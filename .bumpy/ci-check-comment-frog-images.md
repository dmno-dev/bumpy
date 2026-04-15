---
'@varlock/bumpy': patch
---

Rework CI check PR comment

- Restyle with frog images matching the version PR description
- Filter to only changesets added/modified in the PR, not all pending changesets
- Add links to view diff and edit each changeset file on GitHub
- Add "click to add changeset" link for GitHub's file creation UI
- Detect package manager for correct CLI instructions
- Fix comment update using correct REST API numeric IDs and stdin flag
