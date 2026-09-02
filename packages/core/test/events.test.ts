import { describe, expect, it } from 'vitest';

import { extractEvents, pickBlocker, pickDecision, pickRootCause } from '../src/events.js';
import { analyzeParsedSession } from '../src/index.js';
import type { Session } from '../src/types.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const eventsOf = (session: Session) => extractEvents(analyzeParsedSession(session));

describe('extractEvents', () => {
  it('quotes a discovery and keeps the sentence that explains it', () => {
    const session = sessionWith([
      userTurn('why is the author tag missing'),
      assistantTurn(
        "Let me trace the query. That confirms hypothesis #1 and fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.",
        [tc.read('src/services/content.ts')],
      ),
      userTurn('got it', { gapSec: 120 }),
    ]);
    const found = eventsOf(session).find((event) => event.kind === 'rootCause');

    expect(found?.source).toBe('quoted');
    expect(found?.text).toContain('fully explains the symptom');
    // The conclusion alone means nothing without the clause that follows it.
    expect(found?.text).toContain('no author tag, no result');
    expect(found?.text).not.toContain('Let me trace');
    expect(found?.turnIndex).toBe(1);
  });

  it('backs a claim with evidence even when the turn ran no tools', () => {
    const session = sessionWith([
      userTurn('what is going on'),
      assistantTurn('Found it — the root cause is that Article.authorId is never set by the import path.', []),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const found = eventsOf(session).find((event) => event.kind === 'rootCause');
    // Nothing was opened, so the symbols the sentence names are what to check.
    expect(found?.evidence).toContain('Article.authorId');
  });

  it('records a goal change only after work has happened', () => {
    const session = sessionWith([
      userTurn('we want to add a retry queue'), // the original goal, not a pivot
      assistantTurn('sure', [tc.edit('src/queue.ts', 'a', 'b')]),
      userTurn('actually, can we build a backfill for the old rows instead', { gapSec: 200 }),
      assistantTurn('ok', [tc.edit('src/backfill.ts', 'a', 'b')], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const pivots = eventsOf(session).filter((event) => event.kind === 'pivot');

    expect(pivots).toHaveLength(1);
    expect(pivots[0]?.text).toContain('backfill for the old rows');
  });

  it('never treats a preamble as a finding', () => {
    const session = sessionWith([
      userTurn('look into it'),
      assistantTurn("I'll go and find out what the problem is with the importer.", [tc.read('src/a.ts')]),
      userTurn('ok', { gapSec: 120 }),
    ]);
    expect(eventsOf(session).filter((event) => event.kind === 'discovery')).toEqual([]);
  });

  it('emits structural events for edits, failures and checks', () => {
    const session = sessionWith([
      userTurn('build it'),
      assistantTurn('working', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: 2 failing' }),
      ]),
      userTurn('and again', { gapSec: 200 }),
      assistantTurn('fixed', [tc.bash('pnpm test', { result: '42 passed' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const kinds = eventsOf(session).map((event) => event.kind);

    expect(kinds).toContain('implementation');
    expect(kinds).toContain('failure');
    expect(kinds).toContain('verification');
    for (const event of eventsOf(session).filter((e) => e.source === 'structural')) {
      expect(event.evidence.length).toBeGreaterThanOrEqual(0);
      expect(event.turnIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic, ordered and JSON-safe', () => {
    const session = sessionWith([
      userTurn('why is it broken'),
      assistantTurn('Found it — the config never loads in production builds.', [tc.read('src/a.ts')]),
      userTurn('fix it', { gapSec: 200 }),
      assistantTurn("I'm blocked on reaching the staging database from here.", [tc.edit('src/a.ts', 'x', 'y')], { gapSec: 30 }),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const first = eventsOf(session);
    expect(eventsOf(session)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.map((event) => event.turnIndex)).toEqual([...first.map((e) => e.turnIndex)].sort((a, b) => a - b));
  });
});

describe('a verdict is not a finding', () => {
  it('never promotes "all green, no type errors, no lint findings" to a root cause', () => {
    // "no X, no Y" is the root-cause marker that exists for "no author tag, no
    // result". A passing check report satisfies it, and used to become the
    // loudest thing on the page while the real finding sat unmarked.
    const session = sessionWith([
      userTurn('run the full check before I merge'),
      assistantTurn('All green: 84 tests, no type errors, no lint findings. Safe to merge.', [
        tc.bash('pnpm test', { result: '84 passed (84)' }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const events = eventsOf(session);

    expect(events.filter((event) => event.kind === 'rootCause')).toEqual([]);
    expect(pickRootCause(events)).toBeNull();
  });

  it('still reads "no author tag, no result" as the root cause', () => {
    const session = sessionWith([
      userTurn('why is the author tag missing'),
      assistantTurn(
        'The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [tc.read('src/services/content.ts')],
      ),
      userTurn('got it', { gapSec: 120 }),
    ]);
    expect(pickRootCause(eventsOf(session))?.kind).toBe('rootCause');
  });
});

describe('labels', () => {
  it('drops an opener that points at the finding instead of stating it', () => {
    const session = sessionWith([
      userTurn('so what do we do'),
      assistantTurn(
        'The goal is clear: a backfill script that finds untagged author articles and sets the id.',
        [],
      ),
      userTurn('go', { gapSec: 120 }),
    ]);
    const decision = eventsOf(session).find((event) => event.kind === 'decision');

    expect(decision?.label).toMatch(/^a backfill script/);
    // The full sentence is still there — the opener moved to the evidence layer.
    expect(decision?.text).toContain('The goal is clear');
  });

  it('keeps a leading path out of the lead-in stripper', () => {
    const session = sessionWith([
      userTurn('what did you find'),
      assistantTurn(
        'There it is. src/lib/stripe.ts resolves the webhook secret once at module load, before the tests set it.',
        [tc.read('src/lib/stripe.ts')],
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const found = eventsOf(session).find((event) => event.kind === 'discovery');

    expect(found?.label).toMatch(/^src\/lib\/stripe\.ts resolves/);
    expect(found?.label).not.toContain('There it is');
  });

  it('skips a pointer that is long enough to look like a finding', () => {
    // "That confirms hypothesis #1 and fully explains the symptom." clears any
    // length test and names nothing; the sentence after it is the finding.
    const session = sessionWith([
      userTurn('why is the author tag missing'),
      assistantTurn(
        'That confirms hypothesis #1 and fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [tc.read('src/services/content.ts')],
      ),
      userTurn('got it', { gapSec: 120 }),
    ]);
    const found = eventsOf(session).find((event) => event.kind === 'rootCause');

    expect(found?.label).toContain('Article.authorId');
    expect(found?.label).not.toContain('hypothesis #1');
  });

  it('drops a parenthetical aside rather than dying inside it', () => {
    const session = sessionWith([
      userTurn('so what do we do'),
      assistantTurn(
        'The goal is clear: a backfill script that finds untagged author articles (author name in title, or single-author product set) and sets Article.authorId.',
        [],
      ),
      userTurn('go', { gapSec: 120 }),
    ]);
    const decision = eventsOf(session).find((event) => event.kind === 'decision');

    expect(decision?.label).not.toMatch(/…$/);
    expect(decision?.label).not.toContain('author name in title');
    // The aside went; the thing the label is about survived.
    expect(decision?.label).toContain('Article.authorId');
  });

  it('keeps the clause the marker matched, not the first clause that fits', () => {
    const session = sessionWith([
      userTurn('did it run'),
      assistantTurn(
        "The script is written and typechecks, but I'm blocked on reaching the CMS database from this machine — that last step needs input only you have.",
        [],
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const blocker = eventsOf(session).find((event) => event.kind === 'blocker');

    // Clipping to budget would keep "The script is written and typechecks" —
    // the reassuring half — and lose the blocker entirely.
    expect(blocker?.label).toContain('blocked on reaching the CMS database');
    expect(blocker?.label).not.toMatch(/…$/);
  });

  it('cuts at a clause boundary rather than mid-thought', () => {
    const session = sessionWith([
      userTurn('where do articles live'),
      assistantTurn(
        'Turns out articles are not in Supabase — they live in a separate CMS Postgres database, and the consumer author page reads them live from that database on every request.',
        [],
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const found = eventsOf(session).find((event) => event.kind === 'discovery');

    // The marker is the opener; the clause after it is the point, and both fit.
    expect(found?.label).toMatch(/database$/);
    expect(found?.label).toContain('not in Supabase');
    expect(found?.label).not.toMatch(/…$/);
  });

  it('says the same line once, however many markers matched it', () => {
    // Two sentences of one paragraph can fire two markers and clip to the same
    // line. Same words, same moment — the stronger reading of it wins.
    const session = sessionWith([
      userTurn('what did you find'),
      assistantTurn(
        'Found the whole chain. One big surprise up front: articles are not in Supabase — they live in a separate CMS Postgres database, which is why the author page misses them.',
        [],
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const labels = eventsOf(session).map((event) => event.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never invents a word — every label is a substring of its own text', () => {
    const session = sessionWith([
      userTurn('why is it broken'),
      assistantTurn('Found it — the config never loads in production builds.', [tc.read('src/a.ts')]),
      userTurn('ok', { gapSec: 120 }),
    ]);
    for (const event of eventsOf(session).filter((e) => e.source === 'quoted')) {
      expect(event.text).toContain(event.label.replace(/…$/, ''));
    }
  });
});

describe('collapsing repeats', () => {
  it('reports the edits of one turn as one change set', () => {
    const session = sessionWith([
      userTurn('apply the plan'),
      assistantTurn('working', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.edit('src/handler.ts', 'c', 'd'),
        tc.edit('src/retry.ts', 'e', 'f'),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const edits = eventsOf(session).filter((event) => event.kind === 'implementation');

    expect(edits).toHaveLength(1);
    expect(edits[0]?.count).toBe(3);
    expect(edits[0]?.label).toContain('3 files changed');
    expect(edits[0]?.evidence).toContain('src/handler.ts');
  });

  it('quotes the run that failed, not the one that passed after it', () => {
    // `note` describes the last run. A group that failed then passed ends
    // green, so the failure was being reported as "42 passed".
    const session = sessionWith([
      userTurn('run the tests'),
      assistantTurn('trying', [
        tc.bash('pnpm test', { error: 'Error: signature mismatch in verify.ts' }),
        tc.bash('pnpm test', { result: '42 passed' }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const failure = eventsOf(session).find((event) => event.kind === 'failure');

    expect(failure?.label).toContain('signature mismatch');
    expect(failure?.label).not.toContain('42 passed');
  });

  it('counts identical failures once, and only within a phase', () => {
    const session = sessionWith([
      userTurn('fix it'),
      assistantTurn('try one', [
        tc.edit('src/a.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: signature mismatch in verify.ts' }),
      ]),
      assistantTurn('try two', [
        tc.edit('src/a.ts', 'b', 'c'),
        tc.bash('pnpm test', { error: 'Error: signature mismatch in verify.ts' }),
      ], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const failures = eventsOf(session).filter((event) => event.kind === 'failure');

    expect(failures).toHaveLength(1);
    expect(failures[0]?.count).toBeGreaterThan(1);
  });
});

describe('rank', () => {
  const session = sessionWith([
    userTurn('why is it broken'),
    assistantTurn('Found it — the importer never sets the id on legacy rows.', [tc.read('src/import.ts')]),
    userTurn('fix it', { gapSec: 200 }),
    assistantTurn("Written, but I'm blocked on reaching the CMS database from this machine.", [
      tc.edit('scripts/backfill.ts', 'a', 'b'),
    ], { gapSec: 30 }),
    userTurn('ok', { gapSec: 120 }),
  ]);
  const events = eventsOf(session);
  const rankOf = (kind: string) => events.find((event) => event.kind === kind)?.rank;

  it('gives a finding the heavier mark and a change set the lighter one', () => {
    expect(rankOf('discovery')).toBe('key');
    expect(rankOf('implementation')).toBe('normal');
  });

  it('treats what stopped the session as the outcome', () => {
    expect(rankOf('blocker')).toBe('outcome');
  });

  it('leaves a structural plan stub as an ordinary step', () => {
    const structural = events.find((event) => event.kind === 'decision' && event.source === 'structural');
    if (structural !== undefined) expect(structural.rank).toBe('normal');
  });
});

describe('relatesTo', () => {
  it('links a finding back to the earlier phase that already named the file', () => {
    const session = sessionWith([
      userTurn('why are signatures failing'),
      assistantTurn('Found it — both env vars in src/lib/stripe.ts default to the empty string.', [
        tc.read('src/lib/stripe.ts'),
      ]),
      userTurn('now fix the verifier', { gapSec: 900 }),
      assistantTurn('working', [tc.edit('src/verify.ts', 'a', 'b')], { gapSec: 30 }),
      userTurn('still failing, what about the secret', { gapSec: 900 }),
      assistantTurn('Turns out src/lib/stripe.ts resolves the secret once at module load.', [
        tc.read('src/lib/stripe.ts'),
      ], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const events = eventsOf(session);
    const last = events.filter((event) => event.kind === 'discovery').pop();

    expect(last?.relatesTo).not.toBeNull();
    expect(last?.relatesTo).toBeLessThan(last?.turnIndex ?? 0);
  });

  it('does not call a shared check name a callback', () => {
    // Two phases that both ran "Tests" both ran tests. That is not a thread
    // coming back, and treating it as one puts a link on every verify phase.
    const session = sessionWith([
      userTurn('run the tests'),
      assistantTurn('trying', [tc.bash('pnpm test', { error: 'Error: 2 failing' })]),
      userTurn('now run them again', { gapSec: 900 }),
      assistantTurn('green', [tc.bash('pnpm test', { result: '42 passed' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    for (const event of eventsOf(session)) {
      if (event.evidence.every((item) => !item.includes('/'))) expect(event.relatesTo).toBeNull();
    }
  });
});

describe('the read that ended a stall', () => {
  const stalled = (closing: string) =>
    sessionWith([
      userTurn('the webhook tests are failing'),
      assistantTurn('one', [tc.edit('src/verify.ts', 'a', 'b'), tc.bash('pnpm test', { error: 'Error: signature mismatch' })]),
      assistantTurn('two', [tc.edit('src/verify.ts', 'b', 'c'), tc.bash('pnpm test', { error: 'Error: signature mismatch' })], { gapSec: 30 }),
      assistantTurn('three', [tc.edit('src/verify.ts', 'c', 'd'), tc.bash('pnpm test', { error: 'Error: signature mismatch' })], { gapSec: 30 }),
      assistantTurn(closing, [tc.read('src/lib/stripe.ts'), tc.edit('src/verify.ts', 'd', 'e'), tc.bash('pnpm test', { result: '12 passed' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);

  it('records the breakthrough when the turn never said what was found', () => {
    const found = eventsOf(stalled('ok')).find(
      (event) => event.kind === 'discovery' && event.source === 'structural',
    );
    expect(found?.label).toContain('src/lib/stripe.ts');
    expect(found?.label).toContain('identical failures');
  });

  it('stands aside when the session said it in its own words', () => {
    const events = eventsOf(stalled('Found it — the secret resolves once at module load, before the tests set it.'));
    const discoveries = events.filter((event) => event.kind === 'discovery');

    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]?.source).toBe('quoted');
  });
});

describe('picking what carries the session', () => {
  const session = sessionWith([
    userTurn('why is the article missing'),
    assistantTurn('Found it — the mental model is that authorId is the single load-bearing tag here.', [
      tc.read('src/content.ts'),
    ]),
    userTurn('so what do we do', { gapSec: 200 }),
    assistantTurn(
      'The goal is clear: a backfill script that finds untagged articles and sets Article.authorId.',
      [],
      { gapSec: 30 },
    ),
    userTurn('go', { gapSec: 200 }),
    assistantTurn("Written and typechecked, but I'm blocked on reaching the CMS database from this machine.", [
      tc.edit('scripts/backfill.ts', 'a', 'b'),
    ], { gapSec: 30 }),
    userTurn('thanks', { gapSec: 120 }),
  ]);
  const events = eventsOf(session);

  it('finds the sentence that explains the session', () => {
    expect(pickRootCause(events)?.text).toContain('load-bearing');
  });

  it('prefers a stated decision over the structural stub', () => {
    const decision = pickDecision(events);
    expect(decision?.source).toBe('quoted');
    expect(decision?.text).toContain('backfill script');
  });

  it('reports what stopped the work', () => {
    expect(pickBlocker(events)?.text).toContain('blocked on reaching the CMS database');
  });

  it('returns null rather than guessing when the session said none of it', () => {
    const quiet = eventsOf(
      sessionWith([
        userTurn('just look around'),
        assistantTurn('ok', [tc.read('src/a.ts'), tc.read('src/b.ts')]),
        userTurn('thanks', { gapSec: 120 }),
      ]),
    );
    expect(pickRootCause(quiet)).toBeNull();
    expect(pickBlocker(quiet)).toBeNull();
  });
});
