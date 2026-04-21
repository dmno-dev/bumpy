import { resolve } from 'node:path';
import {
  readJson,
  readText,
  writeText,
  exists,
  updateJsonFields,
  updateJsonNestedField,
  listFiles,
  removeFile,
} from '../utils/fs.ts';
import { generateChangelogEntry, prependToChangelog, loadFormatter } from './changelog.ts';
import { getBumpyDir } from './config.ts';
import type { ReleasePlan, WorkspacePackage, BumpyConfig } from '../types.ts';

/** Apply the release plan: bump versions, update changelogs, delete bump files */
export async function applyReleasePlan(
  releasePlan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
  config: BumpyConfig,
): Promise<void> {
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));
  const formatter = await loadFormatter(config.changelog, rootDir);

  // 1. Update package.json versions and internal dependency ranges (preserving formatting)
  for (const release of releasePlan.releases) {
    const pkg = packages.get(release.name)!;
    const pkgJsonPath = resolve(pkg.dir, 'package.json');
    const pkgJson = await readJson<Record<string, unknown>>(pkgJsonPath);

    // Bump the version (in-place string replacement)
    await updateJsonFields(pkgJsonPath, { version: release.newVersion });

    // Update internal dependency ranges (in-place string replacement)
    for (const depField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkgJson[depField] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [depName, range] of Object.entries(deps)) {
        const depRelease = releaseMap.get(depName);
        if (!depRelease) continue;
        const newRange = updateRange(range, depRelease.newVersion);
        await updateJsonNestedField(pkgJsonPath, depField, depName, newRange);
      }
    }
  }

  // 2. Update changelogs
  for (const release of releasePlan.releases) {
    const pkg = packages.get(release.name)!;
    const changelogPath = resolve(pkg.dir, 'CHANGELOG.md');

    const entry = await generateChangelogEntry(release, releasePlan.bumpFiles, formatter);
    let existingContent = '';
    if (await exists(changelogPath)) {
      existingContent = await readText(changelogPath);
    }
    const newContent = prependToChangelog(existingContent, entry);
    await writeText(changelogPath, newContent);
  }

  // 3. Delete all bump files (including empty ones that aren't in the release plan)
  const bumpyDir = getBumpyDir(rootDir);
  const allBumpFiles = await listFiles(bumpyDir, '.md');
  for (const file of allBumpFiles) {
    if (file === 'README.md') continue;
    await removeFile(resolve(bumpyDir, file));
  }
}

/** Update a version range to include a new version, preserving the range prefix */
function updateRange(range: string, newVersion: string): string {
  // Preserve workspace:/catalog: protocols
  let protocol = '';
  let cleanRange = range;
  const protoMatch = range.match(/^(workspace:|catalog:)/);
  if (protoMatch) {
    protocol = protoMatch[1]!;
    cleanRange = range.slice(protocol.length);
  }

  // Preserve the range prefix (^, ~, >=, etc.)
  const prefixMatch = cleanRange.match(/^(\^|~|>=|>|<=|<|=)?/);
  const prefix = prefixMatch?.[1] ?? '^';

  // Handle wildcard ranges
  if (cleanRange === '*' || cleanRange === '') {
    return range; // don't touch wildcards
  }

  return `${protocol}${prefix}${newVersion}`;
}
