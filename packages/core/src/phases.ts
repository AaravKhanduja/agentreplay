/**
 * Phase segmentation (§4.1).
 *
 * Candidate boundaries at every user turn, and at the seams inside a stretch of
 * agent work: leaving plan mode, and long silences. Cutting only at user turns
 * meant a session that planned and then built without being interrupted came
 * out as one enormous "plan" phase containing all of the editing.
 *
 * Each segment is classified from explicit plan signals (win outright),
 * detected debug loops, sustained validation intent, then tool mix.
 * Adjacent same-kind segments merge; segments shorter than 2 turns AND 60s
 * are absorbed into a neighbor (previous preferred), keeping the neighbor's
 * kind.
 */

import { checkCategory, commandOf, isReadOnlyShell } from './checks.js';
import { loopRuns } from './loops.js';
import type { DebugLoop, Iso, Phase, PhaseKind, Session, ToolCategory, Turn } from './types.js';

const MIN_TURNS = 2;
const MIN_DURATION_MS = 60_000;
const EXPLORE_READ_RATIO = 0.6;
const EXPLORE_WRITE_RATIO = 0.2;
const VERIFY_BASH_RATIO = 0.6;
const VERIFY_MIN_CHECKS = 2;
/** Silence long enough to end a phase, matching the parser's turn seam. */
const SEAM_GAP_MS = 10 * 60_000;

export function segmentPhases(session: Session, loops: DebugLoop[]): Phase[] {
  const turns = session.turns;
  if (turns.length === 0) return [];

  const starts: number[] = [];
  turns.forEach((turn, index) => {
    if (index === 0 || turn.role === 'user' || isSeam(turns, index)) starts.push(index);
  });

  let phases: Phase[] = starts.map((start, i) => {
    const next = starts[i + 1];
    return buildPhase(turns, loops, start, (next ?? turns.length) - 1);
  });

  phases = mergeSameKind(phases, turns, loops);
  phases = mergeAcrossDebugRuns(phases, turns, loops);

  // Absorb phases that are too short, or that contain no work at all, into a
  // neighbor. Each absorption can create a new same-kind adjacency, so
  // re-merge after every step.
  while (phases.length > 1) {
    const shortIndex = phases.findIndex((phase) => isTooShort(phase) || isWorkless(turns, phase));
    if (shortIndex === -1) break;
    const neighborIndex = shortIndex > 0 ? shortIndex - 1 : shortIndex + 1;
    const left = phases[Math.min(shortIndex, neighborIndex)];
    const right = phases[Math.max(shortIndex, neighborIndex)];
    const neighbor = phases[neighborIndex];
    if (left === undefined || right === undefined || neighbor === undefined) break;
    const merged: Phase = { ...buildPhase(turns, loops, left.startIndex, right.endIndex), kind: neighbor.kind };
    phases.splice(Math.min(shortIndex, neighborIndex), 2, merged);
    phases = mergeSameKind(phases, turns, loops);
  }

  return phases;
}

/**
 * A boundary inside agent work: the moment planning turned into building, or a
 * long gap where the developer stepped away. The parser already ends turns at
 * both, so this only has to notice the change between neighbours.
 */
function isSeam(turns: Turn[], index: number): boolean {
  const turn = turns[index];
  const previous = turns[index - 1];
  if (turn === undefined || previous === undefined) return false;
  if (previous.planMode && !turn.planMode) return true;
  const gap = Date.parse(turn.timestamp) - Date.parse(segmentEndedAt(turns, index - 1));
  return Number.isFinite(gap) && gap >= SEAM_GAP_MS;
}

function buildPhase(turns: Turn[], loops: DebugLoop[], start: number, end: number): Phase {
  const toolMix: Record<ToolCategory, number> = { read: 0, write: 0, bash: 0, meta: 0 };
  let planSignal = false;
  const checkKinds = new Set<string>();
  let nonCheckBash = 0;
  let failedCheck = false;
  let readOnlyShell = 0;
  let delegated = 0;

  for (let i = start; i <= end; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    if (turn.planMode) planSignal = true;
    for (const call of turn.toolCalls) {
      toolMix[call.category] += 1;
      if (call.name === 'ExitPlanMode') planSignal = true;
      // A subagent is sent out to look at something — investigation, not work.
      if (call.name === 'Agent' || call.name === 'Task') delegated += 1;
      if (call.category !== 'bash') continue;
      const command = commandOf(call);
      if (isReadOnlyShell(command)) readOnlyShell += 1;
      const category = checkCategory(command);
      if (category === null) nonCheckBash += 1;
      else {
        checkKinds.add(category);
        if (call.outcome === 'error') failedCheck = true;
      }
    }
  }

  // Failing loops only: one failure and a fix is ordinary execution, and the
  // detector now also emits the passing loop that closes a cycle.
  const loopCount = loops.filter(
    (loop) => loop.turnIndex >= start && loop.turnIndex <= end && loop.result !== 'passed',
  ).length;
  const verify: VerifySignal = {
    kinds: checkKinds.size,
    allChecks: nonCheckBash === 0,
    allPassed: !failedCheck,
    isTail: end === turns.length - 1,
  };

  return {
    kind: classify(planSignal, loopCount, toolMix, verify, readOnlyShell + delegated),
    startIndex: start,
    endIndex: end,
    startedAt: turns[start]?.timestamp ?? '',
    endedAt: segmentEndedAt(turns, end),
    activeMs: activeMs(turns, start, end),
    toolMix,
  };
}

