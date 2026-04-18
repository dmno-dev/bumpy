import { test, expect, describe } from 'bun:test';
import { parseChangeset } from '../../src/core/changeset.ts';

describe('parseChangeset', () => {
  test('parses simple format', () => {
    const content = `---
"pkg-a": minor
"pkg-b": patch
---

Added a new feature to pkg-a
`;
    const cs = parseChangeset(content, 'test-cs');
    expect(cs).not.toBeNull();
    expect(cs!.id).toBe('test-cs');
    expect(cs!.releases).toHaveLength(2);
    expect(cs!.releases[0]!.name).toBe('pkg-a');
    expect(cs!.releases[0]!.type).toBe('minor');
    expect(cs!.releases[1]!.name).toBe('pkg-b');
    expect(cs!.releases[1]!.type).toBe('patch');
    expect(cs!.summary).toBe('Added a new feature to pkg-a');
  });

  test('parses patch-isolated bump type', () => {
    const content = `---
"pkg-a": patch-isolated
---

Internal change
`;
    const cs = parseChangeset(content, 'test-cs');
    expect(cs!.releases[0]!.type).toBe('patch-isolated');
  });

  test('parses none bump type', () => {
    const content = `---
"pkg-a": minor
"pkg-b": none
---

Feature in pkg-a, suppress bump on pkg-b
`;
    const cs = parseChangeset(content, 'test-cs');
    expect(cs!.releases).toHaveLength(2);
    expect(cs!.releases[0]!.type).toBe('minor');
    expect(cs!.releases[1]!.type).toBe('none');
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
    const cs = parseChangeset(content, 'test-cs');
    expect(cs).not.toBeNull();
    expect(cs!.releases).toHaveLength(1);
    const release = cs!.releases[0]! as any;
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
    const cs = parseChangeset(content, 'test-cs');
    expect(cs!.releases).toHaveLength(2);
    expect(cs!.releases[0]!.name).toBe('@myorg/core');
    expect(cs!.releases[1]!.name).toBe('@myorg/utils');
    expect(cs!.releases[1]!.type).toBe('patch');
  });

  test('returns null for invalid content', () => {
    expect(parseChangeset('no frontmatter here', 'bad')).toBeNull();
    expect(parseChangeset('---\n---\n', 'empty')).toBeNull();
  });

  test('handles multi-line summary', () => {
    const content = `---
"pkg-a": minor
---

First line

Second paragraph with more details.

- bullet point
`;
    const cs = parseChangeset(content, 'test-cs');
    expect(cs!.summary).toContain('First line');
    expect(cs!.summary).toContain('Second paragraph');
    expect(cs!.summary).toContain('- bullet point');
  });
});
