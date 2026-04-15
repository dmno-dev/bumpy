import { test, expect, describe } from 'bun:test';
import { bumpVersion, satisfies, stripProtocol, compareVersions, isValidVersion } from '../../src/core/semver.ts';

describe('bumpVersion', () => {
  test('bumps patch', () => {
    expect(bumpVersion('1.0.0', 'patch')).toBe('1.0.1');
  });

  test('bumps minor', () => {
    expect(bumpVersion('1.0.0', 'minor')).toBe('1.1.0');
  });

  test('bumps major', () => {
    expect(bumpVersion('1.0.0', 'major')).toBe('2.0.0');
  });

  test('bumps minor resets patch', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  test('bumps major resets minor and patch', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('handles prerelease versions', () => {
    expect(bumpVersion('1.0.0-alpha.1', 'patch')).toBe('1.0.0');
  });

  test('throws on invalid version', () => {
    expect(() => bumpVersion('not-a-version', 'patch')).toThrow();
  });
});

describe('satisfies', () => {
  test('caret range satisfied by minor bump', () => {
    expect(satisfies('1.1.0', '^1.0.0')).toBe(true);
  });

  test('caret range NOT satisfied by major bump', () => {
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
  });

  test('tilde range satisfied by patch bump', () => {
    expect(satisfies('1.0.1', '~1.0.0')).toBe(true);
  });

  test('tilde range NOT satisfied by minor bump', () => {
    expect(satisfies('1.1.0', '~1.0.0')).toBe(false);
  });

  test('exact range only matches exact version', () => {
    expect(satisfies('1.0.0', '1.0.0')).toBe(true);
    expect(satisfies('1.0.1', '1.0.0')).toBe(false);
  });

  test('wildcard always satisfies', () => {
    expect(satisfies('99.99.99', '*')).toBe(true);
  });

  test('empty range always satisfies', () => {
    expect(satisfies('1.0.0', '')).toBe(true);
  });

  // workspace: protocol handling
  test('workspace:^ always satisfies', () => {
    expect(satisfies('2.0.0', 'workspace:^')).toBe(true);
  });

  test('workspace:~ always satisfies', () => {
    expect(satisfies('2.0.0', 'workspace:~')).toBe(true);
  });

  test('workspace:* always satisfies', () => {
    expect(satisfies('2.0.0', 'workspace:*')).toBe(true);
  });

  test('workspace: with real range checks the range', () => {
    expect(satisfies('1.1.0', 'workspace:^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', 'workspace:^1.0.0')).toBe(false);
  });

  // catalog: protocol handling
  test('catalog: always satisfies (cannot resolve)', () => {
    expect(satisfies('99.0.0', 'catalog:')).toBe(true);
  });

  test('catalog:named always satisfies', () => {
    expect(satisfies('99.0.0', 'catalog:testing')).toBe(true);
  });
});

describe('stripProtocol', () => {
  test('strips workspace: prefix', () => {
    expect(stripProtocol('workspace:^1.0.0')).toBe('^1.0.0');
  });

  test('strips workspace: with shorthand', () => {
    expect(stripProtocol('workspace:*')).toBe('*');
  });

  test('leaves non-workspace ranges unchanged', () => {
    expect(stripProtocol('^1.0.0')).toBe('^1.0.0');
  });

  test('leaves catalog: unchanged (only strips workspace:)', () => {
    expect(stripProtocol('catalog:')).toBe('catalog:');
  });
});

describe('compareVersions', () => {
  test('returns -1 when a < b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
  });

  test('returns 0 when equal', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  test('returns 1 when a > b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
  });

  test('compares minor versions', () => {
    expect(compareVersions('1.1.0', '1.2.0')).toBe(-1);
  });

  test('compares patch versions', () => {
    expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
  });
});

describe('isValidVersion', () => {
  test('valid semver returns true', () => {
    expect(isValidVersion('1.0.0')).toBe(true);
    expect(isValidVersion('0.0.1')).toBe(true);
    expect(isValidVersion('1.2.3-alpha.1')).toBe(true);
  });

  test('invalid semver returns false', () => {
    expect(isValidVersion('not-a-version')).toBe(false);
    expect(isValidVersion('1.0')).toBe(false);
    expect(isValidVersion('')).toBe(false);
  });
});
