# Codex CLI rollout format

What AgentReplay reads when it replays a Codex session, and the three places
where reading it naively produces a confident wrong answer rather than an
empty one. Everything here was checked against a real 90-session corpus.

The Claude Code equivalent is [session-jsonl-format.md](session-jsonl-format.md).

## Where sessions live

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
~/.codex/session_index.jsonl        # {id, thread_name, updated_at} per session
```

`CODEX_HOME` overrides `~/.codex`.

Two consequences of the date-based layout. The session id is *embedded* in the
filename rather than being the filename, so it is parsed out. And a rollout's
neighbours are that day's sessions across every unrelated repo — which is why
AgentReplay does not compute cross-session file reads for Codex, where for
Claude Code (one directory per project) it does.

`session_index.jsonl` gives every thread a name. It becomes the replay's title,
and it is better than anything derivable from the opening message.

## Line shape

Every line is `{timestamp, type, payload}`. The first line is always
`session_meta`.

| `type` | `payload.type` | What it carries |
|---|---|---|
| `session_meta` | — | `id`, `cwd`, `cli_version`, `model_provider`, `git` |
| `turn_context` | — | `turn_id`, `cwd`, `model`, `effort`, `approval_policy` |
| `event_msg` | `item_completed` | A finished item — the kind is `item.type`; see trap 5 |
| `event_msg` | `user_message` | Older spelling: what the developer typed, in `message` |
| `event_msg` | `agent_message` | Older spelling: what the agent said, in `message` |
| `event_msg` | `task_started` / `task_complete` | Turn boundaries, with `turn_id` |
| `event_msg` | `token_count` | `info.total_token_usage`, cumulative |
| `response_item` | `function_call` | `name`, `call_id`, `arguments` (a JSON string) |
| `response_item` | `function_call_output` | `call_id`, `output` (a string) |
| `response_item` | `custom_tool_call` | `name`, `call_id`, `input` — **not** JSON; see below |
| `response_item` | `custom_tool_call_output` | `call_id`, `output` (a string) |
| `response_item` | `web_search_call` | `status`, `action.query` or `action.url` |
| `response_item` | `message` | The model's view of the conversation |
| `response_item` | `reasoning` | Ignored — `summary` is empty and `encrypted_content` is opaque |
| `event_msg` | `patch_apply_end` | `call_id`, `success`, `stdout`, `stderr`, `changes` |
| `event_msg` | `turn_aborted` | `reason` (`"interrupted"`), `duration_ms` |

`session_meta.model_provider` is `"openai"`, not a model name. The model name
(`gpt-5.5`) is on `turn_context`.

## Five traps

**1. Message text comes from `event_msg`, tool calls from `response_item`.**

The two overlap: a prompt appears both as `event_msg/user_message` and as
`response_item/message` with role `user`. But the `response_item` copy also
carries the injected AGENTS.md preamble and a `<permissions instructions>`
block, neither of which anyone typed. Reading both doubles every turn; reading
only the `response_item` copy puts a system preamble into the replay's title,
its opening request, and every plan's trigger text — the most visible line on
the page.

A caveat on the first two rows: current Codex versions write neither. Both are
the old spelling of trap 5.

**2. Edits arrive as `custom_tool_call`, not `function_call`.**

Every edit Codex makes is an `apply_patch` call, and `apply_patch` is the only
`custom_tool_call` there is. A reader that handles `function_call` alone sees a
session that read a great deal and changed nothing — and because a debug loop
begins at a write with a path, it also sees no stuck runs, no breakthroughs, and
an execute phase classified as exploration. Measured against 90 real rollouts,
handling it took the corpus from 1 session with writes to 18, from 2 edit
attempts to 279, and from 0 debug loops to 37.

Two details make it its own case. `input` is the patch document itself, not a
JSON argument string, so it is read directly rather than `JSON.parse`d. And the
document can run past the parser's 4000-character input cap, so it is parsed in
full before the copy kept on the call is truncated — truncate first and the
patch loses whichever files it names after the cut.

The result comes back on `event_msg/patch_apply_end`, keyed by the same
`call_id`: `success`, and `changes` mapping each absolute path to `update` (with
a `unified_diff`), `add` or `delete` (with `content`). A refused patch arrives as
`success: false` with `stderr: "patch rejected by user"` — a decline, so the call
is `outcome: 'unknown'`, never an error.

**3. Tool output is wrapped, and the wrapper is unique per call.**

```
Chunk ID: 6e0ed1
Wall time: 0.4210 seconds
Process exited with code 0
Original token count: 16
Output:
<the actual output>
```

`errorSignature` in `loops.ts` reads the *first line* of an error to decide
whether two failures are the same failure. Leave this header in place and the
`Chunk ID` makes every signature unique: no stuck run is ever detected, no
breakthrough is ever found, and a session that fought one error for two hours
reports as clean. The parser strips the header and keeps the exit code.

The exit code is exact, so Codex never needs the heuristic that scans output
for words like "error". One refinement: `rg` exiting 1 means it matched
nothing, which is an answer rather than a failure, so a search exiting 1 is
recorded as a success.

**4. Almost everything else is `exec_command`.**

Across 90 real sessions: `exec_command` 6,565, `write_stdin` 481,
`apply_patch` 301, `update_plan` 17, and a long tail in single digits. There is
no Read, Grep, Edit or Write tool — reads and searches are all shell strings,
and so are the edits that do not go through `apply_patch`.

So a call's category is derived from what its command does (`shellKind` in
`checks.ts`), and an edit made with a `cat`/`tee` heredoc, `sed -i`, `git apply`
or `patch` becomes a real write call with a diff (`shellWrites`, then
`expandShellWrites`); a patch filed as a tool call takes the same road one step
later (`applyPatchWrites`, then `expandPatchWrites`), so the `*** Begin Patch`
format has one parser rather than one per delivery mechanism. Without any of
that there is no write with a path, so `loops.ts` can never start a debug loop
and the header reports "0 files changed" for a session that rewrote the repo.

An interpreter heredoc (`python3 - <<'PY'`) writes whatever the script decides
and is deliberately not guessed at. `write_stdin` is input to a running
process, not a write.

**5. The kind of a message moved, and both spellings are alive.**

Older versions put it on the payload, with the text in `message`:

```json
{ "type": "event_msg",
  "payload": { "type": "user_message", "message": "the signature check rejects valid webhooks" } }
