/**
 * Codex CLI rollout JSONL → Session.
 *
 * Format in `docs/codex-rollout-format.md`. Every line is
 * `{timestamp, type, payload}`, and the first is always `session_meta`.
 *
 * The one rule worth stating up front: **message text comes from `event_msg`,
 * tool calls come from `response_item`.** The two overlap — a user's prompt
 * appears as both an `event_msg/user_message` and a `response_item/message`
 * with role 'user' — but the `response_item` copy also carries the injected
 * AGENTS.md preamble and the permissions instructions, which nobody typed.
 * Reading both would double every turn; reading the wrong one would put a
 * system preamble in the replay's title and its opening request.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { shellKind } from '../../checks.js';
import { expandShellWrites } from '../../shellcalls.js';
import type { ParsedSession, Session, ToolCall, ToolCategory, Turn } from '../../types.js';

const INPUT_STRING_MAX = 4000;
const ERROR_TEXT_MAX = 500;
const RESULT_PREVIEW_MAX = 300;
/** Silence between two tool calls that ends an assistant turn. */
const IDLE_SPLIT_MS = 10 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Deep-truncate strings so a huge patch body doesn't bloat the artifact. */
function truncateStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > INPUT_STRING_MAX ? value.slice(0, INPUT_STRING_MAX) : value;
  }
  if (Array.isArray(value)) return value.map(truncateStrings);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = truncateStrings(inner);
    return out;
  }
  return value;
}

