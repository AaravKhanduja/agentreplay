import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { commandOf, planText } from '../src/checks.js';
import { analyzeParsedSession } from '../src/index.js';
import { errorSignature } from '../src/loops.js';
import { buildBrief } from '../src/narrative.js';
import { parseCodexFile, parseCodexJsonl, readOutput, sessionIdFromPath } from '../src/sources/codex/parser.js';
import { sniffCodex } from '../src/sources/codex/discover.js';
import type { Session, ToolCall } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const load = (name: string) => parseCodexFile(path.join(fixturesDir, name));
const calls = (session: Session): ToolCall[] => session.turns.flatMap((t) => t.toolCalls);

describe('codex parser', () => {
  it('reads the session_meta header and the turn model', async () => {
    const { session, skippedLines } = await load('codex-exec.jsonl');
    expect(session.agent).toBe('codex');
    expect(session.id).toBe('019e6f13-91d0-7893-9d26-2e5886df16b2');
    expect(session.projectPath).toBe('/Users/dev/webshop');
    // model_provider is "openai"; the model name lives on turn_context.
    expect(session.model).toBe('gpt-5.5');
    expect(session.totalTokens).toBe(25651);
    // A truncated line and a non-JSON line; nothing else counts.
    expect(skippedLines).toBe(2);
  });

  it('never lets an injected preamble become the ask', async () => {
    const { session } = await load('codex-exec.jsonl');
    const [first] = session.turns;
    // The same prompt appears as a response_item carrying the AGENTS.md
    // preamble and the permissions instructions. Read that copy instead and the
    // preamble becomes the replay's title and its opening request.
    expect(first?.role).toBe('user');
    expect(first?.text).toBe('the signature check rejects valid webhooks — find out why');
    expect(session.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(session.turns)).not.toContain('AGENTS.md');
    expect(JSON.stringify(session.turns)).not.toContain('permissions instructions');
  });

  it('gives every shell call the command key the heuristics read', async () => {
    const { session } = await load('codex-exec.jsonl');
    const shell = calls(session).filter((c) => c.name === 'exec_command');
    expect(shell.length).toBeGreaterThan(0);
    // Without this the fallback returns the tool name, and a whole session
    // collapses into one phase of "exec_command" that ran nothing.
    for (const call of shell) expect(commandOf(call)).not.toBe('exec_command');
    expect(commandOf(shell[0] as ToolCall)).toBe('rg -n "verifySignature" src');
  });
});

describe('codex tool output', () => {
  it('strips the wrapper so an error signature is the error', () => {
    const raw = [
      'Chunk ID: dd33ee',
      'Wall time: 0.4210 seconds',
      'Process exited with code 1',
      'Original token count: 42',
      'Output:',
      'FAIL src/webhook/handler.test.ts',
      '  signature mismatch: expected sha256=abc',
    ].join('\n');
    const { exitCode, body } = readOutput(raw);
    expect(exitCode).toBe(1);
    expect(body.split('\n')[0]).toBe('FAIL src/webhook/handler.test.ts');
  });

  it('two runs of the same failure compare equal', async () => {
    const { session } = await load('codex-exec.jsonl');
    const failures = calls(session).filter((c) => c.outcome === 'error');
    expect(failures).toHaveLength(2);
    const [a, b] = failures;
    // The Chunk ID is unique per call and sits on the first line. Left in
    // place, no two failures ever match, no stuck run is ever detected, and a
    // session that fought one error for hours reports as clean.
    expect(errorSignature(a?.errorText ?? '')).toBe(errorSignature(b?.errorText ?? ''));
    expect(errorSignature(a?.errorText ?? '')).not.toContain('chunk id');
  });

  it('does not call a fruitless search a failure', async () => {
    const { session } = await load('codex-exec.jsonl');
    const search = calls(session).find((c) => commandOf(c).includes('notAThing'));
    // rg exiting 1 means it found nothing. That is an answer, not an error.
    expect(search?.outcome).toBe('success');
  });
});

