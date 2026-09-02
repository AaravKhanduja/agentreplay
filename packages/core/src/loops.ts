/**
 * Debug loop detection (§4.3).
 *
 * A loop = write to file F → next bash call → the bash errored, OR F was
 * written again within 5 tool calls of the bash. Loops with matching
 * normalized error signatures count as "same-error".
 *
 * Once a file is in a fix-and-run cycle, the run that finally passes is part of
 * that cycle too, so a passing check on an already-looping file closes the
 * sequence rather than being dropped. Without it a session that got unstuck on
 * the first good try would end on its last failure — the resolution, which is
 * the whole point, would be invisible.
 */

import { diffSummary, extractDiff } from './diffs.js';
import { checkLabel, commandOf, failureLine } from './checks.js';
import type { DebugLoop, DebugSequence, Phase, Session, ToolCall } from './types.js';

const REWRITE_WINDOW = 5;
const STUCK_RUN_MIN = 3;

interface FlatCall {
  call: ToolCall;
  turnIndex: number;
}

function flattenCalls(session: Session): FlatCall[] {
  const flat: FlatCall[] = [];
  session.turns.forEach((turn, turnIndex) => {
    for (const call of turn.toolCalls) flat.push({ call, turnIndex });
  });
  return flat;
}

/** Lowercase first line, line/col numbers and hex addresses stripped, whitespace collapsed. */
/** Fallback when nothing reads like a failure: the first line that isn't an echo. */
function firstMeaningfulLine(errorText: string): string {
  for (const line of errorText.split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim();
    if (trimmed !== '' && !/^[$>]\s/.test(trimmed)) return trimmed;
  }
  return '';
}

export function errorSignature(errorText: string): string {
  const firstLine = errorText.split('\n')[0] ?? '';
  return firstLine
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '')
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\b(line|column|col)\s*\d+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectDebugLoops(session: Session): DebugLoop[] {
  const flat = flattenCalls(session);
  const loops: DebugLoop[] = [];
  let previousSignature: string | null = null;
  let previousLoopEnd = -1; // flat index of the previous loop's bash call
  const looping = new Set<string>(); // files already in a fix-and-run cycle

  for (let i = 0; i < flat.length; i++) {
    const entry = flat[i];
    if (entry === undefined) continue;
    const write = entry.call;
    const filePath = write.filePath;
    if (write.category !== 'write' || filePath === null) continue;

    let bashIndex = -1;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j]?.call.category === 'bash') {
        bashIndex = j;
        break;
      }
    }
    if (bashIndex === -1) continue;
    const bash = flat[bashIndex]?.call;
    if (bash === undefined) continue;

    const errored = bash.outcome === 'error';
    let rewritten = false;
    if (!errored) {
      for (let j = bashIndex + 1; j <= bashIndex + REWRITE_WINDOW && j < flat.length; j++) {
        const candidate = flat[j]?.call;
        if (candidate !== undefined && candidate.category === 'write' && candidate.filePath === filePath) {
          rewritten = true;
          break;
        }
      }
    }
    const resolves = !errored && !rewritten && looping.has(filePath);
    if (!errored && !rewritten && !resolves) continue;

    const errorText = errored ? (bash.errorText ?? bash.resultPreview ?? '') : '';
    const signature = errored ? errorSignature(errorText) : '';
    const result: DebugLoop['result'] = !errored
      ? 'passed'
      : signature === previousSignature
        ? 'same-error'
        : 'new-error';

    // Files read since the previous loop ended, ordered by most recent read last.
    // Everything else in that gap is counted, not listed: the chain collapses it.
    const precedingReads: string[] = [];
    let precedingOtherCalls = 0;
    for (let j = previousLoopEnd + 1; j < i; j++) {
      const candidate = flat[j]?.call;
      if (candidate === undefined) continue;
      if (candidate.category !== 'read' || candidate.filePath === null) {
        precedingOtherCalls += 1;
        continue;
      }
      const existing = precedingReads.indexOf(candidate.filePath);
      if (existing !== -1) precedingReads.splice(existing, 1);
      precedingReads.push(candidate.filePath);
    }

    loops.push({
      index: loops.length,
      turnIndex: entry.turnIndex,
      startedAt: write.timestamp,
      error: { text: errorText, signature },
      attempt: { filePath, diffSummary: diffSummary(write), editCount: extractDiff(write).editCount },
      check: { command: commandOf(bash), label: checkLabel(commandOf(bash)), outcome: bash.outcome },
      // The line that names the failure; an echoed command explains nothing.
      errorLine: failureLine(errorText, 96) ?? firstMeaningfulLine(errorText),
      precedingReads,
      precedingOtherCalls,
      result,
    });
    previousSignature = signature;
    previousLoopEnd = bashIndex;
    if (errored || rewritten) looping.add(filePath);
    else looping.delete(filePath); // the cycle closed
  }

  return loops;
}

