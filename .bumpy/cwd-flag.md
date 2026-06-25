---
'@varlock/bumpy': minor
---

Added a global `--cwd <dir>` flag that runs bumpy as if it were started in `<dir>`. This makes the `pull_request_target` PR-check workflow safe against a previously-undocumented attack: a fork PR could commit a `bunfig.toml`/`.npmrc` that redirected where `bunx @varlock/bumpy` itself was fetched from (swapping in a malicious package at the pinned version). The recommended workflow now fetches and runs bumpy from a trusted base checkout and points it at the untrusted PR tree with `--cwd ./pr`, so package-manager config in the PR can no longer influence how bumpy is obtained.

To help existing users migrate, `bumpy ci check` now fails when it runs under `pull_request_target` without an explicit `--cwd`, with a message pointing at the updated two-checkout workflow. Pass `--cwd .` to acknowledge an already-trusted checkout (e.g. a same-repo PR).
