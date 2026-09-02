/**
 * The session on a working-time axis.
 *
 * Real clock time cannot carry this drawing: a session spread across a day is
 * 90% idle, so phases drawn to scale become slivers and the shape disappears.
 * Working time — every gap over a few minutes clamped — keeps the work legible,
 * and the gaps come back as notches on the axis with their real durations, so
 * nothing is hidden, only compressed.
 */

import type { Iso, Phase, Session, Timeline, TimelineGap, TimelineMark, TimelineSegment } from './types.js';

/** A pause longer than this is not working time. Matches phases.ts. */
const IDLE_GAP_MS = 3 * 60_000;
/** A gap worth drawing and naming, rather than merely clamping. */
const NOTCH_MIN_MS = 10 * 60_000;

interface Event {
  at: number;
  turnIndex: number;
  /** Present for tool calls; turns themselves are only clock anchors. */
  mark: { category: TimelineMark['category']; failed: boolean; timestamp: Iso } | null;
}

export function buildTimeline(session: Session, phases: Phase[]): Timeline {
  const segments = buildSegments(phases);
  const marks: TimelineMark[] = [];
  const gaps: TimelineGap[] = [];
  let previousPhaseEnd: Event | undefined;

  phases.forEach((phase, phaseIndex) => {
    const segment = segments[phaseIndex];
    if (segment === undefined) return;
    const events = collectEvents(session, phase.startIndex, phase.endIndex);
    let local = 0;

    // A pause across a phase boundary belongs at the seam between them.
    const first = events[0];
    if (previousPhaseEnd !== undefined && first !== undefined) {
      const elapsed = first.at - previousPhaseEnd.at;
      if (elapsed >= NOTCH_MIN_MS) {
        gaps.push({
          activeOffsetMs: segment.activeStartMs,
          ms: elapsed,
          startedAt: new Date(previousPhaseEnd.at).toISOString(),
          endedAt: new Date(first.at).toISOString(),
        });
      }
    }

    events.forEach((event, i) => {
      const previous = events[i - 1];
      if (previous !== undefined) {
        const elapsed = event.at - previous.at;
        local = Math.min(local + Math.min(elapsed, IDLE_GAP_MS), segment.activeMs);
        if (elapsed >= NOTCH_MIN_MS) {
          gaps.push({
            activeOffsetMs: segment.activeStartMs + local,
            ms: elapsed,
            startedAt: new Date(previous.at).toISOString(),
            endedAt: new Date(event.at).toISOString(),
          });
        }
      }
      if (event.mark !== null) {
        marks.push({
          timestamp: event.mark.timestamp,
          category: event.mark.category,
          failed: event.mark.failed,
          turnIndex: event.turnIndex,
          activeOffsetMs: segment.activeStartMs + local,
        });
      }
    });

    previousPhaseEnd = events[events.length - 1] ?? previousPhaseEnd;
  });

  const totalActiveMs = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
  return { totalActiveMs: Math.max(1, totalActiveMs), segments, marks, gaps };
}

/** Phases laid end to end on the compressed axis, in order. */
function buildSegments(phases: Phase[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let offset = 0;
  phases.forEach((phase, phaseIndex) => {
    const activeMs = Math.max(1, phase.activeMs);
    segments.push({ phaseIndex, activeStartMs: offset, activeMs });
    offset += activeMs;
  });
  return segments;
}

function collectEvents(session: Session, startIndex: number, endIndex: number): Event[] {
  const events: Event[] = [];
  session.turns.slice(startIndex, endIndex + 1).forEach((turn, offset) => {
    const turnIndex = startIndex + offset;
    const turnAt = Date.parse(turn.timestamp);
    if (Number.isFinite(turnAt)) events.push({ at: turnAt, turnIndex, mark: null });
    for (const call of turn.toolCalls) {
      const at = Date.parse(call.timestamp);
      if (!Number.isFinite(at)) continue;
      events.push({
        at,
        turnIndex,
        mark: { category: call.category, failed: call.outcome === 'error', timestamp: call.timestamp },
      });
    }
  });
  return events.sort((a, b) => a.at - b.at);
}
