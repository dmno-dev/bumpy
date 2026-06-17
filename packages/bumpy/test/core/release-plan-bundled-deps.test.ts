import { test, expect, describe } from 'bun:test';
import { assembleReleasePlan } from '../../src/core/release-plan.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { makePkg, makeConfig } from '../helpers.ts';
import type { BumpFile } from '../../src/types.ts';

describe('bundledDependencies — devDeps baked into published output', () => {
  const coreMinor: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'minor' }], summary: 'Feature' }];
  const corePatch: BumpFile[] = [{ id: 'cs1', releases: [{ name: 'core', type: 'patch' }], summary: 'Fix' }];

  test('without the marker, a devDep bump does not propagate', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      ['app', makePkg('app', '2.0.0', { devDependencies: { core: '^1.0.0' } })],
    ]);
    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(coreMinor, packages, graph, makeConfig());
    expect(plan.releases.map((r) => r.name)).toEqual(['core']);
  });

  test('marking a devDep as bundled republishes the consumer with a patch bump', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      [
        'app',
        makePkg('app', '2.0.0', { devDependencies: { core: '^1.0.0' }, bumpy: { bundledDependencies: ['core'] } }),
      ],
    ]);
    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(coreMinor, packages, graph, makeConfig());

    const app = plan.releases.find((r) => r.name === 'app');
    expect(app?.type).toBe('patch');
    expect(app?.newVersion).toBe('2.0.1');
    expect(app?.isCascadeBump).toBe(true);
  });

  test('cascades even when the bump stays in range (any change to bundled code ships)', () => {
    // 1.0.0 → 1.0.1 still satisfies `^1.0.0`, so Phase A would never fire — but the
    // bundled output changed, so the consumer must still be republished.
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      [
        'app',
        makePkg('app', '2.0.0', { devDependencies: { core: '^1.0.0' }, bumpy: { bundledDependencies: ['core'] } }),
      ],
    ]);
    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(corePatch, packages, graph, makeConfig());
    expect(plan.releases.find((r) => r.name === 'app')?.newVersion).toBe('2.0.1');
  });

  test('glob patterns match bundled deps', () => {
    const packages = new Map([
      ['@myorg/core', makePkg('@myorg/core', '1.0.0')],
      [
        '@myorg/app',
        makePkg('@myorg/app', '2.0.0', {
          devDependencies: { '@myorg/core': '^1.0.0' },
          bumpy: { bundledDependencies: ['@myorg/*'] },
        }),
      ],
    ]);
    const graph = new DependencyGraph(packages);
    const bumpFiles: BumpFile[] = [
      { id: 'cs1', releases: [{ name: '@myorg/core', type: 'minor' }], summary: 'Feature' },
    ];
    const plan = assembleReleasePlan(bumpFiles, packages, graph, makeConfig());
    expect(plan.releases.find((r) => r.name === '@myorg/app')?.newVersion).toBe('2.0.1');
  });

  test('an unbundled devDep alongside a bundled one stays skipped', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      [
        'app',
        makePkg('app', '2.0.0', { devDependencies: { core: '^1.0.0' }, bumpy: { bundledDependencies: ['other-lib'] } }),
      ],
    ]);
    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(coreMinor, packages, graph, makeConfig());
    expect(plan.releases.map((r) => r.name)).toEqual(['core']);
  });

  test('an explicit cascadeFrom rule wins over the bundled default (proportional bump)', () => {
    const packages = new Map([
      ['core', makePkg('core', '1.0.0')],
      [
        'app',
        makePkg('app', '2.0.0', {
          devDependencies: { core: '^1.0.0' },
          bumpy: {
            bundledDependencies: ['core'],
            cascadeFrom: { core: { trigger: 'patch', bumpAs: 'match' } },
          },
        }),
      ],
    ]);
    const graph = new DependencyGraph(packages);
    const plan = assembleReleasePlan(coreMinor, packages, graph, makeConfig());
    // bumpAs 'match' → minor on core cascades a minor (not the bundled-default patch)
    expect(plan.releases.find((r) => r.name === 'app')?.newVersion).toBe('2.1.0');
  });
});
