---
'@varlock/bumpy': patch
---

Label and link npm targets published to GitHub Packages correctly. Packages publishing to a GitHub Packages registry (`npm.pkg.github.com`) were labelled `npm` in the GitHub release notes and `bumpy status`/`bumpy ci plan` output, with a "Published to" badge linking to a non-existent npmjs.com page (404). The configured registry is now honoured: such targets are labelled **GitHub Packages** and link to the package page under the repo (`https://github.com/<owner>/<repo>/pkgs/npm/<name>`), resolving the repo from the package's `repository` field or `GITHUB_REPOSITORY`. Other custom/private registries no longer emit a dead npmjs.com link. `buildPublishUrl` now honours its registry argument (previously the unused `_registry` param).
