/**
 * What a phase actually ran, as actions rather than command strings.
 *
 * A raw command list is mostly ceremony — `cd "/Users/…/core" && cat …` repeated
 * fifteen times — and it answers the wrong question. What matters is which
 * thing was attempted, how many times, and what came back. So commands are
 * grouped by the action they perform, counted, and shown with the line that
 * explains the outcome: `✗ backfill.ts ×2 — Can't reach database server`.
 */

import { checkCategory, checkTitle, commandOf, failureLine, shellKind } from './checks.js';
import type { CommandGroup, Phase, Session, ToolCall } from './types.js';

/**
 * A result line's budget. 72 cut real errors mid-word — "(gcloud.sql.instances
 * .list) There was a problem refreshing your…" loses the word that says which
 * thing needs refreshing, which is the whole message.
 */
const NOTE_MAX = 104;

/** Package-manager and runner prefixes that say nothing about the action. */
const RUNNER_PREFIX = /^(sudo|command|time|env|npx|pnpm dlx|pnpm exec|yarn dlx)\s+/;
const RUNNERS = /^(?:pnpm |npm |yarn |bun )?(run-ts|tsx|ts-node|node|python3?|ruby|bash|sh|deno)\b/;
/** `command -v doppler`, `which psql` — the interesting word is the target. */
const LOOKUP = /^(?:command|which|type)\s+/;
const PACKAGE_SCRIPT = /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+([a-z][\w:-]*)/;
const GIT = /^git\s+([a-z-]+)/;

export function summarizeCommands(session: Session, phase: Phase): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();

  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    for (const call of session.turns[i]?.toolCalls ?? []) {
      if (call.category !== 'bash') continue;
      const command = commandOf(call);
      const { label, kind } = describe(command);
      const key = `${kind}:${label}`;
      const failed = call.outcome === 'error';
      const existing = groups.get(key);
      const note = noteOf(call);

      if (existing === undefined) {
        groups.set(key, {
          label,
          kind,
          runs: 1,
          failed: failed ? 1 : 0,
          lastOutcome: call.outcome,
          note,
          failNote: failed ? note : null,
          turnIndex: i,
          command,
        });
        continue;
      }
      existing.runs += 1;
      if (failed) existing.failed += 1;
      existing.lastOutcome = call.outcome;
      // The last thing it said is the thing worth showing.
      if (note !== null) existing.note = note;
      if (failed && note !== null) existing.failNote = note;
      existing.turnIndex = i;
      existing.command = command;
    }
  }

  return [...groups.values()];
}

/** The action a command performs, and what kind of action it is. */
export function describe(command: string): { label: string; kind: CommandGroup['kind'] } {
  const head = stripCeremony(command);

  const check = checkCategory(head);
  if (check !== null) return { label: checkTitle(head), kind: 'check' };

  const runner = RUNNERS.exec(head)?.[1];
  if (runner !== undefined) {
    // `pnpm run-ts scripts/backfill.ts` names the script; `pnpm run-ts -e "…"`
    // has no script to name, so the runner itself is the honest label.
    const script = args(head).find(isScriptFile);
    return { label: script === undefined ? runner : basename(script), kind: 'script' };
  }

  const git = GIT.exec(head)?.[1];
  if (git !== undefined) return { label: `git ${git}`, kind: 'git' };

  const packaged = PACKAGE_SCRIPT.exec(head)?.[1];
  if (packaged !== undefined) return { label: packaged, kind: 'package' };

  if (shellKind(head) === 'search' || shellKind(head) === 'read') {
    return { label: program(head), kind: 'inspect' };
  }
  return { label: program(head), kind: 'other' };
}

/** Drop the `cd "…" &&` prelude and any wrapper, and keep the first segment. */
function stripCeremony(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  const withoutCd = flat.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '');
  const segment = withoutCd.split(/\s*(?:\|\||&&|\||;)\s*/)[0]?.trim() ?? withoutCd;
  return segment.replace(RUNNER_PREFIX, '');
}

/** The command's name, skipping flags and lookup wrappers. */
function program(command: string): string {
  const text = command.replace(LOOKUP, '');
  const token = text.split(/\s+/).find((part) => part !== '' && !part.startsWith('-'));
  return basename(token ?? text);
}

/** A command's arguments, with flags and quoted literals dropped. */
function args(command: string): string[] {
  return command
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .split(/\s+/)
    .slice(1)
    .filter((token) => token !== '' && !token.startsWith('-'));
}

/** A path to run, not an inline expression: `scripts/backfill.ts`, not `console.log(x)`. */
function isScriptFile(token: string): boolean {
  return /\.(ts|tsx|js|mjs|cjs|jsx|py|rb|sh|bash)$/.test(token) || token.includes('/');
}

function basename(path: string): string {
  const clean = path.replace(/^["']|["']$/g, '');
  return clean.split('/').pop() ?? clean;
}

/**
 * The one line worth showing: the failure for a failed run, otherwise a line
 * that reports a count or a verdict. An echoed command is not a result, and a
 * warning is not a diagnosis — when nothing qualifies, say nothing.
 */
function noteOf(call: ToolCall): string | null {
  if (call.outcome === 'error') return failureLine(call.errorText ?? call.resultPreview, NOTE_MAX);
  const preview = call.resultPreview;
  if (preview === null) return null;
  let note: string | null = null;
  for (const line of preview.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (!/\b\d+\b/.test(trimmed) || !/\b(passed|failing|failed|errors?|warnings?|ok|files?|rows?)\b/i.test(trimmed)) {
      continue;
    }
    note = clip(trimmed);
  }
  return note;
}

function clip(text: string): string {
  return text.length <= NOTE_MAX ? text : `${text.slice(0, NOTE_MAX - 1).trimEnd()}…`;
}
