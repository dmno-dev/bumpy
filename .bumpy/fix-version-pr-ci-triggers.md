---
'@varlock/bumpy': patch
---

Support custom token for triggering CI on version PRs

- Add `BUMPY_GH_TOKEN` env var support — when set, bumpy pushes the version branch using the custom token, bypassing GitHub's anti-recursion guard so PR workflows fire automatically
- Add `bumpy ci setup` interactive command to help create a fine-grained PAT or GitHub App and store it as a repo secret
- When no custom token is set, log a warning with setup instructions
