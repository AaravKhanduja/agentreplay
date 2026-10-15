# AgentReplay — agent guide

A local tool that reads Claude Code's session logs under `~/.claude/projects` and writes two self-contained files: `agentreplay.html` (the overview page) and `agentreplay-card.html` (a 1200×675 share card). One command: `python3 agentreplay.py`. MIT, fully local, standard library only. The session format is in `docs/session-jsonl-format.md`; the design spec is `design/DESIGN.md`, with reference renders beside it.

v1 is Claude Code only. The TypeScript per-session replay and the Codex parser are parked on the `v2-codex-parsers` branch.

## Commands

```sh
python3 -m unittest discover tests
python3 agentreplay.py --demo --no-open --out-dir /tmp/demo   # sample fixtures
python3 agentreplay.py --json                                 # real stats as JSON
```

## Layout

- `agentreplay.py`: discovery, parsing, metrics and rendering. It emits per-session rows, unioned time intervals, the year grid, streaks and PRs.
- `template.html`: both outputs. `mode` in the injected data picks the page or the card. The card is drawn on a 2× canvas (`drawCard`), so the card file and the copied PNG are the same pixels.
- The range switch recomputes the page from session rows in the browser (`stats()`), so there is one aggregation path, not two that can disagree.
- `fonts/`: Plex woff2, inlined as base64 at render time. The output must never fetch anything.

## Counting rules (all load-bearing)

- **Dedupe tokens by `message.id`, across all files.** One response is split over several lines with the same usage, and resumes and forks copy earlier records into a new file. Records are also deduped by `uuid`; the session whose file was created first owns copies. `<synthetic>` model records are not model calls.
- **A human prompt is a typed one.** Exclude tool-result carriers (`type: user` with `tool_result` content), `isMeta`, sidechains, compact summaries, `<command-name>` and `<local-command` wrappers, `[Request interrupted`, and anything whose `origin.kind` isn't `human` (task notifications).
- **Time.**
  - Gaps between consecutive user/assistant records count only up to 10 minutes (`IDLE_GAP_MS`).
  - A gap is Claude's if it ends in an assistant record, a tool result, a subagent record or a machine message, and yours if it ends in your prompt.
  - Intervals are unioned across sessions, and Claude's time wins an overlap, so agent + you = active.
- **Lines come from `toolUseResult.structuredPatch`.** A Write that creates a file counts its content. Fall back to the input's string newlines only when no patch exists. `.claude/` paths are the harness's, not the user's.
- **A declined call is not an error** (`DECLINED_RE`).
- **A PR counts only when its URL appears in the result.**
- **Days and hours are local time** (`--tz` overrides).
- **Degrade, never crash.** Bad lines are counted, unknown types are ignored, and an empty directory renders an empty state.

## Product rules

- **Only numbers the logs record.** No inference, no model, no generated prose. Sentences are fixed templates around computed numbers. Cost, outcomes, goals and "productivity" are out.
- **Every metric has a stated definition** in the README, and the page footer carries the time rules.
- **Never add telemetry or analytics. Permanent rule.** The pages make zero network requests. The only outbound links are ones the user clicks: PRs, the X intent, the repo.
- **Data goes in as text.** The template builds DOM with `h()` and `textContent`, never `innerHTML` with data. The JSON is injected with `</` and U+2028/2029 escaped.

## Design (see design/DESIGN.md)

- Ground `#141413`, text `#faf9f5`, accent clay `#d97757`.
  - The accent appears at most 3–4 times per screen: one bar per chart, the headline, the hour figures, the grid.
  - Cyan `#7cc4d6` is only for failure numbers (the MCP error rate).
- IBM Plex Mono for numbers and labels, Plex Sans for sentences. Second-person voice.
- No gradients, icons, emoji, or lowercase-everything.
- The year grid is always the last 12 months, using quantile opacity levels, with the longest streak outlined. The range switch never changes it.

## Out of scope for v1

/insights, Codex, Cursor, per-session replays, server-side PNG rendering, leaderboards and percentiles, any model-generated text, a hosted version, a local server.

Prefer boring code: clarity over cleverness, no premature abstraction, delete dead code.
