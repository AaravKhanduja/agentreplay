/**
 * Claude Code session JSONL → Session.
 *
 * Parsing rules follow docs/session-jsonl-format.md. The schema drifts
 * between Claude Code versions, so everything here is defensive: malformed
 * lines are counted and skipped, unknown line types are skipped silently,
 * and no field is trusted to exist or have the expected type.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectDir } from './discover.js';
import type { ParsedSession, Session, ToolCall, ToolCategory, Turn } from './types.js';

const INPUT_STRING_MAX = 4000;
const ERROR_TEXT_MAX = 500;
/** Silence between two tool calls that ends an assistant turn (approval wait, or a break). */
const IDLE_SPLIT_MS = 10 * 60_000;
const RESULT_PREVIEW_MAX = 300;

/** Bash results without an is_error flag still count as failures when the output reads like one. */
const BASH_ERROR_RE = /error|failed|exception|traceback|panic/i;
/**
 * The developer declined the call. It never executed, so it is neither a
 * success nor a failure — and treating it as a failure made a row of permission
 * prompts look like the same error hit nine times.
 */
const DECLINED_RE = /(user doesn't want to proceed|tool use was rejected|user rejected|operation was aborted by the user)/i;

const CATEGORY_BY_TOOL: Record<string, ToolCategory> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  WebFetch: 'read',
  WebSearch: 'read',
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
};

function toolCategory(name: string): ToolCategory {
  return CATEGORY_BY_TOOL[name] ?? 'meta';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-truncate string values so huge Edit inputs don't bloat the artifact. */
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
  // Paths outside the project stay absolute — a "../../.." path helps nobody.
  return rel === '' || rel.startsWith('..') ? filePath : rel;
}

