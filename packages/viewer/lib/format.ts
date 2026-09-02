/** Small display formatters shared across components. */

/** "14:32" — local time, 24h. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Jul 24, 2026" */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * "38s" / "47m" / "1h 05m".
 *
 * Minutes round rather than floor, matching core's own duration formatting —
 * the stuck block and the headline describe the same stall and must agree.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function durationMs(startIso: string, endIso: string): number {
  return Date.parse(endIso) - Date.parse(startIso);
}

/**
 * Truncate a path from the LEFT with a single … char, keeping the filename.
 * "src/very/deep/nested/handler.ts" → "…/nested/handler.ts"
 */
export function truncateLeft(path: string, max: number): string {
  if (path.length <= max) return path;
  const tail = path.slice(path.length - (max - 1));
  const slash = tail.indexOf('/');
  // Prefer cutting at a directory boundary so the result starts at a segment.
  const cut = slash > -1 && slash < tail.length - 2 ? tail.slice(slash) : tail;
  return `…${cut}`;
}

/** Last path segment: "src/lib/crypto.ts" → "crypto.ts" */
export function leaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * The last `segments` parts of a path: enough to recognise a file without
 * spending a line on its ancestry. "a/b/c/d/index.ts" → "d/index.ts".
 */
export function tail(path: string, segments: number): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length <= segments) return path;
  return parts.slice(-segments).join('/');
}
