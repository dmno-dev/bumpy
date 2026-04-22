import { test, expect, describe } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeJson, readJson, writeText, readText, ensureDir, exists } from '../../src/utils/fs.ts';
import { initCommand } from '../../src/commands/init.ts';

describe('init command with changeset migration', () => {
  let tmpDir: string;

  test('migrates .changeset/ to .bumpy/ by renaming', async () => {
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

    // Create changeset files
    await writeText(
      resolve(tmpDir, '.changeset/cool-feature.md'),
      `---\n"@test/core": minor\n"@test/utils": patch\n---\n\nAdded cool feature\n`,
    );
    await writeText(resolve(tmpDir, '.changeset/fix-bug.md'), `---\n"@test/utils": patch\n---\n\nFixed a bug\n`);

    // Run init (force to skip interactive prompts)
    await initCommand(tmpDir, { force: true });

    // .changeset/ should be gone (renamed to .bumpy/)
    expect(await exists(resolve(tmpDir, '.changeset'))).toBe(false);

    // .bumpy/ should exist with _config.json
    expect(await exists(resolve(tmpDir, '.bumpy/_config.json'))).toBe(true);

    // Old config.json should be removed
    expect(await exists(resolve(tmpDir, '.bumpy/config.json'))).toBe(false);

    // Check config was migrated (compatible fields kept, changesets-only fields dropped)
    const config = await readJson<Record<string, unknown>>(resolve(tmpDir, '.bumpy/_config.json'));
    expect(config.baseBranch).toBe('develop');
    expect(config.access).toBe('restricted');
    expect(config.ignore).toEqual(['@test/internal']);
    expect(config.fixed).toEqual([['@test/core', '@test/types']]);
    // 'commit' is changesets-only and should NOT be migrated
    expect(config.commit).toBeUndefined();

    // Pending changeset files should be kept as-is
    expect(await exists(resolve(tmpDir, '.bumpy/cool-feature.md'))).toBe(true);
    expect(await exists(resolve(tmpDir, '.bumpy/fix-bug.md'))).toBe(true);

    // Verify content is preserved
    const content = await readText(resolve(tmpDir, '.bumpy/cool-feature.md'));
    expect(content).toContain('@test/core');
    expect(content).toContain('minor');
    expect(content).toContain('Added cool feature');

    // README should be bumpy's, not changesets'
    const readme = await readText(resolve(tmpDir, '.bumpy/README.md'));
    expect(readme).toContain('bumpy');

    await rm(tmpDir, { recursive: true });
  });

  test('fresh init when no .changeset/ exists', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-init-'));

    await writeJson(resolve(tmpDir, 'package.json'), {
      name: 'test-monorepo',
      private: true,
      workspaces: ['packages/*'],
    });

    await initCommand(tmpDir, { force: true });

    expect(await exists(resolve(tmpDir, '.bumpy/_config.json'))).toBe(true);
    expect(await exists(resolve(tmpDir, '.bumpy/README.md'))).toBe(true);

    const config = await readJson<Record<string, unknown>>(resolve(tmpDir, '.bumpy/_config.json'));
    expect(config.baseBranch).toBe('main');
    expect(config.changelog).toBe('default');

    await rm(tmpDir, { recursive: true });
  });

  test('skips if .bumpy/_config.json already exists', async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'bumpy-init-'));

    await writeJson(resolve(tmpDir, 'package.json'), {
      name: 'test-monorepo',
      private: true,
      workspaces: ['packages/*'],
    });

    await ensureDir(resolve(tmpDir, '.bumpy'));
    await writeJson(resolve(tmpDir, '.bumpy/_config.json'), { baseBranch: 'main' });

    // Should not throw, just warn and return
    await initCommand(tmpDir, { force: true });

    // Config should be unchanged
    const config = await readJson<Record<string, unknown>>(resolve(tmpDir, '.bumpy/_config.json'));
    expect(config.baseBranch).toBe('main');
    expect(config.changelog).toBeUndefined(); // wasn't added since we returned early

    await rm(tmpDir, { recursive: true });
  });
});
