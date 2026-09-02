import { describe, expect, it } from 'vitest';

import { detectOllama, enrichWithOllama } from '../src/ollama.js';
import type { FetchLike } from '../src/ollama.js';
import type { AnalyzedSession, Brief } from '../src/types.js';
import { assistantTurn, sessionWith, userTurn } from './builders.js';

function makeAnalyzed(): AnalyzedSession {
  const session = sessionWith([userTurn('fix the webhook retry logic'), assistantTurn('on it', [])]);
  return {
    session,
    trails: [],
    verifications: [],
    phases: [
      {
        kind: 'execute',
        startIndex: 0,
        endIndex: 1,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        toolMix: { read: 0, write: 1, bash: 1, meta: 0 },
        summary: null,
      },
    ],
    files: [],
    fileEdges: [],
    editHistories: [],
    debugSequences: [],
    concepts: [{ label: 'webhook retry', mentions: 3, relatedFiles: ['src/retry.ts'], source: 'heuristic' }],
    planRevisions: [],
    enrichment: 'none',
  };
}

function makeBrief(): Brief {
  return {
    title: 'Fix the webhook retry logic',
    stats: { toolCalls: 2, filesChanged: 1, added: 4, removed: 2, outcome: 'passed' },
    headline: [{ text: 'Everything passed first try', style: 'good' }, { text: '.' }],
    takeaways: [
      {
        kind: 'tip',
        lead: [{ text: 'Pin ' }, { text: 'src/retry.ts', style: 'file' }, { text: ' in your CLAUDE.md.' }],
        body: [{ text: 'Read ' }, { text: '3×', style: 'hl' }, { text: ' this session.' }],
        snippet: '# src/retry.ts contains the retry logic',
      },
    ],
    sections: [
      {
        phaseIndex: 0,
        title: 'Execute',
        summary: {
          text: 'The retry worker was dropping jobs because the queue key changed in the last deploy.',
          turnIndex: 1,
          source: 'session',
        },
        components: ['src/retry.ts'],
        intent: null,
        timeRange: '10:00–10:20',
        statLine: '2 edits · 2 files',
        badge: { text: 'clean', tone: 'green' },
      },
    ],
    thin: false,
  };
}

const TAGS_OK = { models: [{ name: 'llama3.2:3b' }] };

/** Fetch stub: /api/tags result + a generate() responder keyed on the prompt. */
function stubFetch(opts: {
  tags?: unknown | null;
  generate?: (prompt: string) => unknown;
  delayMs?: number;
}): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    if (opts.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    if (input.endsWith('/api/tags')) {
      calls.push('tags');
      if (opts.tags === null) throw new Error('unreachable');
      return new Response(JSON.stringify(opts.tags ?? TAGS_OK));
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
    const prompt = body.prompt ?? '';
    calls.push(
      prompt.includes('"labels"')
        ? 'labels'
        : prompt.includes('"title"')
          ? 'title'
          : prompt.includes('"summary"')
            ? 'summary'
            : 'takeaway',
    );
    const out = opts.generate?.(prompt) ?? {};
    return new Response(JSON.stringify({ response: JSON.stringify(out) }));
  };
  return { fetchImpl, calls };
}

const text = (rich: Array<{ text: string }>): string => rich.map((span) => span.text).join('');

describe('detectOllama', () => {
  it('is true when /api/tags answers and false when unreachable', async () => {
    expect(await detectOllama('http://x', stubFetch({}).fetchImpl)).toBe(true);
    expect(await detectOllama('http://x', stubFetch({ tags: null }).fetchImpl)).toBe(false);
  });
});

