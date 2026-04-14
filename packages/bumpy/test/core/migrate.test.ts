import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, readJson, writeText, readText, ensureDir, exists } from '../../src/utils/fs.ts';
import { migrateCommand } from '../../src/commands/migrate.ts';

describe('migrate command', () => {
  let tmpDir: string;

  test('migrates changeset files to .bumpy/', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-migrate-'));

    // Set up a fake monorepo with .changeset/
    await writeJson(resolve(tmpDir, 'package.json'), {
      name: 'test-monorepo',
      private: true,
      workspaces: ['packages/*'],
    });

    await ensureDir(resolve(tmpDir, '.changeset'));
    await writeJson(resolve(tmpDir, '.changeset/config.json'), {
      baseBranch: 'develop',
      access: 'restricted',
      commit: true,
      ignore: ['@test/internal'],
      fixed: [['@test/core', '@test/types']],
    });

    // Create a changeset file
    await writeText(
      resolve(tmpDir, '.changeset/cool-feature.md'),
      `---\n"@test/core": minor\n"@test/utils": patch\n---\n\nAdded cool feature\n`,
    );

    // Create another changeset
    await writeText(resolve(tmpDir, '.changeset/fix-bug.md'), `---\n"@test/utils": patch\n---\n\nFixed a bug\n`);

    // Run migration (force to skip interactive cleanup prompt)
    await migrateCommand(tmpDir, { force: true });

    // Check .bumpy/ was created
    expect(await exists(resolve(tmpDir, '.bumpy/_config.json'))).toBe(true);

    // Check config was migrated
    const config = await readJson<Record<string, unknown>>(resolve(tmpDir, '.bumpy/_config.json'));
    expect(config.baseBranch).toBe('develop');
    expect(config.access).toBe('restricted');
    expect(config.commit).toBe(true);
    expect(config.ignore).toEqual(['@test/internal']);
    expect(config.fixed).toEqual([['@test/core', '@test/types']]);

    // Check changeset files were migrated
    expect(await exists(resolve(tmpDir, '.bumpy/cool-feature.md'))).toBe(true);
    expect(await exists(resolve(tmpDir, '.bumpy/fix-bug.md'))).toBe(true);

    // Verify the content is parseable
    const content = await readText(resolve(tmpDir, '.bumpy/cool-feature.md'));
    expect(content).toContain('@test/core');
    expect(content).toContain('minor');
    expect(content).toContain('Added cool feature');

    await rm(tmpDir, { recursive: true });
  });

  test("skips changesets with 'none' bump type", async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-migrate-'));

    await writeJson(resolve(tmpDir, 'package.json'), {
      name: 'test-monorepo',
      private: true,
      workspaces: ['packages/*'],
    });

    await ensureDir(resolve(tmpDir, '.changeset'));
    await writeJson(resolve(tmpDir, '.changeset/config.json'), {});

    // Changeset with "none" type (changesets supports this, we don't)
    await writeText(resolve(tmpDir, '.changeset/no-bump.md'), `---\n"@test/docs": none\n---\n\nDocs only change\n`);

    await migrateCommand(tmpDir, { force: true });

    // The file should still be created but with no releases (or skipped)
    // Our parser skips "none" entries, so if the only entry is none, it gets skipped
    const bumpyDir = resolve(tmpDir, '.bumpy');
    expect(await exists(bumpyDir)).toBe(true);

    await rm(tmpDir, { recursive: true });
  });
});
