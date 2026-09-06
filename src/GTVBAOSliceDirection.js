import { float, normalize, vec3 } from 'three/tsl';

// Slice directions after GT-VBAO (Mirko Salm, Shadertoy XXGSDd). VBAO picks
// the slice direction as an angle in the image plane, which is only uniform
// around the view vector at the screen center: a perspective camera distorts
// the distribution towards the edges. GT-VBAO takes the angle in a frame
// around the view vector ("view vec space") and projects it to the screen.

// Orthonormal frame around the view vector: the minimal rotation taking +z
// onto it. V.z > 0 for every pixel of a perspective camera looking down -z,
// so 1 + V.z never vanishes.
export const createViewVectorFrame = ( viewDir ) => {
	const a = float( 1 ).div( viewDir.z.add( 1 ) ).toConst();
	const b = viewDir.x.negate().mul( viewDir.y ).mul( a ).toConst();
	return {
		tangent: vec3( viewDir.x.mul( viewDir.x ).mul( a ).oneMinus(), b, viewDir.x.negate() ).toConst(),
		bitangent: vec3( b, viewDir.y.mul( viewDir.y ).mul( a ).oneMinus(), viewDir.y.negate() ).toConst()
	};
};

// Screen direction of the slice plane spanned by the view vector V and the
// frame direction D (a 2D direction in the frame's tangent/bitangent): the
// derivative of the perspective projection at P = -|P| V, which comes out as
// V.z D.xy - D.z V.xy up to a positive factor (the aspect cancels in pixel
// units). Returned as a view-space vector with z = 0: V.z D - D.z V lies in the
// slice plane, so the plane normal can still be taken as cross( result, V ).
export const projectSliceDirection = ( frame, viewDir, direction ) => {
	const frameDirection = frame.tangent.mul( direction.x ).add( frame.bitangent.mul( direction.y ) ).toConst();
	const screenDirection = frameDirection.xy.mul( viewDir.z ).sub( viewDir.xy.mul( frameDirection.z ) );
	return vec3( normalize( screenDirection ), 0 ).toConst();
};
