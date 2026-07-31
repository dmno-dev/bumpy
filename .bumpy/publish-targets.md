---
'@varlock/bumpy': minor
---

Publish-target plugin system: packages can now publish to multiple targets at once via per-package `publishTargets` and a root `targets` map (type-level defaults + named reusable instances). Built-in targets: `npm`, `jsr`, `pypi`, `vscode-marketplace`, `open-vsx`, and `custom` (the existing shell-command escape hatch). Publish state is tracked per target in the GitHub release metadata, so a partial failure (npm succeeded, Open VSX errored) retries only the failed target; a registry-level guard also prevents republishing versions that are already live even when metadata is missing. Targets publishing the same artifact share one build — a single `.vsix` goes to both the VS Code Marketplace and Open VSX, byte-identical. Marketplace/JSR/PyPI targets sit out snapshots and (where unsupported) prereleases as recorded skips instead of failures. Legacy `publishCommand`/`skipNpmPublish` fields keep working unchanged.

JSR publishing (publish-time `jsr.json` version sync, claim-first bootstrap detection) is modeled on [Drake Costa's](https://github.com/Saeris) setup in [mirrordown](https://github.com/mirrordown/mirrordown) — thanks Drake!
