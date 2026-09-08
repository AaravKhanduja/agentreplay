/**
 * Codex CLI rollout JSONL → Session.
 *
 * Format in `docs/codex-rollout-format.md`. Every line is
 * `{timestamp, type, payload}`, and the first is always `session_meta`.
 *
 * The one rule worth stating up front: **message text comes from `event_msg`,
 * tool calls come from `response_item`.** The two overlap — a user's prompt
 * appears as both an `event_msg` message (`messages.ts` knows its two
 * spellings) and a `response_item/message` with role 'user' — but the
 * `response_item` copy also carries the injected
 * AGENTS.md preamble and the permissions instructions, which nobody typed.
 * Reading both would double every turn; reading the wrong one would put a
 * system preamble in the replay's title and its opening request.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { shellKind } from '../../checks.js';
import { expandPatchWrites, expandShellWrites } from '../../shellcalls.js';
import type { ParsedSession, Session, ToolCall, ToolCategory, Turn } from '../../types.js';
import { codexMessage } from './messages.js';

const INPUT_STRING_MAX = 4000;
const ERROR_TEXT_MAX = 500;
const RESULT_PREVIEW_MAX = 300;
/** Silence between two tool calls that ends an assistant turn. */
const IDLE_SPLIT_MS = 10 * 60_000;
/**
 * The developer refused the patch, so it never applied. Neither a success nor a
 * failure — the same rule the Claude reader applies to a declined tool call, and
 * for the same reason: a row of refusals is not a row of bugs.
 */
const DECLINED_RE = /(rejected by user|aborted by the user|user rejected|user denied)/i;

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

/**
 * Everything Codex is known to write, as `type` or `type/payload.type`.
 *
 * This is the reader's vocabulary, not its dispatch table: some of these are
 * read, some are deliberately ignored (the `response_item/message` copies of
 * the conversation, `reasoning`, turn boundaries the phases derive themselves,
 * the searches and compaction notices nothing downstream asks about). What
 * matters is that anything *outside* the set is new since this was written,
 * and gets counted rather than passing in silence — which is how the move to
 * `item_completed` went unnoticed while it emptied the picker.
 */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  'session_meta',
  'turn_context',
  'compacted',
  'event_msg/item_completed',
  'event_msg/user_message',
  'event_msg/agent_message',
  'event_msg/task_started',
  'event_msg/task_complete',
  'event_msg/token_count',
  'event_msg/patch_apply_begin',
  'event_msg/patch_apply_end',
  'event_msg/turn_aborted',
  'event_msg/error',
  'response_item/message',
  'response_item/reasoning',
  'response_item/function_call',
  'response_item/function_call_output',
  'response_item/custom_tool_call',
  'response_item/custom_tool_call_output',
  'response_item/web_search_call',
  'response_item/tool_search_call',
  'response_item/tool_search_output',
]);

/**
 * The `item.type`s inside `item_completed`. The two messages are read; the
 * rest are ignored because the same fact arrives as a `response_item` the
 * parser already reads — a FileChange beside its `custom_tool_call`, a Plan
 * beside its `update_plan`. A kind not listed here is new.
 */
const KNOWN_ITEMS: ReadonlySet<string> = new Set([
  'UserMessage',
  'AgentMessage',
  'FileChange',
  'WebSearch',
  'McpToolCall',
  'Plan',
  'ContextCompaction',
]);

/** The shape's name in the tally, or null when the reader knows it. */
function unknownShape(type: string, payload: Record<string, unknown>): string | null {
  const payloadType = typeof payload['type'] === 'string' ? payload['type'] : null;
  const shape = payloadType === null ? type : `${type}/${payloadType}`;
  if (!KNOWN_EVENTS.has(shape)) return shape;
  if (payloadType !== 'item_completed') return null;
  const item = isRecord(payload['item']) ? payload['item'] : null;
  const itemType = item !== null && typeof item['type'] === 'string' ? item['type'] : null;
  if (itemType === null || KNOWN_ITEMS.has(itemType)) return null;
  return `${shape}/${itemType}`;
}

