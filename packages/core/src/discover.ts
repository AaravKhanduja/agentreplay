/**
 * Session discovery across every installed agent.
 *
 * Each agent's own scanning lives in `sources/<agent>/`; this file only fans
 * out, merges and disambiguates. Sorting is by recency across all of them,
 * because "the session I was just in" is the thing people reach for and it
 * does not matter which tool produced it.
 */

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { SOURCES, availableSources, sourceOf } from './sources/index.js';
import type { SessionMeta, SessionRef } from './types.js';

export {
  getClaudeProjectsDir,
  decodeProjectDir,
  countCrossSessionReads,
} from './sources/claude/discover.js';

export async function discoverSessions(opts: { limit?: number } = {}): Promise<SessionMeta[]> {
  const sources = await availableSources();
  const found = await Promise.all(sources.map((source) => source.discover({})));
  const metas = found.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? metas.slice(0, opts.limit) : metas;
}

/** The first line of a file, without reading the rest — a rollout can be 19MB. */
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

/**
 * Resolve a session reference — a file path, or a session id (full or a unique
 * prefix) searched across every installed agent — to something loadable.
 *
 * A path is sniffed rather than declared: the file says which agent wrote it,
 * so nobody has to tell the CLI what they just handed it.
 */
export async function resolveSessionRef(ref: string): Promise<SessionRef> {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw new Error('No session given — pass a session file or a session id.');
  }

  const sources = await availableSources();

  let isFile = false;
  try {
    isFile = (await stat(trimmed)).isFile();
  } catch {
    // Not a path. It may still be an id, so fall through to the search.
  }
  if (isFile) {
    const absolute = path.resolve(trimmed);
    const line = await firstLine(absolute);
    const owner = sources.find((source) => source.sniff(line));
    if (owner === undefined) {
      throw new Error(`${absolute} doesn't look like a session file from any supported agent.`);
    }
    const [resolved] = await owner.resolve(absolute);
    return resolved ?? { agent: owner.id, sessionId: sessionIdOf(absolute), filePath: absolute };
  }

  if (sources.length === 0) throw new Error(noSessionsMessage());

  const matches = (await Promise.all(sources.map((source) => source.resolve(trimmed)))).flat();

  const only = matches[0];
  if (only !== undefined && matches.length === 1) return only;
  if (only === undefined) {
    throw new Error(
      `No session matching "${trimmed}" — pass a session file or a session id (a unique prefix works too).`,
    );
  }

  // Several. Say which kind of ambiguity it is, because the fix differs: a
  // longer prefix settles one agent's, naming the agent settles the other's.
  const agents = [...new Set(matches.map((m) => m.agent))];
  if (agents.length > 1) {
    const labels = agents.map((agent) => sourceOf(agent).label).join(' and ');
    throw new Error(
      `Session id "${trimmed}" is ambiguous — it matches sessions in ${labels}. Name the agent, e.g. "agentreplay ${only.agent} ${trimmed}".`,
    );
  }
  throw new Error(
    `Session id "${trimmed}" is ambiguous (${matches.length} matches) — add more characters or pass the full path.`,
  );
}

function sessionIdOf(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, '');
}

/** What to say when nothing is installed — naming the places actually looked at. */
export function noSessionsMessage(): string {
  const roots = SOURCES.map((source) => `${source.label} (${source.root()})`).join(', ');
  return `No sessions found — looked in ${roots}.`;
}
