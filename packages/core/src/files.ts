/**
 * File access graph (§4.2): per-file read/write counts with timestamps,
 * backtrack detection, and consecutive-access edges for the explore view.
 */

import { isHarnessPath } from './checks.js';
import type { FileAccess, FileEdge, Iso, Session } from './types.js';

const BACKTRACK_THRESHOLD = 3;

interface Access {
  path: string;
  category: 'read' | 'write';
  timestamp: Iso;
}

/** All file-touching tool calls, in chronological (turn, call) order. */
function fileAccesses(session: Session): Access[] {
  const accesses: Access[] = [];
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      if (call.filePath === null || isHarnessPath(call.filePath)) continue;
      if (call.category !== 'read' && call.category !== 'write') continue;
      accesses.push({ path: call.filePath, category: call.category, timestamp: call.timestamp });
    }
  }
  return accesses;
}

export function buildFileAccess(session: Session): FileAccess[] {
  const byPath = new Map<string, FileAccess>();
  // Per file: distinct OTHER files touched since its last access.
  const othersSinceLast = new Map<string, Set<string>>();

  for (const access of fileAccesses(session)) {
    let entry = byPath.get(access.path);
    if (entry === undefined) {
      entry = { path: access.path, reads: 0, writes: 0, timestamps: [], isBacktracked: false };
      byPath.set(access.path, entry);
    } else if (
      access.category === 'read' &&
      (othersSinceLast.get(access.path)?.size ?? 0) >= BACKTRACK_THRESHOLD
    ) {
      entry.isBacktracked = true;
    }

    if (access.category === 'read') entry.reads += 1;
    else entry.writes += 1;
    entry.timestamps.push(access.timestamp);

    othersSinceLast.set(access.path, new Set());
    for (const [path, others] of othersSinceLast) {
      if (path !== access.path) others.add(access.path);
    }
  }

  return [...byPath.values()];
}

export function buildFileEdges(session: Session): FileEdge[] {
  const accesses = fileAccesses(session);
  const edges = new Map<string, FileEdge>();

  for (let i = 1; i < accesses.length; i++) {
    const from = accesses[i - 1];
    const to = accesses[i];
    if (from === undefined || to === undefined) continue;
    if (from.path === to.path) continue; // no self-edges

    const key = `${from.path}\u0000${to.path}`;
    const edge = edges.get(key);
    if (edge === undefined) edges.set(key, { from: from.path, to: to.path, weight: 1 });
    else edge.weight += 1;
  }

  return [...edges.values()];
}
