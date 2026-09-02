/**
 * Replay selection: which few events deserve the primary replay.
 *
 * Detection is not presentation. `extractEvents` finds every checkable moment
 * and `analyzed.events` keeps all of them; this module derives the small
 * ordered set the graph actually draws — the shortest truthful story. It
 * optimizes for four things, in tension: non-redundancy (a later restatement
 * of a known finding is noise), causal importance (the discovery that led to
 * the decision beats the observation that led nowhere), arc coverage (five
 * Explore discoveries and no outcome is not a story), and outcome relevance
 * (the reader must never finish wondering whether it worked).
 *
 * Everything here is deterministic selection over existing events — no model,
 * no authored wording. Density comes from deduplication, collapsing and
 * relevance; the budget is a soft cap that should almost never be the reason
 * an event disappears.
 */

import type { AnalyzedSession, EventKind, SessionEvent } from './types.js';

/** How findings outrank each other when they describe the same thing. */
const FINDING_STRENGTH: Partial<Record<EventKind, number>> = {
  rootCause: 3,
  discovery: 2,
  hypothesis: 1,
};

export function selectReplayEvents(analyzed: AnalyzedSession): SessionEvent[] {
  let events = analyzed.events.map((event) => ({ ...event, evidence: [...event.evidence] }));

  events = demoteEarlierRootCauses(events);
  events = dropRestatements(events);
  events = dropStructuralDecisions(events);
  events = dropEchoedVerifications(events);
  events = mergeImplementationRuns(events);
  events = mergeVerificationRuns(events);

  const scores = new Map(events.map((event) => [event, scoreOf(event, events)]));
  events = capFailuresPerPhase(events, scores);

  const chosen = pick(analyzed, events, scores);

  // Chronological on the page, whatever order importance picked them in;
  // within one turn the outcome goes last so the story ends on the ending.
  const RANK_ORDER = { normal: 0, key: 1, outcome: 2 } as const;
  return chosen.sort(
    (a, b) => a.turnIndex - b.turnIndex || RANK_ORDER[a.rank] - RANK_ORDER[b.rank],
  );
}

// ---------------------------------------------------------------------------
// Deduplication and demotion
// ---------------------------------------------------------------------------

/**
 * An investigation narrows: when the markers produced several ROOT CAUSE
 * candidates, the last one stated is the conclusion and the earlier ones were
 * steps on the way to it — so they present as discoveries. Their words,
 * evidence and turns are untouched; only the reading changes, and the graph
 * shows the arc the session actually walked: discovery → root cause.
 */
function demoteEarlierRootCauses(events: SessionEvent[]): SessionEvent[] {
  const last = events.filter((event) => event.kind === 'rootCause').pop();
  return events.map((event) =>
    event.kind === 'rootCause' && event !== last ? { ...event, kind: 'discovery', weight: 4 } : event,
  );
}

/**
 * A later finding that re-walks ground an earlier one already holds is noise:
 * same phase, weaker or equal kind, and every anchor it cites was already in
 * the earlier finding's evidence, with nothing new added. Strictly later-only
 * and same-phase-only — an earlier discovery may be the causal step toward
 * the root cause ("data lives in the CMS database" precedes "the query needs
 * authorId"; related, not redundant), and a cross-phase echo is a thread
 * coming back, which is signal.
 */
function dropRestatements(events: SessionEvent[]): SessionEvent[] {
  const findings = events.filter((event) => FINDING_STRENGTH[event.kind] !== undefined);
  const dropped = new Set<SessionEvent>();

  for (const later of findings) {
    // No anchors means nothing to compare on — scoring decides its fate.
    const anchors = later.evidence.filter(isAnchor);
    if (anchors.length === 0) continue;
    const covered = findings.some(
      (earlier) =>
        earlier !== later &&
        !dropped.has(earlier) &&
        earlier.phaseIndex === later.phaseIndex &&
        earlier.turnIndex < later.turnIndex &&
        (FINDING_STRENGTH[later.kind] ?? 0) <= (FINDING_STRENGTH[earlier.kind] ?? 0) &&
        anchors.every((anchor) => earlier.evidence.includes(anchor)),
    );
    if (covered) dropped.add(later);
  }

  return events.filter((event) => !dropped.has(event));
}

