import { test, expect, describe } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  parseCatalogs,
  diffCatalogMaps,
  isCatalogRefAffected,
  resolveCatalogDep,
  catalogYamlFile,
  detectWorkspaces,
  type CatalogMap,
} from '../../src/utils/package-manager.ts';

describe('parseCatalogs', () => {
  test('returns empty map when no content', () => {
    expect(parseCatalogs(null, null).size).toBe(0);
  });

  test('parses default catalog from pnpm-workspace.yaml', () => {
    const yaml = `
packages:
  - 'packages/*'
catalog:
  react: ^19.0.0
  lodash: ^4.17.21
`;
    const catalogs = parseCatalogs(yaml, null);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0', lodash: '^4.17.21' });
  });

  test('parses default catalog from .yarnrc.yml (same shape as pnpm)', () => {
    // Yarn (>=4.10) stores catalogs in .yarnrc.yml using the same catalog/catalogs keys
    const yaml = `
catalog:
  react: ^19.0.0
  lodash: ^4.17.21
`;
    const catalogs = parseCatalogs(yaml, null);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0', lodash: '^4.17.21' });
  });

  test('parses named catalogs from .yarnrc.yml', () => {
    const yaml = `
catalog:
  lodash: ^4.17.21
catalogs:
  react18:
    react: ^18.3.1
    react-dom: ^18.3.1
`;
    const catalogs = parseCatalogs(yaml, null);
    expect(catalogs.get('')).toEqual({ lodash: '^4.17.21' });
    expect(catalogs.get('react18')).toEqual({ react: '^18.3.1', 'react-dom': '^18.3.1' });
  });

  test('parses named catalogs from pnpm-workspace.yaml', () => {
    const yaml = `
catalogs:
  testing:
    jest: ^30.0.0
  build:
    typescript: ^5.0.0
`;
    const catalogs = parseCatalogs(yaml, null);
    expect(catalogs.get('testing')).toEqual({ jest: '^30.0.0' });
    expect(catalogs.get('build')).toEqual({ typescript: '^5.0.0' });
  });

  test('parses top-level catalog from package.json (bun/yarn style)', () => {
    const pkg = JSON.stringify({
      name: 'root',
      catalog: { react: '^19.0.0' },
      catalogs: { testing: { jest: '^30.0.0' } },
    });
    const catalogs = parseCatalogs(null, pkg);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0' });
    expect(catalogs.get('testing')).toEqual({ jest: '^30.0.0' });
  });

  test('parses workspaces.catalog from package.json (bun nested style)', () => {
    const pkg = JSON.stringify({
      name: 'root',
      workspaces: {
        packages: ['packages/*'],
        catalog: { react: '^19.0.0' },
        catalogs: { testing: { jest: '^30.0.0' } },
      },
    });
    const catalogs = parseCatalogs(null, pkg);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0' });
    expect(catalogs.get('testing')).toEqual({ jest: '^30.0.0' });
  });

  test('package.json catalog overrides pnpm yaml when both present', () => {
    const yaml = `catalog:\n  react: ^18.0.0\n`;
    const pkg = JSON.stringify({ catalog: { react: '^19.0.0' } });
    const catalogs = parseCatalogs(yaml, pkg);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0' });
  });

  test('tolerates malformed yaml', () => {
    expect(() => parseCatalogs('not: valid: yaml: at all', null)).not.toThrow();
  });

  test('tolerates malformed json', () => {
    expect(() => parseCatalogs(null, '{not valid json')).not.toThrow();
  });

  test('catalogs.default is stored under "" so it merges with the top-level catalog', () => {
    // pnpm treats top-level `catalog` and `catalogs.default` as aliases of the same default catalog
    const yaml = `
catalogs:
  default:
    react: ^19.0.0
`;
    const catalogs = parseCatalogs(yaml, null);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0' });
    expect(catalogs.has('default')).toBe(false);
  });

  test('catalogs.default in package.json also normalizes to ""', () => {
    const pkg = JSON.stringify({ catalogs: { default: { react: '^19.0.0' }, testing: { jest: '^30.0.0' } } });
    const catalogs = parseCatalogs(null, pkg);
    expect(catalogs.get('')).toEqual({ react: '^19.0.0' });
    expect(catalogs.get('testing')).toEqual({ jest: '^30.0.0' });
    expect(catalogs.has('default')).toBe(false);
  });
});

describe('diffCatalogMaps', () => {
  function mapOf(obj: Record<string, Record<string, string>>): CatalogMap {
    return new Map(Object.entries(obj));
  }

  test('returns empty when catalogs are identical', () => {
    const a = mapOf({ '': { react: '^19.0.0' } });
    const b = mapOf({ '': { react: '^19.0.0' } });
    expect(diffCatalogMaps(a, b).size).toBe(0);
  });

  test('detects version change in default catalog', () => {
    const before = mapOf({ '': { react: '^19.0.0' } });
    const after = mapOf({ '': { react: '^19.1.0' } });
    const diff = diffCatalogMaps(before, after);
    expect(diff.get('')).toEqual(new Set(['react']));
  });

  test('detects added entry', () => {
    const before = mapOf({ '': { react: '^19.0.0' } });
    const after = mapOf({ '': { react: '^19.0.0', lodash: '^4.0.0' } });
    expect(diffCatalogMaps(before, after).get('')).toEqual(new Set(['lodash']));
  });

  test('detects removed entry', () => {
    const before = mapOf({ '': { react: '^19.0.0', lodash: '^4.0.0' } });
    const after = mapOf({ '': { react: '^19.0.0' } });
    expect(diffCatalogMaps(before, after).get('')).toEqual(new Set(['lodash']));
  });

  test('tracks changes in named catalogs separately', () => {
    const before = mapOf({ '': { react: '^19.0.0' }, testing: { jest: '^30.0.0' } });
    const after = mapOf({ '': { react: '^19.0.0' }, testing: { jest: '^30.1.0' } });
    const diff = diffCatalogMaps(before, after);
    expect(diff.has('')).toBe(false);
    expect(diff.get('testing')).toEqual(new Set(['jest']));
  });

  test('handles entirely new catalog', () => {
    const before = mapOf({});
    const after = mapOf({ '': { react: '^19.0.0' } });
    expect(diffCatalogMaps(before, after).get('')).toEqual(new Set(['react']));
  });
});

