import type { Changeset, PlannedRelease } from "../types.ts";

/** Generate a changelog entry for a single package release */
export function generateChangelogEntry(
  release: PlannedRelease,
  changesets: Changeset[],
  date: string = new Date().toISOString().split("T")[0]!,
): string {
  const lines: string[] = [];
  lines.push(`## ${release.newVersion}`);
  lines.push("");
  lines.push(`_${date}_`);
  lines.push("");

  // Group changeset summaries
  const relevantChangesets = changesets.filter((cs) =>
    release.changesets.includes(cs.id)
  );

  if (relevantChangesets.length > 0) {
    for (const cs of relevantChangesets) {
      if (cs.summary) {
        // If summary is multi-line, indent continuation lines
        const summaryLines = cs.summary.split("\n");
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
    lines.push("- Updated dependencies");
  }

  if (release.isCascadeBump && !release.isDependencyBump && relevantChangesets.length === 0) {
    lines.push("- Version bump via cascade rule");
  }

  lines.push("");
  return lines.join("\n");
}

/** Prepend a new entry to an existing CHANGELOG.md content */
export function prependToChangelog(existingContent: string, newEntry: string): string {
  // Try to find the first ## heading and insert before it
  const headerMatch = existingContent.match(/^# /m);
  if (headerMatch && headerMatch.index !== undefined) {
    // Find the first ## after the # header
    const afterTitle = existingContent.indexOf("\n##");
    if (afterTitle !== -1) {
      return (
        existingContent.slice(0, afterTitle + 1) +
        "\n" +
        newEntry +
        existingContent.slice(afterTitle + 1)
      );
    }
    // No existing entries, append after the title
    return existingContent.trimEnd() + "\n\n" + newEntry;
  }
  // No title found, create fresh
  return "# Changelog\n\n" + newEntry;
}
