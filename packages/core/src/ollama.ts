/**
 * Optional Ollama enrichment (§5). Hard scope: Ollama does exactly four
 * things — cleaned concept labels, session-title polish, takeaway fluency
 * rewrites, and tightening a section summary the session already contains. It must never do more, and it may never add
 * facts: rewrites that introduce numbers not present in the heuristic input
 * are discarded, and takeaway snippets are never touched. Every failure
 * path falls back to the heuristic values; enrichment can never break
 * analysis. `fetchImpl` is injectable so tests run without a server.
 */

import type {
  AnalyzedSession,
  Brief,
  EnrichResult,
  NarrativeStyle,
  OllamaOptions,
  RichText,
  Takeaway,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2:3b';
const DEFAULT_BUDGET_MS = 30_000;
const DETECT_TIMEOUT_MS = 1_000;

const SNIPPET_MAX_CHARS = 160;
const SNIPPETS_PER_CONCEPT = 2;

export async function detectOllama(
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  return (await fetchTags(baseUrl, fetchImpl)) !== null;
}

export async function enrichWithOllama(
  analyzed: AnalyzedSession,
  brief: Brief,
  opts: OllamaOptions,
  fetchImpl: FetchLike = fetch,
): Promise<EnrichResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const model = opts.model ?? DEFAULT_MODEL;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;

  const tags = await fetchTags(baseUrl, fetchImpl);
  if (tags === null) return { analyzed, brief, used: false, note: null };
  if (!hasModel(tags, model)) {
    return {
      analyzed,
      brief,
      used: false,
      note: `Model ${model} not found — run: ollama pull ${model}`,
    };
  }

  const deadline = Date.now() + budgetMs;
  const remaining = (): number => deadline - Date.now();

  const concepts = analyzed.concepts.map((concept) => ({ ...concept, relatedFiles: [...concept.relatedFiles] }));
  let landed = false;

  // 1. Concept labels — one call for all concepts.
  if (concepts.length > 0 && remaining() > 0) {
    const parsed = await generate(baseUrl, model, conceptPrompt(analyzed), remaining(), fetchImpl);
    const labels = (parsed as { labels?: unknown } | null)?.labels;
    if (Array.isArray(labels)) {
      labels.forEach((label, i) => {
        const concept = concepts[i];
        if (concept !== undefined && typeof label === 'string' && label.trim() !== '') {
          concept.label = label.trim();
          concept.source = 'ollama';
          landed = true;
        }
      });
    }
  }

  // 2. Session-title polish — one call. The title is the first thing anyone
  // reads, so the bar is high: no invented numbers, and every significant word
  // must already appear in what the user asked for.
  let title = brief.title;
  if (remaining() > 0) {
    const ask = firstUserText(analyzed);
    const parsed = await generate(baseUrl, model, titlePrompt(brief.title, ask), remaining(), fetchImpl);
    const polished = (parsed as { title?: unknown } | null)?.title;
    if (typeof polished === 'string' && acceptableTitle(polished.trim(), brief.title, ask)) {
      title = polished.trim();
      landed = true;
    }
  }

  // 3. Section-summary tightening — one call per section. The sentence is
  // quoted from the transcript; Ollama may only compress it. A rewrite that
  // introduces a number or a word the session never used is discarded, because
  // the reader is being shown this as something Claude said.
  const sections = brief.sections.map((section) => ({ ...section, components: [...section.components] }));
  for (const section of sections) {
    if (remaining() <= 0) break;
    const summary = section.summary;
    if (summary === null || summary.source !== 'session') continue;
    const parsed = await generate(baseUrl, model, summaryPrompt(summary.text), remaining(), fetchImpl);
    const tightened = (parsed as { summary?: unknown } | null)?.summary;
    if (typeof tightened === 'string' && acceptableSummary(tightened.trim(), summary.text)) {
      section.summary = { ...summary, text: tightened.trim(), source: 'ollama' };
      landed = true;
    }
  }

  // 4. Takeaway fluency rewrite — one call per takeaway; snippet untouched.
  const takeaways = brief.takeaways.map((takeaway) => ({ ...takeaway }));
  for (const takeaway of takeaways) {
    if (remaining() <= 0) break;
    const parsed = await generate(baseUrl, model, takeawayPrompt(takeaway), remaining(), fetchImpl);
    const lead = (parsed as { lead?: unknown } | null)?.lead;
    const body = (parsed as { body?: unknown } | null)?.body;
    const allowed = numbersIn([takeaway.lead, takeaway.body]);
    if (typeof lead === 'string' && lead.trim() !== '' && !inventsNumbers(lead, allowed)) {
      takeaway.lead = restyle(lead.trim(), takeaway.lead);
      landed = true;
    }
    if (
      typeof body === 'string' &&
      body.trim() !== '' &&
      takeaway.body.length > 0 &&
      !inventsNumbers(body, allowed)
    ) {
      takeaway.body = restyle(body.trim(), takeaway.body);
      landed = true;
    }
  }

  return {
    analyzed: {
      ...analyzed,
      concepts,
      enrichment: landed ? 'ollama' : analyzed.enrichment,
    },
    brief: { ...brief, title, sections, takeaways },
    used: landed,
    note: null,
  };
}

