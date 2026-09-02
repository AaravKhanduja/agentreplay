/**
 * Explore trail: what the session was trying to find out.
 *
 * Each step is a question and its answer — the pattern a search hunted for and
 * the files it landed in, or a file that was opened outright. Describing steps
 * by their commands instead made an investigation render as a column of nearly
 * identical `rg -n "…" "/Users/…"` strings, which is filing, not a replay.
 *
 * `laterCritical` is the one cross-phase fact: the file that later broke a
 * debug stall, marked at the moment it was first opened. The answer was in hand.
 */

import { commandOf, isHarnessPath, shellKind } from './checks.js';
import type { AnalyzedSession, Phase, Session, ToolCall, TrailStep } from './types.js';

const FOUND_SHOWN = 2;
const SUBJECT_MAX = 44;
/** Alternations beyond this become "+N" rather than a wall of pipes. */
const ALTERNATIVES_SHOWN = 2;

export function buildExploreTrail(session: Session, phase: Phase, analyzed: AnalyzedSession): TrailStep[] {
  const critical = criticalFiles(analyzed);
  const seenBefore = subjectsSeenBefore(session, phase.startIndex);
  const steps: TrailStep[] = [];
  const bySubject = new Map<string, TrailStep>();

  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    const turn = session.turns[i];
    if (turn === undefined) continue;
    for (const call of turn.toolCalls) {
      const look = lookAt(call, session.projectPath, i);
      if (look === null) continue;

      // The same question asked twice is one question, asked twice.
      const already = bySubject.get(look.subject);
      if (already !== undefined) {
        already.repeats += 1;
        already.matches += look.matches;
        for (const file of look.found) {
          if (!already.found.includes(file)) already.found.push(file);
        }
        already.moreFound = Math.max(already.moreFound, look.moreFound);
        already.turnIndex = look.turnIndex;
        continue;
      }

      const step: TrailStep = {
        ...look,
        found: [...look.found],
        revisit: seenBefore.has(look.subject),
        laterCritical: look.path !== '' && critical.has(look.path),
      };
      steps.push(step);
      bySubject.set(step.subject, step);
      seenBefore.add(step.subject);
    }
  }

  return steps;
}

type Look = Omit<TrailStep, 'revisit' | 'laterCritical'>;

/** A read, a search, or null when the call wasn't looking at anything. */
function lookAt(call: ToolCall, projectPath: string, turnIndex: number): Look | null {
  const base = { timestamp: call.timestamp, turnIndex, found: [], moreFound: 0, matches: 0, repeats: 1 };

  if (call.category === 'read' && call.filePath !== null) {
    if (isHarnessPath(call.filePath) || isAttachment(call.filePath)) return null;
    // A Grep/Glob call is a search even though its tool category is 'read'.
    const pattern = typeof call.input['pattern'] === 'string' ? call.input['pattern'] : null;
    if (pattern !== null) {
      return { ...base, kind: 'search', subject: readable(pattern), path: '', ...landed(call, projectPath) };
    }
    return { ...base, kind: 'read', subject: call.filePath, path: call.filePath };
  }

  if (call.category !== 'bash') return null;
  const command = commandOf(call);
  const kind = shellKind(command);
  if (kind !== 'search' && kind !== 'read') return null;

  const pattern = searchPattern(command);
  if (pattern !== null) {
    return { ...base, kind: 'search', subject: readable(pattern), path: '', ...landed(call, projectPath) };
  }

  // A read-only command with no pattern (`sed -n`, `cat`) is opening a file.
  const target = shellTargetFile(command, projectPath);
  if (target === null || isHarnessPath(target)) return null;
  return { ...base, kind: 'read', subject: target, path: target };
}

/** Only these programs are searching for something. */
const SEARCH_PROGRAM = /^(rg|ag|ack|grep|egrep|fgrep|fd|find)\b/;
/** Flags whose value is a filter, not the pattern (`-g '!*.test.*'`, `-t ts`). */
// `-r` is deliberately absent: it means "recursive" to grep and "replace" to
// rg, and eating grep's pattern is worse than keeping an rg replacement.
const VALUED_FLAG = /(^|\s)(-[gtTmABCf]|--glob|--iglob|--type|--type-not|--max-count|--file|--replace|--context)(=|\s+)("[^"]*"|'[^']*'|\S+)/g;
/** Flags that introduce the pattern itself. */
const PATTERN_FLAG = /(?:^|\s)(?:-e|--regexp|-name|-iname)(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))/;

/**
 * What a search command is hunting for.
 *
 * Filter flags are dropped first, or `-g '!*.test.*'` reads as the question.
 * `-e` and `find -name` introduce the pattern explicitly and win outright;
 * otherwise it is the first quoted or bare argument that isn't a path.
 */
