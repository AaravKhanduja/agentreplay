# Contributing to AgentReplay

Thanks for looking under the hood. This project is maintained best-effort; focused PRs with tests are the most likely to land quickly.

## Dev setup

Requires Node ≥ 20 and pnpm ≥ 9.

```sh
pnpm install
pnpm build        # core → viewer (static export + inline) → cli
pnpm test         # Vitest, currently parser + heuristics in packages/core
pnpm typecheck
```

For UI work:

```sh
pnpm dev:viewer   # Next.js dev server with hot reload
```

The viewer in dev mode loads `packages/viewer/lib/sample.json` (a real parsed session) instead of injected data, so you never need the CLI round-trip while iterating on components.

To run the CLI against your own sessions without building:

```sh
pnpm cli -- --last --json
```

## Repo tour

```
packages/
├── core/     # parser + heuristics — no UI, no CLI deps
├── viewer/   # Next.js app, static export → single HTML file
└── cli/      # commander CLI, session picker, HTML generation
```

**Dependency rule (hard):** `core` depends on nothing internal. `viewer` and `cli` both depend on `core`. The CLI never imports viewer code — it only consumes the built `packages/cli/assets/viewer.html` artifact, which `packages/viewer/scripts/inline.mjs` produces from the static export.

Inside `packages/core/src`:

| File | Responsibility |
|---|---|
| `types.ts` | The entire shared data model. Read this first. |
| `parser.ts` | JSONL → `Session`. See [docs/session-jsonl-format.md](docs/session-jsonl-format.md) for the format and the normative parsing rules. |
| `discover.ts` | Scans `~/.claude/projects/` for sessions, cheap metadata for the picker |
| `phases.ts` | Phase segmentation (explore / plan / execute / debug / verify) |
| `checks.ts` | What counts as a check command, what a shell command is doing, and what is harness-owned |
| `commands.ts` | Bash calls grouped into actions with their results (Execute) |
| `summary.ts` | Finds the sentence a phase is about, quoted from the transcript |
| `events.ts` | Semantic events — the primitives diagrams are generated from |
| `prose.ts` | Sentence splitting and markdown stripping, shared by both |
| `timeline.ts` | The working-time axis behind the ribbon |
| `files.ts` | File access graph, backtrack detection, edges |
| `trail.ts` | The explore trail: depth, revisits, and the file that mattered later |
| `verify.ts` | Verification results and whole-session change totals |
| `title.ts` | The session title, derived from the first thing the user asked for |
| `loops.ts` | Debug loop detection, stuck runs, breakthrough attribution |
| `diffs.ts` | Edit diff extraction and per-file attempt histories |
| `concepts.ts` | Heuristic concept extraction from user turns |
| `plans.ts` | Plan revision tracking and step-level diffs |
| `ollama.ts` | Optional enrichment — strictly scoped, see below |
| `index.ts` | Public API: `analyzeSession(path)` → `AnalyzeResult` |

One serialization note that bites people: **all timestamps in the data model are ISO 8601 strings, not `Date` objects.** The `AnalyzedSession` is `JSON.stringify`'d directly into the generated HTML, so the in-memory shape must equal the wire shape.

A second one, just as sharp: **the viewer imports types from `core`, never its runtime.** Importing a function pulls `node:fs` into the client bundle and breaks the static export, so anything the page needs must be computed in core and serialized (see `AnalyzedSession.trails` and `.verifications`). That is also the design rule — heuristics live in core, components only draw. After changing the model, regenerate the dev payload:

```sh
node packages/cli/dist/index.js --demo --no-ollama --json > packages/viewer/lib/sample.json
```

## Running tests

```sh
pnpm test                          # everything
pnpm --filter @agentreplay/core test   # core only
```

Tests run against small synthetic `.jsonl` fixtures in `packages/core/test/fixtures/`. If you change parser or heuristic behavior, update or add a fixture that demonstrates it.

## Adding or changing a heuristic

Heuristics live in `packages/core` and follow one pattern:

1. **Pure function.** `Session` (or prior analysis output) in, typed result out. No I/O, no globals, no randomness. Deterministic: same session, same answer, every time.
2. **Typed in `types.ts`.** If your heuristic produces a new shape, add it to the shared types with doc comments — the viewer consumes exactly these types.
3. **Tested.** Add a Vitest file in `packages/core/test/` with a fixture that exercises the behavior, including at least one degenerate case (empty session, orphaned tool call, malformed input).
4. **Wired in `index.ts`** if it should be part of `analyzeSession`, and exported individually so it can be tested and reused in isolation.

Heuristics should degrade, not crash. A session that doesn't match your pattern should produce an empty result, never a throw.

## Viewer PRs: design-system constraints

The design tokens in `packages/viewer/app/globals.css` are constraints, not suggestions:

- **Color axes never mix.** Blue/amber/purple encode tool *category* (read/write/bash). Green/red encode *outcome* only. Cyan (`--selection`) is only for hover/focus/revisit — never semantic.
- **Color lives on small marks** — the graph's node marks and chips, the ribbon's blocks and ticks. Never tint a whole block.
- **A panel marks an exceptional or actionable object, never ordinary session structure.** Today that is the stuck-run block and the copyable CLAUDE.md snippet; the rule is the sentence, not the count.
- **No prose in a view.** If a section needs a paragraph to be understood, the layout is wrong — fix the layout.
- Border radius ≤ 6px. No gradients, no glows, no shadows-for-depth. Animations ≤ 200ms.
- File paths truncate from the left with a single `…`, keeping the filename.
- Fonts: IBM Plex Sans for UI, IBM Plex Mono for paths/diffs/timestamps/metadata. Base size 13px.
- When in doubt: denser, quieter, smaller radius.

No Tailwind, no chart libraries, no force graphs. Indentation, flex rows and CSS carry the structure.

## Hard scope lines

**Ollama boundary.** Ollama does exactly three things: relabel concepts, polish the session title, and rewrite takeaways for fluency. It is never involved in loop analysis, diff summaries, takeaway selection, or anything structural, and it may never add facts — rewrites that introduce numbers not present in the heuristic input are discarded, a polished title that uses a significant word absent from the user's own request is rejected, and copyable snippets are never touched. PRs that expand its role will be declined. Detection is a 1s probe of `localhost:11434`, default model `llama3.2:3b`, never auto-pulled, total time budget 30s shared across all enrichment calls, heuristic fallback on any failure. Fully optional, always.

**Out of scope** (do not build, PRs will be declined):

- Web app / hosted version, drag-drop upload, shareable URLs, accounts
- Claude/OpenAI API keys, in-browser models
- A local HTTP server (the output is a file, on purpose)
- Light mode, mobile layouts
- Multi-session dashboards or aggregate stats
- Cursor/Codex session support
- Watch mode / live sessions
- Any telemetry or analytics — this one is permanent, not just v0

## Commits and PRs

- Keep PRs focused: one heuristic, one section-view fix, one parser improvement per PR.
- Heuristic and parser changes need tests; explain in the PR description what real-world session pattern motivated the change.
- Parsing real session files means schema drift between Claude Code versions — parse defensively, keep `raw` on events, never crash on unknown fields. If you hit a session file the parser mishandles, a sanitized fixture reproducing it is the ideal bug report.
- Prefer boring code. This repo is read by strangers as a portfolio artifact: clarity over cleverness, no premature abstraction, delete dead code.