function relativizePath(filePath: string, projectPath: string): string {
  if (projectPath === '' || !path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(projectPath, filePath);
  return rel === '' || rel.startsWith('..') ? filePath : rel;
}

/**
 * What a tool result actually says.
 *
 * Codex wraps output in a header — `Chunk ID`, `Wall time`, the exit code, a
 * token count — and the Chunk ID is unique per call. Left in place it becomes
 * the first line of `errorText`, and `errorSignature` reads the first line: two
 * runs of the same failing test would never compare equal, no stuck run would
 * ever be detected, and a session that spent two hours on one error would
 * report as clean. Stripping this header is the whole reason it exists.
 */
export function readOutput(raw: string): { exitCode: number | null; body: string } {
  const exit = /^Process exited with code (\d+)/m.exec(raw);
  const marker = raw.indexOf('\nOutput:\n');
  const body = marker === -1 ? raw : raw.slice(marker + '\nOutput:\n'.length);
  return { exitCode: exit === null ? null : Number(exit[1]), body };
}

/** The command a call ran, and the shape the rest of the code expects to read it in. */
function normalizeInput(name: string, args: Record<string, unknown>): {
  input: Record<string, unknown>;
  category: ToolCategory;
  command: string | null;
} {
  if (name === 'exec_command' || name === 'shell') {
    const command = str(args['cmd']) ?? str(args['command']) ?? '';
    // `command` is the key `commandOf` reads, and every shell heuristic with it.
    return { input: { ...args, command }, category: 'bash', command };
  }
  if (name === 'update_plan') {
    // Rendered into the shape `planText` reads, so no heuristic needs to know
    // that this agent files its plan as a list of steps rather than a document.
    return { input: { ...args, plan: renderPlan(args) }, category: 'meta', command: null };
  }
  return { input: args, category: 'meta', command: null };
}

/** `{plan: [{step, status}], explanation?}` as the numbered list a plan reads as. */
function renderPlan(args: Record<string, unknown>): string {
  const steps = args['plan'];
  if (!Array.isArray(steps)) return '';
  const lines = steps
    .filter(isRecord)
    .map((entry) => str(entry['step']))
    .filter((step): step is string => step !== null && step !== '')
    .map((step, i) => `${i + 1}. ${step}`);
  const explanation = str(args['explanation']);
  // The explanation is the session's own words for why the plan moved.
  return explanation === null ? lines.join('\n') : `${explanation}\n\n${lines.join('\n')}`;
}

export function parseCodexJsonl(
  jsonl: string,
  opts: { sessionId: string; projectPathHint?: string; title?: string | null },
): ParsedSession {
  let skippedLines = 0;
  const events: Record<string, unknown>[] = [];

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      skippedLines += 1;
      continue;
    }
    events.push(parsed);
  }

  let projectPath = opts.projectPathHint ?? '';
  let sessionId = opts.sessionId;
  let model: string | null = null;
  let totalTokens: number | null = null;
  let approvalPolicy: string | null = null;

  const turns: Turn[] = [];
  let currentAssistant: Turn | null = null;
  const pendingCalls = new Map<string, ToolCall>();
  const shellCalls: ToolCall[] = [];
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  const openAssistant = (timestamp: string): Turn => {
    // A long silence between calls is a seam — an approval wait, or the
    // developer stepping away — and phases are cut at turn boundaries.
    if (currentAssistant !== null) {
      const previous = currentAssistant.toolCalls[currentAssistant.toolCalls.length - 1];
      if (previous !== undefined) {
        const gap = Date.parse(timestamp) - Date.parse(previous.timestamp);
        if (Number.isFinite(gap) && gap >= IDLE_SPLIT_MS) currentAssistant = null;
      }
    }
    if (currentAssistant === null) {
      currentAssistant = { role: 'assistant', timestamp, text: '', toolCalls: [], planMode: false };
      turns.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const event of events) {
    const type = event['type'];
    const timestamp = str(event['timestamp']) ?? '';
    if (timestamp !== '') {
      if (firstTimestamp === null) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }
    const payload = isRecord(event['payload']) ? event['payload'] : null;
    if (payload === null) continue;

    if (type === 'session_meta') {
      projectPath = str(payload['cwd']) ?? projectPath;
      sessionId = str(payload['id']) ?? sessionId;
      continue;
    }

    if (type === 'turn_context') {
      model = str(payload['model']) ?? model;
      const cwd = str(payload['cwd']);
      const policy = str(payload['approval_policy']);
      // Codex has no plan mode, so this is the closest thing to one: the work
      // changed character when the directory or the approval rules changed.
      if ((cwd !== null && cwd !== projectPath) || (policy !== null && policy !== approvalPolicy)) {
        if (approvalPolicy !== null || (cwd !== null && cwd !== projectPath)) currentAssistant = null;
      }
      if (cwd !== null && projectPath === '') projectPath = cwd;
      approvalPolicy = policy ?? approvalPolicy;
      continue;
    }

    const payloadType = str(payload['type']);

    if (type === 'event_msg') {
      if (payloadType === 'user_message') {
        const text = str(payload['message']) ?? '';
        if (text.trim() === '') continue;
        turns.push({ role: 'user', timestamp, text, toolCalls: [], planMode: false });
        currentAssistant = null;
        continue;
      }
      if (payloadType === 'agent_message') {
        const text = str(payload['message']) ?? '';
        if (text.trim() === '') continue;
        const turn = openAssistant(timestamp);
        turn.text = turn.text === '' ? text : `${turn.text}\n\n${text}`;
        continue;
      }
      if (payloadType === 'token_count') {
        const info = isRecord(payload['info']) ? payload['info'] : null;
        const usage = info !== null && isRecord(info['total_token_usage']) ? info['total_token_usage'] : null;
        // Cumulative, so the last one seen is the session's total.
        if (usage !== null && typeof usage['total_tokens'] === 'number') {
          totalTokens = usage['total_tokens'];
        }
        continue;
      }
      continue;
    }

    if (type !== 'response_item') continue;

    if (payloadType === 'function_call') {
      const name = str(payload['name']) ?? 'unknown';
      const callId = str(payload['call_id']) ?? '';
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(str(payload['arguments']) ?? '{}');
        if (isRecord(parsed)) args = truncateStrings(parsed) as Record<string, unknown>;
      } catch {
        // Unparseable arguments are not a broken line; the call still happened.
      }

      const { input, category, command } = normalizeInput(name, args);
      const call: ToolCall = {
        id: callId,
        name,
        // Reading is reading whatever tool carried it — and for this agent
        // every read, search and edit is carried by the shell.
        category: command === null ? category : categoryOfShell(command),
        timestamp,
        durationMs: null,
        input,
        filePath: null,
        outcome: 'unknown',
        errorText: null,
        resultPreview: null,
      };
      openAssistant(timestamp).toolCalls.push(call);
      if (callId !== '') pendingCalls.set(callId, call);
      if (command !== null) shellCalls.push(call);
      continue;
    }

    if (payloadType === 'function_call_output') {
      const callId = str(payload['call_id']) ?? '';
      const call = pendingCalls.get(callId);
      if (call === undefined) continue;
      pendingCalls.delete(callId);

      const rawOutput = str(payload['output']) ?? outputText(payload['output']);
      const { exitCode, body } = readOutput(rawOutput);
      call.outcome = outcomeOf(exitCode, call);
      if (call.outcome === 'error') call.errorText = body.slice(0, ERROR_TEXT_MAX);
      call.resultPreview = body.slice(0, RESULT_PREVIEW_MAX);

      const callMs = Date.parse(call.timestamp);
      const resultMs = Date.parse(timestamp);
      if (!Number.isNaN(callMs) && !Number.isNaN(resultMs)) call.durationMs = resultMs - callMs;
      continue;
    }
  }

  // Paths and shell edits are resolved once the project root is known and the
  // outcomes have landed: a synthetic write copies the outcome of its command.
  for (const call of shellCalls) {
    const command = str(call.input['command']) ?? '';
    if (call.category === 'read') call.filePath = shellReadTarget(command, projectPath);
  }
  expandInPlace(turns, shellCalls, projectPath);

  const startedAt = firstTimestamp ?? new Date(0).toISOString();
  const session: Session = {
    id: sessionId,
    agent: 'codex',
    title: opts.title ?? null,
    projectPath,
    startedAt,
    endedAt: lastTimestamp ?? startedAt,
    turns,
    model,
    totalTokens,
  };
  return { session, skippedLines };
}

