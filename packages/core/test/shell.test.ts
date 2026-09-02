import { describe, expect, it } from 'vitest';

import { isHarnessPath, isReadOnlyShell, shellKind, shellTarget } from '../src/checks.js';
import { buildEditHistories } from '../src/diffs.js';
import { buildFileAccess } from '../src/files.js';
import { detectDebugLoops } from '../src/loops.js';
import { segmentPhases } from '../src/phases.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

describe('shellKind', () => {
  it('recognizes searching and reading, whatever tool carried it', () => {
    expect(shellKind('rg -n "authorId" src -l')).toBe('search');
    expect(shellKind('grep -r foo .')).toBe('search');
    expect(shellKind('find . -name "*.ts"')).toBe('search');
    expect(shellKind("sed -n '100,215p' src/app.ts")).toBe('read');
    expect(shellKind('cat package.json')).toBe('read');
    expect(shellKind('git log --oneline -8')).toBe('read');
    expect(shellKind('git diff --stat')).toBe('read');
  });

  it('does not call mutation or unknown work a read', () => {
    expect(shellKind("sed -i '' 's/a/b/' src/app.ts")).toBe('other');
    expect(shellKind('cat template.txt > out.txt')).toBe('other');
    expect(shellKind('git commit -m "wip"')).toBe('other');
    expect(shellKind('gcloud sql instances list')).toBe('other');
    expect(shellKind('mkdir -p tmp')).toBe('other');
  });

  it('keeps checks separate from reading', () => {
    expect(shellKind('pnpm test')).toBe('check');
    expect(shellKind('pnpm typecheck')).toBe('check');
    expect(isReadOnlyShell('pnpm test')).toBe(false);
    expect(isReadOnlyShell('rg foo src')).toBe(true);
  });

  it('classifies a pipeline by what it starts with', () => {
    expect(shellKind('rg -n "x" src | head -40')).toBe('search');
  });

  it('pulls the project-relative target out of a command', () => {
    expect(shellTarget('rg -n "authorId" "/Users/dev/code/src/forms" -l', '/Users/dev/code')).toBe('src/forms');
    expect(shellTarget('rg -n "authorId"', '/Users/dev/code')).toBeNull();
  });
});

describe('read-only shell counts as exploration', () => {
  it('classifies a phase of searching as explore, not as a write-heavy execute', () => {
    const session = sessionWith([
      userTurn('where is the author id set'),
      assistantTurn('looking', [
        tc.bash('rg -n "authorId" src -l', { result: 'src/forms/Edit.tsx' }),
        tc.bash('rg -n "ArticleForm" src', { result: 'src/forms/Edit.tsx:12' }),
        tc.bash("sed -n '1,80p' src/forms/Edit.tsx", { result: 'export function…' }),
        tc.bash('git log --oneline -5', { result: 'abc123 fix' }),
      ]),
      userTurn('got it', { gapSec: 120 }),
    ]);
    const phases = segmentPhases(session, detectDebugLoops(session));
    expect(phases[0]?.kind).toBe('explore');
    expect(phases[0]?.toolMix.write).toBe(0);
  });

  it('an rg that finds nothing is not a failing session', () => {
    const session = sessionWith([
      userTurn('is there a author tag'),
      // rg exits 1 when there are no matches — a result, not an error.
      assistantTurn('looking', [tc.bash('rg -n "authorTag" src', { error: 'exit code 1' })]),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const phases = segmentPhases(session, detectDebugLoops(session));
    expect(phases[0]?.kind).toBe('explore');
  });
});

describe('harness-owned files', () => {
  it('recognizes .claude paths anywhere in the tree', () => {
    expect(isHarnessPath('.claude/plans/ancient-roaming-alpaca.md')).toBe(true);
    expect(isHarnessPath('/Users/dev/code/.claude/settings.json')).toBe(true);
    expect(isHarnessPath('src/claude/helper.ts')).toBe(false);
  });

  it('excludes them from edit histories and the file graph', () => {
    const session = sessionWith([
      userTurn('plan and then do it'),
      assistantTurn('writing the plan', [
        tc.write('.claude/plans/ancient-roaming-alpaca.md', 'a whole plan document'),
        tc.edit('api/scripts/backfill.ts', 'a', 'b'),
      ]),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    expect(buildEditHistories(session).map((h) => h.path)).toEqual(['api/scripts/backfill.ts']);
    expect(buildFileAccess(session).map((f) => f.path)).toEqual(['api/scripts/backfill.ts']);
  });
});
