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

- **Two sources.** Claude Code deletes transcripts 30 days after last activity (`cleanupPeriodDays`), so `history.jsonl` (one line per typed prompt, never cleaned) carries the year: sessions, projects, grid, streak, heatmap. Slash commands and exact repeats are dropped. Transcripts carry the detail, counted only from `detailSince`, which is the oldest surviving session's last-activity day. From that day on every session survives, so detail is complete there. Every detail label says "since <day>" when the range reaches further back. With no history file, transcripts are the only source.

- **Dedupe tokens by `message.id`, across all files.** One response is split over several lines with the same usage, and resumes and forks copy earlier records into a new file. Records are also deduped by `uuid`; the session whose file was created first owns copies. `<synthetic>` model records are not model calls.
- **A human prompt is a typed one.** Exclude tool-result carriers (`type: user` with `tool_result` content), `isMeta`, sidechains, compact summaries, `<command-name>` and `<local-command` wrappers, `[Request interrupted`, and anything whose `origin.kind` isn't `human` (task notifications).
- **Time.**
  - Gaps between consecutive user/assistant records count only up to 10 minutes (`IDLE_GAP_MS`).
  - Only Claude's working time counts: a gap that ends in an assistant record, a tool result, a subagent record or a machine message (`ends_claude_work`). A gap that ends in your prompt is you reading and typing, and is not shown anywhere.
  - Intervals are unioned across sessions; every hour figure uses this one measure.
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
- Motion is CSS only and short: the grid sweeps in, sections rise, bars grow, numbers count up; hovering the grid lifts and outlines a cell, without dimming the others. All of it is off under `prefers-reduced-motion`, and the card has none.
- The grid and streak follow the range switch (`grids`/`streaks` per range in the payload). Shades are quantile levels within that range, and the longest streak is outlined. The switch is the last 12 months (`year`), this calendar year so far (`thisYear`, the default) and last calendar year (`lastYear`); the card always uses `year`.

## Out of scope for v1

/insights, Codex, Cursor, per-session replays, server-side PNG rendering, leaderboards and percentiles, any model-generated text, a hosted version, a local server.

Prefer boring code: clarity over cleverness, no premature abstraction, delete dead code.
