'use client';

import { useEffect, useState } from 'react';
import type { AnalyzedSession, Brief } from '@agentreplay/core';
import EventGraph from '../components/EventGraph';
import Header from '../components/Header';
import Ribbon from '../components/Ribbon';
import Topbar from '../components/Topbar';
import sample from '../lib/sample.json';

interface ViewerPayload {
  analyzed: AnalyzedSession;
  brief: Brief;
}

declare global {
  interface Window {
    __AGENTREPLAY_DATA__?: unknown;
  }
}

// scripts/inline.mjs injects `window.__AGENTREPLAY_DATA__ = "__AGENTREPLAY_DATA__";`
// into <head>, and the CLI replaces the quoted token with raw payload JSON.
// This module must never mention the quoted token in code the bundler can
// constant-fold into the output (the CLI's string replacement must only ever
// match the head script) — so the uninjected placeholder string is handled
// purely by the JSON.parse fallback below, never compared against.
function loadData(): ViewerPayload {
  const injected = window.__AGENTREPLAY_DATA__;
  if (typeof injected === 'string') {
    // Tolerate a CLI that injects a JSON string; the uninjected placeholder
    // string fails to parse and lands on the sample.
    try {
      return JSON.parse(injected) as ViewerPayload;
    } catch {
      return sample as unknown as ViewerPayload;
    }
  }
  if (injected === undefined || injected === null) {
    // `next dev`, or a built viewer.html opened without CLI injection.
    return sample as unknown as ViewerPayload;
  }
  return injected as ViewerPayload;
}

export default function Page() {
  // Data is read after mount: the page is prerendered at build time where
  // `window` does not exist, and reading it during render would make the
  // prerendered HTML disagree with the injected data at hydration.
  const [data, setData] = useState<ViewerPayload | null>(null);
  useEffect(() => {
    setData(loadData());
  }, []);

  if (!data) return null;
  return <Replay analyzed={data.analyzed} brief={data.brief} />;
}

/**
 * One answer to "what happened": the header names the session, the ribbon
 * maps the time, the event graph tells the story, and evidence sits one click
 * deeper. There is deliberately nothing else — the phase sections, spine,
 * root-cause card and outcomes block this replaced were four more answers to
 * the same question on one page.
 */
function Replay({ analyzed, brief }: ViewerPayload) {
  if (brief.thin) {
    return (
      <div className="ar-page">
        <Topbar data={analyzed} />
        <main className="ar-thin">
          <Header brief={brief} />
          <p className="ar-thin-note mono">
            {analyzed.session.turns.length} turns · {analyzed.files.length} files ·{' '}
            {brief.stats.toolCalls} tool calls — too little to replay.
          </p>
          <Footer />
        </main>
      </div>
    );
  }

  return (
    <div className="ar-page">
      <Topbar data={analyzed} />
      <main className="ar-main">
        <Header brief={brief}>
          <Ribbon analyzed={analyzed} />
        </Header>
        <EventGraph analyzed={analyzed} brief={brief} />
        <Footer />
      </main>
    </div>
  );
}

function Footer() {
  return <footer className="ar-footer mono">generated locally · nothing left your machine</footer>;
}
