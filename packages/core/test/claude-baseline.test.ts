/**
 * What the Claude Code fixtures analyze to, pinned.
 *
 * Adding a second agent means moving code every Claude session also runs
 * through. A unit test says a function still works; this says the replay a
 * reader would actually see has not moved. If a Codex change alters any line
 * here, that change reached further than it was supposed to.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeParsedSession } from '../src/index.js';
import { buildBrief } from '../src/narrative.js';
import { parseSessionFile } from '../src/sources/claude/parser.js';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FIXTURES = ['clean-execute.jsonl', 'debug-loops.jsonl', 'plan-mode.jsonl'];

/** The surface a reader sees: phases, the story, and the header. */
async function shapeOf(name: string) {
  const { session, skippedLines } = await parseSessionFile(path.join(fixturesDir, name));
  const analyzed = analyzeParsedSession(session);
  const brief = buildBrief(analyzed);
  return {
    skippedLines,
    turns: session.turns.length,
    toolCalls: session.turns.reduce((n, t) => n + t.toolCalls.length, 0),
    phases: analyzed.phases.map((p) => `${p.kind} ${p.startIndex}-${p.endIndex}`),
    replay: analyzed.replay.map((e) => `${e.kind} · ${e.label}`),
    files: analyzed.files.map((f) => `${f.path} r${f.reads} w${f.writes}`),
    debugLoops: analyzed.debugSequences.map((s) => s.loops.length),
    stats: brief.stats,
    title: brief.title,
  };
}

describe('the Claude replays do not move', () => {
  it.each(FIXTURES)('%s analyzes to the same replay', async (name) => {
    expect(await shapeOf(name)).toMatchSnapshot();
  });

  it.each(FIXTURES)('%s survives the JSON round trip', async (name) => {
    const { session } = await parseSessionFile(path.join(fixturesDir, name));
    const analyzed = analyzeParsedSession(session);
    // No Dates, no Maps, no undefined-valued keys: the analysis is stringified
    // straight into the generated HTML, so wire shape must equal memory shape.
    expect(JSON.parse(JSON.stringify(analyzed))).toEqual(analyzed);
  });

  it.each(FIXTURES)('%s is tagged with the agent that produced it', async (name) => {
    const { session } = await parseSessionFile(path.join(fixturesDir, name));
    expect(session.agent).toBe('claude');
  });
});
