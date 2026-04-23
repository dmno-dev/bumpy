import { resolve, relative } from 'node:path';
import { realpathSync } from 'node:fs';
import { log } from '../utils/logger.ts';
import type { BumpFile, BumpType, PlannedRelease, BumpyConfig } from '../types.ts';
import { BUMP_LEVELS } from '../types.ts';

// ---- Formatter interface ----

export interface ChangelogContext {
  release: PlannedRelease;
  /** Bump files that contributed to this release */
  bumpFiles: BumpFile[];
  /** ISO date string (YYYY-MM-DD) */
  date: string;
}

/**
 * A changelog formatter receives full context and returns the complete
 * changelog entry string for a single release.
 */
export type ChangelogFormatter = (ctx: ChangelogContext) => string | Promise<string>;

// ---- Bump type helpers ----

/** Get the bump type a bump file applies to a specific package */
export function getBumpTypeForPackage(bf: BumpFile, packageName: string): BumpType {
  const rel = bf.releases.find((r) => r.name === packageName);
  return rel?.type === 'none' ? 'patch' : (rel?.type ?? 'patch');
}

/** Sort bump files by bump type for a specific package (major → minor → patch) */
export function sortBumpFilesByType(bumpFiles: BumpFile[], packageName: string): BumpFile[] {
  return [...bumpFiles].sort((a, b) => {
    const aLevel = BUMP_LEVELS[getBumpTypeForPackage(a, packageName)];
    const bLevel = BUMP_LEVELS[getBumpTypeForPackage(b, packageName)];
    return bLevel - aLevel;
  });
}

// ---- Built-in formatters ----

/** Default formatter — version heading with date, bullet points sorted by bump type */
export const defaultFormatter: ChangelogFormatter = (ctx) => {
  const { release, bumpFiles, date } = ctx;
  const lines: string[] = [];
  lines.push(`## ${release.newVersion}`);
  lines.push(`<sub>${date}</sub>`);
  lines.push('');

  const relevantBumpFiles = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));
  const sorted = sortBumpFilesByType(relevantBumpFiles, release.name);

  for (const bf of sorted) {
    if (!bf.summary) continue;
    const type = getBumpTypeForPackage(bf, release.name);
    const tag = type !== release.type ? `*(${type})* ` : '';
    const summaryLines = bf.summary.split('\n');
    lines.push(`- ${tag}${summaryLines[0]}`);
    for (let i = 1; i < summaryLines.length; i++) {
      if (summaryLines[i]!.trim()) {
        lines.push(`  ${summaryLines[i]}`);
      }
    }
  }

  if (release.isDependencyBump) {
    const tag = release.type !== 'patch' ? `*(patch)* ` : '';
    lines.push(`- ${tag}Updated dependencies`);
  }

  if (release.isCascadeBump && !release.isDependencyBump && relevantBumpFiles.length === 0) {
    lines.push('- Version bump via cascade rule');
  }

  lines.push('');
  return lines.join('\n');
};

// ---- Formatter loading ----

const BUILTIN_FORMATTERS: Record<string, ChangelogFormatter | (() => Promise<ChangelogFormatter>)> = {
  default: defaultFormatter,
  github: async () => {
    const { createGithubFormatter } = await import('./changelog-github.ts');
    return createGithubFormatter();
  },
};

/**
 * Load a changelog formatter from config.
 * Supports: "default", "./path/to/formatter.ts", or a module name.
 */
export async function loadFormatter(changelog: BumpyConfig['changelog'], rootDir: string): Promise<ChangelogFormatter> {
  const [name, options] = Array.isArray(changelog) ? changelog : [changelog, {}];

  // Built-in with options (e.g., ["github", { repo: "..." }])
  if (name === 'github') {
    const { createGithubFormatter } = await import('./changelog-github.ts');
    return createGithubFormatter(options as import('./changelog-github.ts').GithubChangelogOptions);
  }

  // Built-in formatter (no options)
  if (typeof name === 'string' && BUILTIN_FORMATTERS[name]) {
    const builtin = BUILTIN_FORMATTERS[name];
    if (typeof builtin === 'function' && builtin.length === 0) {
      // Lazy-loaded formatter factory (like github)
      return (builtin as () => Promise<ChangelogFormatter>)();
    }
    return builtin as ChangelogFormatter;
  }

  // Custom module
  if (typeof name === 'string') {
    try {
      let modulePath: string;
      if (name.startsWith('.')) {
        // Relative path — resolve symlinks and verify it stays within the project root
        modulePath = resolve(rootDir, name);
        try {
          modulePath = realpathSync(modulePath);
        } catch {
          // File doesn't exist yet — use the resolved path as-is
        }
        const rel = relative(realpathSync(rootDir), modulePath);
        if (rel.startsWith('..') || resolve('/', rel) === resolve('/')) {
          throw new Error(`Changelog formatter path "${name}" resolves outside the project root`);
        }
      } else {
        // Bare module specifier (e.g. npm package name)
        modulePath = name;
      }
      const mod = await import(modulePath);
      // Support: export default fn, export const changelogFormatter = fn, or module is fn
      const exported = mod.default || mod.changelogFormatter;
      if (typeof exported === 'function') {
        // If it takes options, call it as a factory; otherwise use it directly
        // Heuristic: if the function returns a function, it's a factory
        const result = exported(options);
        if (typeof result === 'function') return result;
        // If it returned a string/promise, it IS the formatter
        return exported;
      }
      throw new Error(`Changelog module "${name}" does not export a function`);
    } catch (err) {
      log.warn(`Failed to load changelog formatter "${name}": ${err instanceof Error ? err.message : err}`);
      log.warn('Falling back to default formatter');
      return defaultFormatter;
    }
  }

  return defaultFormatter;
}

// ---- Public API ----

/** Generate a changelog entry using the configured formatter */
export async function generateChangelogEntry(
  release: PlannedRelease,
  bumpFiles: BumpFile[],
  formatter: ChangelogFormatter = defaultFormatter,
  date: string = new Date().toISOString().split('T')[0]!,
): Promise<string> {
  return formatter({ release, bumpFiles, date });
}

/** Prepend a new entry to an existing CHANGELOG.md content */
export function prependToChangelog(existingContent: string, newEntry: string): string {
  // Try to find the first ## heading and insert before it
  const headerMatch = existingContent.match(/^# /m);
  if (headerMatch && headerMatch.index !== undefined) {
    // Find the first ## after the # header
    const afterTitle = existingContent.indexOf('\n##');
    if (afterTitle !== -1) {
      return existingContent.slice(0, afterTitle + 1) + '\n' + newEntry + '\n' + existingContent.slice(afterTitle + 1);
    }
    // No existing entries, append after the title
    return existingContent.trimEnd() + '\n\n' + newEntry;
  }
  // No title found, create fresh
  return '# Changelog\n\n' + newEntry;
}
