import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, readJson, ensureDir, writeText } from '../../src/utils/fs.ts';
import { makePkg, gitInDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { publishPackages, parseStageId } from '../../src/core/publish-pipeline.ts';
import type { WorkspacePackage, ReleasePlan, BumpyConfig } from '../../src/types.ts';
import { DEFAULT_CONFIG, DEFAULT_PUBLISH_CONFIG } from '../../src/types.ts';

const IN_PLACE_CONFIG: BumpyConfig = {
  ...DEFAULT_CONFIG,
  publish: { ...DEFAULT_PUBLISH_CONFIG, protocolResolution: 'in-place' },
};

const STAGED_CONFIG: BumpyConfig = {
  ...DEFAULT_CONFIG,
  publish: { ...DEFAULT_PUBLISH_CONFIG, npmStaged: true, protocolResolution: 'in-place' },
};

describe('publishPackages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
    installShellMock();
  });

  afterEach(async () => {
    uninstallShellMock();
    await rm(tmpDir, { recursive: true });
  });

  function setupGitRepo() {
    gitInDir(['init'], tmpDir);
    gitInDir(['add', '.'], tmpDir);
    gitInDir(['commit', '-m', 'init', '--allow-empty'], tmpDir);
  }

  test('dry run does not modify files', async () => {
    const pkgDir = resolve(tmpDir, 'packages/my-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'my-pkg', version: '1.0.0' });
    await setupGitRepo();

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'my-pkg',
      makePkg('my-pkg', '1.0.0', {
        dir: pkgDir,
        bumpy: { skipNpmPublish: true },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'my-pkg',
          type: 'minor',
          oldVersion: '1.0.0',
          newVersion: '1.1.0',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { dryRun: true });

    expect(result.failed).toHaveLength(0);

    const pkg = await readJson<Record<string, unknown>>(resolve(pkgDir, 'package.json'));
    expect(pkg.version).toBe('1.0.0');
  });

  test('custom publish command gets version/name templated', async () => {
    const pkgDir = resolve(tmpDir, 'packages/my-ext');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'my-ext', version: '2.0.0' });
    await writeText(resolve(pkgDir, 'publish.sh'), 'echo "$@" > published.txt');
    await setupGitRepo();

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'my-ext',
      makePkg('my-ext', '2.0.0', {
        dir: pkgDir,
        bumpy: {
          publishCommand: 'echo published {{name}}@{{version}}',
        },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'my-ext',
          type: 'minor',
          oldVersion: '2.0.0',
          newVersion: '2.1.0',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.published).toHaveLength(1);
    expect(result.published[0]!.name).toBe('my-ext');
    expect(result.published[0]!.version).toBe('2.1.0');
  });

  test('skips private packages without custom publish', async () => {
    const pkgDir = resolve(tmpDir, 'packages/private-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'private-pkg', version: '1.0.0', private: true });
    await setupGitRepo();

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'private-pkg',
      makePkg('private-pkg', '1.0.0', {
        dir: pkgDir,
        private: true,
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'private-pkg',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('private');
    expect(result.published).toHaveLength(0);
  });

  test('workspace protocol resolution for publish', async () => {
    const coreDir = resolve(tmpDir, 'packages/core');
    const appDir = resolve(tmpDir, 'packages/app');
    await ensureDir(coreDir);
    await ensureDir(appDir);

    await writeJson(resolve(coreDir, 'package.json'), { name: 'core', version: '1.1.0' });
    await writeJson(resolve(appDir, 'package.json'), {
      name: 'app',
      version: '1.0.1',
      dependencies: { core: 'workspace:^' },
    });
    await setupGitRepo();

    const packages = new Map<string, WorkspacePackage>();
    packages.set('core', makePkg('core', '1.1.0', { dir: coreDir }));
    packages.set(
      'app',
      makePkg('app', '1.0.1', {
        dir: appDir,
        dependencies: { core: 'workspace:^' },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'core',
          type: 'minor',
          oldVersion: '1.0.0',
          newVersion: '1.1.0',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
        {
          name: 'app',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          bumpFiles: [],
          isDependencyBump: true,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    await publishPackages(plan, packages, depGraph, IN_PLACE_CONFIG, tmpDir, { dryRun: true });

    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.core).toBe('^1.1.0');
  });

  test('catalog: protocol resolution for publish', async () => {
    const appDir = resolve(tmpDir, 'packages/app');
    await ensureDir(appDir);

    await writeJson(resolve(appDir, 'package.json'), {
      name: 'app',
      version: '1.0.0',
      dependencies: { react: 'catalog:', jest: 'catalog:testing' },
    });
    await setupGitRepo();

    const packages = new Map<string, WorkspacePackage>();
    packages.set('app', makePkg('app', '1.0.0', { dir: appDir }));

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'app',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const catalogs = new Map<string, Record<string, string>>();
    catalogs.set('', { react: '^19.0.0', 'react-dom': '^19.0.0' });
    catalogs.set('testing', { jest: '^30.0.0' });

    await publishPackages(plan, packages, depGraph, IN_PLACE_CONFIG, tmpDir, { dryRun: true }, catalogs);

    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.react).toBe('^19.0.0');
    expect(deps.jest).toBe('^30.0.0');
  });

  test('staged publishing uses npm stage publish', async () => {
    const pkgDir = resolve(tmpDir, 'packages/staged-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'staged-pkg', version: '1.0.0' });
    await setupGitRepo();

    // Mock npm --version (for staged validation) and the publish command.
    // `npm stage publish --json` returns the staged package + its stage id.
    addMockRule({ match: 'npm --version', response: '11.15.0' });
    addMockRule({
      match: 'npm stage publish',
      response: JSON.stringify({ pkg: { name: 'staged-pkg', version: '1.0.1', stageId: 'stage-uuid-123' } }),
    });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('staged-pkg', makePkg('staged-pkg', '1.0.0', { dir: pkgDir }));

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'staged-pkg',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, STAGED_CONFIG, tmpDir, {});

    // A staged publish is NOT live — it lands in `staged`, not `published`, so the
    // GitHub release stays a draft until finalized.
    expect(result.published).toHaveLength(0);
    expect(result.staged).toHaveLength(1);
    expect(result.staged[0]!.name).toBe('staged-pkg');
    expect(result.staged[0]!.version).toBe('1.0.1');
    expect(result.staged[0]!.stageId).toBe('stage-uuid-123');

    const publishCalls = getCallsMatching('npm stage publish');
    expect(publishCalls.length).toBeGreaterThanOrEqual(1);
    // `--json` is required to capture the stage id.
    expect(publishCalls.some((c) => c.command.includes('--json'))).toBe(true);
  });

  test('noStage forces a live publish even when npmStaged is configured (snapshots)', async () => {
    const pkgDir = resolve(tmpDir, 'packages/snap-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'snap-pkg', version: '1.0.0' });
    await setupGitRepo();

    addMockRule({ match: 'npm --version', response: '11.15.0' });
    addMockRule({ match: 'npm publish', response: '' });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('snap-pkg', makePkg('snap-pkg', '1.0.0', { dir: pkgDir }));

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      bumpFiles: [],
      warnings: [],
      releases: [
        {
          name: 'snap-pkg',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1-snap.0',
          bumpFiles: [],
          isDependencyBump: false,
          isCascadeBump: false,
          isGroupBump: false,
          bumpSources: [],
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, STAGED_CONFIG, tmpDir, {
      noStage: true,
      noTag: true,
    });

    expect(result.staged).toHaveLength(0);
    expect(result.published).toHaveLength(1);
    // Live publish path — never `stage publish`.
    expect(getCallsMatching('npm stage publish')).toHaveLength(0);
    expect(getCallsMatching('npm publish').length).toBeGreaterThanOrEqual(1);
  });
});

describe('parseStageId', () => {
  test('parses the stage id from npm stage publish --json output', () => {
    const out = JSON.stringify({ pkg: { name: 'foo', version: '1.2.3', stageId: 'abc-123' } });
    expect(parseStageId(out)).toBe('abc-123');
  });

  test('tolerates an array wrapper', () => {
    const out = JSON.stringify([{ pkg: { stageId: 'in-array' } }]);
    expect(parseStageId(out)).toBe('in-array');
  });

  test('tolerates a top-level stageId', () => {
    expect(parseStageId(JSON.stringify({ stageId: 'top-level' }))).toBe('top-level');
  });

  test('returns undefined for empty or non-JSON output', () => {
    expect(parseStageId('')).toBeUndefined();
    expect(parseStageId('not json')).toBeUndefined();
    expect(parseStageId(JSON.stringify({ pkg: {} }))).toBeUndefined();
  });
});
