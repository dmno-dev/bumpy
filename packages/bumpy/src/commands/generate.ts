import { relative } from 'node:path';
import { log, colorize } from '../utils/logger.ts';
import { tryRunArgs } from '../utils/shell.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { writeBumpFile } from '../core/bump-file.ts';
import { getBumpyDir } from '../core/config.ts';
import { ensureDir } from '../utils/fs.ts';
import { slugify, randomName } from '../utils/names.ts';
import { getBranchCommits, getFilesChangedInCommit } from '../core/git.ts';
import type { BumpType, BumpTypeWithNone, BumpyConfig, BumpFileRelease, WorkspacePackage } from '../types.ts';

interface GenerateOptions {
  from?: string; // git ref to start from (default: branch base)
  dryRun?: boolean;
  name?: string;
}

interface ConventionalCommit {
  hash: string;
  type: string; // feat, fix, chore, etc.
  scope: string | null;
  breaking: boolean;
  description: string;
  body: string;
}

const BUMP_MAP: Record<string, BumpType> = {
  feat: 'minor',
  fix: 'patch',
  perf: 'patch',
  refactor: 'patch',
  docs: 'patch',
  style: 'patch',
  test: 'patch',
  build: 'patch',
  ci: 'patch',
  chore: 'patch',
};

export async function generateCommand(rootDir: string, opts: GenerateOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const packages = await discoverPackages(rootDir, config);

  // Get commits — either from explicit ref or from branch divergence point
  let commits: { hash: string; subject: string; body: string }[];

  if (opts.from) {
    log.step(`Scanning commits from ${colorize(opts.from, 'cyan')}...`);
    const rawLog = tryRunArgs(['git', 'log', `${opts.from}..HEAD`, '--format=%H%n%s%n%b%n---END---'], { cwd: rootDir });
    if (!rawLog) {
      log.info('No commits found since ' + opts.from);
      return;
    }
    commits = parseGitLog(rawLog);
  } else {
    log.step(`Scanning commits on this branch (vs ${colorize(config.baseBranch, 'cyan')})...`);
    commits = getBranchCommits(rootDir, config.baseBranch);
  }

  if (commits.length === 0) {
    log.info('No commits found on this branch.');
    return;
  }

  log.dim(`  Found ${commits.length} commit(s)`);

  // Build scope → package name mapping for CC resolution
  const scopeMap = buildScopeMap(packages, config);

  // Collect releases from all commits
  const releaseMap = new Map<string, { type: BumpType; messages: string[] }>();

  let ccCount = 0;
  let fileBasedCount = 0;

  for (const commit of commits) {
    const cc = parseConventionalCommit(commit);

    if (cc) {
      // Conventional commit — use type/scope for bump level
      ccCount++;
      const bump: BumpType = cc.breaking ? 'major' : BUMP_MAP[cc.type] || 'patch';

      let pkgNames: string[] = [];
      if (cc.scope) {
        const resolved = resolveScope(cc.scope, scopeMap, packages);
        if (resolved.length > 0) {
          pkgNames = resolved;
        }
        // If scope didn't resolve, fall through to file-based detection below
      }

      if (pkgNames.length > 0) {
        for (const name of pkgNames) {
          mergeRelease(releaseMap, name, bump, cc.description);
        }
        continue;
      }

      // CC commit but scope didn't resolve (or no scope) — use file-based detection
      // with the CC-derived bump level
      const files = getFilesChangedInCommit(commit.hash, { cwd: rootDir });
      const touchedPkgs = mapFilesToPackages(files, packages, rootDir);

      if (touchedPkgs.length > 0) {
        for (const name of touchedPkgs) {
          mergeRelease(releaseMap, name, bump, cc.description);
        }
      } else {
        log.dim(`  Skipping CC (no matching packages): ${cc.type}: ${cc.description}`);
      }
    } else {
      // Non-conventional commit — use file paths to detect packages, default to patch
      const files = getFilesChangedInCommit(commit.hash, { cwd: rootDir });
      const touchedPkgs = mapFilesToPackages(files, packages, rootDir);

      if (touchedPkgs.length > 0) {
        fileBasedCount++;
        for (const name of touchedPkgs) {
          mergeRelease(releaseMap, name, 'patch', commit.subject);
        }
      } else {
        log.dim(`  Skipping (no matching packages): ${commit.subject}`);
      }
    }
  }

  if (ccCount > 0) log.dim(`  ${ccCount} conventional commit(s)`);
  if (fileBasedCount > 0) log.dim(`  ${fileBasedCount} commit(s) detected via changed files`);

  if (releaseMap.size === 0) {
    log.info('No package bumps detected from commits.');
    return;
  }

  // Build releases and summary
  const releases: BumpFileRelease[] = [];
  const summaryLines: string[] = [];

  for (const [name, info] of releaseMap) {
    releases.push({ name, type: info.type as BumpTypeWithNone });
    for (const msg of info.messages) {
      summaryLines.push(`- ${name}: ${msg}`);
    }
  }

  if (opts.dryRun) {
    log.bold('Would create bump file:');
    for (const r of releases) {
      console.log(
        `  ${r.name}: ${colorize(r.type, r.type === 'major' ? 'red' : r.type === 'minor' ? 'yellow' : 'green')}`,
      );
    }
    console.log();
    log.dim('Summary:');
    for (const line of summaryLines) {
      log.dim(`  ${line}`);
    }
    return;
  }

  // Write the bump file
  await ensureDir(getBumpyDir(rootDir));
  const filename = opts.name ? slugify(opts.name) : randomName();
  const summary = summaryLines.join('\n');
  await writeBumpFile(rootDir, filename, releases, summary);

  log.success(`🐸 Created bump file: .bumpy/${filename}.md`);
  for (const r of releases) {
    log.dim(`  ${r.name}: ${r.type}`);
  }
}

