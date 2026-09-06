// How the 32 sectors of a slice are laid out over the hemisphere, i.e. what a
// sector counts as. Cosine (the default) remaps the horizon angles through the
// CDF of the cosine-weighted solid angle (GT-VBAO): every sector then stands
// for an equal share of what GTAO integrates, and the result no longer drifts
// with the camera pitch. Solid angle is the same remap for uniform hemisphere
// weighting. Angle is the original VBAO layout (equal angles, no remap): it
// under-weights the directions near the tangent plane, so it reads brighter
// and drifts with the pitch, but at a given sample count it is the least noisy.
// The correct measures spend more sectors near the tangent plane, where the
// horizon estimate jitters most, so they cost 30-40% more noise in dark areas
// (measured at Balanced 2x6 in compare.html's Detail view).
export const GTVBAO_SECTOR_MEASURE_OPTIONS = {
	Angle: 'angle',
	'Solid angle': 'solidAngle',
	Cosine: 'cosine'
};

const SECTOR_MEASURES = /*@__PURE__*/ new Set( /*@__PURE__*/ Object.values( GTVBAO_SECTOR_MEASURE_OPTIONS ) );

export const normalizeGtvbaoSectorMeasure = ( value ) => SECTOR_MEASURES.has( value ) ? value : GTVBAO_SECTOR_MEASURE_OPTIONS.Cosine;
