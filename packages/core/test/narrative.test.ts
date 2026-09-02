import { describe, expect, it } from 'vitest';

import { buildBrief } from '../src/narrative.js';
import type { AnalyzedSession, RichText, Session } from '../src/types.js';
import { analyzeParsedSession } from '../src/index.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

/** Run the real pipeline so fixtures stay honest with the heuristics. */
const analyze = (session: Session): AnalyzedSession => analyzeParsedSession(session);

const text = (rich: RichText): string => rich.map((span) => span.text).join('');
const withStyle = (rich: RichText, style: string): string[] =>
  rich.filter((span) => span.style === style).map((span) => span.text);

const TYPE_ERROR = "TypeError: Cannot read properties of undefined (reading 'id')";

/** Three identical failures and no fix: the session ends still red. */
function unresolvedSession(): Session {
  return sessionWith([
    userTurn('fix it'),
    assistantTurn('a1', [tc.edit('src/a.ts', 'x1', 'y1'), tc.bash('pnpm test', { error: TYPE_ERROR })]),
    assistantTurn('a2', [tc.edit('src/a.ts', 'x2', 'y2'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 120 }),
    assistantTurn('a3', [tc.edit('src/a.ts', 'x3', 'y3'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 120 }),
    userTurn('hm'),
    assistantTurn('sorry', []),
  ]);
}

/**
 * Explore (with src/lib/stripe.ts backtracked), then a debug phase: three
 * attempts stuck on the same TypeError, a read of src/lib/stripe.ts, a
 * breakthrough (new error), and a final passing run.
 */
function debugHeavySession(): Session {
  return sessionWith([
    userTurn('the stripe webhook handler is broken'),
    assistantTurn('let me look around', [
      tc.read('src/lib/stripe.ts'),
      tc.read('src/app.ts'),
      tc.read('src/routes/webhook.ts'),
      tc.read('src/config.ts'),
      tc.read('src/lib/stripe.ts'), // backtracked: ≥3 distinct others in between
    ]),
    userTurn('fix the TypeError', { gapSec: 120 }),
    assistantTurn('attempt 1', [tc.edit('src/routes/webhook.ts', 'a1', 'b1'), tc.bash('pnpm test', { error: TYPE_ERROR })]),
    assistantTurn('attempt 2', [tc.edit('src/routes/webhook.ts', 'a2', 'b2'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 300 }),
    assistantTurn('attempt 3', [tc.edit('src/routes/webhook.ts', 'a3', 'b3'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 300 }),
    assistantTurn('reading the stripe lib', [tc.read('src/lib/stripe.ts')], { gapSec: 300 }),
    assistantTurn('the fix', [tc.edit('src/routes/webhook.ts', 'a4', 'b4'), tc.bash('pnpm test', { error: 'AssertionError: expected 200 to equal 500' })], { gapSec: 60 }),
    assistantTurn('final touch', [tc.edit('src/routes/webhook.ts', 'a5', 'b5'), tc.bash('pnpm test', { result: 'all tests passed' })], { gapSec: 60 }),
  ]);
}

/** Same shape, but the breakthrough file is never read anywhere else. */
function debugWithoutBacktrackSession(): Session {
  return sessionWith([
    userTurn('the stripe webhook handler is broken'),
    assistantTurn('let me look around', [
      tc.read('src/app.ts'),
      tc.read('src/routes/webhook.ts'),
      tc.read('src/config.ts'),
    ]),
    userTurn('fix the TypeError', { gapSec: 120 }),
    assistantTurn('attempt 1', [tc.edit('src/routes/webhook.ts', 'a1', 'b1'), tc.bash('pnpm test', { error: TYPE_ERROR })]),
    assistantTurn('attempt 2', [tc.edit('src/routes/webhook.ts', 'a2', 'b2'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 300 }),
    assistantTurn('attempt 3', [tc.edit('src/routes/webhook.ts', 'a3', 'b3'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 300 }),
    assistantTurn('reading the stripe lib', [tc.read('src/lib/stripe.ts')], { gapSec: 300 }),
    assistantTurn('the fix', [tc.edit('src/routes/webhook.ts', 'a4', 'b4'), tc.bash('pnpm test', { error: 'AssertionError: expected 200 to equal 500' })], { gapSec: 60 }),
    assistantTurn('final touch', [tc.edit('src/routes/webhook.ts', 'a5', 'b5'), tc.bash('pnpm test', { result: 'all tests passed' })], { gapSec: 60 }),
  ]);
}

/** Explore then execute; every run passes, no debug loops, no plan. */
function cleanSession(): Session {
  return sessionWith([
    userTurn('add request logging'),
    assistantTurn('looking', [tc.read('src/app.ts'), tc.read('src/middleware.ts'), tc.read('src/logger.ts')]),
    userTurn('go ahead', { gapSec: 120 }),
    assistantTurn('editing middleware', [tc.edit('src/middleware.ts', 'a', 'b'), tc.bash('pnpm test', { result: 'ok' })]),
    assistantTurn('editing logger', [tc.edit('src/logger.ts', 'c', 'd'), tc.bash('pnpm test', { result: 'ok' })]),
  ]);
}

/** Plan (two revisions) then a debug phase whose breakthrough is a stripe read. */
function plannedDebugSession(revisionMentionsBreakthroughFile: boolean): Session {
  const secondDraft = [
    '## Plan',
    '',
    'Fix webhook parsing in src/routes/webhook.ts',
    '',
    'Add tests for the handler',
    '',
    revisionMentionsBreakthroughFile ? 'Harden the retry queue in src/lib/stripe.ts' : 'Harden the retry queue',
  ].join('\n');
  return sessionWith([
    userTurn('plan the webhook fix'),
    assistantTurn('here is a plan', [
      tc.exitPlanMode('## Plan\n\nFix webhook parsing in src/routes/webhook.ts\n\nAdd tests for the handler'),
    ]),
    userTurn('also cover the stripe retry queue', { gapSec: 60 }),
    assistantTurn('updated the plan', [tc.exitPlanMode(secondDraft)], { gapSec: 60 }),
    userTurn('go', { gapSec: 60 }),
    assistantTurn('attempt 1', [tc.edit('src/routes/webhook.ts', 'a1', 'b1'), tc.bash('pnpm test', { error: TYPE_ERROR })]),
    assistantTurn('attempt 2', [tc.edit('src/routes/webhook.ts', 'a2', 'b2'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 200 }),
    assistantTurn('attempt 3', [tc.edit('src/routes/webhook.ts', 'a3', 'b3'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 200 }),
    assistantTurn('reading the stripe lib', [tc.read('src/lib/stripe.ts')], { gapSec: 200 }),
    assistantTurn('the fix', [tc.edit('src/routes/webhook.ts', 'a4', 'b4'), tc.bash('pnpm test', { error: 'AssertionError: expected 200 to equal 500' })], { gapSec: 60 }),
    assistantTurn('final touch', [tc.edit('src/routes/webhook.ts', 'a5', 'b5'), tc.bash('pnpm test', { result: 'all tests passed' })], { gapSec: 60 }),
  ]);
}

describe('buildBrief — title and stats', () => {
  it('titles the session from what the user asked for', () => {
    const brief = buildBrief(analyze(debugHeavySession()));
    expect(brief.title).toBe('The stripe webhook handler is broken');
  });

  it('counts tool calls and changed lines, and never repeats the duration', () => {
    const analyzed = analyze(debugHeavySession());
    const brief = buildBrief(analyzed);
    const calls = analyzed.session.turns.reduce((n, turn) => n + turn.toolCalls.length, 0);

    expect(brief.stats.toolCalls).toBe(calls);
    expect(brief.stats.filesChanged).toBe(analyzed.editHistories.length);
    expect(brief.stats.added).toBeGreaterThan(0);
    expect(brief.stats.outcome).toBe('passed');
    expect(Object.keys(brief.stats)).not.toContain('durationMs');
  });

  it('reports a failing outcome when the last run still failed', () => {
    expect(buildBrief(analyze(unresolvedSession())).stats.outcome).toBe('failing');
  });
});

describe('buildBrief — headline', () => {
  it('names the stall and the read that broke it', () => {
    const line = buildBrief(analyze(debugHeavySession())).headline ?? [];

    expect(text(line)).toMatch(/repeating the same TypeError/);
    expect(withStyle(line, 'bad')).toContain('TypeError');
    expect(withStyle(line, 'bad').some((t) => /^\d+ minutes?$/.test(t))).toBe(true);
    expect(withStyle(line, 'file')).toContain('src/lib/stripe.ts');
    expect(withStyle(line, 'good')).toContain('broke the loop');
  });

  it('does not enumerate what the session did — the header stats carry that', () => {
    const line = buildBrief(analyze(debugHeavySession())).headline ?? [];
    expect(text(line)).not.toMatch(/explored \d+ files|edited \d+ files|You /);
  });

  it('credits a clean session and stays to one sentence', () => {
    const line = buildBrief(analyze(cleanSession())).headline ?? [];
    expect(withStyle(line, 'good')).toContain('Everything passed first try');
  });

  it('flags an unresolved ending in bad style', () => {
    const line = buildBrief(analyze(unresolvedSession())).headline ?? [];
    expect(withStyle(line, 'bad').join(' ').toLowerCase()).toContain('still failing');
  });

  it('never tells a blocked session its checks failed', () => {
    // The session stopped; it did not fail. Saying "Typecheck was still
    // failing" over a blocker that reads "the script is written and
    // typechecks" is the page contradicting itself in two places at once.
    const session = sessionWith([
      userTurn('backfill the untagged rows'),
      assistantTurn('working', [
        tc.edit('scripts/backfill.ts', 'a', 'b'),
        tc.bash('pnpm typecheck', { error: 'Error: 1 error' }),
      ]),
      userTurn('and run it', { gapSec: 200 }),
      assistantTurn(
        "The script is written and typechecks, but I'm blocked on reaching the CMS database from this machine.",
        [],
        { gapSec: 30 },
      ),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const brief = buildBrief(analyze(session));

    expect(brief.stats.outcome).toBe('blocked');
    expect(text(brief.headline ?? []).toLowerCase()).not.toContain('still failing');
  });

  it('does not lead with the blocker — the tail carries it', () => {
    const session = sessionWith([
      userTurn('backfill the untagged rows'),
      assistantTurn('working', [tc.edit('scripts/backfill.ts', 'a', 'b')]),
      userTurn('and run it', { gapSec: 200 }),
      assistantTurn("I'm blocked on reaching the CMS database from this machine.", [], { gapSec: 30 }),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const brief = buildBrief(analyze(session));

    expect(text(brief.headline ?? []).toLowerCase()).not.toContain('blocked');
    // Still on the page, where a verdict belongs.
    expect(brief.blocker?.label).toContain('CMS database');
  });

  it('says nothing at all when the session found nothing', () => {
    const session = sessionWith([
      userTurn('what does this repo do'),
      assistantTurn('reading', [tc.read('README.md'), tc.read('src/index.ts'), tc.read('package.json')]),
      userTurn('and the tests?'),
      assistantTurn('reading more', [tc.read('test/app.test.ts'), tc.read('vitest.config.ts')]),
      userTurn('thanks'),
    ]);
    expect(buildBrief(analyze(session)).headline).toBeNull();
  });
});

describe('buildBrief — thin sessions', () => {
  it('returns the honest short form for a <5 turn session', () => {
    const session = sessionWith([
      userTurn('what does this repo do'),
      assistantTurn('reading', [tc.read('README.md')]),
    ]);
    const brief = buildBrief(analyze(session));
    expect(brief.thin).toBe(true);
    expect(brief.title.length).toBeGreaterThan(0);
    expect(brief.headline).toBeNull();
    expect(brief.takeaways).toEqual([]);
    expect(brief.sections).toEqual([]);
  });

  it('never throws on an empty session', () => {
    const brief = buildBrief(analyze(sessionWith([])));
    expect(brief.thin).toBe(true);
    expect(brief.title.length).toBeGreaterThan(0);
  });
});

describe('buildBrief — the opening prompt', () => {
  it('keeps the request that started the session, verbatim', () => {
    const brief = buildBrief(analyze(debugHeavySession()));
    expect(brief.openingPrompt).toBe('the stripe webhook handler is broken');
  });

  it('is null when the session opened with something unquotable', () => {
    const session = sessionWith([
      userTurn('/var/folders/kn/T/TemporaryItems/NSIRD_screencapture/Screenshot.png'),
      assistantTurn('looking', [tc.read('src/a.ts')]),
      userTurn('ok', { gapSec: 120 }),
      assistantTurn('more', [tc.read('src/b.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    // A dragged-in screenshot is not a request, so it is skipped entirely.
    expect(buildBrief(analyze(session)).openingPrompt ?? '').not.toContain('NSIRD');
  });
});

describe('buildBrief — what a debug phase is chasing', () => {
  it('names the failure being retried, with the file and the count', () => {
    const analyzed = analyze(debugHeavySession());
    const debugSection = buildBrief(analyzed).sections.find(
      (section) => analyzed.phases[section.phaseIndex]?.kind === 'debug',
    );
    expect(debugSection?.chasing).toContain('TypeError');
    expect(debugSection?.chasing).toContain('webhook.ts');
    expect(debugSection?.chasing).toMatch(/×\d+$/);
  });

  it('is null for every phase that is not debugging', () => {
    const analyzed = analyze(cleanSession());
    for (const section of buildBrief(analyzed).sections) {
      if (analyzed.phases[section.phaseIndex]?.kind === 'debug') continue;
      expect(section.chasing).toBeNull();
    }
  });
});

describe('buildBrief — intent', () => {
  it('quotes the ask behind each section, in the developer\'s words', () => {
    const brief = buildBrief(analyze(debugHeavySession()));
    const first = brief.sections[0];
    expect(first?.intent).toEqual({ quote: 'the stripe webhook handler is broken', source: 'user' });
    // Every section says what it was for, not just which files it touched.
    expect(brief.sections.every((section) => section.intent !== null)).toBe(true);
  });

  it('prefers the plan\'s own objective sentence for a plan section', () => {
    const session = sessionWith([
      userTurn('fix the retry queue'),
      assistantTurn(
        'Goal: make retries survive a redeploy without dropping jobs.\n\n1. Persist the queue\n2. Drain on boot',
        [],
        { planMode: true },
      ),
      userTurn('go', { gapSec: 120 }),
      assistantTurn('doing it', [tc.edit('src/queue.ts', 'a', 'b')], { gapSec: 10 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const analyzed = analyze(session);
    const brief = buildBrief(analyzed);
    const planSection = brief.sections.find(
      (section) => analyzed.phases[section.phaseIndex]?.kind === 'plan',
    );
    expect(planSection?.intent?.source).toBe('plan');
    expect(planSection?.intent?.quote).toBe('Goal: make retries survive a redeploy without dropping jobs.');
  });

  it('never quotes a harness annotation as an ask', () => {
    const session = sessionWith([
      userTurn('[Image: original 2800x3000, displayed at 1867x2000. Multiply coordinates by 1.5]'),
      assistantTurn('looking', [tc.read('src/a.ts')]),
      userTurn('ok', { gapSec: 120 }),
      assistantTurn('more', [tc.read('src/b.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    for (const section of buildBrief(analyze(session)).sections) {
      expect(section.intent?.quote ?? '').not.toContain('[Image');
    }
  });

  it('describes an execute phase that worked through the shell', () => {
    const session = sessionWith([
      userTurn('regenerate the fixtures'),
      assistantTurn('running the generator', [
        tc.bash('python3 scripts/gen.py --all', { result: 'wrote 12 fixtures' }),
        tc.bash('python3 scripts/check.py', { result: 'ok' }),
      ]),
      userTurn('now the second set', { gapSec: 120 }),
      assistantTurn('again', [tc.bash('python3 scripts/gen.py --set 2', { result: 'wrote 4' })], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
      assistantTurn('done', [], { gapSec: 10 }),
    ]);
    const analyzed = analyze(session);
    const section = buildBrief(analyzed).sections[0];
    expect(analyzed.phases[0]?.kind).toBe('execute');
    // Not "0 edits · 0 files": plenty of real work never touches the Edit tool.
    expect(section?.statLine).toMatch(/^\d+ commands run$/);
  });

  it('never quotes tool noise as an ask', () => {
    const session = sessionWith([
      userTurn('<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
      assistantTurn('ok', [tc.read('src/a.ts')]),
      userTurn('ok', { gapSec: 120 }),
      assistantTurn('more', [tc.read('src/b.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    for (const section of buildBrief(analyze(session)).sections) {
      expect(section.intent?.quote ?? '').not.toContain('task-notification');
    }
  });
});

describe('buildBrief — section heads', () => {
  it('produces one head per phase, chronological, with the required fields and no prose', () => {
    const analyzed = analyze(debugHeavySession());
    const brief = buildBrief(analyzed);

    expect(brief.sections).toHaveLength(analyzed.phases.length);
    brief.sections.forEach((section, i) => {
      expect(section.phaseIndex).toBe(i);
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.timeRange).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/);
      expect(section.statLine.length).toBeGreaterThan(0);
      // A badge is a finding, not a decoration: it may legitimately be empty.
      expect(typeof section.badge.text).toBe('string');
      expect(['red', 'green', 'blue', 'gray']).toContain(section.badge.tone);
      expect(section).not.toHaveProperty('story');
    });
  });

  it('numbers repeated phase kinds', () => {
    const session = sessionWith([
      userTurn('build A'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y'), tc.bash('pnpm test', { result: 'ok' })]),
      userTurn('now build B', { gapSec: 4000 }),
      assistantTurn('reading around first', [
        tc.read('src/b.ts'),
        tc.read('src/c.ts'),
        tc.read('src/d.ts'),
        tc.read('src/e.ts'),
      ], { gapSec: 100 }),
      userTurn('ok go', { gapSec: 100 }),
      assistantTurn('editing B', [tc.edit('src/b.ts', 'x', 'y'), tc.bash('pnpm test', { result: 'ok' })]),
    ]);
    const analyzed = analyze(session);
    const executeCount = analyzed.phases.filter((phase) => phase.kind === 'execute').length;
    const brief = buildBrief(analyzed);
    if (executeCount > 1) {
      const titles = brief.sections.map((section) => section.title);
      expect(titles).toContain('Execute (1)');
      expect(titles).toContain('Execute (2)');
    }
  });

  it('debug badge shows the stall duration in red', () => {
    const analyzed = analyze(debugHeavySession());
    const debugSection = buildBrief(analyzed).sections.find(
      (section) => analyzed.phases[section.phaseIndex]?.kind === 'debug',
    );
    expect(debugSection?.badge.tone).toBe('red');
    expect(debugSection?.badge.text).toMatch(/stuck/);
  });

  it('debug stat line counts loops, the stuck run and the breakthrough', () => {
    const analyzed = analyze(debugHeavySession());
    const debugSection = buildBrief(analyzed).sections.find(
      (section) => analyzed.phases[section.phaseIndex]?.kind === 'debug',
    );
    expect(debugSection?.statLine).toMatch(/loops/);
    expect(debugSection?.statLine).toMatch(/stuck/);
    expect(debugSection?.statLine).toMatch(/breakthrough/);
  });
});

describe('buildBrief — takeaways', () => {
  it('emits the guessing-before-reading warning with traceable numbers', () => {
    const analyzed = analyze(debugHeavySession());
    const brief = buildBrief(analyzed);
    const warning = brief.takeaways.find((takeaway) => takeaway.kind === 'warning');

    expect(warning).toBeDefined();
    expect(text(warning?.lead ?? [])).toMatch(/guessing instead of reading/);
    expect(withStyle(warning?.lead ?? [], 'bad').some((t) => /minute/.test(t))).toBe(true);
    expect(text(warning?.body ?? [])).toContain('3');
    expect(withStyle(warning?.body ?? [], 'file')).toContain('src/lib/stripe.ts');
    const debugIndex = analyzed.phases.findIndex((phase) => phase.kind === 'debug');
    expect(warning?.evidenceSection).toBe(debugIndex);
  });

  it('does not emit the guessing warning without a breakthrough read', () => {
    const session = sessionWith([
      userTurn('fix it'),
      assistantTurn('a1', [tc.edit('src/a.ts', 'x1', 'y1'), tc.bash('pnpm test', { error: TYPE_ERROR })]),
      assistantTurn('a2', [tc.edit('src/a.ts', 'x2', 'y2'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 120 }),
      assistantTurn('a3', [tc.edit('src/a.ts', 'x3', 'y3'), tc.bash('pnpm test', { error: TYPE_ERROR })], { gapSec: 120 }),
      userTurn('hm'),
      assistantTurn('sorry', []),
    ]);
    const brief = buildBrief(analyze(session));
    expect(brief.takeaways.some((takeaway) => text(takeaway.lead).includes('guessing'))).toBe(false);
  });

  it('emits a CLAUDE.md candidate with a snippet naming the actual file', () => {
    const analyzed = analyze(debugHeavySession()); // stripe.ts read 3×
    const brief = buildBrief(analyzed);
    const tip = brief.takeaways.find((takeaway) => takeaway.kind === 'tip');

    expect(tip).toBeDefined();
    expect(withStyle(tip?.lead ?? [], 'file')).toContain('src/lib/stripe.ts');
    expect(tip?.snippet).toBeDefined();
    expect(tip?.snippet).toContain('src/lib/stripe.ts');
    // The file was a breakthrough read, so the fact form names the error.
    expect(tip?.snippet).toContain('TypeError');
  });

  it('counts cross-session reads when provided', () => {
    const analyzed = analyze(debugHeavySession());
    const brief = buildBrief(analyzed, { crossSessionReads: { 'src/lib/stripe.ts': 5 } });
    const tip = brief.takeaways.find((takeaway) => takeaway.kind === 'tip');
    expect(text(tip?.body ?? [])).toContain('5×');
    expect(text(tip?.body ?? [])).toContain('other sessions');
  });

  it('emits the reprompt-ROI win when the plan connects to the debug escape', () => {
    const brief = buildBrief(analyze(plannedDebugSession(true)));
    const win = brief.takeaways.find((takeaway) => text(takeaway.lead).includes('pushback paid off'));
    expect(win).toBeDefined();
    expect(win?.kind).toBe('win');
    expect(withStyle(win?.body ?? [], 'file')).toContain('src/lib/stripe.ts');
  });

  it('does not emit reprompt-ROI without the connection', () => {
    const brief = buildBrief(analyze(plannedDebugSession(false)));
    expect(brief.takeaways.some((takeaway) => text(takeaway.lead).includes('pushback paid off'))).toBe(false);
  });

  it('credits a clean session', () => {
    const brief = buildBrief(analyze(cleanSession()));
    const win = brief.takeaways.find((takeaway) => takeaway.kind === 'win');
    expect(win).toBeDefined();
    expect(text(win?.lead ?? []).toLowerCase()).toContain('clean');
  });

  it('never returns zero takeaways for a non-thin session', () => {
    const session = sessionWith([
      userTurn('poke around'),
      assistantTurn('reading', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts')]),
      userTurn('more'),
      assistantTurn('reading', [tc.read('src/d.ts')]),
      userTurn('ok'),
      assistantTurn('done', []),
    ]);
    const brief = buildBrief(analyze(session));
    expect(brief.thin).toBe(false);
    expect(brief.takeaways.length).toBeGreaterThanOrEqual(1);
    expect(brief.takeaways.length).toBeLessThanOrEqual(4);
  });

  it('caps takeaways at 4', () => {
    for (const session of [debugHeavySession(), plannedDebugSession(true), cleanSession()]) {
      expect(buildBrief(analyze(session)).takeaways.length).toBeLessThanOrEqual(4);
    }
  });
});

describe('buildBrief — invariants', () => {
  const fixtures: Array<[string, Session]> = [
    ['debug-heavy', debugHeavySession()],
    ['clean', cleanSession()],
    ['planned debug', plannedDebugSession(true)],
    ['no backtrack', debugWithoutBacktrackSession()],
  ];

  it.each(fixtures)('%s: spans are non-empty, styles are the 4-style set', (_name, session) => {
    const brief = buildBrief(analyze(session));
    const allRich: RichText[] = [
      brief.headline ?? [],
      ...brief.takeaways.flatMap((takeaway) => [takeaway.lead, takeaway.body]),
    ];
    for (const rich of allRich) {
      for (const span of rich) {
        expect(span.text.length).toBeGreaterThan(0);
        if (span.style !== undefined) expect(['file', 'bad', 'good', 'hl']).toContain(span.style);
      }
    }
  });

  it.each(fixtures)('%s: output is deterministic and JSON-safe', (_name, session) => {
    const analyzed = analyze(session);
    const first = buildBrief(analyzed);
    const second = buildBrief(analyzed);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
