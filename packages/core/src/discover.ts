/**
 * Session discovery: scan ~/.claude/projects/ for .jsonl session files and
 * build cheap picker metadata without a full parse.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionMeta } from './types.js';

export function getClaudeProjectsDir(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}


export function decodeProjectDir(dirName: string): string {
  return dirName.replace(/-/g, '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, '');
}

/** Cheap per-line scan: message count, first/last timestamps, first cwd. */
async function scanSessionFile(filePath: string, dirName: string): Promise<SessionMeta | null> {
  let content: string;
  let stats;
  try {
    content = await readFile(filePath, 'utf8');
    stats = await stat(filePath);
  } catch {
    return null;
  }

  const lines = content.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 3) return null;

  let messageCount = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let cwd: string | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const ts = typeof parsed['timestamp'] === 'string' ? Date.parse(parsed['timestamp']) : NaN;
    if (!Number.isNaN(ts)) {
      if (firstMs === null) firstMs = ts;
      lastMs = ts;
    }
    if (cwd === null && typeof parsed['cwd'] === 'string' && parsed['cwd'] !== '') {
      cwd = parsed['cwd'];
    }

    if (parsed['isSidechain'] === true) continue;
    const type = parsed['type'];
    if (type === 'assistant') {
      messageCount += 1;
    } else if (type === 'user') {
      // Tool-result carriers arrive as user lines; don't count them as messages.
      const message = isRecord(parsed['message']) ? parsed['message'] : null;
      const msgContent = message?.['content'];
      const isCarrier =
        Array.isArray(msgContent) &&
        msgContent.some((block) => isRecord(block) && block['type'] === 'tool_result');
      if (!isCarrier) messageCount += 1;
    }
  }

  return {
    filePath,
    sessionId: sessionIdFromPath(filePath),
    projectPath: cwd ?? decodeProjectDir(dirName),
    messageCount,
    durationMs: firstMs !== null && lastMs !== null ? lastMs - firstMs : null,
    mtimeMs: stats.mtimeMs,
  };
}

/** All project subdirectories under the projects dir, or [] if it doesn't exist. */
async function listProjectDirs(projectsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listJsonlFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath);
    return entries.filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

export async function discoverSessions(opts: { limit?: number } = {}): Promise<SessionMeta[]> {
  const projectsDir = getClaudeProjectsDir();
  const metas: SessionMeta[] = [];

  for (const dirName of await listProjectDirs(projectsDir)) {
    const dirPath = path.join(projectsDir, dirName);
    for (const fileName of await listJsonlFiles(dirPath)) {
      const meta = await scanSessionFile(path.join(dirPath, fileName), dirName);
      if (meta !== null) metas.push(meta);
    }
  }

  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? metas.slice(0, opts.limit) : metas;
}

/**
 * Resolve a session reference — a .jsonl file path, or a session uuid
 * (full or prefix) searched across all projects — to an absolute file path.
 */
export async function resolveSessionRef(ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw new Error('No session given — pass a .jsonl path or a session id.');
  }

  // Literal file path wins.
  try {
    const stats = await stat(trimmed);
    if (stats.isFile()) return path.resolve(trimmed);
  } catch {
    // not a path — fall through to uuid search
  }

  const projectsDir = getClaudeProjectsDir();
  const projectDirs = await listProjectDirs(projectsDir);
  if (projectDirs.length === 0) {
    throw new Error(
      `No Claude Code sessions found in ${projectsDir} — is Claude Code installed?`,
    );
  }

  const prefixMatches: string[] = [];
  const exactMatches: string[] = [];
  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsDir, dirName);
    for (const fileName of await listJsonlFiles(dirPath)) {
      const sessionId = sessionIdFromPath(fileName);
      if (sessionId === trimmed) exactMatches.push(path.join(dirPath, fileName));
      else if (sessionId.startsWith(trimmed)) prefixMatches.push(path.join(dirPath, fileName));
    }
  }

  const first = exactMatches[0];
  if (first !== undefined && exactMatches.length === 1) return first;
  if (exactMatches.length === 0 && prefixMatches.length === 1 && prefixMatches[0] !== undefined) {
    return prefixMatches[0];
  }

  const total = exactMatches.length + prefixMatches.length;
  if (total === 0) {
    throw new Error(
      `No session matching "${trimmed}" — pass a .jsonl path or a session id (a unique prefix works too).`,
    );
  }
  throw new Error(
    `Session id "${trimmed}" is ambiguous (${total} matches) — add more characters or pass the full path.`,
  );
}

const CROSS_SESSION_FILE_CAP = 20; // most-recent sibling sessions scanned
const CROSS_SESSION_SIZE_CAP = 20 * 1024 * 1024; // skip files over 20MB
const CROSS_SESSION_HITS_PER_FILE = 10; // occurrence cap per candidate per file

/**
 * Count reads of `candidatePaths` across OTHER sessions in the same project
 * directory — cheap substring line scan, hard-capped, best-effort. Counts
 * occurrences of the quoted path per sibling file (capped at 10 per file, so
 * one pathological session can't dominate), summed across files. Returns
 * undefined (never throws) when siblings are missing or the scan fails.
 */
export async function countCrossSessionReads(
  sessionFilePath: string,
  candidatePaths: string[],
  excludeSessionId: string,
): Promise<Record<string, number> | undefined> {
  if (candidatePaths.length === 0) return undefined;
  try {
    const dir = path.dirname(path.resolve(sessionFilePath));
    const entries = await readdir(dir, { withFileTypes: true });
    const siblings: Array<{ filePath: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      if (entry.name.startsWith(excludeSessionId)) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stats = await stat(filePath);
        if (stats.size > CROSS_SESSION_SIZE_CAP) continue;
        siblings.push({ filePath, mtimeMs: stats.mtimeMs });
      } catch {
        // unreadable sibling — skip silently
      }
    }
    if (siblings.length === 0) return undefined;

    siblings.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const counts: Record<string, number> = {};
    for (const sibling of siblings.slice(0, CROSS_SESSION_FILE_CAP)) {
      let text: string;
      try {
        text = await readFile(sibling.filePath, 'utf8');
      } catch {
        continue;
      }
      for (const candidate of candidatePaths) {
        // Quoted form avoids matching path fragments inside longer paths.
        const needle = `"${candidate}"`;
        let hits = 0;
        let at = text.indexOf(needle);
        while (at !== -1 && hits < CROSS_SESSION_HITS_PER_FILE) {
          hits += 1;
          at = text.indexOf(needle, at + needle.length);
        }
        // Absolute-path tool inputs won't match the relative form; try the
        // suffix form once per file as a fallback.
        if (hits === 0 && text.includes(`/${candidate}"`)) hits = 1;
        if (hits > 0) counts[candidate] = (counts[candidate] ?? 0) + hits;
      }
    }
    return Object.keys(counts).length > 0 ? counts : undefined;
  } catch {
    return undefined;
  }
}
