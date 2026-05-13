---
'@varlock/bumpy': patch
---

Fix git push auth in CI by using remote URL token embedding instead of extraheader approach, which doesn't work with actions/checkout@v6