interface VerifySignal {
  /** Distinct check categories present in the segment. */
  kinds: number;
  /** Every bash call in the segment was a check command. */
  allChecks: boolean;
  /** No check in the segment failed. */
  allPassed: boolean;
  /** The segment runs to the end of the session. */
  isTail: boolean;
}

function classify(
  planSignal: boolean,
  loopCount: number,
  mix: Record<ToolCategory, number>,
  verify: VerifySignal,
  readOnlyShell: number,
): PhaseKind {
  if (planSignal) return 'plan';
  if (loopCount >= 2) return 'debug';
  if (isVerification(mix, verify)) return 'verify';
  const total = mix.read + mix.write + mix.bash + mix.meta;
  // `rg`, `sed -n`, `git log` are reading, whatever tool carried them.
  const reads = mix.read + readOnlyShell;
  if (total > 0 && reads / total >= EXPLORE_READ_RATIO && mix.write / total < EXPLORE_WRITE_RATIO) {
    return 'explore';
  }
  return 'execute';
}

/**
 * Verify means sustained validation intent, never "there was a test command
 * here" — otherwise an ordinary edit-then-test rhythm shreds the session into
 * Execute/Verify/Execute/Verify and the phase list becomes noise.
 */
function isVerification(mix: Record<ToolCategory, number>, verify: VerifySignal): boolean {
  const total = mix.read + mix.write + mix.bash + mix.meta;
  if (mix.write > 0 || mix.bash < VERIFY_MIN_CHECKS || total === 0) return false;
  if (mix.bash / total < VERIFY_BASH_RATIO || !verify.allChecks) return false;
  // Two different kinds of check is intent on its own; one kind only counts as
  // the session's closing, all-green validation sweep.
  return verify.kinds >= 2 || (verify.isTail && verify.allPassed);
}

/** Gap between two events beyond which nobody was working. */
const IDLE_GAP_MS = 3 * 60_000;

/**
 * Time the session was moving. Every consecutive pair of events contributes at
 * most IDLE_GAP_MS, so thinking and typing count while lunch does not.
 */
function activeMs(turns: Turn[], start: number, end: number): number {
  const stamps: number[] = [];
  for (let i = start; i <= end; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const turnMs = Date.parse(turn.timestamp);
    if (Number.isFinite(turnMs)) stamps.push(turnMs);
    for (const call of turn.toolCalls) {
      const callMs = Date.parse(call.timestamp);
      if (Number.isFinite(callMs)) stamps.push(callMs);
    }
  }
  stamps.sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < stamps.length; i++) {
    total += Math.min((stamps[i] ?? 0) - (stamps[i - 1] ?? 0), IDLE_GAP_MS);
  }
  return total;
}

/** End of a segment: the last turn's timestamp, or its latest tool call if later. */
function segmentEndedAt(turns: Turn[], end: number): Iso {
  const turn = turns[end];
  if (turn === undefined) return '';
  let latest = turn.timestamp;
  for (const call of turn.toolCalls) {
    if (Date.parse(call.timestamp) > Date.parse(latest)) latest = call.timestamp;
  }
  return latest;
}

/**
 * A stretch of pure conversation — no files touched, nothing run, nothing
 * delegated. It is part of the session, but it is not a phase of work: shown
 * on its own it becomes an "Execute · 0 edits · 0 files" section that says
 * nothing. Fold it into a neighbour instead.
 */
function isWorkless(turns: Turn[], phase: Phase): boolean {
  // Planning is work even when it touches nothing: the plan is the output.
  if (phase.kind === 'plan') return false;
  const { read, write, bash } = phase.toolMix;
  if (read + write + bash > 0) return false;
  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    for (const call of turns[i]?.toolCalls ?? []) {
      if (call.name === 'Agent' || call.name === 'Task') return false;
    }
  }
  return true;
}

function isTooShort(phase: Phase): boolean {
  if (phase.endIndex - phase.startIndex + 1 >= MIN_TURNS) return false;
  return Date.parse(phase.endedAt) - Date.parse(phase.startedAt) < MIN_DURATION_MS;
}

/**
 * A debugging episode is one story: attempt, check, fail, attempt again, and
 * finally the read that breaks it. Cutting it at a user turn left one phase
 * reporting "0 loops" and, worse, put the breakthrough in a different phase
 * from the stall it ended — so the phases give way, not the episode.
 */
function mergeAcrossDebugRuns(phases: Phase[], turns: Turn[], loops: DebugLoop[]): Phase[] {
  let result = phases;
  for (const run of loopRuns(loops)) {
    const first = result.findIndex((p) => p.startIndex <= run.startTurn && run.startTurn <= p.endIndex);
    const last = result.findIndex((p) => p.startIndex <= run.endTurn && run.endTurn <= p.endIndex);
    const from = result[first];
    const to = result[last];
    // Only ever join neighbours. A run that appears to span three phases is a
    // file being revisited across the afternoon, not one episode, and merging
    // that far collapses the whole session into a single block.
    if (last !== first + 1 || from === undefined || to === undefined) continue;
    const merged: Phase = {
      ...buildPhase(turns, loops, from.startIndex, to.endIndex),
      kind: 'debug',
    };
    result = [...result.slice(0, first), merged, ...result.slice(last + 1)];
  }
  return mergeSameKind(result, turns, loops);
}

function mergeSameKind(phases: Phase[], turns: Turn[], loops: DebugLoop[]): Phase[] {
  const merged: Phase[] = [];
  for (const phase of phases) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.kind === phase.kind) {
      merged[merged.length - 1] = { ...buildPhase(turns, loops, prev.startIndex, phase.endIndex), kind: prev.kind };
    } else {
      merged.push(phase);
    }
  }
  return merged;
}
