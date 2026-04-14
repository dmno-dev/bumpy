import { resolve } from "node:path";
import { log, colorize } from "../utils/logger.ts";
import { ask, select, multiSelect, confirm } from "../utils/prompt.ts";
import { ensureDir, exists } from "../utils/fs.ts";
import { randomName, slugify } from "../utils/names.ts";
import { writeChangeset } from "../core/changeset.ts";
import { getBumpyDir, loadConfig, findRoot } from "../core/config.ts";
import { discoverPackages } from "../core/workspace.ts";
import { DependencyGraph } from "../core/dep-graph.ts";
import { matchGlob } from "../core/config.ts";
import type {
  BumpType,
  BumpTypeWithIsolated,
  ChangesetRelease,
  ChangesetReleaseCascade,
  WorkspacePackage,
} from "../types.ts";

interface AddOptions {
  packages?: string; // "pkg-a:minor,pkg-b:patch-isolated"
  message?: string;
  name?: string;
  empty?: boolean;
}

const BUMP_CHOICES: { label: string; value: BumpTypeWithIsolated }[] = [
  { label: "patch", value: "patch" },
  { label: "minor", value: "minor" },
  { label: "major", value: "major" },
  { label: "patch (isolated - no cascade)", value: "patch-isolated" },
  { label: "minor (isolated - no cascade)", value: "minor-isolated" },
  { label: "major (isolated - no cascade)", value: "major-isolated" },
];

export async function addCommand(rootDir: string, opts: AddOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const bumpyDir = getBumpyDir(rootDir);
  await ensureDir(bumpyDir);

  // Handle --empty flag
  if (opts.empty) {
    const filename = opts.name ? slugify(opts.name) : randomName();
    // Empty changeset - just a placeholder
    const filePath = resolve(bumpyDir, `${filename}.md`);
    const { writeText } = await import("../utils/fs.ts");
    await writeText(filePath, "---\n---\n");
    log.success(`Created empty changeset: .bumpy/${filename}.md`);
    return;
  }

  let releases: ChangesetRelease[];
  let summary: string;

  if (opts.packages) {
    // Non-interactive mode
    releases = parsePackagesFlag(opts.packages);
    summary = opts.message || "";
  } else {
    // Interactive mode
    const pkgs = await discoverPackages(rootDir, config);
    const depGraph = new DependencyGraph(pkgs);

    // Select packages
    const selected = await multiSelect<string>(
      "Which packages should be included in this changeset?",
      [...pkgs.values()]
        .filter((p) => !p.private || config.privatePackages.version)
        .map((p) => ({ label: `${p.name} (${p.version})`, value: p.name })),
    );

    if (selected.length === 0) {
      log.warn("No packages selected. Aborting.");
      return;
    }

    releases = [];
    for (const name of selected) {
      const bumpType = await select<BumpTypeWithIsolated>(
        `Bump type for ${colorize(name, "cyan")}:`,
        BUMP_CHOICES,
      );

      const release: ChangesetRelease = { name, type: bumpType };

      // Offer cascade options if the package has dependents and bump is not isolated
      if (!bumpType.endsWith("-isolated")) {
        const dependents = depGraph.getDependents(name);
        const pkg = pkgs.get(name)!;
        const cascadeTargets = pkg.bumpy?.cascadeTo;

        if (dependents.length > 0 || cascadeTargets) {
          const wantCascade = await confirm(
            `${name} has ${dependents.length} dependents. Specify explicit cascades?`,
            false,
          );

          if (wantCascade) {
            const allTargets = new Set<string>();
            for (const d of dependents) allTargets.add(d.name);
            if (cascadeTargets) {
              for (const pattern of Object.keys(cascadeTargets)) {
                for (const [pName] of pkgs) {
                  if (matchGlob(pName, pattern)) allTargets.add(pName);
                }
              }
            }

            const cascadeSelected = await multiSelect<string>(
              "Which packages should cascade?",
              [...allTargets].map((n) => ({ label: n, value: n })),
            );

            if (cascadeSelected.length > 0) {
              const cascadeBump = await select<BumpType>(
                "Cascade bump type:",
                [
                  { label: "patch", value: "patch" },
                  { label: "minor", value: "minor" },
                  { label: "major", value: "major" },
                ],
              );
              const cascade: Record<string, BumpType> = {};
              for (const target of cascadeSelected) {
                cascade[target] = cascadeBump;
              }
              (release as ChangesetReleaseCascade).cascade = cascade;
            }
          }
        }
      }

      releases.push(release);
    }

    // Get summary
    summary = await ask("Summary (what changed and why)");
  }

  // Get filename
  let filename: string;
  if (opts.name) {
    filename = slugify(opts.name);
  } else if (opts.packages) {
    // Non-interactive, no name specified
    filename = randomName();
  } else {
    const nameInput = await ask("Changeset name", randomName());
    filename = slugify(nameInput) || randomName();
  }

  // Check for existing file
  if (await exists(resolve(bumpyDir, `${filename}.md`))) {
    filename = `${filename}-${Date.now()}`;
  }

  const filePath = await writeChangeset(rootDir, filename, releases, summary);
  log.success(`Created changeset: .bumpy/${filename}.md`);

  // Preview
  for (const r of releases) {
    const cascade = "cascade" in r && Object.keys(r.cascade).length > 0
      ? ` (cascade: ${Object.entries(r.cascade).map(([k, v]) => `${k}:${v}`).join(", ")})`
      : "";
    log.dim(`  ${r.name}: ${r.type}${cascade}`);
  }
}

function parsePackagesFlag(input: string): ChangesetRelease[] {
  return input.split(",").map((entry) => {
    const [name, type] = entry.trim().split(":");
    if (!name || !type) {
      throw new Error(`Invalid package format: "${entry}". Expected "name:bumpType"`);
    }
    return { name: name.trim(), type: type.trim() as BumpTypeWithIsolated };
  });
}
