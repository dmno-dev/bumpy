import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, ensureDir } from '../../src/utils/fs.ts';
import { makePkg, gitInDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { publishPackages, releaseShipped, mergePublishResults } from '../../src/core/publish-pipeline.ts';
import { releaseComplete } from '../../src/core/release-state.ts';
import { resolvePackageTargets } from '../../src/core/targets/registry.ts';
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
    // One target went out → the version shipped from this commit (the flow tags it)
    expect(releaseShipped(outcomes)).toBe(true);
  });

  test('custom target only honors "command" — no alias spelling ever runs', async () => {
    const pkgDir = await setupPkg('alias');
    const pkg = makePkg('alias', '1.0.0', {
      dir: pkgDir,
      bumpy: { publishTargets: [{ type: 'custom', name: 'sneaky', publishCommand: 'echo sneaky' }] },
    });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    const outcomes = result.targetOutcomes.get('alias')!;
    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.error).toMatch(/no "command" configured/);
    expect(getCallsMatching('echo sneaky')).toHaveLength(0);
  });

  test('preflight validates every distinct instance, not just the first one sharing a name', async () => {
    // Both inline entries are named "npm" (the type) but carry different options —
    // the second one's npmStaged validation must still run and abort the whole run
    const dirA = await setupPkg('plain');
    const dirB = await setupPkg('staged');
    const plain = makePkg('plain', '1.0.0', { dir: dirA, bumpy: { publishTargets: [{ type: 'npm' }] } });
    const staged = makePkg('staged', '1.0.0', {
      dir: dirB,
      bumpy: { publishTargets: [{ type: 'npm', npmStaged: true }] },
    });
    addMockRule({ match: 'npm --version', response: '10.0.0' });
    addMockRule({ match: /^npm (pack|publish)/, response: '[]' });

    const { packages, depGraph, plan } = planFor(plain, staged);
    await expect(publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {})).rejects.toThrow(
      /npmStaged requires npm >= 11\.15\.0/,
    );
    // Aborted before anything published
    expect(getCallsMatching(/^npm publish/)).toHaveLength(0);
  });

  test('public package with no targets (publishTargets: []) still builds and gets its tag', async () => {
    const pkgDir = await setupPkg('tool');
    const pkg = makePkg('tool', '1.0.0', {
      dir: pkgDir,
      bumpy: { publishTargets: [], buildCommand: 'build-tool' },
    });
    addMockRule({ match: 'build-tool', response: '' });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    // Dependents may bundle its build output, so the build runs even though nothing publishes
    expect(getCallsMatching('build-tool')).toHaveLength(1);
    expect(result.skipped).toEqual([{ name: 'tool', reason: 'no publish targets' }]);
    expect(result.failed).toHaveLength(0);
  });

  test('private package with no targets neither builds nor tags by default', async () => {
    const pkgDir = await setupPkg('internal');
    const pkg = makePkg('internal', '1.0.0', {
      dir: pkgDir,
      private: true,
      bumpy: { buildCommand: 'build-internal' },
    });

    const { packages, depGraph, plan } = planFor(pkg);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(getCallsMatching('build-internal')).toHaveLength(0);
    expect(result.skipped).toEqual([{ name: 'internal', reason: 'private' }]);
  });

  test('prior success in release metadata skips the target (per-target resume)', async () => {
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
      priorStates: new Map([['resume', { 'done-already': { status: 'success' as const } }]]),
    });

    const outcomes = result.targetOutcomes.get('resume')!;
    expect(outcomes.find((o) => o.target === 'done-already')!.status).toBe('skipped');
    expect(outcomes.find((o) => o.target === 'done-already')!.skipKind).toBe('metadata');
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
    expect(outcomes[0]!.skipKind).toBe('registry');
    expect(outcomes[0]!.reason).toBe('already on registry');
    expect(getCallsMatching('publish-cmd')).toHaveLength(0);
    // Version is out even though nothing was published this run → still "shipped"
    // (the flow ensures the tag) but not "published"
    expect(result.published).toHaveLength(0);
    expect(releaseShipped(outcomes)).toBe(true);
  });

  test('a staged target is re-checked: still pending → left alone, live → recorded as published', async () => {
    const pkgDir = await setupPkg('stager');
    const pkg = makePkg('stager', '1.0.0', {
      dir: pkgDir,
      bumpy: {
        publishTargets: [{ type: 'custom', name: 'gated', command: 'publish-cmd', checkPublished: 'check-cmd' }],
      },
    });
    const prior = new Map([['stager', { gated: { status: 'staged' as const, ref: 'stage-123' } }]]);
    const { packages, depGraph, plan } = planFor(pkg);

    // Not live yet: don't re-run the publish command (would duplicate the staged item)
    addMockRule({ match: 'check-cmd', response: '1.0.0' });
    let result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { priorStates: prior });
    let outcome = result.targetOutcomes.get('stager')![0]!;
    expect(outcome.status).toBe('skipped');
    expect(outcome.skipKind).toBe('staged');
    expect(outcome.ref).toBe('stage-123');
    expect(getCallsMatching('publish-cmd')).toHaveLength(0);
    expect(releaseShipped([outcome])).toBe(false);

    // Approved since: the registry answers first, and the flow records the success
    addMockRule({ match: 'check-cmd', response: '1.0.1' });
    result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { priorStates: prior });
    outcome = result.targetOutcomes.get('stager')![0]!;
    expect(outcome.skipKind).toBe('registry');
    expect(getCallsMatching('publish-cmd')).toHaveLength(0);
  });

  test('a dependency failing on a target blocks dependents on that same target only', async () => {
    const dirA = await setupPkg('lib-a');
    const dirB = await setupPkg('app-b');
    const a = makePkg('lib-a', '1.0.0', {
      dir: dirA,
      bumpy: {
        publishTargets: [
          { type: 'custom', name: 'reg-x', command: 'echo a-x' },
          { type: 'custom', name: 'reg-y', command: 'echo a-y' },
        ],
      },
    });
    const b = makePkg('app-b', '1.0.0', {
      dir: dirB,
      dependencies: { 'lib-a': '^1.0.0' },
      bumpy: {
        publishTargets: [
          { type: 'custom', name: 'reg-x', command: 'echo b-x' },
          { type: 'custom', name: 'reg-y', command: 'echo b-y' },
        ],
      },
    });
    addMockRule({ match: 'a-x', error: 'registry x down' });

    const { packages, depGraph, plan } = planFor(a, b);
    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    const bOutcomes = result.targetOutcomes.get('app-b')!;
    // app-b@reg-x would reference a lib-a@reg-x that never landed → blocked, not published
    expect(bOutcomes.find((o) => o.target === 'reg-x')!.status).toBe('failed');
    expect(bOutcomes.find((o) => o.target === 'reg-x')!.error).toMatch(/blocked: dependency lib-a failed on reg-x/);
    expect(getCallsMatching('b-x')).toHaveLength(0);
    // ...while reg-y, where lib-a succeeded, proceeds
    expect(bOutcomes.find((o) => o.target === 'reg-y')!.status).toBe('success');
    expect(getCallsMatching('b-y')).toHaveLength(1);
    expect(result.failed.map((f) => f.name).sort()).toEqual(['app-b', 'lib-a']);
  });

  describe('marketplace registry guards', () => {
    async function setupExtension(name: string, targets: string[]) {
      const pkgDir = await setupPkg(name, { publisher: 'acme', engines: { vscode: '^1.90.0' } });
      const pkg = makePkg(name, '1.0.0', { dir: pkgDir, private: true, bumpy: { publishTargets: targets } });
      pkg.packageJson.publisher = 'acme';
      pkg.packageJson.engines = { vscode: '^1.90.0' };
      return pkg;
    }

    test('vscode-marketplace matches any published version, not just the latest', async () => {
      const pkg = await setupExtension('ext-a', ['vscode-marketplace']);
      // 1.0.1 is live but a newer 1.2.0 has since shipped (e.g. retrying an old release
      // whose metadata was lost) — it must still read as published
      addMockRule({
        match: /@vscode\/vsce show/,
        response: JSON.stringify({ versions: [{ version: '1.2.0' }, { version: '1.0.1' }] }),
      });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      const outcomes = result.targetOutcomes.get('ext-a')!;
      expect(outcomes[0]!.skipKind).toBe('registry');
      expect(getCallsMatching(/vsce (package|publish)/)).toHaveLength(0);
    });

    test('open-vsx falls back to an exact-version query when the latest differs', async () => {
      const pkg = await setupExtension('ext-b', ['open-vsx']);
      addMockRule({ match: /ovsx get acme\.ext-b --metadata/, response: JSON.stringify({ version: '1.2.0' }) });
      addMockRule({ match: /ovsx get acme\.ext-b@1\.0\.1 --metadata/, response: JSON.stringify({ version: '1.0.1' }) });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      const outcomes = result.targetOutcomes.get('ext-b')!;
      expect(outcomes[0]!.skipKind).toBe('registry');
      expect(getCallsMatching(/ovsx publish/)).toHaveLength(0);
    });
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

    test('registry queries use the jsr.json name, not the npm name', async () => {
      // JSR scopes are a separate namespace — the npm package is @myorg/thing but it
      // publishes to JSR as @jsr-org/thing. Only the JSR scope is claimed.
      const pkgDir = await setupPkg('@myorg/thing');
      await writeJson(resolve(pkgDir, 'jsr.json'), {
        name: '@jsr-org/thing',
        version: '0.0.0',
        exports: { '.': './src/index.ts' },
      });
      fetchResponses.set(/scopes\/jsr-org\/packages\/thing$/, 200);
      fetchResponses.set('/versions/', 404);
      addMockRule({ match: 'jsr publish', response: '' });
      const pkg = makePkg('@myorg/thing', '1.0.0', { dir: pkgDir, bumpy: { publishTargets: ['jsr'] } });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      // Querying @myorg/thing instead would have failed the claim check (404)
      expect(result.failed).toHaveLength(0);
      expect(getCallsMatching('jsr publish')).toHaveLength(1);
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

  describe('pypi target', () => {
    const realFetch = globalThis.fetch;
    let pypiVersionStatus = 404;

    beforeEach(() => {
      pypiVersionStatus = 404;
      globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        if (u.startsWith('https://pypi.org/pypi/')) return new Response('{}', { status: pypiVersionStatus });
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const PYPROJECT = [
      '[build-system]',
      'requires = ["hatchling"]',
      '',
      '[project]',
      'name = "My_Py.Tool"',
      'version = "0.0.0"',
      'description = "demo"',
      '',
      '[tool.other]',
      'version = "9.9.9"',
    ].join('\n');

    async function setupPyPkg() {
      const pkgDir = await setupPkg('py-tool', { private: true });
      const { writeText } = await import('../../src/utils/fs.ts');
      await writeText(resolve(pkgDir, 'pyproject.toml'), PYPROJECT);
      addMockRule({ match: 'uv --version', response: 'uv 0.9.0' });
      addMockRule({ match: 'uv build', response: '' });
      addMockRule({ match: 'uv publish', response: '' });
      return makePkg('py-tool', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: { publishTargets: ['pypi'] },
      });
    }

    test('syncs pyproject version, builds isolated dist, publishes explicit files', async () => {
      const pkg = await setupPyPkg();
      // simulate uv build producing distributions in the requested out-dir
      const { ensureDir: mkdir, writeText } = await import('../../src/utils/fs.ts');
      const outDir = resolve(pkg.dir, '.bumpy-pypi-dist-1.0.1');
      await mkdir(outDir);
      await writeText(resolve(outDir, 'my_py_tool-1.0.1-py3-none-any.whl'), '');
      await writeText(resolve(outDir, 'my_py_tool-1.0.1.tar.gz'), '');

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(0);
      expect(result.published.map((p) => p.name)).toEqual(['py-tool']);

      // version synced into [project] only — [tool.other] version untouched
      const { readText } = await import('../../src/utils/fs.ts');
      const toml = await readText(resolve(pkg.dir, 'pyproject.toml'));
      expect(toml).toContain('version = "1.0.1"');
      expect(toml).toContain('version = "9.9.9"');

      const build = getCallsMatching(/^uv build/);
      expect(build).toHaveLength(1);
      expect(build[0]!.command).toContain('--out-dir');
      const publish = getCallsMatching(/^uv publish/);
      expect(publish).toHaveLength(1);
      expect(publish[0]!.command).toContain('my_py_tool-1.0.1-py3-none-any.whl');
      expect(publish[0]!.command).toContain('my_py_tool-1.0.1.tar.gz');
    });

    test('version already on PyPI is skipped via the registry guard (PEP 503 name normalization)', async () => {
      const pkg = await setupPyPkg();
      pypiVersionStatus = 200;

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      const outcomes = result.targetOutcomes.get('py-tool')!;
      expect(outcomes[0]!.status).toBe('skipped');
      expect(outcomes[0]!.reason).toBe('already on registry');
      expect(getCallsMatching(/^uv publish/)).toHaveLength(0);
    });

    test('prerelease versions are skipped (PEP 440 mismatch)', async () => {
      const pkg = await setupPyPkg();
      const packages = new Map([[pkg.name, pkg]]);
      const depGraph = new DependencyGraph(packages);
      const plan: ReleasePlan = {
        bumpFiles: [],
        warnings: [],
        releases: [makeRelease('py-tool', '1.0.0', '1.1.0-next.0')],
      };

      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});
      const outcomes = result.targetOutcomes.get('py-tool')!;
      expect(outcomes[0]!.status).toBe('skipped');
      expect(outcomes[0]!.reason).toBe('prereleases not supported');
      // preflight's `uv --version` check still runs; no build/publish happens
      expect(getCallsMatching(/^uv (build|publish)/)).toHaveLength(0);
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

  describe('phases (release vs post-release targets)', () => {
    test('plugins default the phase; an instance option overrides it', () => {
      const pkg = makePkg('cli', '1.0.0', { private: true });
      const targets = resolvePackageTargets(
        pkg,
        {
          publishTargets: [
            { type: 'github-release-assets', files: ['x'] },
            { type: 'docker', image: 'ghcr.io/a/b' },
            { type: 'custom', name: 'announce', command: 'echo hi', phase: 'post-release' },
            { type: 'homebrew', name: 'brew-early', tap: 'a/b', template: 't', phase: 'release' },
          ],
        },
        DEFAULT_CONFIG,
      );
      expect(targets.map((t) => [t.name, t.phase])).toEqual([
        ['github-release-assets', 'release'],
        ['docker', 'post-release'],
        ['announce', 'post-release'],
        ['brew-early', 'release'],
      ]);
      expect(() =>
        resolvePackageTargets(
          pkg,
          { publishTargets: [{ type: 'custom', command: 'x', phase: 'later' }] },
          DEFAULT_CONFIG,
        ),
      ).toThrow(/Invalid target "phase"/);
    });

    test('the release pass builds and runs only release-phase targets; the post-release pass runs the rest without rebuilding', async () => {
      const pkgDir = await setupPkg('two-phase');
      const pkg = makePkg('two-phase', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: {
          buildCommand: 'build-it',
          publishTargets: [
            { type: 'custom', name: 'registry', command: 'echo publish-registry' },
            { type: 'custom', name: 'announce', command: 'echo announce', phase: 'post-release' },
          ],
        },
      });
      addMockRule({ match: 'build-it', response: '' });
      const { packages, depGraph, plan } = planFor(pkg);

      const first = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { phase: 'release' });
      expect(first.targetOutcomes.get('two-phase')!.map((o) => o.target)).toEqual(['registry']);
      expect(getCallsMatching('build-it')).toHaveLength(1);
      expect(getCallsMatching('echo announce')).toHaveLength(0);

      const second = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { phase: 'post-release' });
      expect(second.targetOutcomes.get('two-phase')!.map((o) => o.target)).toEqual(['announce']);
      expect(getCallsMatching('build-it')).toHaveLength(1); // not rebuilt
      expect(getCallsMatching('echo announce')).toHaveLength(1);

      const merged = mergePublishResults(first, second);
      expect(merged.targetOutcomes.get('two-phase')!.map((o) => [o.target, o.status])).toEqual([
        ['registry', 'success'],
        ['announce', 'success'],
      ]);
      expect(merged.published.map((p) => p.name)).toEqual(['two-phase']);
    });

    test('a package with only post-release targets still builds in the release pass and is otherwise untouched', async () => {
      const pkgDir = await setupPkg('img-only');
      const pkg = makePkg('img-only', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: {
          buildCommand: 'build-img',
          publishTargets: [{ type: 'custom', name: 'push-image', command: 'echo push', phase: 'post-release' }],
        },
      });
      addMockRule({ match: 'build-img', response: '' });
      const { packages, depGraph, plan } = planFor(pkg);

      const first = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { phase: 'release' });
      expect(getCallsMatching('build-img')).toHaveLength(1);
      expect(first.targetOutcomes.get('img-only')).toEqual([]);
      expect(first.published).toHaveLength(0);
      expect(first.skipped).toHaveLength(0);
      expect(first.failed).toHaveLength(0);
    });

    test('releaseComplete gates on release-phase targets only', () => {
      const pkg = makePkg('cli', '1.0.0', { private: true });
      const targets = resolvePackageTargets(
        pkg,
        {
          publishTargets: [
            { type: 'github-release-assets', files: ['x'] },
            { type: 'docker', image: 'ghcr.io/a/b' },
          ],
        },
        DEFAULT_CONFIG,
      );
      const meta = (assets: string, docker: string) => ({
        version: '1.0.1',
        targets: { 'github-release-assets': { status: assets as never }, docker: { status: docker as never } },
      });
      // docker (post-release) pending never holds the release; assets does
      expect(releaseComplete(meta('success', 'pending'), targets)).toBe(true);
      expect(releaseComplete(meta('pending', 'success'), targets)).toBe(false);
      expect(releaseComplete(meta('staged', 'pending'), targets)).toBe(false);
      expect(releaseComplete(meta('skipped', 'pending'), targets)).toBe(false); // needs at least one success
      // nothing gates a post-release-only package
      const dockerOnly = targets.filter((t) => t.type === 'docker');
      expect(releaseComplete(meta('pending', 'pending'), dockerOnly)).toBe(true);
    });
  });
});