export function searchPattern(command: string): string | null {
  const trimmed = command.trim();
  if (!SEARCH_PROGRAM.test(trimmed)) return null;

  const explicit = PATTERN_FLAG.exec(trimmed);
  if (explicit !== null) {
    const value = explicit[2] ?? explicit[3] ?? explicit[4] ?? '';
    if (value !== '') return value;
  }

  const withoutFilters = trimmed.replace(VALUED_FLAG, ' ').replace(/(^|\s)-{1,2}[A-Za-z][\w-]*/g, ' ');
  const quoted = [...withoutFilters.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((value) => value !== '' && !looksLikePath(value));
  const first = quoted[0];
  if (first !== undefined) return first;

  const bare = withoutFilters
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(1)
    .find((token) => token !== '' && !looksLikePath(token) && !/^[!*.]/.test(token));
  return bare ?? null;
}

/** Where a search landed: the files named in its output, and how many matched lines. */
function landed(call: ToolCall, projectPath: string): { found: string[]; moreFound: number; matches: number } {
  const preview = call.resultPreview ?? '';
  const files: string[] = [];
  let matches = 0;

  for (const raw of preview.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === '---') continue;
    if (/^\d+[:-]/.test(line)) {
      matches += 1;
      continue;
    }
    const path = relative(line.split(':')[0] ?? line, projectPath);
    if (path !== null && !files.includes(path) && !isHarnessPath(path)) files.push(path);
    if (/^\S+:\d+[:-]/.test(line)) matches += 1;
  }

  return {
    found: files.slice(0, FOUND_SHOWN),
    moreFound: Math.max(0, files.length - FOUND_SHOWN),
    matches,
  };
}

/**
 * A pattern as a person would say it: escapes undone, regex alternation turned
 * into a short list, and the noisier metacharacters dropped.
 */
function readable(pattern: string): string {
  // Undo escaping of punctuation (\. \" \') but leave regex classes (\d \w)
  // to be stripped below.
  const unescaped = pattern.replace(/\\([^A-Za-z0-9])/g, '$1');
  const alternatives = unescaped
    .split('|')
    .map((part) =>
      part
        // A case-insensitive class is one letter to a reader: [Ee] → E.
        .replace(/\[([A-Za-z])[A-Za-z]*\]/g, '$1')
        .replace(/\.\*|\.\+/g, '')
        .replace(/[[\]()^$*+?{}]|\\[a-zA-Z]/g, '')
        .replace(/["']/g, '')
        .replace(/\s+/g, ' ')
        // Leftover punctuation at either end reads as damage, not as a query.
        .replace(/^[^\p{L}\p{N}_@#$.]+|[^\p{L}\p{N}_)]+$/gu, '')
        .trim(),
    )
    .filter((part) => part !== '');

  if (alternatives.length === 0) return clip(unescaped);
  const shown = alternatives.slice(0, ALTERNATIVES_SHOWN).join(', ');
  const rest = alternatives.length - ALTERNATIVES_SHOWN;
  return clip(rest > 0 ? `${shown} +${rest}` : shown);
}

function clip(text: string): string {
  return text.length <= SUBJECT_MAX ? text : `${text.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || /^[\w.-]+\/[\w./-]+$/.test(value);
}

/** A project-relative path, or null when the token isn't one of this project's files. */
function relative(token: string, projectPath: string): string | null {
  const clean = token.replace(/^["']|["']$/g, '').trim();
  if (clean === '' || !/[/.]/.test(clean)) return null;
  if (projectPath !== '' && clean.startsWith(projectPath)) {
    const rest = clean.slice(projectPath.length).replace(/^\//, '');
    return rest === '' ? null : rest;
  }
  if (clean.startsWith('/')) return null; // outside the project — not useful
  return /\.\w{1,8}$/.test(clean) ? clean : null;
}

/** The file a read-only command was pointed at (`sed -n '1,80p' src/app.ts`). */
function shellTargetFile(command: string, projectPath: string): string | null {
  const tokens = [...command.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) continue;
    const path = relative(token, projectPath);
    if (path !== null) return path;
  }
  return null;
}

/** Screenshots and pasted media are attachments, not parts of the codebase. */
function isAttachment(path: string): boolean {
  return /\s/.test(path) || /\.(png|jpe?g|gif|webp|pdf|mov|mp4)$/i.test(path);
}

/** Files a later debug sequence credits with its breakthrough. */
function criticalFiles(analyzed: AnalyzedSession): Set<string> {
  const files = new Set<string>();
  for (const sequence of analyzed.debugSequences) {
    if (sequence.breakthroughCause === null) continue;
    files.add(sequence.breakthroughCause.replace(/^read /, ''));
  }
  return files;
}

/** Subjects already looked at before this phase, so revisits can be marked. */
function subjectsSeenBefore(session: Session, startIndex: number): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < startIndex; i++) {
    for (const call of session.turns[i]?.toolCalls ?? []) {
      const step = lookAt(call, session.projectPath, i);
      if (step !== null) seen.add(step.subject);
    }
  }
  return seen;
}