```

Current versions wrap it in `item_completed` and move the kind one level down,
into `item.type`, spelled differently — with the text in `item.content`, a list
of blocks rather than a string:

```json
{ "type": "event_msg",
  "payload": { "type": "item_completed",
               "item": { "type": "UserMessage",
                         "content": [{ "type": "text", "text": "…" }] } } }
```

`item.type` is `UserMessage`, `AgentMessage` or `FileChange`. The last is a
patch result, and is ignored: the same edit already arrives as a
`custom_tool_call` (trap 2), which is where the diff is read from.

Inside `content`, take any block carrying a string `text`. Do **not** filter on
the block's own `type`: a user's blocks are typed `text` and an agent's `Text`,
so filtering drops one side of the conversation and looks half-working.

A sessions directory holds both spellings, so both are read —
`sources/codex/messages.ts` is the only place that decides, because this was
written down twice before and the copies drifted apart.

## `update_plan`

```json
{"plan": [{"step": "Inspect the CMS services", "status": "in_progress"}],
 "explanation": "Updated per your latest direction: ..."}
```

Rendered into the numbered document that `planText` reads, so plan revisions
need no agent-specific branch. Step strings survive a revision verbatim, which
means the step diff is exact — kept, added and removed — where a prose plan
churns into removed+added because no two drafts phrase a step the same way.

`explanation` is the session's own words for why the plan moved.

It is rare: 17 calls across 90 sessions. Useful when present, never something
to build phase classification on.

## What has no equivalent

Codex has no plan mode, so `Turn.planMode` is always false and a replay has no
plan phase unless the session used `update_plan`. The closest structural
analogue to leaving plan mode is a `turn_context` whose `cwd` or
`approval_policy` changed, and the parser cuts a turn there. An
`event_msg/turn_aborted` is cut on too: the developer stopped the run, so what
follows is a new stretch of work.

`turn_id` looks like it should give turn boundaries outright, and it does not:
across 90 real rollouts it is absent from 81% of `function_call` payloads, so
reading it instead of the idle heuristic would merge every turn whose calls
happen not to carry one.
