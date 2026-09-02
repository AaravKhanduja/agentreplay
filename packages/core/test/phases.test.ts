import { describe, expect, it } from 'vitest';

import { detectDebugLoops } from '../src/loops.js';
import { segmentPhases } from '../src/phases.js';
import type { DebugLoop } from '../src/types.js';
import { assistantTurn, iso, sessionWith, tc, userTurn } from './builders.js';

function loopAt(turnIndex: number, index = 0): DebugLoop {
  return {
    index,
    turnIndex,
    startedAt: iso(0),
    error: { text: 'boom', signature: 'boom' },
    attempt: { filePath: 'src/a.ts', diffSummary: 'a.ts · 1 edit', editCount: 1 },
    precedingReads: [],
    result: 'new-error',
  };
}

describe('segmentPhases', () => {
  it('returns [] for an empty session', () => {
    expect(segmentPhases(sessionWith([]), [])).toEqual([]);
  });

  it('classifies a read-heavy segment as explore', () => {
    const session = sessionWith([
      userTurn('how does the parser work?'),
      assistantTurn('looking', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts'), tc.todo()]),
    ]);
    const phases = segmentPhases(session, []);
    expect(phases).toHaveLength(1);
    const phase = phases[0];
    expect(phase?.kind).toBe('explore');
    expect(phase?.startIndex).toBe(0);
    expect(phase?.endIndex).toBe(1);
    expect(phase?.toolMix).toEqual({ read: 3, write: 0, bash: 0, meta: 1 });
    expect(phase?.activeMs).toBeGreaterThan(0);
  });

  it('classifies a write-heavy segment as execute', () => {
    const session = sessionWith([
      userTurn('add the endpoint'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y'), tc.edit('src/b.ts', 'x', 'y'), tc.bash('pnpm build')]),
    ]);
    expect(segmentPhases(session, [])[0]?.kind).toBe('execute');
  });

  it('does not classify explore when writes reach 20%', () => {
    // 3 reads, 1 write, 1 bash → read 60% but write 20% (not < 20%)
    const session = sessionWith([
      userTurn('look around then tweak'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
        tc.read('src/c.ts'),
        tc.edit('src/a.ts', 'x', 'y'),
        tc.bash('pnpm test'),
      ]),
    ]);
    expect(segmentPhases(session, [])[0]?.kind).toBe('execute');
  });

  it('plan-mode turns win over tool mix', () => {
    const session = sessionWith([
      userTurn('plan this out'),
      assistantTurn('## Plan', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts')], { planMode: true }),
    ]);
    expect(segmentPhases(session, [])[0]?.kind).toBe('plan');
  });

  it('an ExitPlanMode tool call marks the segment as plan', () => {
    const session = sessionWith([
      userTurn('plan this out'),
      assistantTurn('done planning', [tc.exitPlanMode('the plan')]),
    ]);
    expect(segmentPhases(session, [])[0]?.kind).toBe('plan');
  });

  it('classifies debug when >=2 loops fall inside the segment', () => {
    const session = sessionWith([
      userTurn('tests are red'),
      assistantTurn('fixing', [tc.edit('src/a.ts', 'a', 'b'), tc.bash('pnpm test', { error: 'FAIL x' })]),
    ]);
    expect(segmentPhases(session, [loopAt(1, 0), loopAt(1, 1)])[0]?.kind).toBe('debug');
    // one loop is not enough
    expect(segmentPhases(session, [loopAt(1, 0)])[0]?.kind).toBe('execute');
  });

  it('works end to end with detectDebugLoops', () => {
    const session = sessionWith([
      userTurn('tests are red'),
      assistantTurn('try 1', [tc.edit('src/a.ts', 'a', 'b'), tc.bash('pnpm test', { error: 'Error: nope' })]),
      assistantTurn('try 2', [tc.edit('src/a.ts', 'b', 'c'), tc.bash('pnpm test', { error: 'Error: nope' })]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops.length).toBeGreaterThanOrEqual(2);
    expect(segmentPhases(session, loops)[0]?.kind).toBe('debug');
  });

  it('merges adjacent segments of the same kind', () => {
    const session = sessionWith([
      userTurn('what does a do?'),
      assistantTurn('reading', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts')]),
      userTurn('and what about d?'),
      assistantTurn('reading', [tc.read('src/d.ts'), tc.read('src/e.ts'), tc.read('src/f.ts')]),
    ]);
    const phases = segmentPhases(session, []);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe('explore');
    expect(phases[0]?.startIndex).toBe(0);
    expect(phases[0]?.endIndex).toBe(3);
    expect(phases[0]?.toolMix.read).toBe(6);
  });

  it('absorbs a too-short segment into its neighbor', () => {
    const session = sessionWith([
      userTurn('look at a'),
      assistantTurn('reading', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts')]),
      userTurn('hold on'), // 1-turn, <60s segment — merges into previous explore
      userTurn('now look at d'),
      assistantTurn('reading', [tc.read('src/d.ts'), tc.read('src/e.ts'), tc.read('src/f.ts')]),
    ]);
    const phases = segmentPhases(session, []);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe('explore');
    expect(phases[0]?.startIndex).toBe(0);
    expect(phases[0]?.endIndex).toBe(4);
  });

  it('keeps a lone short session as a single phase', () => {
    const session = sessionWith([userTurn('hi')]);
    const phases = segmentPhases(session, []);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe('execute');
  });

  it('uses the first turn timestamp as startedAt', () => {
    const session = sessionWith([
      userTurn('go', { atSec: 100 }),
      assistantTurn('ok', [tc.read('src/a.ts')]),
    ]);
    const phases = segmentPhases(session, []);
    expect(phases[0]?.startedAt).toBe(iso(100));
  });
});
