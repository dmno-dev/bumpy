---
'@varlock/bumpy': patch
---

Fix "Bun is not defined" error in CI release command when running under Node.js by replacing `Bun.CryptoHasher` with `node:crypto`.
