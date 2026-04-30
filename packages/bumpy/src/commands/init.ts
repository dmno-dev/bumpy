import { resolve } from 'node:path';
import { rename, readdir, rm } from 'node:fs/promises';
import pc from 'picocolors';
import { ensureDir, writeJson, writeText, readJson, readText, exists, listFiles } from '../utils/fs.ts';
import { log } from '../utils/logger.ts';
import { detectPackageManager } from '../utils/package-manager.ts';
import { p, unwrap } from '../utils/clack.ts';
import { run } from '../utils/shell.ts';
import readmeTemplate from '../../../../.bumpy/README.md';

const PM_RUNNER: Record<string, string> = {
  bun: 'bunx bumpy',
  pnpm: 'pnpm bumpy',
  yarn: 'yarn bumpy',
  npm: 'npx bumpy',
};

const PM_ADD_DEV: Record<string, string> = {
  bun: 'bun add -d',
  pnpm: 'pnpm add -Dw',
  yarn: 'yarn add -D -W',
  npm: 'npm install -D',
};

const PM_REMOVE: Record<string, string> = {
  bun: 'bun remove',
  pnpm: 'pnpm remove -w',
  yarn: 'yarn remove -W',
  npm: 'npm uninstall',
};

interface InitOptions {
  force?: boolean;
}

