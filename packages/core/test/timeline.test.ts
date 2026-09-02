import { describe, expect, it } from 'vitest';

import { detectDebugLoops } from '../src/loops.js';
import { segmentPhases } from '../src/phases.js';
import { buildTimeline } from '../src/timeline.js';
import type { Session } from '../src/types.js';
import { assistantTurn, sessionWith, tc, userTurn } from './builders.js';

const timelineOf = (session: Session) => buildTimeline(session, segmentPhases(session, detectDebugLoops(session)));

describe('buildTimeline', () => {
  it('compresses idle so the work stays legible, and records what was skipped', () => {
    const session = sessionWith([
      userTurn('start'),
      assistantTurn('working', [tc.read('src/a.ts'), tc.read('src/b.ts')]),
      // 50 minutes away — clamped on the axis, but named on it.
      userTurn('back', { gapSec: 3000 }),
      assistantTurn('more', [tc.edit('src/a.ts', 'x', 'y')], { gapSec: 30 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const timeline = timelineOf(session);

    expect(timeline.gaps).toHaveLength(1);
    expect(Math.round((timeline.gaps[0]?.ms ?? 0) / 60_000)).toBe(50);
    // The 50-minute pause contributes at most the 3-minute clamp to the axis.
    expect(timeline.totalActiveMs).toBeLessThan(10 * 60_000);
  });

  it('places every tool call on the axis in order, flagging failures', () => {
    const session = sessionWith([
      userTurn('go'),
      assistantTurn('working', [
        tc.read('src/a.ts'),
        tc.edit('src/a.ts', 'x', 'y'),
        tc.bash('pnpm test', { error: 'Error: boom' }),
      ]),
      userTurn('ok', { gapSec: 120 }),
    ]);
    const { marks } = timelineOf(session);

    expect(marks.map((m) => m.category)).toEqual(['read', 'write', 'bash']);
    expect(marks.map((m) => m.failed)).toEqual([false, false, true]);
    const offsets = marks.map((m) => m.activeOffsetMs);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('lays phases end to end, covering the whole axis', () => {
    const session = sessionWith([
      userTurn('look around'),
      assistantTurn('reading', [tc.read('src/a.ts'), tc.read('src/b.ts'), tc.read('src/c.ts')]),
      userTurn('now build it', { gapSec: 200 }),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y'), tc.bash('pnpm test', { result: 'ok' })], { gapSec: 60 }),
      userTurn('thanks', { gapSec: 120 }),
    ]);
    const timeline = timelineOf(session);
    const phases = segmentPhases(session, detectDebugLoops(session));

    expect(timeline.segments).toHaveLength(phases.length);
    timeline.segments.forEach((segment, i) => {
      expect(segment.phaseIndex).toBe(i);
      const previous = timeline.segments[i - 1];
      if (previous !== undefined) {
        expect(segment.activeStartMs).toBe(previous.activeStartMs + previous.activeMs);
      }
    });
  });

  it('never places a mark past the end of the axis', () => {
    const session = sessionWith([
      userTurn('look around'),
      assistantTurn('reading', [tc.read('src/a.ts'), tc.read('src/b.ts')]),
      userTurn('now build', { gapSec: 4000 }),
      assistantTurn('editing', [tc.edit('src/a.ts', 'x', 'y'), tc.bash('pnpm test', { result: 'ok' })], { gapSec: 60 }),
      userTurn('thanks', { gapSec: 200 }),
    ]);
    const timeline = timelineOf(session);
    for (const mark of timeline.marks) {
      expect(mark.activeOffsetMs).toBeLessThanOrEqual(timeline.totalActiveMs);
    }
    // The axis is exactly the phases laid end to end.
    const last = timeline.segments[timeline.segments.length - 1];
    expect((last?.activeStartMs ?? 0) + (last?.activeMs ?? 0)).toBe(timeline.totalActiveMs);
  });

  it('never throws on an empty session', () => {
    const timeline = buildTimeline(sessionWith([]), []);
    expect(timeline.marks).toEqual([]);
    expect(timeline.totalActiveMs).toBeGreaterThan(0);
  });
});
