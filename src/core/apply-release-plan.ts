import { resolve } from "node:path";
import { readJson, writeJson, readText, writeText, exists } from "../utils/fs.ts";
import { deleteChangesets } from "./changeset.ts";
import { generateChangelogEntry, prependToChangelog } from "./changelog.ts";
import { stripProtocol } from "./semver.ts";
import type {
  ReleasePlan,
  WorkspacePackage,
  BumpyConfig,
} from "../types.ts";

/** Apply the release plan: bump versions, update changelogs, delete changesets */
export async function applyReleasePlan(
  releasePlan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
  config: BumpyConfig,
): Promise<void> {
  const releaseMap = new Map(releasePlan.releases.map((r) => [r.name, r]));

  // 1. Update package.json versions and internal dependency ranges
  for (const release of releasePlan.releases) {
    const pkg = packages.get(release.name)!;
    const pkgJsonPath = resolve(pkg.dir, "package.json");
    const pkgJson = await readJson<Record<string, unknown>>(pkgJsonPath);

    // Bump the version
    pkgJson.version = release.newVersion;

    // Update internal dependency ranges
    for (const depField of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const deps = pkgJson[depField] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [depName, range] of Object.entries(deps)) {
        const depRelease = releaseMap.get(depName);
        if (!depRelease) continue;
        deps[depName] = updateRange(range, depRelease.newVersion);
      }
    }

    await writeJson(pkgJsonPath, pkgJson);
  }

  // 2. Update changelogs
  for (const release of releasePlan.releases) {
    const pkg = packages.get(release.name)!;
    const changelogPath = resolve(pkg.dir, "CHANGELOG.md");

    const entry = generateChangelogEntry(release, releasePlan.changesets);
    let existingContent = "";
    if (await exists(changelogPath)) {
      existingContent = await readText(changelogPath);
    }
    const newContent = prependToChangelog(existingContent, entry);
    await writeText(changelogPath, newContent);
  }

  // 3. Delete consumed changeset files
  const csIds = releasePlan.changesets.map((cs) => cs.id);
  await deleteChangesets(rootDir, csIds);
}

/** Update a version range to include a new version, preserving the range prefix */
function updateRange(range: string, newVersion: string): string {
  // Preserve workspace:/catalog: protocols
  let protocol = "";
  let cleanRange = range;
  const protoMatch = range.match(/^(workspace:|catalog:)/);
  if (protoMatch) {
    protocol = protoMatch[1]!;
    cleanRange = range.slice(protocol.length);
  }

  // Preserve the range prefix (^, ~, >=, etc.)
  const prefixMatch = cleanRange.match(/^(\^|~|>=|>|<=|<|=)?/);
  const prefix = prefixMatch?.[1] ?? "^";

  // Handle wildcard ranges
  if (cleanRange === "*" || cleanRange === "") {
    return range; // don't touch wildcards
  }

  return `${protocol}${prefix}${newVersion}`;
}
