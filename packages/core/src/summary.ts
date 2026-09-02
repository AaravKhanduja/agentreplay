/**
 * The one sentence a phase is about.
 *
 * Sessions summarize themselves. Somewhere in a phase of exploring, Claude
 * usually writes "That confirms hypothesis #1 and fully explains the symptom…";
 * somewhere in a phase of building, "the script is written and typechecks, but
 * I'm blocked on reaching the CMS database". Those sentences are the summary the
 * reader wants, and they are already in the transcript — so this module *finds*
 * them rather than writing one. AgentReplay quotes the session; it does not
 * narrate it.
 *
 * When a phase never states a conclusion, the fallback is composed from computed
 * facts only, and is marked `derived` so the viewer can withhold the attribution
 * — an arithmetic line must never look like something Claude said.
 */

import { checkTitle, commandOf } from './checks.js';
import { clipSentence, prose, splitSentences } from './prose.js';
import { planObjective } from './plans.js';
import type { AnalyzedSession, Phase, PhaseSummary, Session, Turn } from './types.js';

const MIN_CHARS = 40;
const MAX_CHARS = 220;
/** Below this a sentence isn't a conclusion, just prose that happened to be there. */
const SCORE_FLOOR = 3;
/**
 * Verification is mechanical, and "3 checks, all green" beats whatever the
 * conversation happened to be about while they ran. Only a sentence that is
 * plainly about the checks clears this.
 */
const VERIFY_SCORE_FLOOR = 6;

/** How a conclusion announces itself. */
const CONCLUSION =
  /(^|\s)(found|turns out|that (confirms|settles|explains)|the (problem|issue|answer|cause|fix|goal|plan|root cause) is|in short|to summari[sz]e|blocked on|explains? the|so the|so,? the|it turns out|confirmed|the reason|mental model)\b/i;

/**
 * Vocabulary that ties a sentence to the *kind* of phase it sits in. Without
 * it, a long execute phase picks whichever conclusion came last — including a
 * detour about query permissions — over the sentence that reports what was
 * actually built.
 */
