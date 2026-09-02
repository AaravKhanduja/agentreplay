/**
 * Edit diff extraction (§4.4).
 *
 * Turns Edit/MultiEdit/Write tool inputs into del/add line pairs (capped at
 * 20 lines per attempt) and groups attempts per file for the ExecuteView.
 */

import { isHarnessPath } from './checks.js';
import type { DiffLine, EditAttempt, FileEditHistory, Session, ToolCall } from './types.js';

const MAX_DIFF_LINES = 20;
const SUMMARY_LINE_MAX = 60;

interface EditPair {
  oldText: string;
  newText: string;
}

export interface ExtractedDiff {
  lines: DiffLine[];
  editCount: number;
  truncated: boolean;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** old/new string pairs from an Edit, MultiEdit or Write tool input. */
function editPairs(call: ToolCall): EditPair[] {
  if (call.name === 'Edit') {
    const oldText = asString(call.input['old_string']);
    const newText = asString(call.input['new_string']);
    if (oldText === null && newText === null) return [];
    return [{ oldText: oldText ?? '', newText: newText ?? '' }];
  }
  if (call.name === 'MultiEdit') {
    const edits = call.input['edits'];
    if (!Array.isArray(edits)) return [];
    const pairs: EditPair[] = [];
    for (const edit of edits) {
      if (typeof edit !== 'object' || edit === null) continue;
      const record = edit as Record<string, unknown>;
      pairs.push({
        oldText: asString(record['old_string']) ?? '',
        newText: asString(record['new_string']) ?? '',
      });
    }
    return pairs;
  }
  if (call.name === 'Write') {
    const content = asString(call.input['content']);
    if (content === null) return [];
    // A full-file Write counts as one add-only attempt.
    return [{ oldText: '', newText: content }];
  }
  return [];
}

/** Del/add lines for a write tool call, capped at 20 lines. */
export function extractDiff(call: ToolCall): ExtractedDiff {
  const pairs = editPairs(call);
  const lines: DiffLine[] = [];
  let truncated = false;

  const push = (kind: 'del' | 'add', text: string): void => {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      return;
    }
    lines.push({ kind, text });
  };

  for (const pair of pairs) {
    if (pair.oldText !== '') for (const text of pair.oldText.split('\n')) push('del', text);
    if (pair.newText !== '') for (const text of pair.newText.split('\n')) push('add', text);
  }
  return { lines, editCount: pairs.length, truncated };
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function summaryLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SUMMARY_LINE_MAX ? `${trimmed.slice(0, SUMMARY_LINE_MAX - 1)}…` : trimmed;
}

/** One line like `webhook-handler.ts · 2 edits · -old line +new line`. */
export function diffSummary(call: ToolCall): string {
  const { lines, editCount } = extractDiff(call);
  const name = basename(call.filePath ?? call.name);
  const head = `${name} · ${editCount} edit${editCount === 1 ? '' : 's'}`;

  const firstDel = lines.find((line) => line.kind === 'del' && line.text.trim() !== '');
  const firstAdd = lines.find((line) => line.kind === 'add' && line.text.trim() !== '');
  const parts: string[] = [];
  if (firstDel !== undefined) parts.push(`-${summaryLine(firstDel.text)}`);
  if (firstAdd !== undefined) parts.push(`+${summaryLine(firstAdd.text)}`);
  return parts.length === 0 ? head : `${head} · ${parts.join(' ')}`;
}

export function buildEditHistories(session: Session): FileEditHistory[] {
  const byFile = new Map<string, EditAttempt[]>();

  session.turns.forEach((turn, turnIndex) => {
    for (const call of turn.toolCalls) {
      if (call.category !== 'write' || call.filePath === null) continue;
      // Plan documents and settings under .claude/ are the harness's files,
      // not the developer's — counting them misreports what changed.
      if (isHarnessPath(call.filePath)) continue;
      const { lines, editCount, truncated } = extractDiff(call);
      const attempt: EditAttempt = {
        turnIndex,
        timestamp: call.timestamp,
        toolName: call.name,
        editCount,
        diff: lines,
        truncated,
        outcome: call.outcome,
      };
      const attempts = byFile.get(call.filePath);
      if (attempts === undefined) byFile.set(call.filePath, [attempt]);
      else attempts.push(attempt);
    }
  });

  const histories: FileEditHistory[] = [];
  for (const [path, attempts] of byFile) {
    histories.push({ path, attempts, finalOutcome: finalOutcome(attempts) });
  }
  return histories;
}

function finalOutcome(attempts: EditAttempt[]): FileEditHistory['finalOutcome'] {
  const last = attempts[attempts.length - 1];
  if (last !== undefined && last.outcome === 'error') return 'failed';
  return attempts.length === 1 ? 'clean' : 'retried';
}
