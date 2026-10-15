# Contributing to AgentReplay

Thanks for looking under the hood. This project is maintained best-effort; small PRs with tests land fastest.

## Setup

Python 3.9 or newer. Nothing to install.

```sh
python3 -m unittest discover tests
python3 agentreplay.py --demo --out-dir /tmp/demo    # renders the sample sessions
python3 agentreplay.py --json                       # your own numbers, as JSON
```

## Repo tour

| Path | What it is |
|---|---|
| `agentreplay.py` | Reads `~/.claude/projects`, computes every number, renders both pages |
| `template.html` | The overview page and the share card: one template, vanilla JS, no libraries |
| `fonts/` | IBM Plex, inlined into the output so the pages never fetch anything |
| `design/` | The design spec and the reference renders the output should match |
| `tests/` | `unittest` tests and small synthetic session fixtures |
| `docs/session-jsonl-format.md` | The Claude Code session format |

The script computes per-session rows and time intervals; the page sums whichever rows the selected range includes. Anything that needs the raw logs happens in Python. The page only adds up and draws.

## Adding a number

1. It must come straight from the logs: a field, a count, or a sum. If it needs a guess about what happened, it doesn't belong here.
2. Write down its definition in the README's "What the numbers mean" and, if it is on the page, in the footer.
3. Add a fixture line that exercises it to `tests/fixtures/` and a test that asserts the exact value.

Parse defensively. The format changes between Claude Code versions: unreadable lines are counted and skipped, unknown record types are ignored, and nothing crashes.

## Design rules

`design/DESIGN.md` is the spec. The short version:

- Warm slate ground, ivory text, one clay accent. The accent appears at most three or four times per screen: one highlighted bar per chart, the headline, the hour figures.
- The cyan friction colour is only for numbers that mean something went wrong.
- IBM Plex Mono for numbers and labels, Plex Sans for sentences. Second person ("You spent…").
- No gradients, no icons, no emoji. Every data string is set as text, never as HTML.

## Out of scope

PRs for these will be declined:

- Anything model-generated: summaries, titles, classifications
- Telemetry or analytics of any kind (permanent)
- Network calls, a hosted version, accounts, uploads
- Leaderboards or percentiles
- Per-session replays
- Codex and Cursor for now. The Codex parser is parked on the `v2-codex-parsers` branch.

## Commits

One change per PR, with tests. Prefer boring code: this repo is read by strangers.
