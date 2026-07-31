import type { TargetOptions } from './types.ts';

/** Coerce a target option to a string array (options are untyped user config) */
export function stringArrayOption(options: TargetOptions, key: string): string[] {
  const value = options[key];
  return Array.isArray(value) ? value.map(String) : [];
}

/** Coerce a target option to a non-empty string, or undefined */
export function stringOption(options: TargetOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value ? value : undefined;
}
