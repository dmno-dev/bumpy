import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { readText, writeText, listFiles, removeFile } from '../utils/fs.ts';
import { getBumpyDir } from './config.ts';
import { tryRunArgs } from '../utils/shell.ts';
import type { BumpFile, BumpFileRelease, BumpFileReleaseCascade, BumpType, BumpTypeWithNone } from '../types.ts';
import { log } from '../utils/logger.ts';

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

/** Read all bump files from .bumpy/ directory, sorted by git creation order */
export async function readBumpFiles(rootDir: string): Promise<BumpFile[]> {
  const dir = getBumpyDir(rootDir);
  const files = await listFiles(dir, '.md');
  const bumpFiles: BumpFile[] = [];
  for (const file of files) {
    if (file === 'README.md') continue;
    const bf = await parseBumpFileFromPath(resolve(dir, file));
    if (bf) bumpFiles.push(bf);
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

  return bumpFiles;
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
export async function parseBumpFileFromPath(filePath: string): Promise<BumpFile | null> {
  const content = await readText(filePath);
  return parseBumpFile(content, fileToId(filePath));
}

/** Parse bump file content (for testing) */
export function parseBumpFile(content: string, id: string): BumpFile | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const summary = match[2]!.trim();

  const parsed = yaml.load(frontmatter) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return null;

  const releases: BumpFileRelease[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!validatePackageName(name)) {
      log.warn(`Skipping invalid package name in bump file "${id}": ${name}`);
      continue;
    }

    if (typeof value === 'string') {
      if (!VALID_BUMP_TYPES.has(value)) {
        log.warn(`Skipping unknown bump type "${value}" for ${name} in bump file "${id}"`);
        continue;
      }
      // Simple format: "pkg-name": minor
      releases.push({ name, type: value as BumpTypeWithNone });
    } else if (value && typeof value === 'object') {
      // Nested format: "pkg-name": { bump: minor, cascade: { ... } }
      const obj = value as { bump: BumpTypeWithNone; cascade?: Record<string, BumpType> };
      if (!VALID_BUMP_TYPES.has(obj.bump)) {
        log.warn(`Skipping unknown bump type "${obj.bump}" for ${name} in bump file "${id}"`);
        continue;
      }
      const release: BumpFileReleaseCascade = {
        name,
        type: obj.bump,
        cascade: obj.cascade || {},
      };
      releases.push(release);
    }
  }

  if (releases.length === 0) return null;
  return { id, releases, summary };
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
 * Returns the filtered bump files and whether any changed bump file was
 * empty (has no releases — signals intentionally no releases needed).
 */
export function filterBranchBumpFiles(
  allBumpFiles: BumpFile[],
  changedFiles: string[],
): { branchBumpFiles: BumpFile[]; branchBumpFileIds: Set<string> } {
  const branchBumpFileIds = extractBumpFileIdsFromChangedFiles(changedFiles);
  const branchBumpFiles = allBumpFiles.filter((bf) => branchBumpFileIds.has(bf.id));
  return { branchBumpFiles, branchBumpFileIds };
}
