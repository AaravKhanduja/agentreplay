import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countCrossSessionReads,
  decodeProjectDir,
  discoverSessions,
  getClaudeProjectsDir,
  resolveSessionRef,
} from '../src/discover.js';
import { codexSource } from '../src/sources/codex/index.js';
import { sessionIdFromPath } from '../src/sources/codex/parser.js';

const ORIGINAL_CONFIG_DIR = process.env['CLAUDE_CONFIG_DIR'];
// Discovery fans out across every installed agent, so a test that only
// redirects Claude would pick up whatever else is on the machine running it.
const ORIGINAL_CODEX_HOME = process.env['CODEX_HOME'];

afterEach(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = ORIGINAL_CONFIG_DIR;
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = ORIGINAL_CODEX_HOME;
});

describe('decodeProjectDir', () => {
  it('decodes a leading-dash project dir to an absolute path', () => {
    expect(decodeProjectDir('-Users-dev-code-webshop')).toBe('/Users/dev/code/webshop');
  });

  it('is lossy for dashes that were part of the original path', () => {
    // "-home-user-my-app" could have been /home/user/my-app; the cwd field
    // on events is the reliable source — this is just the fallback.
    expect(decodeProjectDir('-home-user-my-app')).toBe('/home/user/my/app');
  });

  it('leaves dashless names alone', () => {
    expect(decodeProjectDir('fixtures')).toBe('fixtures');
  });
});

describe('getClaudeProjectsDir', () => {
  it('respects CLAUDE_CONFIG_DIR', () => {
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/claude-config';
    expect(getClaudeProjectsDir()).toBe(path.join('/tmp/claude-config', 'projects'));
  });

  it('defaults to ~/.claude/projects', () => {
    delete process.env['CLAUDE_CONFIG_DIR'];
    expect(getClaudeProjectsDir()).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });
});

