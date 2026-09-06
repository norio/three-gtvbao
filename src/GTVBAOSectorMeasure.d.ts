export type GTVBAOSectorMeasure = "angle" | "solidAngle" | "cosine";

export const GTVBAO_SECTOR_MEASURE_OPTIONS: {
  readonly Angle: "angle";
  readonly "Solid angle": "solidAngle";
  readonly Cosine: "cosine";
};

export function normalizeGtvbaoSectorMeasure(value: unknown): GTVBAOSectorMeasure;