describe('codex shell work', () => {
  it('classifies reading, searching and running by what the command does', async () => {
    const { session } = await load('codex-exec.jsonl');
    const byCommand = new Map(calls(session).map((c) => [commandOf(c), c.category]));
    expect(byCommand.get('rg -n "verifySignature" src')).toBe('read');
    expect(byCommand.get("sed -n '30,60p' src/webhook/handler.ts")).toBe('read');
    expect(byCommand.get('pnpm test webhooks')).toBe('bash');
  });

  it('turns an apply_patch into an edit with a real diff', async () => {
    const { session } = await load('codex-exec.jsonl');
    const analyzed = analyzeParsedSession(session);
    const [history] = analyzed.editHistories;
    expect(history?.path).toBe('src/webhook/handler.ts');
    expect(history?.attempts[0]?.diff).toEqual([
      { kind: 'del', text: '  const raw = req.body.toString();' },
      { kind: 'add', text: '  const raw = req.rawBody;' },
    ]);
    expect(buildBrief(analyzed).stats.filesChanged).toBe(1);
  });

  it('finds the debug loops those edits are part of', async () => {
    const { session } = await load('codex-exec.jsonl');
    const analyzed = analyzeParsedSession(session);
    // Three edit-then-check cycles, ending green. Without the shell writes
    // there is no write with a path, so there are no loops at all.
    expect(analyzed.debugSequences[0]?.loops).toHaveLength(3);
    expect(analyzed.phases.map((p) => p.kind)).toContain('debug');
    expect(buildBrief(analyzed).stats.outcome).toBe('passed');
  });
});

describe('codex plans', () => {
  it('reads update_plan as a plan revision', async () => {
    const { session } = await load('codex-plan.jsonl');
    const analyzed = analyzeParsedSession(session);
    expect(analyzed.planRevisions.map((r) => r.changeKind)).toEqual(['initial', 'revised']);
  });

  it('diffs the steps exactly, because the wording is stable across revisions', async () => {
    const { session } = await load('codex-plan.jsonl');
    const [, second] = analyzeParsedSession(session).planRevisions;
    // A step list survives a revision verbatim, so the diff is exact: two steps
    // untouched, one reworded, one appended. Prose plans churn into
    // removed+added because no two drafts phrase a step the same way.
    expect(second?.change).toEqual({ added: 2, removed: 1, kept: 2 });
    const by = (change: string) => second?.steps.filter((s) => s.change === change).map((s) => s.text) ?? [];
    expect(by('kept')).toContain('Inspect editorials CMS services and AI utilities');
    expect(by('added')).toContain('Add cron entry and verify with targeted checks');
    expect(by('removed')).toContain('Add trending-products retrieval and AI draft generation');
  });

  it('quotes the session for why the plan moved', async () => {
    const { session } = await load('codex-plan.jsonl');
    const [, second] = analyzeParsedSession(session).planRevisions;
    expect(second?.planText).toContain('use Gemini through the existing Google AI SDK');
  });

  it('reads a filed plan by its shape, whichever agent filed it', async () => {
    const { session } = await load('codex-plan.jsonl');
    const planCall = calls(session).find((c) => c.name === 'update_plan');
    expect(planText(planCall as ToolCall)).toContain('1. Inspect editorials CMS services');
  });
});

describe('codex discovery', () => {
  it('recognizes a rollout by its first line', () => {
    expect(sniffCodex('{"timestamp":"2026-05-28T14:00:00Z","type":"session_meta","payload":{}}')).toBe(true);
    expect(sniffCodex('{"type":"user","uuid":"u1"}')).toBe(false);
    expect(sniffCodex('not json')).toBe(false);
  });

  it('takes the id out of the filename, not the whole filename', () => {
    expect(sessionIdFromPath('/x/rollout-2026-05-28T10-53-34-019e6f13-91d0-7893-9d26-2e5886df16b2.jsonl'))
      .toBe('019e6f13-91d0-7893-9d26-2e5886df16b2');
  });
});