function extractFilePath(input: Record<string, unknown>, projectPath: string): string | null {
  // `path` is deliberately excluded: on Grep/Glob/LS it names a search-root
  // directory, which would pollute the file graph with directory nodes.
  for (const key of ['file_path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return relativizePath(value, projectPath);
  }
  return null;
}

/** Text of a tool_result block: plain string or an array of text blocks. */
function toolResultText(block: Record<string, unknown>): string {
  const content = block['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
      .map((b) => b['text'] as string)
      .join('\n');
  }
  return '';
}

export function parseSessionJsonl(
  jsonl: string,
  opts: { sessionId: string; projectPathHint?: string },
): ParsedSession {
  let skippedLines = 0;
  const events: Record<string, unknown>[] = [];

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue; // blank/trailing lines aren't malformed
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      skippedLines += 1; // valid JSON but no usable shape
      continue;
    }
    if (parsed['isSidechain'] === true) continue; // subagent chatter
    events.push(parsed);
  }

  // The events' cwd is the reliable project path; the directory-name hint is
  // ambiguous ("-" separators vs "-" in the original path).
  let projectPath = opts.projectPathHint ?? '';
  for (const event of events) {
    const cwd = event['cwd'];
    if (typeof cwd === 'string' && cwd !== '') {
      projectPath = cwd;
      break;
    }
  }

  const turns: Turn[] = [];
  /**
   * Open assistant turn. Consecutive assistant lines merge into it until a real
   * user turn — or until the work visibly changes character: leaving plan mode,
   * or a long wait between tool calls. Without those seams a single assistant
   * turn can hold hours of work and dozens of calls, and since phases are cut
   * at turn boundaries the whole stretch collapses into one mislabeled phase.
   */
  let currentAssistant: Turn | null = null;
  const pendingCalls = new Map<string, ToolCall>();
  let inPlanMode = false;
  let model: string | null = null;
  let totalTokens: number | null = null;
  const countedMessageIds = new Set<string>();
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  const applyToolResult = (block: Record<string, unknown>, resultTimestamp: string): void => {
    const toolUseId = block['tool_use_id'];
    if (typeof toolUseId !== 'string') return;
    const call = pendingCalls.get(toolUseId);
    if (call === undefined) return; // result for a call we never saw
    pendingCalls.delete(toolUseId);

    const callMs = Date.parse(call.timestamp);
    const resultMs = Date.parse(resultTimestamp);
    if (!Number.isNaN(callMs) && !Number.isNaN(resultMs)) call.durationMs = resultMs - callMs;

    const text = toolResultText(block);
    if (DECLINED_RE.test(text)) {
      call.outcome = 'unknown';
      call.resultPreview = text.slice(0, RESULT_PREVIEW_MAX);
      return;
    }
    const isError =
      block['is_error'] === true || (call.name === 'Bash' && BASH_ERROR_RE.test(text));
    if (isError) {
      call.outcome = 'error';
      call.errorText = text.slice(0, ERROR_TEXT_MAX);
    } else {
      call.outcome = 'success';
    }
    call.resultPreview = text.slice(0, RESULT_PREVIEW_MAX);
  };

  for (const event of events) {
    const type = event['type'];

    if (type === 'permission-mode') {
      inPlanMode = event['permissionMode'] === 'plan';
      continue;
    }
    if (type !== 'user' && type !== 'assistant') continue; // known/unknown non-message lines

    const timestamp = typeof event['timestamp'] === 'string' ? event['timestamp'] : '';
    if (timestamp !== '') {
      if (firstTimestamp === null) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }

    const message = isRecord(event['message']) ? event['message'] : null;

    if (type === 'user') {
      if (typeof event['permissionMode'] === 'string') {
        inPlanMode = event['permissionMode'] === 'plan';
      }
      if (message === null) continue;
      const content = message['content'];
      const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

      const resultBlocks = blocks.filter((b) => b['type'] === 'tool_result');
      if (resultBlocks.length > 0) {
        // Tool-result carrier, not a user turn.
        for (const block of resultBlocks) applyToolResult(block, timestamp);
        continue;
      }

      let text: string;
      if (typeof content === 'string') {
        text = content;
      } else {
        const textBlocks = blocks.filter(
          (b) => b['type'] === 'text' && typeof b['text'] === 'string',
        );
        if (textBlocks.length === 0) continue; // no usable user content
        text = textBlocks.map((b) => b['text'] as string).join('\n');
      }

      turns.push({ role: 'user', timestamp, text, toolCalls: [], planMode: inPlanMode });
      currentAssistant = null;
      continue;
    }

    // assistant
    if (message === null) continue;

    if (model === null && typeof message['model'] === 'string') model = message['model'];

    // A long silence between tool calls is a seam: an approval wait, or the
    // developer stepping away. Cut the turn there so the work either side can
    // be classified separately.
    if (currentAssistant !== null && timestamp !== '') {
      const previous = currentAssistant.toolCalls[currentAssistant.toolCalls.length - 1];
      if (previous !== undefined) {
        const gap = Date.parse(timestamp) - Date.parse(previous.timestamp);
        if (Number.isFinite(gap) && gap >= IDLE_SPLIT_MS) currentAssistant = null;
      }
    }

    // One API response spans several lines sharing message.id, each repeating
    // the same usage object — count tokens once per id.
    const messageId = typeof message['id'] === 'string' ? message['id'] : null;
    const usage = isRecord(message['usage']) ? message['usage'] : null;
    if (usage !== null && messageId !== null && !countedMessageIds.has(messageId)) {
      countedMessageIds.add(messageId);
      const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
      const output = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
      totalTokens = (totalTokens ?? 0) + input + output;
    }

    if (currentAssistant === null) {
      currentAssistant = {
        role: 'assistant',
        timestamp,
        text: '',
        toolCalls: [],
        planMode: inPlanMode,
      };
      turns.push(currentAssistant);
    }

    const appendText = (text: string): void => {
      if (text === '') return;
      if (currentAssistant === null) return;
      currentAssistant.text =
        currentAssistant.text === '' ? text : `${currentAssistant.text}\n\n${text}`;
    };

    let exitedPlan = false;
    const content = message['content'];
    if (typeof content === 'string') {
      appendText(content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content.filter(isRecord)) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        appendText(block['text']);
      } else if (block['type'] === 'tool_use') {
        const id = typeof block['id'] === 'string' ? block['id'] : '';
        const name = typeof block['name'] === 'string' ? block['name'] : 'unknown';
        const input = isRecord(block['input'])
          ? (truncateStrings(block['input']) as Record<string, unknown>)
          : {};
        const call: ToolCall = {
          id,
          name,
          category: toolCategory(name),
          timestamp,
          durationMs: null,
          input,
          filePath: extractFilePath(input, projectPath),
          outcome: 'unknown',
          errorText: null,
          resultPreview: null,
        };
        currentAssistant.toolCalls.push(call);
        if (id !== '') pendingCalls.set(id, call);
        // Approving a plan ends the planning, mid-turn. Everything after it is
        // execution and must not inherit the plan label.
        if (name === 'ExitPlanMode') {
          inPlanMode = false;
          exitedPlan = true;
        }
      }
      // thinking / anything else: ignored
    }

    if (exitedPlan) {
      currentAssistant = null;
      exitedPlan = false;
    }
  }

  const startedAt = firstTimestamp ?? new Date(0).toISOString();
  const session: Session = {
    id: opts.sessionId,
    projectPath,
    startedAt,
    endedAt: lastTimestamp ?? startedAt,
    turns,
    model,
    totalTokens,
  };
  return { session, skippedLines };
}

export async function parseSessionFile(filePath: string): Promise<ParsedSession> {
  const absPath = path.resolve(filePath);
  const jsonl = await readFile(absPath, 'utf8');
  const sessionId = path.basename(absPath).replace(/\.jsonl$/i, '');
  const projectPathHint = decodeProjectDir(path.basename(path.dirname(absPath)));
  return parseSessionJsonl(jsonl, { sessionId, projectPathHint });
}
