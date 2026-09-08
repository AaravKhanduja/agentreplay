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

/**
 * The plan a call filed, or null when it filed none.
 *
 * Read by shape rather than by tool name: one agent submits a plan document
 * when it leaves plan mode, another files a list of steps mid-run, and both
 * arrive here as a `plan` string because their parsers put one there.
 */
export function planText(call: ToolCall): string | null {
  const plan = call.input['plan'];
  return typeof plan === 'string' && plan.trim() !== '' ? plan.trim() : null;
}

/**
 * A call that sent a subagent out to look at something — investigation, not
 * work. Named tools, because there is no shape that distinguishes delegation,
 * and every agent's name for it belongs in one list rather than in `phases.ts`.
 */
export function isDelegation(call: ToolCall): boolean {
  return call.name === 'Agent' || call.name === 'Task';
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
export type ShellKind = 'search' | 'read' | 'check' | 'write' | 'other';

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
  // Before MUTATING_RE, which knows only that *something* was written. This
  // knows what, and to where — and it reads the raw command, because `text` is
  // lowercased and paths are not.
  if (collectWrites(command).length > 0) return 'write';
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
 * Files an agent writes for itself — plan documents, settings, transcripts.
 * They are not the developer's code, so counting them as "files changed" (and
 * their prose as +68 lines) misreports what a session actually did.
 *
 * Every agent's directory, not just the one that produced this session: a
 * session that edits another agent's config is still not editing the project.
 * Kept as a plain predicate because the three heuristics that ask have only a
 * path in hand, and threading a source into them would buy nothing.
 */
export function isHarnessPath(filePath: string): boolean {
  return /(^|\/)\.(claude|codex)(\/|$)/.test(filePath);
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

// ---------------------------------------------------------------------------
// Writing through the shell
// ---------------------------------------------------------------------------

/**
 * One file a shell command writes, with the change itself when the command
 * carries it literally.
 *
 * Agents that have no edit tool do all their editing here — a Codex session is
 * almost entirely `exec_command` — but Claude Code writes this way too, and
 * those edits were invisible: no file graph entry, no debug loop, and a header
 * reading "0 files changed" on a session that rewrote the repo.
 */
export interface ShellWrite {
  /** Project-relative when inside the project. */
  path: string;
  mode: 'create' | 'append' | 'patch' | 'inplace';
  /** The new content, when the command spells it out. Null when it doesn't. */
  body: string | null;
  /** Old/new pairs, in the shape `extractDiff` reads. */
  edits: Array<{ oldText: string; newText: string }>;
}

/** A heredoc: the command text before `<<`, and the body it carries. */
interface Heredoc {
  intro: string;
  body: string;
}

/**
 * Heredocs, in order. The body runs to a line that is exactly the terminator,
 * which is why this is line-based rather than a regex over the whole command.
 */
function heredocs(command: string): { docs: Heredoc[]; rest: string[] } {
  const lines = command.split('\n');
  const docs: Heredoc[] = [];
  const rest: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const start = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (start === null) {
      rest.push(line);
      continue;
    }
    const terminator = start[2] ?? '';
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if ((lines[j] ?? '').trim() === terminator) break;
      body.push(lines[j] ?? '');
    }
    // The whole line minus the marker: `cat <<'EOF' | tee -a log.txt` keeps
    // both the redirect before it and the pipeline after it.
    const intro = line.slice(0, start.index) + line.slice(start.index + start[0].length);
    docs.push({ intro, body: body.join('\n') });
    i = j; // skip the body and its terminator
  }
  return { docs, rest };
}

/** Strip the quotes a shell path is usually written with. */
function unquote(token: string): string {
  const match = /^(['"])(.*)\1$/.exec(token);
  return match?.[2] ?? token;
}

/**
 * The redirect target in a command fragment, and whether it appends.
 * Stderr plumbing is not a write: `2>&1` and `>/dev/null` are stripped by the
 * caller, and a bare `>` with no path is ignored.
 */
function redirect(intro: string): { path: string; append: boolean } | null {
  const match = /(>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s|&;<>]+))/.exec(intro);
  if (match === null) return null;
  const path = match[2] ?? match[3] ?? match[4] ?? '';
  if (path === '') return null;
  return { path, append: match[1] === '>>' };
}

