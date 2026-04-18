import semver from 'semver';
import type { BumpType } from '../types.ts';

export function bumpVersion(version: string, type: BumpType): string {
  const result = semver.inc(version, type);
  if (!result) throw new Error(`Failed to bump ${version} by ${type}`);
  return result;
}

/**
 * Check if a version satisfies a range.
 * @param version - The version to check
 * @param range - The version range (may include workspace: or catalog: protocol)
 * @param currentVersion - The dependency's current version, used to resolve workspace:^ and workspace:~
 */
export function satisfies(version: string, range: string, currentVersion?: string): boolean {
  // Handle workspace: protocol — resolve shorthands using currentVersion
  if (range.startsWith('workspace:')) {
    const cleanRange = range.slice('workspace:'.length);
    if (!cleanRange || cleanRange === '*') return true;
    if (cleanRange === '^' || cleanRange === '~') {
      if (!currentVersion) return true; // can't resolve without current version
      const resolved = `${cleanRange}${currentVersion}`;
      return semver.satisfies(version, resolved);
    }
    return semver.satisfies(version, cleanRange);
  }
  // catalog: references can't be range-checked without catalog data,
  // so treat them as always satisfied (don't trigger out-of-range bumps)
  if (range.startsWith('catalog:')) return true;

  if (!range || range === '*') return true;
  return semver.satisfies(version, range);
}

/** Strip workspace: protocol from version ranges */
export function stripProtocol(range: string): string {
  return range.replace(/^workspace:/, '');
}

/** Compare two versions: -1 if a < b, 0 if equal, 1 if a > b */
export function compareVersions(a: string, b: string): number {
  return semver.compare(a, b);
}

export function isValidVersion(version: string): boolean {
  return semver.valid(version) !== null;
}
