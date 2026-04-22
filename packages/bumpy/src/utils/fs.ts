import { readFile, writeFile, readdir, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

export async function readJson<T = Record<string, unknown>>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export async function readJsonc<T = Record<string, unknown>>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return parseJsonc(content) as T;
}

export async function writeJson(filePath: string, data: unknown, indent = 2): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, indent) + '\n', 'utf-8');
}

/**
 * Update specific top-level string fields in a JSON file without reformatting.
 * Reads the raw text, does targeted regex replacements, and writes it back.
 */
export async function updateJsonFields(filePath: string, updates: Record<string, string>): Promise<void> {
  let content = await readFile(filePath, 'utf-8');
  for (const [key, newValue] of Object.entries(updates)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`("${escaped}"\\s*:\\s*)"[^"]*"`);
    content = content.replace(pattern, `$1"${newValue}"`);
  }
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Update a nested string field inside a top-level object in a JSON file without reformatting.
 * e.g., updateJsonNestedField(path, 'dependencies', 'core', '^2.0.0')
 */
export async function updateJsonNestedField(
  filePath: string,
  parentKey: string,
  childKey: string,
  newValue: string,
): Promise<void> {
  let content = await readFile(filePath, 'utf-8');
  const parentEscaped = parentKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const childEscaped = childKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Find the parent object block and replace the child value within it
  const parentPattern = new RegExp(
    `("${parentEscaped}"\\s*:\\s*\\{)([^}]*)\\}`,
    's', // dotAll so . matches newlines
  );
  content = content.replace(parentPattern, (match, prefix, body) => {
    const childPattern = new RegExp(`("${childEscaped}"\\s*:\\s*)"[^"]*"`);
    const newBody = body.replace(childPattern, `$1"${newValue}"`);
    return `${prefix}${newBody}}`;
  });
  await writeFile(filePath, content, 'utf-8');
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listFiles(dir: string, ext?: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    if (ext) return entries.filter((e) => e.endsWith(ext));
    return entries;
  } catch {
    return [];
  }
}

export async function removeFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export { join };
