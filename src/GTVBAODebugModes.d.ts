export const GTVBAO_DEBUG_MODE_OPTIONS: {
  readonly Off: 0;
  readonly "Raw AO": 1;
  readonly Thickness: 2;
  readonly "Bit Count": 3;
  readonly "Normal Stability": 4;
  readonly "Temporal Jitter": 5;
};

export const GTVBAO_VARIANT_LIMITS: Record<
  "sliceCount" | "stepCount" | "debugMode",
  { min: number; max: number; step: number }
>;

export function getGtvbaoDebugVariantKey(debugMode: number): number;
export function isGtvbaoDebugEnabled(debugMode: number): boolean;
export function isGtvbaoTemporalJitterDebug(debugMode: number): boolean;
