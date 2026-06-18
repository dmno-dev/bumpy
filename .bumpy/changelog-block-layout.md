---
'@varlock/bumpy': patch
---

Changelog entries now use a block layout when a summary is multi-line, long (>120 chars), or contains markdown block syntax (headings, lists, blockquotes, code fences, tables). In those cases the entry metadata (`*(type)*`, PR link, "Thanks @user!") goes on its own line and the summary is rendered indented below it, instead of being jammed onto the same line. Short single-line summaries are unchanged and stay inline. Internal blank lines in a summary are now preserved so markdown paragraphs and lists render correctly. Applies to both the default and `github` formatters.
