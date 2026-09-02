import { describe, expect, it } from 'vitest';

import { detectDebugLoops, errorSignature, groupDebugSequences } from '../src/loops.js';
import type { Phase } from '../src/types.js';
import { assistantTurn, iso, sessionWith, tc, userTurn } from './builders.js';

function phase(kind: Phase['kind'], startIndex: number, endIndex: number): Phase {
  return {
    kind,
    startIndex,
    endIndex,
    startedAt: iso(0),
    endedAt: iso(1000),
    toolMix: { read: 0, write: 0, bash: 0, meta: 0 },
    summary: null,
  };
}

describe('errorSignature', () => {
  it('lowercases the first line and collapses whitespace', () => {
    expect(errorSignature('Error:   Something  Bad\nstack line')).toBe('error: something bad');
  });

  it('strips line/col numbers and hex addresses', () => {
    const a = errorSignature('TypeError: boom at src/app.ts:12:5');
    const b = errorSignature('TypeError: boom at src/app.ts:40:2');
    expect(a).toBe(b);
    expect(errorSignature('segfault at 0xDEADBEEF')).toBe(errorSignature('segfault at 0x1234'));
    expect(errorSignature('error on line 42')).toBe(errorSignature('error on line 7'));
  });
});

describe('detectDebugLoops', () => {
  it('detects a write → failing bash as a loop', () => {
    const session = sessionWith([
      userTurn('fix the failing test'),
      assistantTurn('editing', [
        tc.edit('src/app.ts', 'const x = 1', 'const x = 2'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3\n    at src/app.test.ts:12:5' }),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops).toHaveLength(1);
    const loop = loops[0];
    expect(loop?.index).toBe(0);
    expect(loop?.turnIndex).toBe(1);
    expect(loop?.result).toBe('new-error');
    expect(loop?.attempt.filePath).toBe('src/app.ts');
    expect(loop?.attempt.editCount).toBe(1);
    expect(loop?.error.signature).toBe('error: expected 2 to be 3');
  });

  it('marks repeated identical errors as same-error', () => {
    const session = sessionWith([
      userTurn('fix it'),
      assistantTurn('try 1', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3\n at x.ts:1:1' }),
      ]),
      assistantTurn('try 2', [
        tc.edit('src/app.ts', 'b', 'c'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3\n at x.ts:9:9' }),
      ]),
      assistantTurn('try 3', [
        tc.edit('src/app.ts', 'c', 'd'),
        tc.bash('pnpm test', { error: 'TypeError: parse is not a function' }),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops.map((l) => l.result)).toEqual(['new-error', 'same-error', 'new-error']);
  });

  it('detects a passed loop when a successful bash is followed by a rewrite within 5 calls', () => {
    const session = sessionWith([
      userTurn('tweak it'),
      assistantTurn('working', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { result: 'all green' }),
        tc.edit('src/app.ts', 'b', 'c'),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.result).toBe('passed');
    expect(loops[0]?.error.signature).toBe('');
  });

  it('finds no loop when bash succeeds and the file is not rewritten', () => {
    const session = sessionWith([
      userTurn('do it'),
      assistantTurn('done', [tc.edit('src/app.ts', 'a', 'b'), tc.bash('pnpm test', { result: 'ok' })]),
    ]);
    expect(detectDebugLoops(session)).toHaveLength(0);
  });

  it('ignores rewrites more than 5 tool calls after the bash', () => {
    const session = sessionWith([
      userTurn('do it'),
      assistantTurn('working', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { result: 'ok' }),
        tc.read('src/1.ts'),
        tc.read('src/2.ts'),
        tc.read('src/3.ts'),
        tc.read('src/4.ts'),
        tc.read('src/5.ts'),
        tc.edit('src/app.ts', 'b', 'c'), // 6th call after bash — outside the window
      ]),
    ]);
    expect(detectDebugLoops(session)).toHaveLength(0);
  });

  it('collects precedingReads between loops, most recent last', () => {
    const session = sessionWith([
      userTurn('fix it'),
      assistantTurn('try 1', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: nope' }),
      ]),
      assistantTurn('try 2', [
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
        tc.edit('src/app.ts', 'b', 'c'),
        tc.bash('pnpm test', { error: 'Error: nope' }),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops).toHaveLength(2);
    expect(loops[1]?.precedingReads).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('groupDebugSequences', () => {
  it('detects a stuck run and its breakthrough with cause', () => {
    const session = sessionWith([
      userTurn('tests are failing'),
      assistantTurn('try 1', [
        tc.edit('src/app.ts', 'a', 'b'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3\n at x.ts:1:1' }),
      ]),
      assistantTurn('try 2', [
        tc.edit('src/app.ts', 'b', 'c'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3\n at x.ts:9:9' }),
      ]),
      assistantTurn('try 3', [
        tc.edit('src/app.ts', 'c', 'd'),
        tc.bash('pnpm test', { error: 'Error: expected 2 to be 3' }),
      ]),
      assistantTurn('read then fix', [
        tc.read('src/lib/parse.ts'),
        tc.edit('src/app.ts', 'd', 'e'),
        tc.bash('pnpm test', { result: 'all passed' }),
        tc.edit('src/app.ts', 'e', 'e2'),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops.map((l) => l.result)).toEqual(['new-error', 'same-error', 'same-error', 'passed']);

    const sequences = groupDebugSequences(loops, [phase('debug', 0, 4)]);
    expect(sequences).toHaveLength(1);
    const seq = sequences[0];
    expect(seq?.phaseIndex).toBe(0);
    expect(seq?.stuckRuns).toEqual([
      {
        startLoop: 0,
        endLoop: 2,
        errorSignature: 'error: expected 2 to be 3',
        durationMs: expect.any(Number) as unknown as number,
      },
    ]);
    // "11 minutes stuck" runs from the first attempt to the one that ended it,
    // not to the last failing attempt — the waiting counts.
    const run = seq?.stuckRuns[0];
    const loops2 = seq?.loops ?? [];
    expect(run?.durationMs).toBe(
      Date.parse(loops2[3]?.startedAt ?? '') - Date.parse(loops2[0]?.startedAt ?? ''),
    );
    expect(seq?.breakthroughLoop).toBe(3);
    expect(seq?.breakthroughCause).toBe('read src/lib/parse.ts');
  });

  it('keeps the check command, the error line and the size of the gap for the chain', () => {
    const session = sessionWith([
      userTurn('fix'),
      assistantTurn('try 1', [
        tc.edit('src/a.ts', 'a', 'b'),
        tc.bash('pnpm test webhooks', { error: 'Error: signature mismatch\n  at verify()' }),
      ]),
      assistantTurn('look around', [
        tc.read('src/lib/stripe.ts'),
        tc.bash('git status', { result: 'clean' }),
        tc.bash('ls src', { result: 'a.ts' }),
      ]),
      assistantTurn('try 2', [
        tc.edit('src/a.ts', 'b', 'c'),
        tc.bash('pnpm test webhooks', { error: 'AssertionError: expected 200' }),
      ]),
    ]);
    const loops = detectDebugLoops(session);
    const first = loops[0];
    const second = loops[1];

    expect(first?.check).toEqual({ command: 'pnpm test webhooks', label: 'TEST', outcome: 'error' });
    expect(first?.errorLine).toBe('Error: signature mismatch');
    expect(first?.precedingOtherCalls).toBe(0);

    // The read is listed; the two unrelated bash calls are only counted.
    expect(second?.precedingReads).toEqual(['src/lib/stripe.ts']);
    expect(second?.precedingOtherCalls).toBe(2);
    expect(second?.errorLine).toBe('AssertionError: expected 200');
  });

  it('closes a cycle with the run that finally passes, and credits the read behind it', () => {
    const session = sessionWith([
      userTurn('fix the auth middleware'),
      assistantTurn('a1', [tc.edit('src/auth.ts', 'a', 'b'), tc.bash('pnpm test', { error: 'Error: bad token' })]),
      assistantTurn('a2', [tc.edit('src/auth.ts', 'b', 'c'), tc.bash('pnpm test', { error: 'Error: bad token' })], { gapSec: 120 }),
      assistantTurn('a3', [tc.edit('src/auth.ts', 'c', 'd'), tc.bash('pnpm test', { error: 'Error: bad token' })], { gapSec: 120 }),
      assistantTurn('reading', [tc.read('src/lib/jwt.ts')], { gapSec: 120 }),
      // The fix works first time — this must still be part of the cycle.
      assistantTurn('fix', [tc.edit('src/auth.ts', 'd', 'e'), tc.bash('pnpm test', { result: '31 passed' })], { gapSec: 60 }),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops.map((l) => l.result)).toEqual(['new-error', 'same-error', 'same-error', 'passed']);

    const sequences = groupDebugSequences(loops, [phase('debug', 0, 5)]);
    expect(sequences[0]?.breakthroughLoop).toBe(3);
    expect(sequences[0]?.breakthroughCause).toBe('read src/lib/jwt.ts');
  });

  it('does not turn ordinary edit-then-fix work into a passing loop', () => {
    const session = sessionWith([
      userTurn('add the endpoint'),
      assistantTurn('write it', [tc.edit('src/new.ts', 'a', 'b'), tc.bash('pnpm test', { result: 'ok' })]),
    ]);
    // Nothing was ever failing, so there is no cycle for a pass to close.
    expect(detectDebugLoops(session)).toEqual([]);
  });

  it('needs at least 3 consecutive same-signature loops for a stuck run', () => {
    const session = sessionWith([
      userTurn('fix'),
      assistantTurn('try 1', [tc.edit('src/a.ts', 'a', 'b'), tc.bash('t', { error: 'Error: x' })]),
      assistantTurn('try 2', [tc.edit('src/a.ts', 'b', 'c'), tc.bash('t', { error: 'Error: x' })]),
    ]);
    const loops = detectDebugLoops(session);
    const sequences = groupDebugSequences(loops, [phase('debug', 0, 2)]);
    expect(sequences[0]?.stuckRuns).toEqual([]);
    expect(sequences[0]?.breakthroughLoop).toBeNull();
    expect(sequences[0]?.breakthroughCause).toBeNull();
  });

  it('splits sequences when loops move to a different file', () => {
    const session = sessionWith([
      userTurn('fix'),
      assistantTurn('a 1', [tc.edit('src/a.ts', 'a', 'b'), tc.bash('t', { error: 'Error: x' })]),
      assistantTurn('a 2', [tc.edit('src/a.ts', 'b', 'c'), tc.bash('t', { error: 'Error: x' })]),
      assistantTurn('b 1', [tc.edit('src/b.ts', 'a', 'b'), tc.bash('t', { error: 'Error: y' })]),
    ]);
    const loops = detectDebugLoops(session);
    expect(loops).toHaveLength(3);
    const sequences = groupDebugSequences(loops, [phase('debug', 0, 3)]);
    expect(sequences).toHaveLength(2);
    expect(sequences[0]?.loops).toHaveLength(2);
    expect(sequences[1]?.loops).toHaveLength(1);
  });

  it('maps each sequence to the phase containing its first loop', () => {
    const session = sessionWith([
      userTurn('explore'),
      assistantTurn('reading', [tc.read('src/a.ts')]),
      userTurn('now fix'),
      assistantTurn('fixing', [tc.edit('src/a.ts', 'a', 'b'), tc.bash('t', { error: 'Error: x' })]),
    ]);
    const loops = detectDebugLoops(session);
    const sequences = groupDebugSequences(loops, [phase('explore', 0, 1), phase('debug', 2, 3)]);
    expect(sequences[0]?.phaseIndex).toBe(1);
  });
});
