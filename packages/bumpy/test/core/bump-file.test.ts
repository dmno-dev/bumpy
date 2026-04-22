import { test, expect, describe } from 'bun:test';
import { parseBumpFile } from '../../src/core/bump-file.ts';

describe('parseBumpFile', () => {
  test('parses simple format', () => {
    const content = `---
"pkg-a": minor
"pkg-b": patch
---

Added a new feature to pkg-a
`;
    const { bumpFile: bf, errors } = parseBumpFile(content, 'test-bf');
    expect(errors).toHaveLength(0);
    expect(bf).not.toBeNull();
    expect(bf!.id).toBe('test-bf');
    expect(bf!.releases).toHaveLength(2);
    expect(bf!.releases[0]!.name).toBe('pkg-a');
    expect(bf!.releases[0]!.type).toBe('minor');
    expect(bf!.releases[1]!.name).toBe('pkg-b');
    expect(bf!.releases[1]!.type).toBe('patch');
    expect(bf!.summary).toBe('Added a new feature to pkg-a');
  });

  test('parses none bump type', () => {
    const content = `---
"pkg-a": minor
"pkg-b": none
---

Feature in pkg-a, suppress bump on pkg-b
`;
    const { bumpFile: bf, errors } = parseBumpFile(content, 'test-bf');
    expect(errors).toHaveLength(0);
    expect(bf!.releases).toHaveLength(2);
    expect(bf!.releases[0]!.type).toBe('minor');
    expect(bf!.releases[1]!.type).toBe('none');
  });

  test('parses nested format with cascade', () => {
    const content = `---
"@myorg/core":
  bump: minor
  cascade:
    "plugins/*": patch
    "@myorg/cli": minor
---

Added encryption provider
`;
    const { bumpFile: bf, errors } = parseBumpFile(content, 'test-bf');
    expect(errors).toHaveLength(0);
    expect(bf).not.toBeNull();
    expect(bf!.releases).toHaveLength(1);
    const release = bf!.releases[0]! as any;
    expect(release.name).toBe('@myorg/core');
    expect(release.type).toBe('minor');
    expect(release.cascade).toEqual({
      'plugins/*': 'patch',
      '@myorg/cli': 'minor',
    });
  });

  test('parses mixed simple and nested', () => {
    const content = `---
"@myorg/core":
  bump: minor
  cascade:
    "plugins/*": patch
"@myorg/utils": patch
---

Mixed changes
`;
    const { bumpFile: bf, errors } = parseBumpFile(content, 'test-bf');
    expect(errors).toHaveLength(0);
    expect(bf!.releases).toHaveLength(2);
    expect(bf!.releases[0]!.name).toBe('@myorg/core');
    expect(bf!.releases[1]!.name).toBe('@myorg/utils');
    expect(bf!.releases[1]!.type).toBe('patch');
  });

  test('returns errors for missing frontmatter', () => {
    const noFrontmatter = parseBumpFile('no frontmatter here', 'bad');
    expect(noFrontmatter.bumpFile).toBeNull();
    expect(noFrontmatter.errors).toHaveLength(1);
    expect(noFrontmatter.errors[0]).toContain('no valid frontmatter');
  });

  test('returns no errors for intentionally empty bump file (no newline)', () => {
    const result = parseBumpFile('---\n---\n', 'empty');
    expect(result.bumpFile).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  test('returns no errors for intentionally empty bump file (with newline)', () => {
    const result = parseBumpFile('---\n\n---\n', 'empty');
    expect(result.bumpFile).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  test('returns no errors for intentionally empty bump file (with whitespace)', () => {
    const result = parseBumpFile('---\n  \n---\n', 'empty');
    expect(result.bumpFile).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  test('returns errors for invalid bump types', () => {
    const content = `---
"pkg-a": bogus
---

Bad bump type
`;
    const { bumpFile, errors } = parseBumpFile(content, 'test-bf');
    expect(bumpFile).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown bump type "bogus"');
    expect(errors[0]).toContain('expected: major, minor, patch, or none');
  });

  test('returns partial results with errors for mixed valid/invalid entries', () => {
    const content = `---
"pkg-a": minor
"pkg-b": bogus
---

Mixed
`;
    const { bumpFile, errors } = parseBumpFile(content, 'test-bf');
    expect(bumpFile).not.toBeNull();
    expect(bumpFile!.releases).toHaveLength(1);
    expect(bumpFile!.releases[0]!.name).toBe('pkg-a');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"bogus"');
  });

  test('handles multi-line summary', () => {
    const content = `---
"pkg-a": minor
---

First line

Second paragraph with more details.

- bullet point
`;
    const { bumpFile: bf, errors } = parseBumpFile(content, 'test-bf');
    expect(errors).toHaveLength(0);
    expect(bf!.summary).toContain('First line');
    expect(bf!.summary).toContain('Second paragraph');
    expect(bf!.summary).toContain('- bullet point');
  });
});
