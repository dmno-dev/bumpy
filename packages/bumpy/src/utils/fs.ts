import { readFile, writeFile, readdir, unlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

export async function readJson<T = Record<string, unknown>>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

export async function writeJson(filePath: string, data: unknown, indent = 2): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, indent) + '\n', 'utf-8');
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
