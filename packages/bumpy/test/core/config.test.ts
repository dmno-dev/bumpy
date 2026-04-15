import { test, expect, describe } from 'bun:test';
import { matchGlob, isPackageManaged } from '../../src/core/config.ts';
import { makeConfig } from '../helpers.ts';

describe('matchGlob', () => {
  test('exact match', () => {
    expect(matchGlob('pkg-a', 'pkg-a')).toBe(true);
    expect(matchGlob('pkg-a', 'pkg-b')).toBe(false);
  });

  test('wildcard *', () => {
    expect(matchGlob('plugin-auth', 'plugin-*')).toBe(true);
    expect(matchGlob('plugin-cache', 'plugin-*')).toBe(true);
    expect(matchGlob('other-thing', 'plugin-*')).toBe(false);
  });

  test('scoped packages with wildcard', () => {
    expect(matchGlob('@myorg/core', '@myorg/*')).toBe(true);
    expect(matchGlob('@myorg/plugin-a', '@myorg/plugin-*')).toBe(true);
    expect(matchGlob('@other/core', '@myorg/*')).toBe(false);
  });

  test('double wildcard **', () => {
    expect(matchGlob('@myorg/a/b/c', '@myorg/**')).toBe(true);
    expect(matchGlob('@myorg/core', '@myorg/**')).toBe(true);
  });
});

describe('isPackageManaged', () => {
  test('public packages are managed by default', () => {
    expect(isPackageManaged('pkg-a', false, makeConfig())).toBe(true);
  });

  test('private packages are NOT managed by default', () => {
    expect(isPackageManaged('pkg-a', true, makeConfig())).toBe(false);
  });

  test('private packages managed when privatePackages.version is true', () => {
    expect(isPackageManaged('pkg-a', true, makeConfig({ privatePackages: { version: true, tag: false } }))).toBe(true);
  });

  test('ignore excludes packages by exact name', () => {
    expect(isPackageManaged('pkg-a', false, makeConfig({ ignore: ['pkg-a'] }))).toBe(false);
  });

  test('ignore supports globs', () => {
    expect(isPackageManaged('@myorg/internal-tool', false, makeConfig({ ignore: ['@myorg/internal-*'] }))).toBe(false);
    expect(isPackageManaged('@myorg/core', false, makeConfig({ ignore: ['@myorg/internal-*'] }))).toBe(true);
  });

  test('include overrides private', () => {
    expect(isPackageManaged('my-vscode-ext', true, makeConfig({ include: ['my-vscode-ext'] }))).toBe(true);
  });

  test('include supports globs', () => {
    expect(isPackageManaged('@myorg/app-a', true, makeConfig({ include: ['@myorg/app-*'] }))).toBe(true);
    expect(isPackageManaged('@myorg/lib-b', true, makeConfig({ include: ['@myorg/app-*'] }))).toBe(false);
  });

  test('include overrides ignore', () => {
    expect(isPackageManaged('pkg-special', false, makeConfig({ ignore: ['pkg-*'], include: ['pkg-special'] }))).toBe(
      true,
    );
    expect(isPackageManaged('pkg-other', false, makeConfig({ ignore: ['pkg-*'], include: ['pkg-special'] }))).toBe(
      false,
    );
  });

  test('per-package managed: true overrides everything', () => {
    expect(isPackageManaged('pkg-a', true, makeConfig({ ignore: ['pkg-a'] }), { managed: true })).toBe(true);
  });

  test('per-package managed: false overrides everything', () => {
    expect(isPackageManaged('pkg-a', false, makeConfig({ include: ['pkg-a'] }), { managed: false })).toBe(false);
  });
});
