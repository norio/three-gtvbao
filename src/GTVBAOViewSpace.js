import { WebGPUCoordinateSystem } from 'three/webgpu';
import { Fn, float, vec2, vec3 } from 'three/tsl';

// Depth textures use [0, 1] on both backends, but WebGL projection matrices
// expect clip-space Z in [-1, 1]. Resolve this at shader build time.
const clipDepth = /*@__PURE__*/ Fn( ( [ depth ], builder ) =>
	builder.renderer.coordinateSystem === WebGPUCoordinateSystem ? depth : depth.mul( 2 ).sub( 1 ) );

// Perspective-camera specialization of three's getViewPosition, using the
// renderer's coordinate system.
//
// The inverse perspective projection has exact zeros everywhere except m00,
// m11, m32 and column 3, so the generic mat4 x vec4 collapses to three
// multiply-adds and one division without changing the result.
export const getPerspectiveViewPosition = ( screenPosition, depth, projectionMatrixInverse ) => {
	const ndc = vec2( screenPosition.x, screenPosition.y.oneMinus() ).mul( 2 ).sub( 1 ).toConst();
	const projectionColumn3 = projectionMatrixInverse.element( 3 );
	const invW = float( 1 ).div( projectionMatrixInverse.element( 2 ).w.mul( clipDepth( depth ) ).add( projectionColumn3.w ) );
	return vec3(
		projectionMatrixInverse.element( 0 ).x.mul( ndc.x ).add( projectionColumn3.x ),
		projectionMatrixInverse.element( 1 ).y.mul( ndc.y ).add( projectionColumn3.y ),
		projectionColumn3.z
	).mul( invW );
};

// Same reconstruction addressed by integer texel instead of UV: the texel
// center UV ((texel + 0.5) * texelSize) is folded into a per-axis scale and
// bias, so each sample costs two multiply-adds and the perspective divide.
// Build once per shader (outside any loop) and call per sample.
export const createPerspectiveTexelViewPosition = ( projectionMatrixInverse, texelSize ) => {
	const projectionM00 = projectionMatrixInverse.element( 0 ).x.toConst();
	const projectionM11 = projectionMatrixInverse.element( 1 ).y.toConst();
	const projectionM32 = projectionMatrixInverse.element( 2 ).w.toConst();
	const projectionColumn3 = projectionMatrixInverse.element( 3 ).toConst();
	const viewTexelScale = vec2(
		projectionM00.mul( texelSize.x.mul( 2 ) ),
		projectionM11.mul( texelSize.y.mul( - 2 ) )
	).toConst();
	const viewTexelBias = vec2(
		projectionM00.mul( texelSize.x.sub( 1 ) ).add( projectionColumn3.x ),
		projectionM11.mul( texelSize.y.oneMinus() ).add( projectionColumn3.y )
	).toConst();
	return ( sampleTexel, sampleDepth ) => {
		const invW = float( 1 ).div( projectionM32.mul( clipDepth( sampleDepth ) ).add( projectionColumn3.w ) ).toConst();
		const viewXY = viewTexelScale.mul( sampleTexel ).add( viewTexelBias ).toConst();
		return vec3( viewXY, projectionColumn3.z ).mul( invW );
	};
};

// Reconstruction from positive linear view depth instead of perspective depth.
// view.z = c3z * invW, so invW = -linearDepth / c3z and the perspective divide
// disappears; only the x/y multiply-adds remain. Build once per shader.
export const createPerspectiveViewPositionFromLinearDepth = ( projectionMatrixInverse ) => {
	const projectionM00 = projectionMatrixInverse.element( 0 ).x.toConst();
	const projectionM11 = projectionMatrixInverse.element( 1 ).y.toConst();
	const projectionColumn3 = projectionMatrixInverse.element( 3 ).toConst();
	const invProjectionZ = float( - 1 ).div( projectionColumn3.z ).toConst();
	return ( screenPosition, linearDepth ) => {
		const ndc = vec2( screenPosition.x, screenPosition.y.oneMinus() ).mul( 2 ).sub( 1 ).toConst();
		const invW = linearDepth.mul( invProjectionZ ).toConst();
		return vec3(
			projectionM00.mul( ndc.x ).add( projectionColumn3.x ),
			projectionM11.mul( ndc.y ).add( projectionColumn3.y ),
			projectionColumn3.z
		).mul( invW );
	};
};

// Camera type is resolved while building the shader. Orthographic projection
// has no perspective divide: x/y depend only on UV, and z is linear in depth.
export const getViewPosition = ( screenPosition, depth, projectionMatrixInverse, isOrthographicCamera ) => {
	if ( ! isOrthographicCamera ) return getPerspectiveViewPosition( screenPosition, depth, projectionMatrixInverse );
	const ndc = vec2( screenPosition.x, screenPosition.y.oneMinus() ).mul( 2 ).sub( 1 );
	return vec3(
		projectionMatrixInverse.element( 0 ).x.mul( ndc.x ),
		projectionMatrixInverse.element( 1 ).y.mul( ndc.y ),
		projectionMatrixInverse.element( 2 ).z.mul( clipDepth( depth ) )
	).add( projectionMatrixInverse.element( 3 ).xyz );
};

export const createTexelViewPosition = ( projectionMatrixInverse, texelSize, isOrthographicCamera ) => {
	if ( ! isOrthographicCamera ) return createPerspectiveTexelViewPosition( projectionMatrixInverse, texelSize );
	return ( sampleTexel, sampleDepth ) => getViewPosition(
		sampleTexel.add( 0.5 ).mul( texelSize ), sampleDepth, projectionMatrixInverse, true
	);
};

export const createViewPositionFromLinearDepth = ( projectionMatrixInverse, isOrthographicCamera ) => {
	if ( ! isOrthographicCamera ) return createPerspectiveViewPositionFromLinearDepth( projectionMatrixInverse );
	const scale = vec2( projectionMatrixInverse.element( 0 ).x, projectionMatrixInverse.element( 1 ).y ).toConst();
	const bias = projectionMatrixInverse.element( 3 ).xy.toConst();
	return ( screenPosition, linearDepth ) => {
		const ndc = vec2( screenPosition.x, screenPosition.y.oneMinus() ).mul( 2 ).sub( 1 );
		return vec3( ndc.mul( scale ).add( bias ), linearDepth.negate() );
	};
};
