#!/usr/bin/env node

import { findRoot } from './core/config.ts';
import { log, colorize } from './utils/logger.ts';

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags(args.slice(1));

  try {
    switch (command) {
      case 'init': {
        const rootDir = await findRoot();
        const { initCommand } = await import('./commands/init.ts');
        await initCommand(rootDir, {
          force: flags.force === true,
        });
        break;
      }

      case 'add': {
        const rootDir = await findRoot();
        const { addCommand } = await import('./commands/add.ts');
        await addCommand(rootDir, {
          packages: flags.packages as string | undefined,
          message: flags.message as string | undefined,
          name: flags.name as string | undefined,
          empty: flags.empty === true,
          none: flags.none === true,
        });
        break;
      }

      case 'status': {
        const rootDir = await findRoot();
        const { statusCommand } = await import('./commands/status.ts');
        await statusCommand(rootDir, {
          json: flags.json === true,
          packagesOnly: flags.packages === true,
          bumpType: flags.bump as string | undefined,
          filter: flags.filter as string | undefined,
          verbose: flags.verbose === true,
        });
        break;
      }

      case 'version': {
        const rootDir = await findRoot();
        const { versionCommand } = await import('./commands/version.ts');
        await versionCommand(rootDir, {
          commit: flags.commit === true,
        });
        break;
      }

      case 'generate': {
        const rootDir = await findRoot();
        const { generateCommand } = await import('./commands/generate.ts');
        await generateCommand(rootDir, {
          from: flags.from as string | undefined,
          dryRun: flags['dry-run'] === true,
          name: flags.name as string | undefined,
        });
        break;
      }

      case 'check': {
        const rootDir = await findRoot();
        const { checkCommand } = await import('./commands/check.ts');
        const hookValue = flags.hook as string | undefined;
        if (hookValue && hookValue !== 'pre-commit' && hookValue !== 'pre-push') {
          log.error(`Invalid --hook value "${hookValue}". Expected "pre-commit" or "pre-push".`);
          process.exit(1);
        }
        await checkCommand(rootDir, {
          strict: flags.strict === true,
          noFail: flags['no-fail'] === true,
          hook: hookValue as 'pre-commit' | 'pre-push' | undefined,
        });
        break;
      }

      case 'ci': {
        const rootDir = await findRoot();
        const subcommand = args[1];
        const ciFlags = parseFlags(args.slice(2));

        if (subcommand === 'check') {
          const { ciCheckCommand } = await import('./commands/ci.ts');
          await ciCheckCommand(rootDir, {
            comment: ciFlags.comment !== undefined ? ciFlags.comment === true : undefined,
            strict: ciFlags.strict === true,
            noFail: ciFlags['no-fail'] === true,
          });
        } else if (subcommand === 'release') {
          const { ciReleaseCommand } = await import('./commands/ci.ts');
          const mode = ciFlags['auto-publish'] === true ? ('auto-publish' as const) : ('version-pr' as const);
          await ciReleaseCommand(rootDir, {
            mode,
            tag: ciFlags.tag as string | undefined,
            branch: ciFlags.branch as string | undefined,
          });
        } else if (subcommand === 'setup') {
          const { ciSetupCommand } = await import('./commands/ci-setup.ts');
          await ciSetupCommand(rootDir);
        } else {
          log.error(`Unknown ci subcommand: ${subcommand}. Use "ci check", "ci release", or "ci setup".`);
          process.exit(1);
        }
        break;
      }

      case 'publish': {
        const rootDir = await findRoot();
        const { publishCommand } = await import('./commands/publish.ts');
        await publishCommand(rootDir, {
          dryRun: flags['dry-run'] === true,
          tag: flags.tag as string | undefined,
          noPush: flags['no-push'] === true,
          filter: flags.filter as string | undefined,
        });
        break;
      }

      case 'ai': {
        const rootDir = await findRoot();
        const subcommand = args[1];
        const aiFlags = parseFlags(args.slice(2));

        if (subcommand === 'setup') {
          const { aiSetupCommand } = await import('./commands/ai.ts');
          await aiSetupCommand(rootDir, {
            target: aiFlags.target as string | undefined,
          });
        } else {
          log.error(`Unknown ai subcommand: ${subcommand}. Use "ai setup".`);
          process.exit(1);
        }
        break;
      }

      case '--version':
      case '-v':
        console.log(`bumpy ${__BUMPY_VERSION__}`);
        break;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        printHelp();
        break;

      default:
        log.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
  ${colorize(`🐸 bumpy v${__BUMPY_VERSION__}`, 'bold')} - Modern monorepo versioning

  Usage: bumpy <command> [options]

  Commands:
    init [--force]          Initialize .bumpy/ (migrates from .changeset/ if found)
    add                     Create a new bump file
      --none                  Set all changed packages to "none" (acknowledge without bumping)
      --empty                 Create an empty bump file (no releases needed)
    generate                Generate bump file from branch commits
    status                  Show pending releases
    check                   Verify changed packages have bump files (for git hooks)
      --strict                Fail if any changed package is uncovered (default: only fail if no bump files at all)
      --no-fail               Warn only, never exit 1
      --hook <context>        Hook context: "pre-commit" or "pre-push" (controls which bump files count)
    version [--commit]      Apply bump files and bump versions
    publish                 Publish versioned packages
    ci check                PR check — report pending releases, comment on PR
    ci release              Release — create version PR or auto-publish
    ci setup                Set up a token for triggering CI on version PRs
    ai setup                Install AI skill for creating bump files

  Add options:
    --packages <list>       Package bumps (e.g., "pkg-a:minor,pkg-b:patch")
    --message <text>        Bump file summary
    --name <name>           Bump file filename
    --empty                 Create an empty bump file

  Generate options:
    --from <ref>            Git ref to scan from (default: branch point from baseBranch)
    --dry-run               Preview without creating a bump file
    --name <name>           Bump file filename

  Status options:
    --json                  Output as JSON (includes dirs, bumpFiles, packageNames)
    --packages              Output only package names, one per line
    --bump <types>          Filter by bump type (e.g., "major", "minor,patch")
    --filter <names>        Filter by package name/glob (e.g., "@myorg/*")
    --verbose               Show bump file details

  Publish options:
    --dry-run               Preview without publishing
    --tag <tag>             npm dist-tag (e.g., "next", "beta")
    --no-push               Skip pushing git tags to remote
    --filter <names>        Publish only matching packages (e.g., "@myorg/*")

  CI check options:
    --comment               Force PR comment on/off (auto-detected in CI)
    --strict                Fail if any changed package is uncovered (default: only fail if no bump files at all)
    --no-fail               Warn only, never exit 1

  CI release options:
    --auto-publish          Version + publish directly (default: create version PR)
    --tag <tag>             npm dist-tag for auto-publish
    --branch <name>         Branch name for version PR (default: bumpy/version-packages)

  AI setup options:
    --target <tool>         Target AI tool: claude, opencode, cursor, codex

  ${colorize('https://bumpy.varlock.dev', 'dim')}
`);
}

main();
