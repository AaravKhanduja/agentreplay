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
| `event_msg` | `user_message` | What the developer typed, in `message` |
| `event_msg` | `agent_message` | What the agent said, in `message` |
| `event_msg` | `task_started` / `task_complete` | Turn boundaries, with `turn_id` |
| `event_msg` | `token_count` | `info.total_token_usage`, cumulative |
| `response_item` | `function_call` | `name`, `call_id`, `arguments` (a JSON string) |
| `response_item` | `function_call_output` | `call_id`, `output` (a string) |
| `response_item` | `message` | The model's view of the conversation |
| `response_item` | `reasoning` | Ignored |

`session_meta.model_provider` is `"openai"`, not a model name. The model name
(`gpt-5.5`) is on `turn_context`.

## Three traps

**1. Message text comes from `event_msg`, tool calls from `response_item`.**

The two overlap: a prompt appears both as `event_msg/user_message` and as
`response_item/message` with role `user`. But the `response_item` copy also
carries the injected AGENTS.md preamble and a `<permissions instructions>`
block, neither of which anyone typed. Reading both doubles every turn; reading
only the `response_item` copy puts a system preamble into the replay's title,
its opening request, and every plan's trigger text — the most visible line on
the page.

**2. Tool output is wrapped, and the wrapper is unique per call.**

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

**3. Everything is `exec_command`.**

Across 90 real sessions: `exec_command` 6,565, `write_stdin` 481,
`update_plan` 17, and a long tail in single digits. There is no Read, Grep,
Edit or Write tool — reads, searches **and file edits** are all shell strings.

So a call's category is derived from what its command does (`shellKind` in
`checks.ts`), and an edit made with `apply_patch`, a `cat`/`tee` heredoc,
`sed -i`, `git apply` or `patch` becomes a real write call with a diff
(`shellWrites`, then `expandShellWrites`). Without that there is no write with
a path, so `loops.ts` can never start a debug loop and the header reports
"0 files changed" for a session that rewrote the repo.

An interpreter heredoc (`python3 - <<'PY'`) writes whatever the script decides
and is deliberately not guessed at. `write_stdin` is input to a running
process, not a write.

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
`approval_policy` changed, and the parser cuts a turn there.
