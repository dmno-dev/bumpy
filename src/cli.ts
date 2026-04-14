#!/usr/bin/env node

import { findRoot } from "./core/config.ts";
import { log } from "./utils/logger.ts";

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
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
      case "init": {
        const rootDir = await findRoot();
        const { initCommand } = await import("./commands/init.ts");
        await initCommand(rootDir);
        break;
      }

      case "add": {
        const rootDir = await findRoot();
        const { addCommand } = await import("./commands/add.ts");
        await addCommand(rootDir, {
          packages: flags.packages as string | undefined,
          message: flags.message as string | undefined,
          name: flags.name as string | undefined,
          empty: flags.empty === true,
        });
        break;
      }

      case "status": {
        const rootDir = await findRoot();
        const { statusCommand } = await import("./commands/status.ts");
        await statusCommand(rootDir, {
          json: flags.json === true,
          packagesOnly: flags.packages === true,
          bumpType: flags.bump as string | undefined,
          filter: flags.filter as string | undefined,
          verbose: flags.verbose === true,
        });
        break;
      }

      case "version": {
        const rootDir = await findRoot();
        const { versionCommand } = await import("./commands/version.ts");
        await versionCommand(rootDir);
        break;
      }

      case "migrate": {
        const rootDir = await findRoot();
        const { migrateCommand } = await import("./commands/migrate.ts");
        await migrateCommand(rootDir, {
          force: flags.force === true,
        });
        break;
      }

      case "publish": {
        const rootDir = await findRoot();
        const { publishCommand } = await import("./commands/publish.ts");
        await publishCommand(rootDir, {
          dryRun: flags["dry-run"] === true,
          tag: flags.tag as string | undefined,
          noPush: flags["no-push"] === true,
        });
        break;
      }

      case "help":
      case "--help":
      case "-h":
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
  ${log.bold ? "" : ""}bumpy - Modern monorepo versioning

  Usage: bumpy <command> [options]

  Commands:
    init                    Initialize .bumpy/ directory
    add                     Create a new changeset
    status                  Show pending releases
    version                 Apply changesets and bump versions
    publish                 Publish versioned packages
    migrate                 Migrate from .changeset/ to .bumpy/

  Add options:
    --packages <list>       Package bumps (e.g., "pkg-a:minor,pkg-b:patch")
    --message <text>        Changeset summary
    --name <name>           Changeset filename
    --empty                 Create an empty changeset

  Status options:
    --json                  Output as JSON (includes dirs, changesets, packageNames)
    --packages              Output only package names, one per line
    --bump <types>          Filter by bump type (e.g., "major", "minor,patch")
    --filter <names>        Filter by package name/glob (e.g., "@myorg/*")
    --verbose               Show changeset details

  Publish options:
    --dry-run               Preview without publishing
    --tag <tag>             npm dist-tag (e.g., "next", "beta")
    --no-push               Skip pushing git tags to remote
`);
}

main();
