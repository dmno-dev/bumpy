import { resolve } from "node:path";
import yaml from "js-yaml";
import { readText, writeText, listFiles, removeFile } from "../utils/fs.ts";
import { getBumpyDir } from "./config.ts";
import type {
  Changeset,
  ChangesetRelease,
  ChangesetReleaseCascade,
  BumpType,
  BumpTypeWithIsolated,
} from "../types.ts";

/** Read all changeset files from .bumpy/ directory */
export async function readChangesets(rootDir: string): Promise<Changeset[]> {
  const dir = getBumpyDir(rootDir);
  const files = await listFiles(dir, ".md");
  const changesets: Changeset[] = [];
  for (const file of files) {
    if (file === "README.md") continue;
    const cs = await parseChangesetFile(resolve(dir, file));
    if (cs) changesets.push(cs);
  }
  return changesets;
}

/** Parse a single changeset markdown file */
export async function parseChangesetFile(filePath: string): Promise<Changeset | null> {
  const content = await readText(filePath);
  return parseChangeset(content, fileToId(filePath));
}

/** Parse changeset content (for testing) */
export function parseChangeset(content: string, id: string): Changeset | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const summary = match[2]!.trim();

  const parsed = yaml.load(frontmatter) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") return null;

  const releases: ChangesetRelease[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      // Simple format: "pkg-name": minor
      releases.push({ name, type: value as BumpTypeWithIsolated });
    } else if (value && typeof value === "object") {
      // Nested format: "pkg-name": { bump: minor, cascade: { ... } }
      const obj = value as { bump: BumpTypeWithIsolated; cascade?: Record<string, BumpType> };
      const release: ChangesetReleaseCascade = {
        name,
        type: obj.bump,
        cascade: obj.cascade || {},
      };
      releases.push(release);
    }
  }

  if (releases.length === 0) return null;
  return { id, releases, summary };
}

/** Write a changeset file */
export async function writeChangeset(
  rootDir: string,
  filename: string,
  releases: ChangesetRelease[],
  summary: string,
): Promise<string> {
  const dir = getBumpyDir(rootDir);
  const filePath = resolve(dir, `${filename}.md`);

  // Build frontmatter object
  const frontmatter: Record<string, unknown> = {};
  for (const release of releases) {
    if ("cascade" in release && Object.keys(release.cascade).length > 0) {
      frontmatter[release.name] = { bump: release.type, cascade: release.cascade };
    } else {
      frontmatter[release.name] = release.type;
    }
  }

  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1, quotingType: '"' }).trim();
  const content = `---\n${yamlStr}\n---\n\n${summary}\n`;
  await writeText(filePath, content);
  return filePath;
}

/** Delete consumed changeset files */
export async function deleteChangesets(rootDir: string, ids: string[]): Promise<void> {
  const dir = getBumpyDir(rootDir);
  for (const id of ids) {
    await removeFile(resolve(dir, `${id}.md`));
  }
}

function fileToId(filePath: string): string {
  const base = filePath.split("/").pop()!;
  return base.replace(/\.md$/, "");
}
