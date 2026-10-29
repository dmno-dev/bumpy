import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { checkCommand, requiredBumpFileCommands } from '../../src/commands/check.ts';
import { ciCheckCommand, formatEmptyBumpFileComment, formatReleasePlanComment } from '../../src/commands/ci.ts';
import { createTempGitRepo, cleanupTempDir, gitInDir, makeBumpFile, makeReleasePlan } from '../helpers.ts';

/**
 * Integration tests for `requireBumpFile`: a temp monorepo where `helper` requires its
 * own bump file and `app` uses the lenient default. Each test changes both packages on
 * a feature branch, adds some bump files, and asserts whether the check exits 1.
 */
describe('requireBumpFile', () => {
  let tmpDir: string;
  let remote: string;
  let output: string[];
  const spies: Array<{ mockRestore(): void }> = [];

  async function writeAt(path: string, content: string): Promise<void> {
    await mkdir(resolve(tmpDir, path, '..'), { recursive: true });
    await writeFile(resolve(tmpDir, path), content);
  }

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    gitInDir(['branch', '-M', 'main'], tmpDir);
    gitInDir(['config', 'user.email', 'test@example.com'], tmpDir);
    gitInDir(['config', 'user.name', 'Test'], tmpDir);

    await writeAt('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
    await writeAt('packages/app/package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    await writeAt('packages/app/index.js', 'export {};\n');
    await writeAt('packages/helper/package.json', JSON.stringify({ name: 'helper', version: '1.0.0' }));
    await writeAt('packages/helper/index.js', 'export {};\n');
    await writeAt('.bumpy/_config.json', JSON.stringify({ packages: { 'help*': { requireBumpFile: true } } }));
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'base'], tmpDir);

    remote = await mkdtemp(resolve(tmpdir(), 'bumpy-remote-'));
    gitInDir(['init', '--bare'], remote);
    gitInDir(['remote', 'add', 'origin', remote], tmpDir);
    gitInDir(['push', '-u', 'origin', 'main'], tmpDir);

    gitInDir(['checkout', '-b', 'feature'], tmpDir);
    await writeAt('packages/app/index.js', 'export const a = 1;\n');
    await writeAt('packages/helper/index.js', 'export const h = 1;\n');

    output = [];
    const capture = (...args: unknown[]) => void output.push(args.join(' '));
    spies.push(spyOn(console, 'log').mockImplementation(capture));
    spies.push(spyOn(console, 'error').mockImplementation(capture));
    spies.push(
      spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit),
    );
  });

  afterEach(async () => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    await cleanupTempDir(tmpDir);
    await rm(remote, { recursive: true, force: true });
  });

  async function commitBumpFiles(files: Record<string, string>): Promise<void> {
    for (const [id, content] of Object.entries(files)) await writeAt(`.bumpy/${id}.md`, content);
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'change'], tmpDir);
  }

  /** Run a check; returns the exit code (0 when it returned normally) */
  async function run(fn: () => Promise<void>): Promise<number> {
    try {
      await fn();
      return 0;
    } catch (err) {
      const match = /process\.exit\((\d*)\)/.exec((err as Error).message);
      if (!match) throw err;
      return Number(match[1] || 0);
    }
  }

  describe('bumpy check', () => {
    test('fails when a required package is uncovered, even with another bump file', async () => {
      await commitBumpFiles({ 'app-change': "---\n'app': patch\n---\n\nFix app\n" });
      expect(await run(() => checkCommand(tmpDir))).toBe(1);
      const text = output.join('\n');
      expect(text).toContain('helper');
      expect(text).toContain('add --packages "helper:patch"');
      expect(text).toContain('add --packages "helper:none"');
    });

    test('passes when the required package is listed with type none', async () => {
      await commitBumpFiles({ 'app-change': "---\n'app': patch\n'helper': none\n---\n\nFix app\n" });
      expect(await run(() => checkCommand(tmpDir))).toBe(0);
    });

    test('an empty bump file does not satisfy a required package', async () => {
      await commitBumpFiles({ nothing: '---\n---\n' });
      expect(await run(() => checkCommand(tmpDir))).toBe(1);
      const text = output.join('\n');
      expect(text).toContain('helper');
      // app is still acknowledged by the empty bump file
      expect(text).not.toMatch(/\bapp\b.*—/);
    });

    test('non-required packages keep the lenient default', async () => {
      await commitBumpFiles({ 'helper-change': "---\n'helper': patch\n---\n\nFix helper\n" });
      expect(await run(() => checkCommand(tmpDir))).toBe(0);
      expect(output.join('\n')).toContain('app');
    });

    test('--no-fail only warns', async () => {
      await commitBumpFiles({ 'app-change': "---\n'app': patch\n---\n\nFix app\n" });
      expect(await run(() => checkCommand(tmpDir, { noFail: true }))).toBe(0);
    });
  });

  describe('bumpy ci check', () => {
    test('fails when a required package is uncovered, even with another bump file', async () => {
      await commitBumpFiles({ 'app-change': "---\n'app': patch\n---\n\nFix app\n" });
      expect(await run(() => ciCheckCommand(tmpDir, { comment: false }))).toBe(1);
    });

    test('an empty bump file does not satisfy a required package', async () => {
      await commitBumpFiles({ nothing: '---\n---\n' });
      expect(await run(() => ciCheckCommand(tmpDir, { comment: false }))).toBe(1);
    });

    test('passes when the required package is listed with type none', async () => {
      await commitBumpFiles({ 'app-change': "---\n'app': patch\n'helper': none\n---\n\nFix app\n" });
      expect(await run(() => ciCheckCommand(tmpDir, { comment: false }))).toBe(0);
    });

    test('--no-fail only warns', async () => {
      await commitBumpFiles({ nothing: '---\n---\n' });
      expect(await run(() => ciCheckCommand(tmpDir, { comment: false, noFail: true }))).toBe(0);
    });
  });
});

describe('requireBumpFile PR comments', () => {
  test('release plan comment shows missing required packages as blocking', () => {
    const bf = makeBumpFile('app-change', [{ name: 'app', type: 'patch' }]);
    const body = formatReleasePlanComment(makeReleasePlan([], [bf]), [bf], '1', null, 'pnpm', [], [], [], null, null, [
      'helper',
    ]);
    expect(body).toContain(':x: Missing required bump files');
    expect(body).toContain('this check is failing');
    expect(body).toContain('pnpm exec bumpy add --packages "helper:patch"');
  });

  test('empty bump file comment is not a green light when required packages are missing', () => {
    const body = formatEmptyBumpFileComment(['nothing'], '1', null, ['helper'], 'npm');
    expect(body).not.toContain('no version bump is needed');
    expect(body).toContain('npx bumpy add --packages "helper:none"');
  });

  test('--no-fail renders the section as a warning', () => {
    const body = formatEmptyBumpFileComment(['nothing'], '1', null, ['helper'], 'npm', false);
    expect(body).toContain('⚠️ Missing required bump files');
    expect(body).not.toContain('this check is failing');
  });

  test('commands list every package', () => {
    expect(requiredBumpFileCommands(['@s/a', '@s/b'])[0]).toContain('bumpy add --packages "@s/a:patch,@s/b:patch"');
  });
});
