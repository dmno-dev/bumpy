---
'@varlock/bumpy': patch
---

Fixed GitHub release notes coming up empty (`No changelog entries.`) when the publish ran several commits after the version commit — e.g. a retry after the first publish was blocked and unrelated fixes landed on main. Bump-file recovery assumed the version commit was always `HEAD~1..HEAD`; it now locates the most recent commit that actually deleted bump files and recovers their content from that commit's parent, so release notes are populated regardless of how far HEAD has moved past versioning.
