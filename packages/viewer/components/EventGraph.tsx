'use client';

import { useEffect, useState } from 'react';
import type { AnalyzedSession, EventKind, SessionEvent } from '@agentreplay/core';
import EvidenceDrawer from './EvidenceDrawer';
import { durationMs, fmtClock, fmtDuration, tail } from '../lib/format';

/**
 * The event graph: one chronological column that tells the shortest truthful
 * story of the session. This is the replay — there is no other layout.
 *
 *   Ribbon = map · Event graph = story · Evidence drawer = proof
 *
 * The column draws `analyzed.replay` — core's replay selection (replay.ts):
 * detection finds every checkable moment, selection keeps the few that carry
 * the arc. The viewer adds only the opening request and the drawing; nothing
 * here decides what happened, and no string is authored on this side. The
 * request itself is the header's, not a node: printing it in both places cost
 * the reader a screen before the first finding.
 * Evidence never opens inline: the graph's vertical layout is the story, and
 * proof appears in a drawer beside it so selecting an event never moves the
 * events below it.
 */

export const MARK: Record<EventKind, string> = {
  hypothesis: '●',
  discovery: '●',
  rootCause: '◎',
  decision: '◆',
  pivot: '↻',
  implementation: '○',
  failure: '✕',
  verification: '✓',
  blocker: '⚠',
};

export const CHIP: Record<EventKind, string> = {
  hypothesis: 'hypothesis',
  discovery: 'discovery',
  rootCause: 'root cause',
  decision: 'decision',
  pivot: 'goal changed',
  implementation: 'implementation',
  failure: 'failure',
  verification: 'verified',
  blocker: 'blocked',
};