export async function initCommand(rootDir: string, opts: InitOptions = {}): Promise<void> {
  const bumpyDir = resolve(rootDir, '.bumpy');
  const changesetDir = resolve(rootDir, '.changeset');
  const hasChangeset = await exists(changesetDir);
  const hasBumpy = await exists(resolve(bumpyDir, '_config.json'));

  if (hasBumpy) {
    log.info("🐸 Detected .bumpy/ directory - looks like we're ready to go!");
    return;
  }

  const pm = await detectPackageManager(rootDir);

  if (!opts.force) {
    p.intro(pc.bgCyan(pc.black(' bumpy init ')));
  }

  // ── Migrate from changesets ──────────────────────────────────────────
  if (hasChangeset) {
    log.step('🦋 Detected .changeset/ directory — migrating to .bumpy/ 🐸');

    // Rename .changeset → .bumpy
    await rename(changesetDir, bumpyDir);
    log.dim('  Renamed .changeset/ → .bumpy/');

    // Migrate config.json → _config.json
    const oldConfigPath = resolve(bumpyDir, 'config.json');
    if (await exists(oldConfigPath)) {
      const csConfig = await readJson<Record<string, unknown>>(oldConfigPath);
      const bumpyConfig = migrateChangesetConfig(csConfig);
      await writeJson(resolve(bumpyDir, '_config.json'), bumpyConfig);
      await rm(oldConfigPath);
      log.dim('  Migrated config.json → _config.json');

      const migratedFields = Object.keys(bumpyConfig).filter((k) => k !== '$schema');
      if (migratedFields.length > 0) {
        log.dim('  Migrated fields: ' + migratedFields.join(', '));
      }
    } else {
      // No changeset config, write defaults
      await writeJson(resolve(bumpyDir, '_config.json'), makeDefaultConfig());
    }

    // Replace changeset README with bumpy README
    const readmeContent = readmeTemplate.replaceAll('bunx bumpy', PM_RUNNER[pm] || 'npx bumpy');
    await writeText(resolve(bumpyDir, 'README.md'), readmeContent);
    log.dim('  Replaced README.md');

    // Count pending changeset files (they're already compatible)
    const files = await readdir(bumpyDir);
    const pendingFiles = files.filter((f) => f.endsWith('.md') && f !== 'README.md');
    if (pendingFiles.length > 0) {
      log.dim(`  Kept ${pendingFiles.length} pending bump file(s)`);
    }

    // Check for changesets/cli and offer to uninstall
    const hasChangesetsCli = await isPackageInstalled(rootDir, '@changesets/cli');
    if (hasChangesetsCli) {
      if (opts.force) {
        await uninstallPackage(pm, '@changesets/cli', rootDir);
      } else {
        const shouldUninstall = unwrap(
          await p.confirm({
            message: 'Uninstall @changesets/cli?',
            initialValue: true,
          }),
        );
        if (shouldUninstall) {
          await uninstallPackage(pm, '@changesets/cli', rootDir);
        }
      }
    }

    // Scan GitHub workflows for changeset references
    await warnChangesetWorkflows(rootDir, pm);
  } else {
    // ── Fresh init ───────────────────────────────────────────────────────
    await ensureDir(bumpyDir);
    await writeJson(resolve(bumpyDir, '_config.json'), makeDefaultConfig());

    const readmeContent = readmeTemplate.replaceAll('bunx bumpy', PM_RUNNER[pm] || 'npx bumpy');
    await writeText(resolve(bumpyDir, 'README.md'), readmeContent);

    log.success('Initialized .bumpy/ directory');
    log.dim('  Created .bumpy/_config.json');
    log.dim('  Created .bumpy/README.md');
  }

  // ── Ensure @varlock/bumpy is installed ─────────────────────────────
  const hasBumpyPkg = await isPackageInstalled(rootDir, '@varlock/bumpy');
  if (!hasBumpyPkg) {
    if (opts.force) {
      await installPackage(pm, '@varlock/bumpy', rootDir);
    } else {
      const shouldInstall = unwrap(
        await p.confirm({
          message: 'Install @varlock/bumpy as a dev dependency?',
          initialValue: true,
        }),
      );
      if (shouldInstall) {
        await installPackage(pm, '@varlock/bumpy', rootDir);
      }
    }
  }

  if (!opts.force) {
    p.outro(pc.green('bumpy is ready!'));
  } else if (hasChangeset) {
    log.success('Migration complete!');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function makeDefaultConfig(): Record<string, unknown> {
  return {
    $schema: '../node_modules/@varlock/bumpy/config-schema.json',
    baseBranch: 'main',
    changelog: 'default',
  };
}

function migrateChangesetConfig(csConfig: Record<string, unknown>): Record<string, unknown> {
  const bumpyConfig: Record<string, unknown> = makeDefaultConfig();

  // Fields that map directly from changesets → bumpy
  const migrateableFields = [
    'baseBranch',
    'access',
    'fixed',
    'linked',
    'ignore',
    'updateInternalDependencies',
    'privatePackages',
  ] as const;

  for (const field of migrateableFields) {
    const value = csConfig[field];
    if (value === undefined) continue;
    // Skip empty arrays and values that match bumpy defaults — no need to clutter the config
    if (Array.isArray(value) && value.length === 0) continue;
    if (field === 'baseBranch' && value === 'main') continue;
    if (field === 'access' && value === 'public') continue;
    if (field === 'updateInternalDependencies' && value === 'out-of-range') continue;
    bumpyConfig[field] = value;
  }

  // Fields intentionally NOT migrated (changesets-only):
  // - commit, changelog, ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH, etc.

  return bumpyConfig;
}

async function isPackageInstalled(rootDir: string, pkgName: string): Promise<boolean> {
  try {
    const pkg = await readJson<Record<string, Record<string, string>>>(resolve(rootDir, 'package.json'));
    return !!(pkg.devDependencies?.[pkgName] || pkg.dependencies?.[pkgName]);
  } catch {
    return false;
  }
}

async function installPackage(pm: string, pkgName: string, rootDir: string): Promise<void> {
  const cmd = `${PM_ADD_DEV[pm] || 'npm install -D'} ${pkgName}`;
  log.step(`Installing ${pkgName}...`);
  try {
    run(cmd, { cwd: rootDir });
    log.dim(`  ${cmd}`);
  } catch (err) {
    log.warn(`Failed to install ${pkgName}: ${err instanceof Error ? err.message : err}`);
    log.dim(`  Run manually: ${cmd}`);
  }
}

async function uninstallPackage(pm: string, pkgName: string, rootDir: string): Promise<void> {
  const cmd = `${PM_REMOVE[pm] || 'npm uninstall'} ${pkgName}`;
  log.step(`Uninstalling ${pkgName}...`);
  try {
    run(cmd, { cwd: rootDir });
    log.dim(`  ${cmd}`);
  } catch (err) {
    log.warn(`Failed to uninstall ${pkgName}: ${err instanceof Error ? err.message : err}`);
    log.dim(`  Run manually: ${cmd}`);
  }
}

/** Patterns to detect in workflow files, with suggested replacements */
const CHANGESET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /changesets\/action/, replacement: 'see https://bumpy.varlock.dev/ci for bumpy CI setup' },
  { pattern: /changeset publish/, replacement: 'bumpy publish' },
  { pattern: /changeset version/, replacement: 'bumpy version' },
  { pattern: /changeset status/, replacement: 'bumpy status' },
  { pattern: /@changesets\//, replacement: 'replace with @varlock/bumpy' },
];

async function warnChangesetWorkflows(rootDir: string, pm: string): Promise<void> {
  const workflowDir = resolve(rootDir, '.github', 'workflows');
  if (!(await exists(workflowDir))) return;

  const files = await listFiles(workflowDir);
  const yamlFiles = files.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (yamlFiles.length === 0) return;

  const runner = PM_RUNNER[pm] || 'npx bumpy';
  const hits: Array<{ file: string; matches: Array<{ line: number; found: string; suggestion: string }> }> = [];

  for (const file of yamlFiles) {
    const content = await readText(resolve(workflowDir, file));
    const lines = content.split('\n');
    const fileMatches: Array<{ line: number; found: string; suggestion: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { pattern, replacement } of CHANGESET_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          fileMatches.push({ line: i + 1, found: match[0], suggestion: replacement });
        }
      }
    }

    if (fileMatches.length > 0) {
      hits.push({ file, matches: fileMatches });
    }
  }

  if (hits.length === 0) return;

  console.log();
  log.warn('Found changeset references in GitHub workflows:');
  for (const { file, matches } of hits) {
    log.dim(`  .github/workflows/${file}`);
    for (const { line, found, suggestion } of matches) {
      log.dim(`    L${line}: ${pc.red(found)}  →  ${pc.green(suggestion)}`);
    }
  }
  console.log();
  log.dim(`  Run ${pc.cyan(`${runner} ci setup`)} for help configuring CI workflows.`);
}
