import type { Brief } from '@agentreplay/core';
import RichText from './RichText';

/**
 * How it ended, in one word or two. "blocked" outranks a check result: the
 * session did not fail, it stopped — and that distinction is the difference
 * between "fix the code" and "get me database access".
 */
function outcomeText(stats: Brief['stats']): string | null {
  if (stats.outcome === 'unknown') return null;
  if (stats.outcome === 'blocked') return 'blocked';
  const what = (stats.outcomeCheck ?? 'checks').toLowerCase();
  return `${what} ${stats.outcome === 'passed' ? 'passing' : 'failing'}`;
}

/**
 * Title, stats, phase bars, and at most one finding. Everything above the
 * session itself — five seconds should be enough to know what this was.
 * Duration is deliberately absent: the topbar prints it and the bars show it.
 */
export default function Header({ brief, children }: { brief: Brief; children?: React.ReactNode }) {
  const { stats } = brief;
  const parts = [
    `${stats.toolCalls} tool call${stats.toolCalls === 1 ? '' : 's'}`,
    `${stats.filesChanged} file${stats.filesChanged === 1 ? '' : 's'} changed`,
  ];
  if (stats.added > 0 || stats.removed > 0) parts.push(`+${stats.added} −${stats.removed}`);
  const outcome = outcomeText(stats);
  if (outcome !== null) parts.push(outcome);

  return (
    <header className="ar-header">
      <h1 className="ar-title">{brief.title}</h1>
      <p className="ar-stats mono">{parts.join(' · ')}</p>
      {/* The title is a compression and loses detail; the page still has to
          show what was actually asked for. */}
      {brief.openingPrompt !== null && <p className="ar-opening">“{brief.openingPrompt}”</p>}
      {children}
      {/* No mark: the headline is a finding, and a permanent warning triangle
          in front of "Everything passed first try" is the wrong tone twice
          over. The spans carry their own colour. */}
      {brief.headline !== null && (
        <p className="ar-headline">
          <RichText spans={brief.headline} />
        </p>
      )}
    </header>
  );
}
