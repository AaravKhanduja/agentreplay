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
import { Command } from 'commander';
import { analyzeSession, discoverSessions, resolveSessionRef } from '@agentreplay/core';
import type { AnalyzeOptions, SessionMeta } from '@agentreplay/core';
import { generateAndOpen } from './generate.js';
import { pickSession } from './picker.js';

const NO_SESSIONS_MESSAGE = 'No Claude Code sessions found — is Claude Code installed?';

interface CliFlags {
  last?: boolean;
  all?: boolean;
  demo?: boolean;
  model?: string;
  /** commander negation: --no-ollama sets this to false; defaults to true. */
  ollama: boolean;
  out?: string;
  json?: boolean;
}

const program = new Command();

program
  .name('agentreplay')
  .description(
    'Replay a Claude Code session as a visual debugging artifact.\nFully local — nothing leaves your machine.',
  )
  .version('0.1.0')
  .argument('[session]', 'path to a session .jsonl file, or a session uuid')
  .option('--last', 'open the most recent session (skip the picker)')
  .option('--all', 'pick from all sessions instead of the 20 most recent')
  .option('--demo', 'open the bundled demo session')
  .option('--model <name>', 'Ollama model for enrichment (default: llama3.2:3b)')
  .option('--no-ollama', 'skip Ollama detection and enrichment entirely')
  .option('--out <path>', 'write the HTML to this path instead of a temp file (does not open a browser)')
  .option('--json', 'print the analyzed session as JSON to stdout instead of generating HTML')
  .action(run);

await program.parseAsync(process.argv);

async function run(sessionRef: string | undefined, flags: CliFlags): Promise<void> {
  // In --json mode stdout is reserved for the JSON payload; everything
  // human-facing goes to stderr.
  const say = flags.json
    ? (message: string) => console.error(message)
    : (message: string) => console.log(message);

  try {
    const filePath = await resolveSessionFile(sessionRef, flags);
    const { analyzed, brief, skippedLines, notes } = await analyzeSession(filePath, toAnalyzeOptions(flags));

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

async function resolveSessionFile(ref: string | undefined, flags: CliFlags): Promise<string> {
  if (flags.demo) return resolveDemoPath();

  if (ref) {
    try {
      return await resolveSessionRef(ref);
    } catch (err) {
      throw new Error(`Could not resolve session "${ref}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const sessions = await listSessions();
  const mostRecent = sessions[0];
  if (!mostRecent) throw new Error(NO_SESSIONS_MESSAGE);
  if (flags.last) return mostRecent.filePath;

  const pool = flags.all ? sessions : sessions.slice(0, 20);
  const picked = await pickSession(pool, { output: flags.json ? process.stderr : undefined });
  return picked.filePath;
}

async function listSessions(): Promise<SessionMeta[]> {
  let sessions: SessionMeta[];
  try {
    sessions = await discoverSessions();
  } catch {
    throw new Error(NO_SESSIONS_MESSAGE);
  }
  if (sessions.length === 0) throw new Error(NO_SESSIONS_MESSAGE);
  return [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
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
