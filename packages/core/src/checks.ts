/**
 * Shell vocabulary: what a bash command is actually doing.
 *
 * A leaf module on purpose: phase segmentation, the verify result, the debug
 * chain labels and the parser all need the same answer, and the viewer must
 * never re-implement it in a component.
 */

import type { ToolCall } from './types.js';

export const CHECK_CATEGORIES: Record<string, RegExp> = {
  test: /\b(test|tests|vitest|jest|pytest|cargo test|go test)\b/,
  typecheck: /\b(typecheck|type-check|tsc|mypy)\b/,
  lint: /\b(lint|eslint|ruff|clippy|go vet)\b/,
  build: /\b(build|cargo build|go build)\b/,
};

const SHORT_LABEL: Record<string, string> = {
  test: 'TEST',
  typecheck: 'TYPES',
  lint: 'LINT',
  build: 'BUILD',
};

const LONG_LABEL: Record<string, string> = {
  test: 'Tests',
  typecheck: 'Typecheck',
  lint: 'Lint',
  build: 'Build',
};

/**
 * The check category a command belongs to, or null when it isn't a check.
 *
 * Matched against the command's bare tokens only. Matching the raw string made
 * `rg -n "authorId" src -g '!*.test.*'` look like a test run — the word "test"
 * was in a glob, not in the program being run.
 */
export function checkCategory(command: string): string | null {
  const text = runnableTokens(command);
  if (text === '') return null;
  for (const [category, pattern] of Object.entries(CHECK_CATEGORIES)) {
    if (pattern.test(text)) return category;
  }
  return null;
}

/**
 * The words a command is actually invoking: quoted strings, flags, paths and
 * globs removed. `cd "/x" && pnpm turbo typecheck --filter @webshop/api` reduces
 * to "cd pnpm turbo typecheck".
 */