/** `tee out.txt` / `tee -a out.txt` — the first argument that isn't a flag. */
function teeTarget(intro: string): { path: string; append: boolean } | null {
  const match = /(^|[|&;]\s*)tee\s+([^|&;<>]*)/.exec(intro);
  if (match === null) return null;
  const args = (match[2] ?? '').trim().split(/\s+/).filter((a) => a !== '');
  const append = args.some((a) => a === '-a' || a === '--append');
  const path = args.find((a) => !a.startsWith('-'));
  return path === undefined ? null : { path: unquote(path), append };
}

/**
 * Consecutive `-`/`+` runs in a diff body, paired. A run of deletions followed
 * by additions is one edit; either alone is a deletion or an insertion.
 */
function pairsFromHunk(lines: string[]): Array<{ oldText: string; newText: string }> {
  const pairs: Array<{ oldText: string; newText: string }> = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    if (removed.length > 0 || added.length > 0) {
      pairs.push({ oldText: removed.join('\n'), newText: added.join('\n') });
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line.startsWith('-')) {
      if (added.length > 0) flush(); // a new run starts
      removed.push(line.slice(1));
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    } else {
      flush();
    }
  }
  flush();
  return pairs;
}

/**
 * Codex's `apply_patch` envelope: `*** Begin Patch`, then a section per file.
 * The one write shape where both the path and the change are recoverable.
 */
