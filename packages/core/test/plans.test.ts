import { describe, expect, it } from 'vitest';

import { diffSteps, extractPlanRevisions, extractSteps } from '../src/plans.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

describe('extractPlanRevisions', () => {
  it('returns [] when the session never enters plan mode', () => {
    const session = sessionWith([
      userTurn('just do it'),
      assistantTurn('doing it', [tc.edit('src/a.ts', 'x', 'y')]),
    ]);
    expect(extractPlanRevisions(session)).toEqual([]);
  });

  it('records the first plan as initial with no diff', () => {
    const session = sessionWith([
      userTurn('plan the refactor'),
      assistantTurn('## Plan\n\nStep one: parse the file.', [], { planMode: true }),
    ]);
    const revisions = extractPlanRevisions(session);
    expect(revisions).toHaveLength(1);
    const first = revisions[0];
    expect(first?.turnIndex).toBe(1);
    expect(first?.changeKind).toBe('initial');
    expect(first?.diffFromPrevious).toBeNull();
    expect(first?.triggerUserText).toBe('plan the refactor');
    expect(first?.planText).toContain('Step one');
  });

  it('classifies appended paragraphs as added', () => {
    const session = sessionWith([
      userTurn('plan the refactor'),
      assistantTurn('## Plan\n\nStep one: parse the file.', [], { planMode: true }),
      userTurn('also handle errors'),
      assistantTurn('## Plan\n\nStep one: parse the file.\n\nStep two: handle errors.', [], { planMode: true }),
    ]);
    const revisions = extractPlanRevisions(session);
    expect(revisions).toHaveLength(2);
    const second = revisions[1];
    expect(second?.changeKind).toBe('added');
    expect(second?.triggerUserText).toBe('also handle errors');
    expect(second?.diffFromPrevious).toContain('Step two');
    expect(second?.diffFromPrevious).toContain('@@');
  });

  it('classifies changed paragraphs as revised', () => {
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn('Step one: parse the file synchronously.', [], { planMode: true }),
      userTurn('stream it instead'),
      assistantTurn('First: stream the file lazily.', [], { planMode: true }),
    ]);
    expect(extractPlanRevisions(session)[1]?.changeKind).toBe('revised');
  });

  it('classifies a paragraph that grew >40% as expanded', () => {
    const original = 'Step two: handle errors.';
    const grown =
      'Step two: handle errors, including malformed JSONL lines, orphaned tool calls, and schema drift between versions.';
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn(`Intro paragraph.\n\n${original}`, [], { planMode: true }),
      userTurn('add much more detail to step two'),
      assistantTurn(`Intro paragraph.\n\n${grown}`, [], { planMode: true }),
    ]);
    expect(extractPlanRevisions(session)[1]?.changeKind).toBe('expanded');
  });

  it('treats the plan input of an ExitPlanMode call as plan text', () => {
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn('here is the plan', [tc.exitPlanMode('My plan body.')]),
    ]);
    const revisions = extractPlanRevisions(session);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.planText).toBe('My plan body.');
    expect(revisions[0]?.changeKind).toBe('initial');
  });

  it('skips consecutive identical plan texts', () => {
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn('The plan.', [], { planMode: true }),
      assistantTurn('The plan.', [], { planMode: true }),
    ]);
    expect(extractPlanRevisions(session)).toHaveLength(1);
  });

  it('falls back to an empty trigger when no user turn precedes the plan', () => {
    const session = sessionWith([assistantTurn('The plan.', [], { planMode: true })]);
    expect(extractPlanRevisions(session)[0]?.triggerUserText).toBe('');
  });
});

