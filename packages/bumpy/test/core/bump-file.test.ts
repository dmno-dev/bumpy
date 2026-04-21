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
    const bf = parseBumpFile(content, 'test-bf');
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
    const bf = parseBumpFile(content, 'test-bf');
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
    const bf = parseBumpFile(content, 'test-bf');
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
    const bf = parseBumpFile(content, 'test-bf');
    expect(bf!.releases).toHaveLength(2);
    expect(bf!.releases[0]!.name).toBe('@myorg/core');
    expect(bf!.releases[1]!.name).toBe('@myorg/utils');
    expect(bf!.releases[1]!.type).toBe('patch');
  });

  test('returns null for invalid content', () => {
    expect(parseBumpFile('no frontmatter here', 'bad')).toBeNull();
    expect(parseBumpFile('---\n---\n', 'empty')).toBeNull();
  });

  test('handles multi-line summary', () => {
    const content = `---
"pkg-a": minor
---

First line

Second paragraph with more details.

- bullet point
`;
    const bf = parseBumpFile(content, 'test-bf');
    expect(bf!.summary).toContain('First line');
    expect(bf!.summary).toContain('Second paragraph');
    expect(bf!.summary).toContain('- bullet point');
  });
});
