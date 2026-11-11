import type { GTVBAOVariantValue } from "./GTVBAONode.js";

export function normalizeGtvbaoBool(value: unknown): boolean;
export function normalizeGtvbaoNumber(fallback: number): (value: unknown) => number;
export function normalizeGtvbaoInt(limits: { min: number; max: number }): (value: unknown) => number;
export function createGtvbaoVariantValue<T>(
  owner: { _markVariantDirty(rebuildMaterial?: boolean): void },
  initialValue: unknown,
  normalizeValue: (value: unknown) => T,
  options?: {
    mirrorNode?: { value: T } | null;
    shouldRebuild?: (previousValue: T, nextValue: T) => boolean;
    shouldNotify?: (previousValue: T, nextValue: T) => boolean;
  }
): GTVBAOVariantValue<T>;
