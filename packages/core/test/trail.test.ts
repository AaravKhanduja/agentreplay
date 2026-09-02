import { describe, expect, it } from 'vitest';

import { buildExploreTrail, searchPattern } from '../src/trail.js';
import type { AnalyzedSession, Session } from '../src/types.js';
import { analyzeParsedSession } from '../src/index.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const analyze = (session: Session): AnalyzedSession => analyzeParsedSession(session);

describe('searchPattern', () => {
  it('takes what the search was hunting for, never a path or a flag', () => {
    expect(searchPattern('rg -n "authorId" "/project/src" -l')).toBe('authorId');
    expect(searchPattern("rg -n 'handleEdit' src/components")).toBe('handleEdit');
    expect(searchPattern('grep -r authorId .')).toBe('authorId');
    expect(searchPattern('rg --type ts -g "!*.test.*" "ArticleForm" src')).toBe('ArticleForm');
  });

  it('is null when there is nothing being searched for', () => {
    expect(searchPattern("sed -n '1,80p' src/app.ts")).toBeNull();
    expect(searchPattern('cat package.json')).toBeNull();
  });
});

describe('buildExploreTrail', () => {
  const session = sessionWith([
    userTurn('why is the author tag missing'),
    assistantTurn('looking', [
      tc.bash('rg -n "authorId|author" "/project/src" -l', {
        result: '/project/src/forms/ArticleForm.tsx\n/project/src/services/content.ts',
      }),
      tc.bash('rg -n "handleEdit|setEditing|ArticlePreview|editing" "/project/src/Section.tsx"', {
        result: '109:  handleEdit: (article) => void;\n120:  handleEdit,',
      }),
      tc.bash("sed -n '1,80p' \"/project/src/lib/stripe.ts\"", { result: 'export function verify…' }),
    ]),
    userTurn('fix it', { gapSec: 200 }),
    assistantTurn('a1', [tc.edit('src/Section.tsx', 'a', 'b'), tc.bash('pnpm test', { error: 'Error: bad' })]),
    assistantTurn('a2', [tc.edit('src/Section.tsx', 'b', 'c'), tc.bash('pnpm test', { error: 'Error: bad' })], { gapSec: 60 }),
    assistantTurn('a3', [tc.edit('src/Section.tsx', 'c', 'd'), tc.bash('pnpm test', { error: 'Error: bad' })], { gapSec: 60 }),
    assistantTurn('reading', [tc.read('src/lib/stripe.ts')], { gapSec: 60 }),
    assistantTurn('fix', [tc.edit('src/Section.tsx', 'd', 'e'), tc.bash('pnpm test', { result: 'ok' })], { gapSec: 60 }),
  ]);
  const analyzed = analyze(session);
  const explore = analyzed.phases.find((phase) => phase.kind === 'explore');
  const trail = explore === undefined ? [] : buildExploreTrail(session, explore, analyzed);

  it('leads with what was looked for, not the command that did the looking', () => {
    expect(trail.map((step) => step.subject)).toEqual([
      'authorId, author',
      'handleEdit, setEditing +2',
      'src/lib/stripe.ts',
    ]);
    expect(trail.map((step) => step.kind)).toEqual(['search', 'search', 'read']);
  });

  it('records where a search landed', () => {
    expect(trail[0]?.found).toEqual(['src/forms/ArticleForm.tsx', 'src/services/content.ts']);
    expect(trail[1]?.matches).toBe(2);
  });

  it('asks each question once, counting the repeats', () => {
    const repeated = analyze(
      sessionWith([
        userTurn('find the modal'),
        assistantTurn('looking', [
          tc.bash('rg -ln "EditArticleModal" "/project/src"', { result: '/project/src/modals/index.ts' }),
          tc.bash('rg -n "handleEdit" "/project/src"', { result: '109: handleEdit,' }),
          tc.bash('rg -n "EditArticleModal" "/project/src" -g "*.tsx"', { result: '/project/src/modals/Edit.tsx' }),
        ]),
        userTurn('thanks', { gapSec: 120 }),
      ]),
    );
    const phase = repeated.phases[0];
    const steps = phase === undefined ? [] : buildExploreTrail(repeated.session, phase, repeated);

    expect(steps.map((step) => step.subject)).toEqual(['EditArticleModal', 'handleEdit']);
    const modal = steps[0];
    expect(modal?.repeats).toBe(2);
    // Both answers survive the merge.
    expect(modal?.found).toEqual(['src/modals/index.ts', 'src/modals/Edit.tsx']);
  });

  it('marks the file that later broke the stall', () => {
    expect(analyzed.debugSequences[0]?.breakthroughCause).toBe('read src/lib/stripe.ts');
    expect(trail.filter((step) => step.laterCritical).map((step) => step.subject)).toEqual(['src/lib/stripe.ts']);
  });

  it('carries the turn index so the viewer can show the original turn', () => {
    for (const step of trail) {
      expect(analyzed.session.turns[step.turnIndex]?.role).toBe('assistant');
    }
  });

  it('degrades to an empty trail when nothing was looked at', () => {
    const quiet = analyze(
      sessionWith([
        userTurn('just chat'),
        assistantTurn('sure', []),
        userTurn('ok', { gapSec: 120 }),
      ]),
    );
    const phase = quiet.phases[0];
    expect(phase === undefined ? [] : buildExploreTrail(quiet.session, phase, quiet)).toEqual([]);
  });
});
