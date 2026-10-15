# AgentReplay

[![CI](https://github.com/AaravKhanduja/agentreplay/actions/workflows/ci.yml/badge.svg)](https://github.com/AaravKhanduja/agentreplay/actions/workflows/ci.yml)

AgentReplay reads the session logs Claude Code keeps in `~/.claude` and shows you how you work with it: a year of activity, your longest streak, how many hours Claude spent working, where the tokens went, which models you ran, when you work, and the PRs you opened. It writes two files: an overview page and a 1200×675 card you can post.

One Python file, no dependencies, nothing leaves your machine.

## Quickstart

```sh
git clone https://github.com/AaravKhanduja/agentreplay
python3 agentreplay/agentreplay.py --handle @you
```

That writes `agentreplay.html` and `agentreplay-card.html` to the current directory and opens the overview. Python 3.9 or newer; nothing to install.

| Flag | What it does |
|---|---|
| `--handle @you` | Your handle, shown on the card |
| `--out-dir DIR` | Where to write the two files (default: current directory) |
| `--claude-dir DIR` | Where Claude Code keeps its data (default: `$CLAUDE_CONFIG_DIR` or `~/.claude`) |
| `--tz Area/City` | Time zone for days and hours (default: your local zone) |
| `--no-open` | Don't open the page |
| `--json` | Print the stats as JSON instead |
| `--demo` | Use the bundled sample sessions |

## Sharing the card

On the overview, **Export card** shows the card. **Post on X** copies the card to your clipboard and opens X's composer in a popup with your headline stat filled in; the page tells you to press ⌘V (Ctrl+V) in the post to attach the card. X's post link can only carry text, and uploading the image for you would mean sending it somewhere, so the card travels by clipboard. **Copy image** and **Download PNG** are there if you're posting somewhere else. `agentreplay-card.html` is the same card as a page.

## What the numbers mean

Every number is counted from the logs. Nothing is estimated, inferred or written by a model.

There are two sources. Claude Code deletes full session transcripts 30 days after their last activity (the `cleanupPeriodDays` setting), but it keeps `~/.claude/history.jsonl`, one line per prompt you typed. So:

- **From your prompt history, the whole year:** sessions, projects, the year grid, the streak, and when you work.
- **From the transcripts that are left:** tokens, hours Claude worked, lines, tools, models, MCP calls and PRs. The page says where these start (e.g. "since Sep 1"): the day from which every session's transcript still exists, so the count from that day on is complete.

If you'd like the detail to reach further back next year, raise `cleanupPeriodDays` in `~/.claude/settings.json`; transcripts already deleted can't be recovered.

- **Sessions**: distinct session ids in your prompt history, plus any transcript the history doesn't mention. Subagent transcripts fold into their parent session.
- **Tokens**: `input + output + cache write + cache read`, counted once per message. Claude Code writes one response across several lines, and a resumed session copies earlier messages, so tokens are deduplicated by message id.
- **Hours Claude worked**: the gaps between consecutive messages that end in Claude's reply or a tool result, which is Claude thinking, writing, or running a tool. Any gap over 10 minutes is dropped as idle, a gap that ends in your prompt (you reading and typing) isn't counted, and overlapping sessions count once. The year grid and the streak use the same time.
- **Lines written**: added lines in Claude Code's own diff of each Edit and Write. Files under `.claude/` don't count.
- **PRs opened**: `gh pr create` runs whose output contains the PR's URL.
- **Year grid and streak**: prompts you typed per day, in your time zone; a streak is consecutive days with at least one. Slash commands don't count.
- **When you work**: the same prompts, by weekday and hour.
- **MCP error rate**: failed calls over calls that ran. Calls you declined aren't failures.

The time-range switch (All time, 90d, 30d, 7d) filters everything, including the grid and the streak; within a range, the grid's shades are relative to that range's own busiest days. The share card always shows the last 12 months.

## Privacy

- No network calls. The fonts are embedded and the pages load nothing.
- No telemetry or analytics, ever.
- The only links are ones you click: your PRs, and the X post.

## Development

```sh
python3 -m unittest discover tests
python3 agentreplay.py --demo --out-dir /tmp/demo
```

`agentreplay.py` does the reading and counting; `template.html` draws both outputs. The design spec is [design/DESIGN.md](design/DESIGN.md), and the session format is documented in [docs/session-jsonl-format.md](docs/session-jsonl-format.md). See [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. IBM Plex is included under the SIL Open Font License ([fonts/OFL.txt](fonts/OFL.txt)).
