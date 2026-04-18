---
'@varlock/bumpy': minor
---

Restructured version propagation into Phase A/B/C architecture. Phase A (out-of-range fixes) always runs — peer deps now match the triggering bump level instead of always forcing major. Added workspace:^ protocol resolution for range checking. Removed minor-isolated and specificDependencyRules. Added none bump type and patch-isolated validation. Added warnings for ^0.x peer dep propagation and workspace:\* on peer deps.
