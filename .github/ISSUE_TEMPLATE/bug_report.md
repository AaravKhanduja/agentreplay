---
name: Bug report
about: Something broke — a parse failure, a wrong number, a rendering problem
title: ''
labels: bug
assignees: ''
---

## What happened

A clear description of the bug, and what you expected instead.

## Environment

- AgentReplay version:
- Claude Code version (`claude --version`):
- OS:
- Python version (`python3 --version`):

## Does `--demo` reproduce it?

Run `python3 agentreplay.py --demo`. Does the bug happen there too? (This tells us whether the problem is your session data or the tool itself.)

- [ ] Yes, `--demo` reproduces it
- [ ] No, only with my own session

## Analysis output (if shareable)

If a number looks wrong, the matching part of `python3 agentreplay.py --json` helps a lot.

> **Privacy reminder:** your session data is local and stays that way — AgentReplay never uploads anything. Pasting it into a GitHub issue is the only way it leaves your machine, so share only what you're comfortable with, and redact file paths, code, or prompts as needed. A trimmed snippet around the problem is usually enough.

```json
<paste relevant snippet here>
```

## Anything else

Stack traces, screenshots of the generated HTML, or a sanitized `.jsonl` fixture that reproduces a parse failure (the gold standard for parser bugs).
