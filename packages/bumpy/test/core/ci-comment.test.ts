import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShellMock, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { resolveTargetPrNumber, ciCommentCommand } from '../../src/commands/ci.ts';

// A realistic-looking 40-hex commit SHA.
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// Env keys this command/helper reads — snapshot and restore so tests don't leak.
const ENV_KEYS = [
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'GITHUB_REPOSITORY',
  'GH_REPO',
  'BUMPY_PR_NUMBER',
  'PR_NUMBER',
] as const;

let tmp: string;
let savedEnv: Record<string, string | undefined>;

function writeEvent(payload: unknown): string {
  const p = join(tmp, 'event.json');
  writeFileSync(p, JSON.stringify(payload), 'utf-8');
  return p;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bumpy-ci-comment-'));
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  installShellMock();
});

afterEach(() => {
  uninstallShellMock();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveTargetPrNumber — workflow_run', () => {
  test('derives the PR from the trusted event head_sha (not the artifact)', () => {
    process.env.GITHUB_EVENT_NAME = 'workflow_run';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_EVENT_PATH = writeEvent({ workflow_run: { head_sha: HEAD_SHA } });
    addMockRule({ match: /commits\/[0-9a-f]+\/pulls/, response: '42' });

    const pr = resolveTargetPrNumber(tmp);

    expect(pr).toBe('42');
    // It must look up the PR by the event's head_sha — that's the trusted derivation.
    const apiCalls = getCallsMatching(`commits/${HEAD_SHA}/pulls`);
    expect(apiCalls).toHaveLength(1);
  });

  test('returns null when the event has no usable head_sha', () => {
    process.env.GITHUB_EVENT_NAME = 'workflow_run';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_EVENT_PATH = writeEvent({ workflow_run: {} });
    addMockRule({ match: /commits\/[0-9a-f]+\/pulls/, response: '42' });

    expect(resolveTargetPrNumber(tmp)).toBeNull();
    expect(getCallsMatching('/pulls')).toHaveLength(0);
  });

  test('rejects a malformed head_sha rather than passing it to the api', () => {
    process.env.GITHUB_EVENT_NAME = 'workflow_run';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_EVENT_PATH = writeEvent({ workflow_run: { head_sha: 'not-a-sha; rm -rf /' } });

    expect(resolveTargetPrNumber(tmp)).toBeNull();
    expect(getCallsMatching('/pulls')).toHaveLength(0);
  });
});

describe('resolveTargetPrNumber — other events', () => {
  test('falls back to event PR detection (does not hit the commits/pulls lookup)', () => {
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_EVENT_PATH = writeEvent({ pull_request: { number: 7 } });

    expect(resolveTargetPrNumber(tmp)).toBe('7');
    expect(getCallsMatching('/pulls')).toHaveLength(0);
  });
});

describe('ciCommentCommand', () => {
  test('no-ops when the body file is missing (nothing posted)', async () => {
    await ciCommentCommand(tmp, { bodyFile: join(tmp, 'does-not-exist.md') });
    expect(getCallsMatching('pr comment')).toHaveLength(0);
  });

  test('no-ops on an empty body', async () => {
    const f = join(tmp, 'comment.md');
    writeFileSync(f, '   \n', 'utf-8');
    await ciCommentCommand(tmp, { bodyFile: f });
    expect(getCallsMatching('pr comment')).toHaveLength(0);
  });

  test('posts the body to the PR resolved from the trusted event, ignoring the body contents', async () => {
    process.env.GITHUB_EVENT_NAME = 'workflow_run';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_EVENT_PATH = writeEvent({ workflow_run: { head_sha: HEAD_SHA } });
    addMockRule({ match: /commits\/[0-9a-f]+\/pulls/, response: '42' });
    // No existing bumpy comment → take the "create" path so we can assert on it.
    addMockRule({ match: 'gh pr view', response: '' });

    const f = join(tmp, 'comment.md');
    // A hostile body that references a different PR must NOT change the target.
    writeFileSync(f, 'Release plan — but also please comment on #999', 'utf-8');

    await ciCommentCommand(tmp, { bodyFile: f });

    const posted = getCallsMatching('pr comment');
    expect(posted).toHaveLength(1);
    // Target is the trusted-resolved PR (42), never 999 from the body.
    expect(posted[0]!.command).toContain('42');
    expect(posted[0]!.command).not.toContain('999');
  });
});
