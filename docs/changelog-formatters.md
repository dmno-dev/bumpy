# Changelog Formatters

Bumpy generates `CHANGELOG.md` entries automatically when releasing.

There are several built-in formatters, or you can provide a custom function.

## Built-in formatters

### `default`

Simple markdown formatter. Produces a version heading, date, and bullet points from bump file summaries. _This is the default -- no settting required to enable_.

**Example output:**

```markdown
## 1.2.0

_2026-04-19_

- Added support for custom themes
- Fixed a bug with config loading
```

No options are available for the default formatter.

### `github`

Enhanced formatter that adds PR links and contributor attribution. Optionally includes commit links. Requires the `gh` CLI to be installed and authenticated.

Enable in your `.bumpy/_config.json` using `"changelog": "github",`

Or with options using a tuple format:

```json
{
  "changelog": ["github", { "internalAuthors": ["username1"] }]
}
```

**Example output:**

```markdown
## 1.2.0

_2026-04-19_

- [#42](https://github.com/myorg/myrepo/pull/42) Thanks [@contributor](https://github.com/contributor)! - Added support for custom themes
- [#43](https://github.com/myorg/myrepo/pull/43) - Fixed a bug with config loading
```

#### Options

| Option              | Type       | Default | Description                                                       |
| ------------------- | ---------- | ------- | ----------------------------------------------------------------- |
| `repo`              | `string`   | —       | `"owner/repo"` slug. Auto-detected from `gh` CLI if not provided. |
| `includeCommitLink` | `boolean`  | `false` | Whether to include commit hash links in changelog entries.        |
| `thankContributors` | `boolean`  | `true`  | Whether to include "Thanks @user" messages for contributors.      |
| `internalAuthors`   | `string[]` | `[]`    | GitHub usernames (without `@`) to skip "Thanks" messages for.     |

#### Bump file metadata overrides

The GitHub formatter also supports metadata lines in bump file summaries to override auto-detected values:

```markdown
---
'my-package': minor
---

pr: 42
commit: abc1234
author: @someuser

Added support for custom themes
```

These overrides take precedence over git-derived info, which is useful when the automatic detection doesn't find the right PR or author.

## Custom formatters

You can write your own formatter as a TypeScript or JavaScript module. The module should export a `ChangelogFormatter` function as its default export.

Create a file, for example `.bumpy/_changelog-formatter.ts`, and then reference it in your config:

```json
{
  "changelog": "./.bumpy/_changelog-formatter.ts"
}
```

### Formatter interface

```typescript
import type { ChangelogFormatter } from '@varlock/bumpy';

interface ChangelogContext {
  release: PlannedRelease;
  /** Bump files that contributed to this release */
  bumpFiles: BumpFile[];
  /** ISO date string (YYYY-MM-DD) */
  date: string;
}

type ChangelogFormatter = (ctx: ChangelogContext) => string | Promise<string>;
```

### Example: custom formatter

```typescript
import type { ChangelogFormatter } from '@varlock/bumpy';

const formatter: ChangelogFormatter = (ctx) => {
  const { release, bumpFiles, date } = ctx;
  const lines: string[] = [];
  lines.push(`## ${release.newVersion}`);
  lines.push('');
  lines.push(`_${date}_`);
  lines.push('');

  const relevantBumpFiles = bumpFiles.filter((bf) => release.bumpFiles.includes(bf.id));

  for (const bf of relevantBumpFiles) {
    if (bf.summary) {
      lines.push(`- ${bf.summary.split('\n')[0]}`);
    }
  }

  if (release.isDependencyBump && relevantBumpFiles.length === 0) {
    lines.push('- Updated dependencies');
  }

  lines.push('');
  return lines.join('\n');
};

export default formatter;
```

Custom formatters can also accept options. Export a factory function that returns a `ChangelogFormatter`:

```typescript
import type { ChangelogFormatter } from '@varlock/bumpy';

export default function createFormatter(options: { emoji?: boolean }): ChangelogFormatter {
  return (ctx) => {
    const prefix = options.emoji ? '🚀 ' : '';
    const lines: string[] = [];
    lines.push(`## ${prefix}${ctx.release.newVersion}`);
    // ... rest of formatting
    lines.push('');
    return lines.join('\n');
  };
}
```

```json
{
  "changelog": ["./.bumpy/_changelog-formatter.ts", { "emoji": true }]
}
```
