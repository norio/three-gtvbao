import { MathUtils } from 'three/webgpu';

const TRUE_VALUES = new Set( [ true, 1, '1', 'true', 'on' ] );

export const normalizeGtvbaoBool = ( value ) => TRUE_VALUES.has( value );

export const normalizeGtvbaoNumber = ( fallback ) => ( value ) => {
	const nextValue = Number( value );
	return Number.isFinite( nextValue ) ? nextValue : fallback;
};

export const normalizeGtvbaoInt = ( { min, max } ) => ( value ) => {
	const nextValue = Number( value );
	return Number.isFinite( nextValue ) ? Math.round( MathUtils.clamp( nextValue, min, max ) ) : min;
};

export const createGtvbaoVariantValue = (
	owner,
	initialValue,
	normalizeValue,
	{
		mirrorNode = null,
		shouldRebuild = ( previousValue, nextValue ) => previousValue !== nextValue,
		shouldNotify = shouldRebuild
	} = {}
) => {
	let value = normalizeValue( initialValue );
	if ( mirrorNode !== null ) mirrorNode.value = value;
	return {
		get value() {
			return value;
		},
		set value( nextValue ) {
			const normalizedValue = normalizeValue( nextValue );
			if ( normalizedValue === value ) return;
			const rebuild = shouldRebuild( value, normalizedValue );
			const notify = shouldNotify( value, normalizedValue );
			value = normalizedValue;
			if ( mirrorNode !== null ) mirrorNode.value = value;
			if ( rebuild || notify ) owner._markVariantDirty( rebuild );
		}
	};
};
