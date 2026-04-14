import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureDir, exists, writeText } from "../utils/fs.ts";
import { log } from "../utils/logger.ts";

const SUPPORTED_TARGETS = ["opencode", "cursor", "codex"] as const;
type AiTarget = typeof SUPPORTED_TARGETS[number];

interface AiSetupOptions {
  target?: string;
}

export async function aiSetupCommand(rootDir: string, opts: AiSetupOptions): Promise<void> {
  const target = opts.target as AiTarget | undefined;

  if (!target) {
    log.error(`Please specify a target: bumpy ai setup --target <${SUPPORTED_TARGETS.join("|")}>`);
    log.dim("  Claude Code users: install the plugin instead — claude plugin install @dmno-dev/bumpy");
    process.exit(1);
  }

  if (!SUPPORTED_TARGETS.includes(target)) {
    log.error(`Unknown target: "${target}". Supported: ${SUPPORTED_TARGETS.join(", ")}`);
    process.exit(1);
  }

  // Read the prompt template bundled with bumpy
  const promptContent = await loadPromptTemplate();

  switch (target) {
    case "opencode":
      await setupOpenCode(rootDir, promptContent);
      break;
    case "cursor":
      await setupCursor(rootDir, promptContent);
      break;
    case "codex":
      await setupCodex(rootDir, promptContent);
      break;
  }
}

async function loadPromptTemplate(): Promise<string> {
  // The prompt file is the SKILL.md bundled with the plugin
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(thisDir, "../../skills/add-change/SKILL.md");
  const content = await readFile(promptPath, "utf-8");
  // Strip the YAML frontmatter (skill-specific metadata)
  return content.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
}

/** Install as an OpenCode custom command */
async function setupOpenCode(rootDir: string, promptContent: string): Promise<void> {
  const commandsDir = resolve(rootDir, ".opencode", "commands");
  const targetPath = resolve(commandsDir, "add-bumpy-change.md");

  await ensureDir(commandsDir);

  if (await exists(targetPath)) {
    log.warn(".opencode/commands/add-bumpy-change.md already exists — overwriting");
  }

  // OpenCode commands use frontmatter with description
  const openCodeContent = `---
description: Create a bumpy changeset to track package version bumps
---

${promptContent}`;

  await writeText(targetPath, openCodeContent);

  log.success("Installed OpenCode command");
  log.dim("  Created .opencode/commands/add-bumpy-change.md");
  log.dim("  Usage: type /add-bumpy-change in OpenCode");
}

/** Install as a Cursor rule */
async function setupCursor(rootDir: string, promptContent: string): Promise<void> {
  const rulesDir = resolve(rootDir, ".cursor", "rules");
  const targetPath = resolve(rulesDir, "add-bumpy-change.mdc");

  await ensureDir(rulesDir);

  if (await exists(targetPath)) {
    log.warn(".cursor/rules/add-bumpy-change.mdc already exists — overwriting");
  }

  // Cursor rules use .mdc format with frontmatter
  const cursorContent = `---
description: Create a bumpy changeset to track package version bumps
globs:
alwaysApply: false
---

${promptContent}`;

  await writeText(targetPath, cursorContent);

  log.success("Installed Cursor rule");
  log.dim("  Created .cursor/rules/add-bumpy-change.mdc");
  log.dim("  The rule will be suggested when relevant, or you can reference it manually");
}

/** Install as a Codex instruction */
async function setupCodex(rootDir: string, promptContent: string): Promise<void> {
  const targetPath = resolve(rootDir, ".codex", "add-bumpy-change.md");

  await ensureDir(resolve(rootDir, ".codex"));

  if (await exists(targetPath)) {
    log.warn(".codex/add-bumpy-change.md already exists — overwriting");
  }

  await writeText(targetPath, promptContent);

  log.success("Installed Codex instruction");
  log.dim("  Created .codex/add-bumpy-change.md");
  log.dim("  Reference this file in your AGENTS.md or pass it as context");
}
