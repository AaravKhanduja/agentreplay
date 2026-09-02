/**
 * Heuristic concept extraction (§4.5): recurring 1–3 word phrases from user
 * turn text (never assistant text), ranked by spread × frequency, with files
 * accessed near the mentions attached.
 */

import type { Concept, Session } from './types.js';

const MAX_CONCEPTS = 8;
const MAX_NGRAM_WORDS = 3;
const MIN_DISTINCT_TURNS = 2;
const RELATED_TURN_RADIUS = 2;

const STOPWORDS = new Set(
  (
    'a an the and or but if then else so of in on at to for with from by as is are was were be been being am ' +
    'it its this that these those there here i me my we us our you your he she they them their do does did ' +
    'done doing can could should would shall will may might must not no nor yes ok okay just also only really ' +
    'please thanks make makes sure use using used want wants need needs get gets got let lets when what which ' +
    'how why where who than too very now some any all both each more most other another into onto about over ' +
    'under again once still up out off down have has had having like ' +
    // generic conversational filler that otherwise surfaces as junk concepts
    'anything something everything nothing thing things stuff way ways bit lot go goes going gone went keep ' +
    'keeps kept touch touched try trying tried look looking looked see seeing seen well fine great good bad ' +
    'new old full quick actually maybe probably basically dont doesnt didnt cant wont isnt arent ve ll re ' +
    'don doesn didn isn aren won'
  ).split(' '),
);

interface NgramStats {
  words: number;
  mentions: number;
  turnIndexes: Set<number>;
}

export function extractConcepts(session: Session): Concept[] {
  const stats = new Map<string, NgramStats>();

  session.turns.forEach((turn, turnIndex) => {
    if (turn.role !== 'user') return;
    for (const run of tokenRuns(turn.text)) {
      for (let size = 1; size <= MAX_NGRAM_WORDS; size++) {
        for (let i = 0; i + size <= run.length; i++) {
          const label = run.slice(i, i + size).join(' ');
          let entry = stats.get(label);
          if (entry === undefined) {
            entry = { words: size, mentions: 0, turnIndexes: new Set() };
            stats.set(label, entry);
          }
          entry.mentions += 1;
          entry.turnIndexes.add(turnIndex);
        }
      }
    }
  });

  const candidates = [...stats.entries()]
    .filter(([, entry]) => entry.turnIndexes.size >= MIN_DISTINCT_TURNS)
    .map(([label, entry]) => ({
      label,
      words: entry.words,
      mentions: entry.mentions,
      turnCount: entry.turnIndexes.size,
      turnIndexes: entry.turnIndexes,
      score: entry.turnIndexes.size * Math.log(1 + entry.mentions),
    }))
    .sort((a, b) => b.score - a.score || b.words - a.words || a.label.localeCompare(b.label));

  // Prefer longer ngrams over their contained sub-ngrams when counts are equal.
  const kept = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.words > candidate.words &&
          other.turnCount === candidate.turnCount &&
          other.mentions === candidate.mentions &&
          ` ${other.label} `.includes(` ${candidate.label} `),
      ),
  );

  const filesByTurn = session.turns.map((turn) =>
    turn.toolCalls.flatMap((call) =>
      call.filePath !== null && (call.category === 'read' || call.category === 'write')
        ? [call.filePath]
        : [],
    ),
  );

  return kept.slice(0, MAX_CONCEPTS).map((candidate) => {
    const related = new Set<string>();
    for (const turnIndex of candidate.turnIndexes) {
      const from = Math.max(0, turnIndex - RELATED_TURN_RADIUS);
      const to = Math.min(filesByTurn.length - 1, turnIndex + RELATED_TURN_RADIUS);
      for (let i = from; i <= to; i++) {
        for (const path of filesByTurn[i] ?? []) related.add(path);
      }
    }
    return {
      label: candidate.label,
      mentions: candidate.mentions,
      relatedFiles: [...related],
      source: 'heuristic' as const,
    };
  });
}

/**
 * Runs of meaningful tokens. Stopwords, short tokens and punctuation end a
 * run, so ngrams never span them.
 */
function tokenRuns(text: string): string[][] {
  const runs: string[][] = [];
  for (const fragment of text.toLowerCase().split(/[^a-z0-9_\s-]+/)) {
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    };
    for (const token of fragment.split(/[\s-]+/)) {
      if (token.length >= 2 && /[a-z]/.test(token) && !STOPWORDS.has(token)) current.push(token);
      else flush();
    }
    flush();
  }
  return runs;
}
