/**
 * Semantic events: the primitives a replay is actually made of.
 *
 * Phases and file lists cannot carry meaning — "8 questions · 6 files" says
 * nothing about the session, while "Article.authorId is the only association
 * the author page reads" is the whole thing. This module extracts the moments
 * that matter as typed events, so the viewer can give each one the weight and
 * the shape it deserves.
 *
 * The boundary this module defends:
 *
 *   **Select, clip, group, rank and count are ours. Wording is the session's,
 *   wherever wording exists.**
 *
 * So an event is either a sentence the session contains, quoted and clipped
 * (`source: 'quoted'`), or a fact assembled from tool calls and arithmetic over
 * them (`source: 'structural'`). There is no third category and no model. Every
 * event carries the turn it came from and the files or commands that back it,
 * so a reader can check the claim — and a wrong one is visibly the session's
 * rather than quietly ours.
 *
 * Extraction runs in four stages, in this order: gather, collapse, rank, relate.
 * Ranking has to see the grouped set (a failure repeated three times outranks a
 * failure), and relating has to see the ranked set (only findings look back).
 */

import { clipSentence, prose, splitSentences } from './prose.js';
import type {
  AnalyzedSession,
  EventKind,
  EventRank,
  Phase,
  SessionEvent,
  Turn,
} from './types.js';

const MIN_CHARS = 30;
const MAX_CHARS = 200;
const LABEL_MAX = 92;
const LABEL_MIN = 36;

