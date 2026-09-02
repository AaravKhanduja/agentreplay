'use client';

import { useEffect, useState } from 'react';
import type { AnalyzedSession, SessionEvent } from '@agentreplay/core';
import Markdown from './Markdown';
import { fmtClock } from '../lib/format';
import { CHIP, MARK } from './EventGraph';

/**
 * The proof for one selected event, in a drawer beside the graph.
 *
 * The graph is the story and must never move when evidence opens — inline
 * expansion pushed every later event down, which destroyed the one thing a
 * replay has: spatial stability. So proof lives here instead: the exact
 * snippet that earned the node, who said it and when, the files behind it,
 * and the full turn (markdown-rendered) with its tool activity. A reader
 * should leave knowing "this is why AgentReplay surfaced this event."
 *
 * Non-modal by design: a fixed panel, independently scrollable, closed by ×,
 * Escape, or selecting the event again. Selecting another event replaces the
 * contents. It absorbs what OriginalTurn used to render — this drawer was
 * that component's last consumer.
 */
export default function EvidenceDrawer({
  analyzed,
  event,
  onClose,
}: {
  analyzed: AnalyzedSession;
  event: SessionEvent;
  onClose: () => void;
}) {
  const turn = analyzed.session.turns[event.turnIndex];
  const speaker = turn?.role === 'user' ? 'You' : 'Claude';
  // Three levels of compression — graph, evidence, transcript. The full turn
  // is the deepest one and only renders when asked for; a new selection
  // starts compressed again.
  const [turnOpen, setTurnOpen] = useState(false);
  useEffect(() => setTurnOpen(false), [event]);

  return (
    <aside className="ar-drawer" aria-label="Evidence">
      <header className="ar-drawer-head">
        <span className={`ar-drawer-kind mono ar-drawer-kind--${event.kind}`}>
          <span aria-hidden>{MARK[event.kind]} </span>
          {CHIP[event.kind] === '' ? 'request' : CHIP[event.kind]}
          {event.count > 1 && ` ×${event.count}`}
        </span>
        <button className="ar-drawer-close mono" onClick={onClose} aria-label="Close evidence">
          ✕
        </button>
      </header>
      <p className="ar-drawer-prov mono">
        {speaker} · {fmtClock(event.timestamp)}
      </p>

      {/* The snippet the node stands on — exact transcript treatment, quotes
          and all: this is the one surface where quoting is the point. */}
      <section className="ar-drawer-section">
        <h3 className="ar-drawer-label mono">Exact evidence</h3>
        {event.source === 'quoted' ? (
          <p className="ar-drawer-quote">“{event.text}”</p>
        ) : (
          <p className="ar-drawer-fact">{event.text}</p>
        )}
      </section>

      {event.evidence.length > 0 && (
        <section className="ar-drawer-section">
          <h3 className="ar-drawer-label mono">{event.source === 'structural' ? 'From' : 'Files'}</h3>
          <p className="ar-drawer-files mono">
            {event.evidence.map((item, i) => (
              <span key={i}>{item}</span>
            ))}
          </p>
        </section>
      )}

      {turn !== undefined && (
        <section className="ar-drawer-section">
          <button className="ar-drawer-turn-toggle mono" aria-expanded={turnOpen} onClick={() => setTurnOpen(!turnOpen)}>
            {turnOpen ? 'Hide full turn' : 'View full turn →'}
          </button>
          {turnOpen && (
            <>
              {turn.text.trim() !== '' && (
                <div className="ar-drawer-turn">
                  <Markdown text={turn.text.trim()} />
                </div>
              )}
              {turn.toolCalls.length > 0 && (
                <>
                  <h3 className="ar-drawer-label mono ar-drawer-label--calls">Tool activity</h3>
                  <ul className="ar-drawer-calls mono">
                    {turn.toolCalls.map((call, i) => (
                      <li key={i}>
                        {call.name}({call.filePath ?? summarize(call.input)})
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      )}
    </aside>
  );
}

/** A tool call's most identifying input, for the `Tool(...)` line. */
function summarize(input: Record<string, unknown>): string {
  for (const key of ['command', 'pattern', 'description', 'plan']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
    }
  }
  return '';
}
