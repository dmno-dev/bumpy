import { tryRunArgs } from '../utils/shell.ts';
import type { ChangelogContext, ChangelogFormatter } from './changelog.ts';

export interface GithubChangelogOptions {
  /** "owner/repo" — auto-detected from gh CLI if not provided */
  repo?: string;
  /** Whether to include "Thanks @user" messages for contributors (default: true) */
  thankContributors?: boolean;
  /** GitHub usernames (without @) to skip "Thanks" messages for (e.g. internal team members) */
  internalAuthors?: string[];
}

/**
 * GitHub-enhanced changelog formatter.
 * Adds PR links, commit links, and contributor attribution when git/gh info is available.
 *
 * Usage in config:
 *   "changelog": "github"
 *   "changelog": ["github", { "repo": "dmno-dev/bumpy" }]
 *   "changelog": ["github", { "thankContributors": false }]
 *   "changelog": ["github", { "internalAuthors": ["theoephraim"] }]
 */
export function createGithubFormatter(options: GithubChangelogOptions = {}): ChangelogFormatter {
  const thankContributors = options.thankContributors ?? true;
  const internalAuthorsSet = new Set((options.internalAuthors ?? []).map((a) => a.toLowerCase()));

  return async (ctx: ChangelogContext) => {
    const { release, bumpFiles, date } = ctx;
    const repoSlug = options.repo ?? detectRepo();
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';

    const lines: string[] = [];
    lines.push(`## ${release.newVersion}`);
    lines.push('');
    lines.push(`_${date}_`);
    lines.push('');

    const relevantBumpFiles = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));

    if (relevantBumpFiles.length > 0) {
      for (const bf of relevantBumpFiles) {
        if (!bf.summary) continue;

        // Extract metadata overrides from summary (pr, commit, author lines)
        const { cleanSummary, overrides } = extractSummaryMeta(bf.summary);

        // Look up git/PR info, with overrides taking precedence
        const gitInfo = resolveBumpFileInfo(bf.id, repoSlug, serverUrl, overrides);

        const summaryLines = cleanSummary.split('\n');
        const firstLine = linkifyIssueRefs(summaryLines[0]!, serverUrl, repoSlug);

        // Build the prefix: PR link, commit link, thanks
        const prefix = formatPrefix(gitInfo, serverUrl, repoSlug, thankContributors, internalAuthorsSet);

        lines.push(`-${prefix ? ` ${prefix} -` : ''} ${firstLine}`);

        // Include continuation lines
        for (let i = 1; i < summaryLines.length; i++) {
          if (summaryLines[i]!.trim()) {
            lines.push(`  ${linkifyIssueRefs(summaryLines[i]!, serverUrl, repoSlug)}`);
          }
        }
      }
    }

    if (release.isDependencyBump && relevantBumpFiles.length === 0) {
      lines.push('- Updated dependencies');
    }

    if (release.isCascadeBump && !release.isDependencyBump && relevantBumpFiles.length === 0) {
      lines.push('- Version bump via cascade rule');
    }

    lines.push('');
    return lines.join('\n');
  };
}

// ---- Types ----

interface BumpFileGitInfo {
  prNumber?: number;
  prUrl?: string;
  commitHash?: string;
  author?: string;
}

interface SummaryOverrides {
  pr?: number;
  commit?: string;
  authors?: string[];
}

// ---- Metadata extraction from bump file summary ----

/**
 * Extract metadata lines (pr, commit, author) from a bump file summary.
 * These override git-derived info, matching the behavior of @changesets/changelog-github.
 */
function extractSummaryMeta(summary: string): { cleanSummary: string; overrides: SummaryOverrides } {
  const overrides: SummaryOverrides = {};

  const cleaned = summary
    .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, (_, pr) => {
      const num = Number(pr);
      if (!isNaN(num)) overrides.pr = num;
      return '';
    })
    .replace(/^\s*commit:\s*([^\s]+)/im, (_, commit) => {
      overrides.commit = commit;
      return '';
    })
    .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, (_, user) => {
      overrides.authors ??= [];
      overrides.authors.push(user);
      return '';
    })
    .trim();

  return { cleanSummary: cleaned, overrides };
}

// ---- Git/PR info resolution ----

/**
 * Resolve PR, commit, and author info for a bump file.
 * Summary overrides take precedence over git-derived info.
 */
