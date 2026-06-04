---
'@varlock/bumpy': patch
---

Harden the publish flow for two failure modes hit when releasing brand-new packages via GitHub Actions + npm trusted publishing (OIDC).

- Detect the new-package case before any side effects. When OIDC is the only available auth path (no `NPM_TOKEN`/`NODE_AUTH_TOKEN`, no `.npmrc` auth), bumpy now checks the npm registry up front and emits a clear error directing the user to publish a `0.0.0` placeholder before merging — instead of failing partway through with stranded GitHub draft releases and remote tags. The check is skipped when a token fallback is present, so users who enable `id-token: write` for provenance attestations alongside token auth are unaffected.
- Replace blanket `git push --tags` after publish with per-tag force push. `gh release create --draft --target SHA` creates the tag on the remote at draft-creation time; if a prior publish failed and HEAD has since moved, the remote tag is stale and `git push --tags` rejects with "already exists". The new logic iterates `releasePlan.releases` minus failed packages and force-pushes each tag individually, preserving the anySucceeded-aware semantics already used for local tag movement — packages whose targets all succeeded in a prior run are stripped upstream and their tags stay at the SHA the artifact was actually published from.
