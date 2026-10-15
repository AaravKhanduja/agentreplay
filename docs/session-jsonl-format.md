# Claude Code session JSONL format

> Claude Code's format. (The Codex CLI rollout format is documented on the
> `v2-codex-parsers` branch.)

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

## Parsing rules (normative for agentreplay.py)

1. Read `projects/<dir>/<session>.jsonl` and every
   `projects/<dir>/<session>/subagents/*.jsonl`; subagent files belong to the
   session named by their directory.
2. A line that fails `json.loads` or isn't an object is counted as skipped.
   Unknown-but-valid types are ignored without counting. Nothing crashes.
3. Resumes and forks copy earlier records, timestamps and ids intact, into the
   new file (rewriting `sessionId`). Dedupe records by `uuid` and assistant
   messages by `message.id` across all files; the session whose file was
   created first owns the copies.
4. Tokens = `input_tokens + output_tokens + cache_creation_input_tokens +
   cache_read_input_tokens`, once per `message.id`. Skip model `<synthetic>`.
5. A human prompt is a `user` line with no `tool_result` blocks, not
   `isMeta`, not `isSidechain`, not `isCompactSummary`, whose `origin.kind`
   (when present) is `human`, and whose text isn't a `<command-name>`,
   `<local-command…>`, `<task-notification>` or `[Request interrupted` line.
6. Match `tool_use` to `tool_result` by id. A result matching the decline
   pattern (`user doesn't want to proceed`, `tool use was rejected`, …) is
   declined, never an error; otherwise `is_error: true` is an error.
7. Lines written/removed come from `toolUseResult.structuredPatch` hunk lines
   (`+`/`-`); `toolUseResult.type == "create"` counts its `content`. Only when
   neither is present, count newlines in the tool input. Paths under `.claude/`
   are excluded.
