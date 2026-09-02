import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseSessionFile, parseSessionJsonl } from '../src/parser.js';
import type { ToolCall, Turn } from '../src/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name: string): string => path.join(fixturesDir, name);

function turnAt(turns: Turn[], index: number): Turn {
  const turn = turns[index];
  if (turn === undefined) throw new Error(`no turn at index ${index}`);
  return turn;
}

function callById(turns: Turn[], id: string): ToolCall {
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      if (call.id === id) return call;
    }
  }
  throw new Error(`no tool call with id ${id}`);
}

describe('clean-execute fixture', () => {
  it('parses turns, tool calls, and session metadata', async () => {
    const { session, skippedLines } = await parseSessionFile(fixture('clean-execute.jsonl'));

    expect(skippedLines).toBe(0);
    expect(session.id).toBe('clean-execute');
    expect(session.projectPath).toBe('/Users/dev/code/webshop');
    expect(session.model).toBe('claude-fable-5');
    // msg_01A spans two lines with identical usage — counted once. Sidechain
    // usage (9999/9999) is excluded entirely.
    expect(session.totalTokens).toBe(6465);
    expect(session.startedAt).toBe('2026-07-20T10:00:00.000Z');
    expect(session.endedAt).toBe('2026-07-20T10:01:10.000Z');

    expect(session.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(session.turns.every((t) => !t.planMode)).toBe(true);

    expect(turnAt(session.turns, 0).text).toBe('add a retry helper to the fetch client');
    // Consecutive assistant lines (across tool-result carriers) merge into one turn.
    const assistant1 = turnAt(session.turns, 1);
    expect(assistant1.text).toBe(
      "I'll look at the fetch client first.\n\nNow I'll add the retry wrapper.",
    );
    expect(assistant1.toolCalls.map((c) => c.name)).toEqual(['Read', 'Read', 'Edit']);
    expect(assistant1.toolCalls.map((c) => c.filePath)).toEqual([
      'src/lib/fetch.ts',
      'src/lib/config.ts',
      'src/lib/fetch.ts',
    ]);
    expect(assistant1.toolCalls.map((c) => c.category)).toEqual(['read', 'read', 'write']);

    const assistant2 = turnAt(session.turns, 3);
    expect(assistant2.toolCalls.map((c) => c.name)).toEqual(['Write']);
    expect(turnAt(session.turns, 3).toolCalls[0]?.filePath).toBe('src/lib/retry.ts');
  });

  it('matches tool results: duration, outcome, preview', async () => {
    const { session } = await parseSessionFile(fixture('clean-execute.jsonl'));

    const read1 = callById(session.turns, 'toolu_c1');
    expect(read1.outcome).toBe('success');
    expect(read1.durationMs).toBe(1500); // 10:00:05.000 → 10:00:06.500
    expect(read1.errorText).toBeNull();
    expect(read1.resultPreview).toContain('export async function fetchJson');

    // tool_result content as an array of text blocks
    const read2 = callById(session.turns, 'toolu_c2');
    expect(read2.resultPreview).toContain('httpConfig');
    expect(read2.durationMs).toBe(1000);

    // "updated" in an Edit result must not trip the Bash-only error regex
    const edit = callById(session.turns, 'toolu_c3');
    expect(edit.outcome).toBe('success');
  });
});

describe('debug-loops fixture', () => {
  it('counts only malformed lines as skipped', async () => {
    const { skippedLines } = await parseSessionFile(fixture('debug-loops.jsonl'));
    expect(skippedLines).toBe(2); // truncated JSON + non-JSON line; ai-title/sidechain don't count
  });

  it('merges everything after the user turn into one assistant turn', async () => {
    const { session } = await parseSessionFile(fixture('debug-loops.jsonl'));
    expect(session.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turnAt(session.turns, 1).toolCalls).toHaveLength(10);
  });

  it('detects bash errors via is_error and via the error regex', async () => {
    const { session } = await parseSessionFile(fixture('debug-loops.jsonl'));
    const calls = session.turns.flatMap((t) => t.toolCalls);

    const errors = calls.filter((c) => c.outcome === 'error');
    expect(errors.map((c) => c.id)).toEqual(['toolu_b1', 'toolu_b2', 'toolu_b3']);
    expect(errors.every((c) => c.name === 'Bash')).toBe(true);
    expect(errors.every((c) => c.errorText !== null && c.errorText.length <= 500)).toBe(true);

    // toolu_b2 has no is_error flag — caught by the /error|failed|.../i scan
    const regexError = callById(session.turns, 'toolu_b2');
    expect(regexError.errorText).toContain('sha256=cd34');

    // the passing run says "passed", which must not match the error regex
    const passing = callById(session.turns, 'toolu_b4');
    expect(passing.outcome).toBe('success');
    expect(passing.resultPreview).toContain('4 passed');

    const firstBash = callById(session.turns, 'toolu_b1');
    expect(firstBash.durationMs).toBe(5000);
  });

  it('leaves orphaned tool calls as unknown', async () => {
    const { session } = await parseSessionFile(fixture('debug-loops.jsonl'));
    const orphan = callById(session.turns, 'toolu_orphan');
    expect(orphan.outcome).toBe('unknown');
    expect(orphan.durationMs).toBeNull();
    expect(orphan.resultPreview).toBeNull();
    expect(orphan.errorText).toBeNull();
  });

  it('extracts the breakthrough read with a relative path', async () => {
    const { session } = await parseSessionFile(fixture('debug-loops.jsonl'));
    const read = callById(session.turns, 'toolu_r1');
    expect(read.name).toBe('Read');
    expect(read.filePath).toBe('src/utils/signature.ts');
    expect(read.outcome).toBe('success');
  });
});

describe('plan-mode fixture', () => {
  it('flags turns by the latest permission-mode signal', async () => {
    const { session, skippedLines } = await parseSessionFile(fixture('plan-mode.jsonl'));

    expect(skippedLines).toBe(0);
    expect(session.turns.map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(session.turns.map((t) => t.planMode)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false, // permission-mode flipped back to "default" before this user turn
      false,
    ]);
  });

  it('parses ExitPlanMode and the execute edits', async () => {
    const { session } = await parseSessionFile(fixture('plan-mode.jsonl'));

    const exitPlan = callById(session.turns, 'toolu_x1');
    expect(exitPlan.name).toBe('ExitPlanMode');
    expect(exitPlan.category).toBe('meta');
    expect(exitPlan.outcome).toBe('success');
    // ExitPlanMode lives on the third assistant turn (merged with the rev-3 plan text)
    expect(turnAt(session.turns, 5).toolCalls.map((c) => c.id)).toEqual(['toolu_x1']);
    expect(turnAt(session.turns, 5).text).toContain('## Phase 2a — Delivery backend');

    const lastTurn = turnAt(session.turns, 7);
    expect(lastTurn.toolCalls.map((c) => c.name)).toEqual(['Edit', 'Write']);
    expect(lastTurn.toolCalls.map((c) => c.category)).toEqual(['write', 'write']);
    expect(lastTurn.toolCalls.map((c) => c.filePath)).toEqual([
      'src/digest/scheduler.ts',
      'src/digest/render.ts',
    ]);

    expect(session.totalTokens).toBe(13010);
  });
});

describe('parseSessionJsonl edge cases', () => {
  const jsonl = (objs: unknown[]): string => objs.map((o) => JSON.stringify(o)).join('\n');

  /** One assistant event carrying one tool call. */
  const assistantCall = (uuid: string, at: string, name: string, input: unknown) => ({
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: at,
    isSidechain: false,
    message: {
      id: `msg_${uuid}`,
      model: 'claude-fable-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: `tool_${uuid}`, name, input }],
    },
  });

  it('does not count a declined tool call as a failure', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        assistantCall('a1', '2026-07-20T10:00:00.000Z', 'Bash', { command: 'pnpm test' }),
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          timestamp: '2026-07-20T10:00:05.000Z',
          isSidechain: false,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_a1',
                is_error: true,
                content:
                  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit).",
              },
            ],
          },
        },
      ]),
      { sessionId: 's', projectPathHint: '/p' },
    );

    // It never ran: neither a success nor a failure. Counting it as an error
    // turned rows of permission prompts into "the same failure ×9".
    expect(session.turns[0]?.toolCalls[0]?.outcome).toBe('unknown');
  });

  it('ends the assistant turn at ExitPlanMode, so execution is not labeled planning', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        { type: 'permission-mode', permissionMode: 'plan' },
        assistantCall('a1', '2026-07-20T10:00:00.000Z', 'ExitPlanMode', { plan: '1. do it' }),
        assistantCall('a2', '2026-07-20T10:00:30.000Z', 'Edit', {
          file_path: '/p/src/app.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      ]),
      { sessionId: 's', projectPathHint: '/p' },
    );

    expect(session.turns).toHaveLength(2);
    expect(session.turns[0]?.toolCalls.map((c) => c.name)).toEqual(['ExitPlanMode']);
    expect(session.turns[0]?.planMode).toBe(true);
    // The edit is its own turn, and no longer inherits the plan label.
    expect(session.turns[1]?.toolCalls.map((c) => c.name)).toEqual(['Edit']);
    expect(session.turns[1]?.planMode).toBe(false);
  });

  it('splits an assistant turn across a long silence between tool calls', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        assistantCall('a1', '2026-07-20T10:00:00.000Z', 'Read', { file_path: '/p/src/a.ts' }),
        assistantCall('a2', '2026-07-20T10:02:00.000Z', 'Read', { file_path: '/p/src/b.ts' }),
        // 47 minutes later — an approval wait, or the developer stepping away.
        assistantCall('a3', '2026-07-20T10:49:00.000Z', 'Edit', {
          file_path: '/p/src/b.ts',
          old_string: 'a',
          new_string: 'b',
        }),
      ]),
      { sessionId: 's', projectPathHint: '/p' },
    );

    expect(session.turns.map((t) => t.toolCalls.length)).toEqual([2, 1]);
  });

  it('keeps ordinary tool-call rhythm in one turn', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        assistantCall('a1', '2026-07-20T10:00:00.000Z', 'Read', { file_path: '/p/src/a.ts' }),
        assistantCall('a2', '2026-07-20T10:04:00.000Z', 'Read', { file_path: '/p/src/b.ts' }),
        assistantCall('a3', '2026-07-20T10:07:00.000Z', 'Read', { file_path: '/p/src/c.ts' }),
      ]),
      { sessionId: 's', projectPathHint: '/p' },
    );

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.toolCalls).toHaveLength(3);
  });

  it('truncates input strings at 4000, errorText at 500, resultPreview at 300', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: null,
          timestamp: '2026-07-20T10:00:00.000Z',
          isSidechain: false,
          message: {
            id: 'msg_1',
            model: 'claude-fable-5',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x'.repeat(5000) } },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: 'a1',
          timestamp: '2026-07-20T10:00:02.000Z',
          isSidechain: false,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'e'.repeat(1000) },
            ],
          },
        },
      ]),
      { sessionId: 's' },
    );

    const call = turnAt(session.turns, 0).toolCalls[0];
    expect(call).toBeDefined();
    expect((call?.input['command'] as string).length).toBe(4000);
    expect(call?.outcome).toBe('error');
    expect(call?.errorText?.length).toBe(500);
    expect(call?.resultPreview?.length).toBe(300);
    expect(call?.durationMs).toBe(2000);
  });

  it('uses projectPathHint when no cwd appears, and keeps outside paths absolute', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: null,
          timestamp: '2026-07-20T10:00:00.000Z',
          message: {
            id: 'msg_1',
            model: 'claude-fable-5',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/proj/a/b.ts' } },
              { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/etc/hosts' } },
            ],
          },
        },
      ]),
      { sessionId: 's', projectPathHint: '/proj' },
    );

    expect(session.projectPath).toBe('/proj');
    const calls = turnAt(session.turns, 0).toolCalls;
    expect(calls.map((c) => c.filePath)).toEqual(['a/b.ts', '/etc/hosts']);
  });

  it('skips unknown line types silently and counts only malformed ones', () => {
    const { session, skippedLines } = parseSessionJsonl(
      [
        '{"type":"file-history-snapshot","snapshot":{}}',
        '{"type":"mode","mode":"whatever"}',
        '{"broken": true', // malformed
        '"just a string"', // valid JSON, no usable shape
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        }),
      ].join('\n'),
      { sessionId: 's' },
    );

    expect(skippedLines).toBe(2);
    expect(session.turns).toHaveLength(1);
    expect(turnAt(session.turns, 0).text).toBe('hello');
  });

  it('reads user text from content block arrays', () => {
    const { session } = parseSessionJsonl(
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-07-20T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'block text' }] },
        },
      ]),
      { sessionId: 's' },
    );
    expect(turnAt(session.turns, 0).text).toBe('block text');
  });
});