/** Model names from /api/tags, or null when Ollama is unreachable. */
async function fetchTags(baseUrl: string, fetchImpl: FetchLike): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) return [];
    return models.flatMap((entry) => {
      const name = (entry as { name?: unknown } | null)?.name;
      return typeof name === 'string' ? [name] : [];
    });
  } catch {
    return null;
  }
}

function hasModel(tags: string[], model: string): boolean {
  return tags.some((tag) => tag === model || tag === `${model}:latest` || tag.replace(/:latest$/, '') === model);
}

/** One /api/generate call; null on any failure (timeout, HTTP error, junk output). */
async function generate(
  baseUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<unknown> {
  if (timeoutMs <= 0) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const response = (body as { response?: unknown } | null)?.response;
    if (typeof response !== 'string') return null;
    return JSON.parse(response) as unknown;
  } catch {
    return null;
  }
}

function conceptPrompt(analyzed: AnalyzedSession): string {
  const userTurns = analyzed.session.turns.filter((turn) => turn.role === 'user');
  const items = analyzed.concepts.map((concept, i) => {
    const snippets = userTurns
      .filter((turn) => turn.text.toLowerCase().includes(concept.label.toLowerCase()))
      .slice(0, SNIPPETS_PER_CONCEPT)
      .map((turn) => JSON.stringify(truncate(turn.text, SNIPPET_MAX_CHARS)));
    const context = snippets.length > 0 ? ` — mentioned in: ${snippets.join(' | ')}` : '';
    return `${i + 1}. "${concept.label}"${context}`;
  });
  return [
    'These phrases were extracted from a coding session. For each phrase, produce a short cleaned-up human label (2-4 words).',
    `Respond with strict JSON: {"labels": ["...", ...]} — exactly ${analyzed.concepts.length} labels, one per phrase, in order.`,
    '',
    ...items,
  ].join('\n');
}

function titlePrompt(title: string, ask: string): string {
  return [
    'Write a short title (at most 8 words) for a coding session, from what the developer asked for.',
    'Use only words and names that appear in the request. Do not add numbers, file paths, or outcomes.',
    'Respond with strict JSON: {"title": "..."}',
    '',
    `Request: ${truncate(ask, TITLE_ASK_MAX_CHARS)}`,
    `Current title: ${title}`,
  ].join('\n');
}

const TITLE_MAX_CHARS = 60;
const TITLE_ASK_MAX_CHARS = 400;
const TITLE_WORD_FLOOR = 4; // words shorter than this are too common to check

function firstUserText(analyzed: AnalyzedSession): string {
  return analyzed.session.turns.find((turn) => turn.role === 'user')?.text ?? '';
}

/**
 * A polished title is accepted only if it stays short, invents no numbers, and
 * introduces no significant word the developer did not use — otherwise the
 * model is naming a session it made up.
 */
function acceptableTitle(polished: string, heuristic: string, ask: string): boolean {
  if (polished === '' || polished.length > TITLE_MAX_CHARS) return false;
  if (inventsNumbers(polished, numbersIn([[{ text: `${heuristic} ${ask}` }]]))) return false;
  const known = new Set(words(`${heuristic} ${ask}`));
  return words(polished).every((word) => word.length < TITLE_WORD_FLOOR || known.has(word));
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .map(stem);
}

/**
 * Crude suffix stripping, so the overlap check polices *facts* rather than
 * grammar: "dropping" → "dropped" is a rewrite, "Redis" appearing from nowhere
 * is an invention. Only the second should be rejected.
 */
