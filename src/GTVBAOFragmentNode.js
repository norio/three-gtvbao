import {
	Break,
	Fn,
	If,
	Loop,
	acos,
	clamp,
	cos,
	countOneBits,
	cross,
	dot,
	float,
	floor,
	fract,
	getNormalFromDepth,
	interleavedGradientNoise,
	inverseSqrt,
	ivec2,
	log2,
	logarithmicDepthToViewZ,
	max,
	min,
	normalize,
	pow,
	rand,
	screenCoordinate,
	sign,
	sin,
	sqrt,
	sub,
	textureSize,
	uint,
	uv,
	vec2,
	vec3,
	vec4,
	viewZToPerspectiveDepth
} from 'three/tsl';
import { GTVBAO_DEBUG_MODE_OPTIONS } from './GTVBAODebugModes.js';
import { createHorizonRemap } from './GTVBAOHorizonRemap.js';
import { GTVBAO_DEPTH_MIP_COUNT, depthTexelOfAoTexel } from './GTVBAODepthPrefilter.js';
import { createViewVectorFrame, projectSliceDirection } from './GTVBAOSliceDirection.js';
import { createPerspectiveTexelViewPosition, createPerspectiveViewPositionFromLinearDepth, getPerspectiveViewPosition } from './GTVBAOViewSpace.js';
export const isAoIntensityFastPath = ( value ) => Math.abs( value - 1 ) < 1e-6;
export const isExpFactorFastPath = ( value ) => Math.abs( value - 2 ) < 1e-6;
// XeGTAO default: a horizon step this many pixels (in log2) away starts using
// the next coarser depth level.
const DEPTH_MIP_SAMPLING_OFFSET = 3.3;
export function createGtvbaoFragmentNode( aoNode, logarithmicDepthBuffer, sharedContext ) {
	const uvNode = uv();
	// Depth is fetched unfiltered from the full-resolution buffer; at reduced AO
	// resolution the low-res pixel centers land between depth texels, so the fetched
	// depth disagrees with the reconstruction UV and the reconstructed points step
	// off the surface — visible as resolution/pixel-ratio dependent banding stripes.
	// Every depth fetch is therefore addressed by integer texel and reconstructed at
	// that texel's center, which is an exact no-op at full resolution.
	const depthResolution = vec2( textureSize( aoNode.depthNode, 0 ) ).toConst();
	const depthTexelSize = vec2( 1 ).div( depthResolution ).toConst();
	const variant = {
		sliceCount: aoNode.sliceCount.value,
		stepCount: aoNode.stepCount.value,
		aoIntensityIsOne: isAoIntensityFastPath( aoNode.aoIntensity.value ),
		expFactorIsTwo: isExpFactorFastPath( aoNode.expFactor.value ),
		useScreenSpaceSampling: aoNode.useScreenSpaceSampling.value,
		useLinearThickness: aoNode.useLinearThickness.value,
		sectorMeasure: aoNode.sectorMeasure.value,
		usePerspectiveCorrectSlice: aoNode.usePerspectiveCorrectSlice.value,
		useDepthMips: aoNode.useDepthMips.value,
		debugMode: aoNode.debugMode.value
	};
	const MAX_RAY = uint( 32 );
	const convertDepth = ( depth ) => {
		if ( logarithmicDepthBuffer === true ) {
			const viewZ = logarithmicDepthToViewZ( depth, aoNode._cameraNear, aoNode._cameraFar );
			return viewZToPerspectiveDepth( viewZ, aoNode._cameraNear, aoNode._cameraFar );
		}
		return depth;
	};
	const loadDepth = ( sampleTexel ) => convertDepth( aoNode.depthNode.load( ivec2( sampleTexel ) ).r );
	// Linear-depth MIP chain at AO resolution (see GTVBAODepthPrefilter). Level 0
	// texels stand for the scene-depth texel selected by the shared center
	// expression below and serve the center pixel and its neighbors; coarser
	// levels are block averages that reconstruct at their own texel center. Near
	// horizon steps keep reading the exact scene-depth texel: a decimated level 0
	// would map steps that land inside the center's own AO texel back onto the
	// center itself, and a zero-length sample vector reads as full occlusion.
	const depthMips = variant.useDepthMips ? aoNode.getDepthMipNodes() : null;
	const mipResolutions = depthMips === null ? null : depthMips.map( ( mipNode ) => vec2( textureSize( mipNode, 0 ) ).toConst() );
	const aoResolution = depthMips === null ? null : mipResolutions[ 0 ];
	const sourceTexelOf = ( aoTexel ) => depthTexelOfAoTexel( aoTexel, depthResolution, aoResolution );
	// Internal MIPs use texel coordinates and never apply a UV transform.
	const loadLinearDepth = ( level, texel ) => depthMips[ level ].load( ivec2( texel ) ).setUpdateMatrix( false ).r;
	// The surface UV is an exact depth-texel center, where a bilinear sample of a
	// same-resolution normal buffer reduces to that texel; fetch it unfiltered
	// (the texel is re-derived from the normal texture's own size in case it differs).
	const loadNormal = ( sampleUv ) => {
		if ( aoNode.normalNode === null ) {
			return getNormalFromDepth( sampleUv, aoNode.depthNode.value, aoNode._cameraProjectionMatrixInverse );
		}
		const normalTexel = floor( sampleUv.mul( vec2( textureSize( aoNode.normalNode, 0 ) ) ) );
		const normal = aoNode.normalNode.load( ivec2( normalTexel ) ).rgb;
		return aoNode.normalEncoding === 'directionToColor' ? normal.mul( 2 ).sub( 1 ).normalize() : normal.normalize();
	};
	const effectiveThickness = ( sampleViewPosition ) => {
		const linearThicknessMultiplier = variant.useLinearThickness
			? sampleViewPosition.z.negate().div( aoNode._cameraFar ).clamp().mul( aoNode.linearThicknessScale.toConst() )
			: float( 1 );
		return clamp( linearThicknessMultiplier.mul( aoNode.thickness.toConst() ), 0.001, aoNode.maxThickness.toConst() );
	};
	const spatialOffsets = Fn( ( [ position ] ) => {
		return float( 0.25 ).mul( sub( position.y, position.x ).bitAnd( 3 ) );
	} ).setLayout( {
		name: 'gtvbaoSpatialOffsets',
		type: 'float',
		inputs: [ { name: 'position', type: 'vec2' } ]
	} );
	// The caller clamps both sector edges to [0, 32], so width is 0..32 and a
	// positive width implies start <= 31. WGSL masks shift amounts modulo 32, so a
	// zero width would otherwise yield a full mask; the select keeps it branch-free
	// inside the march loop.
	const angleBitMask = ( start, width ) => width.greaterThan( uint( 0 ) ).select(
		uint( 0xFFFFFFFF ).shiftRight( MAX_RAY.sub( width ) ).shiftLeft( start ),
		uint( 0 )
	);
	const aoPass = Fn( () => {
		// With depth MIPs the center texel comes from the AO texel through the same
		// expression the prefilter uses, so level 0 holds exactly this texel's depth.
		const aoTexel = depthMips === null ? null : floor( uvNode.mul( aoResolution ) ).toConst();
		const surfaceTexel = ( depthMips === null ? floor( uvNode.mul( depthResolution ) ) : sourceTexelOf( aoTexel ) ).toConst();
		const surfaceUv = surfaceTexel.add( 0.5 ).mul( depthTexelSize ).toConst();
		const depth = loadDepth( surfaceTexel ).toVar();
		const viewNormal = loadNormal( surfaceUv ).toVar();
		// Background keeps the target's white clear. WGSL discard only demotes the
		// invocation, so the AO is additionally guarded by the If below.
		depth.greaterThanEqual( 1.0 ).discard();
		const renderAo = ( viewNormal ) => {
			const createInitialRayStep = () => {
				const noiseOffset = spatialOffsets( screenCoordinate );
				const noiseJitterIdx = aoNode._temporalDirection.mul( 0.02 );
				return fract( noiseOffset.add( aoNode._temporalOffset ).add( rand( uvNode.add( noiseJitterIdx ).mul( 2 ).sub( 1 ) ) ) );
			};
			if ( variant.debugMode === GTVBAO_DEBUG_MODE_OPTIONS[ 'Temporal Jitter' ] ) {
				const initialRayStep = createInitialRayStep();
				return vec4( vec3( fract( aoNode._temporalDirection.mul( 6 ) ), fract( aoNode._temporalOffset ), fract( initialRayStep ) ), 1 );
			}
			const viewPositionFromLinearDepth = depthMips === null ? null : createPerspectiveViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse );
			const viewPosition = ( depthMips === null
				? getPerspectiveViewPosition( surfaceUv, depth, aoNode._cameraProjectionMatrixInverse )
				: viewPositionFromLinearDepth( surfaceUv, loadLinearDepth( 0, aoTexel ) ) ).toVar();
			const aoTexelSize = vec2( 1 ).div( aoNode._resolution ).toConst();
			const centerThickness = effectiveThickness( viewPosition ).toConst();
			if ( variant.debugMode === GTVBAO_DEBUG_MODE_OPTIONS.Thickness ) {
				return vec4( vec3( centerThickness.div( aoNode.maxThickness.toConst() ).clamp() ), 1 );
			}
			const viewDir = viewPosition.negate().mul( inverseSqrt( dot( viewPosition, viewPosition ) ) ).toVar();
			const noiseDirection = interleavedGradientNoise( screenCoordinate );
			// Slice angles are equally spaced (plus the per-pixel and per-frame
			// rotation) around the view vector and projected to the screen (GT-VBAO,
			// see GTVBAOSliceDirection.js); without perspective correction they are
			// image-plane angles, as in VBAO, which is the same thing at the screen center.
			const sliceFrame = variant.usePerspectiveCorrectSlice ? createViewVectorFrame( viewDir ) : null;
			const toSliceDirection = ( direction ) => sliceFrame === null
				? vec3( direction, 0 ).toConst()
				: projectSliceDirection( sliceFrame, viewDir, direction );
			const sliceDirectionAt = ( index ) => {
				const angle = index.add( noiseDirection ).add( aoNode._temporalDirection ).mul( Math.PI / variant.sliceCount ).toConst();
				return vec2( cos( angle ), sin( angle ) ).toConst();
			};
			const forEachSlice = ( addSlice ) => {
				if ( variant.sliceCount === 1 ) {
					addSlice( toSliceDirection( sliceDirectionAt( float( 0 ) ) ) );
				} else if ( variant.sliceCount === 2 ) {
					// The second slice is the first rotated by a quarter turn.
					const direction = sliceDirectionAt( float( 0 ) );
					addSlice( toSliceDirection( direction ) );
					addSlice( toSliceDirection( vec2( direction.y.negate(), direction.x ) ) );
				} else {
					Loop( { start: uint( 0 ), end: uint( variant.sliceCount ), type: 'uint', condition: '<' }, ( { i } ) => {
						addSlice( toSliceDirection( sliceDirectionAt( float( i ) ) ) );
					} );
				}
			};
			if ( variant.debugMode === GTVBAO_DEBUG_MODE_OPTIONS[ 'Normal Stability' ] ) {
				const projectedNormalStability = float( 0 ).toVar();
				forEachSlice( ( sliceDir ) => {
					const planeNormal = variant.usePerspectiveCorrectSlice ? normalize( cross( sliceDir, viewDir ) ) : normalize( cross( sliceDir, viewNormal ) );
					const projectedNormal = viewNormal.sub( planeNormal.mul( dot( viewNormal, planeNormal ) ) ).toConst();
					projectedNormalStability.addAssign( projectedNormal.length().clamp() );
				} );
				return vec4( vec3( projectedNormalStability.div( float( variant.sliceCount ) ).clamp() ), 1 );
			}
			const RADIUS = aoNode.radius.toConst();
			// Slice- and direction-invariant: the horizon step radius only depends on
			// the pixel's view depth, so hoist it out of the horizon marches.
			const stepRadiusBase = variant.useScreenSpaceSampling
				? RADIUS.mul( aoNode._resolution.x.div( 2 ) ).div( float( 16 ) )
				: max( RADIUS.mul( aoNode._halfProjScale ).div( viewPosition.z.negate() ), float( variant.stepCount ) );
			const stepRadius = stepRadiusBase.div( float( variant.stepCount + 1 ) );
			const radiusVS = float( Math.max( 1, variant.stepCount - 1 ) ).mul( stepRadius ).toConst();
			const initialRayStep = createInitialRayStep().toConst();
			const getViewPositionFromTexel = createPerspectiveTexelViewPosition( aoNode._cameraProjectionMatrixInverse, depthTexelSize );
			const occlusion = float( 0 ).toVar();
			// Cosine weighting integrates a different amount of the hemisphere per
			// slice, so slices are averaged with their own integral as the weight.
			// This self-normalized average is what keeps GT-VBAO's uniform slice
			// sampling low-variance here; its importance-sampled slice angles (slice
			// sampling mode 3) were measured against it and brought no improvement.
			const sliceWeightSum = variant.sectorMeasure === 'cosine' ? float( 0 ).toVar() : null;
			// Marches one horizon direction, ORing newly occluded sectors into the
			// caller's bitfield. directionIsRight is a JS build-time constant, so both
			// direction variants inline with their sign/swizzle choices baked in. The
			// step loop deliberately stays a runtime loop: fully unrolling it issues
			// every depth fetch up front, which measured up to 2x slower at high step
			// counts because the march is bound by depth-texture cache behavior, not ALU.
			const sampleHorizonDirection = ( directionIsRight, occludedBitfield, slideDirTexelSize, quantizeDither, remapHorizon ) => {
				const STEP_COUNT = uint( variant.stepCount );
				const invStepSpan = float( 1 / Math.max( 1, variant.stepCount - 1 ) ).toConst();
				const uvDirection = directionIsRight ? vec2( 1, - 1 ) : vec2( - 1, 1 );
				Loop( { start: uint( 0 ), end: STEP_COUNT, type: 'uint', condition: '<' }, ( { i } ) => {
					const offsetBase = float( i ).add( initialRayStep ).mul( invStepSpan ).toConst();
					const offset = ( variant.expFactorIsTwo ? offsetBase.mul( offsetBase ) : pow( offsetBase, aoNode._expFactorNode.toConst() ) ).mul( radiusVS ).toConst();
					const uvOffset = slideDirTexelSize.mul( max( offset, float( i ).add( 1 ) ) ).toConst();
					const stepUv = surfaceUv.add( uvOffset.mul( uvDirection ) ).toConst();
					If(
						stepUv.x.lessThanEqual( 0 )
							.or( stepUv.y.lessThanEqual( 0 ) )
							.or( stepUv.x.greaterThanEqual( 1 ) )
							.or( stepUv.y.greaterThanEqual( 1 ) ),
						() => {
							Break();
						}
					);
					// The open-interval guard above keeps floor( stepUv * resolution ) inside
					// every texture, so no clamp is needed for the fetches.
					let sampleViewPosition;
					if ( depthMips === null ) {
						const sampleTexel = floor( stepUv.mul( depthResolution ) ).toConst();
						sampleViewPosition = getViewPositionFromTexel( sampleTexel, loadDepth( sampleTexel ) ).toConst();
					} else {
						// Level chosen from the step's nominal distance (in AO texels); with
						// screen-space sampling it is uniform across pixels, so the branch is
						// coherent. The If chain selects among the separate level textures.
						const nominalDistance = max( float( i ).add( 0.5 ).mul( invStepSpan ).pow2().mul( radiusVS ), float( i ).add( 1 ) );
						const mipLevel = uint( clamp( floor( log2( nominalDistance ).sub( DEPTH_MIP_SAMPLING_OFFSET ) ), 0, GTVBAO_DEPTH_MIP_COUNT - 1 ) ).toConst();
						sampleViewPosition = vec3( 0 ).toVar();
						const sampleAtLevel = ( level ) => {
							if ( level === 0 ) {
								const sampleTexel = floor( stepUv.mul( depthResolution ) ).toConst();
								sampleViewPosition.assign( getViewPositionFromTexel( sampleTexel, loadDepth( sampleTexel ) ) );
								return;
							}
							const texel = floor( stepUv.mul( mipResolutions[ level ] ) ).toConst();
							const sampleUv = texel.add( 0.5 ).div( mipResolutions[ level ] );
							sampleViewPosition.assign( viewPositionFromLinearDepth( sampleUv, loadLinearDepth( level, texel ) ) );
						};
						let chain = If( mipLevel.equal( uint( 0 ) ), () => { sampleAtLevel( 0 ); } );
						for ( let level = 1; level < GTVBAO_DEPTH_MIP_COUNT - 1; level ++ ) {
							chain = chain.ElseIf( mipLevel.equal( uint( level ) ), () => { sampleAtLevel( level ); } );
						}
						chain.Else( () => { sampleAtLevel( GTVBAO_DEPTH_MIP_COUNT - 1 ); } );
					}
					const pixelToSampleVector = sampleViewPosition.sub( viewPosition ).toConst();
					// Both horizon cosines are expressed through two scalars: the sample
					// vector's projection onto viewDir and its squared length. Every
					// former normalize()/length()/division becomes an inverseSqrt and a
					// few multiply-adds; the 1e-4 distance floor is applied as 1e-8 on the
					// squared length, which is the same threshold.
					const projectedDistance = dot( pixelToSampleVector, viewDir ).toConst();
					const pixelToSampleLengthSq = dot( pixelToSampleVector, pixelToSampleVector ).toConst();
					const invPixelToSampleDistance = inverseSqrt( max( pixelToSampleLengthSq, 1e-8 ) ).toConst();
					const pixelToSampleDistance = pixelToSampleLengthSq.mul( invPixelToSampleDistance ).toConst();
					const sampleThickness = min( centerThickness, pixelToSampleDistance.mul( 0.8 ) ).toConst();
					const frontHorizon = projectedDistance.mul( invPixelToSampleDistance );
					// Backface point B = S - t * viewDir - P = V - t * viewDir.
					const backHorizon = projectedDistance.sub( sampleThickness ).mul( inverseSqrt( max(
						pixelToSampleLengthSq
							.sub( sampleThickness.mul( projectedDistance ).mul( 2 ) )
							.add( sampleThickness.mul( sampleThickness ) ),
						1e-8
					) ) );
					// Monotonic in the horizon cosine, so it commutes with the min/max below
					// and the dither still shifts both remapped edges as a whole.
					let frontBackHorizon = remapHorizon( clamp( vec2( frontHorizon, backHorizon ), - 1, 1 ), directionIsRight ).toConst();
					frontBackHorizon = directionIsRight ? frontBackHorizon.yx : frontBackHorizon.xy;
					const minHorizon = min( frontBackHorizon.x, frontBackHorizon.y ).toConst();
					const maxHorizon = max( frontBackHorizon.x, frontBackHorizon.y ).toConst();
					// Both edges round the same way against the same dither, which makes the
					// occluded width an unbiased estimate of the true angular width: an
					// interval narrower than one sector is marked with probability equal to
					// its width instead of always claiming a whole sector. Rounding the end
					// outward (ceil) instead would add exactly +1 sector in expectation --
					// a floor of ~1/32 occlusion per marched direction that survives even a
					// zero-width horizon, darkening every unoccluded surface.
					const startHorizonInt = uint( clamp( floor( minHorizon.mul( float( MAX_RAY ) ).add( quantizeDither ) ), 0, float( MAX_RAY ) ) ).toConst();
					const endHorizonInt = uint( clamp( floor( maxHorizon.mul( float( MAX_RAY ) ).add( quantizeDither ) ), 0, float( MAX_RAY ) ) ).toConst();
					// OR-ing already-set bits is a no-op, so the former `& ~occluded` mask is dropped.
					occludedBitfield.assign( occludedBitfield.bitOr( angleBitMask( startHorizonInt, endHorizonInt.sub( startHorizonInt ) ) ) );
					If( occludedBitfield.equal( uint( 0xFFFFFFFF ) ), () => { Break(); } );
				} );
			};
			const addSliceOcclusion = ( sliceDir ) => {
				const slideDirTexelSize = sliceDir.xy.mul( aoTexelSize ).toConst();
				const planeNormal = variant.usePerspectiveCorrectSlice ? normalize( cross( sliceDir, viewDir ) ) : normalize( cross( sliceDir, viewNormal ) );
				const tangent = cross( viewDir, planeNormal ).toConst();
				const projectedNormal = viewNormal.sub( planeNormal.mul( dot( viewNormal, planeNormal ) ) ).toConst();
				const projectedNormalLength = projectedNormal.length().toConst();
				const projectedNormalNormalized = projectedNormal.div( max( projectedNormalLength, 1e-4 ) ).toConst();
				const cosN = clamp( dot( projectedNormalNormalized, viewDir ), - 1, 1 ).toConst();
				const degenerate = projectedNormalLength.lessThan( 1e-4 );
				const normalSign = sign( dot( projectedNormal, tangent ) ).negate();
				const normalAngle = degenerate.select(
					float( 0 ),
					normalSign.mul( acos( cosN ) )
				).toConst();
				// sin( s * acos( x ) ) = s * sqrt( 1 - x^2 ); cosN is clamped to [-1, 1] so the
				// radicand never goes negative in f32. Zero in the degenerate case, like the angle.
				const sinN = degenerate.select( float( 0 ), normalSign.mul( sqrt( cosN.mul( cosN ).oneMinus() ) ) ).toConst();
				// The degenerate slice sees the normal along the view vector (cos 1, sin 0).
				const remapCosN = degenerate.select( float( 1 ), cosN ).toConst();
				const remapHorizon = createHorizonRemap( variant.sectorMeasure, normalAngle, remapCosN, sinN );
				// Decorrelates the 32-sector horizon quantization in sampleHorizonDirection,
				// whose boundaries otherwise align into banding stripes at reduced
				// resolution. The same per-pixel/per-slice/per-frame dither is added to
				// both sector edges, so the occluded range shifts as a whole rather than
				// changing width, and it is shared across the steps of a slice so that two
				// steps finding the same horizon land on the same sector. Together with the
				// matched rounding of both edges this makes the occluded width unbiased and
				// turns the banding into zero-mean noise that TRAA resolves.
				const quantizeDither = interleavedGradientNoise(
					screenCoordinate.add( normalAngle ).add( aoNode._temporalOffset.mul( 17 ) ).add( aoNode._temporalDirection.mul( 23 ) )
				).toConst();
				const occludedBitfield = uint( 0 ).toVar();
				for ( const directionIsRight of [ true, false ] ) {
					sampleHorizonDirection( directionIsRight, occludedBitfield, slideDirTexelSize, quantizeDither, remapHorizon );
				}
				const sliceOcclusion = float( countOneBits( occludedBitfield ) ).div( float( MAX_RAY ) );
				if ( variant.sectorMeasure === 'cosine' ) {
					// The slice's cosine-weighted hemisphere integral, |projN| (cosN + n sinN);
					// zero for a degenerate slice, which then drops out of the average.
					const sliceWeight = projectedNormalLength.mul( remapCosN.add( normalAngle.mul( sinN ) ) ).toConst();
					occlusion.addAssign( sliceOcclusion.mul( sliceWeight ) );
					sliceWeightSum.addAssign( sliceWeight );
				} else {
					occlusion.addAssign( sliceOcclusion );
				}
			};
			forEachSlice( addSliceOcclusion );
			const occlusionRatio = ( variant.sectorMeasure === 'cosine'
				? occlusion.div( max( sliceWeightSum, 1e-4 ) )
				: occlusion.div( float( variant.sliceCount ) )
			).clamp().toVar();
			const ao = ( variant.aoIntensityIsOne ? occlusionRatio.oneMinus() : pow( occlusionRatio.oneMinus(), aoNode._aoIntensityNode.toConst() ) ).clamp().toVar();
			let outputColor = vec3( ao );
			if ( variant.debugMode === GTVBAO_DEBUG_MODE_OPTIONS[ 'Bit Count' ] ) {
				outputColor = vec3( occlusionRatio );
			}
			return vec4( outputColor, 1 );
		};
		const outputColor = vec4( 1 ).toVar();
		If( depth.lessThan( 1.0 ), () => {
			outputColor.assign( renderAo( viewNormal ) );
		} );
		return outputColor;
	} );
	return aoPass().context( sharedContext );
}
