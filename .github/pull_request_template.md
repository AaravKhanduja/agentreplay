## What and why

<!-- What changes, and what problem it solves. Link an issue if there is one. -->

## Checks

- [ ] `python3 -m unittest discover tests` passes
- [ ] `python3 agentreplay.py --demo` still opens the page and the card
- [ ] Metric changes come with a fixture test in `tests/`

## Scope

AgentReplay has some deliberate hard lines, listed in
[CONTRIBUTING.md](../CONTRIBUTING.md). The two that come up most:

- [ ] **No telemetry or analytics**, of any kind — this one is permanent
- [ ] The generated HTML still makes **zero network requests** and works from `file://`
