import { describe, expect, it } from 'vitest';

import { buildFileAccess, buildFileEdges } from '../src/files.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

describe('buildFileAccess', () => {
  it('counts reads and writes per file with timestamps', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [tc.read('src/a.ts'), tc.edit('src/a.ts', 'x', 'y'), tc.read('src/b.ts')]),
    ]);
    const files = buildFileAccess(session);
    const a = files.find((f) => f.path === 'src/a.ts');
    const b = files.find((f) => f.path === 'src/b.ts');
    expect(a?.reads).toBe(1);
    expect(a?.writes).toBe(1);
    expect(a?.timestamps).toHaveLength(2);
    expect(b?.reads).toBe(1);
    expect(b?.writes).toBe(0);
    expect(a?.isBacktracked).toBe(false);
  });

  it('ignores tool calls without a file path and non read/write categories', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [tc.grep('foo'), tc.bash('ls'), tc.todo(), tc.read('src/a.ts')]),
    ]);
    const files = buildFileAccess(session);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('src/a.ts');
  });

  it('marks a file backtracked when re-read after >=3 distinct other files', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
        tc.read('src/c.ts'),
        tc.read('src/d.ts'),
        tc.read('src/a.ts'),
      ]),
    ]);
    const a = buildFileAccess(session).find((f) => f.path === 'src/a.ts');
    expect(a?.isBacktracked).toBe(true);
  });

  it('does not mark backtracked with only 2 distinct files in between', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
        tc.read('src/c.ts'),
        tc.read('src/b.ts'), // repeat — still only 2 distinct others
        tc.read('src/a.ts'),
      ]),
    ]);
    const a = buildFileAccess(session).find((f) => f.path === 'src/a.ts');
    expect(a?.isBacktracked).toBe(false);
  });

  it('a write counts as the last access for backtrack tracking', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.edit('src/a.ts', 'x', 'y'),
        tc.read('src/b.ts'),
        tc.read('src/c.ts'),
        tc.read('src/d.ts'),
        tc.read('src/a.ts'),
      ]),
    ]);
    const a = buildFileAccess(session).find((f) => f.path === 'src/a.ts');
    expect(a?.isBacktracked).toBe(true);
  });
});

describe('buildFileEdges', () => {
  it('builds weighted edges from consecutive accesses', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
        tc.read('src/a.ts'),
        tc.read('src/b.ts'),
      ]),
    ]);
    const edges = buildFileEdges(session);
    expect(edges).toContainEqual({ from: 'src/a.ts', to: 'src/b.ts', weight: 2 });
    expect(edges).toContainEqual({ from: 'src/b.ts', to: 'src/a.ts', weight: 1 });
  });

  it('excludes self-edges', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [tc.read('src/a.ts'), tc.read('src/a.ts'), tc.read('src/b.ts')]),
    ]);
    const edges = buildFileEdges(session);
    expect(edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts', weight: 1 }]);
  });

  it('crosses turn boundaries', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('first', [tc.read('src/a.ts')]),
      userTurn('next'),
      assistantTurn('second', [tc.read('src/b.ts')]),
    ]);
    expect(buildFileEdges(session)).toEqual([{ from: 'src/a.ts', to: 'src/b.ts', weight: 1 }]);
  });
});
