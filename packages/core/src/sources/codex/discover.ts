/**
 * Codex CLI session discovery.
 *
 * Rollouts live in ~/.codex/sessions/YYYY/MM/DD/, so unlike Claude Code the
 * directory says *when* a session ran, never which project it belonged to.
 * The project comes from the first line of the file, which is always
 * `session_meta` and carries `cwd` — cheap enough to read for every candidate,
 * and the only reason a picker row can name a project at all.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionMeta, SessionRef } from '../../types.js';
import { sessionIdFromPath } from './parser.js';

export function getCodexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
}

export function getCodexSessionsDir(): string {
  return path.join(getCodexHome(), 'sessions');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every rollout under the date tree, without walking it twice. */
async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(dir, 0);
  return out;
}

/** The first line only — a rollout can reach 19MB and we want one field. */
async function firstLine(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    await handle.close();
  }
}

/** `id → thread_name`: the name Codex itself gave the session. */
export async function readTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const text = await readFile(path.join(getCodexHome(), 'session_index.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) continue;
        const id = parsed['id'];
        const name = parsed['thread_name'];
        if (typeof id === 'string' && typeof name === 'string' && name !== '') titles.set(id, name);
      } catch {
        // A bad index line costs a title, not a session.
      }
    }
  } catch {
    // No index: every session simply goes untitled.
  }
  return titles;
}

async function scanRollout(filePath: string, titles: Map<string, string>): Promise<SessionMeta | null> {
  let stats;
  let head: string;
  try {
    stats = await stat(filePath);
    head = await firstLine(filePath);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed['type'] !== 'session_meta') return null;
  const payload = isRecord(parsed['payload']) ? parsed['payload'] : null;
  if (payload === null) return null;

  const sessionId = typeof payload['id'] === 'string' ? payload['id'] : sessionIdFromPath(filePath);
  const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : '';

  // Counting messages means reading the file, so the picker's message count and
  // duration come from a full scan — the same trade the Claude reader makes.
  const detail = await scanBody(filePath);
  if (detail === null) return null;

  return {
    filePath,
    sessionId,
    agent: 'codex',
    projectPath: cwd,
    title: titles.get(sessionId) ?? null,
    messageCount: detail.messageCount,
    durationMs: detail.durationMs,
    mtimeMs: stats.mtimeMs,
  };
}

/** Message count and span, counting only what a person would call a message. */
async function scanBody(filePath: string): Promise<{ messageCount: number; durationMs: number | null } | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  let messageCount = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
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
    const payload = isRecord(parsed['payload']) ? parsed['payload'] : null;
    const payloadType = payload === null ? null : payload['type'];
    // event_msg only: the response_item copies of the same text are the model's
    // view of the conversation, preamble and all.
    if (parsed['type'] === 'event_msg' && (payloadType === 'user_message' || payloadType === 'agent_message')) {
      messageCount += 1;
    }
  }
  if (messageCount === 0) return null;
  return { messageCount, durationMs: firstMs !== null && lastMs !== null ? lastMs - firstMs : null };
}

export async function discoverCodexSessions(opts: { limit?: number } = {}): Promise<SessionMeta[]> {
  const titles = await readTitles();
  const files = await listRollouts(getCodexSessionsDir());
  const metas: SessionMeta[] = [];
  for (const filePath of files) {
    const meta = await scanRollout(filePath, titles);
    if (meta !== null) metas.push(meta);
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? metas.slice(0, opts.limit) : metas;
}

/** Every Codex session a reference matches — an id, or a prefix of one. */
export async function resolveCodexRef(ref: string): Promise<SessionRef[]> {
  const trimmed = ref.trim();
  if (trimmed === '') return [];

  const exact: SessionRef[] = [];
  const prefix: SessionRef[] = [];
  for (const filePath of await listRollouts(getCodexSessionsDir())) {
    const sessionId = sessionIdFromPath(filePath);
    const entry: SessionRef = { agent: 'codex', sessionId, filePath };
    if (sessionId === trimmed) exact.push(entry);
    else if (sessionId.startsWith(trimmed)) prefix.push(entry);
  }
  return exact.length > 0 ? exact : prefix;
}

/** A rollout announces itself on its first line. */
export function sniffCodex(firstLine: string): boolean {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    return isRecord(parsed) && parsed['type'] === 'session_meta';
  } catch {
    return false;
  }
}
