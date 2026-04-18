---
'@varlock/bumpy': patch
---

Preserve package.json formatting when bumping versions

Instead of re-serializing the entire file with `JSON.stringify`, version bumps and dependency range updates now use targeted string replacements. This prevents reformatting issues like inline arrays being expanded to multi-line, indentation style changes, and other unnecessary churn.
