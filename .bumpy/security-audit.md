---
'@varlock/bumpy': patch
---

Security hardening: eliminate shell injection vulnerabilities across all CLI commands

- Replace shell string interpolation with `execFile`-based argument arrays (`runArgs`/`runArgsAsync`) throughout the codebase, preventing command injection via branch names, PR numbers, config values, package names, and registry URLs
- Add input validation for git branch names and PR numbers from environment variables
- Remove broken `escapeShell` function in favor of shell-free execution
- Use `sq()` single-quote escaping for template substitutions in user-defined publish commands
- Restrict dynamic changelog formatter imports to paths within the project root
- Reduce changeset filename collisions by using three-word random names