describe('plan steps', () => {
  it('extracts numbered steps in order, ignoring surrounding prose', () => {
    expect(
      extractSteps('Here is the plan:\n\n1. Verify signature\n2. Parse event\n3. Dispatch handler\n\nSound good?'),
    ).toEqual(['Verify signature', 'Parse event', 'Dispatch handler']);
  });

  it('falls back to bullets, then headings, then paragraph topic sentences', () => {
    expect(extractSteps('- Verify signature\n- Parse event')).toEqual(['Verify signature', 'Parse event']);
    expect(extractSteps('## Plan\n### Verify signature\n### Parse event')).toEqual([
      'Verify signature',
      'Parse event',
    ]);
    expect(extractSteps('First we verify. Then more words.\n\nThen we parse. And more.')).toEqual([
      'First we verify.',
      'Then we parse.',
    ]);
  });

  it('strips inline markdown and clips long steps', () => {
    const [step] = extractSteps(`1. **Verify** the \`signature\` ${'x'.repeat(100)}\n2. Parse`);
    expect(step?.startsWith('Verify the signature')).toBe(true);
    expect(step?.length).toBeLessThanOrEqual(70);
  });

  it('keeps a step\'s label and drops the expression that implements it', () => {
    const steps = extractSteps(
      '1. Authors: cmsPrisma.author.findMany({ where: { deletedAt: null } })\n' +
        '2. Candidate articles: cmsPrisma.article.findMany({ where: { authorId: null } })\n' +
        '3. Dry run first, then write',
    );
    expect(steps).toEqual(['Authors', 'Candidate articles', 'Dry run first, then write']);
  });

  it('marks kept, added and removed steps against the previous revision', () => {
    const before = ['Verify signature', 'Parse event', 'Dispatch handler'];
    const after = ['Verify signature', 'Detect API version', 'Dispatch handler'];
    expect(diffSteps(before, after)).toEqual([
      { text: 'Verify signature', change: 'kept' },
      { text: 'Detect API version', change: 'added' },
      { text: 'Parse event', change: 'removed' },
      { text: 'Dispatch handler', change: 'kept' },
    ]);
  });

  it('treats the first revision as all kept, and matches ignoring case and punctuation', () => {
    expect(diffSteps([], ['Verify signature'])).toEqual([{ text: 'Verify signature', change: 'kept' }]);
    expect(diffSteps(['Verify signature.'], ['verify signature'])).toEqual([
      { text: 'verify signature', change: 'kept' },
    ]);
  });

  it('leaves the objective sentence out of the steps — the section head shows it', () => {
    const session = sessionWith([
      userTurn('plan the backfill'),
      assistantTurn(
        'The goal is clear: a backfill script that tags author articles.',
        [],
        { planMode: true },
      ),
      userTurn('also cover the retry queue'),
      assistantTurn(
        'The goal is clear: a backfill script that tags author articles.\n\n1. Query authors\n2. Query articles',
        [],
        { planMode: true },
      ),
    ]);
    const revisions = extractPlanRevisions(session);
    expect(revisions[0]?.steps).toEqual([]); // nothing but the goal
    // The reprompt's steps are new, not "kept", and the goal is not "removed".
    expect(revisions[1]?.steps).toEqual([
      { text: 'Query authors', change: 'added' },
      { text: 'Query articles', change: 'added' },
    ]);
  });

  it('never emits modified — v2 shows a rewritten step as removed plus added', () => {
    const steps = diffSteps(['Verify Stripe signature'], ['Validate webhook signature']);
    expect(steps.map((step) => step.change).sort()).toEqual(['added', 'removed']);
  });

  it('attaches steps to every revision it extracts', () => {
    const session = sessionWith([
      userTurn('plan it'),
      assistantTurn('## Plan\n\n1. Verify signature\n2. Parse event', [], { planMode: true }),
      userTurn('also detect the api version'),
      assistantTurn('## Plan\n\n1. Verify signature\n2. Detect API version\n3. Parse event', [], { planMode: true }),
    ]);
    const revisions = extractPlanRevisions(session);
    expect(revisions[0]?.steps.every((step) => step.change === 'kept')).toBe(true);
    expect(revisions[1]?.steps.find((step) => step.text === 'Detect API version')?.change).toBe('added');
  });
});
