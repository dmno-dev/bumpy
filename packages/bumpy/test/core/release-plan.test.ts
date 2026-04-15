import { test, expect, describe } from 'bun:test';
import { assembleReleasePlan } from '../../src/core/release-plan.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { makePkg, makeConfig } from '../helpers.ts';
import type { Changeset } from '../../src/types.ts';

describe('assembleReleasePlan', () => {
  test('basic single package bump', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Added feature' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('pkg-a');
    expect(plan.releases[0]!.type).toBe('minor');
    expect(plan.releases[0]!.oldVersion).toBe('1.0.0');
    expect(plan.releases[0]!.newVersion).toBe('1.1.0');
  });

  test('multiple changesets for same package take highest bump', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'patch' }], summary: 'Fix' },
      { id: 'cs2', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Feature' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.type).toBe('minor');
    expect(plan.releases[0]!.newVersion).toBe('1.1.0');
  });

  test('dependency propagation - patch bump propagates patch to dependents', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

    expect(plan.releases).toHaveLength(2);
    const coreRelease = plan.releases.find((r) => r.name === 'core')!;
    const appRelease = plan.releases.find((r) => r.name === 'app')!;
    expect(coreRelease.newVersion).toBe('1.0.1');
    expect(appRelease.type).toBe('patch');
    expect(appRelease.isDependencyBump).toBe(true);
  });

  test('peer dependency minor bump does NOT propagate by default', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('core');
  });

  test('peer dependency major bump DOES propagate by default', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(2);
    const pluginRelease = plan.releases.find((r) => r.name === 'plugin')!;
    expect(pluginRelease.type).toBe('major');
    expect(pluginRelease.isDependencyBump).toBe(true);
  });

  test('isolated bump skips dependency propagation', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'core', type: 'patch-isolated' }], summary: 'Internal' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('core');
    expect(plan.releases[0]!.newVersion).toBe('1.0.1');
  });

  test('non-isolated changeset overrides isolated for same package', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'core', type: 'patch-isolated' }], summary: 'Internal' },
      { id: 'cs2', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

    expect(plan.releases).toHaveLength(2);
  });

  test('out-of-range: skips propagation when version still satisfies range', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '1.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ updateInternalDependencies: 'out-of-range' });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('core');
  });

  test('out-of-range: propagates when version leaves range', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '1.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ updateInternalDependencies: 'out-of-range' });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    expect(plan.releases).toHaveLength(2);
  });

  test('changeset-level cascade overrides', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['plugin-a', makePkg('plugin-a', '1.0.0')],
      ['plugin-b', makePkg('plugin-b', '1.0.0')],
    ]);

    const changesets: Changeset[] = [
      {
        id: 'cs1',
        releases: [
          {
            name: 'core',
            type: 'minor',
            cascade: { 'plugin-*': 'patch' as const },
          },
        ],
        summary: 'Feature with cascades',
      },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(3);
    const pluginA = plan.releases.find((r) => r.name === 'plugin-a')!;
    const pluginB = plan.releases.find((r) => r.name === 'plugin-b')!;
    expect(pluginA.type).toBe('patch');
    expect(pluginA.isCascadeBump).toBe(true);
    expect(pluginB.type).toBe('patch');
    expect(pluginB.isCascadeBump).toBe(true);
  });

  test('cascadeTo config on source package', () => {
    const packages = new Map([
      [
        'core',
        makePkg('core', '1.0.0', {
          bumpy: {
            cascadeTo: {
              'plugin-*': { trigger: 'minor', bumpAs: 'patch' },
            },
          },
        }),
      ],
      ['plugin-a', makePkg('plugin-a', '1.0.0')],
      ['plugin-b', makePkg('plugin-b', '1.0.0')],
      ['unrelated', makePkg('unrelated', '1.0.0')],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(3);
    expect(plan.releases.find((r) => r.name === 'unrelated')).toBeUndefined();
    expect(plan.releases.find((r) => r.name === 'plugin-a')!.type).toBe('patch');
  });

  test('specific dependency rules override global rules', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      [
        'special',
        makePkg('special', '1.0.0', {
          dependencies: { core: '^1.0.0' },
          bumpy: {
            specificDependencyRules: {
              core: { trigger: 'none', bumpAs: 'patch' },
            },
          },
        }),
      ],
      ['normal', makePkg('normal', '1.0.0', { dependencies: { core: '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

    expect(plan.releases).toHaveLength(2);
    expect(plan.releases.find((r) => r.name === 'normal')).toBeDefined();
    expect(plan.releases.find((r) => r.name === 'special')).toBeUndefined();
  });

  test('fixed groups: all packages get highest bump', () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0')],
      ['pkg-b', makePkg('pkg-b', '1.0.0')],
      ['pkg-c', makePkg('pkg-c', '1.0.0')],
    ]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Feature' },
      { id: 'cs2', releases: [{ name: 'pkg-b', type: 'patch' }], summary: 'Fix' },
    ];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ fixed: [['pkg-a', 'pkg-b', 'pkg-c']] });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    expect(plan.releases).toHaveLength(3);
    for (const r of plan.releases) {
      expect(r.type).toBe('minor');
      expect(r.newVersion).toBe('1.1.0');
    }
  });

  test('devDependencies do not propagate by default', () => {
    const packages = new Map([
      ['test-utils', makePkg('test-utils', '1.0.0')],
      ['app', makePkg('app', '1.0.0', { devDependencies: { 'test-utils': '^1.0.0' } })],
    ]);

    const changesets: Changeset[] = [
      { id: 'cs1', releases: [{ name: 'test-utils', type: 'major' }], summary: 'Breaking' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('test-utils');
  });

  test('empty changesets returns empty plan', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan([], packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(0);
    expect(plan.changesets).toHaveLength(0);
  });

  test('transitive dependency propagation', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['middle', makePkg('middle', '1.0.0', { dependencies: { core: '~1.0.0' } })],
      ['app', makePkg('app', '1.0.0', { dependencies: { middle: '~1.0.0' } })],
    ]);

    const changesets: Changeset[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

    const graph = new DependencyGraph(packages);
    const config = makeConfig({ updateInternalDependencies: 'out-of-range' });
    const plan = assembleReleasePlan(changesets, packages, graph, config);

    expect(plan.releases.find((r) => r.name === 'core')).toBeDefined();
    expect(plan.releases.find((r) => r.name === 'middle')).toBeDefined();
    expect(plan.releases.find((r) => r.name === 'app')).toBeUndefined();
  });

  test('multi-package changeset bumps all listed packages', () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0')],
      ['pkg-b', makePkg('pkg-b', '2.0.0')],
    ]);

    const changesets: Changeset[] = [
      {
        id: 'cs1',
        releases: [
          { name: 'pkg-a', type: 'minor' },
          { name: 'pkg-b', type: 'patch' },
        ],
        summary: 'Cross-package change',
      },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(changesets, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(2);
    expect(plan.releases.find((r) => r.name === 'pkg-a')!.newVersion).toBe('1.1.0');
    expect(plan.releases.find((r) => r.name === 'pkg-b')!.newVersion).toBe('2.0.1');
  });
});
