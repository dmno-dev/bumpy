import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import {
  detectDependencyChanges,
  formatDependencyChange,
  syncDependencyBumpFiles,
  type DependencyChange,
} from '../../src/core/dep-bump-files.ts';
import { discoverWorkspace } from '../../src/core/workspace.ts';
import { getBaseCompareRef } from '../../src/core/git.ts';
import { loadConfig } from '../../src/core/config.ts';
import { createTempGitRepo, cleanupTempDir, gitInDir } from '../helpers.ts';

describe('formatDependencyChange', () => {
  test('updated dep links to the npm version', () => {
    const change: DependencyChange = {
      name: '@scope/lib',
      depType: 'dependencies',
      kind: 'updated',
      from: '^1.2.0',
      to: '^1.3',
    };
    expect(formatDependencyChange(change)).toBe(
      'Updated dependency [`@scope/lib@^1.3` ↗︎](https://www.npmjs.com/package/@scope/lib/v/1.3.0) (from `^1.2.0`, in `dependencies`)',
    );
  });

  test('added / removed wording', () => {
    expect(formatDependencyChange({ name: 'a', depType: 'peerDependencies', kind: 'added', to: '2.0.0' })).toBe(
      'Added dependency [`a@2.0.0` ↗︎](https://www.npmjs.com/package/a/v/2.0.0) (to `peerDependencies`)',
    );
    expect(formatDependencyChange({ name: 'a', depType: 'dependencies', kind: 'removed', from: '^1.0.0' })).toBe(
      'Removed dependency [`a@^1.0.0` ↗︎](https://www.npmjs.com/package/a/v/1.0.0) (from `dependencies`)',
    );
  });

  test('non-registry specifiers are not linked', () => {
    expect(
      formatDependencyChange({ name: 'a', depType: 'dependencies', kind: 'added', to: 'github:org/a#v1.0.0' }),
    ).toBe('Added dependency `a@github:org/a#v1.0.0` (to `dependencies`)');
  });
});