function parseApplyPatch(body: string): ShellWrite[] {
  const writes: ShellWrite[] = [];
  let path: string | null = null;
  let add = false;
  let hunk: string[] = [];

  const flush = (): void => {
    if (path === null) return;
    const edits = add
      ? [{ oldText: '', newText: hunk.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n') }]
      : pairsFromHunk(hunk);
    if (edits.length > 0) writes.push({ path, mode: 'patch', body: null, edits });
    path = null;
    hunk = [];
  };

  for (const line of body.split('\n')) {
    const header = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (header !== null) {
      flush();
      // A deletion carries no content, so there is nothing to show as a diff.
      if (header[1] === 'Delete') continue;
      path = header[2] ?? null;
      add = header[1] === 'Add';
      continue;
    }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) {
      flush();
      continue;
    }
    if (path !== null && !line.startsWith('@@')) hunk.push(line);
  }
  flush();
  return writes;
}

/** A unified diff, as fed to `git apply` or `patch`. */
function parseUnifiedDiff(body: string): ShellWrite[] {
  const writes: ShellWrite[] = [];
  let path: string | null = null;
  let hunk: string[] = [];

  const flush = (): void => {
    if (path === null) return;
    const edits = pairsFromHunk(hunk);
    if (edits.length > 0) writes.push({ path, mode: 'patch', body: null, edits });
    path = null;
    hunk = [];
  };

  for (const line of body.split('\n')) {
    const target = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line);
    if (target !== null) {
      flush();
      const name = target[1] ?? '';
      path = name === '/dev/null' ? null : name;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git')) continue;
    if (path !== null && !line.startsWith('@@')) hunk.push(line);
  }
  flush();
  return writes;
}

/** `sed -i 's/old/new/' file` — BSD's mandatory empty suffix included. */
function parseSedInPlace(fragment: string): ShellWrite[] {
  if (!/(^|\s)sed\s/.test(fragment) || !/\s-i\b|--in-place\b/.test(fragment)) return [];
  const edits: Array<{ oldText: string; newText: string }> = [];
  for (const match of fragment.matchAll(/s([/|#,])((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/g)) {
    edits.push({ oldText: match[2] ?? '', newText: match[3] ?? '' });
  }
  // The path is the last bare token: everything after the flags and the script.
  const tokens = fragment.trim().split(/\s+/).map(unquote);
  const path = tokens[tokens.length - 1];
  if (path === undefined || path.startsWith('-') || !/[/.]/.test(path)) return [];
  return [{ path, mode: 'inplace', body: null, edits }];
}

/** Commands that spell out the content they write. Anything else is guesswork. */
const LITERAL_WRITER = /(^|[|&;]\s*)(cat|tee|echo|printf)\b/;

/**
 * Every file this command writes. `[]` when it writes none — and also when the
 * command is too unusual to read confidently, because a wrong path in the file
 * graph is worse than a missing one.
 *
 * Deliberately not built on `shellKind`'s preprocessing: that lowercases the
 * command, and paths and file contents are case-sensitive.
 */
export function shellWrites(command: string, projectPath = ''): ShellWrite[] {
  return resolveWrites(collectWrites(command), projectPath);
}

/**
 * The writes a patch document makes, project-relative.
 *
 * The `*** Begin Patch` format reaches this repo two ways: a heredoc piped to
 * `apply_patch` in the shell, and an agent whose own patch tool files the same
 * text as the call's argument. Same format, so it gets one parser rather than
 * one per source — the reader that has a patch in hand calls this instead of
 * dressing it up as a shell command first.
 */
export function applyPatchWrites(patch: string, projectPath = ''): ShellWrite[] {
  return resolveWrites(parseApplyPatch(patch), projectPath);
}

/** Drop the writes that land outside the project; make the rest relative. */
function resolveWrites(writes: ShellWrite[], projectPath: string): ShellWrite[] {
  return writes.flatMap((write) => {
    const path = resolveWritePath(write.path, projectPath);
    return path === null ? [] : [{ ...write, path }];
  });
}

/**
 * The same reading, before the project filter. `shellKind` needs to know that a
 * command writes at all, including to a path this project doesn't own.
 */
function collectWrites(command: string): ShellWrite[] {
  // Stderr plumbing is not a write. `>/dev/null` especially: it looks like a
  // redirect to a path and would otherwise be reported as an edited file.
  const cleaned = command
    .replace(/\d?>\s*&\s*\d/g, ' ')
    .replace(/\d?>>?\s*\/dev\/null/g, ' ');

  const { docs, rest } = heredocs(cleaned);
  const writes: ShellWrite[] = [];

  for (const doc of docs) {
    if (/(^|\s)apply_patch\b/.test(doc.intro)) {
      writes.push(...parseApplyPatch(doc.body));
      continue;
    }
    if (/(^|\s)git\s+apply\b/.test(doc.intro) || /(^|\s)patch\s+-p\d/.test(doc.intro)) {
      writes.push(...parseUnifiedDiff(doc.body));
      continue;
    }
    // `cat > f <<EOF` and `tee f <<EOF` write the body verbatim. A heredoc fed
    // to an interpreter (`python3 - <<PY`) writes whatever the script decides,
    // which is not knowable from here.
    if (!LITERAL_WRITER.test(doc.intro)) continue;
    const target = teeTarget(doc.intro) ?? redirect(doc.intro);
    if (target === null) continue;
    writes.push({
      path: unquote(target.path),
      mode: target.append ? 'append' : 'create',
      body: doc.body,
      edits: [{ oldText: '', newText: doc.body }],
    });
  }

  for (const fragment of rest.join('\n').split(/[\n;]|&&|\|\|/)) {
    if (fragment.trim() === '') continue;
    writes.push(...parseSedInPlace(fragment));
    if (!LITERAL_WRITER.test(fragment)) continue;
    const target = teeTarget(fragment) ?? redirect(fragment);
    if (target === null) continue;
    // `echo hi > f` and `printf '%s' x > f`: the literal is the new content.
    const literal = /(?:echo|printf)\s+(.*?)\s*>{1,2}/.exec(fragment);
    const body = literal === null ? null : unquote((literal[1] ?? '').trim());
    writes.push({
      path: unquote(target.path),
      mode: target.append ? 'append' : 'create',
      body,
      edits: body === null ? [] : [{ oldText: '', newText: body }],
    });
  }

  return writes;
}

/**
 * A write target, project-relative. Null for paths outside the project — a
 * command that writes to /tmp or to a sibling checkout did not change this
 * repo, and counting it would inflate "files changed".
 */
function resolveWritePath(filePath: string, projectPath: string): string | null {
  // A path that is still a shell variable is a path this reader cannot resolve.
  // `tmpfile=$(mktemp); cat > "$tmpfile" <<EOF` — a PR body on its way to
  // `gh pr create` — was landing in the file graph as a file literally named
  // `$tmpfile`, and in the drawer as a tool named `tmpfile=$(mktemp)`. Whatever
  // it expanded to, it was not a file in this project.
  if (filePath === '' || filePath.includes('*') || filePath.includes('$')) return null;
  if (!filePath.startsWith('/')) return filePath.replace(/^\.\//, '');
  if (projectPath === '') return null;
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return filePath.startsWith(root) ? filePath.slice(root.length) : null;
}
