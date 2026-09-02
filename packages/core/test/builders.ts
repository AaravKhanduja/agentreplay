/**
 * Tiny builders for constructing Session objects in tests.
 *
 * Timestamps come from a module-level clock: each turn advances it by 10s
 * (override with `atSec` or `gapSec`), and tool calls sit 1s apart inside
 * their turn. Build turns in chronological order.
 */

import type { Session, ToolCall, ToolCategory, Turn } from '../src/types.js';

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
let clockSec = 0;
let nextId = 1;

export function iso(sec: number): string {
  return new Date(BASE_MS + sec * 1000).toISOString();
}

interface TurnOpts {
  planMode?: boolean;
  /** Absolute seconds since the session base. */
  atSec?: number;
  /** Seconds since the previous turn (default 10). */
  gapSec?: number;
}

function makeTurn(role: 'user' | 'assistant', text: string, toolCalls: ToolCall[], opts: TurnOpts): Turn {
  if (opts.atSec !== undefined) clockSec = opts.atSec;
  else clockSec += opts.gapSec ?? 10;
  const turnSec = clockSec;
  const stamped = toolCalls.map((call, i) => ({ ...call, timestamp: iso(turnSec + i + 1) }));
  clockSec += toolCalls.length;
  return { role, timestamp: iso(turnSec), text, toolCalls: stamped, planMode: opts.planMode ?? false };
}

export function userTurn(text: string, opts: TurnOpts = {}): Turn {
  return makeTurn('user', text, [], opts);
}

export function assistantTurn(text: string, toolCalls: ToolCall[] = [], opts: TurnOpts = {}): Turn {
  return makeTurn('assistant', text, toolCalls, opts);
}

interface TcOpts {
  error?: string;
  result?: string;
  outcome?: ToolCall['outcome'];
}

function call(
  name: string,
  category: ToolCategory,
  filePath: string | null,
  input: Record<string, unknown>,
  opts: TcOpts = {},
): ToolCall {
  return {
    id: `tc-${nextId++}`,
    name,
    category,
    timestamp: iso(clockSec), // overwritten when attached to a turn
    durationMs: null,
    input,
    filePath,
    outcome: opts.outcome ?? (opts.error !== undefined ? 'error' : 'success'),
    errorText: opts.error ?? null,
    resultPreview: opts.result ?? null,
  };
}

export const tc = {
  read: (path: string, opts?: TcOpts) => call('Read', 'read', path, { file_path: path }, opts),
  grep: (pattern: string, opts?: TcOpts) => call('Grep', 'read', null, { pattern }, opts),
  edit: (path: string, oldString: string, newString: string, opts?: TcOpts) =>
    call('Edit', 'write', path, { old_string: oldString, new_string: newString }, opts),
  multiEdit: (path: string, edits: Array<{ old_string: string; new_string: string }>, opts?: TcOpts) =>
    call('MultiEdit', 'write', path, { edits }, opts),
  write: (path: string, content: string, opts?: TcOpts) => call('Write', 'write', path, { content }, opts),
  bash: (command: string, opts?: TcOpts) => call('Bash', 'bash', null, { command }, opts),
  todo: () => call('TodoWrite', 'meta', null, {}),
  exitPlanMode: (plan?: string) =>
    call('ExitPlanMode', 'meta', null, plan === undefined ? {} : { plan }),
};

export function sessionWith(turns: Turn[], overrides: Partial<Session> = {}): Session {
  const first = turns[0];
  const last = turns[turns.length - 1];
  const lastCall = last?.toolCalls[last.toolCalls.length - 1];
  return {
    id: 'test-session',
    projectPath: '/project',
    startedAt: first?.timestamp ?? iso(0),
    endedAt: lastCall?.timestamp ?? last?.timestamp ?? iso(0),
    turns,
    model: null,
    totalTokens: null,
    ...overrides,
  };
}
