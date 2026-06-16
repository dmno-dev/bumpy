---
'@varlock/bumpy': patch
---

Stream `buildCommand`/`publishCommand` output live to the parent process and surface the child's real failure reason. Custom publish commands (vsce, ovsx, anything bespoke) previously ran through a buffering runner that discarded stdout and never streamed output, so a failure like an expired marketplace token produced only a generic `Command failed` wrapper with no usable cause in CI logs. These commands now run through a streaming runner (`spawn` with piped+teed stdio) that prints output as it happens and includes both stdout and stderr in the thrown error. The capturing `runAsync`/`runArgsAsync` helpers (still used for internal git/npm calls whose output is parsed) also now include stdout in their error messages.
