import { runAsync, runStreaming, sq } from '../../utils/shell.ts';
import { log } from '../../utils/logger.ts';
import type { PublishTargetPlugin } from './types.ts';

/**
 * The "custom" target: user-supplied shell command(s), the declarative escape hatch
 * for registries without a built-in target. Also what the legacy `publishCommand` /
 * `checkPublished` package fields map onto.
 *
 * Options:
 * - `command` (string | string[], required) — publish command(s); `{{name}}` and
 *   `{{version}}` are substituted (shell-quoted)
 * - `checkPublished` (string) — command printing the currently published version
 *
 * Capabilities are wide open — the user's command owns the semantics, so bumpy
 * doesn't second-guess prereleases or snapshots here.
 */
export const customTarget: PublishTargetPlugin = {
  type: 'custom',
  capabilities: { distTags: false, prereleases: true, snapshots: true },

  needsProtocolResolution() {
    // Custom commands read the manifest straight from the package dir
    return true;
  },

  async checkPublished(_pkg, version, options) {
    const cmd = options.checkPublished;
    if (typeof cmd !== 'string' || !cmd) return null; // unknown — caller falls back to git tags
    try {
      const result = await runAsync(cmd);
      return result.trim() === version;
    } catch {
      return false;
    }
  },

  async publish(ctx) {
    const raw = ctx.options.command ?? ctx.options.publishCommand;
    const commands = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    if (commands.length === 0) {
      throw new Error(`custom target "${ctx.pkg.name}" has no "command" configured`);
    }

    for (const cmd of commands) {
      // Shell-quote substituted values to prevent injection via package names/versions
      const expanded = String(cmd)
        .replace(/\{\{version\}\}/g, sq(ctx.version))
        .replace(/\{\{name\}\}/g, sq(ctx.pkg.name));
      log.dim(`  Running: ${expanded}`);
      if (!ctx.dryRun) {
        await runStreaming(expanded, { cwd: ctx.pkg.dir });
      }
    }
  },
};
