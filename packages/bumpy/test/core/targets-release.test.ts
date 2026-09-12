import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, writeText, ensureDir } from '../../src/utils/fs.ts';
import { makePkg, gitInDir } from '../helpers.ts';
import { installShellMock, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { DependencyGraph } from '../../src/core/dep-graph.ts';
import { publishPackages } from '../../src/core/publish-pipeline.ts';
import { dockerTarget, dockerBuildArgs } from '../../src/core/targets/docker.ts';
import { githubReleaseAssetsTarget } from '../../src/core/targets/github-release-assets.ts';
import { homebrewTarget, renderFormula, formulaVersion } from '../../src/core/targets/homebrew.ts';
import { expandGlobs, templateString } from '../../src/core/targets/util.ts';
import type { TargetPublishContext } from '../../src/core/targets/types.ts';
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

describe('release-shaped targets (github-release-assets / docker / homebrew)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-rel-targets-'));
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

  function planFor(...pkgs: WorkspacePackage[]) {
    const packages = new Map(pkgs.map((p) => [p.name, p]));
    return {
      packages,
      depGraph: new DependencyGraph(packages),
      plan: {
        bumpFiles: [],
        warnings: [],
        releases: pkgs.map((p) => makeRelease(p.name, '1.0.0', '1.0.1')),
      } as ReleasePlan,
    };
  }

  describe('util', () => {
    test('templateString substitutes known placeholders and leaves unknown ones', () => {
      expect(templateString('v{{version}}-{{ name }}-{{nope}}', { version: '1.2.3', name: 'x' })).toBe(
        'v1.2.3-x-{{nope}}',
      );
    });

    test('expandGlobs matches relative to the dir, skipping node_modules', async () => {
      await ensureDir(resolve(tmpDir, 'dist'));
      await ensureDir(resolve(tmpDir, 'node_modules/x'));
      await writeText(resolve(tmpDir, 'dist/a.tar.gz'), 'a');
      await writeText(resolve(tmpDir, 'dist/b.zip'), 'b');
      await writeText(resolve(tmpDir, 'node_modules/x/c.tar.gz'), 'c');
      expect(expandGlobs(tmpDir, ['dist/*.tar.gz', '**/*.zip'])).toEqual(['dist/a.tar.gz', 'dist/b.zip']);
    });
  });

  describe('github-release-assets', () => {
    test('uploads matched files to the name@version release with --clobber', async () => {
      const pkgDir = await setupPkg('cli');
      await ensureDir(resolve(pkgDir, 'dist'));
      await writeText(resolve(pkgDir, 'dist/cli-macos-arm64.tar.gz'), 'bin');
      await writeText(resolve(pkgDir, 'dist/checksums.txt'), 'sums');
      await writeText(resolve(pkgDir, 'dist/notes.md'), 'ignored');
      const pkg = makePkg('cli', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: {
          publishTargets: [{ type: 'github-release-assets', files: ['dist/*.tar.gz', 'dist/checksums.txt'] }],
        },
      });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(0);
      expect(result.published.map((p) => p.name)).toEqual(['cli']);
      const uploads = getCallsMatching(/^gh release upload/);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.args.slice(0, 4)).toEqual(['gh', 'release', 'upload', 'cli@1.0.1']);
      expect(uploads[0]!.args).toContain(resolve(pkgDir, 'dist/cli-macos-arm64.tar.gz'));
      expect(uploads[0]!.args).toContain(resolve(pkgDir, 'dist/checksums.txt'));
      expect(uploads[0]!.args).not.toContain(resolve(pkgDir, 'dist/notes.md'));
      expect(uploads[0]!.args.at(-1)).toBe('--clobber');
    });

    test('registry guard: assets already on the release are not re-uploaded', async () => {
      const pkgDir = await setupPkg('cli2');
      await ensureDir(resolve(pkgDir, 'dist'));
      await writeText(resolve(pkgDir, 'dist/cli2.tar.gz'), 'bin');
      addMockRule({ match: /gh release view cli2@1\.0\.1/, response: 'cli2.tar.gz\nother.txt' });
      const pkg = makePkg('cli2', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: { publishTargets: [{ type: 'github-release-assets', files: ['dist/*.tar.gz'] }] },
      });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.targetOutcomes.get('cli2')![0]!.skipKind).toBe('registry');
      expect(getCallsMatching(/^gh release upload/)).toHaveLength(0);
    });

    test('fails clearly when nothing matched (assets not built)', async () => {
      const pkgDir = await setupPkg('cli3');
      const pkg = makePkg('cli3', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: { publishTargets: [{ type: 'github-release-assets', files: ['dist/*.tar.gz'] }] },
      });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      const outcome = result.targetOutcomes.get('cli3')![0]!;
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/no files matched/);
    });

    test('publishUrl points at the release page', () => {
      const pkg = makePkg('@acme/cli', '1.0.0');
      expect(githubReleaseAssetsTarget.publishUrl!(pkg, '1.0.1', {}, { repoSlug: 'acme/cli' })).toBe(
        'https://github.com/acme/cli/releases/tag/%40acme%2Fcli%401.0.1',
      );
    });
  });

  describe('docker', () => {
    function ctxFor(overrides: Partial<TargetPublishContext> = {}): TargetPublishContext {
      const pkg = makePkg('varlock', '1.0.0', { dir: '/repo/packages/varlock' });
      return {
        pkg,
        pkgConfig: {},
        version: '1.2.0',
        rootDir: '/repo',
        config: DEFAULT_CONFIG,
        options: { image: 'ghcr.io/dmno-dev/varlock' },
        dryRun: false,
        releaseKind: 'stable',
        packManager: 'npm',
        ...overrides,
      };
    }

    test('stable release: version + latest tags, platforms, build args, dockerfile, context', () => {
      const args = dockerBuildArgs(
        ctxFor({
          options: {
            image: 'ghcr.io/dmno-dev/varlock',
            context: '../..',
            dockerfile: '../../Dockerfile',
            platforms: ['linux/amd64', 'linux/arm64'],
            buildArgs: { VARLOCK_VERSION: '{{version}}' },
          },
        }),
      );
      expect(args).toEqual([
        'docker',
        'buildx',
        'build',
        '--push',
        '--tag',
        'ghcr.io/dmno-dev/varlock:1.2.0',
        '--tag',
        'ghcr.io/dmno-dev/varlock:latest',
        '--platform',
        'linux/amd64,linux/arm64',
        '--build-arg',
        'VARLOCK_VERSION=1.2.0',
        '--file',
        '/repo/Dockerfile',
        '/repo',
      ]);
    });

    test('channel release: version + dist-tag, never latest', () => {
      const args = dockerBuildArgs(ctxFor({ version: '1.2.0-next.0', releaseKind: 'channel', distTag: 'next' }));
      const tags = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tags).toEqual(['ghcr.io/dmno-dev/varlock:1.2.0-next.0', 'ghcr.io/dmno-dev/varlock:next']);
    });

    test('checkPublished: manifest present → true, unknown manifest → false, other errors → unknown', async () => {
      const pkg = makePkg('varlock', '1.0.0');
      const opts = { image: 'ghcr.io/dmno-dev/varlock' };
      addMockRule({ match: 'docker manifest inspect ghcr.io/dmno-dev/varlock:1.0.0', response: '{}' });
      addMockRule({ match: 'docker manifest inspect ghcr.io/dmno-dev/varlock:1.0.1', error: 'manifest unknown' });
      addMockRule({
        match: 'docker manifest inspect ghcr.io/dmno-dev/varlock:1.0.2',
        error: 'unauthorized: auth required',
      });
      expect(await dockerTarget.checkPublished!(pkg, '1.0.0', opts)).toBe(true);
      expect(await dockerTarget.checkPublished!(pkg, '1.0.1', opts)).toBe(false);
      expect(await dockerTarget.checkPublished!(pkg, '1.0.2', opts)).toBeNull();
    });

    test('publishes through the pipeline with buildx', async () => {
      const pkgDir = await setupPkg('img');
      const pkg = makePkg('img', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: { publishTargets: [{ type: 'docker', image: 'ghcr.io/acme/img' }] },
      });
      addMockRule({ match: 'docker --version', response: 'Docker version 27.0.0' });
      addMockRule({ match: 'docker manifest inspect', error: 'manifest unknown' });
      addMockRule({ match: 'docker buildx build', response: '' });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(0);
      const builds = getCallsMatching('docker buildx build');
      expect(builds).toHaveLength(1);
      expect(builds[0]!.command).toContain('--tag ghcr.io/acme/img:1.0.1');
      expect(builds[0]!.command).toContain('--tag ghcr.io/acme/img:latest');
    });

    test('labels and URLs by registry', () => {
      const pkg = makePkg('varlock', '1.0.0');
      expect(dockerTarget.label!({ image: 'ghcr.io/dmno-dev/varlock' })).toBe('GHCR');
      expect(dockerTarget.label!({ image: 'dmno/varlock' })).toBe('Docker Hub');
      expect(
        dockerTarget.publishUrl!(pkg, '1.0.0', { image: 'ghcr.io/dmno-dev/varlock' }, { repoSlug: 'dmno-dev/varlock' }),
      ).toBe('https://github.com/dmno-dev/varlock/pkgs/container/varlock');
      expect(dockerTarget.publishUrl!(pkg, '1.0.0', { image: 'dmno/varlock' }, {})).toBe(
        'https://hub.docker.com/r/dmno/varlock',
      );
    });
  });

  describe('homebrew', () => {
    const TEMPLATE = `class Varlock < Formula
  version "{{version}}"
  on_macos do
    url "https://github.com/dmno-dev/varlock/releases/download/varlock@#{version}/varlock-macos-arm64.tar.gz"
    sha256 "{{sha256 varlock-macos-arm64.tar.gz}}"
  end
end
`;

    test('renderFormula fills version and asset checksums; formulaVersion reads it back', () => {
      const rendered = renderFormula(TEMPLATE, { version: '1.2.3', name: 'varlock' }, (file) => `sha-of-${file}`);
      expect(rendered).toContain('version "1.2.3"');
      expect(rendered).toContain('sha256 "sha-of-varlock-macos-arm64.tar.gz"');
      expect(formulaVersion(rendered)).toBe('1.2.3');
    });

    test('checkPublished reads the formula version from the tap via the GitHub API', async () => {
      const pkg = makePkg('varlock', '1.0.0');
      const opts = { tap: 'dmno-dev/homebrew-tap' };
      const live = Buffer.from('class Varlock < Formula\n  version "1.0.1"\nend\n').toString('base64');
      addMockRule({ match: 'gh api repos/dmno-dev/homebrew-tap/contents/Formula/varlock.rb', response: live });
      expect(await homebrewTarget.checkPublished!(pkg, '1.0.1', opts)).toBe(true);
      expect(await homebrewTarget.checkPublished!(pkg, '1.0.2', opts)).toBe(false);
    });

    test('commits the rendered formula to the tap checkout, tags name@version, pushes', async () => {
      const pkgDir = await setupPkg('varlock');
      // Release asset the formula's sha256 refers to
      await ensureDir(resolve(pkgDir, 'dist'));
      const asset = 'binary-bytes';
      await writeText(resolve(pkgDir, 'dist/varlock-macos-arm64.tar.gz'), asset);
      await writeText(resolve(pkgDir, 'Formula.rb.tmpl'), TEMPLATE);

      // A tap repo with a remote, as actions/checkout would leave it
      const bare = resolve(tmpDir, 'tap.git');
      gitInDir(['init', '--bare', bare], tmpDir);
      const tapDir = resolve(tmpDir, 'homebrew-tap');
      gitInDir(['clone', '-q', bare, tapDir], tmpDir);
      await writeText(resolve(tapDir, 'README.md'), 'tap');
      gitInDir(['add', '.'], tapDir);
      gitInDir(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], tapDir);
      gitInDir(['push', '-q', 'origin', 'HEAD'], tapDir);

      const pkg = makePkg('varlock', '1.0.0', {
        dir: pkgDir,
        private: true,
        bumpy: {
          publishTargets: [
            {
              type: 'homebrew',
              tap: 'dmno-dev/homebrew-tap',
              template: 'Formula.rb.tmpl',
              assets: ['dist/*.tar.gz'],
              tapDir: '../../homebrew-tap',
            },
          ],
        },
      });
      // gh api (checkPublished) → not found
      addMockRule({ match: 'gh api repos/dmno-dev/homebrew-tap', error: 'HTTP 404: Not Found' });

      const { packages, depGraph, plan } = planFor(pkg);
      const result = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});

      expect(result.failed).toHaveLength(0);
      const defaultBranch = gitInDir(['rev-parse', '--abbrev-ref', 'HEAD'], tapDir);
      const formula = gitInDir(['show', `${defaultBranch}:Formula/varlock.rb`], bare);
      expect(formula).toContain('version "1.0.1"');
      expect(formula).toContain(`sha256 "${createHash('sha256').update(asset).digest('hex')}"`);
      expect(gitInDir(['tag', '-l', 'varlock@1.0.1'], bare)).toBe('varlock@1.0.1');
      expect(gitInDir(['log', '-1', '--format=%s', defaultBranch], bare)).toBe('varlock@1.0.1');
      // Re-run: formula unchanged → no new commit, still succeeds
      const before = gitInDir(['rev-parse', defaultBranch], bare);
      const again = await publishPackages(plan, packages, depGraph, DEFAULT_CONFIG, tmpDir, {});
      expect(again.failed).toHaveLength(0);
      expect(gitInDir(['rev-parse', defaultBranch], bare)).toBe(before);
      expect(await readFile(resolve(tapDir, 'Formula/varlock.rb'), 'utf-8')).toContain('version "1.0.1"');
    });
  });
});
