import { describe, expect, it } from 'vitest';

import { describe as describeCommand, summarizeCommands } from '../src/commands.js';
import { detectDebugLoops } from '../src/loops.js';
import { segmentPhases } from '../src/phases.js';
import type { Session } from '../src/types.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const groupsOf = (session: Session) => {
  const phases = segmentPhases(session, detectDebugLoops(session));
  const phase = phases[phases.length - 1];
  return phase === undefined ? [] : summarizeCommands(session, phase);
};

describe('describe', () => {
  it('names the action, not the command line', () => {
    expect(describeCommand('cd "/Users/dev/code/core" && pnpm run-ts scripts/backfill.ts --all')).toEqual({
      label: 'backfill.ts',
      kind: 'script',
    });
    expect(describeCommand('cd "/x" && pnpm turbo typecheck --filter @api 2>&1 | tail -20')).toEqual({
      label: 'Typecheck',
      kind: 'check',
    });
    expect(describeCommand('git diff --stat')).toEqual({ label: 'git diff', kind: 'git' });
    expect(describeCommand('pnpm build:api')).toEqual({ label: 'Build', kind: 'check' });
    expect(describeCommand('pnpm migrate')).toEqual({ label: 'migrate', kind: 'package' });
  });

  it('marks looking-around commands as inspection', () => {
    expect(describeCommand("sed -n '100,215p' src/app.ts").kind).toBe('inspect');
    expect(describeCommand('cat api/tsconfig.json | head -30').kind).toBe('inspect');
    expect(describeCommand('rg -n "authorId" src').kind).toBe('inspect');
  });

  it('never labels an action with a flag', () => {
    // `pnpm run-ts -e "console.log(…)"` has no script file to name.
    expect(describeCommand('cd "/x" && pnpm run-ts -e "console.log(process.env.DB)"')).toEqual({
      label: 'run-ts',
      kind: 'script',
    });
    expect(describeCommand('command -v doppler; doppler me 2>&1')).toEqual({
      label: 'doppler',
      kind: 'other',
    });
  });

  it('falls back to the program name', () => {
    expect(describeCommand('gcloud sql instances list --project x')).toEqual({
      label: 'gcloud',
      kind: 'other',
    });
  });
});

describe('summarizeCommands', () => {
  it('groups repeats and counts failures', () => {
    const session = sessionWith([
      userTurn('run the backfill'),
      assistantTurn('trying', [
        tc.bash('cd "/x" && pnpm run-ts scripts/backfill.ts', { error: 'Error: CMS_DATABASE_URL is not set' }),
        tc.bash('cd "/x" && pnpm run-ts scripts/backfill.ts --dry', { error: 'Error: CMS_DATABASE_URL is not set' }),
        tc.bash('cat .env | head -5', { result: 'NODE_ENV=dev' }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const groups = groupsOf(session);
    const backfill = groups.find((g) => g.label === 'backfill.ts');

    expect(backfill?.runs).toBe(2);
    expect(backfill?.failed).toBe(2);
    // The error is the information, not the command that produced it.
    expect(backfill?.note).toBe('Error: CMS_DATABASE_URL is not set');
    expect(groups.find((g) => g.kind === 'inspect')?.label).toBe('cat');
  });

  it('quotes the line that says what went wrong, not the build log preamble', () => {
    const session = sessionWith([
      userTurn('typecheck it'),
      assistantTurn('running', [
        tc.bash('cd "/x" && pnpm turbo typecheck --filter @api', {
          error:
            '@api:generate:graphql: cache miss, executing e04268\n' +
            '@api:typecheck: /Users/dev/code/core/api/scripts/backfill.ts(21,7): error TS2345: Argument of type…',
        }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const note = groupsOf(session).find((g) => g.label === 'Typecheck')?.note ?? '';
    expect(note).toContain('error TS2345');
    expect(note).not.toContain('cache miss');
    // Absolute paths are shortened rather than eating the line.
    expect(note).not.toContain('/Users/dev');
  });

  it('keeps a result line that carries a count, and drops echoed commands', () => {
    const session = sessionWith([
      userTurn('check it'),
      assistantTurn('running', [
        tc.bash('pnpm test', { result: 'Test Files 9 passed (9)\n Tests 84 passed (84)' }),
        tc.bash('pnpm typecheck', { result: 'tsc --noEmit' }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const groups = groupsOf(session);
    expect(groups.find((g) => g.label === 'Tests')?.note).toBe('Tests 84 passed (84)');
    expect(groups.find((g) => g.label === 'Typecheck')?.note).toBeNull();
  });

  it('prefers the line that explains the failure, even without an error word', () => {
    const session = sessionWith([
      userTurn('run it'),
      assistantTurn('running', [
        tc.bash('cd "/x" && pnpm run-ts scripts/backfill.ts', {
          error:
            'PrismaClientInitializationError: \n' +
            'Invalid `prisma.$connect()` invocation\n' +
            "Can't reach database server at `203.0.113.5:5432`\n" +
            '    at ri.handleRequestError (/Users/dev/code/node_modules/@prisma/client/runtime.js:120:11)',
        }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const note = groupsOf(session).find((g) => g.kind === 'script')?.note ?? '';
    // Either explanatory line is the story; the stack frame and the bare class
    // name are not.
    expect(note).toMatch(/Invalid `prisma|Can't reach database server/);
    expect(note).not.toContain('at ri.handleRequestError');
    expect(note).not.toBe('PrismaClientInitializationError:');
  });

  it('says nothing rather than quoting a warning it cannot vouch for', () => {
    const session = sessionWith([
      userTurn('typecheck'),
      assistantTurn('running', [
        tc.bash('pnpm turbo typecheck', {
          error: '@api:generate: cache miss, executing e04268\nWARN Unsupported engine: wanted node >=20',
        }),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    // A ✗ with no note reads as "it failed"; quoting the warning would claim
    // more than the output supports.
    expect(groupsOf(session).find((g) => g.label === 'Typecheck')?.note).toBeNull();
  });

  it('degrades to nothing when a phase ran no commands', () => {
    const session = sessionWith([
      userTurn('read it'),
      assistantTurn('reading', [tc.read('src/a.ts')]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    expect(groupsOf(session)).toEqual([]);
  });
});
