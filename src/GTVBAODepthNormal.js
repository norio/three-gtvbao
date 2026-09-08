import { Fn, abs, cross, float, ivec2, normalize, textureSize, vec2 } from 'three/tsl';
import { getViewPosition } from './GTVBAOViewSpace.js';

// Match three's depth-discontinuity-aware normal reconstruction, but explicitly
// select the scalar depth channel before unprojection. Some three versions pass
// the full texture vec4 to getViewPosition, producing invalid vec3 joins.
export function getDepthNormal( screenUv, depthNode, projectionMatrixInverse, isOrthographicCamera, convertDepth ) {
	return Fn( () => {
		const size = vec2( textureSize( depthNode, 0 ) );
		const p = ivec2( screenUv.mul( size ) ).toConst();
		const load = ( offset ) => convertDepth( depthNode.load( p.add( offset ) ).r ).toConst();
		const center = load( ivec2( 0 ) );
		const left = load( ivec2( - 1, 0 ) );
		const right = load( ivec2( 1, 0 ) );
		const bottom = load( ivec2( 0, 1 ) );
		const top = load( ivec2( 0, - 1 ) );
		const leftError = abs( left.mul( 2 ).sub( load( ivec2( - 2, 0 ) ) ).sub( center ) );
		const rightError = abs( right.mul( 2 ).sub( load( ivec2( 2, 0 ) ) ).sub( center ) );
		const bottomError = abs( bottom.mul( 2 ).sub( load( ivec2( 0, 2 ) ) ).sub( center ) );
		const topError = abs( top.mul( 2 ).sub( load( ivec2( 0, - 2 ) ) ).sub( center ) );
		const position = ( uv, depth ) => getViewPosition( uv, depth, projectionMatrixInverse, isOrthographicCamera );
		const centerPosition = position( screenUv, center ).toConst();
		const dx = vec2( float( 1 ).div( size.x ), 0 );
		const dy = vec2( 0, float( 1 ).div( size.y ) );
		const dpdx = leftError.lessThan( rightError ).select(
			centerPosition.sub( position( screenUv.sub( dx ), left ) ),
			position( screenUv.add( dx ), right ).sub( centerPosition )
		);
		const dpdy = bottomError.lessThan( topError ).select(
			centerPosition.sub( position( screenUv.add( dy ), bottom ) ),
			position( screenUv.sub( dy ), top ).sub( centerPosition )
		);
		return normalize( cross( dpdx, dpdy ) );
	} )();
}
