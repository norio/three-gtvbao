import { Fn, If, abs, clamp, dot, float, floor, fract, ivec2, logarithmicDepthToViewZ, screenCoordinate, textureSize, vec2 } from 'three/tsl';
import { depthTexelOfAoTexel } from './GTVBAODepthPrefilter.js';
import { createViewPositionFromLinearDepth, getViewPosition } from './GTVBAOViewSpace.js';

// A neighbor AO texel counts as the same surface when its reconstructed point
// lies within this many AO-texel footprints (the world size of one AO texel at
// the fragment's depth) of the fragment's tangent plane. Plane distance rather
// than depth difference keeps grazing planes continuous: a slope moves
// neighbors far in depth but not off the plane. A fraction of the depth would
// scale with distance and let small objects merge with the floor behind them.
const PLANE_TOLERANCE_TEXELS = 4;
// Below this total weight every neighbor was rejected; fall back to the
// nearest AO texel rather than dividing by nothing.
const MIN_WEIGHT = 1e-4;

const JITTER_QUADRANTS = [ [ 0, 0 ], [ 1, 1 ], [ 1, 0 ], [ 0, 1 ] ];
const JITTER_SUBSAMPLES = [ [ 1 / 6, 3 / 6 ], [ 5 / 6, 1 / 6 ], [ 3 / 6, 5 / 6 ] ];

// AO cycles its step offset every 4 frames and slice rotation every 6. A jitter
// period dividing 12 pairs each position with fixed noise phases: the combined
// signal repeats every 12 frames for the temporal resolve to average. An
// unrelated period beats against those cycles and drifts. Quadrants repeat
// every 4 frames and subsamples every 3, giving a 12-frame jitter cycle.
export function setGtvbaoUpsampleJitterPhase( target, frameId ) {
	const q = JITTER_QUADRANTS[ frameId % 4 ];
	const s = JITTER_SUBSAMPLES[ frameId % 3 ];
	return target.set( ( q[ 0 ] + s[ 0 ] ) / 2, ( q[ 1 ] + s[ 1 ] ) / 2 );
}

/**
 * Depth-aware upsample of a reduced-resolution AO texture at a full-resolution
 * fragment. The four AO texels around the fragment are weighted bilinearly and
 * by how close their surface point (from the AO node's linear-depth level 0)
 * lies to the fragment's tangent plane, so the AO of a silhouette's far side
 * does not bleed onto its near side the way a plain bilinear fetch lets it.
 * While the node reports the upsample disabled (full resolution, or no depth
 * MIPs to read positions from) this is the plain bilinear sample.
 * Optional footprint jitter in AO texels combines per-pixel noise with a
 * JS-computed per-frame phase, locked to the AO noise cycles.
 * TRAA clips history to the mean +/- one standard deviation of a 3x3
 * full-resolution neighborhood, where spatially correlated bilinear noise has
 * low variance and causes history to be clipped every frame.
 *
 * `fragment` supplies the fragment's screen uv, view-space position and
 * view-space normal as nodes; a lit material passes its own varyings, a
 * full-screen quad reconstructs them from the pre-pass buffers.
 */
