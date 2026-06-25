import { test, expect, describe } from 'bun:test';
import { extractCwdFlag, pullRequestTargetCwdError } from '../../src/utils/cwd.ts';

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

describe('pullRequestTargetCwdError', () => {
  test('errors under pull_request_target without --cwd', () => {
    const err = pullRequestTargetCwdError({ eventName: 'pull_request_target', cwdProvided: false });
    expect(err).toContain('pull_request_target');
    expect(err).toContain('--cwd ./pr');
  });

  test('no error when --cwd is provided (even just `--cwd .`)', () => {
    expect(pullRequestTargetCwdError({ eventName: 'pull_request_target', cwdProvided: true })).toBeNull();
  });

  test('no error for a plain pull_request event (non-privileged)', () => {
    expect(pullRequestTargetCwdError({ eventName: 'pull_request', cwdProvided: false })).toBeNull();
  });

  test('no error for push events', () => {
    expect(pullRequestTargetCwdError({ eventName: 'push', cwdProvided: false })).toBeNull();
  });

  test('no error outside CI (no event name)', () => {
    expect(pullRequestTargetCwdError({ eventName: undefined, cwdProvided: false })).toBeNull();
  });
});
