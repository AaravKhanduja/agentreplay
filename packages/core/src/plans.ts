/**
 * Plan revision extraction (§8.4).
 *
 * Plan text is the markdown emitted by assistant turns while plan mode is on
 * (plus the `plan` input of any ExitPlanMode call). Successive plan texts
 * become revisions, classified by how the paragraphs changed.
 */

import { createPatch } from 'diff';
import type { PlanRevision, PlanStep, Session, Turn } from './types.js';

const EXPANDED_GROWTH = 1.4; // a paragraph that grew >40% is 'expanded'
const PARAGRAPH_MATCH_WORDS = 3;
const MAX_STEPS = 10;
const MAX_STEP_CHARS = 70;

export function extractPlanRevisions(session: Session): PlanRevision[] {
  const revisions: PlanRevision[] = [];
  let previousText: string | null = null;

  session.turns.forEach((turn, turnIndex) => {
    const text = planTextOf(turn);
    if (text === null || text === previousText) return;

    const steps = diffSteps(
      previousText === null ? [] : stepsBelowObjective(previousText),
      stepsBelowObjective(text),
      previousText === null,
    );

    revisions.push({
      turnIndex,
      planText: text,
      triggerUserText: nearestUserText(session.turns, turnIndex),
      changeKind: previousText === null ? 'initial' : classifyChange(previousText, text),
      diffFromPrevious: previousText === null ? null : createPatch('plan', previousText, text),
      steps,
      change: {
        added: steps.filter((step) => step.change === 'added').length,
        removed: steps.filter((step) => step.change === 'removed').length,
        kept: steps.filter((step) => step.change === 'kept').length,
      },
    });
    previousText = text;
  });

  return revisions;
}

function planTextOf(turn: Turn): string | null {
  if (turn.role !== 'assistant') return null;
  // ExitPlanMode's `plan` input is the authoritative full plan; a turn's prose
  // usually restates it, so joining the two would duplicate the document.
  for (const call of turn.toolCalls) {
    if (call.name !== 'ExitPlanMode') continue;
    const plan = call.input['plan'];
    if (typeof plan === 'string' && plan.trim() !== '') return plan.trim();
  }
  if (turn.planMode && turn.text.trim() !== '') return turn.text.trim();
  return null;
}

function nearestUserText(turns: Turn[], fromIndex: number): string {
  for (let i = fromIndex - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn !== undefined && turn.role === 'user') return turn.text;
  }
  return '';
}

