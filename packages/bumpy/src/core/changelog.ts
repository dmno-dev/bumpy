import { resolve } from 'node:path';
import { log } from '../utils/logger.ts';
import type { Changeset, PlannedRelease, BumpyConfig } from '../types.ts';

// ---- Formatter interface ----

export interface ChangelogContext {
  release: PlannedRelease;
  /** Changesets that contributed to this release */
  changesets: Changeset[];
  /** ISO date string (YYYY-MM-DD) */
  date: string;
}

/**
 * A changelog formatter receives full context and returns the complete
 * changelog entry string for a single release.
 */
export type ChangelogFormatter = (ctx: ChangelogContext) => string | Promise<string>;

// ---- Built-in formatters ----

/** Default formatter — version heading, date, bullet points */
export const defaultFormatter: ChangelogFormatter = (ctx) => {
  const { release, changesets, date } = ctx;
  const lines: string[] = [];
  lines.push(`## ${release.newVersion}`);
  lines.push('');
  lines.push(`_${date}_`);
  lines.push('');

  const relevantChangesets = changesets.filter((cs) => release.changesets.includes(cs.id));

  if (relevantChangesets.length > 0) {
    for (const cs of relevantChangesets) {
      if (cs.summary) {
        const summaryLines = cs.summary.split('\n');
        lines.push(`- ${summaryLines[0]}`);
        for (let i = 1; i < summaryLines.length; i++) {
          if (summaryLines[i]!.trim()) {
            lines.push(`  ${summaryLines[i]}`);
          }
        }
      }
    }
  }

  if (release.isDependencyBump && relevantChangesets.length === 0) {
    lines.push('- Updated dependencies');
  }

  if (release.isCascadeBump && !release.isDependencyBump && relevantChangesets.length === 0) {
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

  // Built-in formatter
  if (typeof name === 'string' && BUILTIN_FORMATTERS[name]) {
    const builtin = BUILTIN_FORMATTERS[name];
    if (typeof builtin === 'function' && builtin.length === 0) {
      // Lazy-loaded formatter factory (like github)
      return (builtin as () => Promise<ChangelogFormatter>)();
    }
    return builtin as ChangelogFormatter;
  }

  // Built-in with options (e.g., ["github", { repo: "..." }])
  if (name === 'github') {
    const { createGithubFormatter } = await import('./changelog-github.ts');
    return createGithubFormatter(options as import('./changelog-github.ts').GithubChangelogOptions);
  }

  // Custom module
  if (typeof name === 'string') {
    try {
      let modulePath: string;
      if (name.startsWith('.')) {
        // Relative path — resolve and verify it stays within the project root
        modulePath = resolve(rootDir, name);
        if (!modulePath.startsWith(rootDir + '/')) {
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
  changesets: Changeset[],
  formatter: ChangelogFormatter = defaultFormatter,
  date: string = new Date().toISOString().split('T')[0]!,
): Promise<string> {
  return formatter({ release, changesets, date });
}

/** Prepend a new entry to an existing CHANGELOG.md content */
export function prependToChangelog(existingContent: string, newEntry: string): string {
  // Try to find the first ## heading and insert before it
  const headerMatch = existingContent.match(/^# /m);
  if (headerMatch && headerMatch.index !== undefined) {
    // Find the first ## after the # header
    const afterTitle = existingContent.indexOf('\n##');
    if (afterTitle !== -1) {
      return existingContent.slice(0, afterTitle + 1) + '\n' + newEntry + existingContent.slice(afterTitle + 1);
    }
    // No existing entries, append after the title
    return existingContent.trimEnd() + '\n\n' + newEntry;
  }
  // No title found, create fresh
  return '# Changelog\n\n' + newEntry;
}
