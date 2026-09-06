import { Fn, If, abs, clamp, dot, float, floor, fract, ivec2, logarithmicDepthToViewZ, textureSize, vec2 } from 'three/tsl';
import { depthTexelOfAoTexel } from './GTVBAODepthPrefilter.js';
import { createPerspectiveViewPositionFromLinearDepth, getPerspectiveViewPosition } from './GTVBAOViewSpace.js';

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

/**
 * Depth-aware upsample of a reduced-resolution AO texture at a full-resolution
 * fragment. The four AO texels around the fragment are weighted bilinearly and
 * by how close their surface point (from the AO node's linear-depth level 0)
 * lies to the fragment's tangent plane, so the AO of a silhouette's far side
 * does not bleed onto its near side the way a plain bilinear fetch lets it.
 * While the node reports the upsample disabled (full resolution, or no depth
 * MIPs to read positions from) this is the plain bilinear sample.
 *
 * `fragment` supplies the fragment's screen uv, view-space position and
 * view-space normal as nodes; a lit material passes its own varyings, a
 * full-screen quad reconstructs them from the pre-pass buffers.
 */
export function createGtvbaoDepthAwareAo( aoNode, aoTexture, { screenUv, viewPosition, viewNormal } ) {
	return Fn( () => {
		const result = float( 0 ).toVar();
		If( aoNode._upsampleEnabled.greaterThan( 0.5 ), () => {
			const linearDepthTexture = aoNode.getDepthMipNodes()[ 0 ];
			const aoResolution = vec2( textureSize( linearDepthTexture, 0 ) ).toConst();
			const depthResolution = vec2( textureSize( aoNode.depthNode, 0 ) ).toConst();
			const maxTexel = aoResolution.sub( 1 ).toConst();
			const viewPositionFromLinearDepth = createPerspectiveViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse );
			// AO texel space with texel centers on integers: floor is the lower-left
			// of the 2x2 footprint and fract the bilinear weights.
			const footprint = screenUv.mul( aoResolution ).sub( 0.5 ).toConst();
			const base = floor( footprint ).toConst();
			const blend = fract( footprint ).toConst();
			// One AO texel spans z / (2 halfProjScale) in world units at depth z.
			const tolerance = viewPosition.z.negate().mul( PLANE_TOLERANCE_TEXELS / 2 ).div( aoNode._halfProjScale ).add( 1e-4 ).toConst();
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
				const sourceUv = depthTexelOfAoTexel( texel, depthResolution, aoResolution ).add( 0.5 ).div( depthResolution );
				const neighbor = viewPositionFromLinearDepth( sourceUv, linearDepthTexture.load( ivec2( texel ) ).r );
				const planeDistance = abs( dot( neighbor.sub( viewPosition ), viewNormal ) );
				const weight = bilinear.mul( planeDistance.div( tolerance ).oneMinus().clamp() ).toConst();
				aoSum.addAssign( ao.mul( weight ) );
				weightSum.addAssign( weight );
			}
			// The corner with the largest bilinear weight is the nearest texel.
			const nearestAo = blend.x.lessThan( 0.5 )
				.select( blend.y.lessThan( 0.5 ).select( cornerAo[ 0 ], cornerAo[ 2 ] ), blend.y.lessThan( 0.5 ).select( cornerAo[ 1 ], cornerAo[ 3 ] ) );
			result.assign( weightSum.greaterThan( MIN_WEIGHT ).select( aoSum.div( weightSum ), nearestAo ) );
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
		if ( builder.renderer.logarithmicDepthBuffer === true ) {
			const viewZ = logarithmicDepthToViewZ( depth, aoNode._cameraNear, aoNode._cameraFar );
			// Keep logarithmic depth's range instead of squeezing it back into
			// perspective depth, which would lose precision on distant surfaces.
			const fromLinearDepth = createPerspectiveViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse );
			return fromLinearDepth( screenUv, viewZ.negate() );
		}
		return getPerspectiveViewPosition( screenUv, depth, aoNode._cameraProjectionMatrixInverse );
	} )();
	const normal = normalTexture.sample( screenUv ).rgb;
	const viewNormal = aoNode.normalEncoding === 'directionToColor' ? normal.mul( 2 ).sub( 1 ).normalize() : normal.normalize();
	return createGtvbaoDepthAwareAo( aoNode, aoTexture, { screenUv, viewPosition, viewNormal } );
}
