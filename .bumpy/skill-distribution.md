---
'@varlock/bumpy': patch
---

Streamline agent skill distribution and remove the `bumpy ai` command.

The canonical `add-change` skill now lives at the repo root (`skills/`) as a single source of truth and is synced into the package on `build`/`prepack` (gitignored copy), so it ships version-pinned in the npm tarball and via the Claude Code plugin (`claude plugin install @varlock/bumpy`).

The `bumpy ai setup` command has been removed. Its file-copying targets (`opencode`, `cursor`, `codex`) duplicated the skill into tool-specific directories that drifted from the canonical copy — and had silently been broken in the published package — while the `claude` target was a thin wrapper around `claude plugin install`. Install the skill via the Claude Code plugin, or reference the bundled `SKILL.md` directly from `node_modules/@varlock/bumpy/skills/add-change/SKILL.md`.
