import { test, expect, describe } from 'bun:test';
import { mapFilesToPackages } from '../../src/commands/generate.ts';
import { makePkg } from '../helpers.ts';

describe('mapFilesToPackages', () => {
  const rootDir = '/repo';

  test('attributes every file to the root package in a single-package repo', () => {
    const packages = new Map([['fledgling', makePkg('fledgling', '1.0.0', { dir: rootDir })]]);
    const result = mapFilesToPackages(['src/cli.ts', 'package.json'], packages, rootDir);
    expect(result).toEqual(['fledgling']);
  });

  test('scopes files by directory in a monorepo', () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0', { dir: `${rootDir}/packages/pkg-a` })],
      ['pkg-b', makePkg('pkg-b', '1.0.0', { dir: `${rootDir}/packages/pkg-b` })],
    ]);
    const result = mapFilesToPackages(['packages/pkg-b/src/index.ts'], packages, rootDir);
    expect(result).toEqual(['pkg-b']);
  });
});