/** Long enough between attempts that the next one is a new episode, not a retry. */
const RUN_GAP_MS = 10 * 60_000;

/**
 * Consecutive attempts on the same file, close together in time — one
 * debugging episode. The time limit matters: a file edited on and off across a
 * whole afternoon is not one run, and treating it as one swallowed every phase
 * between the first attempt and the last.
 */
export function loopRuns(loops: DebugLoop[]): Array<{ startTurn: number; endTurn: number }> {
  const runs: Array<{ startTurn: number; endTurn: number }> = [];
  let files = new Set<string>();
  let start: DebugLoop | undefined;
  let last: DebugLoop | undefined;

  for (const loop of loops) {
    const gap = last === undefined ? 0 : Date.parse(loop.startedAt) - Date.parse(last.startedAt);
    if (start !== undefined && (!files.has(loop.attempt.filePath) || gap >= RUN_GAP_MS)) {
      runs.push({ startTurn: start.turnIndex, endTurn: last?.turnIndex ?? start.turnIndex });
      files = new Set();
      start = undefined;
    }
    start ??= loop;
    last = loop;
    files.add(loop.attempt.filePath);
  }
  if (start !== undefined) runs.push({ startTurn: start.turnIndex, endTurn: last?.turnIndex ?? start.turnIndex });
  return runs;
}

export function groupDebugSequences(loops: DebugLoop[], phases: Phase[]): DebugSequence[] {
  const sequences: DebugSequence[] = [];
  let current: DebugLoop[] = [];
  let currentFiles = new Set<string>();


  const flush = (): void => {
    if (current.length === 0) return;
    sequences.push(buildSequence(current, phases, loops));
    current = [];
    currentFiles = new Set();
  };

  for (const loop of loops) {
    if (current.length > 0 && !currentFiles.has(loop.attempt.filePath)) flush();
    current.push(loop);
    currentFiles.add(loop.attempt.filePath);
  }
  flush();

  return sequences;
}

/**
 * @param loops   the sequence's own attempts, all inside one phase
 * @param all     every attempt in the session — a stuck run is often broken by
 *                the attempt straight after a user turn, which lands in the
 *                *next* phase, so the escape has to be looked for beyond the
 *                sequence or the breakthrough disappears
 */
function buildSequence(loops: DebugLoop[], phases: Phase[], all: DebugLoop[]): DebugSequence {
  const stuckRuns: DebugSequence['stuckRuns'] = [];
  const firstTurn = loops[0]?.turnIndex ?? 0;
  const phase = phases.find((p) => p.startIndex <= firstTurn && firstTurn <= p.endIndex);

  /**
   * A stall lasts until something ends it: the next attempt after the run, or
   * the end of the phase when the session simply stopped trying. Measuring
   * first-to-last attempt instead would under-report the time by the whole
   * gap in which the developer was stuck without acting.
   */
  const stallEnd = (endLoop: number, fallback: string): string =>
    // Look across the whole session: the attempt that ended the stall often
    // lands in the next phase, and stopping at this phase's edge under-reports
    // the stall by exactly the time the developer spent stuck and waiting.
    all.find((loop) => loop.index > endLoop)?.startedAt ?? phase?.endedAt ?? fallback;

  // Runs of consecutive loops sharing a non-empty error signature.
  let runStart = 0;
  for (let i = 1; i <= loops.length; i++) {
    const prev = loops[i - 1];
    const cur = loops[i];
    if (cur !== undefined && cur.error.signature === prev?.error.signature) continue;
    const first = loops[runStart];
    const last = loops[i - 1];
    if (first !== undefined && last !== undefined && i - runStart >= STUCK_RUN_MIN && first.error.signature !== '') {
      stuckRuns.push({
        startLoop: first.index,
        endLoop: last.index,
        errorSignature: first.error.signature,
        durationMs: Math.max(
          0,
          Date.parse(stallEnd(last.index, last.startedAt)) - Date.parse(first.startedAt),
        ),
      });
    }
    runStart = i;
  }

  let breakthroughLoop: number | null = null;
  let breakthroughCause: string | null = null;
  outer: for (const run of stuckRuns) {
    for (const loop of all) {
      if (loop.index <= run.endLoop) continue;
      if (loop.result === 'same-error') continue;
      breakthroughLoop = loop.index;
      const mostRecentRead = loop.precedingReads[loop.precedingReads.length - 1];
      breakthroughCause = mostRecentRead !== undefined ? `read ${mostRecentRead}` : null;
      break outer;
    }
  }

  let phaseIndex = phases.findIndex(
    (candidate) => candidate.startIndex <= firstTurn && firstTurn <= candidate.endIndex,
  );
  if (phaseIndex === -1) phaseIndex = 0;

  return { phaseIndex, loops, stuckRuns, breakthroughLoop, breakthroughCause };
}
