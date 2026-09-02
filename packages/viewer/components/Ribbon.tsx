'use client';

import type { AnalyzedSession, PhaseKind, TimelineMark } from '@agentreplay/core';
import { fmtClock, fmtDuration } from '../lib/format';

const HEIGHT = 32;
const BAND_Y = 0;
const BAND_H = 12;
const TICK_Y = 16;
/**
 * Ticks are texture, not data to read: in a 300-call session they must show
 * where the work clustered without competing with the phase band above them.
 */
const TICK_H = 6;

const MARK_FILL: Record<string, string> = {
  read: 'var(--read-fill)',
  write: 'var(--edit-fill)',
  bash: 'var(--bash-fill)',
  meta: 'var(--text-dim)',
};

const KIND_LABEL: Record<PhaseKind, string> = {
  explore: 'Explore',
  plan: 'Plan',
  execute: 'Execute',
  debug: 'Debug',
  verify: 'Verify',
};

/**
 * Nominal ribbon width, used only to decide whether a name fits under its own
 * block. Deliberately smaller than the real container: guessing narrow keeps a
 * name out of a cramped block rather than letting two of them collide, and the
 * cost of guessing wrong is a name in the trailing group instead of under its
 * block — not a broken drawing.
 */
const NOMINAL_PX = 720;
const CHAR_PX = 6.6;
/** Swatch, gap and breathing room either side of the name. */
const CHROME_PX = 24;

interface Spot {
  kind: PhaseKind;
  text: string;
  phaseIndex: number;
  /** Centre of the block this name belongs to, as a percentage of the axis. */
  centerPct: number;
  /** How much of the axis the block occupies. */
  widthPct: number;
  /** How much of the axis the name needs. */
  needPct: number;
}

/**
 * The shape of the session, in one drawing: phases as blocks, every tool call
 * as a tick coloured by what it was, failures in red, and long pauses as
 * notches in the axis.
 *
 * The axis is working time, not clock time. Drawn to the clock, a session
 * spread across a day is nine parts nothing and the work becomes slivers —
 * so idle is compressed to a notch that still names its real duration.
 *
 * Every colour in the band is named once, in the band. Naming every block was
 * what made an earlier version collide on long sessions and cost a row of
 * vertical space, so a kind is named at its widest block and nowhere else:
 * `Debug` appearing three times is one label, under the longest of the three.
 * A kind whose widest block is still too narrow to sit under joins the group
 * at the right — never left unnamed, because an unexplained colour in a legend
 * is the thing the legend exists to prevent.
 */