const KIND_TERMS: Record<string, RegExp> = {
  explore: /\b(found|traced|lives? in|comes? from|reads?|only|because|means)\b/i,
  plan: /\b(plan|goal|approach|steps?|plan is|we'll|plan:)\b/i,
  execute: /\b(written|wrote|created|updated|added|blocked|done|ready|typechecks?|compiles?|ran|runs?)\b/i,
  debug: /\b(fix(ed|es)?|passes|passing|root cause|failing|was)\b/i,
  verify: /\b(pass(ed|ing)?|green|clean|failing|checks?)\b/i,
};
/** Sentences that promise work rather than report it. */
const PREAMBLE = /^(let me|let's|i'll|i will|i'm going to|now i|next[,:]|first[,:]|then[,:]|checking|looking|starting|running)\b/i;

export function summarizeConclusion(
  session: Session,
  phase: Phase,
  analyzed: AnalyzedSession,
): PhaseSummary | null {
  const grounding = groundingTerms(session, phase);
  const last = lastAssistantTurn(session.turns, phase);
  let bestText = '';
  let bestTurn = phase.startIndex;
  let bestScore = -Infinity;

  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    const turn = session.turns[i];
    if (turn === undefined || turn.role !== 'assistant') continue;
    const sentences = splitSentences(prose(turn.text));

    for (let s = 0; s < sentences.length; s++) {
      const sentence = sentences[s];
      if (sentence === undefined) continue;
      const joined = join(sentence, sentences[s + 1]);
      const score = scoreOf(joined, { isLast: i === last, grounding, kind: phase.kind });
      if (score > bestScore) {
        bestScore = score;
        bestText = joined;
        bestTurn = i;
      }
    }
  }

  const floor = phase.kind === 'verify' ? VERIFY_SCORE_FLOOR : SCORE_FLOOR;
  if (bestScore >= floor && bestText !== '') {
    return { text: bestText, turnIndex: bestTurn, source: 'session' };
  }

  const derived = derive(session, phase, analyzed);
  return derived === null ? null : { text: derived, turnIndex: bestTurn, source: 'derived' };
}

// ---------------------------------------------------------------------------
// Choosing the sentence
// ---------------------------------------------------------------------------

function scoreOf(
  sentence: string,
  context: { isLast: boolean; grounding: Set<string>; kind: string },
): number {
  if (sentence.length < MIN_CHARS) return -99;
  let score = 0;
  if (CONCLUSION.test(sentence)) score += 3;
  if (KIND_TERMS[context.kind]?.test(sentence) === true) score += 2;
  if (context.isLast) score += 2;
  if (PREAMBLE.test(sentence)) score -= 5;
  // A sentence naming something the phase actually touched is about this phase.
  if ([...context.grounding].some((term) => sentence.includes(term))) score += 1;
  if (sentence.length > MAX_CHARS) score -= 2;
  return score;
}

/**
 * A conclusion often needs its follow-on clause to make sense ("That confirms
 * hypothesis #1. The author-page query is a plain equality…"), so a short winner
 * takes the next sentence with it when they still fit on two lines.
 */
function join(sentence: string, next: string | undefined): string {
  if (next === undefined) return clipSentence(sentence, MAX_CHARS, MIN_CHARS);
  const together = `${sentence} ${next}`;
  return clipSentence(sentence.length < 120 && together.length <= MAX_CHARS ? together : sentence, MAX_CHARS, MIN_CHARS);
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function lastAssistantTurn(turns: Turn[], phase: Phase): number {
  for (let i = phase.endIndex; i >= phase.startIndex; i--) {
    if (turns[i]?.role === 'assistant' && (turns[i]?.text ?? '').trim() !== '') return i;
  }
  return -1;
}

/** File names and identifiers the phase touched, for grounding a sentence to it. */
function groundingTerms(session: Session, phase: Phase): Set<string> {
  const terms = new Set<string>();
  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    for (const call of session.turns[i]?.toolCalls ?? []) {
      if (call.filePath !== null) {
        const name = call.filePath.split('/').pop();
        if (name !== undefined && name.length > 3) terms.add(name);
      }
    }
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Fallback: composed from computed facts, never invented
// ---------------------------------------------------------------------------

function derive(session: Session, phase: Phase, analyzed: AnalyzedSession): string | null {
  const index = analyzed.phases.indexOf(phase);

  switch (phase.kind) {
    case 'explore': {
      const trail = analyzed.trails.find((view) => view.phaseIndex === index)?.value ?? [];
      if (trail.length === 0) return null;
      const questions = trail.filter((step) => step.kind === 'search');
      const empty = questions.filter((step) => step.found.length === 0 && step.matches === 0).length;
      const files = new Set(trail.flatMap((step) => (step.path !== '' ? [step.path] : step.found))).size;
      if (questions.length === 0) {
        // Nothing was searched for — this phase just opened files.
        const names = trail.slice(0, 3).map((step) => basename(step.path)).filter((name) => name !== '');
        return names.length === 0 ? null : `Opened ${names.join(', ')}${files > names.length ? ` and ${files - names.length} more` : ''}.`;
      }
      const lead = questions[0]?.subject ?? 'the codebase';
      const rest = Math.max(0, questions.length - 1);
      return `Searched for ${lead}${rest > 0 ? ` and ${rest} other${rest === 1 ? '' : 's'}` : ''} across ${files} file${files === 1 ? '' : 's'}${empty > 0 ? `; ${empty} found nothing` : ''}.`;
    }
    case 'plan': {
      const revisions = analyzed.planRevisions.filter(
        (revision) => revision.turnIndex >= phase.startIndex && revision.turnIndex <= phase.endIndex,
      );
      const last = revisions[revisions.length - 1];
      if (last === undefined) return null;
      return planObjective(last.planText, MAX_CHARS) ?? `Planned the work over ${revisions.length} revision${revisions.length === 1 ? '' : 's'}.`;
    }
    case 'execute': {
      const files = analyzed.editHistories.filter((history) =>
        history.attempts.some(
          (attempt) => attempt.turnIndex >= phase.startIndex && attempt.turnIndex <= phase.endIndex,
        ),
      );
      const commands = analyzed.commands.find((view) => view.phaseIndex === index)?.value ?? [];
      const failed = commands.filter((group) => group.failed > 0);
      if (files.length === 0 && commands.length === 0) return null;
      const named = files.slice(0, 2).map((history) => basename(history.path)).join(' and ');
      const more = files.length > 2 ? ` and ${files.length - 2} more` : '';
      const changed = files.length > 0 ? `Edited ${named}${more}` : 'Ran commands';
      const outcome =
        failed.length > 0
          ? `; ${failed.map((group) => group.label.toLowerCase()).slice(0, 2).join(' and ')} failed`
          : '';
      return `${changed}${outcome}.`;
    }
    case 'verify': {
      const result = analyzed.verifications.find((view) => view.phaseIndex === index)?.value;
      if (result === undefined || result.checks.length === 0) return null;
      const passed = result.checks.filter((check) => check.outcome === 'success').length;
      return `${result.checks.length} check${result.checks.length === 1 ? '' : 's'}, ${passed} passed — ${result.checks.map((check) => check.label.toLowerCase()).join(', ')}.`;
    }
    case 'debug': {
      const sequences = analyzed.debugSequences.filter((sequence) => sequence.phaseIndex === index);
      const loops = sequences.reduce((n, sequence) => n + sequence.loops.length, 0);
      if (loops === 0) return null;
      const stuck = sequences.flatMap((sequence) => sequence.stuckRuns)[0];
      const cause = sequences.find((sequence) => sequence.breakthroughCause !== null)?.breakthroughCause;
      const stall = stuck === undefined ? '' : ` — ${stuck.endLoop - stuck.startLoop + 1} of them the same failure`;
      const broke = cause === undefined || cause === null ? '' : `, broken by ${cause}`;
      return `${loops} fix-and-run attempt${loops === 1 ? '' : 's'}${stall}${broke}.`;
    }
  }
}

/** The commands a phase ran, named — used by the derived execute line's callers. */
export function ranLabels(session: Session, phase: Phase): string[] {
  const labels: string[] = [];
  for (let i = phase.startIndex; i <= phase.endIndex; i++) {
    for (const call of session.turns[i]?.toolCalls ?? []) {
      if (call.category !== 'bash') continue;
      const label = checkTitle(commandOf(call));
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}
