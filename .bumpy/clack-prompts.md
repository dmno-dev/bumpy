---
'@varlock/bumpy': minor
---

Revamp interactive prompts using `@clack/prompts` for a much nicer CLI UX.

- `bumpy add` now uses arrow-key navigation, validation, grouped intro/outro framing, and a summary note
- `bumpy migrate` cleanup prompt uses a spinner and intro/outro
- Clean Ctrl-C / Esc cancellation on every prompt (no more stack traces)
- Swapped `ansis` → `picocolors` to avoid bundling two color libraries
