---
'@varlock/bumpy': patch
---

Enhance GitHub changelog formatter with PR/commit links and contributor attribution.

- Add commit hash links alongside PR links in changelog entries
- Add "Thanks @username!" attribution (matching `@changesets/changelog-github` format)
- Add `internalAuthors` option to suppress thanks for team members
- Support metadata overrides in changeset summaries (`pr:`, `commit:`, `author:` lines)
- Linkify bare `#123` issue references in summary text
- Auto-detect repo slug from `gh` CLI when not configured