/** A tool result that arrived as content blocks rather than a plain string. */
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return str(value['output']) ?? str(value['content']) ?? '';
  return '';
}

/** Shell calls carry the meaning their command has, not the meaning of "shell". */
function categoryOfShell(command: string): ToolCategory {
  const kind = shellKind(command);
  if (kind === 'search' || kind === 'read') return 'read';
  if (kind === 'write') return 'write';
  return 'bash';
}

/** The file a read command was pointed at, for the file graph. */
function shellReadTarget(command: string, projectPath: string): string | null {
  const quoted = [...command.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? '');
  const bare = command.split(/\s+/).filter((t) => t.includes('/') || /\.\w+$/.test(t));
  for (const candidate of [...quoted, ...bare]) {
    if (candidate === '' || candidate.startsWith('-')) continue;
    const relative = relativizePath(candidate, projectPath);
    if (!relative.startsWith('/') && relative !== '' && /\.\w+$/.test(relative)) return relative;
  }
  return null;
}

/**
 * An exit code, read the way this repo already reads pass and fail.
 *
 * Only check commands decide pass/fail: `rg` exiting 1 means it found nothing,
 * which is an answer, not a failure. Marking it an error would put a red mark
 * on every fruitless search and let one into the debug chain.
 */
function outcomeOf(exitCode: number | null, call: ToolCall): ToolCall['outcome'] {
  if (exitCode === null) return 'unknown';
  if (exitCode === 0) return 'success';
  const command = str(call.input['command']) ?? '';
  if (exitCode === 1 && shellKind(command) === 'search') return 'success';
  return 'error';
}

/** Replace each shell call with the writes it made, followed by itself. */
function expandInPlace(turns: Turn[], shellCalls: ToolCall[], projectPath: string): void {
  const expansions = new Map<ToolCall, ToolCall[]>();
  for (const call of shellCalls) {
    const expanded = expandShellWrites(call, projectPath);
    if (expanded.length > 1) expansions.set(call, expanded);
  }
  if (expansions.size === 0) return;
  for (const turn of turns) {
    if (turn.toolCalls.some((call) => expansions.has(call))) {
      turn.toolCalls = turn.toolCalls.flatMap((call) => expansions.get(call) ?? [call]);
    }
  }
}

export async function parseCodexFile(
  filePath: string,
  title: string | null = null,
): Promise<ParsedSession> {
  const absPath = path.resolve(filePath);
  const jsonl = await readFile(absPath, 'utf8');
  return parseCodexJsonl(jsonl, { sessionId: sessionIdFromPath(absPath), title });
}

/** `rollout-2026-05-28T10-53-34-<uuid>.jsonl` — the id is embedded, not the name. */
export function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return uuid?.[1] ?? base;
}
