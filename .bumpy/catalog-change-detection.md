---
'@varlock/bumpy': minor
---

Detect catalog entry changes as package changes. When a catalog version in `pnpm-workspace.yaml` (pnpm) or root `package.json` (bun/yarn `catalog`/`catalogs`, plus `workspaces.catalog`/`workspaces.catalogs`) is modified, `bumpy add` and `bumpy check` now flag every package that references the changed entry via `catalog:` / `catalog:<name>` as changed. Closes #92.
