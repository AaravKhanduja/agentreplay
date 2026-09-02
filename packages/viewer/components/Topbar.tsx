'use client';

import type { AnalyzedSession } from '@agentreplay/core';
import { durationMs, fmtClock, fmtDate, fmtDuration, truncateLeft } from '../lib/format';

export default function Topbar({ data }: { data: AnalyzedSession }) {
  const { session, enrichment } = data;
  const total = durationMs(session.startedAt, session.endedAt);

  return (
    <header className="ar-topbar">
      <span className="ar-wordmark">AgentReplay</span>
      <span className="ar-topbar-path mono" title={session.projectPath}>
        {truncateLeft(session.projectPath, 44)}
      </span>
      <span className="ar-topbar-spacer" />
      <span className="ar-topbar-meta mono">
        <span>{fmtDate(session.startedAt)}</span>
        <span className="ar-sep">·</span>
        <span>
          {fmtClock(session.startedAt)}–{fmtClock(session.endedAt)}
        </span>
        <span className="ar-sep">·</span>
        <span>{fmtDuration(total)}</span>
        {session.model && (
          <>
            <span className="ar-sep">·</span>
            <span>{session.model}</span>
          </>
        )}
        {enrichment === 'ollama' && <span className="ar-enrich-badge">ollama</span>}
      </span>
    </header>
  );
}
