import { describe, expect, it } from 'vitest';

import { checkCategory, checkLabel } from '../src/checks.js';
import { segmentPhases } from '../src/phases.js';
import { buildVerifyResult } from '../src/verify.js';
import type { AnalyzedSession, Session } from '../src/types.js';
import { analyzeParsedSession } from '../src/index.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const analyze = (session: Session): AnalyzedSession => analyzeParsedSession(session);

describe('checkCategory', () => {
  it('recognizes the four kinds of check and nothing else', () => {
    expect(checkCategory('pnpm test webhooks')).toBe('test');
    expect(checkCategory('pnpm typecheck')).toBe('typecheck');
    expect(checkCategory('npx eslint .')).toBe('lint');
    expect(checkCategory('cargo build --release')).toBe('build');
    expect(checkCategory('git status')).toBeNull();
    expect(checkCategory('ls src')).toBeNull();
  });

  it('labels checks for the debug chain, keeping the command word otherwise', () => {
    expect(checkLabel('pnpm test webhooks')).toBe('TEST');
    expect(checkLabel('pnpm typecheck')).toBe('TYPES');
    expect(checkLabel('./scripts/smoke.sh')).toBe('SMOKE.SH');
  });
});

describe('verify phase segmentation', () => {
  it('classifies a closing multi-check sweep as verify', () => {
    const session = sessionWith([
      userTurn('ship it'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y'), tc.edit('src/b.ts', 'x', 'y')]),
      userTurn('now check everything', { gapSec: 120 }),
      assistantTurn('checking', [
        tc.bash('pnpm test', { result: '42 passed' }),
        tc.bash('pnpm typecheck', { result: '' }),
        tc.bash('pnpm lint', { result: '' }),
      ], { gapSec: 120 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const kinds = analyze(session).phases.map((phase) => phase.kind);
    expect(kinds).toContain('verify');
  });

  it('does NOT split an edit-then-test rhythm into alternating verify phases', () => {
    const session = sessionWith([
      userTurn('build the thing'),
      assistantTurn('a', [tc.edit('src/a.ts', 'x', 'y')]),
      assistantTurn('check', [tc.bash('pnpm test', { result: 'ok' })], { gapSec: 120 }),
      assistantTurn('b', [tc.edit('src/b.ts', 'x', 'y')], { gapSec: 120 }),
      assistantTurn('check', [tc.bash('pnpm test', { result: 'ok' })], { gapSec: 120 }),
      assistantTurn('c', [tc.edit('src/c.ts', 'x', 'y')], { gapSec: 120 }),
      assistantTurn('check', [tc.bash('pnpm test', { result: 'ok' })], { gapSec: 120 }),
    ]);
    expect(analyze(session).phases.every((phase) => phase.kind !== 'verify')).toBe(true);
  });

  it('does not call a run of non-check commands a verification', () => {
    const session = sessionWith([
      userTurn('what changed'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y')]),
      userTurn('show me', { gapSec: 120 }),
      assistantTurn('looking', [
        tc.bash('git status', { result: 'clean' }),
        tc.bash('git diff --stat', { result: '1 file' }),
        tc.bash('git log --oneline -5', { result: 'abc' }),
      ], { gapSec: 120 }),
      userTurn('ok', { gapSec: 120 }),
    ]);
    expect(analyze(session).phases.every((phase) => phase.kind !== 'verify')).toBe(true);
  });
});

describe('buildVerifyResult', () => {
  const session = sessionWith([
    userTurn('ship it'),
    assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y')]),
    userTurn('check everything', { gapSec: 120 }),
    assistantTurn('checking', [
      tc.bash('pnpm test', { error: '1 failing' }),
      tc.bash('pnpm test', { result: '42 passed\nDuration 1.2s' }),
      tc.bash('pnpm typecheck', { result: 'tsc --noEmit' }),
    ], { gapSec: 120 }),
    userTurn('thanks', { gapSec: 120 }),
  ]);
  const analyzed = analyze(session);
  const phase = analyzed.phases.find((p) => p.kind === 'verify');

  it('labels checks and keeps only the last run of each', () => {
    const result = buildVerifyResult(analyzed, phase ?? analyzed.phases[0]!);
    expect(result.checks.map((check) => check.label)).toEqual(['Tests', 'Typecheck']);
    expect(result.checks[0]?.outcome).toBe('success');
    expect(result.checks[0]?.note).toBe('42 passed');
    // An echoed command is not a result — a bare ✓ says more than "tsc --noEmit".
    expect(result.checks[1]?.note).toBeNull();
  });

  it('reports the change totals and a completed outcome', () => {
    const result = buildVerifyResult(analyzed, phase ?? analyzed.phases[0]!);
    expect(result.filesChanged).toBe(1);
    expect(result.added).toBeGreaterThan(0);
    expect(result.outcome).toBe('completed');
  });

  it('is failing when any check ended red', () => {
    const red = sessionWith([
      userTurn('ship it'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y')]),
      userTurn('check', { gapSec: 120 }),
      assistantTurn('checking', [
        tc.bash('pnpm test', { result: 'ok' }),
        tc.bash('pnpm typecheck', { error: 'TS2345' }),
      ], { gapSec: 120 }),
      userTurn('hm', { gapSec: 120 }),
    ]);
    const redAnalyzed = analyze(red);
    const redPhase = redAnalyzed.phases[redAnalyzed.phases.length - 1]!;
    expect(buildVerifyResult(redAnalyzed, redPhase).outcome).toBe('failing');
  });
});
