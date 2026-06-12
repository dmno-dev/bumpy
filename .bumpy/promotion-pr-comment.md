---
'@varlock/bumpy': patch
---

The PR check comment now explicitly calls out promotion PRs (channel → stable): the headline explains that merging ends the prerelease cycle and ships stable, and bump files that already shipped on a channel are annotated with their dist-tag (e.g. `next/feature.md` _(shipped on `@next`)_).
