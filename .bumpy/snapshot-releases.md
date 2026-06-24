---
'@varlock/bumpy': minor
---

Add snapshot releases — transient, one-off preview publishes for private packages (the private-registry counterpart to pkg.pr.new).

`bumpy publish --snapshot <name>` computes the pending release plan, derives a unique prerelease version per package (e.g. `1.4.0-pr-123-a1b2c3d`), exact-pins in-plan internal deps, publishes to a non-`latest` dist-tag (default: the snapshot name), then restores the working tree. It never consumes bump files, writes changelogs, commits, creates git tags, or makes GitHub releases. `bumpy ci release --snapshot <name>` runs the whole thing and, on a PR, posts/updates a comment with the published versions and install instructions. Requires pending bump files; mutually exclusive with `--channel`.

Version uniqueness is configurable via the new `snapshot.versionStrategy` option: `"sha"` (default — `<target>-<name>-<short-sha>`, idempotent per commit so re-runs skip) or `"timestamp"`. Consumers install via the dist-tag regardless, so the exact version string is just an implementation detail.