function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function summaryPrompt(summary: string): string {
  return [
    'Shorten this sentence from a coding session to at most 25 words, keeping its meaning.',
    'Use only words that already appear in it. Do not add numbers, file paths, or conclusions.',
    'Respond with strict JSON: {"summary": "..."}',
    '',
    summary,
  ].join('\n');
}

const SUMMARY_MIN_CHARS = 30;
const SUMMARY_MAX_CHARS = 200;

/**
 * A tightened summary must stay a compression of the original: same facts, same
 * vocabulary, shorter. Anything else is the model writing its own sentence and
 * putting Claude's name on it.
 */
function acceptableSummary(tightened: string, original: string): boolean {
  if (tightened.length < SUMMARY_MIN_CHARS || tightened.length > SUMMARY_MAX_CHARS) return false;
  if (tightened.length >= original.length) return false;
  if (inventsNumbers(tightened, numbersIn([[{ text: original }]]))) return false;
  const known = new Set(words(original));
  return words(tightened).every((word) => word.length < TITLE_WORD_FLOOR || known.has(word));
}

function takeawayPrompt(takeaway: Takeaway): string {
  return [
    'Rewrite this finding about a coding session so it reads fluently — a bold lead sentence and a short supporting body.',
    'Keep the same meaning. Do not add any facts, file paths, error names, or numbers that are not already present.',
    'Respond with strict JSON: {"lead": "...", "body": "..."}',
    '',
    ...factsBlock([takeaway.lead, takeaway.body]),
    '',
    `Lead: ${plainTextOf(takeaway.lead)}`,
    `Body: ${plainTextOf(takeaway.body)}`,
  ].join('\n');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Narrative rewriting helpers
// ---------------------------------------------------------------------------

function plainTextOf(rich: RichText): string {
  return rich.map((span) => span.text).join('');
}

/** Compact facts list: file paths, styled key facts, and permitted numbers. */
function factsBlock(beats: RichText[]): string[] {
  const files = new Set<string>();
  const marks = new Set<string>();
  for (const beat of beats) {
    for (const span of beat) {
      if (span.style === 'file') files.add(span.text);
      else if (span.style !== undefined) marks.add(span.text);
    }
  }
  const numbers = numbersIn(beats);
  const lines: string[] = [];
  if (files.size > 0) lines.push(`Files: ${[...files].join(', ')}`);
  if (marks.size > 0) lines.push(`Key facts: ${[...marks].join(', ')}`);
  if (numbers.size > 0) lines.push(`Numbers you may use: ${[...numbers].join(', ')}`);
  return lines;
}

/** Every digit run in the plain text of the given beats. */
function numbersIn(beats: RichText[]): Set<string> {
  const numbers = new Set<string>();
  for (const beat of beats) {
    for (const match of plainTextOf(beat).matchAll(/\d+/g)) numbers.add(match[0]);
  }
  return numbers;
}

/** True when the rewrite contains a number the heuristic input never mentioned. */
function inventsNumbers(text: string, allowed: Set<string>): boolean {
  for (const match of text.matchAll(/\d+/g)) {
    if (!allowed.has(match[0])) return true;
  }
  return false;
}

/**
 * Re-apply the original beat's styles to rewritten text by exact substring
 * match (longest spans first, first occurrence, no overlaps). Substrings
 * that no longer appear simply stay plain.
 */
function restyle(text: string, original: RichText): RichText {
  const styledSpans: Array<{ text: string; style: NarrativeStyle }> = [];
  for (const span of original) {
    if (span.style !== undefined && span.text.trim() !== '') {
      styledSpans.push({ text: span.text, style: span.style });
    }
  }
  styledSpans.sort((a, b) => b.text.length - a.text.length);

  const claimed: Array<{ start: number; end: number; style: NarrativeStyle }> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some((range) => start < range.end && end > range.start);

  for (const span of styledSpans) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(span.text, from);
      if (index === -1) break;
      if (!overlaps(index, index + span.text.length)) {
        claimed.push({ start: index, end: index + span.text.length, style: span.style });
        break;
      }
      from = index + 1;
    }
  }

  if (claimed.length === 0) return [{ text }];
  claimed.sort((a, b) => a.start - b.start);

  const spans: RichText = [];
  let cursor = 0;
  for (const range of claimed) {
    if (range.start > cursor) spans.push({ text: text.slice(cursor, range.start) });
    spans.push({ text: text.slice(range.start, range.end), style: range.style });
    cursor = range.end;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) });
  return spans;
}