/** Merge a bump into the release map, keeping the highest bump level */
function mergeRelease(
  releaseMap: Map<string, { type: BumpType; messages: string[] }>,
  name: string,
  bump: BumpType,
  message: string,
): void {
  const existing = releaseMap.get(name);
  if (existing) {
    if (bumpPriority(bump) > bumpPriority(existing.type)) {
      existing.type = bump;
    }
    existing.messages.push(message);
  } else {
    releaseMap.set(name, { type: bump, messages: [message] });
  }
}

/** Map file paths to package names based on directory containment */
function mapFilesToPackages(files: string[], packages: Map<string, WorkspacePackage>, rootDir: string): string[] {
  const matched = new Set<string>();
  for (const file of files) {
    for (const [name, pkg] of packages) {
      const pkgRelDir = relative(rootDir, pkg.dir);
      if (file.startsWith(pkgRelDir + '/')) {
        matched.add(name);
      }
    }
  }
  return [...matched];
}

/** Parse raw git log output into individual commits */
function parseGitLog(raw: string): { hash: string; subject: string; body: string }[] {
  const commits: { hash: string; subject: string; body: string }[] = [];
  const entries = raw.split('---END---').filter((e) => e.trim());

  for (const entry of entries) {
    const lines = entry.trim().split('\n');
    if (lines.length < 2) continue;
    commits.push({
      hash: lines[0]!.trim(),
      subject: lines[1]!.trim(),
      body: lines.slice(2).join('\n').trim(),
    });
  }
  return commits;
}

/** Parse a commit subject into conventional commit format */
function parseConventionalCommit(commit: { hash: string; subject: string; body: string }): ConventionalCommit | null {
  // Match: type(scope)!: description  OR  type!(scope): description  OR  type!: description
  const match = commit.subject.match(/^(\w+)(!)?(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/);
  if (!match) return null;

  const [, type, bang1, scope, bang2, description] = match;
  const breaking = !!bang1 || !!bang2 || commit.body.includes('BREAKING CHANGE');

  return {
    hash: commit.hash,
    type: type!.toLowerCase(),
    scope: scope || null,
    breaking,
    description: description!.trim(),
    body: commit.body,
  };
}

/** Build a map of scope aliases → package names from config and package names */
function buildScopeMap(packages: Map<string, WorkspacePackage>, _config: BumpyConfig): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const [name, pkg] of packages) {
    // Use the last segment of the package name as a scope alias
    // e.g., @myorg/core → "core", my-pkg → "my-pkg"
    const shortName = name.includes('/') ? name.split('/').pop()! : name;
    if (!map.has(shortName)) map.set(shortName, []);
    map.get(shortName)!.push(name);

    // Also register the full name
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(name);

    // Use the directory name as an alias too
    const dirName = pkg.relativeDir.split('/').pop()!;
    if (dirName !== shortName) {
      if (!map.has(dirName)) map.set(dirName, []);
      map.get(dirName)!.push(name);
    }
  }

  return map;
}

/** Resolve a scope string to package name(s) */
function resolveScope(
  scope: string,
  scopeMap: Map<string, string[]>,
  packages: Map<string, WorkspacePackage>,
): string[] {
  // Exact match in scope map
  const mapped = scopeMap.get(scope);
  if (mapped) return [...new Set(mapped)];

  // Try case-insensitive
  for (const [key, value] of scopeMap) {
    if (key.toLowerCase() === scope.toLowerCase()) return [...new Set(value)];
  }

  // Direct package name match
  if (packages.has(scope)) return [scope];

  return [];
}

function bumpPriority(type: BumpType): number {
  return type === 'major' ? 2 : type === 'minor' ? 1 : 0;
}