export function parseCodexJsonl(
  jsonl: string,
  opts: { sessionId: string; projectPathHint?: string; title?: string | null },
): ParsedSession {
  let skippedLines = 0;
  /** Shapes this reader has no name for — drift, counted instead of dropped. */
  const unknownEvents: Record<string, number> = {};
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
  /** Patch calls, with the untruncated document each one filed. */
  const patchText = new Map<ToolCall, string>();
  const patchById = new Map<string, ToolCall>();
  /** Calls whose result `patch_apply_end` already reported, in more detail. */
  const settled = new Set<ToolCall>();
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

    if (typeof type === 'string') {
      const unknown = unknownShape(type, payload);
      if (unknown !== null) unknownEvents[unknown] = (unknownEvents[unknown] ?? 0) + 1;
    }

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
      // Both spellings of a message, old and new, resolve in one place.
      const message = codexMessage(payload);
      if (message !== null) {
        if (message.role === 'user') {
          turns.push({ role: 'user', timestamp, text: message.text, toolCalls: [], planMode: false });
          currentAssistant = null;
        } else {
          const turn = openAssistant(timestamp);
          turn.text = turn.text === '' ? message.text : `${turn.text}\n\n${message.text}`;
        }
        continue;
      }
      if (payloadType === 'patch_apply_end') {
        // The authoritative result of a patch: which files, and whether it took.
        const call = patchById.get(str(payload['call_id']) ?? '');
        if (call === undefined) continue;
        const stderr = str(payload['stderr']) ?? '';
        call.outcome =
          payload['success'] === true ? 'success' : DECLINED_RE.test(stderr) ? 'unknown' : 'error';
        if (call.outcome === 'error') call.errorText = stderr.slice(0, ERROR_TEXT_MAX);
        call.resultPreview = (str(payload['stdout']) ?? stderr).slice(0, RESULT_PREVIEW_MAX);
        settled.add(call);
        continue;
      }
      if (payloadType === 'turn_aborted') {
        // The developer stopped the agent mid-run. Whatever happens next is a
        // new stretch of work, and phases are cut at turn boundaries.
        currentAssistant = null;
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

    if (payloadType === 'custom_tool_call') {
      // Not JSON arguments: the whole input is the patch document itself.
      const name = str(payload['name']) ?? 'unknown';
      const callId = str(payload['call_id']) ?? '';
      const patch = str(payload['input']) ?? '';
      const call: ToolCall = {
        id: callId,
        name,
        // The write is the per-file call this expands into, not the call itself.
        category: 'meta',
        timestamp,
        durationMs: null,
        input: { patch: truncateStrings(patch) as string },
        filePath: null,
        outcome: 'unknown',
        errorText: null,
        resultPreview: null,
      };
      openAssistant(timestamp).toolCalls.push(call);
      if (callId !== '') {
        pendingCalls.set(callId, call);
        patchById.set(callId, call);
      }
      patchText.set(call, patch);
      continue;
    }

    if (payloadType === 'web_search_call') {
      const action = isRecord(payload['action']) ? payload['action'] : {};
      const query = str(action['query']);
      const url = str(action['url']);
      openAssistant(timestamp).toolCalls.push({
        id: str(payload['id']) ?? '',
        name: 'web_search',
        // Reading is reading whatever tool carried it.
        category: 'read',
        timestamp,
        durationMs: null,
        input: query !== null ? { query } : url !== null ? { url } : {},
        filePath: null,
        outcome: str(payload['status']) === 'completed' ? 'success' : 'unknown',
        errorText: null,
        resultPreview: null,
      });
      continue;
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = str(payload['call_id']) ?? '';
      const call = pendingCalls.get(callId);
      if (call === undefined) continue;
      pendingCalls.delete(callId);

      const callMs = Date.parse(call.timestamp);
      const resultMs = Date.parse(timestamp);
      if (!Number.isNaN(callMs) && !Number.isNaN(resultMs)) call.durationMs = resultMs - callMs;

      // A patch reported its own result already, and said more than this line does.
      if (settled.has(call)) continue;

      const rawOutput = str(payload['output']) ?? outputText(payload['output']);
      const { exitCode, body } = readOutput(rawOutput);
      call.outcome = outcomeOf(exitCode, call);
      if (call.outcome === 'error') call.errorText = body.slice(0, ERROR_TEXT_MAX);
      call.resultPreview = body.slice(0, RESULT_PREVIEW_MAX);
      continue;
    }
  }

  // Paths and shell edits are resolved once the project root is known and the
  // outcomes have landed: a synthetic write copies the outcome of its command.
  for (const call of shellCalls) {
    const command = str(call.input['command']) ?? '';
    if (call.category === 'read') call.filePath = shellReadTarget(command, projectPath);
  }

  const expansions = new Map<ToolCall, ToolCall[]>();
  for (const call of shellCalls) {
    const expanded = expandShellWrites(call, projectPath);
    if (expanded.length > 1) expansions.set(call, expanded);
  }
  for (const [call, patch] of patchText) {
    const expanded = expandPatchWrites(call, patch, projectPath);
    if (expanded.length > 1) expansions.set(call, expanded);
  }
  applyExpansions(turns, expansions);

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
  return { session, skippedLines, unknownEvents };
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

/** Swap each call that edited files for itself followed by one write per file. */
function applyExpansions(turns: Turn[], expansions: Map<ToolCall, ToolCall[]>): void {
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