export function createGtvbaoDepthAwareAo( aoNode, aoTexture, { screenUv, viewPosition, viewNormal } ) {
	return Fn( () => {
		// Material normals are shared with the subsequent lighting code. Evaluate
		// them outside the optional upsample branch: r185 otherwise initializes
		// normalView only inside that branch, leaving full-resolution lighting
		// with a zero normal when the branch is skipped.
		const surfaceNormal = viewNormal.toVar();
		const result = float( 0 ).toVar();
		If( aoNode._upsampleEnabled.greaterThan( 0.5 ), () => {
			const linearDepthTexture = aoNode.getDepthMipNodes()[ 0 ];
			const aoResolution = vec2( textureSize( linearDepthTexture, 0 ) ).toConst();
			const depthResolution = vec2( textureSize( aoNode.depthNode, 0 ) ).toConst();
			const depthTexelSize = vec2( 1 ).div( depthResolution ).toConst();
			const maxTexel = aoResolution.sub( 1 ).toConst();
			const viewPositionFromLinearDepth = createViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse, aoNode._isOrthographicCamera );
			// AO texel space with texel centers on integers: floor is the lower-left
			// of the 2x2 footprint and fract the bilinear weights.
			const ign = ( p ) => fract( fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ).mul( 52.9829189 ) );
			const xi = fract( vec2( ign( screenCoordinate ), ign( screenCoordinate.yx ) ).add( aoNode._upsampleJitterPhase ) );
			const offset = xi.sub( 0.5 ).mul( aoNode._upsampleJitter );
			const footprint = screenUv.mul( aoResolution ).sub( 0.5 ).add( offset ).toConst();
			const base = floor( footprint ).toConst();
			const blend = fract( footprint ).toConst();
			// Orthographic texel footprints stay constant with view depth.
			const footprintDepth = aoNode._isOrthographicCamera ? float( 1 ) : viewPosition.z.negate();
			const tolerance = footprintDepth.mul( PLANE_TOLERANCE_TEXELS / 2 ).div( aoNode._halfProjScale ).add( 1e-4 ).toConst();
			const aoSum = float( 0 ).toVar();
			const weightSum = float( 0 ).toVar();
			const cornerAo = [];
			for ( const [ offsetX, offsetY ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {
				const texel = clamp( base.add( vec2( offsetX, offsetY ) ), vec2( 0 ), maxTexel ).toConst();
				const bilinear = ( offsetX ? blend.x : blend.x.oneMinus() ).mul( offsetY ? blend.y : blend.y.oneMinus() );
				const ao = aoTexture.load( ivec2( texel ) ).r.toConst();
				cornerAo.push( ao );
				// Level 0 stands for the scene-depth texel the prefilter picked, so the
				// neighbor's point is reconstructed at that texel's center.
				const sourceUv = depthTexelOfAoTexel( texel, depthResolution, aoResolution ).add( 0.5 ).mul( depthTexelSize );
				const neighbor = viewPositionFromLinearDepth( sourceUv, linearDepthTexture.load( ivec2( texel ) ).r );
				const planeDistance = abs( dot( neighbor.sub( viewPosition ), surfaceNormal ) );
				const weight = bilinear.mul( planeDistance.div( tolerance ).oneMinus().clamp() ).toConst();
				aoSum.addAssign( ao.mul( weight ) );
				weightSum.addAssign( weight );
			}
			// The corner with the largest bilinear weight is the nearest texel.
			const nearestAo = blend.x.lessThan( 0.5 )
				.select( blend.y.lessThan( 0.5 ).select( cornerAo[ 0 ], cornerAo[ 2 ] ), blend.y.lessThan( 0.5 ).select( cornerAo[ 1 ], cornerAo[ 3 ] ) );
			If( weightSum.greaterThan( MIN_WEIGHT ), () => {
				result.assign( aoSum.div( weightSum ) );
			} ).ElseIf( aoNode._upsampleJitter.greaterThan( 0 ), () => {
				result.assign( aoTexture.load( ivec2( clamp( floor( screenUv.mul( aoResolution ) ), vec2( 0 ), maxTexel ) ) ).r );
			} ).Else( () => {
				result.assign( nearestAo );
			} );
		} ).Else( () => {
			result.assign( aoTexture.sample( screenUv ).r );
		} );
		return result;
	} )();
}

/**
 * The same upsample for a full-screen quad, which has no surface of its own:
 * the fragment's position and normal come from the pre-pass depth and normal
 * buffers at the quad's uv.
 */
export function createGtvbaoDepthAwareAoFromBuffers( aoNode, aoTexture, depthTexture, normalTexture, screenUv ) {
	const viewPosition = Fn( ( builder ) => {
		const depth = depthTexture.sample( screenUv ).r;
		// This helper can be called before aoNode.setup() knows the depth mode.
		if ( builder.renderer.logarithmicDepthBuffer === true && ! aoNode._isOrthographicCamera ) {
			const viewZ = logarithmicDepthToViewZ( depth, aoNode._cameraNear, aoNode._cameraFar );
			// Keep logarithmic depth's range instead of squeezing it back into
			// perspective depth, which would lose precision on distant surfaces.
			const fromLinearDepth = createViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse, aoNode._isOrthographicCamera );
			return fromLinearDepth( screenUv, viewZ.negate() );
		}
		return getViewPosition( screenUv, depth, aoNode._cameraProjectionMatrixInverse, aoNode._isOrthographicCamera );
	} )();
	const normal = normalTexture.sample( screenUv ).rgb;
	const viewNormal = aoNode.normalEncoding === 'directionToColor' ? normal.mul( 2 ).sub( 1 ).normalize() : normal.normalize();
	return createGtvbaoDepthAwareAo( aoNode, aoTexture, { screenUv, viewPosition, viewNormal } );
}
