import { describe, expect, it } from 'vitest';

import { extractConcepts } from '../src/concepts.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

describe('extractConcepts', () => {
  it('keeps phrases mentioned in >=2 distinct user turns and drops one-offs', () => {
    const session = sessionWith([
      userTurn('fix the webhook handler retry logic'),
      assistantTurn('on it', [tc.read('src/webhook.ts')]),
      userTurn('the webhook handler drops events'),
    ]);
    const labels = extractConcepts(session).map((c) => c.label);
    expect(labels).toContain('webhook handler');
    expect(labels).not.toContain('retry logic'); // single turn only
  });

  it('prefers longer ngrams over contained sub-ngrams with equal counts', () => {
    const session = sessionWith([
      userTurn('the webhook handler is broken'),
      userTurn('please fix webhook handler now'),
    ]);
    const labels = extractConcepts(session).map((c) => c.label);
    expect(labels).toContain('webhook handler');
    expect(labels).not.toContain('webhook');
    expect(labels).not.toContain('handler');
  });

  it('keeps a sub-ngram whose counts differ from the longer ngram', () => {
    const session = sessionWith([
      userTurn('the webhook handler is broken'),
      userTurn('fix webhook handler please'),
      userTurn('the webhook itself times out'),
    ]);
    const concepts = extractConcepts(session);
    const webhook = concepts.find((c) => c.label === 'webhook');
    expect(webhook).toBeDefined();
    expect(webhook?.mentions).toBe(3);
  });

  it('ignores assistant turn text entirely', () => {
    const session = sessionWith([
      userTurn('hello'),
      assistantTurn('database migration is the key, database migration everywhere'),
      assistantTurn('database migration again'),
      userTurn('thanks'),
    ]);
    expect(extractConcepts(session).map((c) => c.label)).not.toContain('database migration');
  });

  it('ranks by distinct-turn count times log(1 + mentions)', () => {
    const session = sessionWith([
      userTurn('the parser cache is stale'),
      userTurn('parser cache again, clear the parser cache'),
      userTurn('parser cache still stale'),
      userTurn('token bucket refill is wrong'),
      userTurn('check token bucket size'),
    ]);
    const labels = extractConcepts(session).map((c) => c.label);
    expect(labels.indexOf('parser cache')).toBeLessThan(labels.indexOf('token bucket'));
  });

  it('attaches files accessed within ±2 turns of mentions', () => {
    const session = sessionWith([
      userTurn('the webhook handler is broken'), // turn 0
      assistantTurn('reading', [tc.read('src/webhook.ts')]), // turn 1
      userTurn('webhook handler still broken'), // turn 2
      assistantTurn('ok'), // turn 3
      assistantTurn('ok'), // turn 4
      assistantTurn('far away', [tc.read('src/far.ts')]), // turn 5 — outside ±2 of both mentions
    ]);
    const concept = extractConcepts(session).find((c) => c.label === 'webhook handler');
    expect(concept?.relatedFiles).toContain('src/webhook.ts');
    expect(concept?.relatedFiles).not.toContain('src/far.ts');
  });

  it('caps the result at 8 concepts', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const spaced = words.split(' ').join(' and '); // stopword separators keep them unigrams
    const session = sessionWith([userTurn(spaced), userTurn(spaced)]);
    expect(extractConcepts(session)).toHaveLength(8);
  });

  it('returns [] when nothing recurs', () => {
    const session = sessionWith([userTurn('one single message about caching')]);
    expect(extractConcepts(session)).toEqual([]);
  });

  it('marks every concept heuristic with a mention count', () => {
    const session = sessionWith([userTurn('rate limiter'), userTurn('rate limiter again')]);
    const concept = extractConcepts(session).find((c) => c.label === 'rate limiter');
    expect(concept?.source).toBe('heuristic');
    expect(concept?.mentions).toBe(2);
  });
});