function resolveBumpFileInfo(
  bumpFileId: string,
  repo: string | undefined,
  serverUrl: string,
  overrides: SummaryOverrides,
): BumpFileGitInfo {
  // If we have a PR override, look it up directly
  if (overrides.pr !== undefined) {
    const prInfo = lookupPr(overrides.pr, repo);
    return {
      prNumber: overrides.pr,
      prUrl: prInfo?.url ?? `${serverUrl}/${repo}/pull/${overrides.pr}`,
      commitHash: overrides.commit ?? prInfo?.commitHash,
      author: overrides.authors?.[0] ?? prInfo?.author,
    };
  }

  // Otherwise, find the commit that added this bump file
  const gitInfo = findBumpFileCommitInfo(bumpFileId, repo);

  return {
    prNumber: gitInfo?.prNumber,
    prUrl: gitInfo?.prUrl,
    commitHash: overrides.commit ?? gitInfo?.commitHash,
    author: overrides.authors?.[0] ?? gitInfo?.author,
  };
}

/** Look up a PR by number using gh CLI */
function lookupPr(prNumber: number, repo?: string): { url: string; author?: string; commitHash?: string } | null {
  try {
    const ghArgs = ['gh', 'pr', 'view', String(prNumber), '--json', 'url,author,mergeCommit'];
    if (repo) ghArgs.push('--repo', repo);

    const result = tryRunArgs(ghArgs);
    if (!result) return null;

    const pr = JSON.parse(result);
    return {
      url: pr.url,
      author: pr.author?.login,
      commitHash: pr.mergeCommit?.oid,
    };
  } catch {
    return null;
  }
}

/**
 * Find the PR that introduced a bump file by checking git log
 * for the commit that added the file, then looking up the PR.
 */
function findBumpFileCommitInfo(bumpFileId: string, repo?: string): BumpFileGitInfo | null {
  try {
    // Find the commit that added this bump file
    const commitOutput = tryRunArgs([
      'git',
      'log',
      '--diff-filter=A',
      '--format=%H',
      '--',
      `.bumpy/${bumpFileId}.md`,
      `.changeset/${bumpFileId}.md`,
    ]);
    if (!commitOutput) return null;

    const commitHash = commitOutput.split('\n')[0]!.trim();
    if (!commitHash) return null;

    // Look up the PR for this commit
    const ghArgs = [
      'gh',
      'pr',
      'list',
      '--search',
      commitHash,
      '--state',
      'merged',
      '--json',
      'number,url,author',
      '--jq',
      '.[0]',
    ];
    if (repo) ghArgs.push('--repo', repo);

    const prJson = tryRunArgs(ghArgs);
    if (!prJson) {
      return { commitHash };
    }

    const pr = JSON.parse(prJson);
    if (!pr.number) {
      return { commitHash };
    }

    return {
      prNumber: pr.number,
      prUrl: pr.url,
      commitHash,
      author: pr.author?.login,
    };
  } catch {
    return null;
  }
}

// ---- Formatting helpers ----

/**
 * Build the prefix portion of a changelog line: PR link, commit link, thanks.
 * Matches the format used by @changesets/changelog-github.
 */
function formatPrefix(
  info: BumpFileGitInfo,
  serverUrl: string,
  repo: string | undefined,
  thankContributors: boolean,
  internalAuthors: Set<string>,
): string {
  const parts: string[] = [];

  if (info.prNumber && info.prUrl) {
    parts.push(`[#${info.prNumber}](${info.prUrl})`);
  }

  if (info.commitHash && repo) {
    const short = info.commitHash.slice(0, 7);
    parts.push(`[\`${short}\`](${serverUrl}/${repo}/commit/${info.commitHash})`);
  }

  if (thankContributors && info.author && !internalAuthors.has(info.author.toLowerCase())) {
    parts.push(`Thanks [@${info.author}](${serverUrl}/${info.author})!`);
  }

  return parts.join(' ');
}

/**
 * Linkify bare issue/PR references like #123 in text,
 * but skip references already inside markdown links.
 */
function linkifyIssueRefs(line: string, serverUrl: string, repo?: string): string {
  if (!repo) return line;
  // "match what you skip, capture what you want" pattern:
  // the left alternative consumes markdown links so the right alternative only matches bare refs
  return line.replace(/\[.*?\]\(.*?\)|\B#([1-9]\d*)\b/g, (match, issue) =>
    issue ? `[#${issue}](${serverUrl}/${repo}/issues/${issue})` : match,
  );
}

/** Try to detect the repo slug from the gh CLI */
function detectRepo(): string | undefined {
  try {
    const result = tryRunArgs(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    return result?.trim() || undefined;
  } catch {
    return undefined;
  }
}
