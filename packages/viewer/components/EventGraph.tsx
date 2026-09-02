'use client';

import { useEffect, useState } from 'react';
import type { AnalyzedSession, Brief, EventKind, SessionEvent } from '@agentreplay/core';
import EvidenceDrawer from './EvidenceDrawer';
import { fmtClock, tail } from '../lib/format';

/**
 * The event graph: one chronological column that tells the shortest truthful
 * story of the session. This is the replay — there is no other layout.
 *
 *   Ribbon = map · Event graph = story · Evidence drawer = proof
 *
 * The column draws `analyzed.replay` — core's replay selection (replay.ts):
 * detection finds every checkable moment, selection keeps the few that carry
 * the arc. The viewer adds only the opening request and the drawing; nothing
 * here decides what happened, and no string is authored on this side.
 * Evidence never opens inline: the graph's vertical layout is the story, and
 * proof appears in a drawer beside it so selecting an event never moves the
 * events below it.
 */

export const MARK: Record<EventKind, string> = {
  question: '○',
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
  question: '',
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

export default function EventGraph({ analyzed, brief }: { analyzed: AnalyzedSession; brief: Brief }) {
  const moments = [...opening(analyzed, brief), ...analyzed.replay];
  const [selected, setSelected] = useState<number | null>(null);

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
}: {
  event: SessionEvent;
  id: string;
  selected: boolean;
  onSelect: () => void;
  seenAt: string | undefined;
  anchor: string | null;
}) {
  const chip = CHIP[event.kind];

  return (
    <article
      className={`ar-graph-node ar-graph-node--${event.rank} ar-graph-node--k-${event.kind}${selected ? ' is-selected' : ''}`}
      id={id}
    >
      <span className="ar-graph-time mono">{fmtClock(event.timestamp)}</span>
      <span className="ar-graph-mark" aria-hidden>
        {MARK[event.kind]}
      </span>

      <div className="ar-graph-body" onClick={onSelect} role="presentation">
        {chip !== '' && (
          <span className="ar-graph-chip mono">
            {chip}
            {event.count > 1 && ` ×${event.count}`}
          </span>
        )}

        <p className="ar-graph-text">{event.label}</p>

        <p className="ar-graph-support mono">
          {event.evidence.slice(0, 3).map((item, i) => (
            <span key={i} className="ar-graph-support-item" title={item}>
              {tail(item, 2)}
            </span>
          ))}
          {seenAt !== undefined &&
            (anchor !== null ? (
              <button
                className="ar-graph-seen"
                onClick={(click) => {
                  click.stopPropagation();
                  document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              >
                ↑ first seen {fmtClock(seenAt)}
              </button>
            ) : (
              <span className="ar-graph-seen">↑ first seen {fmtClock(seenAt)}</span>
            ))}
          <button className="ar-graph-evd" aria-expanded={selected} onClick={onSelect}>
            {selected ? 'Hide evidence' : 'Evidence →'}
          </button>
        </p>
      </div>
    </article>
  );
}

/**
 * The graph's beginning: the request, verbatim, as a quiet node. Built from
 * `brief.openingPrompt` — presentation of an existing verbatim string, not a
 * new extraction.
 */
function opening(analyzed: AnalyzedSession, brief: Brief): SessionEvent[] {
  if (brief.openingPrompt === null) return [];
  const turn = analyzed.session.turns[0];
  return [
    {
      kind: 'question',
      text: brief.openingPrompt,
      label: brief.openingPrompt,
      turnIndex: 0,
      timestamp: turn?.timestamp ?? analyzed.session.startedAt,
      phaseIndex: 0,
      evidence: [],
      source: 'quoted',
      weight: 0,
      rank: 'normal',
      count: 1,
      relatesTo: null,
    },
  ];
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
