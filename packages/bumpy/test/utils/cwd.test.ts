import { test, expect, describe } from 'bun:test';
import { extractCwdFlag } from '../../src/utils/cwd.ts';

describe('extractCwdFlag', () => {
  test('absent flag returns args unchanged', () => {
    const { cwd, rest } = extractCwdFlag(['ci', 'check']);
    expect(cwd).toBeUndefined();
    expect(rest).toEqual(['ci', 'check']);
  });

  test('--cwd <dir> form is extracted and stripped', () => {
    const { cwd, rest } = extractCwdFlag(['ci', 'check', '--cwd', './pr']);
    expect(cwd).toBe('./pr');
    expect(rest).toEqual(['ci', 'check']);
  });

  test('--cwd=<dir> form is extracted and stripped', () => {
    const { cwd, rest } = extractCwdFlag(['--cwd=/tmp/pr', 'ci', 'check']);
    expect(cwd).toBe('/tmp/pr');
    expect(rest).toEqual(['ci', 'check']);
  });

  test('flag can appear before the command', () => {
    const { cwd, rest } = extractCwdFlag(['--cwd', './pr', 'status', '--json']);
    expect(cwd).toBe('./pr');
    expect(rest).toEqual(['status', '--json']);
  });

  test('other flags are preserved', () => {
    const { cwd, rest } = extractCwdFlag(['ci', 'release', '--cwd', './pr', '--expect-mode', 'publish']);
    expect(cwd).toBe('./pr');
    expect(rest).toEqual(['ci', 'release', '--expect-mode', 'publish']);
  });

  test('throws when --cwd has no value', () => {
    expect(() => extractCwdFlag(['ci', 'check', '--cwd'])).toThrow('--cwd requires a directory argument');
  });

  test('throws when --cwd is followed by another flag', () => {
    expect(() => extractCwdFlag(['--cwd', '--json', 'status'])).toThrow('--cwd requires a directory argument');
  });

  test('throws on empty --cwd= value', () => {
    expect(() => extractCwdFlag(['--cwd=', 'status'])).toThrow('--cwd requires a directory argument');
  });

  test('a literal "--cwd" value works (not confused with the flag)', () => {
    // `--cwd ./--cwd` — directory literally named that; only the first token is the flag
    const { cwd, rest } = extractCwdFlag(['add', '--cwd', './--cwd-dir']);
    expect(cwd).toBe('./--cwd-dir');
    expect(rest).toEqual(['add']);
  });
});
