import { describe, expect, it } from 'vitest';

import { analyzeParsedSession } from '../src/index.js';
import type { Session, SessionEvent } from '../src/types.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const replayOf = (session: Session): SessionEvent[] => analyzeParsedSession(session).replay;

describe('selectReplayEvents — deduplication', () => {
  it('suppresses a later discovery that restates the root cause', () => {
    // The shape from a real session: after "the author-page query is a plain equality on
    // Article.authorId", a later "Article.authorId is the only identifier
    // that counts" adds nothing — same phase, same anchor, weaker kind.
    const session = sessionWith([
      userTurn('why is the article missing from the author page'),
      assistantTurn(
        'That confirms hypothesis #1 and fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [],
      ),
      assistantTurn(
        'Confirmed — for the consumer author page, Article.authorId is the only identifier that counts.',
        [],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.filter((event) => event.kind === 'rootCause')).toHaveLength(1);
    expect(replay.some((event) => event.label.includes('only identifier that counts'))).toBe(false);
  });

  it('keeps a discovery that is a causal step toward the root cause', () => {
    // "the data lives in the CMS database" precedes "the query needs authorId":
    // related, not redundant — different anchors, earlier turn.
    const session = sessionWith([
      userTurn('why is the article missing'),
      assistantTurn(
        'Found it — articles are not in Supabase, they live in a separate CMS Postgres database.',
        [],
      ),
      assistantTurn(
        'That fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.some((event) => event.kind === 'discovery' && event.label.includes('CMS Postgres'))).toBe(true);
    expect(replay.some((event) => event.kind === 'rootCause' && event.label.includes('plain equality'))).toBe(true);
  });

  it('demotes an earlier root-cause candidate: the last conclusion is the conclusion', () => {
    const session = sessionWith([
      userTurn('why is the article missing'),
      assistantTurn('The reason the sync fails is the importer never sets ids on legacy rows.', []),
      assistantTurn(
        'That fully explains the symptom. The author-page query is a plain equality on Article.authorId — no author tag, no result.',
        [],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);
    const rootCauses = replay.filter((event) => event.kind === 'rootCause');

    expect(rootCauses).toHaveLength(1);
    expect(rootCauses[0]?.label).toContain('plain equality');
    // The earlier candidate survives, re-read as the step it was.
    expect(replay.some((event) => event.kind === 'discovery' && event.label.includes('importer'))).toBe(true);
  });

  it('keeps both the goal change and the decision — what changed vs how', () => {
    const session = sessionWith([
      userTurn('debug why this article is missing'),
      assistantTurn('sure', [tc.edit('src/a.ts', 'a', 'b')]),
      userTurn('actually, can we add articles that were made for an author instead', { gapSec: 200 }),
      assistantTurn(
        'The goal is clear: a backfill script that finds untagged author articles and sets Article.authorId.',
        [],
        { gapSec: 30 },
      ),
      userTurn('go', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.some((event) => event.kind === 'pivot')).toBe(true);
    expect(replay.some((event) => event.kind === 'decision' && event.label.includes('backfill script'))).toBe(true);
  });

  it('never lets the structural plan stub stand in for a spoken decision', () => {
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn('The plan is to route the raw bytes into verification before anything parses them.', [
        tc.exitPlanMode('## Fix\n- step one\n- step two'),
      ]),
      userTurn('go', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);
    const decisions = replay.filter((event) => event.kind === 'decision');

    expect(decisions.every((event) => event.source === 'quoted')).toBe(true);
  });
});

describe('selectReplayEvents — collapsing runs', () => {
  it('collapses adjacent implementation turns into one beat', () => {
    const session = sessionWith([
      userTurn('apply the plan'),
      assistantTurn('working', [tc.edit('src/a.ts', 'a', 'b'), tc.edit('src/b.ts', 'c', 'd')]),
      assistantTurn('continuing', [tc.edit('src/c.ts', 'e', 'f')], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const implementations = replayOf(session).filter((event) => event.kind === 'implementation');

    expect(implementations).toHaveLength(1);
    expect(implementations[0]?.label).toContain('3 files changed');
    expect(implementations[0]?.evidence).toContain('src/c.ts');
  });

  it('collapses repeated successful verification into one node', () => {
    const session = sessionWith([
      userTurn('run the checks'),
      assistantTurn('running', [tc.bash('pnpm typecheck', { result: '0 errors' })]),
      assistantTurn('and tests', [tc.bash('pnpm test', { result: '42 passed' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const verifications = replayOf(session).filter((event) => event.kind === 'verification');

    expect(verifications).toHaveLength(1);
  });

  it('keeps a failure that led to the finding — the transition is the story', () => {
    const session = sessionWith([
      userTurn('run it'),
      assistantTurn('trying', [
        tc.edit('src/verify.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: signature mismatch in verify.ts' }),
      ]),
      assistantTurn(
        'Found it — the secret resolves once at module load, before the tests ever set it.',
        [tc.read('src/lib/stripe.ts')],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.some((event) => event.kind === 'failure' && event.label.includes('signature mismatch'))).toBe(true);
    expect(replay.some((event) => event.kind === 'discovery')).toBe(true);
  });

  it('keeps one failure per phase when several describe the same struggle', () => {
    const session = sessionWith([
      userTurn('run the backfill'),
      assistantTurn('running', [
        tc.bash('pnpm typecheck', { error: 'Error: 1 type error' }),
        tc.bash('pnpm run-ts scripts/backfill.ts', { error: "Error: Can't reach database server at 10.0.0.5:5432" }),
        tc.bash('pnpm run-ts scripts/backfill.ts', { error: "Error: Can't reach database server at 10.0.0.5:5432" }),
      ]),
      userTurn('hm', { gapSec: 120 }),
    ]);
    const failures = replayOf(session).filter((event) => event.kind === 'failure');

    expect(failures).toHaveLength(1);
    // The repeated one is the struggle; the one-off is noise beside it.
    expect(failures[0]?.label).toContain("Can't reach database server");
    expect(failures[0]?.count).toBe(2);
  });
});

describe('selectReplayEvents — the arc', () => {
  it('always ends a blocked session on the blocker', () => {
    const session = sessionWith([
      userTurn('run the backfill'),
      assistantTurn('working', [tc.edit('scripts/backfill.ts', 'a', 'b')]),
      assistantTurn(
        "The script is written and typechecks, but I'm blocked on reaching the CMS database from this machine.",
        [],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);
    const last = replay[replay.length - 1];

    expect(last?.kind).toBe('blocker');
  });

  it('keeps the early finding whose anchor the implementation later reuses', () => {
    const session = sessionWith([
      userTurn('what is wrong with the verifier'),
      assistantTurn('Found it — src/lib/stripe.ts resolves the webhook secret once at module load.', []),
      userTurn('fix it there', { gapSec: 200 }),
      assistantTurn('done', [tc.edit('src/lib/stripe.ts', 'a', 'b')], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.some((event) => event.kind === 'discovery' && event.evidence.includes('src/lib/stripe.ts'))).toBe(
      true,
    );
  });

  it('drops a finding that arrives after the outcome and changes nothing', () => {
    const session = sessionWith([
      userTurn('run the backfill'),
      assistantTurn('working', [tc.edit('scripts/backfill.ts', 'a', 'b')]),
      assistantTurn("I'm blocked on reaching the CMS database from this machine.", [], { gapSec: 30 }),
      assistantTurn('That error settles it for now — nothing else to try from here today.', [], { gapSec: 30 }),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const replay = replayOf(session);

    expect(replay.some((event) => event.label.includes('settles it'))).toBe(false);
    expect(replay[replay.length - 1]?.kind).toBe('blocker');
  });

  it('keeps the full detected set intact on analyzed.events', () => {
    const session = sessionWith([
      userTurn('run the checks'),
      assistantTurn('running', [tc.bash('pnpm typecheck', { result: '0 errors' })]),
      assistantTurn('and tests', [tc.bash('pnpm test', { result: '42 passed' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const analyzed = analyzeParsedSession(session);

    // Detection is not presentation: selection must never mutate or shrink
    // the detected set it reads from.
    expect(analyzed.events.length).toBeGreaterThanOrEqual(analyzed.replay.length);
    expect(analyzed.events.filter((event) => event.kind === 'verification').length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic and JSON-safe', () => {
    const session = sessionWith([
      userTurn('why is it broken'),
      assistantTurn('Found it — the config never loads in production builds.', [tc.read('src/a.ts')]),
      userTurn('fix it', { gapSec: 200 }),
      assistantTurn('done', [tc.edit('src/config.ts', 'x', 'y')], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const first = replayOf(session);
    expect(replayOf(session)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
