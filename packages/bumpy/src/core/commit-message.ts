import { resolve } from 'node:path';
import type { ReleasePlan, VersionCommitMessageConfig } from '../types.ts';

/** Build the default version commit message */
function defaultCommitMessage(plan: ReleasePlan): string {
  return ['Version packages', '', ...plan.releases.map((r) => `${r.name}@${r.newVersion}`)].join('\n');
}

/** Resolve the commit message from config, falling back to the default */
export async function resolveCommitMessage(
  config: string | VersionCommitMessageConfig | undefined,
  plan: ReleasePlan,
  rootDir: string,
): Promise<string> {
  if (!config) return defaultCommitMessage(plan);

  if (typeof config === 'string') return config;

  if (config.message) return config.message;

  if (config.generateFn) {
    const fnPath = resolve(rootDir, config.generateFn);
    const mod = await import(fnPath);
    const fn = mod.default ?? mod;
    if (typeof fn !== 'function') {
      throw new Error(`versionCommitMessage.generateFn module "${config.generateFn}" must export a function`);
    }
    return fn(plan);
  }

  return defaultCommitMessage(plan);
}
