import { describe, expect, it } from 'vitest';

import { buildEditHistories, diffSummary, extractDiff } from '../src/diffs.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

describe('extractDiff', () => {
  it('turns an Edit into del/add line pairs', () => {
    const { lines, editCount, truncated } = extractDiff(tc.edit('src/a.ts', 'old line', 'new line'));
    expect(lines).toEqual([
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' },
    ]);
    expect(editCount).toBe(1);
    expect(truncated).toBe(false);
  });

  it('handles MultiEdit edits arrays', () => {
    const call = tc.multiEdit('src/a.ts', [
      { old_string: 'one', new_string: 'ONE' },
      { old_string: 'two', new_string: 'TWO' },
    ]);
    const { lines, editCount } = extractDiff(call);
    expect(editCount).toBe(2);
    expect(lines).toEqual([
      { kind: 'del', text: 'one' },
      { kind: 'add', text: 'ONE' },
      { kind: 'del', text: 'two' },
      { kind: 'add', text: 'TWO' },
    ]);
  });

  it('treats Write as one add-only attempt', () => {
    const { lines, editCount } = extractDiff(tc.write('src/a.ts', 'line 1\nline 2'));
    expect(editCount).toBe(1);
    expect(lines).toEqual([
      { kind: 'add', text: 'line 1' },
      { kind: 'add', text: 'line 2' },
    ]);
  });

  it('caps the diff at 20 lines and flags truncation', () => {
    const content = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
    const { lines, truncated } = extractDiff(tc.write('src/a.ts', content));
    expect(lines).toHaveLength(20);
    expect(truncated).toBe(true);
  });

  it('does not flag truncation at exactly 20 lines', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const { lines, truncated } = extractDiff(tc.write('src/a.ts', content));
    expect(lines).toHaveLength(20);
    expect(truncated).toBe(false);
  });

  it('returns an empty diff for malformed input', () => {
    const call = { ...tc.edit('src/a.ts', 'x', 'y'), input: { nonsense: 42 } };
    expect(extractDiff(call)).toEqual({ lines: [], editCount: 0, truncated: false });
  });
});

describe('diffSummary', () => {
  it('reads like "<file> · N edits · -old +new"', () => {
    const call = tc.multiEdit('src/lib/webhook-handler.ts', [
      { old_string: 'const retries = 1', new_string: 'const retries = 3' },
      { old_string: 'foo', new_string: 'bar' },
    ]);
    const summary = diffSummary(call);
    expect(summary.startsWith('webhook-handler.ts · 2 edits')).toBe(true);
    expect(summary).toContain('-const retries = 1');
    expect(summary).toContain('+const retries = 3');
  });

  it('uses singular "edit" for one edit', () => {
    expect(diffSummary(tc.edit('src/a.ts', 'x', 'y'))).toBe('a.ts · 1 edit · -x +y');
  });
});

describe('buildEditHistories', () => {
  it('classifies a single successful attempt as clean', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y')]),
    ]);
    const histories = buildEditHistories(session);
    expect(histories).toHaveLength(1);
    expect(histories[0]?.path).toBe('src/a.ts');
    expect(histories[0]?.finalOutcome).toBe('clean');
    expect(histories[0]?.attempts[0]?.turnIndex).toBe(1);
    expect(histories[0]?.attempts[0]?.toolName).toBe('Edit');
  });

  it('classifies multiple attempts ending ok as retried', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('try 1', [tc.edit('src/a.ts', 'x', 'y')]),
      assistantTurn('try 2', [tc.edit('src/a.ts', 'y', 'z')]),
    ]);
    const history = buildEditHistories(session)[0];
    expect(history?.attempts).toHaveLength(2);
    expect(history?.finalOutcome).toBe('retried');
  });

  it('classifies a history whose last attempt errored as failed', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('try 1', [tc.edit('src/a.ts', 'x', 'y')]),
      assistantTurn('try 2', [tc.edit('src/a.ts', 'nope', 'z', { error: 'String to replace not found' })]),
    ]);
    expect(buildEditHistories(session)[0]?.finalOutcome).toBe('failed');
  });

  it('groups attempts per file and ignores reads', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.edit('src/a.ts', 'x', 'y'),
        tc.write('src/b.ts', 'hello'),
      ]),
    ]);
    const histories = buildEditHistories(session);
    expect(histories.map((h) => h.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(histories.every((h) => h.attempts.length === 1)).toBe(true);
  });
});
