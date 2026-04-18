/**
 * Shared test helpers for bumpy tests.
 * Provides factory functions and utilities to reduce duplication across test files.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { WorkspacePackage, PlannedRelease, BumpType, BumpyConfig, Changeset, ReleasePlan } from '../src/types.ts';
import { DEFAULT_CONFIG } from '../src/types.ts';

// ---- Factory functions ----

/** Create a WorkspacePackage for testing (no real filesystem needed) */
export function makePkg(
  name: string,
  version: string,
  deps: Partial<
    Pick<
      WorkspacePackage,
      'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' | 'bumpy' | 'private'
    >
  > & { dir?: string } = {},
): WorkspacePackage {
  return {
    name,
    version,
    dir: deps.dir ?? `/fake/${name}`,
    relativeDir: `packages/${name}`,
    packageJson: { name, version },
    private: deps.private ?? false,
    dependencies: deps.dependencies ?? {},
    devDependencies: deps.devDependencies ?? {},
    peerDependencies: deps.peerDependencies ?? {},
    optionalDependencies: deps.optionalDependencies ?? {},
    bumpy: deps.bumpy,
  };
}

/** Create a BumpyConfig with overrides */
export function makeConfig(overrides: Partial<BumpyConfig> = {}): BumpyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Create a PlannedRelease for testing */
export function makeRelease(
  name: string,
  newVersion: string,
  opts: Partial<Pick<PlannedRelease, 'type' | 'oldVersion' | 'changesets' | 'isDependencyBump' | 'isCascadeBump'>> = {},
): PlannedRelease {
  return {
    name,
    type: opts.type ?? 'patch',
    oldVersion: opts.oldVersion ?? '0.0.0',
    newVersion,
    changesets: opts.changesets ?? [],
    isDependencyBump: opts.isDependencyBump ?? false,
    isCascadeBump: opts.isCascadeBump ?? false,
  };
}

/** Create a Changeset for testing */
export function makeChangeset(
  id: string,
  releases: { name: string; type: BumpType }[],
  summary = 'Test change',
): Changeset {
  return { id, releases, summary };
}

/** Create a ReleasePlan for testing */
export function makeReleasePlan(releases: PlannedRelease[], changesets: Changeset[] = []): ReleasePlan {
  return { releases, changesets, warnings: [] };
}

// ---- Temp git repo helpers ----

/** Create a temp directory and initialize a git repo in it */
export async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'bumpy-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Remove a temp directory */
export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true });
}

/** Run a git command in a directory (for test setup only) */
export function gitInDir(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}
