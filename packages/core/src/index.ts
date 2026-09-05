/**
 * Public API of @agentreplay/core.
 *
 * `analyzeSession` is the one entry point the CLI needs: session file in,
 * analysis + brief out. The individual steps are exported too so they can be
 * tested and reused in isolation.
 */

import { detectDebugLoops, groupDebugSequences } from './loops.js';
import { extractConcepts } from './concepts.js';
import { buildEditHistories } from './diffs.js';
import { countCrossSessionReads } from './discover.js';
import { buildFileAccess, buildFileEdges } from './files.js';
import { buildBrief } from './narrative.js';
import { enrichWithOllama } from './ollama.js';
import { resolveSessionRef } from './discover.js';
import { sourceOf } from './sources/index.js';
import { segmentPhases } from './phases.js';
import { summarizeCommands } from './commands.js';
import { extractEvents } from './events.js';
import { buildTimeline } from './timeline.js';
import { buildExploreTrail } from './trail.js';
import { buildVerifyResult } from './verify.js';
import { extractPlanRevisions } from './plans.js';
import { selectReplayEvents } from './replay.js';
import type {
  AnalyzedSession,
  AnalyzeOptions,
  AnalyzeResult,
  BriefExtras,
  Session,
  SessionRef,
} from './types.js';

export * from './types.js';
export { parseSessionFile, parseSessionJsonl } from './sources/claude/parser.js';
export { parseCodexFile, parseCodexJsonl } from './sources/codex/parser.js';
export { SOURCES, availableSources, sourceOf } from './sources/index.js';
export type { SessionSource } from './sources/types.js';
export { expandShellWrites } from './shellcalls.js';
export {
  discoverSessions,
  noSessionsMessage,
  resolveSessionRef,
  getClaudeProjectsDir,
  decodeProjectDir,
  countCrossSessionReads,
} from './discover.js';
export { segmentPhases } from './phases.js';
export {
  checkCategory,
  checkLabel,
  checkTitle,
  commandOf,
  isDelegation,
  planText,
  shellKind,
  shellWrites,
} from './checks.js';
export type { ShellKind, ShellWrite } from './checks.js';
export { buildFileAccess, buildFileEdges } from './files.js';
export { detectDebugLoops, groupDebugSequences } from './loops.js';
export { buildEditHistories } from './diffs.js';
export { extractConcepts } from './concepts.js';
export { extractPlanRevisions, extractSteps, diffSteps } from './plans.js';
export { buildBrief } from './narrative.js';
export { summarizeConclusion } from './summary.js';
export { extractEvents, pickBlocker, pickDecision, pickRootCause } from './events.js';
export { deriveTitle } from './title.js';
export { buildExploreTrail } from './trail.js';
export { buildTimeline } from './timeline.js';
export { summarizeCommands } from './commands.js';
export { buildVerifyResult, countChanges } from './verify.js';
export { detectOllama, enrichWithOllama } from './ollama.js';
export { selectReplayEvents } from './replay.js';

/**
 * Every heuristic, composed. Pure: a parsed session in, the full analysis out.
 *
 * Exported because the tests must exercise the same composition the CLI does —
 * hand-assembling an `AnalyzedSession` in each test file let the shape drift
 * every time a view was added.
 */
export function analyzeParsedSession(session: Session): AnalyzedSession {
  const loops = detectDebugLoops(session);
  const phases = segmentPhases(session, loops);

  const base: AnalyzedSession = {
    session,
    phases,
    events: [],
    timeline: buildTimeline(session, phases),
    trails: [],
    verifications: [],
    commands: [],
    files: buildFileAccess(session),
    fileEdges: buildFileEdges(session),
    editHistories: buildEditHistories(session),
    replay: [],
    debugSequences: groupDebugSequences(loops, phases),
    concepts: extractConcepts(session),
    planRevisions: extractPlanRevisions(session),
    enrichment: 'none',
  };

  // Per-phase views are computed here, not in the viewer: everything the
  // replay draws has to survive JSON.stringify into the generated HTML.
  const withViews: AnalyzedSession = {
    ...base,
    trails: phases
      .map((phase, phaseIndex) => ({ phaseIndex, value: buildExploreTrail(session, phase, base) }))
      .filter(({ phaseIndex }) => phases[phaseIndex]?.kind === 'explore'),
    verifications: phases
      .map((phase, phaseIndex) => ({ phaseIndex, value: buildVerifyResult(base, phase) }))
      .filter(({ phaseIndex }) => phases[phaseIndex]?.kind === 'verify'),
    commands: phases
      .map((phase, phaseIndex) => ({ phaseIndex, value: summarizeCommands(session, phase) }))
      .filter(({ value }) => value.length > 0),
  };

  // Events read the views (commands, edits), so they come after them — and
  // the replay reads the events, so it comes last of all.
  const withEvents = { ...withViews, events: extractEvents(withViews) };
  return { ...withEvents, replay: selectReplayEvents(withEvents) };
}

/**
 * A session file or id, analyzed. Takes a `SessionRef` when the caller already
 * resolved one (the picker hands back the row it listed), or a raw string to
 * resolve — a path, or an id searched across every installed agent.
 */
export async function analyzeSession(
  ref: string | SessionRef,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const resolved = typeof ref === 'string' ? await resolveSessionRef(ref) : ref;
  const source = sourceOf(resolved.agent);
  const { session, skippedLines } = await source.load(resolved);
  let analyzed = analyzeParsedSession(session);

  // Cross-session facts are optional I/O — best-effort, silent on failure.
  // A source omits the method where the answer isn't cheap to get right, and a
  // wrong count here would land inside a takeaway's data bar.
  const extras: BriefExtras = {};
  const rereadCandidates = analyzed.files.filter((f) => f.reads >= 2).map((f) => f.path);
  if (rereadCandidates.length > 0 && source.crossSessionReads !== undefined) {
    extras.crossSessionReads = await source.crossSessionReads(
      resolved,
      rereadCandidates,
      session.projectPath,
    );
  }

  // The brief sees the full analysis so it can cross-reference phases
  // (explore↔debug, plan↔debug) — it must never receive a single phase.
  let brief = buildBrief(analyzed, extras);

  const notes: string[] = [];
  if (options.ollama !== false) {
    const enriched = await enrichWithOllama(analyzed, brief, options.ollama ?? {});
    analyzed = enriched.analyzed;
    brief = enriched.brief;
    if (enriched.note) notes.push(enriched.note);
  }

  return { analyzed, brief, skippedLines, notes };
}