export default function EventGraph({ analyzed }: { analyzed: AnalyzedSession }) {
  const moments = analyzed.replay;
  const [selected, setSelected] = useState<number | null>(null);
  /* Hovering a file lights it up everywhere else it appears. The finding a
     replay can show that scrollback cannot is that a file was open long
     before it mattered — so the graph lets you see it rather than say it. */
  const [litFile, setLitFile] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (moments.length === 0) return null;

  // The node an `↑ first seen` link can scroll to, by turn.
  const anchorByTurn = new Map<number, number>();
  moments.forEach((moment, index) => {
    if (!anchorByTurn.has(moment.turnIndex)) anchorByTurn.set(moment.turnIndex, index);
  });

  const current = selected !== null ? moments[selected] : undefined;

  return (
    <>
      <div className="ar-graph" aria-label="Session story">
        {groupByPhase(moments).map((group) => {
          const phase = analyzed.phases[group.phaseIndex];
          return (
            <section key={group.phaseIndex} className="ar-graph-phase" id={`graph-phase-${group.phaseIndex}`}>
              {/* A chapter marker, not navigation: a reader should remember
                  the root cause, not that there was an Explore phase. */}
              {phase !== undefined && (
                <header className="ar-graph-phase-head mono">
                  <span className={`ar-graph-phase-mark ar-graph-phase-mark--${phase.kind}`} aria-hidden />
                  <span className="ar-graph-phase-kind">{phase.kind}</span>
                  <span className="ar-graph-phase-time">
                    · {fmtClock(phase.startedAt)}–{fmtClock(phase.endedAt)}
                  </span>
                </header>
              )}
              {group.items.map(({ moment, index }) => (
                <Node
                  key={index}
                  event={moment}
                  id={`graph-ev-${index}`}
                  selected={selected === index}
                  onSelect={() => setSelected(selected === index ? null : index)}
                  seenAt={
                    moment.relatesTo !== null ? analyzed.session.turns[moment.relatesTo]?.timestamp : undefined
                  }
                  anchor={
                    moment.relatesTo !== null && anchorByTurn.has(moment.relatesTo)
                      ? `graph-ev-${anchorByTurn.get(moment.relatesTo)}`
                      : null
                  }
                  litFile={litFile}
                  onFile={setLitFile}
                />
              ))}
            </section>
          );
        })}
      </div>
      {current !== undefined && (
        <EvidenceDrawer analyzed={analyzed} event={current} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

/**
 * One moment on the column: time, mark, chip, the session's words, then a
 * footer of metadata that ends in the affordance — `Evidence →` sits with the
 * event it belongs to, quiet mono rather than a control, and the whole body
 * selects. No quotation marks and no speaker label: the wording is verbatim
 * from the session, but the graph is a reconstruction from evidence, not a
 * quote browser. Provenance lives in the drawer.
 */
function Node({
  event,
  id,
  selected,
  onSelect,
  seenAt,
  anchor,
  litFile,
  onFile,
}: {
  event: SessionEvent;
  id: string;
  selected: boolean;
  onSelect: () => void;
  seenAt: string | undefined;
  anchor: string | null;
  /** The file currently hovered anywhere in the graph, or null. */
  litFile: string | null;
  onFile: (file: string | null) => void;
}) {
  const chip = CHIP[event.kind];
  const echoes = litFile !== null && event.evidence.includes(litFile);

  return (
    <article
      className={`ar-graph-node ar-graph-node--${event.rank} ar-graph-node--k-${event.kind}${selected ? ' is-selected' : ''}`}
      id={id}
      data-echo={echoes || undefined}
    >
      <span className="ar-graph-time mono">{fmtClock(event.timestamp)}</span>
      <span className="ar-graph-mark" aria-hidden>
        {MARK[event.kind]}
      </span>

      <div className="ar-graph-body">
        {chip !== '' && (
          <span className="ar-graph-chip mono">
            {chip}
            {event.count > 1 && ` ×${event.count}`}
          </span>
        )}

        <button type="button" className="ar-graph-text" aria-expanded={selected} onClick={onSelect}>
          <span>{event.label}</span>
          <span className="ar-graph-cue" aria-hidden>
            {selected ? 'Hide evidence' : 'Evidence →'}
          </span>
        </button>

        {/* Two, not three: past a pair this reads as filing rather than
            support. Which two is core's call — the viewer only ever takes
            them in order. */}
        <p className="ar-graph-support mono">
          {event.evidence.slice(0, 2).map((item, i) => (
            <button
              key={i}
              type="button"
              className="ar-graph-support-item"
              title={item}
              data-lit={litFile === item || undefined}
              onMouseEnter={() => onFile(item)}
              onMouseLeave={() => onFile(null)}
              onFocus={() => onFile(item)}
              onBlur={() => onFile(null)}
            >
              {tail(item, 2)}
            </button>
          ))}
        </p>

        {/* Its own row, and it says the gap out loud. That a file had been open
            since 10:03 and took another 41 minutes to matter is the one thing
            a replay knows that scrollback does not — it should not be the
            dimmest text in the node. The elapsed figure is arithmetic over two
            timestamps the session already carries. */}
        {seenAt !== undefined && (
          <p className="ar-graph-echo mono">
            <Callback
              seenAt={seenAt}
              at={event.timestamp}
              anchor={anchor}
            />
          </p>
        )}
      </div>
    </article>
  );
}

/** `↑ first opened 10:03 · 41m earlier`, linked to that node when it is drawn. */
function Callback({ seenAt, at, anchor }: { seenAt: string; at: string; anchor: string | null }) {
  const gap = durationMs(seenAt, at);
  const label = `↑ first opened ${fmtClock(seenAt)}`;
  const since = gap > 60_000 ? ` · ${fmtDuration(gap)} earlier` : '';

  if (anchor === null) return <span className="ar-graph-seen">{label}{since}</span>;
  return (
    <button
      type="button"
      className="ar-graph-seen"
      onClick={(click) => {
        click.stopPropagation();
        document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
    >
      {label}
      {since}
    </button>
  );
}

function groupByPhase(
  moments: SessionEvent[],
): Array<{ phaseIndex: number; items: Array<{ moment: SessionEvent; index: number }> }> {
  const groups: Array<{ phaseIndex: number; items: Array<{ moment: SessionEvent; index: number }> }> = [];
  moments.forEach((moment, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.phaseIndex === moment.phaseIndex) last.items.push({ moment, index });
    else groups.push({ phaseIndex: moment.phaseIndex, items: [{ moment, index }] });
  });
  return groups;
}
