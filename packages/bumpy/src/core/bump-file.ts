import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { readText, writeText, listFiles, removeFile } from '../utils/fs.ts';
import { getBumpyDir } from './config.ts';
import { tryRunArgs } from '../utils/shell.ts';
import type { BumpFile, BumpFileRelease, BumpFileReleaseCascade, BumpType, BumpTypeWithNone } from '../types.ts';

const VALID_BUMP_TYPES = new Set<string>(['major', 'minor', 'patch', 'none']);

/**
 * Reject package names that contain characters which could cause injection
 * when used in git tags, markdown, URLs, or shell-quoted strings.
 * Intentionally permissive — we don't enforce npm naming rules because
 * bumpy may be used with other registries or non-JS packages.
 */
function validatePackageName(name: string): boolean {
  if (!name || name.length > 214) return false;
  // disallow control chars
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  // disallow HTML/shell metacharacters and whitespace
  if (/[<>"'`&;|$(){}[\]\\!#%\s]/.test(name)) return false;
  // must not start with - (could be interpreted as a CLI flag)
  if (name.startsWith('-')) return false;
  return true;
}

export interface ReadBumpFilesResult {
  bumpFiles: BumpFile[];
  errors: string[];
}

/** Read all bump files from .bumpy/ directory, sorted by git creation order */
export async function readBumpFiles(rootDir: string): Promise<ReadBumpFilesResult> {
  const dir = getBumpyDir(rootDir);
  const files = await listFiles(dir, '.md');
  const bumpFiles: BumpFile[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file === 'README.md') continue;
    const result = await parseBumpFileFromPath(resolve(dir, file));
    if (result.bumpFile) bumpFiles.push(result.bumpFile);
    errors.push(...result.errors);
  }

  // Sort by the commit date when each bump file was first added to git.
  // Falls back to filename order for uncommitted bump files.
  const creationOrder = getBumpFileCreationOrder(rootDir);
  if (creationOrder.size > 0) {
    bumpFiles.sort((a, b) => {
      const aOrder = creationOrder.get(a.id) ?? Infinity;
      const bOrder = creationOrder.get(b.id) ?? Infinity;
      return aOrder - bOrder || a.id.localeCompare(b.id);
    });
  }

  return { bumpFiles, errors };
}

/**
 * Use `git log` to get the commit timestamp when each bump file was first added.
 * Returns a map of bump file ID → unix timestamp (seconds).
 */
function getBumpFileCreationOrder(rootDir: string): Map<string, number> {
  const order = new Map<string, number>();

  // git log with --diff-filter=A shows only commits that added files
  // --format="%at" gives unix timestamp, --name-only lists files
  const result = tryRunArgs(['git', 'log', '--diff-filter=A', '--format=%at', '--name-only', '--', '.bumpy/*.md'], {
    cwd: rootDir,
  });
  if (!result) return order;

  // Output format: timestamp line, then filename lines, then blank line, repeat
  let currentTimestamp = 0;
  for (const line of result.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) {
      currentTimestamp = parseInt(trimmed, 10);
    } else if (trimmed.startsWith('.bumpy/') && trimmed.endsWith('.md')) {
      const id = trimmed.replace(/^\.bumpy\//, '').replace(/\.md$/, '');
      // Only record the first (oldest) commit — git log is newest-first,
      // so later entries overwrite with earlier timestamps
      order.set(id, currentTimestamp);
    }
  }

  return order;
}

/** Parse a single bump file from disk */
export async function parseBumpFileFromPath(filePath: string): Promise<BumpFileParseResult> {
  const content = await readText(filePath);
  return parseBumpFile(content, fileToId(filePath));
}

export interface BumpFileParseResult {
  bumpFile: BumpFile | null;
  errors: string[];
}

/** Parse bump file content (for testing) */
export function parseBumpFile(content: string, id: string): BumpFileParseResult {
  const errors: string[] = [];
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    errors.push(`Bump file "${id}" has no valid frontmatter (expected --- delimiters)`);
    return { bumpFile: null, errors };
  }

  const frontmatter = match[1]!;
  const summary = match[2]!.trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(frontmatter) as Record<string, unknown>;
  } catch (e) {
    errors.push(`Bump file "${id}" has invalid YAML: ${e instanceof Error ? e.message : e}`);
    return { bumpFile: null, errors };
  }
  if (!parsed || typeof parsed !== 'object') {
    errors.push(`Bump file "${id}" has empty or invalid frontmatter`);
    return { bumpFile: null, errors };
  }

  const releases: BumpFileRelease[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!validatePackageName(name)) {
      errors.push(`Invalid package name "${name}" in bump file "${id}"`);
      continue;
    }

    if (typeof value === 'string') {
      if (!VALID_BUMP_TYPES.has(value)) {
        errors.push(
          `Unknown bump type "${value}" for "${name}" in bump file "${id}" (expected: major, minor, patch, or none)`,
        );
        continue;
      }
      // Simple format: "pkg-name": minor
      releases.push({ name, type: value as BumpTypeWithNone });
    } else if (value && typeof value === 'object') {
      // Nested format: "pkg-name": { bump: minor, cascade: { ... } }
      const obj = value as { bump: BumpTypeWithNone; cascade?: Record<string, BumpType> };
      if (!VALID_BUMP_TYPES.has(obj.bump)) {
        errors.push(
          `Unknown bump type "${obj.bump}" for "${name}" in bump file "${id}" (expected: major, minor, patch, or none)`,
        );
        continue;
      }
      const release: BumpFileReleaseCascade = {
        name,
        type: obj.bump,
        cascade: obj.cascade || {},
      };
      releases.push(release);
    } else {
      errors.push(`Invalid value for "${name}" in bump file "${id}" — expected a bump type string or object`);
    }
  }

  if (releases.length === 0 && errors.length === 0) {
    // Truly empty frontmatter with no errors — this is the "intentionally empty" case
    return { bumpFile: null, errors };
  }

  const bumpFile = releases.length > 0 ? { id, releases, summary } : null;
  return { bumpFile, errors };
}