describe('codex patches', () => {
  const patchCalls = (session: Session): ToolCall[] =>
    calls(session).filter((call) => call.name === 'apply_patch');

  it('reads apply_patch as one write per file it changed', async () => {
    const { session } = await load('codex-patch.jsonl');
    const writes = patchCalls(session).filter((call) => call.category === 'write');
    expect(writes.map((call) => call.filePath)).toEqual([
      'src/webhooks/verify.ts',
      'src/webhooks/raw-body.ts',
      'src/config/env.ts',
    ]);
  });

  it('files the edits where diffs.ts can read them', async () => {
    const { session } = await load('codex-patch.jsonl');
    const analyzed = analyzeParsedSession(session);
    // Without this the whole chain is empty: no file graph, no edit history,
    // and no debug loop, because a loop begins at a write with a path.
    expect(analyzed.files.filter((file) => file.writes > 0)).toHaveLength(3);
    const verify = analyzed.editHistories.find((h) => h.path === 'src/webhooks/verify.ts');
    expect(verify?.attempts).toHaveLength(1);
    expect(verify?.attempts[0]?.diff.some((line) => line.kind === 'del')).toBe(true);
    expect(verify?.attempts[0]?.diff.some((line) => line.kind === 'add')).toBe(true);
  });

  it('counts one action even when the patch changed two files', async () => {
    const { session } = await load('codex-patch.jsonl');
    const applied = patchCalls(session).filter((call) => call.id.startsWith('p1'));
    // The agent made one call; two files changed. The parent is what the header
    // counts, the synthetic writes are what the file graph reads.
    expect(applied.filter((call) => call.synthetic !== true)).toHaveLength(1);
    expect(applied.filter((call) => call.synthetic === true)).toHaveLength(2);
    expect(applied[0]?.category).toBe('meta');
  });

  it('treats a patch the developer refused as unknown, never an error', async () => {
    const { session } = await load('codex-patch.jsonl');
    const refused = patchCalls(session).filter((call) => call.id.startsWith('p2'));
    expect(refused.length).toBeGreaterThan(0);
    // "patch rejected by user" never applied, so it is neither a pass nor a
    // fail — counting it as a failure turns a row of refusals into a row of bugs.
    expect(refused.every((call) => call.outcome === 'unknown')).toBe(true);
    expect(refused.every((call) => call.errorText === null)).toBe(true);
  });

  it('names every file even when the patch is longer than the input cap', () => {
    const files = Array.from({ length: 6 }, (_, i) => `src/gen/file-${i}.ts`);
    const patch = [
      '*** Begin Patch',
      ...files.flatMap((file) => [`*** Add File: ${file}`, `+// ${'x'.repeat(900)}`]),
      '*** End Patch',
    ].join('\n');
    expect(patch.length).toBeGreaterThan(4000);

    const jsonl = [
      JSON.stringify({ timestamp: '2026-06-02T10:00:00.000Z', type: 'session_meta', payload: { id: 's', cwd: '/repo' } }),
      JSON.stringify({ timestamp: '2026-06-02T10:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'p9', name: 'apply_patch', input: patch } }),
    ].join('\n');

    const { session } = parseCodexJsonl(jsonl, { sessionId: 's' });
    // The stored input is truncated to keep the artifact small; the parse is not.
    expect(calls(session).filter((c) => c.category === 'write').map((c) => c.filePath)).toEqual(files);
    expect(String(calls(session)[0]?.input['patch']).length).toBeLessThan(patch.length);
  });
});

describe('codex turns', () => {
  it('ends the turn where the developer stopped the run', async () => {
    const { session } = await load('codex-patch.jsonl');
    // turn_aborted is a seam: what the agent says afterwards is a new stretch
    // of work, and phases are cut at turn boundaries.
    const assistant = session.turns.filter((turn) => turn.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(1);
    expect(assistant.at(-1)?.text).toContain('Stopped.');
    expect(assistant[0]?.text).not.toContain('Stopped.');
  });

  it('reads a web search as reading', async () => {
    const { session } = await load('codex-patch.jsonl');
    const search = calls(session).find((call) => call.name === 'web_search');
    expect(search?.category).toBe('read');
    expect(search?.input['query']).toContain('raw body');
  });
});

describe('the codex analysis is artifact-safe', () => {
  it.each(['codex-exec.jsonl', 'codex-plan.jsonl', 'codex-patch.jsonl'])('%s survives the JSON round trip', async (name) => {
    const { session } = await load(name);
    const analyzed = analyzeParsedSession(session);
    expect(JSON.parse(JSON.stringify(analyzed))).toEqual(analyzed);
  });

  it.each(['codex-exec.jsonl', 'codex-plan.jsonl', 'codex-patch.jsonl'])('%s analyzes the same way twice', async (name) => {
    const { session } = await load(name);
    expect(buildBrief(analyzeParsedSession(session))).toEqual(buildBrief(analyzeParsedSession(session)));
  });
});
