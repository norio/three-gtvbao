import { Fn, HALF_PI, PI, abs, clamp, float, max, mul, sqrt, vec2 } from 'three/tsl';

// Every consumer needs acos / PI, so normalize the polynomial coefficients
// once and remove a vector division from every horizon step.
const fastAcosNorm = /*@__PURE__*/ Fn( ( [ value ] ) => {
	const outVal = abs( value ).mul( float( - 0.156583 / Math.PI ) ).add( 0.5 ).toVar();
	outVal.mulAssign( sqrt( abs( value ).oneMinus() ) );
	const x = value.x.greaterThanEqual( 0 ).select( outVal.x, outVal.x.oneMinus() );
	const y = value.y.greaterThanEqual( 0 ).select( outVal.y, outVal.y.oneMinus() );
	return vec2( x, y );
} ).setLayout( {
	name: 'gtvbaoFastAcosNorm',
	type: 'vec2',
	inputs: [ { name: 'value', type: 'vec2' } ]
} );
// Slice-relative CDF remap of the horizon angles (GT-VBAO, Mirko Salm). The 32
// sectors are equal in angle, but the hemisphere measure inside a slice is not:
// solid angle carries a |sin| Jacobian around the view vector (the pole every
// slice shares) and cosine-weighted AO adds cos(angle to the normal). Neither
// can be applied to a bit, so the horizon angles are pushed through the CDF of
// that measure instead, which makes each equal-width sector carry equal weight
// and turns countOneBits / 32 into the correctly weighted visibility.
//
// The normalized horizon x in [0, 1] spans the hemisphere around the projected
// normal: sector angle psi = x * PI - PI / 2 = -d * theta - n, where theta is
// the horizon's angle from the view vector (cosine h), d the march direction
// (+1 right) and n the normal's angle (normalAngle), so the pole sits at
// psi = -n and each direction covers one side of it. In GT-VBAO's conventions
// this is angN = -normalAngle and isPhiLargerThanAngN = !directionIsRight;
// the constants below are its SliceRelCDF_Cos / SliceRelCDF_Uniform with those
// substitutions applied, then rewritten in terms of h: cos(psi + n) = h and
// cos(2 psi + n) = (2 h^2 - 1) cosN - 2 d h sin(theta) sinN, so the uniform
// remap needs no transcendental at all and the cosine remap keeps one acos for
// the linear-in-angle term. The remap is evaluated on both edges of a sample
// at once (vec2), and directionIsRight is a JS build constant.
export const createHorizonRemap = ( measure, normalAngle, cosN, sinN ) => {
	// Slice constants, hoisted out of the march loop.
	const invNormalization = measure === 'cosine'
		? float( 0.25 ).div( max( cosN.add( normalAngle.mul( sinN ) ), 1e-4 ) ).toConst()
		: null;
	const normalAngleNorm = measure === 'angle' ? normalAngle.sub( HALF_PI ).div( PI ).toConst() : null;
	return ( horizonCos, directionIsRight ) => {
		const d = directionIsRight ? 1 : - 1;
		if ( measure === 'angle' ) {
			// Original VBAO: sectors of equal angle, x = (PI/2 - d theta - n) / PI.
			return clamp( mul( d, fastAcosNorm( horizonCos ).negate() ).sub( normalAngleNorm ) );
		}
		if ( measure === 'solidAngle' ) {
			// Values past the hemisphere edge (below the tangent plane) map outside
			// [0, 1] monotonically, so the clamp lands them on the edge sector.
			const [ m0, m1 ] = directionIsRight ? [ 0, 1 ] : [ 2, - 1 ];
			return clamp( horizonCos.mul( m1 ).add( m0 ).sub( sinN ).mul( 0.5 ) );
		}
		// The cosine CDF is not monotonic past the hemisphere edge, so the horizon
		// is held at the edge first: psi >= -PI/2 is theta <= PI/2 - d n, i.e.
		// h >= sin(d n). Both edges of a sample are then inside [0, 1] and a
		// sample below the tangent plane collapses to zero width, as before.
		const [ n0, n1, n2 ] = directionIsRight ? [ 1, 1, 0 ] : [ 3, - 1, 4 ];
		const h = max( horizonCos, sinN.mul( d ) ).toConst();
		const sinTheta = sqrt( h.mul( h ).oneMinus() );
		const theta = fastAcosNorm( h ).mul( PI );
		const cosTwoPsiPlusN = h.mul( h ).mul( 2 ).sub( 1 ).mul( cosN ).sub( h.mul( sinTheta ).mul( 2 * d ).mul( sinN ) );
		const t0 = cosN.mul( n0 )
			.add( cosTwoPsiPlusN.mul( n1 ) )
			.add( theta.mul( 2 * n1 * d ).add( normalAngle.mul( n2 + 2 * n1 ) ).sub( PI ).mul( sinN ) );
		return clamp( t0.mul( invNormalization ) );
	};
};
