---
'@varlock/bumpy': minor
---

Add `cascadeFrom` config and simplify cascade API

Added consumer-side `cascadeFrom` as the complement to `cascadeTo`, allowing packages to declare cascade relationships from either direction. Both now support an array shorthand with sensible defaults (trigger: "patch", bumpAs: "match") alongside the object form for custom rules.
