---
'@varlock/bumpy': patch
---

Degrade the version PR body when it would exceed GitHub's 65536-character limit (which previously failed the release for large multi-package releases). The body now drops inline change summaries — and hard-truncates as a last resort — instead of erroring.
