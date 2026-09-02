# AgentReplay

AgentReplay turns Claude Code sessions into visual replays of how the agent worked — what it explored, how its plan changed, what it edited, where it got stuck, and what finally worked.

The output is one self-contained HTML file with one hierarchy: a **header** that names the session, a **ribbon** that maps where the time went, an **event graph** that tells the story in a handful of moments — discovery, root cause, goal changed, decision, implementation, blocked — and an **evidence drawer** that proves every one of them from the transcript. A six-hour session reads in about fifteen seconds, and every claim is one click from the turn that backs it.

## Quickstart

```sh
npx agentreplay-cli          # pick from your 20 most recent Claude Code sessions
npx agentreplay-cli --demo   # bundled demo session — works without Claude Code
```

Installed globally (`npm i -g agentreplay-cli`) the command is just `agentreplay`.

> Not yet published to npm. Until the first npm release, run from source:
>
> ```sh
> pnpm install && pnpm build
> node packages/cli/dist/index.js --demo
> ```

AgentReplay reads a session file from `~/.claude/projects/`, analyzes it, and opens a single self-contained HTML file in your browser. No server, no install step beyond the CLI itself.

All flags:

| Flag | What it does |
|---|---|
| `agentreplay` | Picker over the 20 most recent sessions across all projects |
| `agentreplay --last` | Skip the picker, open the most recent session |
| `agentreplay --all` | Picker over all sessions |
| `agentreplay <path-or-uuid>` | Open a specific session (uuid is searched across projects) |
| `agentreplay --demo` | Open the bundled demo session |
| `agentreplay --model <name>` | Override the Ollama model (default `llama3.2:3b`) |
| `agentreplay --no-ollama` | Skip Ollama detection entirely |
| `agentreplay --out <path>` | Write the HTML to a path instead of tmp (doesn't auto-open) |
| `agentreplay --json` | Print the analysis as JSON to stdout, no HTML (debug/scripting) |

## Privacy

Everything runs on your machine. Full stop.

- No telemetry, no analytics — permanently, not just for now.
- No upload, no accounts, no backend.
- The only network call AgentReplay can ever make is to an Ollama server on `localhost:11434`, and only if you have one running (skip even the probe with `--no-ollama`).
- The output is a plain HTML file on your disk. It works from `file://`, offline, forever, and goes nowhere unless you move it — it makes no requests at all, not even a failed one.

Your session data stays exactly where Claude Code put it.

## The replay

The page has four layers, and each answers exactly one question:

| Layer | Question |
|---|---|
| Header | What session is this? |
| Ribbon | How long was it, and where did the time go? |
| Event graph | What actually happened? |
| Evidence drawer | Why does AgentReplay claim that? |

There is deliberately no second answer to "what happened" — no phase cards, no analytics block, no closing summary that repeats the graph.

### Header and ribbon

The **title** comes from the first thing you asked for; the stat line carries `42 tool calls · 1 file changed · +23 −2 · blocked`; your opening prompt sits under it verbatim, because the title is a compression and loses detail.

The **ribbon** is the session's shape in one drawing: phases as blocks, every tool call as a tick coloured by what it was (blue read, amber edit, purple shell, red failure), and long pauses as notches. Its axis is *working* time — drawn to the clock, a session spread across a day is nine parts nothing — and the caption keeps the real numbers (`3h 20m working · longest pause 2h 11m`). Each phase kind is named once in a key laid along the band itself; clicking a block jumps to that chapter of the graph.

### The event graph

One chronological column, roughly five to nine moments, selected from everything the analysis detected. This is `agentreplay --demo`, in full:

```
▪ EXPLORE · 10:03–10:10

10:03  ○  stripe webhook signatures are failing in prod since
          yesterday's deploy — datadog is full of…

10:03  ◆  DECISION
          The fix is to route the exact raw bytes into verification.
          webhooks/handler.ts · webhooks/verify.ts · Evidence →

▪ EXECUTE · 10:19–10:31

10:19  ○  IMPLEMENTATION ×4
          4 files changed (+27 −21)
          src/app.ts · middleware/rawBody.ts · Evidence →

▪ DEBUG · 10:33–10:54

10:44  ○  IMPLEMENTATION
          src/webhooks/verify.ts (+28 −13)

10:44  ●  DISCOVERY
          src/lib/stripe.ts resolves webhookSecret once at module load
          lib/stripe.ts · ↑ first seen 10:03 · Evidence →

10:44  ✕  FAILURE ×5
          Timestamp outside the tolerance zone (verify.ts:29:27)

▪ VERIFY · 10:55–10:57

10:55  ✓  VERIFIED
          3 checks passed — Tests, Typecheck, Lint
```

*(Clock times render in your local timezone.)*

Forty-six tool calls and sixteen turns, compressed to seven moments — and the compression is deduplication and collapsing, not truncation. `IMPLEMENTATION ×4` is one beat covering four edited files; `FAILURE ×5` is one struggle, not five rows.

Three visual weights carry the whole design: quiet `○` steps, key moments (`●` discovery, `◎` root cause, `◆` decision, `↻` goal changed, `✕` failure) with more type and more air, and the outcome (`⚠` / `✓`) ending the story. Phases are small chapter markers, not the artifact.

The `↑ first seen 10:03` link is the part a transcript can't show you: `src/lib/stripe.ts` was already open in the first minute, and the session spent thirteen minutes stuck before coming back to it. An earlier finding feeding a later moment is the one thing a replay knows that scrollback doesn't.

**Every word is the session's.** A node's text is a mechanically clipped sentence from the transcript or a structural fact (`4 files changed (+27 −21)`); the semantic chip carries the verb. AgentReplay selects, clips, groups, ranks and counts — it never writes. If Claude concluded something wrong, the replay shows the wrong conclusion as the session's, never as an AgentReplay finding.

### The evidence drawer

Clicking any event opens its proof in a panel beside the graph — never inline, so the story never shifts under you. Three levels of compression stay distinct:

1. **The claim** — the graph node.
2. **The evidence** — the exact snippet that earned it, with speaker and time (`Claude · 10:03`), and the files behind it.
3. **The transcript** — `View full turn →` reveals the underlying Claude Code turn, markdown-rendered, with its tool calls. AgentReplay is a lens over Claude Code, not a replacement for it.

## How it works

Claude Code writes every session as a JSONL file under `~/.claude/projects/` — one JSON object per line: user messages, assistant messages, tool calls, tool results. AgentReplay's parser (`@agentreplay/core`) turns those lines into a normalized `Session` of turns and tool calls. It is deliberately defensive: the schema drifts between Claude Code versions, so unparseable lines are counted and skipped rather than fatal, tool calls are matched to their results by id (orphans get `outcome: 'unknown'`), and the raw line is kept on every event for anything the model doesn't cover. The format is documented in [docs/session-jsonl-format.md](docs/session-jsonl-format.md).

On top of the normalized session, a set of pure, tested heuristic functions builds the analysis.

**Phase segmentation.** Candidate boundaries are cut at every user turn, and each segment is classified by its tool mix: mostly reads means `explore`, write-heavy means `execute`, and a segment containing two or more debug loops means `debug`. Explicit signals win over statistics — if plan-mode markers are present (an `ExitPlanMode` call, or plan-mode metadata on the turns), the segment is `plan` regardless of tool mix. A segment is `verify` only on *sustained* validation intent: no edits, two or more check commands, and either two different kinds of check (test + typecheck, test + lint) or the session's closing all-green run — otherwise an ordinary edit-then-test rhythm would shred the session into alternating Execute/Verify noise. Adjacent segments of the same kind merge, and segments shorter than two turns or sixty seconds merge into a neighbor, so the timeline shows real phases rather than noise.

**What counts as an outcome.** Only test, typecheck, lint and build commands decide whether a session passed or failed, and the page names the one that decided it ("typecheck failing", not always "tests"). Anything else — a failed `gcloud` lookup, an `rg` that exits 1 because it found no matches — is not evidence about your code. Files under `.claude/` are excluded from everything: the harness's own plan documents are not changes you made.

**Debug-loop detection.** A loop is the triple you already know by feel: a write to a file, a bash run, an error (or another write to the same file within five tool calls). Error messages are normalized into signatures — lowercase the first line, strip line/column numbers and hex addresses, collapse whitespace — so "the same error" is a comparison, not a guess. Three or more consecutive loops with an identical signature form a stuck run. The first loop after a stuck run whose result changes is the breakthrough, and because the analyzer tracks the files read between attempts, it can usually attribute it: "read utils/signature.ts" is often the moment the session turned.

**Semantic events are the primitives.** `events.ts` extracts typed moments — question, hypothesis, discovery, root cause, decision, pivot, implementation, failure, verification, blocker — from two sources and no others: sentences the session contains (quoted, marker-matched) and facts the tool calls prove (edits, checks, outcomes). Nothing is inferred, and every event carries the turn it came from plus the files that back it, so a wrong conclusion reads as *the session's* wrong conclusion rather than as an AgentReplay finding.

The rule the whole product rests on: **select, clip, group, rank and count are ours; wording is the session's, wherever wording exists.** Each event's display line is its own sentence with the pointer opener stripped (*"The goal is clear:"*, *"There it is."*) and cut at a clause boundary — never mid-thought, and never a word the session didn't use.

**Detection is not presentation.** The extractor finds every checkable moment; `replay.ts` then derives the few that carry the story. Earlier root-cause candidates demote to discoveries (the last conclusion stated is the conclusion). A later finding that restates an earlier one without adding a new file or symbol is dropped. Runs of edits and passing checks merge into one beat each. Several distinct failures in one phase keep only the strongest, unless one caused the breakthrough. The rest fill a soft budget by score — weight, repetition, whether a later event comes back to this one's file, whether it precedes the phase's conclusion — with outcomes, the root cause, goal changes and spoken decisions never cut. Compression comes from deduplication and collapsing, not truncation.

**Everything the replay draws is computed first.** The event graph's selection, every node's label, the ribbon's working-time axis and the takeaways are all built in `@agentreplay/core` and serialized into the page; the viewer only draws. That is what lets you disagree with the UI without distrusting the analysis — and it means improving `buildExploreTrail()` or the loop detector never involves touching React.

**Why heuristics first.** All of this is deterministic string and sequence analysis — it runs in milliseconds, produces the same answer every time, and never sends your data anywhere. Even the text layer (the title, the one finding, the takeaways) is template-composed from computed facts. An LLM is strictly optional: if Ollama is running locally, it does exactly four things — relabel the heuristically extracted concepts, polish the session title, tighten a section summary the session already contains, and rewrite takeaways for fluency (never adding facts: rewrites that invent numbers are discarded, titles that name something you never mentioned are rejected, and copyable snippets are never touched). It never decides what happened, what a root cause is, whether two events are duplicates, or which events enter the replay — and it never words a graph node. Without it, the output is identical minus nicer wording.

**One file out.** The viewer is a Next.js app built with static export, then post-processed into a single HTML file: every script, stylesheet, and font is inlined (fonts as base64 `@font-face`), and the analysis is injected as a JSON blob on `window.__AGENTREPLAY_DATA__`. The result is a self-contained artifact under 1 MB that opens from `file://`, issues zero requests of any kind, and will still work in ten years.

## Ollama setup (optional)

AgentReplay works fully without Ollama, on every platform, with identical structure and identical facts. With it, you get four small improvements: cleaned-up concept labels ("webhook signature verification" instead of a raw noun phrase), a better-worded session title, a tightened section summary, and more fluent takeaway phrasing (the facts, files, and numbers stay exactly as the heuristics computed them — rewrites that invent numbers are discarded, a title that introduces a word you never used is rejected, and the copyable CLAUDE.md snippet is never touched). Nothing else — loop detection, diffs, event extraction, replay selection, and all structure are heuristic and never touch the model. The event graph's node text is never model-worded.

```sh
# install: https://ollama.com
ollama pull llama3.2:3b
agentreplay --last                 # detects Ollama automatically (1s probe)
agentreplay --model qwen2.5:7b    # use a different model
agentreplay --no-ollama            # skip detection entirely
```

**Where it works.** Ollama itself runs on macOS (Apple Silicon and Intel), Linux (x86-64 and ARM, with or without a GPU) and Windows. AgentReplay doesn't care which — it makes one HTTP call to `http://localhost:11434/api/tags` with a 1-second timeout, and if anything other than a model list comes back it moves on. So the matrix is simple:

| Situation | What happens |
|---|---|
| No Ollama installed | 1s probe fails, heuristic output, no message |
| Ollama running, model not pulled | Prints `Model llama3.2:3b not found — run: ollama pull llama3.2:3b` |
| Ollama on a non-default port or another host | Not auto-detected; the default URL is hard-coded to localhost |
| Low-memory machine (< ~8 GB free) | `llama3.2:3b` may be slow; the 30s budget cuts it off and the rest falls back |
| Any failure mid-enrichment | Whatever landed is kept, the rest stays heuristic |
| `--no-ollama` | No probe at all — the process makes zero network calls of any kind |

The 3B default is deliberate: it runs on a laptop without a GPU. Nothing is downloaded automatically and no model is bundled — if you never run `ollama pull`, AgentReplay never talks to anything.

## Development

Requires Node ≥ 20 and pnpm ≥ 10 (the repo pins `pnpm@10.33.0` via `packageManager`).

```sh
pnpm install && pnpm build && pnpm test
```

pnpm workspace with three packages:

| Package | What it is |
|---|---|
| `packages/core` | Parser + heuristics. Zero UI dependencies — the testable heart of the project. Public API: `analyzeSession(path)` → `AnalyzedSession`. |
| `packages/viewer` | Next.js app (static export). Vanilla CSS with design tokens; no chart libraries and no markdown library — the ribbon is hand-rolled SVG, the graph is CSS. |
| `packages/cli` | `commander`-based CLI: discovery, session picker, data injection, browser open. |

`viewer` and `cli` depend on `core`; `core` depends on nothing internal.

`pnpm dev:viewer` runs the viewer with hot reload against `packages/viewer/lib/sample.json` (a real parsed session) — no CLI round-trip needed while working on UI. The production build (`pnpm build`) statically exports the viewer, inlines it into one file via `packages/viewer/scripts/inline.mjs`, and drops the result at `packages/cli/assets/viewer.html`, which the CLI injects session data into at runtime.

Two dev-only scripts sit in `scripts/`, both needing a local Chrome via `puppeteer-core` (nothing is downloaded — set `CHROME_PATH` if yours is somewhere unusual). Neither runs in `pnpm build` or `pnpm test`:

```sh
node packages/cli/dist/index.js --demo --no-ollama --out /tmp/agentreplay-demo.html
node scripts/ar-verify.mjs /tmp/agentreplay-demo.html   # asserts the artifact makes zero network requests
node scripts/screenshots.mjs /tmp/agentreplay-demo.html # regenerates docs images, if you add any
```

`packages/viewer/lib/sample.json` is a generated payload — regenerate it after any change to the core data model, or the dev viewer renders against a stale shape:

```sh
node packages/cli/dist/index.js --demo --no-ollama --json > packages/viewer/lib/sample.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repo tour, how to add a heuristic, and the scope lines. This project is maintained best-effort — PRs welcome, especially heuristic improvements with tests.

MIT licensed. See [LICENSE](LICENSE).
