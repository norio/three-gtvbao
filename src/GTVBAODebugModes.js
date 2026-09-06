export const GTVBAO_DEBUG_MODE_OPTIONS = {
	Off: 0,
	'Raw AO': 1,
	Thickness: 2,
	'Bit Count': 3,
	'Normal Stability': 4,
	'Temporal Jitter': 5
};

export const GTVBAO_VARIANT_LIMITS = /*@__PURE__*/ ( () => {
	const debugModeValues = Object.values( GTVBAO_DEBUG_MODE_OPTIONS );
	return {
		sliceCount: { min: 1, max: 8, step: 1 },
		stepCount: { min: 1, max: 32, step: 1 },
		debugMode: { min: Math.min( ...debugModeValues ), max: Math.max( ...debugModeValues ), step: 1 }
	};
} )();

export const getGtvbaoDebugVariantKey = ( debugMode ) => debugMode > 1 ? debugMode : 0;
export const isGtvbaoDebugEnabled = ( debugMode ) => debugMode > 0;
export const isGtvbaoTemporalJitterDebug = ( debugMode ) => debugMode === GTVBAO_DEBUG_MODE_OPTIONS[ 'Temporal Jitter' ];
