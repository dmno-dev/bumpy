import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, ensureDir } from '../../src/utils/fs.ts';
import { makePkg, gitInDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { publishPackages } from '../../src/core/publish-pipeline.ts';
import type { WorkspacePackage, ReleasePlan, PlannedRelease } from '../../src/types.ts';
import { DEFAULT_CONFIG } from '../../src/types.ts';

function makeRelease(name: string, oldVersion: string, newVersion: string): PlannedRelease {
  return {
    name,
    type: 'patch',
    oldVersion,
    newVersion,
    bumpFiles: [],
    isDependencyBump: false,
    isCascadeBump: false,
    isGroupBump: false,
    bumpSources: [],
  };
}

describe('publishPackages — multi-target', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-mt-test-'));
    installShellMock();
  });

  afterEach(async () => {
    uninstallShellMock();
    await rm(tmpDir, { recursive: true });
  });

  async function setupPkg(name: string, pkgJson: Record<string, unknown> = {}): Promise<string> {
    const pkgDir = resolve(tmpDir, `packages/${name}`);
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name, version: '1.0.0', ...pkgJson });
    gitInDir(['init'], tmpDir);
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init', '--allow-empty'], tmpDir);
    return pkgDir;
  }

  function planFor(...pkgs: WorkspacePackage[]): {
    packages: Map<string, WorkspacePackage>;
    depGraph: DependencyGraph;
    plan: ReleasePlan;
  } {
    const packages = new Map(pkgs.map((p) => [p.name, p]));
    return {
      packages,
      depGraph: new DependencyGraph(packages),
      plan: { bumpFiles: [], warnings: [], releases: pkgs.map((p) => makeRelease(p.name, '1.0.0', '1.0.1')) },
    };
  }

  test('two targets on one package both publish, with per-target outcomes', async () => {
    const pkgDir = await setupPkg('multi');
    const pkg = makePkg('multi', '1.0.0', {
      dir: pkgDir,
      bumpy: {
        publishTargets: [
          { type: 'custom', name: 'a', command: 'echo publish-a' },
          { type: 'custom', name: 'b', command: 'echo publish-b' },
        ],
      },
    });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.published).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    const outcomes = result.targetOutcomes.get('multi')!;
    expect(outcomes.map((o) => [o.target, o.status])).toEqual([
      ['a', 'success'],
      ['b', 'success'],
    ]);
  });

  test('one target failing does not block its sibling; package is published AND failed', async () => {
    const pkgDir = await setupPkg('flaky');
    const pkg = makePkg('flaky', '1.0.0', {
      dir: pkgDir,
      bumpy: {
        publishTargets: [
          { type: 'custom', name: 'bad', command: 'fail-cmd' },
          { type: 'custom', name: 'good', command: 'echo ok' },
        ],
      },
    });
    addMockRule({ match: 'fail-cmd', error: 'boom' });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    const outcomes = result.targetOutcomes.get('flaky')!;
    expect(outcomes.find((o) => o.target === 'bad')!.status).toBe('failed');
    expect(outcomes.find((o) => o.target === 'good')!.status).toBe('success');
    // Partial success: counted as published (tag exists) and failed (exit code / retry)
    expect(result.published.map((p) => p.name)).toEqual(['flaky']);
    expect(result.failed.map((f) => f.name)).toEqual(['flaky']);
    // Tag was created because one target succeeded
    expect(gitInDir(['tag', '-l', 'flaky@1.0.1'], tmpDir)).toBe('flaky@1.0.1');
  });

  test('completedTargets skips already-published targets (per-target resume)', async () => {
    const pkgDir = await setupPkg('resume');
    const pkg = makePkg('resume', '1.0.0', {
      dir: pkgDir,
      bumpy: {
        publishTargets: [
          { type: 'custom', name: 'done-already', command: 'echo again' },
          { type: 'custom', name: 'pending', command: 'echo finally' },
        ],
      },
    });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {
      completedTargets: new Map([['resume', new Set(['done-already'])]]),
    });

    const outcomes = result.targetOutcomes.get('resume')!;
    expect(outcomes.find((o) => o.target === 'done-already')!.status).toBe('skipped');
    expect(outcomes.find((o) => o.target === 'done-already')!.reason).toBe('already published');
    expect(outcomes.find((o) => o.target === 'pending')!.status).toBe('success');
  });

  test('vscode-marketplace and open-vsx share one vsix artifact', async () => {
    const pkgDir = await setupPkg('my-ext', { publisher: 'acme', engines: { vscode: '^1.90.0' } });
    const pkg = makePkg('my-ext', '1.0.0', {
      dir: pkgDir,
      private: true,
      bumpy: { publishTargets: ['vscode-marketplace', 'open-vsx'] },
    });
    pkg.packageJson.publisher = 'acme';
    pkg.packageJson.engines = { vscode: '^1.90.0' };

    addMockRule({ match: '@vscode/vsce package', response: '' });
    addMockRule({ match: '@vscode/vsce publish', response: '' });
    addMockRule({ match: /ovsx publish/, response: '' });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.failed).toHaveLength(0);
    expect(result.published).toHaveLength(1);
    // vsix built exactly once, then published to both registries from the same file
    expect(getCallsMatching('@vscode/vsce package')).toHaveLength(1);
    const vscePublish = getCallsMatching('@vscode/vsce publish');
    const ovsxPublish = getCallsMatching(/^npx --yes ovsx publish/);
    expect(vscePublish).toHaveLength(1);
    expect(ovsxPublish).toHaveLength(1);
    expect(vscePublish[0]!.command).toContain('--packagePath');
    expect(vscePublish[0]!.command).toContain('my-ext-1.0.1.vsix');
    expect(ovsxPublish[0]!.command).toContain('my-ext-1.0.1.vsix');
  });

  test('azureCredential option publishes via Azure OIDC instead of a PAT', async () => {
    const pkgDir = await setupPkg('azure-ext', { publisher: 'acme', engines: { vscode: '^1.90.0' } });
    const pkg = makePkg('azure-ext', '1.0.0', {
      dir: pkgDir,
      private: true,
      bumpy: { publishTargets: [{ type: 'vscode-marketplace', azureCredential: true }] },
    });
    pkg.packageJson.publisher = 'acme';

    addMockRule({ match: '@vscode/vsce package', response: '' });
    addMockRule({ match: '@vscode/vsce publish', response: '' });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.failed).toHaveLength(0);
    expect(getCallsMatching('@vscode/vsce publish')[0]!.command).toContain('--azure-credential');
  });

  test('marketplace targets skip prerelease versions', async () => {
    const pkgDir = await setupPkg('pre-ext', { publisher: 'acme', engines: { vscode: '^1.90.0' } });
    const pkg = makePkg('pre-ext', '1.0.0', {
      dir: pkgDir,
      private: true,
      bumpy: {
        publishTargets: ['vscode-marketplace', { type: 'custom', name: 'mirror', command: 'echo ok' }],
      },
    });
    pkg.packageJson.publisher = 'acme';

    const packages = new Map([[pkg.name, pkg]]);
    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [makeRelease('pre-ext', '1.0.0', '1.1.0-rc.0')],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    const outcomes = result.targetOutcomes.get('pre-ext')!;
    expect(outcomes.find((o) => o.target === 'vscode-marketplace')!.status).toBe('skipped');
    expect(outcomes.find((o) => o.target === 'vscode-marketplace')!.reason).toBe('prereleases not supported');
    // The custom target still publishes the prerelease
    expect(outcomes.find((o) => o.target === 'mirror')!.status).toBe('success');
    // No vsce invocation at all
    expect(getCallsMatching('@vscode/vsce')).toHaveLength(0);
  });

  test('marketplace targets skip snapshot releases', async () => {
    const pkgDir = await setupPkg('snap-ext', { publisher: 'acme' });
    const pkg = makePkg('snap-ext', '1.0.0', {
      dir: pkgDir,
      private: true,
      bumpy: { publishTargets: ['open-vsx'] },
    });
    pkg.packageJson.publisher = 'acme';

    const packages = new Map([[pkg.name, pkg]]);
    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [makeRelease('snap-ext', '1.0.0', '1.0.1-preview-abc1234')],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {
      noTag: true,
      releaseKind: 'snapshot',
    });

    const outcomes = result.targetOutcomes.get('snap-ext')!;
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toBe('snapshots not supported');
    expect(result.published).toHaveLength(0);
    expect(result.skipped.map((s) => s.name)).toEqual(['snap-ext']);
  });

  test('registry guard: target already live on the registry is skipped, not re-published', async () => {
    const pkgDir = await setupPkg('guarded');
    const pkg = makePkg('guarded', '1.0.0', {
      dir: pkgDir,
      bumpy: {
        publishTargets: [{ type: 'custom', name: 'mirror', command: 'publish-cmd', checkPublished: 'check-cmd' }],
      },
    });
    addMockRule({ match: 'check-cmd', response: '1.0.1' }); // reports the target version as live

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    const outcomes = result.targetOutcomes.get('guarded')!;
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toBe('already on registry');
    expect(getCallsMatching('publish-cmd')).toHaveLength(0);
    // Version exists → tag still created (resume semantics)
    expect(gitInDir(['tag', '-l', 'guarded@1.0.1'], tmpDir)).toBe('guarded@1.0.1');
  });

  describe('jsr target', () => {
    const realFetch = globalThis.fetch;
    let fetchResponses: Map<string | RegExp, number>;

    beforeEach(() => {
      fetchResponses = new Map();
      globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        for (const [pattern, status] of fetchResponses) {
          if (typeof pattern === 'string' ? u.includes(pattern) : pattern.test(u)) {
            return new Response('{}', { status });
          }
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    async function setupJsrPkg(opts: { claimed?: boolean } = {}) {
      const pkgDir = await setupPkg('@myorg/mdit-thing');
      await writeJson(resolve(pkgDir, 'jsr.json'), {
        name: '@myorg/mdit-thing',
        version: '0.0.0',
        exports: { '.': './src/index.ts' },
      });
      // package claimed on JSR (200) unless the test says otherwise; version never published
      fetchResponses.set(/packages\/mdit-thing$/, opts.claimed === false ? 404 : 200);
      fetchResponses.set('/versions/', 404);
      addMockRule({ match: 'jsr publish', response: '' });
      return makePkg('@myorg/mdit-thing', '1.0.0', {
        dir: pkgDir,
        bumpy: { publishTargets: ['jsr'] },
      });
    }

    test('syncs jsr.json version at publish time and publishes with --allow-dirty', async () => {
      const pkg = await setupJsrPkg();
      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(0);
      expect(result.published.map((p) => p.name)).toEqual(['@myorg/mdit-thing']);

      const publishCalls = getCallsMatching('jsr publish');
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0]!.command).toContain('--allow-dirty');
      expect(publishCalls[0]!.command).not.toContain('--allow-slow-types');

      // jsr.json version was synced from the release (committed as 0.0.0)
      const { readJson } = await import('../../src/utils/fs.ts');
      const jsrJson = await readJson<{ version: string }>(resolve(pkg.dir, 'jsr.json'));
      expect(jsrJson.version).toBe('1.0.1');
    });

    test('allowSlowTypes option adds the flag', async () => {
      const pkg = await setupJsrPkg();
      pkg.bumpy = { publishTargets: [{ type: 'jsr', allowSlowTypes: true }] };
      const { packages, depGraph, plan } = planFor(pkg);
      await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(getCallsMatching('jsr publish')[0]!.command).toContain('--allow-slow-types');
    });

    test('unclaimed package fails with claim guidance instead of publishing', async () => {
      const pkg = await setupJsrPkg({ claimed: false });
      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toContain('not claimed on JSR');
      expect(getCallsMatching('jsr publish')).toHaveLength(0);
    });

    test('version already on JSR is skipped via the registry guard', async () => {
      const pkg = await setupJsrPkg();
      fetchResponses.set('/versions/', 200); // already published
      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      const outcomes = result.targetOutcomes.get('@myorg/mdit-thing')!;
      expect(outcomes[0]!.status).toBe('skipped');
      expect(outcomes[0]!.reason).toBe('already on registry');
      expect(getCallsMatching('jsr publish')).toHaveLength(0);
    });
  });

  test('npm + named GitHub Packages instance publish to both registries', async () => {
    const pkgDir = await setupPkg('dual-reg');
    const pkg = makePkg('dual-reg', '1.0.0', {
      dir: pkgDir,
      bumpy: { publishTargets: ['npm', 'ghp'] },
    });
    const config = {
      ...DEFAULT_CONFIG,
      publish: { ...DEFAULT_CONFIG.publish, protocolResolution: 'in-place' as const },
      targets: { ghp: { type: 'npm', registry: 'https://npm.pkg.github.com' } },
    };
    // resolve targets with the config that defines the named instance
    const { resolvePackageTargets } = await import('../../src/core/targets/registry.ts');
    pkg.targets = resolvePackageTargets(pkg, pkg.bumpy!, config);

    addMockRule({ match: /^npm publish/, response: '' });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, config, tmpDir, {});

    expect(result.failed).toHaveLength(0);
    const publishes = getCallsMatching(/^npm publish/);
    expect(publishes).toHaveLength(2);
    expect(publishes.some((c) => c.command.includes('--registry https://npm.pkg.github.com'))).toBe(true);
    expect(publishes.some((c) => !c.command.includes('--registry'))).toBe(true);
  });
});
