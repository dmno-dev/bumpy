import { resolve } from 'node:path';
import { ensureDir, writeJson, writeText, exists } from '../utils/fs.ts';
import { log } from '../utils/logger.ts';
import { detectPackageManager } from '../utils/package-manager.ts';
import type { BumpyConfig } from '../types.ts';
import readmeTemplate from '../../../../.bumpy/README.md';

const PM_RUNNER: Record<string, string> = {
  bun: 'bunx bumpy',
  pnpm: 'pnpm bumpy',
  yarn: 'yarn bumpy',
  npm: 'npx bumpy',
};

export async function initCommand(rootDir: string): Promise<void> {
  const bumpyDir = resolve(rootDir, '.bumpy');

  if (await exists(resolve(bumpyDir, '_config.json'))) {
    log.warn('.bumpy/_config.json already exists');
    return;
  }

  await ensureDir(bumpyDir);

  // Write a minimal config (only non-default values would go here)
  const config: Partial<BumpyConfig> = {
    baseBranch: 'main',
    changelog: 'default',
  };
  await writeJson(resolve(bumpyDir, '_config.json'), config);

  // Write a README with commands tailored to the detected package manager
  const pm = await detectPackageManager(rootDir);
  const readmeContent = readmeTemplate.replaceAll('bunx bumpy', PM_RUNNER[pm] || 'npx bumpy');
  await writeText(resolve(bumpyDir, 'README.md'), readmeContent);

  log.success('Initialized .bumpy/ directory');
  log.dim('  Created .bumpy/_config.json');
  log.dim('  Created .bumpy/README.md');
}
