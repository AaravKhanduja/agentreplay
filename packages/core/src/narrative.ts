/**
 * The brief: the replay's text layer — a session title, the header stats, at
 * most one headline sentence, 2–4 ranked takeaways, and a head per phase
 * section. Deliberately thin: the replay's meaning is carried by structure
 * (trails, plan steps, debug chains), not by prose, so there are no phase
 * stories here to write. Ollama may polish the title and takeaway wording
 * (never adding facts) in ollama.ts.
 *
 * Pure and deterministic: no I/O, no throwing — thin data degrades to fewer
 * and simpler sentences. Output is styled spans (RichText), never HTML.
 * Cross-session facts (I/O) arrive pre-computed via BriefExtras.
 */

import { checkCategory, checkTitle, commandOf } from './checks.js';
import { pickBlocker, pickDecision, pickRootCause } from './events.js';
import { planObjective } from './plans.js';
import { summarizeConclusion } from './summary.js';
import { deriveTitle } from './title.js';
import { countChanges } from './verify.js';
import type {
  AnalyzedSession,
  Brief,
  BriefExtras,
  BriefStats,
  DebugSequence,
  NarrativeSpan,
  NarrativeStyle,
  Phase,
  PlanRevision,
  RichText,
  SectionHead,
  Takeaway,
  ToolCall,
  Turn,
} from './types.js';

const THIN_TURN_FLOOR = 5;
const MAX_TAKEAWAYS = 4;
const INTENT_MAX_CHARS = 150;

export function buildBrief(analyzed: AnalyzedSession, extras: BriefExtras = {}): Brief {
  const title = deriveTitle(analyzed.session);
  const stats = buildStats(analyzed);

  const openingPrompt = openingAsk(analyzed.session.turns);

  if (analyzed.session.turns.length < THIN_TURN_FLOOR) {
    return {
      title,
      openingPrompt,
      stats,
      headline: null,
      rootCause: null,
      decision: null,
      blocker: null,
      pivots: [],
      takeaways: [],
      sections: [],
      thin: true,
    };
  }

  const line = headline(analyzed);
  return {
    title,
    openingPrompt,
    stats,
    headline: line === null ? null : tidy(line),
    rootCause: pickRootCause(analyzed.events),
    decision: pickDecision(analyzed.events),
    blocker: pickBlocker(analyzed.events),
    pivots: analyzed.events.filter((event) => event.kind === 'pivot'),
    takeaways: buildTakeaways(analyzed, extras),
    sections: analyzed.phases.map((phase, index) => buildSectionHead(analyzed, phase, index)),
    thin: false,
  };
}

/** Header stats. No duration: the topbar prints it and the phase bars encode it. */
function buildStats(analyzed: AnalyzedSession): BriefStats {
  const { filesChanged, added, removed } = countChanges(analyzed);
  const toolCalls = analyzed.session.turns.reduce((n, turn) => n + turn.toolCalls.length, 0);
  const check = sessionCheck(analyzed);
  // A session that ended blocked did not "fail its typecheck" — it stopped.
  if (pickBlocker(analyzed.events) !== null) {
    return { toolCalls, filesChanged, added, removed, outcome: 'blocked', outcomeCheck: null };
  }
  return { toolCalls, filesChanged, added, removed, outcome: check.result, outcomeCheck: check.label };
}

// ---------------------------------------------------------------------------
// Span + formatting helpers
// ---------------------------------------------------------------------------

function plain(text: string): NarrativeSpan {
  return { text };
}

function styled(text: string, style: NarrativeStyle): NarrativeSpan {
  return { text, style };
}

