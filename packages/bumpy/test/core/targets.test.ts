import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson } from '../../src/utils/fs.ts';
import { makePkg, makeConfig } from '../helpers.ts';
import {
  resolvePackageTargets,
  getPackageTargets,
  getNpmTarget,
  packagePublishes,
  targetLabel,
} from '../../src/core/targets/registry.ts';
import { loadPackageConfig } from '../../src/core/config.ts';
import { parsePyproject, updatePyprojectVersion } from '../../src/core/targets/pypi.ts';
import type { BumpyConfig } from '../../src/types.ts';

function configWithTargets(targets: BumpyConfig['targets']): BumpyConfig {
  return makeConfig({ targets });
}

describe('resolvePackageTargets — legacy field mapping', () => {
  test('default: public package gets the implicit npm target', () => {
    const pkg = makePkg('lib', '1.0.0');
    const targets = resolvePackageTargets(pkg, {}, makeConfig());
    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe('npm');
    expect(targets[0]!.type).toBe('npm');
  });

  test('publishCommand maps to a custom target named "custom" (matches old metadata keys)', () => {
    const pkg = makePkg('ext', '1.0.0');
    const targets = resolvePackageTargets(
      pkg,
      { publishCommand: 'vsce publish', checkPublished: 'my-check' },
      makeConfig(),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.name).toBe('custom');
    expect(targets[0]!.type).toBe('custom');
    expect(targets[0]!.options.command).toBe('vsce publish');
    expect(targets[0]!.options.checkPublished).toBe('my-check');
  });

  test('skipNpmPublish yields no targets', () => {
    const pkg = makePkg('tool', '1.0.0');
    expect(resolvePackageTargets(pkg, { skipNpmPublish: true }, makeConfig())).toHaveLength(0);
  });

  test('private package without publishCommand yields no targets', () => {
    const pkg = makePkg('app', '1.0.0', { private: true });
    expect(resolvePackageTargets(pkg, {}, makeConfig())).toHaveLength(0);
  });

  test('private package with publishCommand keeps its custom target', () => {
    const pkg = makePkg('ext', '1.0.0', { private: true });
    const targets = resolvePackageTargets(pkg, { publishCommand: 'do-publish' }, makeConfig());
    expect(targets).toHaveLength(1);
    expect(targets[0]!.type).toBe('custom');
  });

  test('legacy npm target picks up root targets.npm type defaults', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({ npm: { provenance: true } });
    const targets = resolvePackageTargets(pkg, {}, config);
    expect(targets[0]!.options.provenance).toBe(true);
  });
});

describe('resolvePackageTargets — explicit publishTargets', () => {
  test('string entries resolve built-in types', () => {
    const pkg = makePkg('lib', '1.0.0');
    const targets = resolvePackageTargets(pkg, { publishTargets: ['npm'] }, makeConfig());
    expect(targets).toHaveLength(1);
    expect(targets[0]!.type).toBe('npm');
  });

  test('multiple targets on one package', () => {
    const pkg = makePkg('ext', '1.0.0', { private: true });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['vscode-marketplace', 'open-vsx'] }, makeConfig());
    expect(targets.map((t) => t.type)).toEqual(['vscode-marketplace', 'open-vsx']);
  });

  test('inline entry with options', () => {
    const pkg = makePkg('lib', '1.0.0');
    const targets = resolvePackageTargets(
      pkg,
      { publishTargets: [{ type: 'custom', name: 'cdn', command: 'upload {{version}}' }] },
      makeConfig(),
    );
    expect(targets[0]!.name).toBe('cdn');
    expect(targets[0]!.type).toBe('custom');
    expect(targets[0]!.options.command).toBe('upload {{version}}');
  });

  test('named instance from root targets map', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({
      ghp: { type: 'npm', registry: 'https://npm.pkg.github.com' },
    });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['npm', 'ghp'] }, config);
    expect(targets).toHaveLength(2);
    expect(targets[1]!.name).toBe('ghp');
    expect(targets[1]!.type).toBe('npm');
    expect(targets[1]!.options.registry).toBe('https://npm.pkg.github.com');
  });

  test('named instance inherits type defaults, its own options win', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({
      npm: { provenance: true, access: 'public' },
      ghp: { type: 'npm', registry: 'https://npm.pkg.github.com', access: 'restricted' },
    });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['ghp'] }, config);
    expect(targets[0]!.options.provenance).toBe(true); // inherited from targets.npm
    expect(targets[0]!.options.access).toBe('restricted'); // instance wins
  });

  test('inline entry options win over type defaults', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({ npm: { provenance: true } });
    const targets = resolvePackageTargets(pkg, { publishTargets: [{ type: 'npm', provenance: false }] }, config);
    expect(targets[0]!.options.provenance).toBe(false);
  });

  test('npm targets are dropped for private packages', () => {
    const pkg = makePkg('ext', '1.0.0', { private: true });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['npm', 'open-vsx'] }, makeConfig());
    expect(targets.map((t) => t.type)).toEqual(['open-vsx']);
  });

  test('duplicate instance names throw', () => {
    const pkg = makePkg('lib', '1.0.0');
    expect(() =>
      resolvePackageTargets(
        pkg,
        {
          publishTargets: [
            { type: 'custom', command: 'a' },
            { type: 'custom', command: 'b' },
          ],
        },
        makeConfig(),
      ),
    ).toThrow(/duplicate publish target name "custom"/);
  });

  test('unknown string reference throws', () => {
    const pkg = makePkg('lib', '1.0.0');
    expect(() => resolvePackageTargets(pkg, { publishTargets: ['cargo'] }, makeConfig())).toThrow(
      /unknown publish target "cargo"/,
    );
  });

  test('unknown inline type throws', () => {
    const pkg = makePkg('lib', '1.0.0');
    expect(() => resolvePackageTargets(pkg, { publishTargets: [{ type: 'cargo' }] }, makeConfig())).toThrow(
      /Unknown publish target type "cargo"/,
    );
  });

  test('root targets key colliding with a built-in type cannot redirect it', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({ npm: { type: 'custom', command: 'evil' } });
    expect(() => resolvePackageTargets(pkg, { publishTargets: ['npm'] }, config)).toThrow(/built-in target type/);
  });

  test('named instance without a type throws', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({ mystery: { registry: 'x' } });
    expect(() => resolvePackageTargets(pkg, { publishTargets: ['mystery'] }, config)).toThrow(/must declare a "type"/);
  });

  test('explicit empty list yields no targets', () => {
    const pkg = makePkg('tool', '1.0.0');
    expect(resolvePackageTargets(pkg, { publishTargets: [] }, makeConfig())).toHaveLength(0);
  });
});