/** Write a bump file */
export async function writeBumpFile(
  rootDir: string,
  filename: string,
  releases: BumpFileRelease[],
  summary: string,
): Promise<string> {
  const dir = getBumpyDir(rootDir);
  const filePath = resolve(dir, `${filename}.md`);

  // Build frontmatter object
  const frontmatter: Record<string, unknown> = {};
  for (const release of releases) {
    if ('cascade' in release && Object.keys(release.cascade).length > 0) {
      frontmatter[release.name] = { bump: release.type, cascade: release.cascade };
    } else {
      frontmatter[release.name] = release.type;
    }
  }

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1, quotingType: '"' }).trim();
  const content = `---\n${yamlStr}\n---\n\n${summary}\n`;
  await writeText(filePath, content);
  return filePath;
}

/** Delete consumed bump files */
export async function deleteBumpFiles(rootDir: string, ids: string[]): Promise<void> {
  const dir = getBumpyDir(rootDir);
  for (const id of ids) {
    await removeFile(resolve(dir, `${id}.md`));
  }
}

function fileToId(filePath: string): string {
  const base = filePath.split('/').pop()!;
  return base.replace(/\.md$/, '');
}

/**
 * Given a list of changed file paths (relative to root), extract the IDs
 * of bump files that were added/modified. Shared by `check` and `ci check`.
 */
export function extractBumpFileIdsFromChangedFiles(changedFiles: string[]): Set<string> {
  return new Set(
    changedFiles
      .filter((f) => /^\.bumpy\/.*\.md$/.test(f) && !f.endsWith('README.md'))
      .map((f) => f.replace(/^\.bumpy\//, '').replace(/\.md$/, '')),
  );
}

/**
 * Filter bump files to only those added/modified on the current branch.
 * Also detects empty bump files (no releases) that still exist on disk,
 * which signal intentionally no releases needed.
 *
 * When `parseErrors` is provided, a file that exists on disk but didn't parse
 * is only treated as an "empty bump file" if it produced no parse errors —
 * otherwise it's a broken file, not an intentionally empty one.
 */
export function filterBranchBumpFiles(
  allBumpFiles: BumpFile[],
  changedFiles: string[],
  rootDir?: string,
  parseErrors: string[] = [],
): { branchBumpFiles: BumpFile[]; branchBumpFileIds: Set<string>; hasEmptyBumpFile: boolean } {
  const branchBumpFileIds = extractBumpFileIdsFromChangedFiles(changedFiles);
  const branchBumpFiles = allBumpFiles.filter((bf) => branchBumpFileIds.has(bf.id));

  // Check if any changed bump file IDs that didn't parse still exist on disk (= empty bump file).
  // Deleted bump files (from other branches) should not count.
  // Files that produced parse errors are broken, not intentionally empty.
  let hasEmptyBumpFile = false;
  if (rootDir) {
    const parsedIds = new Set(branchBumpFiles.map((bf) => bf.id));
    const bumpyDir = getBumpyDir(rootDir);
    for (const id of branchBumpFileIds) {
      if (!parsedIds.has(id) && existsSync(resolve(bumpyDir, `${id}.md`))) {
        // Check if this file produced parse errors — if so, it's broken, not empty
        const hasErrors = parseErrors.some((e) => e.includes(`"${id}"`));
        if (!hasErrors) {
          hasEmptyBumpFile = true;
          break;
        }
      }
    }
  }

  return { branchBumpFiles, branchBumpFileIds, hasEmptyBumpFile };
}
