---
'@varlock/bumpy': minor
---

Changed `none` bump type to no longer suppress cascading bumps — it now just skips the direct bump while allowing dependency propagation to apply normally. Added `--hook` flag to `bumpy check` for pre-commit/pre-push hook context, with untracked/staged bump file detection. Added `bumpy add --none` shortcut to acknowledge all changed packages without bumping. Empty bump files no longer bypass `--strict` mode.