export default function Ribbon({ analyzed }: { analyzed: AnalyzedSession }) {
  const { timeline } = analyzed;
  if (timeline.segments.length === 0) return null;

  const pct = (ms: number): number => Math.min(100, Math.max(0, (ms / timeline.totalActiveMs) * 100));
  const jump = (phaseIndex: number): void => {
    document.getElementById(`graph-phase-${phaseIndex}`)?.scrollIntoView({ behavior: 'smooth' });
  };
  // Map ↔ story: hovering a block lights its chapter in the graph.
  const light = (phaseIndex: number, on: boolean): void => {
    document.getElementById(`graph-phase-${phaseIndex}`)?.classList.toggle('is-lit', on);
  };
  const longestGap = [...timeline.gaps].sort((a, b) => b.ms - a.ms)[0];
  const { placed, trailing } = legend(analyzed, pct);

  return (
    <figure className="ar-ribbon">
      <svg
        className="ar-ribbon-svg"
        viewBox={`0 0 100 ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Session shape by working time"
      >
        {timeline.segments.map((segment) => {
          const phase = analyzed.phases[segment.phaseIndex];
          if (phase === undefined) return null;
          return (
            <rect
              key={segment.phaseIndex}
              className={`ar-ribbon-phase ar-ribbon-phase--${phase.kind}`}
              x={pct(segment.activeStartMs)}
              y={BAND_Y}
              width={Math.max(0.3, pct(segment.activeMs))}
              height={BAND_H}
              onClick={() => jump(segment.phaseIndex)}
              onMouseEnter={() => light(segment.phaseIndex, true)}
              onMouseLeave={() => light(segment.phaseIndex, false)}
            >
              <title>{`${phase.kind} · ${fmtDuration(phase.activeMs)} working`}</title>
            </rect>
          );
        })}

        {dedupe(timeline.marks).map((mark, i) => (
          <rect
            key={i}
            x={pct(mark.activeOffsetMs)}
            y={mark.failed ? TICK_Y - 2 : TICK_Y}
            width="0.22"
            height={mark.failed ? TICK_H + 3 : TICK_H}
            fill={mark.failed ? 'var(--error)' : (MARK_FILL[mark.category] ?? 'var(--text-dim)')}
            opacity={mark.failed ? 0.95 : 0.6}
          />
        ))}

        {/* A pause: a break through the band, keeping its real length in the title. */}
        {timeline.gaps.map((gap, i) => (
          <g key={i} className="ar-ribbon-gap">
            <rect x={pct(gap.activeOffsetMs) - 0.22} y={BAND_Y - 1} width="0.44" height={BAND_H + 2} fill="var(--bg-app)" />
            <title>{`${fmtDuration(gap.ms)} idle`}</title>
          </g>
        ))}
      </svg>

      {/* The key, laid out along the axis it explains. Each name sits under the
          block it belongs to, so reading it is reading the drawing. */}
      <div className="ar-ribbon-key">
        {placed.map((spot) => (
          <button
            key={spot.kind}
            className="ar-ribbon-key-item"
            style={{ left: `${spot.left}%` }}
            onClick={() => jump(spot.phaseIndex)}
            onMouseEnter={() => light(spot.phaseIndex, true)}
            onMouseLeave={() => light(spot.phaseIndex, false)}
            title={`Jump to ${spot.text}`}
          >
            <span className={`ar-ribbon-swatch ar-ribbon-swatch--${spot.kind}`} aria-hidden />
            {spot.text}
          </button>
        ))}
        {trailing.length > 0 && (
          <span className="ar-ribbon-key-rest">
            {trailing.map((spot) => (
              <button
                key={spot.kind}
                className="ar-ribbon-key-item is-static"
                onClick={() => jump(spot.phaseIndex)}
                onMouseEnter={() => light(spot.phaseIndex, true)}
                onMouseLeave={() => light(spot.phaseIndex, false)}
                title={`Jump to ${spot.text}`}
              >
                <span className={`ar-ribbon-swatch ar-ribbon-swatch--${spot.kind}`} aria-hidden />
                {spot.text}
              </button>
            ))}
          </span>
        )}
      </div>

      <figcaption className="ar-ribbon-axis mono">
        <span>{fmtClock(analyzed.session.startedAt)}</span>
        <span className="ar-ribbon-note">
          {fmtDuration(timeline.totalActiveMs)} working
          {longestGap !== undefined && ` · longest pause ${fmtDuration(longestGap.ms)}`}
        </span>
        <span>{fmtClock(analyzed.session.endedAt)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * One name per kind, at its widest block, left to right.
 *
 * Placement is a single left-to-right walk with a cursor: a name that would
 * overlap the one before it, or that has no block wide enough to sit under,
 * goes to the trailing group instead. The right-hand strip the trailing group
 * needs is reserved before anything is placed, so the two can never run into
 * each other.
 */
function legend(
  analyzed: AnalyzedSession,
  pct: (ms: number) => number,
): { placed: Array<Spot & { left: number }>; trailing: Spot[] } {
  const widest = new Map<PhaseKind, Spot>();

  for (const segment of analyzed.timeline.segments) {
    const phase = analyzed.phases[segment.phaseIndex];
    if (phase === undefined) continue;
    const text = KIND_LABEL[phase.kind];
    const spot: Spot = {
      kind: phase.kind,
      text,
      phaseIndex: segment.phaseIndex,
      centerPct: pct(segment.activeStartMs + segment.activeMs / 2),
      widthPct: pct(segment.activeMs),
      needPct: ((text.length * CHAR_PX + CHROME_PX) / NOMINAL_PX) * 100,
    };
    const current = widest.get(phase.kind);
    if (current === undefined || spot.widthPct > current.widthPct) widest.set(phase.kind, spot);
  }

  const spots = [...widest.values()].sort((a, b) => a.centerPct - b.centerPct);
  const tooNarrow = spots.filter((spot) => spot.widthPct < spot.needPct);
  const reserved = tooNarrow.reduce((sum, spot) => sum + spot.needPct, 0);

  const placed: Array<Spot & { left: number }> = [];
  const trailing = [...tooNarrow];
  let cursor = 0;

  for (const spot of spots) {
    if (tooNarrow.includes(spot)) continue;
    const limit = 100 - reserved - spot.needPct;
    const left = Math.max(cursor, Math.min(spot.centerPct - spot.needPct / 2, limit));
    if (left > limit) {
      trailing.push(spot);
      continue;
    }
    placed.push({ ...spot, left });
    cursor = left + spot.needPct;
  }

  // Chronological, so the trailing group reads in the same order as the band.
  trailing.sort((a, b) => a.centerPct - b.centerPct);
  return { placed, trailing };
}

/**
 * Many calls can land on the same sliver of a long session. Keep one per
 * sliver, preferring a failure: a red tick must never be painted over.
 */
function dedupe(marks: TimelineMark[]): TimelineMark[] {
  const total = marks[marks.length - 1]?.activeOffsetMs ?? 1;
  const slivers = new Map<number, TimelineMark>();
  for (const mark of marks) {
    const key = Math.round((mark.activeOffsetMs / Math.max(1, total)) * 320);
    const existing = slivers.get(key);
    if (existing === undefined || (mark.failed && !existing.failed)) slivers.set(key, mark);
  }
  return [...slivers.values()];
}
