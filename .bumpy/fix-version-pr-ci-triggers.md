---
'@varlock/bumpy': patch
---

Fix version PR not triggering CI workflow runs

After pushing the version branch, recreate the tip commit via the GitHub REST API so that pull_request workflows fire automatically. Commits pushed with GITHUB_TOKEN don't trigger workflows due to GitHub's anti-recursion guard, but API-created commits bypass this — no PATs, GitHub Apps, or user CI config changes needed.
