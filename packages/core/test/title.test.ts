import { describe, expect, it } from 'vitest';

import { deriveTitle } from '../src/title.js';
import { assistantTurn, sessionWith, userTurn } from './builders.js';

const titleOf = (text: string): string => deriveTitle(sessionWith([userTurn(text), assistantTurn('ok', [])]));

describe('deriveTitle', () => {
  it('takes the first sentence of the first user turn', () => {
    expect(titleOf('Fix the stripe webhook signature check. It fails in prod.')).toBe(
      'Fix the stripe webhook signature check',
    );
  });

  it('strips lead-in filler, including stacked filler', () => {
    expect(titleOf('hey can you please fix the retry logic')).toBe('Fix the retry logic');
    expect(titleOf("ok so I need you to add pagination to the users endpoint")).toBe(
      'Add pagination to the users endpoint',
    );
  });

  it('drops code fences, inline code and quoted context', () => {
    const title = titleOf('```ts\nconst x = 1;\n```\n> pasted error\nrefactor `parseEvent` into two functions');
    expect(title).toBe('Refactor parseEvent into two functions');
  });

  it('caps long asks at a word boundary', () => {
    const title = titleOf(
      'rewrite the entire billing subsystem so that invoices and receipts and refunds all share one code path',
    );
    expect(title.length).toBeLessThanOrEqual(70);
    expect(title.endsWith('…')).toBe(false);
    expect(title.split(' ').length).toBeLessThanOrEqual(14);
  });

  it('leaves a leading identifier or path alone rather than sentence-casing it', () => {
    expect(titleOf('src/lib/stripe.ts is throwing on empty payloads')).toBe(
      'src/lib/stripe.ts is throwing on empty payloads',
    );
  });

  it('never ends on a possessive left hanging by the cap', () => {
    expect(
      titleOf("stripe webhook signatures are failing in prod since yesterday's deploy — datadog is full of errors"),
    ).toBe('Stripe webhook signatures are failing in prod');
  });

  it('drops machine identifiers and the debugging preamble', () => {
    expect(
      titleOf(
        'need to debug why this article the summer gala edit collection-202608-a1b2c3d4e5f60718 is not showing up on author page for maison b',
      ),
    ).toBe('This article the summer gala edit is not showing up on author page');
  });

  it('keeps short alphanumeric words that are really words', () => {
    expect(titleOf('upgrade to react19 in the dashboard')).toContain('react19');
  });

  it('falls back to the project name and date when there is nothing to use', () => {
    const session = sessionWith([userTurn('```\n\n```'), assistantTurn('ok', [])]);
    session.projectPath = '/Users/dev/code/webhook-service';
    expect(deriveTitle(session)).toMatch(/^webhook-service · [A-Z][a-z]{2} \d{1,2}$/);
  });

  it('never throws on an empty session', () => {
    expect(deriveTitle(sessionWith([])).length).toBeGreaterThan(0);
  });
});
