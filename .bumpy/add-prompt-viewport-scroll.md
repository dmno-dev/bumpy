---
'@varlock/bumpy': patch
---

Fix scrolling in `bumpy add` when there are many packages. The interactive bump-select prompt now renders a viewport that fits within the terminal, scrolling the package list (with `▲ N more` / `▼ N more` indicators) as the cursor moves. Previously, when the list exceeded terminal height, navigating up would snap the cursor back to the bottom because the redraw cursor-up lost its anchor once content scrolled off-screen. Closes #96.