describe('discovery against a temp directory tree', () => {
  let tmpDir: string;
  let sessAPath: string;
  let sessBPath: string;
  let sessCPath: string;

  const SESS_A = '3f2b8c1a-9d4e-4f6a-b7c8-1a2b3c4d5e6f';
  const SESS_B = 'aa11bb22-1111-4111-8111-111111111111';
  const SESS_C = 'aabbccdd-2222-4222-8222-222222222222';

  const line = (obj: unknown): string => JSON.stringify(obj);

  async function writeSession(
    projectDir: string,
    sessionId: string,
    lines: string[],
    mtime: Date,
  ): Promise<string> {
    const dir = path.join(tmpDir, 'projects', projectDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8');
    await utimes(filePath, mtime, mtime);
    return filePath;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentreplay-test-'));
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir;
  process.env['CODEX_HOME'] = path.join(tmpDir, 'no-codex-here');

    sessAPath = await writeSession(
      '-Users-dev-code-webshop',
      SESS_A,
      [
        line({
          type: 'user',
          timestamp: '2026-07-20T10:00:00.000Z',
          cwd: '/Users/dev/code/webshop',
          message: { role: 'user', content: 'hi' },
        }),
        line({
          type: 'assistant',
          timestamp: '2026-07-20T10:04:00.000Z',
          cwd: '/Users/dev/code/webshop',
          message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
        // tool-result carrier: not a message for the picker count
        line({
          type: 'user',
          timestamp: '2026-07-20T10:05:00.000Z',
          cwd: '/Users/dev/code/webshop',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
          },
        }),
        line({ type: 'ai-title', title: 'hi session' }),
      ],
      new Date('2026-07-01T00:00:00Z'),
    );

    sessCPath = await writeSession(
      '-Users-dev-code-blog',
      SESS_C,
      [
        line({ type: 'user', timestamp: '2026-07-21T09:00:00.000Z', message: { role: 'user', content: 'a' } }),
        line({ type: 'assistant', timestamp: '2026-07-21T09:01:00.000Z', message: { role: 'assistant', content: [] } }),
        line({ type: 'assistant', timestamp: '2026-07-21T09:02:00.000Z', message: { role: 'assistant', content: [] } }),
      ],
      new Date('2026-07-02T00:00:00Z'),
    );

    sessBPath = await writeSession(
      '-Users-dev-code-blog',
      SESS_B,
      [
        line({ type: 'user', timestamp: '2026-07-22T09:00:00.000Z', message: { role: 'user', content: 'b' } }),
        line({ type: 'assistant', timestamp: '2026-07-22T09:01:00.000Z', message: { role: 'assistant', content: [] } }),
        line({ type: 'assistant', timestamp: '2026-07-22T09:02:00.000Z', message: { role: 'assistant', content: [] } }),
      ],
      new Date('2026-07-03T00:00:00Z'),
    );

    // Too short — must be skipped (< 3 lines).
    await writeSession(
      '-Users-dev-code-webshop',
      'deadbeef-0000-4000-8000-000000000000',
      [line({ type: 'user', message: { role: 'user', content: 'x' } }), line({ type: 'ai-title' })],
      new Date('2026-07-04T00:00:00Z'),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers sessions sorted by mtime desc, skipping short files', async () => {
    const metas = await discoverSessions();
    expect(metas.map((m) => m.sessionId)).toEqual([SESS_B, SESS_C, SESS_A]);
    expect(metas.map((m) => m.filePath)).toEqual([sessBPath, sessCPath, sessAPath]);
  });

  it('builds cheap metadata: message count, duration, project path', async () => {
    const metas = await discoverSessions();
    const a = metas.find((m) => m.sessionId === SESS_A);
    expect(a).toBeDefined();
    expect(a?.messageCount).toBe(2); // carrier + ai-title lines don't count
    expect(a?.durationMs).toBe(5 * 60 * 1000); // 10:00 → 10:05
    expect(a?.projectPath).toBe('/Users/dev/code/webshop'); // from cwd

    const b = metas.find((m) => m.sessionId === SESS_B);
    expect(b?.messageCount).toBe(3);
    expect(b?.durationMs).toBe(2 * 60 * 1000);
    expect(b?.projectPath).toBe('/Users/dev/code/blog'); // no cwd → decoded dir name
  });

  it('applies the limit after sorting', async () => {
    const metas = await discoverSessions({ limit: 1 });
    expect(metas.map((m) => m.sessionId)).toEqual([SESS_B]);
  });

  it('returns [] when the projects dir does not exist', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = path.join(tmpDir, 'nope');
    expect(await discoverSessions()).toEqual([]);
  });

  it('resolves a literal file path', async () => {
    expect(await resolveSessionRef(sessAPath)).toEqual({ agent: 'claude', sessionId: SESS_A, filePath: sessAPath });
  });

  it('resolves a full session uuid across projects', async () => {
    expect((await resolveSessionRef(SESS_A)).filePath).toBe(sessAPath);
  });

  it('resolves a unique uuid prefix', async () => {
    expect((await resolveSessionRef('3f2b')).filePath).toBe(sessAPath);
    expect((await resolveSessionRef('aa11')).filePath).toBe(sessBPath);
  });

  it('rejects an ambiguous prefix with a friendly message', async () => {
    await expect(resolveSessionRef('aa')).rejects.toThrow(/ambiguous/);
  });

  it('rejects an unknown ref with a friendly message', async () => {
    await expect(resolveSessionRef('zzzz')).rejects.toThrow(/No session matching "zzzz"/);
  });

  it('explains when no sessions exist at all', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = path.join(tmpDir, 'nope');
    await expect(resolveSessionRef('3f2b')).rejects.toThrow(/No session matching|looked in/);
  });
});

describe('codex discovery against a rollout tree', () => {
  // Discovery counts messages before it will show a session, and that counting
  // is where a format change hides: the parser kept reading tool calls while
  // every rollout silently stopped being discovered at all.
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(os.tmpdir(), 'agentreplay-codex-'));
    process.env['CODEX_HOME'] = codexHome;
    process.env['CLAUDE_CONFIG_DIR'] = path.join(codexHome, 'no-claude-here');
    const day = path.join(codexHome, 'sessions', '2026', '09', '04');
    await mkdir(day, { recursive: true });
    const fixture = path.join(
      fileURLToPath(new URL('.', import.meta.url)),
      'fixtures',
      'codex-items.jsonl',
    );
    await copyFile(
      fixture,
      path.join(day, 'rollout-2026-09-04T09-00-00-019f7a21-4c8e-71a2-9f30-5b6c7d8e9f01.jsonl'),
    );
  });

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true });
  });

  it('finds a rollout whose messages use the current shape', async () => {
    const metas = await discoverSessions();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.agent).toBe('codex');
    expect(metas[0]?.projectPath).toBe('/Users/dev/reports');
  });

  it('counts the files it could not read, so none-readable is distinguishable from none', async () => {
    // A file that is not a rollout at all: found by countFiles, dropped by discover.
    await writeFile(
      path.join(codexHome, 'sessions', '2026', '09', '04', 'rollout-2026-09-04T10-00-00-junk.jsonl'),
      '{"type":"something-else"}\n',
      'utf8',
    );
    expect(await codexSource.countFiles()).toBe(2);
    expect(await discoverSessions()).toHaveLength(1);
  });

  it('counts every message in it, both sides', async () => {
    const [meta] = await discoverSessions();
    // One from the developer, three from the agent.
    expect(meta?.messageCount).toBe(4);
  });
});

