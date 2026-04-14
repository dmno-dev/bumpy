import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, readJson, ensureDir, writeText } from '../../src/utils/fs.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { publishPackages } from '../../src/core/publish-pipeline.ts';
import type { WorkspacePackage, ReleasePlan, BumpyConfig } from '../../src/types.ts';
import { DEFAULT_CONFIG, DEFAULT_PUBLISH_CONFIG } from '../../src/types.ts';

/** Config override that uses in-place resolution (for testing protocol resolution) */
const IN_PLACE_CONFIG: BumpyConfig = {
  ...DEFAULT_CONFIG,
  publish: { ...DEFAULT_PUBLISH_CONFIG, protocolResolution: 'in-place' },
};

function makePkg(
  name: string,
  version: string,
  dir: string,
  deps: Partial<Pick<WorkspacePackage, 'dependencies' | 'peerDependencies' | 'bumpy' | 'private'>> = {},
): WorkspacePackage {
  return {
    name,
    version,
    dir,
    relativeDir: `packages/${name}`,
    packageJson: { name, version },
    private: deps.private || false,
    dependencies: deps.dependencies || {},
    devDependencies: {},
    peerDependencies: deps.peerDependencies || {},
    optionalDependencies: {},
    bumpy: deps.bumpy,
  };
}