describe('isCatalogRefAffected', () => {
  const changes = new Map<string, Set<string>>([
    ['', new Set(['react'])],
    ['testing', new Set(['jest'])],
  ]);

  test('returns false for non-catalog ranges', () => {
    expect(isCatalogRefAffected('^19.0.0', 'react', changes)).toBe(false);
    expect(isCatalogRefAffected('workspace:*', 'react', changes)).toBe(false);
  });

  test('matches default catalog ref for changed entry', () => {
    expect(isCatalogRefAffected('catalog:', 'react', changes)).toBe(true);
  });

  test('default catalog ref does not match named catalog change', () => {
    expect(isCatalogRefAffected('catalog:', 'jest', changes)).toBe(false);
  });

  test('matches named catalog ref for changed entry', () => {
    expect(isCatalogRefAffected('catalog:testing', 'jest', changes)).toBe(true);
  });

  test('named catalog ref does not match different named catalog', () => {
    expect(isCatalogRefAffected('catalog:build', 'react', changes)).toBe(false);
  });

  test('returns false when depName is not in changes', () => {
    expect(isCatalogRefAffected('catalog:', 'lodash', changes)).toBe(false);
  });

  test('catalog:default is an alias for catalog: (default catalog)', () => {
    expect(isCatalogRefAffected('catalog:default', 'react', changes)).toBe(true);
    expect(isCatalogRefAffected('catalog:default', 'jest', changes)).toBe(false);
  });
});

describe('resolveCatalogDep (sanity check after refactor)', () => {
  test('resolves default catalog reference', () => {
    const catalogs: CatalogMap = new Map([['', { react: '^19.0.0' }]]);
    expect(resolveCatalogDep('react', 'catalog:', catalogs)).toBe('^19.0.0');
  });

  test('resolves named catalog reference', () => {
    const catalogs: CatalogMap = new Map([['testing', { jest: '^30.0.0' }]]);
    expect(resolveCatalogDep('jest', 'catalog:testing', catalogs)).toBe('^30.0.0');
  });

  test('returns null for non-catalog range', () => {
    const catalogs: CatalogMap = new Map([['', { react: '^19.0.0' }]]);
    expect(resolveCatalogDep('react', '^19.0.0', catalogs)).toBeNull();
  });

  test('returns null for missing entry', () => {
    const catalogs: CatalogMap = new Map([['', {}]]);
    expect(resolveCatalogDep('react', 'catalog:', catalogs)).toBeNull();
  });

  test('resolves catalog:default to the default catalog', () => {
    const catalogs: CatalogMap = new Map([['', { react: '^19.0.0' }]]);
    expect(resolveCatalogDep('react', 'catalog:default', catalogs)).toBe('^19.0.0');
  });
});

describe('catalogYamlFile', () => {
  test('pnpm uses pnpm-workspace.yaml', () => {
    expect(catalogYamlFile('pnpm')).toBe('pnpm-workspace.yaml');
  });

  test('yarn uses .yarnrc.yml', () => {
    expect(catalogYamlFile('yarn')).toBe('.yarnrc.yml');
  });

  test('npm and bun have no workspace catalog yaml', () => {
    expect(catalogYamlFile('npm')).toBeNull();
    expect(catalogYamlFile('bun')).toBeNull();
  });
});

describe('detectWorkspaces catalog loading', () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(resolve(tmpdir(), 'bumpy-pm-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('loads Yarn catalogs from .yarnrc.yml (issue #148)', async () => {
    await withTempDir(async (dir) => {
      await writeFile(resolve(dir, 'yarn.lock'), '');
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      await writeFile(
        resolve(dir, '.yarnrc.yml'),
        `catalog:\n  react: ^19.0.0\ncatalogs:\n  testing:\n    jest: ^30.0.0\n`,
      );

      const info = await detectWorkspaces(dir);
      expect(info.packageManager).toBe('yarn');
      expect(info.catalogs.get('')).toEqual({ react: '^19.0.0' });
      expect(info.catalogs.get('testing')).toEqual({ jest: '^30.0.0' });
    });
  });

  test('does not read .yarnrc.yml for a pnpm workspace', async () => {
    await withTempDir(async (dir) => {
      await writeFile(resolve(dir, 'pnpm-lock.yaml'), '');
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'root' }));
      // A stray .yarnrc.yml should be ignored when the PM is pnpm
      await writeFile(resolve(dir, '.yarnrc.yml'), `catalog:\n  react: ^18.0.0\n`);
      await writeFile(resolve(dir, 'pnpm-workspace.yaml'), `catalog:\n  react: ^19.0.0\n`);

      const info = await detectWorkspaces(dir);
      expect(info.packageManager).toBe('pnpm');
      expect(info.catalogs.get('')).toEqual({ react: '^19.0.0' });
    });
  });
});