/** Drop empty spans and make sure the passage ends with punctuation. */
function tidy(rich: RichText): RichText {
  const spans = rich.filter((span) => span.text !== '');
  const last = spans[spans.length - 1];
  if (last !== undefined && !/[.!?]["')\]]?$/.test(last.text.trimEnd())) spans.push(plain('.'));
  return spans;
}

/** "21 minutes" under 90 minutes, "1h 24m" above, digits always. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "13m" / "1h 05m" — compact form for badges and stat lines. */
function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "10:33" — local wall-clock time. */
function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Human error name: "TypeError" style when present, else the trimmed signature. */
function errorName(text: string, signature: string): string {
  const named = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/.exec(text);
  if (named?.[1] !== undefined) return named[1];
  const sig = signature.trim();
  if (sig === '') return 'the error';
  if (sig.length <= 48) return sig;
  // Truncate at a word boundary — "expecte…" reads worse than a shorter cut.
  const cut = sig.slice(0, 47);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 24 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * How to refer to a stall's error in a sentence. A real identifier
 * ("TypeError") reads well inline; half a quoted error message does not, so
 * anything else becomes "failure".
 */
function errorPhrase(stall: Stall): string {
  return /^[A-Z][A-Za-z]*(Error|Exception)$/.test(stall.errorName) ? stall.errorName : 'failure';
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// Shared lookups over the analysis
// ---------------------------------------------------------------------------

function phaseCalls(analyzed: AnalyzedSession, phase: Phase): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    calls.push(...(analyzed.session.turns[i]?.toolCalls ?? []));
  }
  return calls;
}

/** The file behind a sequence's breakthroughCause ("read path"), if any. */
function breakthroughFile(sequence: DebugSequence): string | null {
  const cause = sequence.breakthroughCause;
  if (cause === null || !cause.startsWith('read ')) return null;
  const path = cause.slice('read '.length).trim();
  return path === '' ? null : path;
}

type Resolution = 'passed' | 'failing' | 'unknown';

/**
 * Outcome of the last *check* in a turn range.
 *
 * Only test/typecheck/lint/build commands count. Any bash call used to count,
 * which meant a failed `gcloud` lookup — or an `rg` that exited 1 because it
 * found no matches — was reported as "tests were still failing" in sessions
 * where no test ever ran.
 */
function lastCheck(turns: Turn[], start: number, end: number): { result: Resolution; label: string | null } {
  let result: Resolution = 'unknown';
  let label: string | null = null;
  for (let i = start; i <= end && i < turns.length; i++) {
    for (const call of turns[i]?.toolCalls ?? []) {
      const command = commandOf(call);
      if (call.category !== 'bash' || checkCategory(command) === null) continue;
      if (call.outcome === 'success') result = 'passed';
      else if (call.outcome === 'error') result = 'failing';
      else continue;
      label = checkTitle(command);
    }
  }
  return { result, label };
}

function sessionCheck(analyzed: AnalyzedSession): { result: Resolution; label: string | null } {
  const check = lastCheck(analyzed.session.turns, 0, analyzed.session.turns.length - 1);
  if (check.result !== 'unknown') return check;
  return { result: loopResolution(analyzed), label: null };
}

function sessionResolution(analyzed: AnalyzedSession): Resolution {
  return sessionCheck(analyzed).result;
}

function loopResolution(analyzed: AnalyzedSession): Resolution {
  let lastLoopResult: Resolution = 'unknown';
  for (const sequence of analyzed.debugSequences) {
    const last = sequence.loops[sequence.loops.length - 1];
    if (last !== undefined) lastLoopResult = last.result === 'passed' ? 'passed' : 'failing';
  }
  return lastLoopResult;
}

interface Stall {
  sequence: DebugSequence;
  run: DebugSequence['stuckRuns'][number];
  attempts: number;
  durationMs: number;
  errorName: string;
  /** Set when every attempt in the stuck run edited the same file. */
  sameFile: string | null;
}

/** All stuck runs across all debug sequences, with durations. */
function findStalls(analyzed: AnalyzedSession): Stall[] {
  const stalls: Stall[] = [];
  for (const sequence of analyzed.debugSequences) {
    for (const run of sequence.stuckRuns) {
      const loops = sequence.loops.filter((loop) => loop.index >= run.startLoop && loop.index <= run.endLoop);
      const first = loops[0];
      if (first === undefined) continue;
      const paths = new Set(loops.map((loop) => loop.attempt.filePath));
      stalls.push({
        sequence,
        run,
        attempts: loops.length,
        // Computed once, in loops.ts — the chain's stuck block shows the
        // same number as the headline, because it is the same number.
        durationMs: run.durationMs,
        errorName: errorName(first.error.text, run.errorSignature),
        sameFile: paths.size === 1 ? first.attempt.filePath : null,
      });
    }
  }
  return stalls;
}

/** The longest stall (the session's defining stuck moment), if any. */
function mainStall(analyzed: AnalyzedSession): Stall | undefined {
  return findStalls(analyzed).sort((a, b) => b.durationMs - a.durationMs || b.attempts - a.attempts)[0];
}

function phaseResolution(analyzed: AnalyzedSession, phase: Phase, sequence: DebugSequence): Resolution {
  const last = sequence.loops[sequence.loops.length - 1];
  if (last !== undefined && last.result === 'passed') return 'passed';
  // The run that vindicates the last attempt often lands just past the phase
  // boundary (segmentation cuts at user turns) — scan from the last loop to
  // the end of the session, not just to the phase edge.
  const from = last?.turnIndex ?? phase.startIndex;
  const bash = lastCheck(analyzed.session.turns, from, analyzed.session.turns.length - 1).result;
  if (bash !== 'unknown') return bash;
  if (last !== undefined) return 'failing';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Headline — one finding, or nothing at all
// ---------------------------------------------------------------------------

/**
 * At most two sentences, and only when the session actually found something:
 * a stall and what broke it, or an unambiguous outcome. The old hero sentence
 * enumerated counts ("explored 12 files, edited 5 files") — those numbers now
 * live in the header stats and the phase bars, where they read faster and
 * don't sound like a generated performance review.
 */
function headline(analyzed: AnalyzedSession): RichText | null {
  const stall = mainStall(analyzed);
  // A session that stopped did not fail its checks — `buildStats` already
  // makes that call for the outcome, and the headline has to make the same one
  // or it prints "Typecheck was still failing" over a blocker that says the
  // script typechecks.
  const blocked = pickBlocker(analyzed.events) !== null;
  const resolution = blocked ? 'unknown' : sessionResolution(analyzed);

  // Being blocked is not a finding. It is where the session stopped, the
  // header stats already say `blocked`, and `Outcomes` prints what stopped it
  // under `blocked on` — leading with the same sentence a third time, in full,
  // put the last thing that happened at the top of the page before the reader
  // knew what the session was about.

  if (stall !== undefined) {
    const spans: NarrativeSpan[] = [
      styled(formatDuration(stall.durationMs), 'bad'),
      plain(' went to repeating the same '),
      styled(errorPhrase(stall), 'bad'),
      plain('.'),
    ];
    const cause = breakthroughFile(stall.sequence);
    if (cause !== null) {
      spans.push(plain(' Reading '), styled(cause, 'file'), plain(' '), styled('broke the loop', 'good'), plain('.'));
    } else if (resolution === 'failing') {
      const label = sessionCheck(analyzed).label ?? 'Checks';
      spans.push(plain(' '), styled(`${label} still failing at session end`, 'bad'), plain('.'));
    }
    return spans;
  }

  if (resolution === 'failing') {
    const label = sessionCheck(analyzed).label ?? 'Checks';
    return [styled(`${label} ${label === 'Tests' ? 'were' : 'was'} still failing when the session ended`, 'bad'), plain('.')];
  }

  if (resolution === 'passed' && analyzed.editHistories.length > 0) {
    const retried = analyzed.editHistories.some((history) => history.finalOutcome !== 'clean');
    if (!retried) {
      return [styled('Everything passed first try', 'good'), plain(' — no retries, no stalls.')];
    }
  }

  // Nothing worth saying. The structure below says the rest.
  return null;
}

// ---------------------------------------------------------------------------
// Section heads
// ---------------------------------------------------------------------------

const KIND_TITLE = {
  explore: 'Explore',
  plan: 'Plan',
  execute: 'Execute',
  debug: 'Debug',
  verify: 'Verify',
} as const;

function buildSectionHead(analyzed: AnalyzedSession, phase: Phase, index: number): SectionHead {
  const repeats = analyzed.phases.filter((p) => p.kind === phase.kind).length;
  const ordinal = analyzed.phases.slice(0, index + 1).filter((p) => p.kind === phase.kind).length;
  const title = repeats > 1 ? `${KIND_TITLE[phase.kind]} (${ordinal})` : KIND_TITLE[phase.kind];

  return {
    phaseIndex: index,
    title,
    chasing: chasingOf(analyzed, phase, index),
    summary: summarizeConclusion(analyzed.session, phase, analyzed),
    components: componentsOf(analyzed, phase, index),
    intent: intentOf(analyzed, phase),
    timeRange: `${clock(phase.startedAt)}–${clock(phase.endedAt)}`,
    statLine: statLine(analyzed, phase),
    badge: badge(analyzed, phase, index),
  };
}

/**
 * The request that started the session, verbatim.
 *
 * The title is a compression of it and loses detail on purpose; the page still
 * has to show what was actually asked for, or the reader is left guessing what
 * any of the phases were in service of.
 */
const OPENING_MAX_CHARS = 260;

function openingAsk(turns: Turn[]): string | null {
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const quote = condenseAsk(turn.text, OPENING_MAX_CHARS);
    if (quote !== null) return quote;
  }
  return null;
}

/**
 * What a debug phase kept hitting. The conclusion quote often reports something
 * incidental ("those diagnostics are just the IDE type-checking…"); the failure
 * being retried is what the phase was actually about.
 */
function chasingOf(analyzed: AnalyzedSession, phase: Phase, _index: number): string | null {
  if (phase.kind !== 'debug') return null;
  const sequences = analyzed.debugSequences.filter((sequence) =>
    sequence.loops.some((loop) => loop.turnIndex >= phase.startIndex && loop.turnIndex <= phase.endIndex),
  );
  if (sequences.length === 0) return null;

  const runs = sequences.flatMap((sequence) =>
    sequence.stuckRuns.map((run) => ({ sequence, run, size: run.endLoop - run.startLoop + 1 })),
  );
  const worst = runs.sort((a, b) => b.size - a.size)[0];
  const loop =
    worst === undefined
      ? sequences[0]?.loops.find((candidate) => candidate.errorLine !== '')
      : worst.sequence.loops.find((candidate) => candidate.index === worst.run.startLoop);
  if (loop === undefined) return null;

  const what = loop.errorLine === '' ? `${loop.check.label.toLowerCase()} failing` : loop.errorLine;
  const where = basename(loop.attempt.filePath);
  const times = worst === undefined ? '' : ` ×${worst.size}`;
  return clip(`${what} — ${where}${times}`, 150);
}

/**
 * The files (or checks) a phase was about — the one line under the summary.
 *
 * Ranked so the most telling one leads: a file that later broke a stall first,
 * then whatever the phase kept returning to. Four at most; a list longer than
 * that is a directory listing, not a pointer.
 */
function componentsOf(analyzed: AnalyzedSession, phase: Phase, index: number): string[] {
  const ranked: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | null | undefined): void => {
    if (path === undefined || path === null || path === '') return;
    // Pasted screenshots and attachments are not part of the codebase.
    if (/\s/.test(path) || /\.(png|jpe?g|gif|webp|pdf|mov|mp4)$/i.test(path)) return;
    // Dedupe by file name: "app.ts" and "src/app.ts" are one component.
    const key = path.split('/').pop() ?? path;
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push(path);
  };

  switch (phase.kind) {
    case 'explore': {
      const trail = analyzed.trails.find((view) => view.phaseIndex === index)?.value ?? [];
      for (const step of trail) if (step.laterCritical) add(step.path);
      // Files several searches landed in are what the phase was really about.
      const hits = new Map<string, number>();
      for (const step of trail) {
        for (const file of [...step.found, ...(step.path === '' ? [] : [step.path])]) {
          hits.set(file, (hits.get(file) ?? 0) + 1);
        }
      }
      for (const [file] of [...hits.entries()].sort((a, b) => b[1] - a[1])) add(file);
      break;
    }
    case 'execute':
    case 'debug': {
      for (const sequence of analyzed.debugSequences.filter((s) => s.phaseIndex === index)) {
        add(sequence.loops[0]?.attempt.filePath);
        add(sequence.breakthroughCause?.replace(/^read /, ''));
      }
      for (const history of phaseEditFiles(analyzed, phase)) add(history.path);
      break;
    }
    case 'verify': {
      const result = analyzed.verifications.find((view) => view.phaseIndex === index)?.value;
      for (const check of result?.checks ?? []) add(check.label);
      break;
    }
    case 'plan': {
      const revisions = phaseRevisions(analyzed, phase);
      const text = revisions[revisions.length - 1]?.planText ?? '';
      // Files the plan names are the things it is about. A known source
      // extension is required, or "e.g." and "import.meta.url" qualify.
      for (const match of text.matchAll(
        /[\w./-]*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|prisma|sql|ya?ml|sh|py|rb|go|rs|md)\b(?!\()/g,
      )) {
        // `express.json()` is a call, not a file — the negative lookahead above
        // rejects it; a bare `express.json` still would not, so require a path
        // separator or a source extension that isn't also a method name.
        const token = match[0];
        if (token.includes('/') || !/\.(json|md)$/.test(token)) add(token);
      }
      break;
    }
  }

  return ranked.slice(0, 4);
}

/**
 * What this phase was for, quoted from the session.
 *
 * A section that opens with `src/webhooks/handler.ts — pass the raw Buffer…`
 * tells you what was touched but never what was wanted. The ask is already in
 * the transcript; showing it is not narration, it is the source material. Plan
 * phases prefer the plan's own objective sentence, which states the goal more
 * precisely than the message that triggered it.
 */
function intentOf(analyzed: AnalyzedSession, phase: Phase): SectionHead['intent'] {
  if (phase.kind === 'plan') {
    const revisions = phaseRevisions(analyzed, phase);
    const objective = revisions[0] === undefined ? null : planObjective(revisions[0].planText, INTENT_MAX_CHARS);
    if (objective !== null) return { quote: objective, source: 'plan' };
  }
  const ask = askBefore(analyzed.session.turns, phase.startIndex);
  return ask === null ? null : { quote: ask, source: 'user' };
}

/** The most recent thing the developer actually asked for, at or before a phase. */
function askBefore(turns: Turn[], startIndex: number): string | null {
  for (let i = Math.min(startIndex, turns.length - 1); i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined || turn.role !== 'user') continue;
    const quote = condenseAsk(turn.text);
    if (quote !== null) return quote;
  }
  return null;
}

