import { relative, resolve } from 'node:path';
import pc from 'picocolors';
import { log } from '../utils/logger.ts';
import { p, unwrap } from '../utils/clack.ts';
import { ensureDir, exists } from '../utils/fs.ts';
import { randomName, slugify } from '../utils/names.ts';
import { writeBumpFile } from '../core/bump-file.ts';
import picomatch from 'picomatch';
import { getBumpyDir, loadConfig, loadPackageConfig, matchGlob } from '../core/config.ts';
import { discoverPackages } from '../core/workspace.ts';
import { DependencyGraph } from '../core/dep-graph.ts';
import { getChangedFiles } from '../core/git.ts';
import { bumpSelectPrompt } from '../prompts/bump-select.ts';
import type { BumpSelectItem } from '../prompts/bump-select.ts';
import type { BumpType, BumpTypeWithNone, BumpFileRelease, BumpFileReleaseCascade } from '../types.ts';

interface AddOptions {
  packages?: string; // "pkg-a:minor,pkg-b:patch"
  message?: string;
  name?: string;
  empty?: boolean;
}

const CASCADE_CHOICES: { label: string; value: BumpType }[] = [
  { label: 'patch', value: 'patch' },
  { label: 'minor', value: 'minor' },
  { label: 'major', value: 'major' },
];

export async function addCommand(rootDir: string, opts: AddOptions): Promise<void> {
  const config = await loadConfig(rootDir);
  const bumpyDir = getBumpyDir(rootDir);
  await ensureDir(bumpyDir);

  // Handle --empty flag
  if (opts.empty) {
    const filename = opts.name ? slugify(opts.name) : randomName();
    const filePath = resolve(bumpyDir, `${filename}.md`);
    const { writeText } = await import('../utils/fs.ts');
    await writeText(filePath, '---\n---\n');
    log.success(`Created empty bump file: .bumpy/${filename}.md`);
    return;
  }

  let releases: BumpFileRelease[];
  let summary: string;
  let filename: string;

  if (opts.packages) {
    // Non-interactive mode
    releases = parsePackagesFlag(opts.packages);
    summary = opts.message || '';
    filename = opts.name ? slugify(opts.name) : randomName();
  } else {
    // Interactive mode
    p.intro(pc.bgCyan(pc.black(' bumpy add ')));

    const pkgs = await discoverPackages(rootDir, config);
    const depGraph = new DependencyGraph(pkgs);

    if (pkgs.size === 0) {
      p.cancel('No managed packages found in this workspace.');
      process.exit(1);
    }

    // Detect which packages have changed on this branch
    const baseBranch = config.baseBranch;
    const changedFiles = getChangedFiles(rootDir, baseBranch);
    // Build per-package matchers (per-package patterns override root patterns)
    const matchers = new Map<string, picomatch.Matcher>();
    for (const [name, pkg] of pkgs) {
      const pkgConfig = await loadPackageConfig(pkg.dir, config, name);
      const patterns = pkgConfig.changedFilePatterns ?? config.changedFilePatterns;
      matchers.set(name, picomatch(patterns));
    }

    const changedPackageNames = new Set<string>();
    for (const file of changedFiles) {
      for (const [name, pkg] of pkgs) {
        const pkgRelDir = relative(rootDir, pkg.dir);
        if (file.startsWith(pkgRelDir + '/')) {
          const relToPackage = file.slice(pkgRelDir.length + 1);
          if (matchers.get(name)!(relToPackage)) {
            changedPackageNames.add(name);
          }
        }
      }
    }

    // Build items for the bump select prompt
    const bumpSelectItems: BumpSelectItem[] = [...pkgs.values()].map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      changed: changedPackageNames.has(pkg.name),
    }));

    const bumpSelectResult = await bumpSelectPrompt(bumpSelectItems);
    if (typeof bumpSelectResult === 'symbol') {
      p.cancel('Aborted');
      process.exit(0);
    }
    const bumpSelections = bumpSelectResult;

    if (bumpSelections.length === 0) {
      p.cancel('No packages selected.');
      process.exit(0);
    }

    releases = [];
    for (const { name, type: bumpType } of bumpSelections) {
      const release: BumpFileRelease = { name, type: bumpType };

      // Offer cascade options if the package has dependents
      {
        const dependents = depGraph.getDependents(name);
        const pkg = pkgs.get(name)!;
        const cascadeTargets = pkg.bumpy?.cascadeTo;

        if (dependents.length > 0 || cascadeTargets) {
          const wantCascade = unwrap(
            await p.confirm({
              message: `${pc.cyan(name)} has ${pc.bold(String(dependents.length))} dependents. Specify explicit cascades?`,
              initialValue: false,
            }),
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

            const cascadeSelected = unwrap(
              await p.multiselect<string>({
                message: 'Which packages should cascade?',
                options: [...allTargets].map((n) => ({ label: n, value: n })),
                required: false,
              }),
            );

            if (cascadeSelected.length > 0) {
              const cascadeBump = unwrap(
                await p.select<BumpType>({
                  message: 'Cascade bump type',
                  options: CASCADE_CHOICES,
                }),
              );
              const cascade: Record<string, BumpType> = {};
              for (const target of cascadeSelected) {
                cascade[target] = cascadeBump;
              }
              (release as BumpFileReleaseCascade).cascade = cascade;
            }
          }
        }
      }

      releases.push(release);
    }

    summary = unwrap(
      await p.text({
        message: 'Summary (what changed and why)',
        placeholder: 'A short description of the change',
        validate: (value) => {
          if (!value || !value.trim()) return 'Summary is required';
          return undefined;
        },
      }),
    );

    const defaultName = randomName();
    const nameInput = unwrap(
      await p.text({
        message: 'Bump file name',
        placeholder: defaultName,
        defaultValue: defaultName,
        validate: (value) => {
          if (!value) return undefined; // will use default
          if (!slugify(value)) return 'Name must contain at least one alphanumeric character';
          return undefined;
        },
      }),
    );
    filename = slugify(nameInput) || defaultName;
  }

  // Check for existing file
  if (await exists(resolve(bumpyDir, `${filename}.md`))) {
    filename = `${filename}-${Date.now()}`;
  }

  await writeBumpFile(rootDir, filename, releases, summary);

  if (opts.packages) {
    log.success(`Created bump file: .bumpy/${filename}.md`);
    for (const r of releases) {
      log.dim(`  ${r.name}: ${r.type}${formatCascade(r)}`);
    }
  } else {
    p.note(
      releases.map((r) => `${pc.cyan(r.name)} ${pc.dim('→')} ${pc.bold(r.type)}${formatCascade(r)}`).join('\n'),
      'Bump file',
    );
    p.outro(pc.green(`Created .bumpy/${filename}.md`));
  }
}

function formatCascade(r: BumpFileRelease): string {
  if (!('cascade' in r) || Object.keys(r.cascade).length === 0) return '';
  const parts = Object.entries(r.cascade).map(([k, v]) => `${k}:${v}`);
  return pc.dim(` (cascade: ${parts.join(', ')})`);
}

function parsePackagesFlag(input: string): BumpFileRelease[] {
  return input.split(',').map((entry) => {
    const [name, type] = entry.trim().split(':');
    if (!name || !type) {
      throw new Error(`Invalid package format: "${entry}". Expected "name:bumpType"`);
    }
    return { name: name.trim(), type: type.trim() as BumpTypeWithNone };
  });
}
