import { test, expect, describe } from 'bun:test';
import { randomName, slugify } from '../../src/utils/names.ts';

describe('randomName', () => {
  test('returns a string with two hyphens (adj-adj-noun)', () => {
    const name = randomName();
    const parts = name.split('-');
    expect(parts).toHaveLength(3);
  });

  test('generates different names on successive calls', () => {
    const names = new Set(Array.from({ length: 20 }, () => randomName()));
    // With 60 adjectives and 60 nouns, collisions are extremely unlikely in 20 tries
    expect(names.size).toBeGreaterThan(10);
  });

  test('contains only lowercase letters and hyphens', () => {
    for (let i = 0; i < 10; i++) {
      const name = randomName();
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    }
  });
});

describe('slugify', () => {
  test('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  test('replaces special characters with hyphens', () => {
    expect(slugify('foo@bar!baz')).toBe('foo-bar-baz');
  });

  test('collapses multiple non-alphanumeric chars', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  test('strips leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  test('preserves numbers', () => {
    expect(slugify('v1.2.3')).toBe('v1-2-3');
  });

  test('handles already-slugified input', () => {
    expect(slugify('already-good')).toBe('already-good');
  });
});
