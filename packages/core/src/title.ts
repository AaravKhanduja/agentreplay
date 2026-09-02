/**
 * Session title: the one line at the top of the replay.
 *
 * Derived from the first thing the user asked for, deterministically. Ollama
 * may polish the wording later (ollama.ts), but the heuristic must stand on its
 * own — a title is the first thing anyone reads, so it never waits on a model.
 */

import type { Session } from './types.js';

const MAX_WORDS = 14;
const MAX_CHARS = 70;

/** Openers that add nothing: stripped from the front, repeatedly. */
const FILLER = [
  /^(hey|hi|hello|ok|okay|so|right|alright)[,!.\s]+/i,
  /^(can|could|would) you (please )?/i,
  /^please\s+/i,
  /^i (need|want|would like) (you )?to\s+/i,
  /^i need\s+/i,
  /^(lets|let's) (please )?/i,
  /^(help me|help)\s+/i,
  // "need to debug why X is broken" is a title about X, not about debugging.
  /^(need|want|trying|try) to (debug|figure out|understand|work out|investigate)\s+(why|how|what|whether)?\s*/i,
  /^(debug|figure out|investigate|look into|check)\s+(why|how|what|whether)\s+/i,
  /^(why|how come)\s+(is|are|does|do|did)\s+/i,
];

/**
 * Identifiers a person would never read aloud: collection ids, uuids, hashes.
 * They eat most of a title's budget and identify nothing to a human reader.
 */
const OPAQUE_ID = /\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{8,}\b/gi;

export function deriveTitle(session: Session): string {
  const first = session.turns.find((turn) => turn.role === 'user');
  const cleaned = first === undefined ? '' : cleanBody(first.text);
  const sentence = dropOpaqueIds(firstSentence(cleaned));
  const stripped = stripFiller(sentence);
  const capped = cap(stripped);
  return capped === '' ? fallback(session) : capitalize(capped);
}

/**
 * Remove ids like `collection-202608-a1b2c3d4e5f60718`. Words that mix letters
 * and digits and run long are machine identifiers; keeping them costs half the
 * title and tells the reader nothing.
 */
function dropOpaqueIds(text: string): string {
  return text
    .replace(OPAQUE_ID, (token) => (/^[a-z]+\d{1,4}$/i.test(token) ? token : ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Drop code fences, quoted blocks and headings — the parts that aren't the ask.
 * Inline code is unwrapped rather than dropped: `parseEvent` is usually the
 * most specific word in the sentence.
 */
function cleanBody(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('>') && !trimmed.startsWith('#');
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text);
  return (match?.[1] ?? text).trim().replace(/[.!?]+$/, '');
}

function stripFiller(text: string): string {
  let result = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of FILLER) {
      const next = result.replace(pattern, '');
      if (next !== result) {
        result = next.trim();
        changed = true;
      }
    }
  }
  return result;
}

/** Words too weak to end a title on — a cap that lands here trims one more. */
const DANGLING = new Set([
  'since', 'and', 'but', 'because', 'that', 'which', 'with', 'for', 'to', 'of', 'in', 'on',
  'at', 'by', 'from', 'as', 'when', 'while', 'after', 'before', 'so', 'the', 'a', 'an', 'is',
  'are', 'was', 'were', 'it', 'its',
]);

/** Cap at whole words, and never mid-path or on a dangling connective. */
function cap(text: string): string {
  const words = text.split(/\s+/).filter((word) => word !== '');
  let result = words.slice(0, MAX_WORDS).join(' ');
  if (result.length > MAX_CHARS) {
    const cut = result.slice(0, MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    result = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  }
  result = result.replace(/[,;:\-–—\s]+$/, '');
  let parts = result.split(' ');
  const dangling = (word: string): boolean =>
    // A trailing possessive is waiting for a noun that got cut off.
    DANGLING.has(word.toLowerCase()) || /['’]s$/.test(word);
  while (parts.length > 1 && dangling(parts[parts.length - 1] ?? '')) parts = parts.slice(0, -1);
  return parts.join(' ').replace(/[,;:\-–—\s]+$/, '');
}

/**
 * Capitalize the first letter only. No imperative rewriting: guessing a verb
 * is exactly where a heuristic title starts sounding wrong.
 */
function capitalize(text: string): string {
  const first = text[0];
  if (first === undefined) return text;
  // Leave identifiers and paths alone — "srcApi.ts" would be a lie.
  if (/[/._]/.test(text.split(/\s+/)[0] ?? '')) return text;
  return first.toUpperCase() + text.slice(1);
}

function fallback(session: Session): string {
  const name = session.projectPath.split('/').filter((part) => part !== '').pop() ?? 'Session';
  const started = new Date(session.startedAt);
  if (Number.isNaN(started.getTime())) return name;
  const month = started.toLocaleString('en-US', { month: 'short' });
  return `${name} · ${month} ${started.getDate()}`;
}
