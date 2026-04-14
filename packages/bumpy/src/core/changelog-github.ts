import { tryRun } from '../utils/shell.ts';
import type { ChangelogContext, ChangelogFormatter } from './changelog.ts';

interface GithubOptions {
  repo?: string; // "owner/repo" — auto-detected if not provided
}

/**
 * GitHub-enhanced changelog formatter.
 * Adds PR links and author attribution when git/gh info is available.
 *
 * Usage in config:
 *   "changelog": "github"
 *   "changelog": ["github", { "repo": "dmno-dev/bumpy" }]
 */
export function createGithubFormatter(options: GithubOptions = {}): ChangelogFormatter {
  return async (ctx: ChangelogContext) => {
    const { release, changesets, date } = ctx;
    const lines: string[] = [];
    lines.push(`## ${release.newVersion}`);
    lines.push('');
    lines.push(`_${date}_`);
    lines.push('');

    const relevantChangesets = changesets.filter((cs) => release.changesets.includes(cs.id));

    if (relevantChangesets.length > 0) {
      for (const cs of relevantChangesets) {
        if (!cs.summary) continue;
        const firstLine = cs.summary.split('\n')[0]!;

        // Try to find a PR associated with this changeset
        const prInfo = await findPrForChangeset(cs.id, options.repo);
        if (prInfo) {
          lines.push(`- ${firstLine} ([#${prInfo.number}](${prInfo.url})) by @${prInfo.author}`);
        } else {
          lines.push(`- ${firstLine}`);
        }

        // Include continuation lines
        const summaryLines = cs.summary.split('\n');
        for (let i = 1; i < summaryLines.length; i++) {
          if (summaryLines[i]!.trim()) {
            lines.push(`  ${summaryLines[i]}`);
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
}

interface PrInfo {
  number: number;
  url: string;
  author: string;
}

/**
 * Find the PR that introduced a changeset file by checking git log
 * for the commit that added the file, then looking up the PR.
 */
async function findPrForChangeset(changesetId: string, repo?: string): Promise<PrInfo | null> {
  try {
    // Find the commit that added this changeset file
    const commitHash = tryRun(
      `git log --diff-filter=A --format="%H" -- ".bumpy/${changesetId}.md" ".changeset/${changesetId}.md"`,
    );
    if (!commitHash) return null;

    const hash = commitHash.split('\n')[0]!.trim();
    if (!hash) return null;

    // Look up the PR for this commit
    const repoFlag = repo ? `--repo ${repo}` : '';
    const prJson = tryRun(
      `gh pr list --search "${hash}" --state merged --json number,url,author --jq ".[0]" ${repoFlag}`,
    );
    if (!prJson) return null;

    const pr = JSON.parse(prJson);
    if (!pr.number) return null;

    return {
      number: pr.number,
      url: pr.url,
      author: pr.author?.login || 'unknown',
    };
  } catch {
    return null;
  }
}
