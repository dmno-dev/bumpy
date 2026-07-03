---
'@varlock/bumpy': patch
---

Load Yarn catalogs from `.yarnrc.yml`. Yarn (>=4.10) stores catalog definitions in `.yarnrc.yml` under the `catalog`/`catalogs` keys (the same shape pnpm uses in `pnpm-workspace.yaml`), but catalog loading only read `pnpm-workspace.yaml` and `package.json`, so Yarn workspaces always saw an empty catalog map. Catalog loading and the check command's catalog diff now consult the package manager's own YAML file (`.yarnrc.yml` for Yarn).