describe('target helpers', () => {
  test('getPackageTargets prefers targets attached at discovery', () => {
    const pkg = makePkg('lib', '1.0.0');
    pkg.targets = resolvePackageTargets(pkg, { publishTargets: ['npm', 'open-vsx'] }, makeConfig());
    pkg.bumpy = { skipNpmPublish: true }; // would resolve to [] — must be ignored
    expect(getPackageTargets(pkg).map((t) => t.type)).toEqual(['npm', 'open-vsx']);
  });

  test('packagePublishes / getNpmTarget', () => {
    const npmPkg = makePkg('lib', '1.0.0');
    const nonePkg = makePkg('tool', '1.0.0', { bumpy: { skipNpmPublish: true } });
    expect(packagePublishes(npmPkg)).toBe(true);
    expect(packagePublishes(nonePkg)).toBe(false);
    expect(getNpmTarget(npmPkg)?.type).toBe('npm');
    expect(getNpmTarget(nonePkg)).toBeUndefined();
  });

  test('targetLabel: npm on GitHub Packages registry', () => {
    const pkg = makePkg('lib', '1.0.0');
    const config = configWithTargets({ ghp: { type: 'npm', registry: 'https://npm.pkg.github.com' } });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['ghp'] }, config);
    expect(targetLabel(targets[0]!, pkg)).toBe('GitHub Packages');
  });

  test('targetLabel: marketplace targets', () => {
    const pkg = makePkg('ext', '1.0.0', { private: true });
    const targets = resolvePackageTargets(pkg, { publishTargets: ['vscode-marketplace', 'open-vsx'] }, makeConfig());
    expect(targetLabel(targets[0]!, pkg)).toBe('VS Code Marketplace');
    expect(targetLabel(targets[1]!, pkg)).toBe('Open VSX');
  });
});

describe('pypi pyproject.toml helpers', () => {
  const TOML = ['[project]', 'name = "my-tool"', 'version = "1.0.0"', '', '[tool.uv]', 'dev = true'].join('\n');

  test('parsePyproject extracts name/version from [project] only', () => {
    const info = parsePyproject(TOML);
    expect(info.name).toBe('my-tool');
    expect(info.version).toBe('1.0.0');
    expect(info.dynamicVersion).toBe(false);
  });

  test('parsePyproject detects dynamic version', () => {
    const info = parsePyproject('[project]\nname = "x"\ndynamic = ["version", "readme"]\n');
    expect(info.version).toBeUndefined();
    expect(info.dynamicVersion).toBe(true);
  });

  test('updatePyprojectVersion rewrites only the [project] version, preserving formatting', () => {
    const withOther = `# comment\n${TOML}\n\n[tool.other]\nversion = "3.3.3"\n`;
    const updated = updatePyprojectVersion(withOther, '2.5.0')!;
    expect(updated).toContain('version = "2.5.0"');
    expect(updated).toContain('version = "3.3.3"');
    expect(updated).toContain('# comment');
    expect(updated).not.toContain('"1.0.0"');
  });

  test('updatePyprojectVersion returns null when no static version exists', () => {
    expect(updatePyprojectVersion('[project]\nname = "x"\n', '1.0.0')).toBeNull();
    expect(updatePyprojectVersion('[tool.poetry]\nversion = "1.0.0"\n', '2.0.0')).toBeNull();
  });
});

describe('publishTargets trust gating (package.json config)', () => {
  async function loadFromPkgJson(bumpy: unknown, rootConfig: BumpyConfig) {
    const dir = await mkdtemp(resolve(tmpdir(), 'bumpy-targets-trust-'));
    try {
      await writeJson(resolve(dir, 'package.json'), { name: 'my-pkg', version: '1.0.0', bumpy });
      return await loadPackageConfig(dir, rootConfig, 'my-pkg');
    } finally {
      await rm(dir, { recursive: true });
    }
  }

  test('inline commands in package.json publishTargets are blocked by default', async () => {
    await expect(
      loadFromPkgJson({ publishTargets: [{ type: 'custom', command: 'rm -rf /' }] }, makeConfig()),
    ).rejects.toThrow(/custom command/);
  });

  test('inline commands allowed with allowCustomCommands', async () => {
    const config = makeConfig({ allowCustomCommands: true });
    const result = await loadFromPkgJson({ publishTargets: [{ type: 'custom', command: 'ok' }] }, config);
    expect(result.publishTargets).toHaveLength(1);
  });

  test('string references and data-only options are always allowed', async () => {
    const result = await loadFromPkgJson(
      { publishTargets: ['vscode-marketplace', { type: 'npm', registry: 'https://example.com' }] },
      makeConfig(),
    );
    expect(result.publishTargets).toHaveLength(2);
  });
});
