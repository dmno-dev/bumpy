import { describe, test, expect } from 'bun:test';
import { formatNoBumpFilesComment } from '../../src/commands/ci.ts';

describe('formatNoBumpFilesComment — passing (--no-fail)', () => {
  const comment = formatNoBumpFilesComment('feature-branch', 'npm', false, ['@myorg/core']);

  test('keeps the friendly "you\'re good to go" wording', () => {
    expect(comment).toContain("you're good to go");
    expect(comment).not.toContain('this check is failing');
  });

  test('uses the warning frog, not the error frog', () => {
    expect(comment).toContain('frog-warning.png');
    expect(comment).not.toContain('frog-error.png');
  });
});

describe('formatNoBumpFilesComment — failing (default / strict)', () => {
  const comment = formatNoBumpFilesComment('feature-branch', 'pnpm', true, ['@myorg/core', '@myorg/utils']);

  test('does not contradict the failing status with "good to go"', () => {
    expect(comment).not.toContain("you're good to go");
    expect(comment).toContain('this check is failing');
  });

  test('reports the changed packages that lack a bump file', () => {
    expect(comment).toContain('2 packages but has no bump file');
    expect(comment).toContain('- `@myorg/core`');
    expect(comment).toContain('- `@myorg/utils`');
  });

  test('offers the empty bump file as the no-release acknowledgment', () => {
    expect(comment).toContain('pnpm exec bumpy add --empty');
    expect(comment).toContain('acknowledge');
  });

  test('uses the error frog to match the failing status', () => {
    expect(comment).toContain('frog-error.png');
  });

  test('singularizes the headline for a single changed package', () => {
    const single = formatNoBumpFilesComment('feature-branch', 'npm', true, ['@myorg/core']);
    expect(single).toContain('1 package but has no bump file');
  });
});