function classifyChange(previousText: string, nextText: string): 'added' | 'revised' | 'expanded' {
  const previous = paragraphs(previousText);
  const next = paragraphs(nextText);
  const nextSet = new Set(next);
  const previousSet = new Set(previous);

  // Pure append: every old paragraph survives unchanged and new ones exist.
  if (next.length > previous.length && previous.every((p) => nextSet.has(p))) return 'added';

  // A changed paragraph that grew >40% → expanded.
  for (const oldParagraph of previous) {
    if (nextSet.has(oldParagraph)) continue;
    const grown = next.find(
      (newParagraph) =>
        !previousSet.has(newParagraph) &&
        sameParagraph(oldParagraph, newParagraph) &&
        newParagraph.length > oldParagraph.length * EXPANDED_GROWTH,
    );
    if (grown !== undefined) return 'expanded';
  }

  return 'revised';
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

/** Cheap identity check between an old and a rewritten paragraph. */
function sameParagraph(oldParagraph: string, newParagraph: string): boolean {
  const oldStart = firstWords(oldParagraph);
  if (oldStart !== '' && oldStart === firstWords(newParagraph)) return true;
  const oldFirstLine = oldParagraph.split('\n')[0] ?? '';
  const newFirstLine = newParagraph.split('\n')[0] ?? '';
  return oldFirstLine !== '' && oldFirstLine === newFirstLine;
}

/** First few words, punctuation stripped, for pairing a paragraph with its rewrite. */
function firstWords(paragraph: string): string {
  return paragraph
    .split(/\s+/, PARAGRAPH_MATCH_WORDS)
    .map((word) => word.replace(/[^\p{L}\p{N}_-]+/gu, ''))
    .join(' ')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Steps — the shape of the plan, so revisions can be shown as a mutation
// ---------------------------------------------------------------------------

/**
 * The plan's steps, in order. Ordered list items win, then bullets, then `###`
 * headings; a plan with no list structure falls back to each paragraph's first
 * sentence, which is usually its topic sentence.
 */
/** The plan's steps without its objective sentence, which the head already shows. */
function stepsBelowObjective(planText: string): string[] {
  const objective = planObjective(planText);
  const steps = extractSteps(planText);
  if (objective === null) return steps;
  const key = normalizeStep(objective).slice(0, 40);
  // A plan whose only "step" is its objective has no steps: the section head
  // already shows that sentence, and printing it twice reads as a change.
  return steps.filter((step) => !normalizeStep(step).startsWith(key));
}

export function extractSteps(planText: string): string[] {
  // Fenced code inside a plan is illustration, not steps.
  const lines = planText.replace(/```[\s\S]*?```/g, '\n').split('\n');
  const numbered = lines.map(matchNumbered).filter(isText);
  if (numbered.length >= 2) return capSteps(numbered);
  const bullets = lines.map(matchBullet).filter(isText);
  if (bullets.length >= 2) return capSteps(bullets);
  const headings = headingSteps(lines);
  if (headings.length >= 2) return capSteps(headings);
  return capSteps(paragraphs(planText).map(firstSentence).filter(isText));
}

/**
 * Mark each step of the new plan against the old one.
 *
 * Matching is exact on normalized text, so a rewritten step reads as removed +
 * added rather than 'modified'. That state exists in the type for the semantic
 * matching this will eventually want; nothing emits it yet.
 */
export function diffSteps(previous: string[], next: string[], isFirst = previous.length === 0): PlanStep[] {
  if (isFirst) return next.map((text) => ({ text, change: 'kept' as const }));
  // A later revision that adds structure to a plan which had none: every step
  // is new, not merely "kept".
  if (previous.length === 0) return next.map((text) => ({ text, change: 'added' as const }));

  const previousKeys = previous.map(normalizeStep);
  const nextKeys = next.map(normalizeStep);
  const nextKeySet = new Set(nextKeys);

  const steps: PlanStep[] = [];
  let previousCursor = 0;

  next.forEach((text, i) => {
    const key = nextKeys[i] ?? '';
    const matchIndex = previousKeys.indexOf(key, previousCursor);
    if (matchIndex === -1) {
      steps.push({ text, change: 'added' });
      return;
    }
    // Steps dropped from the old plan surface where they used to be.
    for (let j = previousCursor; j < matchIndex; j++) {
      const dropped = previous[j];
      if (dropped !== undefined && !nextKeySet.has(previousKeys[j] ?? '')) {
        steps.push({ text: dropped, change: 'removed' });
      }
    }
    steps.push({ text, change: 'kept' });
    previousCursor = matchIndex + 1;
  });

  for (let j = previousCursor; j < previous.length; j++) {
    const dropped = previous[j];
    if (dropped !== undefined && !nextKeySet.has(previousKeys[j] ?? '')) {
      steps.push({ text: dropped, change: 'removed' });
    }
  }

  return steps.slice(0, MAX_STEPS);
}

function matchNumbered(line: string): string {
  return /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]?.trim() ?? '';
}

function matchBullet(line: string): string {
  return /^\s*[-*+]\s+(.+)$/.exec(line)?.[1]?.trim() ?? '';
}

/**
 * Headings as steps, taking the deepest level that has at least two entries —
 * a plan titled "## Plan" over "### Verify" / "### Parse" should list the
 * verbs, not its own title.
 */
function headingSteps(lines: string[]): string[] {
  const byLevel = new Map<number, string[]>();
  for (const line of lines) {
    const match = /^\s*(#{2,4})\s+(.+)$/.exec(line);
    const hashes = match?.[1];
    const heading = match?.[2]?.trim();
    if (hashes === undefined || heading === undefined || heading === '') continue;
    const level = hashes.length;
    byLevel.set(level, [...(byLevel.get(level) ?? []), heading]);
  }
  const deepest = [...byLevel.entries()]
    .sort((a, b) => b[0] - a[0])
    .find(([, headings]) => headings.length >= 2);
  return deepest?.[1] ?? [];
}

function isText(value: string): boolean {
  return value !== '';
}

function capSteps(steps: string[]): string[] {
  return steps.slice(0, MAX_STEPS).map(clean);
}

/** A step written as "Label: <code>" — the label is the step, the code is detail. */
const LABELLED_CODE = /^([^:]{2,44}):\s*(.+)$/;
// Deliberately narrow: a bare "(" appears in ordinary prose all the time.
const CODE_ISH = /\(\{|=>|;\s|\w+\.\w+\(|\[\]|\s=\s/;

/**
 * Strip inline markdown, drop the implementation, clip to one readable line.
 *
 * Plans often read "Authors: cmsPrisma.author.findMany({ where: … })". The label
 * is the step; the expression is how it will be done, and printing it makes a
 * plan look like a diff of somebody's editor.
 */
function clean(step: string): string {
  const stripped = step.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const labelled = LABELLED_CODE.exec(stripped);
  const label = labelled?.[1]?.trim();
  const rest = labelled?.[2] ?? '';
  const flat = label !== undefined && CODE_ISH.test(rest) ? label : stripped;
  if (flat.length <= MAX_STEP_CHARS) return flat;
  const cut = flat.slice(0, MAX_STEP_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 24 ? cut.slice(0, lastSpace) : cut}…`;
}

function firstSentence(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  const match = /^(.*?[.!?])(\s|$)/.exec(flat);
  return (match?.[1] ?? flat).trim();
}

function normalizeStep(step: string): string {
  return step
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The plan's first prose sentence — its objective. Code blocks, bullets and
 * headings are the *how*; the sentence above them is the *what*. The section
 * head shows it, so `extractSteps` drops it from the step list rather than
 * printing the same sentence twice.
 */
export function planObjective(planText: string, maxChars = 150): string | null {
  const withoutCode = planText.replace(/```[\s\S]*?```/g, '\n');
  for (const block of withoutCode.split(/\n{2,}/)) {
    const line = block.trim();
    if (line === '' || /^[#>\-*+|]|^\d+[.)]\s/.test(line)) continue;
    const flat = line.replace(/\s+/g, ' ');
    // Skip the abbreviation traps: "(e.g. an author page)" is not a sentence end.
    const sentence = /^(.*?(?<!\b(?:e\.g|i\.e|etc|vs))[.!?])(\s|$)/.exec(flat);
    const text = (sentence?.[1] ?? flat).trim();
    if (text.split(/\s+/).filter((w) => w !== '').length < 4) continue;
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return null;
}
