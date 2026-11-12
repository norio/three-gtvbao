// Quality presets, tuned at 4K with a device pixel ratio of 2. `temporal`,
// `denoise` and `accumulate` describe the pipeline each preset expects: temporal
// presets jitter the sampling per frame and rely on a TRAA resolve after the lit pass;
// the "No Temporal" presets keep the sampling fixed and expect the lit pass to
// read GTVBAODenoiseNode's output instead of the raw AO.
// Presets with `accumulate` expect a GTVBAOTemporalNode between the AO and its
// consumer (the lit pass or denoiser), using the pre-pass velocity buffer.
// They still work without it, but flicker at half resolution.
export const GTVBAO_PRESETS = {
	Low: {
		resolutionScale: 0.5,
		sliceCount: 1,
		stepCount: 8,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: true,
		denoise: false,
		accumulate: true,
		denoiseRadius: 1,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	Balanced: {
		resolutionScale: 0.5,
		sliceCount: 2,
		stepCount: 6,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: true,
		denoise: false,
		accumulate: true,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	High: {
		resolutionScale: 1,
		sliceCount: 3,
		stepCount: 12,
		radius: 3,
		thickness: 0.08,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 0.35,
		temporal: true,
		denoise: false,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	'No Temporal Low': {
		resolutionScale: 0.5,
		sliceCount: 2,
		stepCount: 6,
		radius: 3,
		thickness: 0.12,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 1,
		temporal: false,
		denoise: true,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	},
	'No Temporal High': {
		resolutionScale: 1,
		sliceCount: 3,
		stepCount: 12,
		radius: 3,
		thickness: 0.08,
		aoIntensity: 1,
		expFactor: 2,
		useScreenSpaceSampling: true,
		useLinearThickness: true,
		linearThicknessScale: 100,
		maxThickness: 0.35,
		temporal: false,
		denoise: true,
		accumulate: false,
		denoiseRadius: 2,
		sectorMeasure: 'cosine',
		usePerspectiveCorrectSlice: true,
		useDepthMips: true
	}
};

export const GTVBAO_PRESET_NAMES = Object.keys( GTVBAO_PRESETS );

export const DEFAULT_GTVBAO_PRESET = 'Balanced';

/**
 * Applies a preset (by name or as an object) to a GTVBAONode, and to a
 * GTVBAODenoiseNode when one is given. The shader variant is rebuilt at most
 * once. The caller still decides which texture the lit pass reads according to
 * `preset.denoise` and `preset.accumulate`: raw AO, accumulated AO, or either
 * after denoising.
 */
export function applyGtvbaoPreset( gtvbaoNode, preset, denoiseNode = null ) {
	const resolved = typeof preset === 'string' ? GTVBAO_PRESETS[ preset ] : preset;
	if ( resolved === undefined ) throw new Error( `Unknown GTVBAO preset: ${ preset }` );
	gtvbaoNode.batchVariantChanges( () => {
		gtvbaoNode.resolutionScale = resolved.resolutionScale;
		gtvbaoNode.sliceCount.value = resolved.sliceCount;
		gtvbaoNode.stepCount.value = resolved.stepCount;
		gtvbaoNode.radius.value = resolved.radius;
		gtvbaoNode.thickness.value = resolved.thickness;
		gtvbaoNode.aoIntensity.value = resolved.aoIntensity;
		gtvbaoNode.expFactor.value = resolved.expFactor;
		gtvbaoNode.useScreenSpaceSampling.value = resolved.useScreenSpaceSampling;
		gtvbaoNode.useLinearThickness.value = resolved.useLinearThickness;
		gtvbaoNode.linearThicknessScale.value = resolved.linearThicknessScale;
		gtvbaoNode.maxThickness.value = resolved.maxThickness;
		gtvbaoNode.sectorMeasure.value = resolved.sectorMeasure;
		gtvbaoNode.usePerspectiveCorrectSlice.value = resolved.usePerspectiveCorrectSlice;
		gtvbaoNode.useDepthMips.value = resolved.useDepthMips;
	} );
	gtvbaoNode.useTemporalFiltering = resolved.temporal;
	if ( denoiseNode !== null ) {
		denoiseNode.radius.value = resolved.denoiseRadius;
		denoiseNode.useTemporalDenoiseRotation = resolved.temporal && resolved.denoise;
	}
	return resolved;
}
