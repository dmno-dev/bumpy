import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import pc from 'picocolors';
import { log } from '../utils/logger.ts';
import { readJson, readText, exists } from '../utils/fs.ts';
import { getBumpyDir } from '../core/config.ts';
import { writeBumpFile } from '../core/bump-file.ts';
import { p, unwrap } from '../utils/clack.ts';
import { initCommand } from './init.ts';
import type { BumpFileRelease, BumpTypeWithNone } from '../types.ts';

interface MigrateOptions {
  force?: boolean;
}

export async function migrateCommand(rootDir: string, opts: MigrateOptions): Promise<void> {
  const changesetDir = resolve(rootDir, '.changeset');

  if (!(await exists(changesetDir))) {
    log.error('No .changeset/ directory found. Nothing to migrate.');
    process.exit(1);
  }

  const bumpyDir = getBumpyDir(rootDir);
  const bumpyExists = await exists(resolve(bumpyDir, '_config.json'));

  // Step 1: Migrate config
  if (!bumpyExists) {
    log.step('Initializing .bumpy/ directory...');
    await initCommand(rootDir);
  }

  const changesetConfigPath = resolve(changesetDir, 'config.json');
  if (await exists(changesetConfigPath)) {
    log.step('Migrating config from .changeset/config.json...');
    await migrateConfig(changesetConfigPath, bumpyDir);
  }

  // Step 2: Migrate pending changeset files to bump files
  const files = await readdir(changesetDir);
  const mdFiles = files.filter((f) => f.endsWith('.md') && f !== 'README.md');

  if (mdFiles.length > 0) {
    log.step(`Migrating ${mdFiles.length} pending changeset(s) to bump files...`);
    let migrated = 0;
    for (const file of mdFiles) {
      const content = await readText(resolve(changesetDir, file));
      const result = parseChangesetFile(content);
      if (!result) {
        log.warn(`  Skipped ${file} (could not parse)`);
        continue;
      }

      const name = file.replace(/\.md$/, '');
      const targetPath = resolve(bumpyDir, file);
      if (await exists(targetPath)) {
        log.dim(`  Skipped ${file} (already exists in .bumpy/)`);
        continue;
      }

      // Write in bumpy format (which is the same, but let's go through our writer for consistency)
      await writeBumpFile(rootDir, name, result.releases, result.summary);
      migrated++;
      log.dim(`  Migrated ${file}`);
    }
    log.success(`Migrated ${migrated} bump file(s)`);
  } else {
    log.info('No pending changesets to migrate.');
  }

  // Step 3: Offer to clean up
  if (!opts.force) {
    p.intro(pc.bgCyan(pc.black(' bumpy migrate ')));
    const shouldCleanup = unwrap(
      await p.confirm({
        message: 'Remove .changeset/ directory?',
        initialValue: false,
      }),
    );
    if (shouldCleanup) {
      const spin = p.spinner();
      spin.start('Removing .changeset/');
      const { rm } = await import('node:fs/promises');
      await rm(changesetDir, { recursive: true });
      spin.stop('Removed .changeset/ directory');
    } else {
      p.log.info('Keeping .changeset/ — you can remove it manually when ready.');
    }
    p.outro(pc.green('Cleanup complete'));
  }

  console.log();
  log.success('Migration complete!');
  log.dim('Review .bumpy/_config.json and adjust settings as needed.');
  log.dim('Key differences from changesets:');
  log.dim('  - Out-of-range peer dep bumps match the triggering bump level (not always major)');
  log.dim("  - Use 'none' in a bump file to suppress a propagated bump");
  log.dim('  - Per-package config goes in package.json["bumpy"]');
}

async function migrateConfig(changesetConfigPath: string, bumpyDir: string): Promise<void> {
  const csConfig = await readJson<Record<string, unknown>>(changesetConfigPath);
  const bumpyConfigPath = resolve(bumpyDir, '_config.json');
  let bumpyConfig: Record<string, unknown> = {};

  if (await exists(bumpyConfigPath)) {
    bumpyConfig = await readJson<Record<string, unknown>>(bumpyConfigPath);
  }

  // Map changesets config fields to bumpy equivalents (changesets values win over defaults)
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
    if (csConfig[field] !== undefined) {
      bumpyConfig[field] = csConfig[field];
    }
  }

  // Note: changesets' commit, changelog, ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH, etc. are not migrated
  // The user should configure these manually

  const { writeJson } = await import('../utils/fs.ts');
  await writeJson(bumpyConfigPath, bumpyConfig);
  log.dim(
    '  Migrated config fields: ' +
      Object.keys(bumpyConfig)
        .filter((k) => k !== 'baseBranch' || bumpyConfig[k] !== 'main')
        .join(', '),
  );
}

/** Parse a changesets-format markdown file */
function parseChangesetFile(content: string): { releases: BumpFileRelease[]; summary: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!.trim();
  const summary = match[2]!.trim();

  if (!frontmatter) return null;

  const releases: BumpFileRelease[] = [];
  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Changesets format: "package-name": bump-type  OR  package-name: bump-type
    // The quotes are optional in changesets
    const lineMatch = trimmed.match(/^"?([^"]+)"?\s*:\s*(.+)$/);
    if (!lineMatch) continue;

    const name = lineMatch[1]!.trim();
    const type = lineMatch[2]!.trim();

    // Changesets supports "none" which we don't — skip those
    if (type === 'none') continue;

    if (['major', 'minor', 'patch'].includes(type)) {
      releases.push({ name, type: type as BumpTypeWithNone });
    }
  }

  if (releases.length === 0 && !summary) return null;
  return { releases, summary };
}