/**
 * `plan drafted — 4 steps` is a stub for the decision, not a second decision.
 * When the session stated one in words anywhere, the stub never enters the
 * replay; when it never did, the stub is the only record a plan existed.
 */
function dropStructuralDecisions(events: SessionEvent[]): SessionEvent[] {
  const spoken = events.some((event) => event.kind === 'decision' && event.source === 'quoted');
  if (!spoken) return events;
  return events.filter((event) => !(event.kind === 'decision' && event.source === 'structural'));
}

/**
 * A mid-session `Tests passed` is an echo once a terminal verification closes
 * the session — the outcome says it, with more coverage. Failures are never
 * touched here: a failure is what happened, not a status.
 */
function dropEchoedVerifications(events: SessionEvent[]): SessionEvent[] {
  const terminal = events.some((event) => event.kind === 'verification' && event.rank === 'outcome');
  if (!terminal) return events;
  return events.filter((event) => !(event.kind === 'verification' && event.rank !== 'outcome'));
}

// ---------------------------------------------------------------------------
// Collapsing runs
// ---------------------------------------------------------------------------

/**
 * Consecutive implementation events with nothing but other implementations
 * between them are one run of work, not several beats — conservative on
 * purpose: any key or outcome event in between (a failure, a pivot) means the
 * work changed direction, and the beats stay separate.
 */
function mergeImplementationRuns(events: SessionEvent[]): SessionEvent[] {
  return mergeConsecutive(events, 'implementation', (run) => {
    const files = run.reduce((sum, event) => sum + event.count, 0);
    return {
      ...run[run.length - 1]!,
      turnIndex: run[run.length - 1]!.turnIndex,
      text: `${files} files changed`,
      label: `${files} files changed`,
      count: files,
      evidence: dedupe(run.flatMap((event) => event.evidence)).slice(0, 4),
    };
  });
}

/** The same, for runs of passing checks. */
function mergeVerificationRuns(events: SessionEvent[]): SessionEvent[] {
  return mergeConsecutive(events, 'verification', (run) => {
    const checks = run.reduce((sum, event) => sum + event.count, 0);
    const labels = dedupe(run.flatMap((event) => event.evidence));
    return {
      ...run[run.length - 1]!,
      text: `${checks} checks passed — ${labels.join(', ')}`,
      label: `${checks} checks passed — ${labels.join(', ')}`,
      count: checks,
      evidence: labels.slice(0, 4),
    };
  });
}

