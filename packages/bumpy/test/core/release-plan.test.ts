import { test, expect, describe } from 'bun:test';
import { assembleReleasePlan } from '../../src/core/release-plan.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { makePkg, makeConfig } from '../helpers.ts';
import type { BumpFile } from '../../src/types.ts';

describe('assembleReleasePlan', () => {
  test('basic single package bump', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const bumpFiles: BumpFile[] = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Added feature' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.name).toBe('pkg-a');
    expect(plan.releases[0]!.type).toBe('minor');
    expect(plan.releases[0]!.oldVersion).toBe('1.0.0');
    expect(plan.releases[0]!.newVersion).toBe('1.1.0');
  });

  test('multiple bump files for same package take highest bump', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const bumpFiles: BumpFile[] = [
      { id: 'cs1', releases: [{ name: 'pkg-a', type: 'patch' }], summary: 'Fix' },
      { id: 'cs2', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Feature' },
    ];

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(1);
    expect(plan.releases[0]!.type).toBe('minor');
    expect(plan.releases[0]!.newVersion).toBe('1.1.0');
  });

  test('empty bump files returns empty plan', () => {
    const packages = new Map([['pkg-a', makePkg('pkg-a', '1.0.0')]]);

    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan([], packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(0);
    expect(plan.bumpFiles).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  test('multi-package bump file bumps all listed packages', () => {
    const packages = new Map([
      ['pkg-a', makePkg('pkg-a', '1.0.0')],
      ['pkg-b', makePkg('pkg-b', '2.0.0')],
    ]);

    const bumpFiles: BumpFile[] = [
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
    const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

    expect(plan.releases).toHaveLength(2);
    expect(plan.releases.find((r) => r.name === 'pkg-a')!.newVersion).toBe('1.1.0');
    expect(plan.releases.find((r) => r.name === 'pkg-b')!.newVersion).toBe('2.0.1');
  });

  // ---- Phase A: out-of-range checks ----

  describe('Phase A: out-of-range', () => {
    test('out-of-range peer dep gets "match" bump level (not always major)', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2);
      const pluginRelease = plan.releases.find((r) => r.name === 'plugin')!;
      expect(pluginRelease.type).toBe('major'); // matches the triggering bump
      expect(pluginRelease.isDependencyBump).toBe(true);
    });

    test('out-of-range regular dep gets patch', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2);
      const appRelease = plan.releases.find((r) => r.name === 'app')!;
      expect(appRelease.type).toBe('patch'); // regular deps get patch
      expect(appRelease.isDependencyBump).toBe(true);
    });

    test('devDeps are skipped in Phase A', () => {
      const packages = new Map([
        ['test-utils', makePkg('test-utils', '1.0.0')],
        ['app', makePkg('app', '1.0.0', { devDependencies: { 'test-utils': '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [
        { id: 'cs1', releases: [{ name: 'test-utils', type: 'major' }], summary: 'Breaking' },
      ];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      // Even with major bump going out-of-range, devDeps are skipped
      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('test-utils');
    });

    test('workspace:^ resolved correctly for range checking', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.2.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: 'workspace:^' } })],
      ]);

      // Minor bump: 1.2.0 → 1.3.0, which satisfies ^1.2.0
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1); // app is NOT bumped because 1.3.0 satisfies ^1.2.0
    });

    test('workspace:^ triggers propagation on major bump', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.2.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: 'workspace:^' } })],
      ]);

      // Major bump: 1.2.0 → 2.0.0, which does NOT satisfy ^1.2.0
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2); // app IS bumped
      expect(plan.releases.find((r) => r.name === 'app')!.type).toBe('patch');
    });

    test('^0.x peer dep minor bump → minor bump on dependent + warning', () => {
      const packages = new Map([
        ['core', makePkg('core', '0.2.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^0.2.0' } })],
      ]);

      // Minor bump: 0.2.0 → 0.3.0, which does NOT satisfy ^0.2.0 (0.x caret range!)
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2);
      const pluginRelease = plan.releases.find((r) => r.name === 'plugin')!;
      expect(pluginRelease.type).toBe('minor'); // matches the triggering bump
      expect(pluginRelease.isDependencyBump).toBe(true);

      // Should generate a warning about ^0.x propagation
      expect(plan.warnings.length).toBeGreaterThan(0);
      expect(plan.warnings[0]).toContain('plugin');
      expect(plan.warnings[0]).toContain('^0.2.0');
    });

    test('skips propagation when version still satisfies range', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });

    test('transitive dependency propagation through out-of-range', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['middle', makePkg('middle', '1.0.0', { dependencies: { core: '~1.0.0' } })],
        ['app', makePkg('app', '1.0.0', { dependencies: { middle: '~1.0.0' } })],
      ]);

      // minor bump on core: 1.0.0 → 1.1.0, breaks ~1.0.0
      // middle gets patch: 1.0.0 → 1.0.1, satisfies ~1.0.0 on app → stops
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases.find((r) => r.name === 'core')).toBeDefined();
      expect(plan.releases.find((r) => r.name === 'middle')).toBeDefined();
      expect(plan.releases.find((r) => r.name === 'app')).toBeUndefined();
    });
  });

  // ---- Phase B: fixed/linked groups ----

  describe('Phase B: fixed and linked groups', () => {
    test('fixed groups: all packages get highest bump', () => {
      const packages = new Map([
        ['pkg-a', makePkg('pkg-a', '1.0.0')],
        ['pkg-b', makePkg('pkg-b', '1.0.0')],
        ['pkg-c', makePkg('pkg-c', '1.0.0')],
      ]);

      const bumpFiles: BumpFile[] = [
        { id: 'cs1', releases: [{ name: 'pkg-a', type: 'minor' }], summary: 'Feature' },
        { id: 'cs2', releases: [{ name: 'pkg-b', type: 'patch' }], summary: 'Fix' },
      ];

      const graph = new DependencyGraph(packages);
      const config = makeConfig({ fixed: [['pkg-a', 'pkg-b', 'pkg-c']] });
      const plan = assembleReleasePlan(bumpFiles, packages, graph, config);

      expect(plan.releases).toHaveLength(3);
      for (const r of plan.releases) {
        expect(r.type).toBe('minor');
        expect(r.newVersion).toBe('1.1.0');
      }
    });

    test('fixed group re-applied after propagation', () => {
      // core and types are in a fixed group. Bumping core causes propagation
      // to plugin (via dep), which then should also pull types (fixed group).
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['types', makePkg('types', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { dependencies: { core: '~1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const config = makeConfig({ fixed: [['core', 'types']] });
      const plan = assembleReleasePlan(bumpFiles, packages, graph, config);

      // core gets minor, types gets minor (fixed), plugin gets patch (out-of-range dep)
      expect(plan.releases).toHaveLength(3);
      expect(plan.releases.find((r) => r.name === 'core')!.type).toBe('minor');
      expect(plan.releases.find((r) => r.name === 'types')!.type).toBe('minor');
      expect(plan.releases.find((r) => r.name === 'plugin')!.type).toBe('patch');
    });

    test('linked group re-applied after propagation', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin-a', makePkg('plugin-a', '2.0.0', { dependencies: { core: '~1.0.0' } })],
        ['plugin-b', makePkg('plugin-b', '3.0.0', { dependencies: { core: '~1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [
        { id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' },
        { id: 'cs2', releases: [{ name: 'plugin-a', type: 'minor' }], summary: 'Plugin feature' },
      ];

      const graph = new DependencyGraph(packages);
      const config = makeConfig({ linked: [['plugin-a', 'plugin-b']] });
      const plan = assembleReleasePlan(bumpFiles, packages, graph, config);

      // plugin-a has minor from changeset, plugin-b gets patch from out-of-range propagation
      // linked group raises plugin-b to match plugin-a's minor
      const pluginA = plan.releases.find((r) => r.name === 'plugin-a')!;
      const pluginB = plan.releases.find((r) => r.name === 'plugin-b')!;
      expect(pluginA.type).toBe('minor');
      expect(pluginB.type).toBe('minor');
    });
  });

  // ---- Phase C: proactive propagation ----

  describe('Phase C: proactive propagation', () => {
    test('cascadeTo works', () => {
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

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(3);
      expect(plan.releases.find((r) => r.name === 'unrelated')).toBeUndefined();
      expect(plan.releases.find((r) => r.name === 'plugin-a')!.type).toBe('patch');
    });

    test('proactive propagation with updateInternalDependencies: "patch"', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      expect(plan.releases).toHaveLength(2);
      const appRelease = plan.releases.find((r) => r.name === 'app')!;
      expect(appRelease.type).toBe('patch');
      expect(appRelease.isDependencyBump).toBe(true);
    });

    test('peer dependency minor bump does NOT propagate by default (out-of-range mode, range satisfied)', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      // ^1.0.0 satisfies 1.1.0, so no out-of-range propagation
      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });

    test('bump-file-level cascade overrides', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin-a', makePkg('plugin-a', '1.0.0')],
        ['plugin-b', makePkg('plugin-b', '1.0.0')],
      ]);

      const bumpFiles: BumpFile[] = [
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
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(3);
      const pluginA = plan.releases.find((r) => r.name === 'plugin-a')!;
      const pluginB = plan.releases.find((r) => r.name === 'plugin-b')!;
      expect(pluginA.type).toBe('patch');
      expect(pluginA.isCascadeBump).toBe(true);
      expect(pluginB.type).toBe('patch');
      expect(pluginB.isCascadeBump).toBe(true);
    });

    test('devDependencies do not propagate by default', () => {
      const packages = new Map([
        ['test-utils', makePkg('test-utils', '1.0.0')],
        ['app', makePkg('app', '1.0.0', { devDependencies: { 'test-utils': '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [
        { id: 'cs1', releases: [{ name: 'test-utils', type: 'major' }], summary: 'Breaking' },
      ];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      // devDeps rule is false by default → never propagates
      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('test-utils');
    });
  });

  // ---- none behavior ----

  describe('none suppression', () => {
    test('none suppresses bump when range is satisfied', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [
        {
          id: 'cs1',
          releases: [
            { name: 'core', type: 'minor' },
            { name: 'plugin', type: 'none' },
          ],
          summary: 'Feature',
        },
      ];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      // Plugin should NOT be in releases because it's suppressed
      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });

    test('none that would break range throws error', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [
        {
          id: 'cs1',
          releases: [
            { name: 'core', type: 'major' },
            { name: 'plugin', type: 'none' },
          ],
          summary: 'Breaking',
        },
      ];

      const graph = new DependencyGraph(packages);
      expect(() => assembleReleasePlan(bumpFiles, packages, graph, makeConfig())).toThrow(
        /Cannot suppress.*plugin.*none/,
      );
    });
  });

  // ---- Per-package dependency bump rules ----

  describe('per-package dependencyBumpRules', () => {
    test('per-package rules override global rules', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        [
          'special',
          makePkg('special', '1.0.0', {
            dependencies: { core: '^1.0.0' },
            bumpy: {
              dependencyBumpRules: {
                dependencies: { trigger: 'patch', bumpAs: 'patch' },
              },
            },
          }),
        ],
        ['normal', makePkg('normal', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      // Both should be bumped because updateInternalDependencies is 'patch'
      // and both have dependency bump rules that trigger on patch
      expect(plan.releases).toHaveLength(3);
      expect(plan.releases.find((r) => r.name === 'special')).toBeDefined();
      expect(plan.releases.find((r) => r.name === 'normal')).toBeDefined();
    });

    test('per-package rule set to false disables propagation for that dep type', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        [
          'special',
          makePkg('special', '1.0.0', {
            dependencies: { core: '^1.0.0' },
            bumpy: {
              dependencyBumpRules: {
                dependencies: false,
              },
            },
          }),
        ],
        ['normal', makePkg('normal', '1.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      // special should NOT be bumped (rule is false), normal should be
      expect(plan.releases).toHaveLength(2);
      expect(plan.releases.find((r) => r.name === 'normal')).toBeDefined();
      expect(plan.releases.find((r) => r.name === 'special')).toBeUndefined();
    });
  });

  // ---- workspace protocol resolution ----

  describe('workspace protocol resolution', () => {
    test('workspace:~ resolved correctly — minor breaks ~range', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.2.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: 'workspace:~' } })],
      ]);

      // Minor bump: 1.2.0 → 1.3.0, does NOT satisfy ~1.2.0 (>=1.2.0 <1.3.0)
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2);
      expect(plan.releases.find((r) => r.name === 'app')!.type).toBe('patch');
    });

    test('workspace:~ — patch stays in range', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.2.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: 'workspace:~' } })],
      ]);

      // Patch bump: 1.2.0 → 1.2.1, satisfies ~1.2.0
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
    });

    test('workspace:* is always satisfied — no propagation', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '1.0.0', { dependencies: { core: 'workspace:*' } })],
      ]);

      // Even a major bump should not propagate
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });

    test('workspace:^ on 0.x peer dep — minor breaks range, gets minor bump', () => {
      const packages = new Map([
        ['core', makePkg('core', '0.2.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: 'workspace:^' } })],
      ]);

      // Minor bump: 0.2.0 → 0.3.0, workspace:^ resolves to ^0.2.0, breaks range
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(2);
      const pluginRelease = plan.releases.find((r) => r.name === 'plugin')!;
      expect(pluginRelease.type).toBe('minor'); // matches triggering bump
      expect(pluginRelease.isDependencyBump).toBe(true);
      expect(plan.warnings.length).toBeGreaterThan(0);
    });

    test('workspace:^ on 0.x peer dep — patch stays in range', () => {
      const packages = new Map([
        ['core', makePkg('core', '0.2.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: 'workspace:^' } })],
      ]);

      // Patch bump: 0.2.0 → 0.2.1, workspace:^ resolves to ^0.2.0, stays in range
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
    });
  });

  // ---- Additional Phase C scenarios ----

  describe('Phase C: additional scenarios', () => {
    test('cascadeTo below trigger threshold does not cascade', () => {
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
      ]);

      // Patch bump on core — below minor trigger threshold
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });

    test('updateInternalDependencies: "minor" skips patch bumps', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'minor' }));

      // Patch bump on core — below minor threshold, app not bumped
      expect(plan.releases).toHaveLength(1);
    });

    test('updateInternalDependencies: "minor" propagates minor bumps', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['app', makePkg('app', '2.0.0', { dependencies: { core: '^1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'minor' }));

      expect(plan.releases).toHaveLength(2);
      expect(plan.releases.find((r) => r.name === 'app')!.isDependencyBump).toBe(true);
    });

    test('bumpAs: "match" in Phase C proactive propagation', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: '^1.0.0' } })],
      ]);

      // Major bump — peerDeps default rule is { trigger: 'major', bumpAs: 'match' }
      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'major' }], summary: 'Breaking' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig({ updateInternalDependencies: 'patch' }));

      const pluginRelease = plan.releases.find((r) => r.name === 'plugin')!;
      // bumpAs: 'match' means plugin gets major (matching core's bump level)
      expect(pluginRelease.type).toBe('major');
    });
  });

  // ---- Multi-phase interaction ----

  describe('multi-phase interaction', () => {
    test('Phase A → Phase B → Phase A across iterations', () => {
      // core and types in fixed group. plugin depends on types with tight range.
      // Bumping core → fixed group bumps types → types out-of-range breaks plugin → plugin bumps
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['types', makePkg('types', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { dependencies: { types: '~1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const config = makeConfig({ fixed: [['core', 'types']] });
      const plan = assembleReleasePlan(bumpFiles, packages, graph, config);

      // core: minor (explicit), types: minor (fixed group), plugin: patch (types out of range)
      expect(plan.releases).toHaveLength(3);
      expect(plan.releases.find((r) => r.name === 'core')!.type).toBe('minor');
      expect(plan.releases.find((r) => r.name === 'types')!.type).toBe('minor');
      expect(plan.releases.find((r) => r.name === 'plugin')!.type).toBe('patch');
    });

    test('long transitive chain stabilizes', () => {
      // a → b → c → d, each with tight ranges
      const packages = new Map([
        ['a', makePkg('a', '1.0.0')],
        ['b', makePkg('b', '1.0.0', { dependencies: { a: '~1.0.0' } })],
        ['c', makePkg('c', '1.0.0', { dependencies: { b: '~1.0.0' } })],
        ['d', makePkg('d', '1.0.0', { dependencies: { c: '~1.0.0' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'a', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      // a: minor (1.1.0, breaks ~1.0.0)
      // b: patch (1.0.1, satisfies ~1.0.0 on c) → chain stops
      expect(plan.releases).toHaveLength(2);
      expect(plan.releases.find((r) => r.name === 'a')!.type).toBe('minor');
      expect(plan.releases.find((r) => r.name === 'b')!.type).toBe('patch');
      expect(plan.releases.find((r) => r.name === 'c')).toBeUndefined();
    });
  });

  // ---- none edge cases ----

  describe('none edge cases', () => {
    test('none on a package not otherwise in the plan is a no-op', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['unrelated', makePkg('unrelated', '1.0.0')],
      ]);

      const bumpFiles: BumpFile[] = [
        {
          id: 'cs1',
          releases: [
            { name: 'core', type: 'minor' },
            { name: 'unrelated', type: 'none' },
          ],
          summary: 'Feature',
        },
      ];

      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.releases).toHaveLength(1);
      expect(plan.releases[0]!.name).toBe('core');
    });
  });

  // ---- Warnings ----

  describe('warnings', () => {
    test('workspace:* on peer dep generates warning', () => {
      const packages = new Map([
        ['core', makePkg('core', '1.0.0')],
        ['plugin', makePkg('plugin', '1.0.0', { peerDependencies: { core: 'workspace:*' } })],
      ]);

      const bumpFiles: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
      const graph = new DependencyGraph(packages);
      const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());

      expect(plan.warnings.some((w) => w.includes('workspace:*') && w.includes('plugin'))).toBe(true);
    });
  });
});