describe('resolving a path on a machine with neither agent installed', () => {
  // CI is exactly this machine: it has never run Claude Code or Codex, so
  // nothing lives under ~/.claude or ~/.codex. Availability gates discovery,
  // never a file someone handed us by path.
  beforeEach(() => {
    process.env['CLAUDE_CONFIG_DIR'] = path.join(os.tmpdir(), 'agentreplay-no-claude-here');
    process.env['CODEX_HOME'] = path.join(os.tmpdir(), 'agentreplay-no-codex-here');
  });

  const fixture = (name: string): string =>
    path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', name);

  it('resolves a Codex rollout', async () => {
    const filePath = fixture('codex-exec.jsonl');
    expect(await resolveSessionRef(filePath)).toEqual({
      agent: 'codex',
      sessionId: sessionIdFromPath(filePath),
      filePath,
    });
  });

  it('resolves a Claude session', async () => {
    const filePath = fixture('clean-execute.jsonl');
    expect((await resolveSessionRef(filePath)).agent).toBe('claude');
  });

  it('still rejects a file no reader recognises', async () => {
    await expect(resolveSessionRef(fixture('../builders.ts'))).rejects.toThrow(
      /doesn't look like a session file/,
    );
  });
});

describe('countCrossSessionReads', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'agentreplay-cross-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]) =>
    writeFile(path.join(dir, name), lines.join('\n') + '\n', 'utf8');

  it('counts quoted-path occurrences across sibling sessions, excluding the session itself', async () => {
    await write('own-session.jsonl', ['{"file_path":"src/lib/stripe.ts"}']);
    await write('sib-1.jsonl', ['{"input":{"file_path":"src/lib/stripe.ts"}}', '{"input":{"file_path":"src/lib/stripe.ts"}}']);
    await write('sib-2.jsonl', ['{"input":{"file_path":"src/lib/stripe.ts"}}', '{"x":"src/app.ts unquoted"}']);

    const counts = await countCrossSessionReads(
      path.join(dir, 'own-session.jsonl'),
      ['src/lib/stripe.ts', 'src/app.ts'],
      'own-session',
    );
    expect(counts?.['src/lib/stripe.ts']).toBe(3);
    // unquoted mention doesn't count
    expect(counts?.['src/app.ts']).toBeUndefined();
  });

  it('matches absolute-path tool inputs via the suffix form', async () => {
    await write('own.jsonl', ['{}']);
    await write('sib.jsonl', ['{"input":{"file_path":"/Users/dev/proj/src/lib/stripe.ts"}}']);
    const counts = await countCrossSessionReads(path.join(dir, 'own.jsonl'), ['src/lib/stripe.ts'], 'own');
    expect(counts?.['src/lib/stripe.ts']).toBe(1);
  });

  it('returns undefined when there are no siblings', async () => {
    await write('own.jsonl', ['{}']);
    const counts = await countCrossSessionReads(path.join(dir, 'own.jsonl'), ['src/a.ts'], 'own');
    expect(counts).toBeUndefined();
  });

  it('returns undefined for a missing directory and never throws', async () => {
    const counts = await countCrossSessionReads(path.join(dir, 'nope', 'x.jsonl'), ['src/a.ts'], 'x');
    expect(counts).toBeUndefined();
  });

  it('returns undefined with no candidates', async () => {
    expect(await countCrossSessionReads(path.join(dir, 'own.jsonl'), [], 'own')).toBeUndefined();
  });
});
