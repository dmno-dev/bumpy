import { log, colorize } from '../utils/logger.ts';
import { tryRunArgs } from '../utils/shell.ts';
import { loadConfig } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { writeBumpFile } from '../core/bump-file.ts';
import { getBumpyDir } from '../core/config.ts';
import { ensureDir } from '../utils/fs.ts';
import { slugify, randomName } from '../utils/names.ts';
import type { BumpType, BumpTypeWithNone, BumpyConfig, BumpFileRelease, WorkspacePackage } from '../types.ts';

interface GenerateOptions {
  from?: string; // git ref to start from (default: auto-detect last version tag)
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

  // Determine the starting ref
  const from = opts.from || findLastVersionTag(rootDir);
  if (!from) {
    log.error('Could not detect last version tag. Use --from <ref> to specify.');
    process.exit(1);
  }

  log.step(`Scanning commits from ${colorize(from, 'cyan')}...`);

  // Get commits since ref
  const rawLog = tryRunArgs(['git', 'log', `${from}..HEAD`, '--format=%H%n%s%n%b%n---END---'], { cwd: rootDir });

  if (!rawLog) {
    log.info('No commits found since ' + from);
    return;
  }

  const commits = parseGitLog(rawLog);
  const conventional = commits.map(parseConventionalCommit).filter((c): c is ConventionalCommit => c !== null);

  if (conventional.length === 0) {
    log.info('No conventional commits found. Commits must follow the format: type(scope): description');
    return;
  }

  log.dim(`  Found ${conventional.length} conventional commit(s)`);

  // Build scope → package name mapping
  const scopeMap = buildScopeMap(packages, config);

  // Collect releases
  const releaseMap = new Map<string, { type: BumpType; messages: string[] }>();

  for (const commit of conventional) {
    const bump: BumpType = commit.breaking ? 'major' : BUMP_MAP[commit.type] || 'patch';

    // Resolve scope to package name
    let pkgNames: string[] = [];
    if (commit.scope) {
      const resolved = resolveScope(commit.scope, scopeMap, packages);
      if (resolved.length > 0) {
        pkgNames = resolved;
      } else {
        log.dim(`  Skipping: unknown scope "${commit.scope}" in: ${commit.description}`);
        continue;
      }
    } else {
      // No scope — skip (we're doing scope-based only for now)
      log.dim(`  Skipping (no scope): ${commit.type}: ${commit.description}`);
      continue;
    }

    for (const name of pkgNames) {
      const existing = releaseMap.get(name);
      if (existing) {
        // Upgrade bump if higher
        if (bumpPriority(bump) > bumpPriority(existing.type)) {
          existing.type = bump;
        }
        existing.messages.push(commit.description);
      } else {
        releaseMap.set(name, { type: bump, messages: [commit.description] });
      }
    }
  }

  if (releaseMap.size === 0) {
    log.info('No package bumps detected from conventional commits.');
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

  log.success(`Created bump file: .bumpy/${filename}.md`);
  for (const r of releases) {
    log.dim(`  ${r.name}: ${r.type}`);
  }
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

/** Find the most recent version tag in the repo */
function findLastVersionTag(rootDir: string): string | null {
  // Look for tags matching common patterns: v1.2.3, pkg@1.2.3, etc.
  const tag =
    tryRunArgs(['git', 'describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: rootDir }) ||
    tryRunArgs(['git', 'describe', '--tags', '--abbrev=0', '--match', '*@*'], { cwd: rootDir });
  return tag || null;
}