/** Marker sets, in the order they are tested. First match wins the kind. */
const MARKERS: Array<{ kind: EventKind; pattern: RegExp; weight: number }> = [
  {
    kind: 'blocker',
    pattern:
      /(?:^|\s)(blocked on|can't reach|cannot reach|unreachable|no access|needs? (?:your|input|credentials|access)|requires? access|permission denied|only you have)/i,
    weight: 4,
  },
  {
    kind: 'rootCause',
    pattern:
      /(?:^|\s)(root cause|explains? the symptom|fully explains|that's why|that is why|which is why|the reason .* is|no .*, no .*)/i,
    weight: 5,
  },
  {
    kind: 'discovery',
    pattern:
      /(?:^|\s)(found|turns out|that (?:confirms|settles)|the (?:problem|issue|answer|cause) is|mental model|load-bearing|the only .* (?:that counts|involved)|confirmed|in short|there it is|that'?s the (?:bug|problem|issue))/i,
    weight: 4,
  },
  {
    kind: 'hypothesis',
    pattern: /(?:^|\s)(hypothesis|my guess|i suspect|suspect that|likely because|probably because|might be why)/i,
    weight: 3,
  },
  {
    kind: 'decision',
    pattern:
      /(?:^|\s)(the (?:plan|goal|approach) is|the plan:|we'll|i'll go with|let's go with|decided to|going with|we need to build|the fix is to)/i,
    weight: 3,
  },
];

/** A sentence that promises work rather than reporting it. */
const PREAMBLE = /^(let me|let's|i'll|i will|i'm going to|now i|next[,:]|first[,:]|then[,:]|checking|looking|starting|running)\b/i;

/**
 * A sentence that reports how the checks went, not what is wrong with the code.
 *
 * "All green: 84 tests, no type errors, no lint findings." satisfies the root
 * cause marker `no .*, no .*` — the pattern that exists for "no author tag, no
 * result" — and a verify summary was then being promoted to the loudest thing
 * on the page while the actual finding sat unmarked in the debug phase. A
 * verdict is never a finding, wherever it appears.
 */
const VERDICT =
  /(?:^|\s)(all green|all (?:tests? )?pass(?:ed|ing)?|safe to merge|no type errors|no lint (?:errors|findings|warnings)|\d+ tests? pass)/i;

/** A user turn that sets a new goal rather than continuing the current one. */
const NEW_GOAL =
  /(?:^|\s)(instead|actually,? (?:can|could|let)|now (?:can|could|let|i want)|i want to|we want to|can we (?:also )?(?:build|add|make|create)|build (?:me )?a|let'?s (?:build|add|make|create|switch)|what if i)/i;

/** Findings that earn a heavier mark. A quoted decision joins them; a stub does not. */
const KEY_KINDS = new Set<EventKind>(['rootCause', 'discovery', 'pivot', 'hypothesis', 'failure']);

export function extractEvents(analyzed: AnalyzedSession): SessionEvent[] {
  const quoted = proseEvents(analyzed);
  const gathered = [
    ...quoted,
    ...pivotEvents(analyzed),
    ...structuralEvents(analyzed),
    ...breakthroughEvents(analyzed, quoted),
  ].sort((a, b) => a.turnIndex - b.turnIndex || Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return relate(rank(collapse(gathered)));
}

/** Every event is built here, so no call site can forget a field. */
function event(
  fields: Omit<SessionEvent, 'label' | 'rank' | 'count' | 'relatesTo'> & { label?: string },
): SessionEvent {
  return {
    ...fields,
    label: fields.label ?? labelOf(fields.text),
    rank: 'normal',
    count: 1,
    relatesTo: null,
  };
}

// ---------------------------------------------------------------------------
// Quoted: what the session said
// ---------------------------------------------------------------------------

function proseEvents(analyzed: AnalyzedSession): SessionEvent[] {
  const events: SessionEvent[] = [];

  analyzed.session.turns.forEach((turn, turnIndex) => {
    if (turn.role !== 'assistant') return;
    const phaseIndex = phaseOf(analyzed.phases, turnIndex);
    const inVerify = analyzed.phases[phaseIndex]?.kind === 'verify';
    const files = filesOf(turn);

    // At most one event of each kind per turn: a turn that says "found" three
    // times found one thing and then explained it.
    const claimed = new Set<EventKind>();

    const sentences = splitSentences(prose(turn.text));
    sentences.forEach((sentence, i) => {
      if (PREAMBLE.test(sentence)) return;
      // "There it is." announces the finding and states none of it. Short
      // sentences are allowed to match only when the next one is there to
      // carry them, and `withFollowOn` is what actually joins the two.
      if (sentence.length < MIN_CHARS && sentences[i + 1] === undefined) return;
      const marker = MARKERS.find((candidate) => candidate.pattern.test(sentence));
      if (marker === undefined || claimed.has(marker.kind)) return;
      // A finding cannot be a verdict, and a verify phase reports verdicts —
      // what it concluded there is how the checks went, not what was wrong.
      const isFinding = marker.kind === 'rootCause' || marker.kind === 'discovery';
      if (isFinding && (inVerify || VERDICT.test(sentence))) return;
      claimed.add(marker.kind);
      // "That confirms hypothesis #1." on its own says nothing; the sentence
      // after it carries the finding.
      const text = withFollowOn(sentence, sentences[i + 1]);
      events.push(
        event({
          kind: marker.kind,
          text,
          // The marker is what made this an event; when the sentence has to be
          // cut, its clause is the one to keep.
          label: labelOf(text, marker.pattern),
          turnIndex,
          timestamp: turn.timestamp,
          phaseIndex,
          evidence: evidenceFor(text, files),
          source: 'quoted',
          weight: marker.weight,
        }),
      );
    });
  });

  return events;
}

/**
 * A short conclusion takes the next sentence with it, when they still fit —
 * and always when it is too short to say anything on its own, since "There it
 * is." alone is not a finding at any length.
 */
function withFollowOn(sentence: string, next: string | undefined): string {
  if (next === undefined) return clipSentence(sentence, MAX_CHARS, MIN_CHARS);
  const together = `${sentence} ${next}`;
  const fits = sentence.length < 120 && together.length <= MAX_CHARS;
  const joined = fits || sentence.length < MIN_CHARS ? together : sentence;
  return clipSentence(joined, MAX_CHARS, MIN_CHARS);
}

/**
 * The scannable line, derived mechanically from the quote.
 *
 * "There it is." and "The goal is clear:" point at a finding without stating
 * one, so the clause that carries it becomes the label and the pointer stays
 * in the evidence. Nothing is rewritten: every word here is a word the session
 * used, in the order it used them.
 */
export function labelOf(text: string, focus?: RegExp): string {
  const sentences = splitSentences(text);
  const long = sentences.filter((sentence) => sentence.length >= LABEL_MIN);
  // "That confirms hypothesis #1 and fully explains the symptom." is long
  // enough to pass a length test and still names nothing — the sentence after
  // it carries the finding. A sentence that names a file or a symbol is about
  // something; prefer one, but never require it, since plenty of real findings
  // name neither.
  const carrying = long.find(namesSomething) ?? long[0] ?? sentences[0] ?? text;
  const stripped = stripLeadIn(carrying);
  if (stripped.length <= LABEL_MAX) return stripped;

  // An aside in brackets is the first thing to go: dropping "(author name in
  // title, or single-author product set)" turns a label that died mid-bracket
  // into a whole sentence that also keeps `Article.authorId` — the part a
  // reader was looking for.
  const tight = withoutAsides(stripped);
  if (tight.length <= LABEL_MAX) return tight;

  // Then the clause the marker actually matched. "The script is written and
  // typechecks, but I'm blocked on reaching the CMS database" cut to budget
  // keeps the reassuring half and loses the blocker; cut to the clause that
  // said "blocked on", it keeps the blocker and fits with room to spare.
  const focused = focus === undefined ? null : focusClause(tight, focus);
  if (focused !== null && focused.length <= LABEL_MAX) return focused;

  return clipClause(tight, LABEL_MAX, LABEL_MIN);
}

/** Does the sentence point at anything a reader could open or grep for? */
function namesSomething(sentence: string): boolean {
  return /[\w/-]+\.(?:tsx?|jsx?|prisma|sql|json|py|go|rs)\b|\b[A-Z][A-Za-z]+\.[a-z][A-Za-z]+\b/.test(sentence);
}

/** Parenthetical asides, and the spacing they leave behind. */
function withoutAsides(text: string): string {
  return text
    .replace(/\s*\([^()]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim();
}

/**
 * Where a sentence can be cut without leaving a fragment.
 *
 * Only joins that start a genuinely new clause — a bare comma is a list, and
 * cutting "no author tag, no result" at it would take half the finding.
 */
const CLAUSE_JOIN = /,\s+(?:and|but|so|which|while|then|though|because)\s+|\s+—\s+|\s+–\s+|;\s+/g;

function clauses(text: string): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(CLAUSE_JOIN.source, 'g');
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    parts.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  parts.push({ start: cursor, end: text.length });
  return parts;
}

/**
 * The clause the marker matched in — the reason this is an event at all —
 * plus as many of the clauses after it as still fit.
 *
 * The marker is often the opener rather than the point: "Turns out articles
 * are not in Supabase" matched, but "they live in a separate CMS Postgres
 * database" is what a reader needs. Starting at the matched clause and running
 * forward keeps both when there is room, and drops the tail rather than the
 * finding when there is not.
 */
function focusClause(text: string, focus: RegExp): string | null {
  const match = new RegExp(focus.source, focus.flags.replace('g', '')).exec(text);
  if (match === null) return null;
  const parts = clauses(text);
  const first = parts.findIndex((clause) => match.index >= clause.start && match.index < clause.end);
  if (first === -1) return null;

  const start = parts[first]?.start ?? 0;
  let end = parts[first]?.end ?? text.length;
  for (const clause of parts.slice(first + 1)) {
    if (clause.end - start > LABEL_MAX) break;
    end = clause.end;
  }

  const slice = text.slice(start, end).trim();
  return slice.length >= LABEL_MIN ? slice : null;
}

/**
 * Cut at the last clause that fits, not at the last word that fits. A label
 * ending "…the CMS database from…" stopped mid-thought; one ending "…in a
 * separate CMS Postgres database" is a sentence, and it is shorter.
 */
function clipClause(text: string, maxChars: number, minChars: number): string {
  const fitting = clauses(text)
    .map((clause) => clause.end)
    .filter((end) => end <= maxChars && end >= minChars);
  const cut = fitting[fitting.length - 1];
  return cut === undefined ? clipSentence(text, maxChars, minChars) : text.slice(0, cut).trim();
}

/**
 * Drop an opener that points at the finding instead of stating it:
 *   "The goal is clear: a backfill script…" → "a backfill script…"
 *   "There it is. src/lib/stripe.ts resolves…" → "src/lib/stripe.ts resolves…"
 *
 * A pointer carries no `.` or `/` of its own, which is what keeps this off
 * "src/lib/stripe.ts resolves…" and "e.g. the importer". The colon form is
 * allowed to be longer than the full-stop form: a clause before a colon is
 * almost always a label, while a short sentence is only sometimes a pointer.
 */
function stripLeadIn(sentence: string): string {
  const cut = sentence
    .replace(/^[^:./]{0,48}:\s+/, '')
    .replace(/^[^:./]{1,24}\.\s+/, '')
    .trim();
  return cut.length >= LABEL_MIN ? cut : sentence;
}

/**
 * What backs the claim. A turn of pure prose has no tool calls, so the files
 * and symbols the sentence itself names are the evidence — they are what a
 * reader would go and check.
 */
function evidenceFor(text: string, files: string[]): string[] {
  if (files.length > 0) return files;
  const named = [...text.matchAll(/[\w./-]*[\w-]+\.(?:tsx?|jsx?|prisma|sql|json|py|go|rs)\b/g)].map((m) => m[0]);
  const symbols = [...text.matchAll(/\b[A-Z][A-Za-z]+\.[a-z][A-Za-z]+\b/g)].map((m) => m[0]);
  return [...new Set([...named, ...symbols])].slice(0, 4);
}

/**
 * A pivot is the developer changing the goal mid-session — "debug why this one
 * article is missing" becoming "backfill every untagged author article".
 * It is the least certain event kind, so it is only ever shown as the quote
 * that triggered it: a wrong call reads as a wrong call.
 */
function pivotEvents(analyzed: AnalyzedSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  let worked = false;

  analyzed.session.turns.forEach((turn, turnIndex) => {
    if (turn.role === 'assistant') {
      if (turn.toolCalls.length > 0) worked = true;
      return;
    }
    // Only after something has been done can a request be a change of course.
    if (!worked) return;
    const text = prose(turn.text);
    if (text.length < MIN_CHARS || !NEW_GOAL.test(text)) return;

    events.push(
      event({
        kind: 'pivot',
        text: clipSentence(text, MAX_CHARS, MIN_CHARS),
        turnIndex,
        timestamp: turn.timestamp,
        phaseIndex: phaseOf(analyzed.phases, turnIndex),
        evidence: [],
        source: 'quoted',
        weight: 3,
      }),
    );
    worked = false; // the next pivot needs work between it and this one
  });

  return events;
}

// ---------------------------------------------------------------------------
// Structural: what the tool calls prove
// ---------------------------------------------------------------------------

function structuralEvents(analyzed: AnalyzedSession): SessionEvent[] {
  const events: SessionEvent[] = [];

  // Edits are grouped by the turn that finished them: five edits in one turn
  // are one change set, and listing them as five events turns the phase that
  // did the work into the longest stretch of the replay.
  const byTurn = new Map<number, Array<{ path: string; added: number; removed: number; failed: boolean }>>();
  for (const history of analyzed.editHistories) {
    const last = history.attempts[history.attempts.length - 1];
    if (last === undefined) continue;
    const lines = history.attempts.flatMap((attempt) => attempt.diff);
    const entry = {
      path: history.path,
      added: lines.filter((line) => line.kind === 'add').length,
      removed: lines.filter((line) => line.kind === 'del').length,
      failed: history.finalOutcome === 'failed',
    };
    const existing = byTurn.get(last.turnIndex);
    if (existing === undefined) byTurn.set(last.turnIndex, [entry]);
    else existing.push(entry);
  }

  for (const [turnIndex, entries] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const turn = analyzed.session.turns[turnIndex];
    const added = entries.reduce((sum, entry) => sum + entry.added, 0);
    const removed = entries.reduce((sum, entry) => sum + entry.removed, 0);
    const only = entries.length === 1 ? entries[0] : undefined;
    const text =
      only !== undefined
        ? `${only.path} (+${only.added} −${only.removed})`
        : `${entries.length} files changed (+${added} −${removed})`;
    events.push({
      ...event({
        kind: 'implementation',
        text,
        turnIndex,
        timestamp: turn?.timestamp ?? analyzed.session.startedAt,
        phaseIndex: phaseOf(analyzed.phases, turnIndex),
        evidence: entries.map((entry) => entry.path).slice(0, 4),
        source: 'structural',
        weight: entries.some((entry) => entry.failed) ? 3 : 2,
      }),
      count: entries.length,
    });
  }

  for (const view of analyzed.commands) {
    // Checks that passed in the same turn are one run, for the same reason.
    const passedByTurn = new Map<number, string[]>();

    for (const group of view.value) {
      if (group.kind === 'inspect') continue;
      const turn = analyzed.session.turns[group.turnIndex];
      const at = {
        turnIndex: group.turnIndex,
        timestamp: turn?.timestamp ?? analyzed.session.startedAt,
        phaseIndex: view.phaseIndex,
        evidence: [group.command],
        source: 'structural' as const,
      };
      // A check that failed and then passed is both events: the failure is what
      // happened, the pass is where it ended, and "blocked vs verified" needs
      // the second one. The failure quotes the run that failed — `note` by then
      // describes the run that passed.
      if (group.failed > 0) {
        events.push({
          ...event({ ...at, kind: 'failure', text: group.failNote ?? `${group.label} failed`, weight: 3 }),
          count: group.failed,
        });
      }
      if (group.kind === 'check' && group.lastOutcome === 'success') {
        const existing = passedByTurn.get(group.turnIndex);
        if (existing === undefined) passedByTurn.set(group.turnIndex, [group.label]);
        else existing.push(group.label);
      }
    }

    for (const [turnIndex, labels] of [...passedByTurn.entries()].sort((a, b) => a[0] - b[0])) {
      const turn = analyzed.session.turns[turnIndex];
      const single = labels.length === 1 ? labels[0] : undefined;
      const note = single === undefined ? null : noteFor(view.value, turnIndex, single);
      events.push({
        ...event({
          kind: 'verification',
          text:
            single !== undefined
              ? (note ?? `${single} passed`)
              : `${labels.length} checks passed — ${labels.join(', ')}`,
          turnIndex,
          timestamp: turn?.timestamp ?? analyzed.session.startedAt,
          phaseIndex: view.phaseIndex,
          evidence: labels.slice(0, 4),
          source: 'structural',
          weight: 2,
        }),
        count: labels.length,
      });
    }
  }

  for (const revision of analyzed.planRevisions) {
    if (revision.changeKind !== 'initial') continue;
    const turn = analyzed.session.turns[revision.turnIndex];
    events.push(
      event({
        kind: 'decision',
        text: `plan drafted — ${revision.steps.length} step${revision.steps.length === 1 ? '' : 's'}`,
        turnIndex: revision.turnIndex,
        timestamp: turn?.timestamp ?? analyzed.session.startedAt,
        phaseIndex: phaseOf(analyzed.phases, revision.turnIndex),
        evidence: [],
        source: 'structural',
        weight: 2,
      }),
    );
  }

  return events;
}

function noteFor(
  groups: AnalyzedSession['commands'][number]['value'],
  turnIndex: number,
  label: string,
): string | null {
  return groups.find((group) => group.turnIndex === turnIndex && group.label === label)?.note ?? null;
}

/**
 * The read that ended a stall.
 *
 * Quoted discoveries need Claude to have phrased one, and in a long debugging
 * run it often never does — it just goes quiet, reads a file, and the error
 * changes. That moment is the discovery of the session and it exists only in
 * the tool calls. Stated as what happened and nothing more: a file was read,
 * and the next attempt behaved differently. Whether the read caused it is the
 * reader's call, and the turn is one click away.
 *
 * This is the fallback, not the preference. Where the turn already says what
 * was found, the session's own sentence stands and this one is dropped —
 * wording is the session's wherever wording exists.
 */
function breakthroughEvents(analyzed: AnalyzedSession, quoted: SessionEvent[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  const spokenFor = new Set(
    quoted
      .filter((event) => event.kind === 'discovery' || event.kind === 'rootCause')
      .map((event) => event.turnIndex),
  );

  for (const sequence of analyzed.debugSequences) {
    const { breakthroughLoop, breakthroughCause } = sequence;
    if (breakthroughLoop === null || breakthroughCause === null) continue;
    const loop = sequence.loops.find((candidate) => candidate.index === breakthroughLoop);
    if (loop === undefined || spokenFor.has(loop.turnIndex)) continue;
    const run = sequence.stuckRuns.filter((candidate) => candidate.endLoop < breakthroughLoop).pop();
    if (run === undefined) continue;

    const file = breakthroughCause.replace(/^read /, '');
    const attempts = run.endLoop - run.startLoop + 1;
    const outcome = loop.result === 'passed' ? 'the check passed' : 'the error changed';
    const turn = analyzed.session.turns[loop.turnIndex];

    events.push(
      event({
        kind: 'discovery',
        text: `read ${file} after ${attempts} identical failures — then ${outcome}`,
        turnIndex: loop.turnIndex,
        timestamp: turn?.timestamp ?? loop.startedAt,
        phaseIndex: sequence.phaseIndex,
        evidence: [file, ...loop.precedingReads.filter((read) => read !== file)].slice(0, 4),
        source: 'structural',
        weight: 4,
      }),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Collapse, rank, relate
// ---------------------------------------------------------------------------

/**
 * One row per thing that happened. The same failure three times is one failure
 * with a count — three rows saying the identical sentence is the bookkeeping
 * the replay exists to be rid of, and the count is the part that matters.
 *
 * Only repeats within a phase merge. The same error in two phases is two
 * episodes, and flattening them would hide that it came back.
 */
function collapse(events: SessionEvent[]): SessionEvent[] {
  const kept: SessionEvent[] = [];
  const seen = new Map<string, SessionEvent>();

  for (const current of events) {
    // Keyed on the label, not the kind: two markers firing on two sentences of
    // one paragraph produce a `discovery` and a `rootCause` that clip to the
    // same line, and the page then says it twice. The same words are the same
    // moment; the stronger reading of it wins.
    const key = `${current.phaseIndex}:${current.label.toLowerCase()}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      const copy = { ...current, evidence: [...current.evidence] };
      seen.set(key, copy);
      kept.push(copy);
      continue;
    }
    // Merge into the first occurrence: a stall is dated from where it began.
    if (current.weight > existing.weight) {
      existing.kind = current.kind;
      existing.text = current.text;
      existing.source = current.source;
    } else {
      existing.count += current.count;
    }
    existing.weight = Math.max(existing.weight, current.weight);
    for (const item of current.evidence) {
      if (!existing.evidence.includes(item) && existing.evidence.length < 4) existing.evidence.push(item);
    }
  }

  return kept;
}

/**
 * Three weights, assigned from the kind and the position — never from taste.
 *
 * `outcome` is the state the session ended in, and only the tail can be that:
 * a blocker, or the last thing that happened being a passing check. Everything
 * a developer came to read is `key`; everything they came to skim is `normal`.
 */
function rank(events: SessionEvent[]): SessionEvent[] {
  const lastTurn = events.reduce((max, current) => Math.max(max, current.turnIndex), -1);

  return events.map((current) => {
    const ranked = (value: EventRank): SessionEvent => ({ ...current, rank: value });
    if (current.kind === 'blocker') return ranked('outcome');
    if (current.kind === 'verification' && current.turnIndex === lastTurn) return ranked('outcome');
    if (current.kind === 'decision') return ranked(current.source === 'quoted' ? 'key' : 'normal');
    return ranked(KEY_KINDS.has(current.kind) ? 'key' : 'normal');
  });
}

/**
 * The link back: the file noted in Explore that turns out to be the root cause
 * in Debug. It is the most useful sentence a replay can carry and it belongs to
 * neither event — only to the pair.
 *
 * Deliberately strict. The earlier event must be in an earlier phase, so a
 * finding pointing at a file it touched two minutes ago is not a callback; and
 * only findings look back, because a normal step sharing a path with another
 * normal step is a file list, not a story.
 */
function relate(events: SessionEvent[]): SessionEvent[] {
  return events.map((current) => {
    if (current.rank === 'normal') return current;
    const anchors = current.evidence.filter(isAnchor);
    if (anchors.length === 0) return current;
    const earlier = events.find(
      (candidate) =>
        candidate.phaseIndex < current.phaseIndex &&
        candidate.turnIndex < current.turnIndex &&
        candidate.evidence.some((item) => anchors.includes(item)),
    );
    return earlier === undefined ? current : { ...current, relatesTo: earlier.turnIndex };
  });
}

/**
 * Something a reader can open or grep for: a path, or a dotted symbol. Check
 * labels are evidence too, but "Tests" appearing in two phases means both ran
 * tests — it is not the same thread coming back.
 */
function isAnchor(item: string): boolean {
  return item.includes('/') || /^[A-Za-z][\w-]*\.[A-Za-z][\w-]*$/.test(item);
}

// ---------------------------------------------------------------------------
// Picking the ones that carry the session
// ---------------------------------------------------------------------------

/**
 * The single finding that explains the session, if it stated one.
 *
 * A root cause outranks a plain discovery, and a later statement outranks an
 * earlier one — an investigation narrows, and the last thing it concluded is
 * usually the thing it concluded.
 */
export function pickRootCause(events: SessionEvent[]): SessionEvent | null {
  const candidates = events.filter(
    (event) => event.kind === 'rootCause' || event.kind === 'discovery',
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, event) => {
    const better =
      event.weight > best.weight || (event.weight === best.weight && event.turnIndex > best.turnIndex);
    return better ? event : best;
  });
}

/** What stopped the session, if anything did. The last one stands. */
export function pickBlocker(events: SessionEvent[]): SessionEvent | null {
  const blockers = events.filter((event) => event.kind === 'blocker');
  return blockers[blockers.length - 1] ?? null;
}

/** What was agreed to do about it: a plan's objective, or a stated decision. */
export function pickDecision(events: SessionEvent[]): SessionEvent | null {
  const quoted = events.filter((event) => event.kind === 'decision' && event.source === 'quoted');
  return quoted[quoted.length - 1] ?? events.find((event) => event.kind === 'decision') ?? null;
}

function phaseOf(phases: Phase[], turnIndex: number): number {
  const index = phases.findIndex((phase) => phase.startIndex <= turnIndex && turnIndex <= phase.endIndex);
  return index === -1 ? 0 : index;
}

/** Files the turn touched. Evidence has to be something a reader can open. */
function filesOf(turn: Turn): string[] {
  const files: string[] = [];
  for (const call of turn.toolCalls) {
    if (call.filePath === null || files.includes(call.filePath)) continue;
    files.push(call.filePath);
  }
  return files.slice(0, 4);
}