describe('dependency bump files (git integration)', () => {
  let tmpDir: string;
  const teardown: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tmpDir = await createTempGitRepo();
    gitInDir(['branch', '-M', 'main'], tmpDir);
    gitInDir(['config', 'user.email', 'test@example.com'], tmpDir);
    gitInDir(['config', 'user.name', 'Test'], tmpDir);
  });

  afterEach(async () => {
    for (const fn of teardown) await fn();
    teardown.length = 0;
    await cleanupTempDir(tmpDir);
  });

  async function writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(resolve(tmpDir, path, '..'), { recursive: true });
    await writeFile(resolve(tmpDir, path), `${JSON.stringify(data, null, 2)}\n`);
  }

  /** Commit `pkgs` (path → package.json) on main, push to a bare origin, then branch. */
  async function setup(pkgs: Record<string, Record<string, unknown>>, rootExtra: Record<string, unknown> = {}) {
    await writeJson('package.json', { name: 'root', private: true, workspaces: ['packages/*'], ...rootExtra });
    for (const [dir, pkg] of Object.entries(pkgs)) await writeJson(`packages/${dir}/package.json`, pkg);
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init'], tmpDir);
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const remote = await mkdtemp(resolve(tmpdir(), 'bumpy-remote-'));
    gitInDir(['init', '--bare'], remote);
    gitInDir(['remote', 'add', 'origin', remote], tmpDir);
    gitInDir(['push', '-u', 'origin', 'main'], tmpDir);
    teardown.push(() => rm(remote, { recursive: true, force: true }));
    gitInDir(['checkout', '-b', 'dependabot/npm_and_yarn/lodash'], tmpDir);
  }

  async function detect() {
    const config = await loadConfig(tmpDir);
    const { packages } = await discoverWorkspace(tmpDir, config);
    const baseRef = getBaseCompareRef(tmpDir, config.baseBranch);
    return { changes: await detectDependencyChanges(tmpDir, config, packages, baseRef), baseRef };
  }

  test('detects runtime/peer changes, ignores dev-only and workspace deps', async () => {
    await setup({
      core: { name: 'core', version: '1.0.0' },
      app: {
        name: 'app',
        version: '1.0.0',
        dependencies: { lodash: '^4.0.0', core: 'workspace:^1.0.0', old: '^1.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      },
    });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      dependencies: { lodash: '^4.17.21', core: 'workspace:^1.1.0' },
      peerDependencies: { react: '^19.0.0' },
      devDependencies: { vitest: '^2.0.0' },
    });

    const { changes } = await detect();
    expect([...changes.keys()]).toEqual(['app']);
    expect(changes.get('app')).toEqual([
      { name: 'lodash', depType: 'dependencies', kind: 'updated', from: '^4.0.0', to: '^4.17.21' },
      { name: 'old', depType: 'dependencies', kind: 'removed', from: '^1.0.0', to: undefined },
      { name: 'react', depType: 'peerDependencies', kind: 'added', from: undefined, to: '^19.0.0' },
    ]);
  });

  test('releaseTriggeringDevDeps devDependencies count', async () => {
    await setup({
      app: {
        name: 'app',
        version: '1.0.0',
        devDependencies: { nanoid: '^4.0.0', vitest: '^1.0.0' },
        bumpy: { releaseTriggeringDevDeps: ['nanoid'] },
      },
    });
    await writeJson('packages/app/package.json', {
      name: 'app',
      version: '1.0.0',
      devDependencies: { nanoid: '^5.0.0', vitest: '^2.0.0' },
      bumpy: { releaseTriggeringDevDeps: ['nanoid'] },
    });
    const { changes } = await detect();
    expect(changes.get('app')?.map((c) => c.name)).toEqual(['nanoid']);
  });

  test('catalog updates are attributed to packages that use the catalog entry', async () => {
    await setup(
      {
        app: { name: 'app', version: '1.0.0', dependencies: { lodash: 'catalog:' } },
        other: { name: 'other', version: '1.0.0', dependencies: { zod: '^3.0.0' } },
      },
      { workspaces: { packages: ['packages/*'], catalog: { lodash: '^4.0.0' } } },
    );
    await writeJson('package.json', {
      name: 'root',
      private: true,
      workspaces: { packages: ['packages/*'], catalog: { lodash: '^4.17.21' } },
    });
    const { changes } = await detect();
    expect([...changes.keys()]).toEqual(['app']);
    expect(changes.get('app')![0]).toMatchObject({ name: 'lodash', from: '^4.0.0', to: '^4.17.21' });
  });

  test('writes one patch bump file per package and removes stale ones on re-run', async () => {
    await setup({
      a: { name: '@org/a', version: '1.0.0', dependencies: { lodash: '^4.0.0' } },
      b: { name: '@org/b', version: '1.0.0', dependencies: { lodash: '^4.0.0' } },
    });
    // A pre-existing, merged file with a colliding prefix must never be deleted
    await mkdir(resolve(tmpDir, '.bumpy'), { recursive: true });
    await writeFile(resolve(tmpDir, '.bumpy/deps-pr7-org-old.md'), '---\n"@org/a": patch\n---\n\nold\n');
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'merged file'], tmpDir);
    gitInDir(['push', 'origin', 'HEAD:main'], tmpDir);

    for (const dir of ['a', 'b']) {
      await writeJson(`packages/${dir}/package.json`, {
        name: `@org/${dir}`,
        version: '1.0.0',
        dependencies: { lodash: '^4.17.21' },
      });
    }
    let { changes, baseRef } = await detect();
    let result = await syncDependencyBumpFiles(tmpDir, changes, 'pr7', baseRef);
    expect(result.written.sort()).toEqual(['deps-pr7-org-a', 'deps-pr7-org-b']);
    const content = await readFile(resolve(tmpDir, '.bumpy/deps-pr7-org-a.md'), 'utf-8');
    expect(content).toContain('"@org/a": patch');
    expect(content).toContain('Updated dependency [`lodash@^4.17.21` ↗︎]');

    // Revert b's change — its file goes away, a's stays, the merged file is untouched
    await writeJson('packages/b/package.json', {
      name: '@org/b',
      version: '1.0.0',
      dependencies: { lodash: '^4.0.0' },
    });
    ({ changes, baseRef } = await detect());
    result = await syncDependencyBumpFiles(tmpDir, changes, 'pr7', baseRef);
    expect(result.written).toEqual(['deps-pr7-org-a']);
    expect(result.removed).toEqual(['deps-pr7-org-b']);
    expect((await readdir(resolve(tmpDir, '.bumpy'))).sort()).toEqual(['deps-pr7-org-a.md', 'deps-pr7-org-old.md']);
  });
});
