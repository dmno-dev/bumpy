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
        await initCommand(rootDir);
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
        await versionCommand(rootDir);
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

      case 'migrate': {
        const rootDir = await findRoot();
        const { migrateCommand } = await import('./commands/migrate.ts');
        await migrateCommand(rootDir, {
          force: flags.force === true,
        });
        break;
      }

      case 'check': {
        const rootDir = await findRoot();
        const { checkCommand } = await import('./commands/check.ts');
        await checkCommand(rootDir);
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
            failOnMissing: ciFlags['fail-on-missing'] === true,
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
    init                    Initialize .bumpy/ directory
    add                     Create a new bump file
    generate                Generate bump file from conventional commits
    status                  Show pending releases
    check                   Verify changed packages have bump files (for pre-push hooks)
    version                 Apply bump files and bump versions
    publish                 Publish versioned packages
    ci check                PR check — report pending releases, comment on PR
    ci release              Release — create version PR or auto-publish
    ci setup                Set up a token for triggering CI on version PRs
    migrate                 Migrate from .changeset/ to .bumpy/
    ai setup                Install AI skill for creating bump files

  Add options:
    --packages <list>       Package bumps (e.g., "pkg-a:minor,pkg-b:patch")
    --message <text>        Bump file summary
    --name <name>           Bump file filename
    --empty                 Create an empty bump file

  Generate options:
    --from <ref>            Git ref to scan from (default: last version tag)
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
    --fail-on-missing       Exit 1 if no bump files found

  CI release options:
    --auto-publish          Version + publish directly (default: create version PR)
    --tag <tag>             npm dist-tag for auto-publish
    --branch <name>         Branch name for version PR (default: bumpy/version-packages)

  AI setup options:
    --target <tool>         Target AI tool: opencode, cursor, codex

  ${colorize(__BUMPY_WEBSITE_URL__, 'dim')}
`);
}

main();
