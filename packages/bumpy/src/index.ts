// Re-export core modules for programmatic usage
export { loadConfig, findRoot, getBumpyDir, matchGlob } from './core/config.ts';
export { discoverPackages } from './core/workspace.ts';
export { DependencyGraph } from './core/dep-graph.ts';
export { readBumpFiles, parseBumpFile, writeBumpFile } from './core/bump-file.ts';
export { assembleReleasePlan } from './core/release-plan.ts';
export { applyReleasePlan } from './core/apply-release-plan.ts';
export { generateChangelogEntry, loadFormatter, defaultFormatter, prependToChangelog } from './core/changelog.ts';
export type { ChangelogFormatter, ChangelogContext } from './core/changelog.ts';
export type { GithubChangelogOptions } from './core/changelog-github.ts';
export { bumpVersion, satisfies, stripProtocol } from './core/semver.ts';
export { publishPackages } from './core/publish-pipeline.ts';
export * from './types.ts';
