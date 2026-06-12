---
'@varlock/bumpy': patch
---

`ci check` now reads bump files in channel directories, so promotion PRs (channel → main) and graduation PRs (channel → channel) correctly report the cycle's pending releases instead of failing with "no bump files found". Channel-dir bump files render with their subdir path (`next/feature.md`) so view/edit links resolve.
