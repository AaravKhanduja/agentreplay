import { describe, expect, it } from 'vitest';

import { shellKind, shellWrites } from '../src/checks.js';

const PROJECT = '/Users/dev/webshop';

describe('shellWrites — apply_patch', () => {
  it('reads a path and its diff out of the envelope', () => {
    const writes = shellWrites(
      [
        "apply_patch <<'EOF'",
        '*** Begin Patch',
        '*** Update File: src/author.ts',
        '@@ export function authorOf',
        '-  return article.author;',
        '+  return article.authorId;',
        '*** End Patch',
        'EOF',
      ].join('\n'),
      PROJECT,
    );
    expect(writes).toEqual([
      {
        path: 'src/author.ts',
        mode: 'patch',
        body: null,
        edits: [{ oldText: '  return article.author;', newText: '  return article.authorId;' }],
      },
    ]);
  });

  it('returns one write per file section', () => {
    const writes = shellWrites(
      [
        "apply_patch <<'EOF'",
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '-const a = 1;',
        '+const a = 2;',
        '*** Add File: src/b.ts',
        '+export const b = 3;',
        '*** End Patch',
        'EOF',
      ].join('\n'),
      PROJECT,
    );
    expect(writes.map((w) => w.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(writes[1]?.edits).toEqual([{ oldText: '', newText: 'export const b = 3;' }]);
  });

  it('skips a deletion — there is no content to show as a diff', () => {
    const writes = shellWrites(
      ["apply_patch <<'EOF'", '*** Begin Patch', '*** Delete File: src/gone.ts', '*** End Patch', 'EOF'].join('\n'),
      PROJECT,
    );
    expect(writes).toEqual([]);
  });
});

describe('shellWrites — heredocs and redirects', () => {
  it('takes the body of a cat heredoc as the new content', () => {
    const writes = shellWrites("cat > src/new.ts <<'EOF'\nexport const x = 1;\nEOF", PROJECT);
    expect(writes).toEqual([
      {
        path: 'src/new.ts',
        mode: 'create',
        body: 'export const x = 1;',
        edits: [{ oldText: '', newText: 'export const x = 1;' }],
      },
    ]);
  });

  it('distinguishes append from create', () => {
    expect(shellWrites("cat >> notes.md <<'EOF'\nmore\nEOF", PROJECT)[0]?.mode).toBe('append');
    expect(shellWrites('echo "hi" > notes.md', PROJECT)[0]?.mode).toBe('create');
  });

  it('reads a tee target, including its append flag', () => {
    expect(shellWrites("cat <<'EOF' | tee -a log.txt\nline\nEOF", PROJECT)).toEqual([
      { path: 'log.txt', mode: 'append', body: 'line', edits: [{ oldText: '', newText: 'line' }] },
    ]);
  });

  it('does not guess what an interpreter heredoc writes', () => {
    expect(shellWrites("python3 - <<'PY'\nopen('x.ts','w').write('hi')\nPY", PROJECT)).toEqual([]);
  });
});

describe('shellWrites — sed in place', () => {
  it('reads the substitution as an edit', () => {
    expect(shellWrites("sed -i '' 's/author/authorId/' src/author.ts", PROJECT)).toEqual([
      {
        path: 'src/author.ts',
        mode: 'inplace',
        body: null,
        edits: [{ oldText: 'author', newText: 'authorId' }],
      },
    ]);
  });

  it('leaves a read-only sed alone', () => {
    expect(shellWrites("sed -n '1,20p' src/author.ts", PROJECT)).toEqual([]);
  });
});

describe('shellWrites — what it refuses to call a write', () => {
  it('ignores stderr plumbing and /dev/null', () => {
    expect(shellWrites('pnpm test 2>&1', PROJECT)).toEqual([]);
    expect(shellWrites('rg -n "x" src > /dev/null', PROJECT)).toEqual([]);
  });

  it('ignores writes outside the project', () => {
    expect(shellWrites("cat > /tmp/scratch.txt <<'EOF'\nx\nEOF", PROJECT)).toEqual([]);
  });

  it('relativizes an absolute path inside the project', () => {
    const writes = shellWrites(`cat > ${PROJECT}/src/a.ts <<'EOF'\nx\nEOF`, PROJECT);
    expect(writes[0]?.path).toBe('src/a.ts');
  });

  it('emits nothing for moves and deletions — no diff body, and they inflate the count', () => {
    expect(shellWrites('rm -rf dist', PROJECT)).toEqual([]);
    expect(shellWrites('mv src/a.ts src/b.ts', PROJECT)).toEqual([]);
    expect(shellWrites('mkdir -p src/lib', PROJECT)).toEqual([]);
  });

  it('does not treat an ordinary command redirect as an edit', () => {
    expect(shellWrites('pnpm build > build.log', PROJECT)).toEqual([]);
  });
});

describe('shellKind', () => {
  it('calls a shell edit a write, and still reads the read-only forms', () => {
    expect(shellKind("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch\nEOF")).toBe('write');
    expect(shellKind("cat > a.ts <<'EOF'\nx\nEOF")).toBe('write');
    expect(shellKind("sed -i '' 's/a/b/' a.ts")).toBe('write');
    expect(shellKind("sed -n '1,5p' a.ts")).toBe('read');
    expect(shellKind('cat a.ts')).toBe('read');
  });

  it('still puts checks first — a test run is a check even when it redirects', () => {
    expect(shellKind('pnpm test')).toBe('check');
  });
});

describe('a shell edit reaches the heuristics', () => {
  const heredoc = "cat > src/author.ts <<'EOF'\nexport const authorId = 1;\nEOF";

  const session = (): string =>
    [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: '/project',
        message: { role: 'user', content: 'fix the author field' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-01T10:00:01.000Z',
        cwd: '/project',
        message: {
          id: 'm1',
          model: 'claude-fable-5',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: heredoc } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a1',
        timestamp: '2026-01-01T10:00:02.000Z',
        cwd: '/project',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      }),
    ].join('\n');

  it('becomes a write call with a path, behind the command it came from', async () => {
    const { parseSessionJsonl } = await import('../src/sources/claude/parser.js');
    const { session: parsed } = parseSessionJsonl(session(), { sessionId: 's' });
    const calls = parsed.turns.flatMap((t) => t.toolCalls);

    // The command first, then the edit it made: `loops.ts` scans forward from a
    // write for the next bash call to see whether the fix held, and the editing
    // command must not be the thing it finds.
    expect(calls.map((c) => c.category)).toEqual(['bash', 'write']);
    expect(calls[1]?.filePath).toBe('src/author.ts');
    expect(calls[1]?.synthetic).toBe(true);
    // The name stays the command that ran; only the meaning is normalized.
    expect(calls[1]?.name).toBe('cat');
    expect(calls[0]?.synthetic).toBeUndefined();
  });

  it('shows up as an edited file and an edit history', async () => {
    const { parseSessionJsonl } = await import('../src/sources/claude/parser.js');
    const { buildFileAccess } = await import('../src/files.js');
    const { buildEditHistories } = await import('../src/diffs.js');
    const { session: parsed } = parseSessionJsonl(session(), { sessionId: 's' });

    expect(buildFileAccess(parsed).map((f) => [f.path, f.writes])).toEqual([['src/author.ts', 1]]);
    const [history] = buildEditHistories(parsed);
    expect(history?.path).toBe('src/author.ts');
    expect(history?.attempts[0]?.diff).toEqual([{ kind: 'add', text: 'export const authorId = 1;' }]);
  });

  it('is left out of the header tool count — it is our reading, not a call', async () => {
    const { parseSessionJsonl } = await import('../src/sources/claude/parser.js');
    const { analyzeParsedSession } = await import('../src/index.js');
    const { buildBrief } = await import('../src/narrative.js');
    const { session: parsed } = parseSessionJsonl(session(), { sessionId: 's' });

    expect(buildBrief(analyzeParsedSession(parsed)).stats.toolCalls).toBe(1);
  });
});
