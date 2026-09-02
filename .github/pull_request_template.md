## What and why

<!-- What changes, and what problem it solves. Link an issue if there is one. -->

## Checks

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes, and `agentreplay --demo` still opens a replay
- [ ] Heuristic changes come with a fixture test in `packages/core/test/`

## Scope

AgentReplay has some deliberate hard lines, listed in
[CONTRIBUTING.md](../CONTRIBUTING.md). The two that come up most:

- [ ] **No telemetry or analytics**, of any kind — this one is permanent
- [ ] The generated HTML still makes **zero network requests** and works from `file://`
