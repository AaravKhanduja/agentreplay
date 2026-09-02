# Claude Code session JSONL format

What AgentReplay actually parses. Verified against Claude Code v2.1.x session
files (`~/.claude/projects/<encoded-project-dir>/<session-uuid>.jsonl`). The
schema drifts between Claude Code versions — parse defensively, keep the raw
line, never crash on unknown fields or line types.

## File location

- Directory per project: `~/.claude/projects/` (respect `CLAUDE_CONFIG_DIR`;
  Windows: `%USERPROFILE%\.claude`).
- Directory names encode the project path with `/` → `-`:
  `-Users-dev-code-webshop` → `/Users/dev/code/webshop`. Note: `-` characters
  that were part of the original path are indistinguishable from separators;
  prefer the `cwd` field on events when available.
- One `.jsonl` file per session, named `<session-uuid>.jsonl`.

## Line envelope

Message lines share this envelope (extra fields are common; ignore them):

```jsonc
{
  "type": "user" | "assistant" | "system" | ...,
  "uuid": "…",
  "parentUuid": "…" | null,
  "timestamp": "2026-07-26T01:07:21.580Z",
  "cwd": "/Users/dev/code/webshop",       // project path — the reliable source
  "sessionId": "…",
  "version": "2.1.220",                   // Claude Code version
  "gitBranch": "HEAD",
  "isSidechain": false                    // true = subagent traffic — SKIP these
}
```

## Line types

### `user`

`message.content` is either a plain string or an array of blocks.

```jsonc
{ "type": "user",
  "message": { "role": "user", "content": "are you working" },
  "permissionMode": "default" | "plan" | ...,   // plan-mode signal
  "origin": { "kind": "human" } }               // typed by the human
```

Tool results ALSO arrive as `user` lines — a user line whose content array
contains `tool_result` blocks is a tool-result carrier, **not** a user turn:

```jsonc
{ "type": "user",
  "message": { "role": "user", "content": [
    { "type": "tool_result",
      "tool_use_id": "toolu_01JKN…",
      "content": "plain string OR [{ \"type\": \"text\", \"text\": \"…\" }]",
      "is_error": true }                        // present + true on failures
  ]},
  "toolUseResult": { /* structured result, tool-specific — e.g. Bash has
                        stdout/stderr; treat as unknown, useful for error
                        detection when present */ } }
```

### `assistant`

One API response can span several consecutive `assistant` lines that share
`message.id` (one line per content block). Merge them into a single logical
assistant turn.

```jsonc
{ "type": "assistant",
  "message": {
    "id": "msg_011CdPmpnDXXHXat7wfsEAMZ",       // same across the split lines
    "model": "claude-fable-5",
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "…", "signature": "…" },  // ignore
      { "type": "text", "text": "…" },
      { "type": "tool_use", "id": "toolu_01JKN…", "name": "Edit",
        "input": { "file_path": "…", "old_string": "…", "new_string": "…" } }
    ],
    "usage": { "input_tokens": 2, "output_tokens": 53, /* … */ }   // identical
      // across the split lines — count once per unique message.id
  } }
```

### Non-message lines — skip silently (not "malformed")

`summary`, `system` (e.g. `subtype: "turn_duration"`), `mode`,
`permission-mode` (`{"type":"permission-mode","permissionMode":"plan"}` —
plan-mode signal), `file-history-snapshot`, `ai-title`, `attachment`,
`last-prompt`, `queued-prompt`, and any unknown `type`.

## Parsing rules (normative for @agentreplay/core)

1. A line that fails `JSON.parse` or has no usable shape → count as skipped,
   continue. Unknown-but-valid line types are skipped WITHOUT counting.
2. Skip `isSidechain: true` lines entirely (subagent chatter).
3. User turn = `user` line with string content or text blocks and no
   `tool_result` blocks.
4. Consecutive `assistant` lines merge into one `Turn` until a user turn
   appears; `tool_use` blocks become `ToolCall`s on that turn.
5. Match `tool_use` → `tool_result` by id; orphaned calls get
   `outcome: 'unknown'`. `durationMs` = result timestamp − call timestamp.
6. Error detection: `is_error: true` on the tool_result block; for Bash also
   scan result text for `/error|failed|exception|traceback|panic/i`.
7. Plan mode: a turn is `planMode: true` if the most recent
   `permission-mode` line (or `permissionMode` field) said `plan`.
8. `model` = first assistant `message.model`; `totalTokens` = sum of
   `usage.output_tokens` + `usage.input_tokens` counted once per `message.id`.
9. File paths: take `file_path` / `path` / `notebook_path` from tool input,
   normalize relative to the project path (from `cwd`).
