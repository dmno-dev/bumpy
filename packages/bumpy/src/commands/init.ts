import { resolve } from 'node:path';
import { ensureDir, writeJson, writeText, exists } from '../utils/fs.ts';
import { log } from '../utils/logger.ts';
import type { BumpyConfig } from '../types.ts';

export async function initCommand(rootDir: string): Promise<void> {
  const bumpyDir = resolve(rootDir, '.bumpy');

  if (await exists(resolve(bumpyDir, 'config.json'))) {
    log.warn('.bumpy/config.json already exists');
    return;
  }

  await ensureDir(bumpyDir);

  // Write a minimal config (only non-default values would go here)
  const config: Partial<BumpyConfig> = {
    baseBranch: 'main',
    changelog: 'default',
  };
  await writeJson(resolve(bumpyDir, 'config.json'), config);

  // Write a README explaining the directory
  await writeText(
    resolve(bumpyDir, 'README.md'),
    `# Bumpy\n\nThis directory is used by [bumpy](https://github.com/dmno-dev/bumpy) to manage versioning.\n\nChangeset files (\`.md\`) in this directory describe pending version bumps.\nRun \`bumpy add\` to create a new changeset.\n`,
  );

  log.success('Initialized .bumpy/ directory');
  log.dim('  Created .bumpy/config.json');
  log.dim('  Created .bumpy/README.md');
}