describe('publishPackages', () => {
  let tmpDir: string;

  test('dry run does not modify files', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
    const pkgDir = resolve(tmpDir, 'packages/my-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'my-pkg', version: '1.0.0' });

    // Init git so tag checks work
    const { run } = await import('../../src/utils/shell.ts');
    run('git init', { cwd: tmpDir });
    run('git add .', { cwd: tmpDir });
    run('git commit -m "init" --allow-empty', { cwd: tmpDir });

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'my-pkg',
      makePkg('my-pkg', '1.0.0', pkgDir, {
        bumpy: { skipNpmPublish: true },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      changesets: [],
      releases: [
        {
          name: 'my-pkg',
          type: 'minor',
          oldVersion: '1.0.0',
          newVersion: '1.1.0',
          changesets: [],
          isDependencyBump: false,
          isCascadeBump: false,
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, { dryRun: true });

    // Skipped because skipNpmPublish + dryRun
    expect(result.failed).toHaveLength(0);

    // package.json should be unchanged
    const pkg = await readJson<Record<string, unknown>>(resolve(pkgDir, 'package.json'));
    expect(pkg.version).toBe('1.0.0');

    await rm(tmpDir, { recursive: true });
  });

  test('custom publish command gets version/name templated', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
    const pkgDir = resolve(tmpDir, 'packages/my-ext');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'my-ext', version: '2.0.0' });

    // Write a dummy publish script that records what it received
    await writeText(resolve(pkgDir, 'publish.sh'), 'echo "$@" > published.txt');

    const { run } = await import('../../src/utils/shell.ts');
    run('git init', { cwd: tmpDir });
    run('git add .', { cwd: tmpDir });
    run('git commit -m "init"', { cwd: tmpDir });

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'my-ext',
      makePkg('my-ext', '2.0.0', pkgDir, {
        bumpy: {
          publishCommand: 'echo published {{name}}@{{version}}',
        },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      changesets: [],
      releases: [
        {
          name: 'my-ext',
          type: 'minor',
          oldVersion: '2.0.0',
          newVersion: '2.1.0',
          changesets: [],
          isDependencyBump: false,
          isCascadeBump: false,
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.published).toHaveLength(1);
    expect(result.published[0]!.name).toBe('my-ext');
    expect(result.published[0]!.version).toBe('2.1.0');

    await rm(tmpDir, { recursive: true });
  });

  test('skips private packages without custom publish', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
    const pkgDir = resolve(tmpDir, 'packages/private-pkg');
    await ensureDir(pkgDir);
    await writeJson(resolve(pkgDir, 'package.json'), { name: 'private-pkg', version: '1.0.0', private: true });

    const { run } = await import('../../src/utils/shell.ts');
    run('git init', { cwd: tmpDir });
    run('git add .', { cwd: tmpDir });
    run('git commit -m "init"', { cwd: tmpDir });

    const packages = new Map<string, WorkspacePackage>();
    packages.set(
      'private-pkg',
      makePkg('private-pkg', '1.0.0', pkgDir, {
        private: true,
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      changesets: [],
      releases: [
        {
          name: 'private-pkg',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          changesets: [],
          isDependencyBump: false,
          isCascadeBump: false,
        },
      ],
    };

    const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('private');
    expect(result.published).toHaveLength(0);

    await rm(tmpDir, { recursive: true });
  });

  test('workspace protocol resolution for publish', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
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

    const { run } = await import('../../src/utils/shell.ts');
    run('git init', { cwd: tmpDir });
    run('git add .', { cwd: tmpDir });
    run('git commit -m "init"', { cwd: tmpDir });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('core', makePkg('core', '1.1.0', coreDir));
    packages.set(
      'app',
      makePkg('app', '1.0.1', appDir, {
        dependencies: { core: 'workspace:^' },
      }),
    );

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      changesets: [],
      releases: [
        {
          name: 'core',
          type: 'minor',
          oldVersion: '1.0.0',
          newVersion: '1.1.0',
          changesets: [],
          isDependencyBump: false,
          isCascadeBump: false,
        },
        {
          name: 'app',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          changesets: [],
          isDependencyBump: true,
          isCascadeBump: false,
        },
      ],
    };

    // Dry run with in-place resolution — protocols get resolved but npm publish doesn't run
    await publishPackages(plan, packages, depGraph, IN_PLACE_CONFIG, tmpDir, { dryRun: true });

    // Check that workspace: was resolved in app's package.json
    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.core).toBe('^1.1.0'); // workspace:^ → ^1.1.0

    await rm(tmpDir, { recursive: true });
  });

  test('catalog: protocol resolution for publish', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
    const appDir = resolve(tmpDir, 'packages/app');
    await ensureDir(appDir);

    await writeJson(resolve(appDir, 'package.json'), {
      name: 'app',
      version: '1.0.0',
      dependencies: { react: 'catalog:', jest: 'catalog:testing' },
    });

    const { run } = await import('../../src/utils/shell.ts');
    run('git init', { cwd: tmpDir });
    run('git add .', { cwd: tmpDir });
    run('git commit -m "init"', { cwd: tmpDir });

    const packages = new Map<string, WorkspacePackage>();
    packages.set('app', makePkg('app', '1.0.0', appDir));

    const depGraph = new DependencyGraph(packages);
    const plan: ReleasePlan = {
      changesets: [],
      releases: [
        {
          name: 'app',
          type: 'patch',
          oldVersion: '1.0.0',
          newVersion: '1.0.1',
          changesets: [],
          isDependencyBump: false,
          isCascadeBump: false,
        },
      ],
    };

    // Set up catalogs
    const catalogs = new Map<string, Record<string, string>>();
    catalogs.set('', { react: '^19.0.0', 'react-dom': '^19.0.0' }); // default catalog
    catalogs.set('testing', { jest: '^30.0.0' }); // named catalog

    // Dry run with in-place resolution — protocols get resolved but npm publish doesn't run
    await publishPackages(plan, packages, depGraph, IN_PLACE_CONFIG, tmpDir, { dryRun: true }, catalogs);

    const appPkg = await readJson<Record<string, unknown>>(resolve(appDir, 'package.json'));
    const deps = appPkg.dependencies as Record<string, string>;
    expect(deps.react).toBe('^19.0.0'); // catalog: → resolved from default catalog
    expect(deps.jest).toBe('^30.0.0'); // catalog:testing → resolved from named catalog

    await rm(tmpDir, { recursive: true });
  });
});
