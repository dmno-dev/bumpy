import { test, expect, describe } from 'bun:test';
import { parseJsonc } from '../../src/utils/jsonc.ts';

describe('parseJsonc', () => {
  test('parses plain JSON', () => {
    expect(parseJsonc('{"a": 1}')).toEqual({ a: 1 });
  });

  test('strips line comments', () => {
    const input = `{
      // this is a comment
      "a": 1
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  test('strips block comments', () => {
    const input = `{
      /* block comment */
      "a": 1
    }`;
    expect(parseJsonc(input)).toEqual({ a: 1 });
  });

  test('handles trailing commas', () => {
    const input = `{ "a": 1, "b": 2, }`;
    expect(parseJsonc(input)).toEqual({ a: 1, b: 2 });
  });

  test('preserves comment-like strings in values', () => {
    const input = `{ "url": "https://example.com // not a comment" }`;
    expect(parseJsonc(input)).toEqual({ url: 'https://example.com // not a comment' });
  });

  test('throws on invalid JSON', () => {
    expect(() => parseJsonc('{ bad }')).toThrow();
  });

  test('throws on empty input', () => {
    expect(() => parseJsonc('')).toThrow();
  });
});
