import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { installShellMock, uninstallShellMock, getCallsMatching, addMockRule } from '../helpers-shell-mock.ts';
import { composeReleaseBody, parseReleaseMetadata, type ReleaseMetadata } from '../../src/core/github-release.ts';
import { reopenCommand } from '../../src/commands/reopen.ts';

/** Mock `gh release view <tag> --json ...` to return a release with the given body. */
function mockReleaseView(body: string, isDraft = true) {
  addMockRule({
    match: /^gh release view/,
    response: JSON.stringify({ tagName: 'pkg-a@1.2.3', name: 'pkg-a v1.2.3', body, isDraft }),
  });
}

describe('reopenCommand', () => {
  beforeEach(() => installShellMock());
  afterEach(() => uninstallShellMock());

  const stagedMeta: ReleaseMetadata = {
    version: '1.2.3',
    targets: { npm: { status: 'staged', stageId: 'uuid-1', stagedAt: '2026-01-01T00:00:00Z' } },
  };

  test('flips a staged target to failed and edits the release body', async () => {
    mockReleaseView(composeReleaseBody('- A change', stagedMeta));
    addMockRule({ match: /^gh release edit/, response: '' });

    await reopenCommand('/tmp/x', { tag: 'pkg-a@1.2.3' });

    const editCalls = getCallsMatching('gh release edit');
    expect(editCalls.length).toBe(1);

    // The edited body's metadata should now show the target as failed (rejected).
    const notesIdx = editCalls[0]!.args.indexOf('--notes');
    const newBody = editCalls[0]!.args[notesIdx + 1]!;
    const meta = parseReleaseMetadata(newBody)!;
    expect(meta.targets.npm!.status).toBe('failed');
    expect(meta.targets.npm!.error).toContain('rejected');
    // No longer staged — the stale 🟡 marker is gone.
    expect(newBody).not.toContain('🟡');
  });

  test('dry-run does not edit the release', async () => {
    mockReleaseView(composeReleaseBody('- A change', stagedMeta));
    addMockRule({ match: /^gh release edit/, response: '' });

    await reopenCommand('/tmp/x', { tag: 'pkg-a@1.2.3', dryRun: true });

    expect(getCallsMatching('gh release edit')).toHaveLength(0);
  });

  test('no-ops when the release has no staged targets', async () => {
    const liveMeta: ReleaseMetadata = {
      version: '1.2.3',
      targets: { npm: { status: 'success', url: 'https://npmjs.com/package/pkg-a/v/1.2.3' } },
    };
    mockReleaseView(composeReleaseBody('- A change', liveMeta));
    addMockRule({ match: /^gh release edit/, response: '' });

    await reopenCommand('/tmp/x', { tag: 'pkg-a@1.2.3' });

    expect(getCallsMatching('gh release edit')).toHaveLength(0);
  });
});
