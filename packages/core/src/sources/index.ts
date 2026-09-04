/** The sources the CLI knows about, in picker order. */

import type { AgentId } from '../types.js';
import { claudeSource } from './claude/index.js';
import type { SessionSource } from './types.js';

export type { SessionSource } from './types.js';

export const SOURCES: readonly SessionSource[] = [claudeSource];

export function sourceOf(agent: AgentId): SessionSource {
  const source = SOURCES.find((s) => s.id === agent);
  // Unreachable via the public API: every AgentId has a source, and the type
  // is closed. Throwing beats returning Claude's reader for someone else's file.
  if (source === undefined) throw new Error(`No reader for agent "${agent}"`);
  return source;
}

/** Only the agents actually installed on this machine. */
export async function availableSources(): Promise<SessionSource[]> {
  const flags = await Promise.all(SOURCES.map((s) => s.isAvailable()));
  return SOURCES.filter((_, i) => flags[i] === true);
}
