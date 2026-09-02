/**
 * Interactive session picker.
 *
 * Rows look like:  ~/code/webshop            ·   34 msgs ·     45m · 2h ago
 */

import os from 'node:os';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import type { SessionMeta } from '@agentreplay/core';

const MAX_PROJECT_WIDTH = 42;

export async function pickSession(
  sessions: SessionMeta[],
  opts: { output?: NodeJS.WritableStream } = {},
): Promise<SessionMeta> {
  const projects = sessions.map((session) => truncateLeft(shortenHome(session.projectPath), MAX_PROJECT_WIDTH));
  const projectWidth = Math.max(...projects.map((p) => p.length));

  const choices = sessions.map((session, i) => ({
    name: formatRow(projects[i] ?? '', projectWidth, session),
    value: session,
  }));

  const context = opts.output ? { output: opts.output } : undefined;
  return select(
    {
      message: 'Pick a session to replay',
      choices,
      pageSize: 15,
      loop: false,
    },
    context,
  );
}

function formatRow(project: string, projectWidth: number, session: SessionMeta): string {
  const msgs = `${String(session.messageCount).padStart(4)} msgs`;
  const duration = humanDuration(session.durationMs).padStart(7);
  const age = humanAge(session.mtimeMs);
  return `${project.padEnd(projectWidth)} · ${msgs} · ${duration} · ${age}`;
}

/** /Users/you/code/webshop → ~/code/webshop */
export function shortenHome(projectPath: string): string {
  const home = os.homedir();
  if (projectPath === home) return '~';
  if (projectPath.startsWith(home + path.sep) || projectPath.startsWith(home + '/')) {
    return '~' + projectPath.slice(home.length);
  }
  return projectPath;
}

/** Truncate from the left, keeping the tail (the interesting part of a path). */
export function truncateLeft(text: string, max: number): string {
  if (text.length <= max) return text;
  return '…' + text.slice(text.length - (max - 1));
}

export function humanDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function humanAge(mtimeMs: number): string {
  const minutes = Math.round((Date.now() - mtimeMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
