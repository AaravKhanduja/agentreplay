/**
 * Shell commands that edit files, expanded into the calls the heuristics read.
 *
 * An agent with no edit tool does all its editing through the shell, and even
 * one that has edit tools reaches for a heredoc sometimes. Either way the edit
 * is invisible: `category` is 'bash', `filePath` is null, so `files.ts` builds
 * no node for it, `diffs.ts` records no attempt, and — the expensive one —
 * `loops.ts` never starts a debug loop, because a loop begins at a write with a
 * path. A session that edited and re-ran a test twenty times reads as clean.
 *
 * The fix is to say what happened in the vocabulary the rest of the code
 * already speaks, at the one place allowed to know a source's shapes.
 */

import { applyPatchWrites, shellWrites } from './checks.js';
import type { ShellWrite } from './checks.js';
import type { ToolCall } from './types.js';

/**
 * A shell call, followed by one write call per file it edited.
 *
 * The order is the whole point, and it is the opposite of what it first looks
 * like. `loops.ts` finds a write and scans *forward* for the next bash call to
 * decide whether the fix held. Put the writes first and the very next bash call
 * is the editing command itself — `apply_patch` reporting its own success — so
 * every debug loop closes green on the edit instead of on the test that follows
 * it, and a session that fought an error for an hour shows no failing loops.
 * Emitting them after leaves the real check as the next bash call, which is
 * exactly the shape `loops.ts` was written for.
 *
 * The timestamps are identical either way, so nothing else can tell.
 */
export function expandShellWrites(call: ToolCall, projectPath: string): ToolCall[] {
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : '';
  if (command === '') return [call];

  const writes = shellWrites(command, projectPath);
  if (writes.length === 0) return [call];

  // The command itself goes back to being a command: the synthetic calls are
  // the edit now, and leaving it a write would count the same change twice.
  return [{ ...call, category: 'bash' }, ...writeCalls(call, writes, commandName(command))];
}

/**
 * The same expansion for an agent that files a patch as a tool call.
 *
 * Codex has an `apply_patch` tool whose whole argument is the patch document,
 * so the edit never passes through a shell command and `expandShellWrites`
 * cannot see it. Everything after this point is identical: one write call per
 * file, emitted after the call that made them, for the reason above.
 *
 * The parent keeps its own name and stops being a write. It is still a call the
 * agent made — one call that changed three files is one action and three
 * changes — so the header counts it and the synthetic writes carry the files.
 */
export function expandPatchWrites(call: ToolCall, patch: string, projectPath: string): ToolCall[] {
  if (patch === '') return [call];

  // The patch text is passed in rather than read off the call: what the call
  // carries is truncated to keep the artifact small, and a patch cut at 4000
  // characters loses whichever files it names after that.
  const writes = applyPatchWrites(patch, projectPath);
  if (writes.length === 0) return [call];

  return [{ ...call, category: 'meta' }, ...writeCalls(call, writes, call.name)];
}

/** One write call per file, sharing the timestamp and outcome of the call that made them. */
function writeCalls(call: ToolCall, writes: ShellWrite[], name: string): ToolCall[] {
  return writes.map((write, i): ToolCall => ({
    // Suffixed so ids stay unique; nothing pairs a result to these.
    id: call.id === '' ? '' : `${call.id}#w${i}`,
    // What ran is the truth. Naming it 'Edit' would be a tidier lie, and the
    // evidence drawer shows this name to the reader.
    name,
    category: 'write',
    timestamp: call.timestamp,
    durationMs: null,
    // The shape `extractDiff` reads, so no heuristic needs a shell branch.
    input: { ...call.input, ...editInput(write.edits) },
    filePath: write.path,
    outcome: call.outcome,
    errorText: call.errorText,
    resultPreview: call.resultPreview,
    synthetic: true,
  }));
}

/**
 * What to call the command in the drawer.
 *
 * The first token is usually the program, but a command may open with
 * environment assignments (`VAR=1 sed -i …`) or a variable it sets for itself,
 * and taking token zero then showed the reader a tool named `tmpfile=$(mktemp)`.
 * Skip the assignments and name the program; when the line is nothing but
 * assignments there is no program to name, so say `shell` and stop.
 */
function commandName(command: string): string {
  for (const token of command.trim().split(/\s+/)) {
    if (token === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token;
  }
  return 'shell';
}

/** One pair is an Edit; several are a MultiEdit. Both shapes already decode. */
function editInput(edits: Array<{ oldText: string; newText: string }>): Record<string, unknown> {
  const first = edits[0];
  if (first === undefined) return {};
  if (edits.length === 1) return { old_string: first.oldText, new_string: first.newText };
  return { edits: edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })) };
}
