# AgentReplay design spec

Two outputs from one stats dict: `overview.html` (the page the user reads) and `card.html` (a fixed 1200x675 image for posting). Both files in this folder are working reference renders with sample data in a `DATA` object at the top of the script. Reuse their markup and CSS; swap `DATA` for the real stats.

## Palette (warm slate, clay accent)

| Token | Hex | Use |
|---|---|---|
| ground | `#141413` | page and card background |
| text | `#faf9f5` | numbers, headings |
| text-2 | `#d6d1c7` | body sentences |
| muted | `#9a948a` | labels, axis text, header |
| faint | `#6b665d` | footer |
| rule | `#2b2a27` | 1px dividers |
| track | `#1c1f23` | empty bar track |
| track-cell | `#222120` | empty day in the grid |
| bar-2 | `#3d4652` | non-highlighted bars |
| accent | `#d97757` | the one highlighted bar per chart, the streak headline, hour figures in the sentence, grid cells |
| friction | `#7cc4d6` | only for error rates and failure counts (MCP error column). Never elsewhere. |

Rules:
- Accent appears at most 3 or 4 times per screen. One bar per chart is accent; the rest are `bar-2`.
- Friction color appears only on numbers that mean "something went wrong". If no such number is on screen, it does not appear.
- No gradients, no rounded cards with icons, no emoji, no lowercase-everything.

## Type

- Numbers, labels, headers, month ticks: `IBM Plex Mono` 400/500. Numbers are weight 500.
- Sentences and labels under numbers: `IBM Plex Sans` 400.
- Load from Google Fonts in the template; for the canvas/PNG path wait on `document.fonts.ready` before drawing.

Sizes used: streak headline 72px (card) / 64px (page), strip numbers 30px (card) / 28px (page), sentence 21px (card) / 20px (page), section h2 18px 600, labels 13px, mono meta 12 to 15px.

## Voice

Second person. "You spent 106 hours directing it." Never first person. Never "your story".

## Year grid (both outputs)

- 53 columns (weeks) x 7 rows (Mon top), last 365 days ending today, local time.
- Card: cell 19px, gap 2px, grid width 1111px. Page: cell 17px, gap 2px, width 1005px.
- Color metric is active minutes per day. Zero days use `track-cell`. Non-zero days use accent at one of five opacities `[0.2, 0.38, 0.56, 0.78, 1.0]`, levels assigned by quantiles (20/40/60/80th percentile of non-zero days), not linear.
- Longest streak gets one rounded 1.5px accent outline around its weeks (bounding box, not per-cell).
- Month labels sit in a 16px row above the grid, absolutely positioned at the first column of each month; skip a label if the first month has fewer than 5 days in the grid.
- On the page the grid follows the time-range control (Mon/Wed/Fri labels on the left); the card's grid is always the last 12 months.

## Card layout (1200x675, padding 44/44/40)

1. Header row: 10px accent square + `agentreplay` (left), `last 12 months` (right). Mono 15px muted.
2. Month label row (margin-top 44) then grid (margin-top 8).
3. Flexible space.
4. Headline: `41-day streak` 72px mono accent, with `Jul 3 to Aug 12` 15px mono muted beside it. Fallback when no streak over 7 days: `1,402 sessions` in the same slot.
5. Sentence (21px, text-2): `1,402 sessions since March. Claude worked <accent>212 hours</accent>. You spent <accent>106</accent> directing it.`
6. Flexible space.
7. Strip, 1px top rule, 5 equal columns: sessions, active hours, lines written, tokens, PRs opened. The template takes a list; render whatever stats the agent provides (Cursor gets 4).

## Overview page layout (max-width 1040, padding 40/16/80, section gap 52)

1. Header: mark + `agentreplay overview` (left); time range switch `Last 12 months / 2026 / 2025` (the current year default, 1px rule border, selected = ivory bg + ground text) and `Share` (right; solid accent fill, ground text, the page's one filled button).
2. Year grid (same as card, smaller cells).
3. Streak headline 64px + dates, sentence with accent hour figures.
4. Strip (1px rules top and bottom): sessions, tokens (label "tokens, 91% cache reads"), active hours (label "active hours, idle gaps removed"), lines written, PRs opened.
5. One mono line under the strip: `Most used tools: Read 8.1k · Bash 5.6k · Edit 4.0k · Grep 1.9k` (tool names in text color).
6. `Where the tokens went`, by project: 180px name column, bar, tokens, sessions. Top project is accent, rest `bar-2`.
7. Two columns: `Models you ran` (bars by token share, top is accent, one sentence under) and `When you work` (7x24 heatmap, local time, accent opacity by count, tick labels 12am/6am/12pm/6pm/11pm, one sentence under).
8. `Top MCP servers`: name, calls, error rate. Highest error rate in friction color. Hidden if no MCP calls.
9. `PRs you opened`: date, title, repo, number. Each row a link. Header shows source and count.
10. Footer, 12px faint: data source, idle-gap rule.

Time range filters the grid, sentence, strip and all sections. Filter at session level by first timestamp.

## Metrics definitions (state these in the footer or a tooltip)

- Active hours: sum of gaps between consecutive records within a session, dropping gaps over 10 minutes; intervals unioned across sessions.
- Claude worked / you directed: a counted gap is agent time if it ends in an assistant turn or tool result, your time if it ends in a human prompt. Tool results are `type: user` records with `tool_result` content; do not count them as human.
- Tokens: sum of `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`, deduped by `message.id`.
- Lines written: newlines in Edit `new_string` minus `old_string`, plus Write `content`. Label as "written", not "lines of code".
- PRs opened: Bash commands matching `gh pr create`; title from `--title`, URL from the tool result.
- Streak: consecutive local days with active minutes > 0.