describe('enrichWithOllama', () => {
  it('passes analyzed and brief through untouched when unreachable', async () => {
    const analyzed = makeAnalyzed();
    const brief = makeBrief();
    const result = await enrichWithOllama(analyzed, brief, {}, stubFetch({ tags: null }).fetchImpl);
    expect(result.analyzed).toBe(analyzed);
    expect(result.brief).toBe(brief);
    expect(result.used).toBe(false);
    expect(result.note).toBeNull();
  });

  it('emits the exact pull instruction when the model is missing', async () => {
    const result = await enrichWithOllama(
      makeAnalyzed(),
      makeBrief(),
      { model: 'mistral:7b' },
      stubFetch({}).fetchImpl,
    );
    expect(result.used).toBe(false);
    expect(result.note).toBe('Model mistral:7b not found — run: ollama pull mistral:7b');
  });

  it('relabels concepts and marks enrichment', async () => {
    const { fetchImpl } = stubFetch({
      generate: (prompt) => (prompt.includes('"labels"') ? { labels: ['Webhook Retry Logic'] } : {}),
    });
    const result = await enrichWithOllama(makeAnalyzed(), makeBrief(), {}, fetchImpl);
    expect(result.analyzed.concepts[0]?.label).toBe('Webhook Retry Logic');
    expect(result.analyzed.concepts[0]?.source).toBe('ollama');
    expect(result.analyzed.enrichment).toBe('ollama');
  });

  it('polishes the session title using only words the developer used', async () => {
    const { fetchImpl } = stubFetch({
      generate: (prompt) => (prompt.includes('"title"') ? { title: 'Fix webhook retry logic' } : {}),
    });
    const result = await enrichWithOllama(makeAnalyzed(), makeBrief(), {}, fetchImpl);
    expect(result.brief.title).toBe('Fix webhook retry logic');
    expect(result.used).toBe(true);
  });

  it('discards a title that names something the developer never mentioned', async () => {
    const original = makeBrief();
    const { fetchImpl } = stubFetch({
      generate: (prompt) => (prompt.includes('"title"') ? { title: 'Migrate billing to Stripe' } : {}),
    });
    const result = await enrichWithOllama(makeAnalyzed(), original, {}, fetchImpl);
    expect(result.brief.title).toBe(original.title);
  });

  it('discards a title that invents a number', async () => {
    const original = makeBrief();
    const { fetchImpl } = stubFetch({
      generate: (prompt) => (prompt.includes('"title"') ? { title: 'Fix 3 webhook retry bugs' } : {}),
    });
    const result = await enrichWithOllama(makeAnalyzed(), original, {}, fetchImpl);
    expect(result.brief.title).toBe(original.title);
  });

  it('tightens a quoted section summary without changing its facts', async () => {
    const { fetchImpl } = stubFetch({
      generate: (prompt) =>
        prompt.includes('"summary"')
          ? { summary: 'The retry worker dropped jobs because the queue key changed in the last deploy.' }
          : {},
    });
    const result = await enrichWithOllama(makeAnalyzed(), makeBrief(), {}, fetchImpl);
    const summary = result.brief.sections[0]?.summary;
    expect(summary?.text).toBe('The retry worker dropped jobs because the queue key changed in the last deploy.');
    // Marked as rewritten, so the viewer never claims it is verbatim.
    expect(summary?.source).toBe('ollama');
  });

  it('discards a summary that introduces a word the session never used', async () => {
    const original = makeBrief();
    const { fetchImpl } = stubFetch({
      generate: (prompt) =>
        prompt.includes('"summary"') ? { summary: 'Redis eviction dropped the retry jobs after the deploy.' } : {},
    });
    const result = await enrichWithOllama(makeAnalyzed(), original, {}, fetchImpl);
    expect(result.brief.sections[0]?.summary?.text).toBe(original.sections[0]?.summary?.text);
    expect(result.brief.sections[0]?.summary?.source).toBe('session');
  });

  it('never rewrites a derived summary — that sentence is ours, not Claude\'s', async () => {
    const brief = makeBrief();
    const derived = { ...brief, sections: brief.sections.map((section) => ({
      ...section,
      summary: { text: 'Edited 2 files (+8 −3); tests passing.', turnIndex: 1, source: 'derived' as const },
    })) };
    const { fetchImpl, calls } = stubFetch({
      generate: (prompt) => (prompt.includes('"summary"') ? { summary: 'Edited two files; tests pass.' } : {}),
    });
    const result = await enrichWithOllama(makeAnalyzed(), derived, {}, fetchImpl);
    expect(result.brief.sections[0]?.summary?.text).toBe('Edited 2 files (+8 −3); tests passing.');
    expect(calls).not.toContain('summary');
  });

  it('rewrites takeaways but never touches the snippet', async () => {
    const { fetchImpl } = stubFetch({
      generate: (prompt) =>
        prompt.includes('"lead"')
          ? { lead: 'Worth pinning src/retry.ts in CLAUDE.md.', body: 'It was read 3× this session.' }
          : {},
    });
    const result = await enrichWithOllama(makeAnalyzed(), makeBrief(), {}, fetchImpl);
    const takeaway = result.brief.takeaways[0];
    expect(text(takeaway?.lead ?? [])).toBe('Worth pinning src/retry.ts in CLAUDE.md.');
    expect(takeaway?.lead.find((span) => span.style === 'file')?.text).toBe('src/retry.ts');
    expect(text(takeaway?.body ?? [])).toBe('It was read 3× this session.');
    expect(takeaway?.snippet).toBe('# src/retry.ts contains the retry logic');
  });

  it('discards a takeaway rewrite that invents a number, keeping the template', async () => {
    const original = makeBrief();
    const { fetchImpl } = stubFetch({
      generate: (prompt) =>
        prompt.includes('"lead"') ? { lead: 'Read 12 times — pin src/retry.ts.', body: 'nope 99' } : {},
    });
    const result = await enrichWithOllama(makeAnalyzed(), original, {}, fetchImpl);
    expect(result.brief.takeaways[0]?.lead).toEqual(original.takeaways[0]?.lead);
    expect(result.brief.takeaways[0]?.body).toEqual(original.takeaways[0]?.body);
  });

  it('falls back silently on junk JSON', async () => {
    const original = makeBrief();
    const fetchImpl: FetchLike = async (input) => {
      if (input.endsWith('/api/tags')) return new Response(JSON.stringify(TAGS_OK));
      return new Response(JSON.stringify({ response: 'not json at all {' }));
    };
    const result = await enrichWithOllama(makeAnalyzed(), original, {}, fetchImpl);
    expect(result.brief.title).toBe(original.title);
    expect(result.brief.takeaways).toEqual(original.takeaways);
    expect(result.used).toBe(false);
  });

  it('stops issuing calls when the budget is exhausted', async () => {
    const { fetchImpl, calls } = stubFetch({ delayMs: 30 });
    const result = await enrichWithOllama(makeAnalyzed(), makeBrief(), { budgetMs: 25 }, fetchImpl);
    // tags consumed the budget; at most one generate call slipped in.
    expect(calls.filter((call) => call !== 'tags').length).toBeLessThanOrEqual(1);
    expect(result.brief.takeaways[0]?.snippet).toBe('# src/retry.ts contains the retry logic');
  });

  it('does not mutate its inputs', async () => {
    const analyzed = makeAnalyzed();
    const brief = makeBrief();
    const before = JSON.parse(JSON.stringify({ analyzed, brief }));
    const { fetchImpl } = stubFetch({
      generate: (prompt) =>
        prompt.includes('"labels"')
          ? { labels: ['X'] }
          : prompt.includes('"story"')
            ? { story: 'src/retry.ts took 2 edit attempts.' }
            : { lead: 'Pin src/retry.ts.', body: 'Read 3× here.' },
    });
    await enrichWithOllama(analyzed, brief, {}, fetchImpl);
    expect(JSON.parse(JSON.stringify({ analyzed, brief }))).toEqual(before);
  });
});
