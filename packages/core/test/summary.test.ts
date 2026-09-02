import { describe, expect, it } from 'vitest';

import { analyzeParsedSession } from '../src/index.js';
import { summarizeConclusion } from '../src/summary.js';
import type { Phase, Session } from '../src/types.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

function summarize(session: Session, kind?: Phase['kind']) {
  const analyzed = analyzeParsedSession(session);
  const phase =
    (kind === undefined ? analyzed.phases[0] : analyzed.phases.find((p) => p.kind === kind)) ??
    analyzed.phases[0];
  return phase === undefined ? null : summarizeConclusion(session, phase, analyzed);
}

describe('summarizeConclusion', () => {
  it('quotes the sentence that states what was learned, not the one that promised work', () => {
    const session = sessionWith([
      userTurn('why is the author tag missing'),
      assistantTurn(
        "I'll trace how an author page gets its articles, then report back. Let me fan out two searches in parallel.",
        [tc.bash('rg -n "authorId" "/project/src" -l', { result: '/project/src/lib/content.ts' })],
      ),
      assistantTurn(
        'That confirms hypothesis #1 and fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [tc.bash('rg -n "authorId" "/project/src/lib/content.ts"', { result: '12: authorId,' })],
        { gapSec: 60 },
      ),
      userTurn('got it', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect(summary?.source).toBe('session');
    expect(summary?.text).toContain('That confirms hypothesis #1');
    expect(summary?.text).toContain('no author tag, no result');
    expect(summary?.text).not.toContain("I'll trace");
  });

  it('points back at the turn it came from, so the reader can expand into the session', () => {
    const session = sessionWith([
      userTurn('what is going on'),
      assistantTurn('Let me look.', [tc.read('src/a.ts')]),
      assistantTurn(
        'Found it — the handler never passes the raw body, so every signature check fails.',
        [tc.read('src/b.ts')],
        { gapSec: 30 },
      ),
      userTurn('thanks', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect(summary?.turnIndex).toBe(2);
    expect(session.turns[summary?.turnIndex ?? -1]?.text).toContain('Found it');
  });

  it('does not inherit a preamble that shares the line with the conclusion', () => {
    const session = sessionWith([
      userTurn('run the backfill'),
      assistantTurn(
        "Let me find the firewall rule: The script is written and typechecks, but I'm blocked on reaching the database from this machine.",
        [tc.edit('scripts/backfill.ts', 'a', 'b'), tc.bash('pnpm run-ts scripts/backfill.ts', { error: 'Error: unreachable' })],
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect(summary?.text.startsWith('The script is written')).toBe(true);
  });

  it('never quotes code blocks, bullets or headings', () => {
    const session = sessionWith([
      userTurn('show me the query'),
      assistantTurn(
        '## Result\n\n- item one that is quite long and would otherwise be picked up as prose\n\n```sql\nSELECT * FROM articles WHERE author_id IS NULL;\n```\n\nThe query returns 41 untagged articles, so the backfill has real work to do.',
        [tc.read('src/a.ts')],
      ),
      userTurn('thanks', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect(summary?.text).toContain('41 untagged articles');
    expect(summary?.text).not.toContain('SELECT');
    expect(summary?.text).not.toContain('##');
  });

  it('falls back to computed facts when the session never concluded anything', () => {
    const session = sessionWith([
      userTurn('look around'),
      assistantTurn('ok', [
        tc.bash('rg -n "authorId" "/project/src" -l', { result: '/project/src/a.ts' }),
        tc.bash('rg -n "article" "/project/src" -l', { result: '' }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect(summary?.source).toBe('derived');
    // Composed from counts only — nothing invented, and no voice to attribute.
    expect(summary?.text).toMatch(/^Searched for authorId/);
    expect(summary?.text).toContain('found nothing');
  });

  it('caps a rambling conclusion at a sentence boundary', () => {
    const long = `Found the whole chain and it explains everything about the way these records move. ${'The mirror job copies rows nightly and nothing else touches them. '.repeat(4)}`;
    const session = sessionWith([
      userTurn('explain'),
      assistantTurn(long, [tc.read('src/a.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);

    const summary = summarize(session);
    expect((summary?.text ?? '').length).toBeLessThanOrEqual(220);
    expect(summary?.text.startsWith('Found the whole chain')).toBe(true);
  });

  it('prefers its own count over conversation for a verify phase', () => {
    const session = sessionWith([
      userTurn('run the checks'),
      assistantTurn('Editing first', [tc.edit('src/a.ts', 'x', 'y')]),
      userTurn('now check it', { gapSec: 200 }),
      assistantTurn(
        'That confirms the approach works and the whole design holds together nicely.',
        [
          tc.bash('pnpm test', { result: '84 passed (84)' }),
          tc.bash('pnpm typecheck', { result: '' }),
          tc.bash('pnpm lint', { result: '' }),
        ],
        { gapSec: 60 },
      ),
      userTurn('great', { gapSec: 200 }),
    ]);

    const summary = summarize(session, 'verify');
    // Chatter that happened to sound conclusive is not what the phase was about.
    expect(summary?.source).toBe('derived');
    expect(summary?.text).toMatch(/^3 checks, 3 passed/);
  });

  it('is deterministic and JSON-safe', () => {
    const session = sessionWith([
      userTurn('why'),
      assistantTurn('Found it — the config was never loaded in production builds.', [tc.read('src/a.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const first = summarize(session);
    expect(summarize(session)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('never throws on a phase with no assistant prose at all', () => {
    const session = sessionWith([userTurn('hello'), assistantTurn('', [tc.read('src/a.ts')])]);
    expect(() => summarize(session)).not.toThrow();
  });
});
