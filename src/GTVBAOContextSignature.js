// Shared contexts contain fresh per-build closures and nodes; only primitive
// flags can deterministically affect AO code generation across consumer builds.
export function getGtvbaoContextSignature( context ) {
	const entries = [];
	for ( const key of Object.keys( context ?? {} ).sort() ) {
		const value = context[ key ];
		const type = typeof value;
		if ( value === null || ( type !== 'object' && type !== 'function' ) ) {
			entries.push( [ key, type, String( value ) ] );
		}
	}
	return JSON.stringify( entries );
}
