import type { ChangelogFormatter } from '@varlock/bumpy';

const formatter: ChangelogFormatter = (ctx) => {
  const { release, bumpFiles, date } = ctx;
  const lines: string[] = [];
  lines.push(`## 🐸 ${release.newVersion}`);
  lines.push('');
  lines.push(`_${date}_`);
  lines.push('');

  const relevantBumpFiles = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));

  if (relevantBumpFiles.length > 0) {
    for (const cs of relevantBumpFiles) {
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

  if (release.isDependencyBump && relevantBumpFiles.length === 0) {
    lines.push('- Updated dependencies');
  }

  if (release.isCascadeBump && !release.isDependencyBump && relevantBumpFiles.length === 0) {
    lines.push('- Version bump via cascade rule');
  }

  lines.push('');
  return lines.join('\n');
};

export default formatter;
