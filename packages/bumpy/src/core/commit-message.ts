import { resolve } from 'node:path';
import type { ReleasePlan } from '../types.ts';

/** Build the default version commit message */
function defaultCommitMessage(plan: ReleasePlan): string {
  return ['Version packages', '', ...plan.releases.map((r) => `${r.name}@${r.newVersion}`)].join('\n');
}

/** Resolve the commit message from config, falling back to the default */
export async function resolveCommitMessage(
  config: string | undefined,
  plan: ReleasePlan,
  rootDir: string,
): Promise<string> {
  if (!config) return defaultCommitMessage(plan);

  // Paths starting with "./" or "../" are treated as module paths
  if (config.startsWith('./') || config.startsWith('../')) {
    const fnPath = resolve(rootDir, config);
    const mod = await import(fnPath);
    const fn = mod.default ?? mod;
    if (typeof fn !== 'function') {
      throw new Error(`versionCommitMessage module "${config}" must export a function`);
    }
    return fn(plan);
  }

  // Otherwise it's a static message
  return config;
}
