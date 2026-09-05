/**
 * agentreplay — CLI entry point.
 *
 * Resolve a session file (picker / --last / --demo / explicit ref), run the
 * core analysis, then either print JSON (--json) or generate and open the
 * single-file HTML viewer.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import {
  SOURCES,
  analyzeSession,
  availableSources,
  discoverSessions,
  noSessionsMessage,
  resolveSessionRef,
} from '@agentreplay/core';
import type { AgentId, AnalyzeOptions, SessionMeta, SessionRef } from '@agentreplay/core';
import { generateAndOpen } from './generate.js';
import { pickSession } from './picker.js';

/** The agent names accepted where a session reference goes. */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const AGENT_WORDS: readonly AgentId[] = ['claude', 'codex'];

/**
 * `agentreplay codex` reads as a scope, not a session.
 *
 * Safe to overload the positional: a session reference is a path or a hex
 * uuid, and no agent name is valid hex. A file that really is named `codex`
 * still wins, because a path is checked before this is consulted.
 */
function agentWord(ref: string | undefined): AgentId | null {
  const word = ref?.trim().toLowerCase();
  return AGENT_WORDS.find((agent) => agent === word) ?? null;
}

interface CliFlags {
  last?: boolean;
  all?: boolean;
  demo?: boolean;
  model?: string;
  /** commander negation: --no-ollama sets this to false; defaults to true. */
  ollama: boolean;
  out?: string;
  json?: boolean;
  sources?: boolean;
}

const program = new Command();

program
  .name('agentreplay')
  .description(
    'Replay a coding-agent session as a visual debugging artifact.\nReads Claude Code and Codex CLI sessions. Fully local — nothing leaves your machine.',
  )
  .version(VERSION)
  .argument('[session]', 'an agent name (claude, codex), a session file, or a session id')
  .option('--last', 'open the most recent session (skip the picker)')
  .option('--all', 'pick from all sessions instead of the 20 most recent')
  .option('--demo', 'open the bundled demo session')
  .option('--model <name>', 'Ollama model for enrichment (default: llama3.2:3b)')
  .option('--no-ollama', 'skip Ollama detection and enrichment entirely')
  .option('--out <path>', 'write the HTML to this path instead of a temp file (does not open a browser)')
  .option('--json', 'print the analyzed session as JSON to stdout instead of generating HTML')
  .option('--sources', 'list the agents found on this machine, and where they were looked for')
  .action(run);

await program.parseAsync(process.argv);

async function run(sessionRef: string | undefined, flags: CliFlags): Promise<void> {
  // In --json mode stdout is reserved for the JSON payload; everything
  // human-facing goes to stderr.
  const say = flags.json
    ? (message: string) => console.error(message)
    : (message: string) => console.log(message);

  try {
    if (flags.sources) {
      say(await describeSources());
      return;
    }

    const target = await resolveSession(sessionRef, flags);
    const { analyzed, brief, skippedLines, notes } = await analyzeSession(target, toAnalyzeOptions(flags));

    if (skippedLines > 0) say(`${skippedLines} line${skippedLines === 1 ? '' : 's'} skipped`);
    for (const note of notes) say(note);

    if (flags.json) {
      process.stdout.write(JSON.stringify({ analyzed, brief }, null, 2) + '\n');
      return;
    }

    await generateAndOpen({ analyzed, brief }, flags.out ?? null, say);
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      // Ctrl-C in the picker — leave quietly.
      process.exitCode = 130;
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** Map CLI flags to core AnalyzeOptions. --no-ollama wins over --model. */
function toAnalyzeOptions(flags: CliFlags): AnalyzeOptions {
  if (!flags.ollama) return { ollama: false };
  if (flags.model) return { ollama: { model: flags.model } };
  return {};
}

/** Which session to replay, and which agent's reader can load it. */
async function resolveSession(ref: string | undefined, flags: CliFlags): Promise<SessionRef> {
  if (flags.demo) {
    const filePath = await resolveDemoPath();
    return { agent: 'claude', sessionId: 'demo-session', filePath };
  }

  const scope = agentWord(ref);
  if (ref && scope === null) {
    try {
      return await resolveSessionRef(ref);
    } catch (err) {
      throw new Error(`Could not resolve session "${ref}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sessions = await listSessions(scope);
  const mostRecent = sessions[0];
  if (!mostRecent) throw new Error(noSessionsMessage());
  if (flags.last) return refOf(mostRecent);

  const pool = flags.all ? sessions : sessions.slice(0, 20);
  const picked = await pickSession(pool, { output: flags.json ? process.stderr : undefined });
  return refOf(picked);
}

function refOf(meta: SessionMeta): SessionRef {
  return { agent: meta.agent, sessionId: meta.sessionId, filePath: meta.filePath };
}

async function listSessions(scope: AgentId | null): Promise<SessionMeta[]> {
  let sessions: SessionMeta[];
  try {
    sessions = await discoverSessions();
  } catch {
    throw new Error(noSessionsMessage());
  }
  const scoped = scope === null ? sessions : sessions.filter((s) => s.agent === scope);
  if (scoped.length === 0) {
    throw new Error(scope === null ? noSessionsMessage() : `No ${scope} sessions found.`);
  }
  return [...scoped].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** What `--sources` prints: every agent, whether it is here, and how many. */
async function describeSources(): Promise<string> {
  const available = new Set((await availableSources()).map((source) => source.id));
  const counts = new Map<string, number>();
  for (const meta of available.size > 0 ? await discoverSessions() : []) {
    counts.set(meta.agent, (counts.get(meta.agent) ?? 0) + 1);
  }
  const width = Math.max(...SOURCES.map((source) => source.label.length));
  return SOURCES.map((source) => {
    const found = available.has(source.id)
      ? `${counts.get(source.id) ?? 0} sessions`
      : 'not found';
    return `${source.label.padEnd(width)}  ${found.padEnd(13)} ${source.root()}`;
  }).join('\n');
}

/**
 * The demo session ships in <package-root>/assets/. When running from source
 * via tsx (dist/ and assets/ may not be built yet) fall back to the repo's
 * examples/ copy.
 */
async function resolveDemoPath(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/ when built, src/ under tsx
  const candidates = [
    path.resolve(here, '../assets/demo-session.jsonl'),
    path.resolve(here, 'assets/demo-session.jsonl'),
    path.resolve(here, '../../../examples/demo-session.jsonl'), // repo root examples/, dev mode
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('Demo session not found — try reinstalling agentreplay.');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
