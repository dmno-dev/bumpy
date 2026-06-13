---
'@varlock/bumpy': patch
---

When a prerelease cycle is promoted (channel → main) or graduated (channel → channel), any lingering release PR on the source channel is now closed automatically with an explanatory comment — merging it would have offered another prerelease of a cycle that already moved on.
