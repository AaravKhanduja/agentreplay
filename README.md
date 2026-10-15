# AgentReplay

[![CI](https://github.com/AaravKhanduja/agentreplay/actions/workflows/ci.yml/badge.svg)](https://github.com/AaravKhanduja/agentreplay/actions/workflows/ci.yml)

AgentReplay reads the session logs Claude Code keeps in `~/.claude` and shows you how you work with it: a year of activity, your longest streak, how many hours Claude worked and how many you spent directing it, where the tokens went, which models you ran, when you work, and the PRs you opened. It writes two files: an overview page and a 1200×675 card you can post.

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

On the overview, **Export card** shows the card. **Copy image** puts it on your clipboard as a PNG, and **Post on X** opens a post with your headline stat filled in, ready to paste the image into. **Download PNG** saves it instead. `agentreplay-card.html` is the same card as a page.

## What the numbers mean

Every number is counted from the logs. Nothing is estimated, inferred or written by a model.

- **Sessions**: session files under `~/.claude/projects`, with their subagent files folded in.
- **Tokens**: `input + output + cache write + cache read`, counted once per message. Claude Code writes one response across several lines, and a resumed session copies earlier messages, so tokens are deduplicated by message id.
- **Active hours**: the gaps between consecutive messages, dropping any gap over 10 minutes. Sessions that overlap count once.
- **Claude worked / you directed**: a counted gap is Claude's time if it ends in Claude's reply or a tool result, and yours if it ends in a prompt you typed. Where sessions overlap, Claude's time wins, so the two always add up to active hours.
- **Lines written**: added lines in Claude Code's own diff of each Edit and Write. Files under `.claude/` don't count.
- **PRs opened**: `gh pr create` runs whose output contains the PR's URL.
- **Streak**: consecutive days, in your time zone, with any active time.
- **When you work**: the prompts you typed, by weekday and hour.
- **MCP error rate**: failed calls over calls that ran. Calls you declined aren't failures.

The time-range switch (All time, 90d, 30d, 7d) filters everything except the year grid, by when each session started.

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