function mergeConsecutive(
  events: SessionEvent[],
  kind: EventKind,
  merge: (run: SessionEvent[]) => SessionEvent,
): SessionEvent[] {
  const out: SessionEvent[] = [];
  let run: SessionEvent[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    out.push(run.length === 1 ? run[0]! : merge(run));
    run = [];
  };

  for (const event of events) {
    if (event.kind === kind && event.rank !== 'outcome') {
      if (run.length > 0 && run[0]!.phaseIndex !== event.phaseIndex) flush();
      run.push(event);
      continue;
    }
    flush();
    out.push(event);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Scoring, failure cap, and the pick
// ---------------------------------------------------------------------------

/**
 * Replay value, from deterministic signals only: the extractor's own weight,
 * repetition (a failure hit twice matters more than once), forward relevance
 * (a later event links back to this turn, or reuses an anchor this event
 * introduced — the one thing a replay can show that a transcript cannot),
 * causal position (a finding that precedes the phase's conclusion is a step
 * toward it), and a penalty for findings after the session's outcome, which
 * explain nothing the reader still needs.
 */
function scoreOf(event: SessionEvent, all: SessionEvent[]): number {
  let score = event.weight;
  if (event.count > 1) score += 1;

  const anchors = event.evidence.filter(isAnchor);
  const reused = all.some(
    (later) =>
      later.turnIndex > event.turnIndex &&
      (later.relatesTo === event.turnIndex ||
        later.evidence.some((item) => anchors.includes(item))),
  );
  if (reused) score += 2;

  if (FINDING_STRENGTH[event.kind] !== undefined) {
    const precedesConclusion = all.some(
      (later) =>
        later.phaseIndex === event.phaseIndex &&
        later.turnIndex > event.turnIndex &&
        (later.kind === 'rootCause' || later.kind === 'pivot' ||
          (later.kind === 'decision' && later.source === 'quoted')),
    );
    if (precedesConclusion) score += 2;

    const lastOutcome = all.filter((candidate) => candidate.rank === 'outcome').pop();
    if (lastOutcome !== undefined && event.turnIndex > lastOutcome.turnIndex) score -= 3;
  }

  return score;
}

/**
 * Several distinct failures inside one phase are one struggle, not several
 * beats — keep the strongest, unless a failure directly precedes a kept
 * finding in its phase (it caused the breakthrough; that transition is the
 * story and stays).
 */
function capFailuresPerPhase(events: SessionEvent[], scores: Map<SessionEvent, number>): SessionEvent[] {
  const dropped = new Set<SessionEvent>();
  const phases = new Set(events.filter((event) => event.kind === 'failure').map((event) => event.phaseIndex));

  for (const phaseIndex of phases) {
    const failures = events.filter((event) => event.kind === 'failure' && event.phaseIndex === phaseIndex);
    if (failures.length <= 1) continue;
    const strongest = failures.reduce((best, event) =>
      (scores.get(event) ?? 0) > (scores.get(best) ?? 0) ? event : best,
    );
    for (const failure of failures) {
      if (failure === strongest) continue;
      const causal = events.some(
        (finding) =>
          FINDING_STRENGTH[finding.kind] !== undefined &&
          finding.phaseIndex === phaseIndex &&
          finding.turnIndex > failure.turnIndex,
      );
      if (!causal) dropped.add(failure);
    }
  }

  return events.filter((event) => !dropped.has(event));
}

/**
 * Soft density target by session length. The budget is the last resort:
 * dedup, collapsing and the failure cap should already have done the work,
 * and must-keep events are never cut by it.
 */
function budgetFor(analyzed: AnalyzedSession): number {
  const activeMs = analyzed.timeline.totalActiveMs;
  if (activeMs < 30 * 60_000) return 5;
  if (activeMs < 3 * 3_600_000) return 7;
  return 9;
}

/** The arc no replay may drop: how it ended, what it concluded, what changed course. */
function isMustKeep(event: SessionEvent): boolean {
  return (
    event.rank === 'outcome' ||
    event.kind === 'rootCause' ||
    event.kind === 'pivot' ||
    (event.kind === 'decision' && event.source === 'quoted')
  );
}

function pick(
  analyzed: AnalyzedSession,
  events: SessionEvent[],
  scores: Map<SessionEvent, number>,
): SessionEvent[] {
  const kept = new Set<SessionEvent>(events.filter(isMustKeep));

  // Arc coverage for the work itself: the largest implementation run per
  // phase, at most two overall — connective tissue, not the findings.
  const implementations = events
    .filter((event) => event.kind === 'implementation')
    .sort((a, b) => b.count - a.count || a.turnIndex - b.turnIndex);
  const implPhases = new Set<number>();
  for (const event of implementations) {
    if (implPhases.size >= 2) break;
    if (implPhases.has(event.phaseIndex)) continue;
    implPhases.add(event.phaseIndex);
    kept.add(event);
  }

  // Fill the remaining room by score; ties go to the phase with the least
  // representation so far (coverage), then to the earlier moment.
  const budget = Math.max(budgetFor(analyzed), kept.size);
  const candidates = events
    .filter((event) => !kept.has(event) && event.kind !== 'implementation')
    .sort((a, b) => {
      const byScore = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
      if (byScore !== 0) return byScore;
      const aCover = [...kept].filter((event) => event.phaseIndex === a.phaseIndex).length;
      const bCover = [...kept].filter((event) => event.phaseIndex === b.phaseIndex).length;
      return aCover - bCover || a.turnIndex - b.turnIndex;
    });

  for (const candidate of candidates) {
    if (kept.size >= budget) break;
    if ((scores.get(candidate) ?? 0) <= 1) continue; // below this it is noise, budget or not
    kept.add(candidate);
  }

  return events.filter((event) => kept.has(event));
}

// ---------------------------------------------------------------------------

/** Something a reader can open or grep for: a path, or a dotted symbol. */
function isAnchor(item: string): boolean {
  return item.includes('/') || /^[A-Za-z][\w-]*\.[A-Za-z][\w-]*$/.test(item);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
