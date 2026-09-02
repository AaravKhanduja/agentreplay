/**
 * Verification result: what the session's closing checks actually said.
 *
 * Reads like a build result rather than a list of commands — the question a
 * verify phase answers is "did it work?", not "what was run?".
 */

import { checkTitle, commandOf } from './checks.js';
import type { AnalyzedSession, Phase, VerifyCheck, VerifyResult } from './types.js';

export function buildVerifyResult(analyzed: AnalyzedSession, phase: Phase): VerifyResult {
  // Deduped by label, last run wins: a re-run after a fix is the real answer.
  const byLabel = new Map<string, VerifyCheck>();

  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    for (const call of analyzed.session.turns[i]?.toolCalls ?? []) {
      if (call.category !== 'bash') continue;
      const command = commandOf(call);
      const label = checkTitle(command);
      byLabel.set(label, {
        label,
        command,
        outcome: call.outcome,
        note: noteOf(call.resultPreview),
      });
    }
  }

  const checks = [...byLabel.values()];
  const { filesChanged, added, removed } = countChanges(analyzed);

  return {
    checks,
    filesChanged,
    added,
    removed,
    outcome: outcomeOf(checks),
  };
}

function outcomeOf(checks: VerifyCheck[]): VerifyResult['outcome'] {
  if (checks.length === 0) return 'incomplete';
  if (checks.some((check) => check.outcome === 'error')) return 'failing';
  return checks.every((check) => check.outcome === 'success') ? 'completed' : 'incomplete';
}

/** Whole-session change totals — the header stat line uses the same numbers. */
export function countChanges(analyzed: AnalyzedSession): {
  filesChanged: number;
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const history of analyzed.editHistories) {
    for (const attempt of history.attempts) {
      for (const line of attempt.diff) {
        if (line.kind === 'add') added += 1;
        else if (line.kind === 'del') removed += 1;
      }
    }
  }
  return { filesChanged: analyzed.editHistories.length, added, removed };
}

/**
 * The one line of output worth showing: a count with a verdict ("84 passed").
 * An echoed command ("tsc --noEmit") is not a result, so it becomes no note at
 * all — a bare ✓ says more. Summaries come last, so the last match wins.
 */
function noteOf(resultPreview: string | null): string | null {
  if (resultPreview === null) return null;
  let note: string | null = null;
  for (const line of resultPreview.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (!/\b\d+\b/.test(trimmed) || !/\b(passed|failing|failed|errors?|warnings?|ok)\b/i.test(trimmed)) continue;
    note = trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
  }
  return note;
}