function runnableTokens(command: string): string {
  return command
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '' && !token.startsWith('-') && !/[/*.$]/.test(token))
    .join(' ');
}

/** "pnpm test webhooks" → "TEST"; unrecognized commands keep their first word. */
export function checkLabel(command: string): string {
  const category = checkCategory(command);
  return category === null ? firstToken(command).toUpperCase() : (SHORT_LABEL[category] ?? 'RUN');
}

/** "pnpm typecheck" → "Typecheck"; unrecognized commands keep their first word. */
export function checkTitle(command: string): string {
  const category = checkCategory(command);
  return category === null ? firstToken(command) : (LONG_LABEL[category] ?? firstToken(command));
}

export function commandOf(call: ToolCall): string {
  const command = call.input['command'];
  return typeof command === 'string' ? command : call.name;
}

function firstToken(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? command;
  return token.split('/').pop() ?? token;
}

// ---------------------------------------------------------------------------
// What a shell command is doing
// ---------------------------------------------------------------------------

/**
 * Claude Code explores through the shell far more than through the Read and
 * Grep tools — `rg`, `sed -n`, `cat`, `git log`. Counting those as generic
 * "bash" made read-only investigation look like execution, so segments of pure
 * searching were classified as write-heavy `execute` phases with zero writes.
 */
export type ShellKind = 'search' | 'read' | 'check' | 'other';

const SEARCH_RE = /^(rg|ag|ack|grep|egrep|fgrep|find|fd|glob|locate)\b/;
const READ_RE = /^(cat|bat|head|tail|less|more|sed|awk|wc|file|stat|ls|tree|pwd|jq|column)\b/;
const GIT_READ_RE = /^git\s+(log|diff|status|show|blame|branch|remote|describe|rev-parse|ls-files)\b/;
/**
 * `sed -i` and `awk > file` write; only their read-only forms count as reads.
 * Stderr plumbing (`2>&1`, `2>/dev/null`) is not writing — treating it as such
 * made half the ripgreps in a session look like mutations.
 */
const MUTATING_RE = /(^|\s)(-i\b|--in-place\b)|(^|[^>&\d])>[^>&]|>>/;

export function shellKind(command: string): ShellKind {
  const text = command
    .trim()
    .toLowerCase()
    .replace(/\d?>\s*&\s*\d/g, ' ') // 2>&1
    .replace(/\d?>\s*\/dev\/null/g, ' ');
  if (checkCategory(text) !== null) return 'check';
  // Compound commands are classified by their first segment; a pipeline that
  // starts with a search is still a search.
  const head = text.split(/\s*(?:\|\||&&|\||;)\s*/)[0]?.trim() ?? text;
  const bare = head.replace(/^(sudo|command|time|env|npx|pnpm dlx)\s+/, '');
  if (MUTATING_RE.test(bare)) return 'other';
  if (SEARCH_RE.test(bare)) return 'search';
  if (READ_RE.test(bare) || GIT_READ_RE.test(bare)) return 'read';
  return 'other';
}

/** True when a bash call only looked at the codebase. */
export function isReadOnlyShell(command: string): boolean {
  const kind = shellKind(command);
  return kind === 'search' || kind === 'read';
}

/**
 * The path a search or read command was pointed at, for the explore trail.
 * Quoted absolute paths are the common shape (`rg -n "x" "/Users/…/src"`).
 */
export function shellTarget(command: string, projectPath: string): string | null {
  const quoted = [...command.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? '');
  const bare = command.split(/\s+/).filter((token) => token.startsWith('/') || token.startsWith('./'));
  for (const candidate of [...quoted, ...bare]) {
    if (candidate === '' || !candidate.includes('/')) continue;
    if (projectPath !== '' && candidate.startsWith(projectPath)) {
      const relative = candidate.slice(projectPath.length).replace(/^\//, '');
      if (relative !== '') return relative;
    }
    if (candidate.startsWith('/')) continue; // outside the project — not useful
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harness-owned files
// ---------------------------------------------------------------------------

/**
 * Files Claude Code writes for itself — plan documents, settings, transcripts.
 * They are not the developer's code, so counting them as "files changed" (and
 * their prose as +68 lines) misreports what a session actually did.
 */
export function isHarnessPath(filePath: string): boolean {
  return /(^|\/)\.claude(\/|$)/.test(filePath);
}

// ---------------------------------------------------------------------------
// Reading failure output
// ---------------------------------------------------------------------------

/**
 * What a failure message sounds like. Deliberately broad on the second half:
 * the most useful line is often advice rather than an error word — "Please make
 * sure your database server is running at …" contains none of the keywords.
 */
const FAILURE_MESSAGE =
  /(?:^|[\s:[(])(?:error|fail(?:ed|ure)?|exception|cannot|can't|could not|couldn't|unable|invalid|denied|refused|unreachable|timed out|not found|no such|not running|does not|doesn't|is not|are not|missing|make sure|expected)\b/i;

/**
 * The line of output that says what went wrong, or null when nothing does.
 *
 * Build tools print pages of progress before the failure, so the first line is
 * usually "cache miss, executing…" — and an echoed command ("$ tsx script.ts")
 * is not a diagnosis. Prefer a line that reads like an error; say nothing
 * rather than quote a line that cannot be vouched for.
 */
export function failureLine(text: string | null, maxChars = 72): string | null {
  if (text === null) return null;
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const useful = lines.filter(
    (line) =>
      !/^(at\s|>\s|\$\s|\.\.\.)/.test(line) &&
      !/:\s*>\s/.test(line) &&
      !/^\/\S+$/.test(line) &&
      !line.endsWith(':') &&
      line.split(/\s+/).length >= 3,
  );
  const chosen = useful.find((line) => FAILURE_MESSAGE.test(line));
  if (chosen === undefined) return null;
  const shortened = chosen.replace(/(^|[\s"'(])\/[^\s"')]*\/([^\s"'/)]+\/[^\s"')]+)/g, '$1…/$2');
  return shortened.length <= maxChars ? shortened : `${shortened.slice(0, maxChars - 1).trimEnd()}…`;
}