/** A user message worth quoting: real words, no tool noise, one line. */
function condenseAsk(text: string, maxChars = INTENT_MAX_CHARS): string | null {
  const flat = text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ') // task-notification blocks and friends
    .replace(/```[\s\S]*?```/g, ' ')
    // Harness annotations the developer never typed: attachments, interrupts,
    // command echoes. Quoting one of these as "what you asked for" is a lie.
    .replace(/\[(Image|Request interrupted|Pasted text)[^\]]*\]/gi, ' ')
    .replace(/^\s*(<command-[a-z]+>|<local-command[^>]*>)[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '' || flat.startsWith('<') || flat.startsWith('[') || countWords(flat) < 3) return null;
  // A dragged-in screenshot arrives as a bare path. It is not a request.
  if (/^\S*\/\S*$/.test(flat) || /\.(png|jpe?g|gif|webp|pdf|mov|mp4)\b/i.test(flat)) return null;
  return clip(flat, maxChars);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function statLine(analyzed: AnalyzedSession, phase: Phase): string {
  switch (phase.kind) {
    case 'explore': {
      // Counting Read calls alone reported "1 file · 1 read" for a phase that
      // ran nine ripgreps; the trail is what the phase actually did.
      const trail = analyzed.trails.find((view) => view.phaseIndex === indexOf(analyzed, phase))?.value ?? [];
      const questions = new Set(
        trail.filter((step) => step.kind === 'search').map((step) => step.subject),
      ).size;
      const files = new Set(
        trail.flatMap((step) => (step.path !== '' ? [step.path] : step.found)),
      ).size;
      const parts: string[] = [];
      if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
      if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
      return parts.length > 0 ? parts.join(' · ') : `${phase.toolMix.read} reads`;
    }
    case 'plan': {
      const revisions = phaseRevisions(analyzed, phase);
      const first = revisions[0];
      const last = revisions[revisions.length - 1];
      const words =
        first !== undefined && last !== undefined && revisions.length > 1
          ? ` · ${countWords(first.planText)}→${countWords(last.planText)} words`
          : '';
      return `${revisions.length} revision${revisions.length === 1 ? '' : 's'}${words}`;
    }
    case 'execute': {
      const files = phaseEditFiles(analyzed, phase);
      const edits = files.reduce((n, f) => n + f.attempts.length, 0);
      if (edits > 0) {
        return `${edits} edit${edits === 1 ? '' : 's'} · ${files.length} file${files.length === 1 ? '' : 's'}`;
      }
      // Plenty of real work never touches the Edit tool — scripts, generators,
      // migrations. "0 edits · 0 files" describes none of it.
      const commands = phase.toolMix.bash;
      if (commands > 0) return `${commands} command${commands === 1 ? '' : 's'} run`;
      const reads = phase.toolMix.read;
      return reads > 0 ? `${reads} read${reads === 1 ? '' : 's'}` : 'no file changes';
    }
    case 'verify': {
      // The verify result is deduped by label (a re-run after a fix is the same
      // check), so count that — not raw bash calls, or the head and the summary
      // disagree about how many checks there were.
      const result = analyzed.verifications.find((view) => view.phaseIndex === indexOf(analyzed, phase))?.value;
      const checks = result?.checks ?? [];
      const passed = checks.filter((check) => check.outcome === 'success').length;
      return `${checks.length} check${checks.length === 1 ? '' : 's'} · ${passed} passed`;
    }
    case 'debug': {
      // Count what happened *in this phase*, not what was filed under it: a
      // debugging episode can start in one phase and finish in the next, and a
      // phase full of attempts must never report "0 loops".
      const loops = phaseLoops(analyzed, phase).length;
      const sequences = analyzed.debugSequences.filter((s) =>
        s.loops.some((loop) => loop.turnIndex >= phase.startIndex && loop.turnIndex <= phase.endIndex),
      );
      // Runs and breakthroughs are counted the same way as the loops: only the
      // part that happened inside this phase, or the numbers contradict.
      const inPhase = (loop: { turnIndex: number }): boolean =>
        loop.turnIndex >= phase.startIndex && loop.turnIndex <= phase.endIndex;
      const stuck = sequences.reduce(
        (n, sequence) =>
          Math.max(
            n,
            ...sequence.stuckRuns.map(
              (run) =>
                sequence.loops.filter(
                  (loop) => loop.index >= run.startLoop && loop.index <= run.endLoop && inPhase(loop),
                ).length,
            ),
            0,
          ),
        0,
      );
      const breakthroughs = sequences.filter((sequence) =>
        sequence.loops.some((loop) => loop.index === sequence.breakthroughLoop && inPhase(loop)),
      ).length;
      const parts = [`${loops} loop${loops === 1 ? '' : 's'}`];
      if (stuck > 0) parts.push(`${stuck} stuck`);
      if (breakthroughs > 0) parts.push(`${breakthroughs} breakthrough${breakthroughs === 1 ? '' : 's'}`);
      return parts.join(' · ');
    }
  }
}

function badge(analyzed: AnalyzedSession, phase: Phase, index: number): SectionHead['badge'] {
  switch (phase.kind) {
    case 'debug': {
      const sequences = analyzed.debugSequences.filter((s) =>
        s.loops.some((loop) => loop.turnIndex >= phase.startIndex && loop.turnIndex <= phase.endIndex),
      );
      // Only call a phase stuck when the stall itself happened here; a run that
      // began in the previous phase is that phase's badge, not this one's.
      const stall = findStalls(analyzed).find(
        (candidate) =>
          sequences.includes(candidate.sequence) &&
          candidate.sequence.loops.some(
            (loop) =>
              loop.index >= candidate.run.startLoop &&
              loop.index <= candidate.run.endLoop &&
              loop.turnIndex >= phase.startIndex &&
              loop.turnIndex <= phase.endIndex,
          ),
      );
      if (stall !== undefined) return { text: `${shortDuration(stall.durationMs)} stuck`, tone: 'red' };
      const sequence = sequences[0];
      if (sequence !== undefined && phaseResolution(analyzed, phase, sequence) === 'passed') {
        return { text: 'resolved', tone: 'green' };
      }
      if (sequence !== undefined && phaseResolution(analyzed, phase, sequence) === 'failing') {
        return { text: 'unresolved', tone: 'red' };
      }
      const loops = phaseLoops(analyzed, phase).length;
      return { text: `${loops} loop${loops === 1 ? '' : 's'}`, tone: 'gray' };
    }
    case 'plan': {
      const revisions = phaseRevisions(analyzed, phase);
      return revisions.length > 1
        ? { text: `revised ×${revisions.length - 1}`, tone: 'blue' }
        : { text: 'drafted', tone: 'gray' };
    }
    case 'execute': {
      const files = phaseEditFiles(analyzed, phase);
      const failed = files.some((f) => f.attempts[f.attempts.length - 1]?.outcome === 'error');
      if (failed) return { text: 'failed', tone: 'red' };
      const retried = files.filter((f) => f.attempts.length > 1).length;
      if (retried > 0) return { text: `retried ×${retried}`, tone: 'gray' };
      return { text: 'clean', tone: 'green' };
    }
    case 'verify': {
      const result = analyzed.verifications.find((view) => view.phaseIndex === index)?.value;
      const failed = (result?.checks ?? []).filter((check) => check.outcome === 'error').length;
      if (failed > 0) return { text: `${failed} failing`, tone: 'red' };
      return { text: 'all green', tone: 'green' };
    }
    case 'explore': {
      // The finding worth surfacing: the file that later broke a stall was
      // already open here.
      const trail = analyzed.trails.find((view) => view.phaseIndex === index)?.value ?? [];
      if (trail.some((step) => step.laterCritical)) return { text: 'answer already open', tone: 'blue' };
      const asked = trail.filter((step) => step.repeats > 1 || step.revisit).length;
      if (asked > 0) {
        return { text: asked === 1 ? 'asked twice' : `${asked} asked twice`, tone: 'gray' };
      }
      const empty = trail.filter((step) => step.found.length === 0 && step.matches === 0).length;
      if (empty > 0 && empty === trail.length) return { text: 'nothing found', tone: 'gray' };
      // The stat line already counts questions and files; repeating it here
      // would be two numbers for one fact.
      return { text: '', tone: 'gray' };
    }
  }
}

function indexOf(analyzed: AnalyzedSession, phase: Phase): number {
  return analyzed.phases.indexOf(phase);
}

/** Every debugging attempt that happened inside this phase's turns. */
function phaseLoops(analyzed: AnalyzedSession, phase: Phase) {
  return analyzed.debugSequences.flatMap((sequence) =>
    sequence.loops.filter((loop) => loop.turnIndex >= phase.startIndex && loop.turnIndex <= phase.endIndex),
  );
}

function phaseOf(analyzed: AnalyzedSession, sequence: DebugSequence): Phase | undefined {
  return analyzed.phases[sequence.phaseIndex];
}

function phaseRevisions(analyzed: AnalyzedSession, phase: Phase): PlanRevision[] {
  const inPhase = analyzed.planRevisions.filter(
    (revision) => revision.turnIndex >= phase.startIndex && revision.turnIndex <= phase.endIndex,
  );
  return inPhase.length > 0 ? inPhase : analyzed.planRevisions;
}

function phaseEditFiles(analyzed: AnalyzedSession, phase: Phase) {
  return analyzed.editHistories
    .map((history) => ({
      path: history.path,
      attempts: history.attempts.filter(
        (attempt) => attempt.turnIndex >= phase.startIndex && attempt.turnIndex <= phase.endIndex,
      ),
    }))
    .filter((history) => history.attempts.length > 0);
}

// ---------------------------------------------------------------------------
// Plan ↔ debug cross-reference (used by the reprompt takeaway)
// ---------------------------------------------------------------------------

function planDebugCrossReference(analyzed: AnalyzedSession, revisions: PlanRevision[]): RichText | null {
  for (const revision of revisions) {
    const added = addedText(revision.diffFromPrevious);
    if (added === '') continue;
    for (const sequence of analyzed.debugSequences) {
      const cause = breakthroughFile(sequence);
      if (
        cause !== null &&
        (added.includes(cause) || (basename(cause).length >= 5 && added.includes(basename(cause))))
      ) {
        return [
          plain('The section your reprompt added mentions '),
          styled(cause, 'file'),
          plain(' — '),
          styled('exactly where the fix landed', 'good'),
          plain('.'),
        ];
      }
      for (const run of sequence.stuckRuns) {
        const loop = sequence.loops.find((candidate) => candidate.index === run.startLoop);
        if (loop === undefined) continue;
        const name = errorName(loop.error.text, run.errorSignature);
        if (/error|exception/i.test(name) && name.length >= 6 && added.toLowerCase().includes(name.toLowerCase())) {
          return [
            plain('Your reprompt called out '),
            styled(name, 'hl'),
            plain(' — '),
            styled('the error the debugging eventually cleared', 'good'),
            plain('.'),
          ];
        }
      }
    }
  }
  return null;
}

/** The `+` lines of a unified diff (minus the `+++` header). */
function addedText(diff: string | null): string {
  if (diff === null) return '';
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Takeaways
// ---------------------------------------------------------------------------

function buildTakeaways(analyzed: AnalyzedSession, extras: BriefExtras): Takeaway[] {
  const takeaways: Takeaway[] = [];

  const guessing = guessingBeforeReading(analyzed);
  if (guessing !== null) takeaways.push(guessing);

  const longWay = longWayAround(analyzed);
  if (longWay !== null) takeaways.push(longWay);

  const claudeMd = claudeMdCandidate(analyzed, extras);
  if (claudeMd !== null) takeaways.push(claudeMd);

  const reprompt = repromptRoi(analyzed);
  if (reprompt !== null) takeaways.push(reprompt);

  const clean = cleanRun(analyzed);
  if (clean !== null) takeaways.push(clean);

  // The report shows 2–4 findings; top up with modest data-traced
  // observations when fewer than 2 clear their bars (never pad past 2).
  if (takeaways.length < 2) {
    for (const observation of modestObservations(analyzed)) {
      if (takeaways.length >= 2) break;
      takeaways.push(observation);
    }
  }
  return takeaways.slice(0, MAX_TAKEAWAYS);
}

/** Bar: stuck run ≥3 loops whose sequence has a breakthrough read. */
function guessingBeforeReading(analyzed: AnalyzedSession): Takeaway | null {
  const stall = mainStall(analyzed);
  if (stall === undefined || stall.attempts < 3) return null;
  const cause = breakthroughFile(stall.sequence);
  if (cause === null) return null;

  const body: NarrativeSpan[] = [
    styled(String(stall.attempts), 'hl'),
    plain(' attempts'),
  ];
  if (stall.sameFile !== null) body.push(plain(' at '), styled(stall.sameFile, 'file'));
  body.push(
    plain(' hit the same '),
    styled(errorPhrase(stall), 'bad'),
    plain('; the answer was in '),
    styled(cause, 'file'),
    plain(', one read away.'),
  );

  return {
    kind: 'warning',
    lead: tidy([
      styled(formatDuration(stall.durationMs), 'bad'),
      plain(' went to guessing instead of reading.'),
    ]),
    body: tidy(body),
    evidenceSection: stall.sequence.phaseIndex,
  };
}

/** Bar: a file read ≥3× this session, or ≥2× here and ≥2× in sibling sessions. */
function claudeMdCandidate(analyzed: AnalyzedSession, extras: BriefExtras): Takeaway | null {
  const cross = extras.crossSessionReads ?? {};
  const candidate = [...analyzed.files]
    .filter((file) => file.reads >= 3 || (file.reads >= 2 && (cross[file.path] ?? 0) >= 2))
    .sort((a, b) => b.reads + (cross[b.path] ?? 0) - (a.reads + (cross[a.path] ?? 0)))[0];
  if (candidate === undefined) return null;

  // Fact form when the debug analysis learned something concrete about this
  // file; location form otherwise.
  const breakthrough = analyzed.debugSequences.find((s) => breakthroughFile(s) === candidate.path);
  const stall = breakthrough === undefined ? undefined : findStalls(analyzed).find((s) => s.sequence === breakthrough);
  // A clean identifier ("TypeError") reads well inline; a truncated signature
  // does not — fall back to a plainer, still data-traced clause.
  const cleanError = stall !== undefined && /^[A-Z][A-Za-z]*(Error|Exception)$/.test(stall.errorName);
  const snippet =
    breakthrough !== undefined
      ? cleanError
        ? `# CLAUDE.md — read ${candidate.path} before editing; it resolved ${stall.errorName} this session`
        : `# CLAUDE.md — read ${candidate.path} before editing; this session's debugging fix came from it`
      : `# ${candidate.path} contains ${inferRole(candidate.path)}`;

  const body: NarrativeSpan[] = [
    plain('Read '),
    styled(`${candidate.reads}×`, 'hl'),
    plain(' this session'),
  ];
  const crossCount = cross[candidate.path] ?? 0;
  if (crossCount > 0) body.push(plain(' and '), styled(`${crossCount}×`, 'hl'), plain(' across other sessions in this project'));
  body.push(plain(' — pinning what it holds into CLAUDE.md saves the re-reads.'));

  return {
    kind: 'tip',
    lead: tidy([plain('Pin '), styled(candidate.path, 'file'), plain(' in your CLAUDE.md.')]),
    body: tidy(body),
    snippet,
  };
}

/** Small path→role table for the location-form snippet. */
function inferRole(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.includes('verify') || name.includes('signature')) return 'the signature verification logic';
  if (name.includes('handler')) return 'the request handling logic';
  if (name.includes('config') || name.includes('env')) return 'environment configuration';
  if (name.includes('auth')) return 'the authentication logic';
  if (name.includes('route') || name.includes('router')) return 'the routing setup';
  if (name.includes('test') || name.includes('spec')) return 'the test coverage for this area';
  const stem = name.replace(/\.[a-z]+$/, '');
  return stem !== '' ? `the ${stem} logic this session kept returning to` : 'logic this session kept returning to';
}

/** Bar: a plan revision connects to a debug escape. */
function repromptRoi(analyzed: AnalyzedSession): Takeaway | null {
  const revisions = analyzed.planRevisions;
  if (revisions.length < 2) return null;
  const cross = planDebugCrossReference(analyzed, revisions);
  if (cross === null) return null;

  const planIndex = analyzed.phases.findIndex((phase) => phase.kind === 'plan');
  return {
    kind: 'win',
    lead: tidy([plain('Your plan pushback paid off.')]),
    body: tidy(cross),
    ...(planIndex >= 0 ? { evidenceSection: planIndex } : {}),
  };
}

/** Bar: zero stuck runs and ≥70% of edited files were clean. */
function cleanRun(analyzed: AnalyzedSession): Takeaway | null {
  if (analyzed.debugSequences.some((sequence) => sequence.stuckRuns.length > 0)) return null;
  const files = analyzed.editHistories;
  if (files.length === 0) return null;
  const clean = files.filter((file) => file.finalOutcome === 'clean').length;
  if (clean / files.length < 0.7) return null;

  const interleaved = analyzed.phases.some((phase) => {
    if (phase.kind !== 'execute') return false;
    const calls = phaseCalls(analyzed, phase);
    const lastWrite = calls.map((c, i) => (c.category === 'write' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    return calls.some((call, i) => call.category === 'bash' && i < lastWrite);
  });

  const body: NarrativeSpan[] = [
    styled(`${clean} of ${files.length}`, 'hl'),
    plain(' edited files landed clean on the first try'),
  ];
  if (interleaved) body.push(plain(', with tests run alongside the edits rather than gambled at the end'));
  body.push(plain('.'));

  return {
    kind: 'win',
    lead: tidy([plain('No stuck runs — '), styled('a clean session', 'good'), plain('.')]),
    body: tidy(body),
  };
}

/** Bar: an execute phase far over median duration with low edit density. */
function longWayAround(analyzed: AnalyzedSession): Takeaway | null {
  const durations = analyzed.phases.map((phase) =>
    Math.max(0, Date.parse(phase.endedAt) - Date.parse(phase.startedAt)),
  );
  if (durations.length < 3) return null;
  const median = [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] ?? 0;
  if (median <= 0) return null;

  const executes = analyzed.phases
    .map((phase, index) => ({ phase, index, ms: durations[index] ?? 0 }))
    .filter((entry) => entry.phase.kind === 'execute');
  if (executes.length < 2) return null;

  const density = (entry: { phase: Phase; ms: number }): number =>
    entry.ms <= 0 ? 0 : entry.phase.toolMix.write / (entry.ms / 600_000); // edits per 10 minutes
  const average = executes.reduce((sum, entry) => sum + density(entry), 0) / executes.length;

  const flagged = executes.find((entry) => entry.ms > 2 * median && density(entry) < average / 2);
  if (flagged === undefined || average <= 0) return null;

  return {
    kind: 'warning',
    lead: tidy([
      plain('One execute stretch ran '),
      styled(formatDuration(flagged.ms), 'bad'),
      plain(' with unusually few edits.'),
    ]),
    body: tidy([
      plain('It ran over '),
      styled('2× the median phase length', 'hl'),
      plain(' at less than half the session’s usual edit density — possibly over-scoped.'),
    ]),
    evidenceSection: flagged.index,
  };
}

/** 1–2 modest, data-traced observations when nothing clears a bar. */
function modestObservations(analyzed: AnalyzedSession): Takeaway[] {
  const observations: Takeaway[] = [];

  // Active time, not wall-clock: a phase that spans two hours because the
  // developer stepped away did not cost two hours of anyone's attention.
  const totalMs = Math.max(1, analyzed.phases.reduce((sum, phase) => sum + phase.activeMs, 0));
  const byKind = new Map<string, number>();
  analyzed.phases.forEach((phase) => {
    byKind.set(phase.kind, (byKind.get(phase.kind) ?? 0) + phase.activeMs);
  });
  const top = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top !== undefined) {
    observations.push({
      kind: 'tip',
      lead: tidy([
        plain('Most of the working time went to '),
        styled(top[0], 'hl'),
        plain('.'),
      ]),
      body: tidy([
        styled(formatDuration(top[1]), 'hl'),
        plain(' of '),
        styled(formatDuration(totalMs), 'hl'),
        plain(' active — idle time excluded.'),
      ]),
    });
  }

  const files = analyzed.editHistories;
  if (files.length > 0) {
    const attempts = files.reduce((n, f) => n + f.attempts.length, 0);
    observations.push({
      kind: 'win',
      lead: tidy([
        styled(String(files.length), 'hl'),
        plain(` file${files.length === 1 ? '' : 's'} edited across `),
        styled(String(attempts), 'hl'),
        plain(` attempt${attempts === 1 ? '' : 's'}.`),
      ]),
      body: [],
    });
  }

  return observations.slice(0, 2);
}
