/**
 * Shared data model for AgentReplay.
 *
 * Three layers:
 *   raw        — one object per JSONL line, minimally interpreted
 *   normalized — Session / Turn / ToolCall: what actually happened
 *   analysis   — phases, file graph, debug loops, concepts, plan revisions
 *
 * All timestamps are ISO 8601 strings (`Iso`), not Date objects: an
 * AnalyzedSession is serialized with JSON.stringify straight into the
 * generated HTML, so keeping the in-memory shape identical to the wire
 * shape removes a whole class of date-revival bugs in the viewer.
 */

/** ISO 8601 timestamp string, e.g. "2026-07-25T22:49:34.855Z". */
export type Iso = string;

// ---------------------------------------------------------------------------
// Raw layer (JSONL parse)
// ---------------------------------------------------------------------------

export interface RawEvent {
  uuid: string;
  parentUuid: string | null;
  timestamp: Iso;
  type: 'user' | 'assistant' | 'system' | 'summary' | (string & {});
  /** The full parsed JSONL line, untouched — schema drifts between Claude Code versions. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Normalized layer
// ---------------------------------------------------------------------------

export type ToolCategory = 'read' | 'write' | 'bash' | 'meta';
// read:  Read, Grep, Glob, LS, WebFetch, WebSearch
// write: Edit, Write, MultiEdit, NotebookEdit
// bash:  Bash, BashOutput, KillShell
// meta:  TodoWrite, Task, ExitPlanMode, everything else

export interface ToolCall {
  id: string;
  /** Original tool name, e.g. "Edit". */
  name: string;
  category: ToolCategory;
  timestamp: Iso;
  /** Derived from the matching tool_result timestamp; null when the result is orphaned. */
  durationMs: number | null;
  /** Tool params. String values longer than ~4000 chars are truncated at parse time. */
  input: Record<string, unknown>;
  /** Extracted from input when applicable, relative to the project root. */
  filePath: string | null;
  outcome: 'success' | 'error' | 'unknown';
  /** First ~500 chars of error output, when outcome is 'error'. */
  errorText: string | null;
  /** First ~300 chars of the result. */
  resultPreview: string | null;
}

export interface Turn {
  role: 'user' | 'assistant';
  timestamp: Iso;
  text: string;
  /** Tool calls made in this assistant turn (always [] for user turns). */
  toolCalls: ToolCall[];
  /** True if this turn happened while Claude Code was in plan mode. */
  planMode: boolean;
}

export interface Session {
  /** Session uuid — the JSONL filename without extension. */
  id: string;
  /** Absolute project path, from the events' `cwd` or decoded from the directory name. */
  projectPath: string;
  startedAt: Iso;
  endedAt: Iso;
  turns: Turn[];
  model: string | null;
  totalTokens: number | null;
}

/** Result of parsing one session file. */
export interface ParsedSession {
  session: Session;
  /** Count of unparseable lines that were skipped (never crash on malformed JSONL). */
  skippedLines: number;
}

/** Cheap per-file metadata for the session picker — no full parse. */
export interface SessionMeta {
  filePath: string;
  sessionId: string;
  projectPath: string;
  messageCount: number;
  durationMs: number | null;
  mtimeMs: number;
}

// ---------------------------------------------------------------------------
// Analysis layer
// ---------------------------------------------------------------------------

export type PhaseKind = 'explore' | 'plan' | 'execute' | 'debug' | 'verify';

export interface Phase {
  kind: PhaseKind;
  /** Turn index range, inclusive. */
  startIndex: number;
  endIndex: number;
  startedAt: Iso;
  endedAt: Iso;
  /**
   * Time with something actually happening: wall-clock minus every gap longer
   * than a few minutes. A phase that spans two hours because the developer went
   * to lunch did not take two hours, and saying it did buries the real numbers.
   */
  activeMs: number;
  toolMix: Record<ToolCategory, number>;
}

export interface FileAccess {
  /** Relative to the project root. */
  path: string;
  reads: number;
  writes: number;
  timestamps: Iso[];
  /** Read again after ≥3 distinct other files were touched since its last access. */
  isBacktracked: boolean;
}

/** Consecutive file accesses form edges (A then B → edge A→B) for the explore graph. */
export interface FileEdge {
  from: string;
  to: string;
  weight: number;
}

export interface DebugLoop {
  index: number;
  /** Turn index of the write that starts the loop — used to map loops onto phases. */
  turnIndex: number;
  startedAt: Iso;
  /** signature = normalized first line of the error, for same-error comparison. */
  error: { text: string; signature: string };
  attempt: { filePath: string; diffSummary: string; editCount: number };
  /** The check that closed the loop — the bash call run after the edit. */
  check: { command: string; /** "TEST" / "TYPES" / "LINT" */ label: string; outcome: 'success' | 'error' | 'unknown' };
  /** First line of the error, trimmed — e.g. "signature mismatch". */
  errorLine: string;
  /** Files read between the previous loop and this attempt. */
  precedingReads: string[];
  /** Tool calls in that same gap that were not reads — the chain collapses these. */
  precedingOtherCalls: number;
  result: 'same-error' | 'new-error' | 'passed';
}

export interface DebugSequence {
  phaseIndex: number;
  loops: DebugLoop[];
  /** ≥3 consecutive loops with an identical error signature. */
  stuckRuns: Array<{ startLoop: number; endLoop: number; errorSignature: string; durationMs: number }>;
  /** First loop after a stuck run with result !== 'same-error'. */
  breakthroughLoop: number | null;
  /** e.g. "read utils/signature.ts" when the breakthrough's precedingReads is non-empty. */
  breakthroughCause: string | null;
}

export interface Concept {
  /** Heuristic: literal phrase; Ollama: cleaned label. */
  label: string;
  mentions: number;
  relatedFiles: string[];
  source: 'heuristic' | 'ollama';
}

/**
 * One step of a plan, diffed against the previous revision.
 *
 * 'modified' is reserved: v2's exact-text matching never emits it (a rewritten
 * step shows up as removed + added), but semantic matching later will, and the
 * viewer already handles it — so that upgrade needs no type or UI churn.
 */
export interface PlanStep {
  text: string;
  change: 'kept' | 'added' | 'removed' | 'modified';
}

export interface PlanRevision {
  turnIndex: number;
  planText: string;
  /** The user message that caused this revision. */
  triggerUserText: string;
  changeKind: 'initial' | 'added' | 'revised' | 'expanded';
  diffFromPrevious: string | null;
  /** The plan's steps, each marked against the previous revision. */
  steps: PlanStep[];
  /** How much this revision moved — one line per iteration in the viewer. */
  change: { added: number; removed: number; kept: number };
}

// ---- edit history (ExecuteView) ----

export interface DiffLine {
  kind: 'del' | 'add' | 'context';
  text: string;
}

export interface EditAttempt {
  turnIndex: number;
  timestamp: Iso;
  toolName: string;
  editCount: number;
  /** Capped at 20 lines; truncated flags the cap. */
  diff: DiffLine[];
  truncated: boolean;
  outcome: 'success' | 'error' | 'unknown';
}

export interface FileEditHistory {
  path: string;
  attempts: EditAttempt[];
  /** clean: single successful attempt · retried: multiple, ended ok · failed: last attempt errored */
  finalOutcome: 'clean' | 'retried' | 'failed';
}

// ---- timeline (the ribbon) ----

/** One tool call, placed on the session's working-time axis. */
export interface TimelineMark {
  timestamp: Iso;
  category: ToolCategory;
  failed: boolean;
  turnIndex: number;
  /** Working time elapsed from the session's start — the ribbon's x. */
  activeOffsetMs: number;
}

/** A pause worth drawing: where it sits on the axis, and how long it really was. */
export interface TimelineGap {
  activeOffsetMs: number;
  ms: number;
  startedAt: Iso;
  endedAt: Iso;
}

/** One phase's span on the working-time axis. */
export interface TimelineSegment {
  phaseIndex: number;
  activeStartMs: number;
  activeMs: number;
}

export interface Timeline {
  totalActiveMs: number;
  segments: TimelineSegment[];
  marks: TimelineMark[];
  gaps: TimelineGap[];
}

// ---- commands (ExecuteChanges) ----

/**
 * One action a phase ran, however many commands it took. Grouped because the
 * same thing attempted three times is one fact, not three rows.
 */
export interface CommandGroup {
  /** What was run: "Typecheck", "backfillArticleAuthorIds.ts", "git diff". */
  label: string;
  kind: 'check' | 'script' | 'package' | 'git' | 'inspect' | 'other';
  runs: number;
  failed: number;
  /** How the *last* run went — a check that failed then passed ended green. */
  lastOutcome: 'success' | 'error' | 'unknown';
  /** First line of what came back — the error, or a line with a count. */
  note: string | null;
  /**
   * The same line, from the last run that actually failed. A group that failed
   * and then passed ends green, so `note` describes the pass — reporting the
   * failure with it says "Tests 12 passed (12)" under a red mark.
   */
  failNote: string | null;
  /** Last occurrence, so the viewer can show the turn behind it. */
  turnIndex: number;
  /** The last raw command, for the tooltip. */
  command: string;
}

// ---- explore trail (ExploreTrail) ----

/**
 * One thing the session looked at, described by what it was looking *for*.
 *
 * The command and the path used to be the headline, which made a phase of
 * investigation read as a column of near-identical shell strings. What the
 * search was hunting for is the question being asked; the files are the answer.
 */
export interface TrailStep {
  kind: 'read' | 'search';
  /** The search pattern, or the file that was opened. The row's headline. */
  subject: string;
  /** Files the search landed in, project-relative. Empty for a read. */
  found: string[];
  /** Files beyond the ones listed in `found`. */
  moreFound: number;
  /** Match count, when the result was matching lines rather than file names. */
  matches: number;
  /** Times this same question was asked inside this phase. */
  repeats: number;
  /** Canonical file path for a read; '' for a search. */
  path: string;
  timestamp: Iso;
  turnIndex: number;
  /** This path was already read earlier in the session. */
  revisit: boolean;
  /** This file later broke a debug stall — the retrospective-causality mark. */
  laterCritical: boolean;
}

// ---- verification (VerifyResult) ----

export interface VerifyCheck {
  /** Tests · Typecheck · Lint · Build, else the command's first token. */
  label: string;
  command: string;
  outcome: 'success' | 'error' | 'unknown';
  /** First line of the result, e.g. "42 passed". */
  note: string | null;
}

export interface VerifyResult {
  /** Deduped by label; the last run of each check wins. */
  checks: VerifyCheck[];
  filesChanged: number;
  added: number;
  removed: number;
  outcome: 'completed' | 'incomplete' | 'failing';
}

// ---- semantic events ----

/**
 * What kind of moment this was. These are the primitives a replay is built
 * from: a diagram can be generated from events, never from `{phase, files}`.
 */
export type EventKind =
  | 'question'
  | 'hypothesis'
  | 'discovery'
  | 'rootCause'
  | 'decision'
  | 'pivot'
  | 'implementation'
  | 'failure'
  | 'verification'
  | 'blocker';

/**
 * How much of the page an event is entitled to. Three weights, not fifteen
 * components: an ordinary step, a moment worth stopping on, and the state the
 * session ended in.
 */
export type EventRank = 'normal' | 'key' | 'outcome';

export interface SessionEvent {
  kind: EventKind;
  /** Quoted from the session, or composed from tool calls. Never inferred. */
  text: string;
  /**
   * The scannable line: `text` with its lead-in stripped and clipped to the
   * first clause. Mechanically derived — we select, clip, group, rank and
   * count; the wording stays the session's. Never authored.
   */
  label: string;
  turnIndex: number;
  timestamp: Iso;
  phaseIndex: number;
  /** Files or commands that back the claim, so a reader can check it. */
  evidence: string[];
  source: 'quoted' | 'structural';
  /** How strongly the marker that matched suggests this kind. */
  weight: number;
  rank: EventRank;
  /** How many identical occurrences this event stands for. 1 unless grouped. */
  count: number;
  /**
   * The turn of an earlier event this one comes back to — the file noted in
   * Explore that turns out to be the root cause in Debug. The single most
   * useful thing a replay can say, and it is a relation between two events
   * rather than anything either one contains. Null when there is no such link.
   */
  relatesTo: number | null;
}

// ---- the brief (narrative layer) ----

/**
 * Inline styling for narrative text. The viewer maps styles to inline
 * elements; core never emits HTML strings.
 *   file — file path, mono + primary
 *   bad  — bad outcome (error red)
 *   good — good outcome (success green)
 *   hl   — highlighted number/key fact, primary text color
 */
export type NarrativeStyle = 'file' | 'bad' | 'good' | 'hl';

export interface NarrativeSpan {
  text: string;
  style?: NarrativeStyle;
}

/** One sentence (or short passage) of narrative, as styleable spans. */
export type RichText = NarrativeSpan[];

export interface Takeaway {
  /** Maps to !/✓/+ icons and red/green/blue tints in the viewer. */
  kind: 'warning' | 'win' | 'tip';
  /** Bold first sentence. */
  lead: RichText;
  /** 1–2 supporting sentences. */
  body: RichText;
  /** Copyable plain text, e.g. a CLAUDE.md suggestion. */
  snippet?: string;
  /** Index of the section this finding links into. */
  evidenceSection?: number;
}

/**
 * The head of one phase section. No prose: the section's body carries the
 * meaning structurally, which is the whole point of the replay layout.
 */
/**
 * Why a phase happened, in the session's own words — never generated. Either
 * the request that drove it, or, for a plan, the plan's stated objective.
 */
export interface Intent {
  quote: string;
  source: 'user' | 'plan';
}

/**
 * The sentence a phase is about — quoted from the session where it said one,
 * composed from computed facts where it didn't.
 */
export interface PhaseSummary {
  text: string;
  /** The turn it came from: "expand into the session" starts here. */
  turnIndex: number;
  /** 'session' is Claude's own claim; 'derived' is our arithmetic. Never conflate them. */
  source: 'session' | 'derived' | 'ollama';
}

export interface SectionHead {
  phaseIndex: number;
  title: string;
  /** What a debug phase is chasing — the failure it kept hitting. Null elsewhere. */
  chasing: string | null;
  /** The section's headline sentence. Null when there is nothing to say. */
  summary: PhaseSummary | null;
  /** The files (or checks) this phase was about, ranked, capped at four. */
  components: string[];
  /** The ask behind this phase — shown inside the expanded detail. */
  intent: Intent | null;
  /** e.g. "10:33–10:40" */
  timeRange: string;
  /** e.g. "5 loops · 3 stuck · 1 breakthrough" */
  statLine: string;
  /** Tone reflects the finding, not the phase kind. */
  badge: { text: string; tone: 'red' | 'green' | 'blue' | 'gray' };
}

/** Header stats. Duration is deliberately absent — the topbar and phase bars both show it. */
export interface BriefStats {
  toolCalls: number;
  filesChanged: number;
  added: number;
  removed: number;
  /** `blocked` means the work stopped for a reason outside the code. */
  outcome: 'passed' | 'failing' | 'blocked' | 'unknown';
  /** Which check decided it — "Tests", "Typecheck", … Null when none ran. */
  outcomeCheck: string | null;
}

/** The replay's text layer: a title, a header line, and one head per phase. */
export interface Brief {
  /** Heuristic session title, optionally polished by Ollama. */
  title: string;
  /** The request that started it all, verbatim. The page opens with this. */
  openingPrompt: string | null;
  stats: BriefStats;
  /** One or two sentences, and only when there is a real finding. Null otherwise. */
  headline: RichText | null;
  /** The finding that explains the session, when it stated one. */
  rootCause: SessionEvent | null;
  /** What was agreed to do about it. */
  decision: SessionEvent | null;
  /** What stopped the session, if anything did. */
  blocker: SessionEvent | null;
  /** Goal changes, in order — rendered between the sections they separate. */
  pivots: SessionEvent[];
  /** 2–4 ranked findings; never padded with generic advice. */
  takeaways: Takeaway[];
  /** Chronological, one per existing phase. */
  sections: SectionHead[];
  /** True for sessions too thin to analyze (<5 turns) — viewer renders the short form. */
  thin: boolean;
}

// ---------------------------------------------------------------------------
// Top-level artifact
// ---------------------------------------------------------------------------

/** A per-phase view, precomputed in core so the viewer only ever draws. */
export interface PhaseView<T> {
  phaseIndex: number;
  value: T;
}

export interface AnalyzedSession {
  session: Session;
  phases: Phase[];
  /** The moments that carry the session, typed and traceable. */
  events: SessionEvent[];
  /**
   * The primary replay: the small ordered subset of `events` (plus merged
   * runs) the graph draws — the shortest truthful story. Detection is not
   * presentation: `events` keeps everything checkable, `replay` keeps what a
   * reader needs. Derived by `selectReplayEvents` in replay.ts.
   */
  replay: SessionEvent[];
  /** The session on a working-time axis, for the ribbon. */
  timeline: Timeline;
  /** One entry per explore phase, in phase order. */
  trails: Array<PhaseView<TrailStep[]>>;
  /** One entry per verify phase, in phase order. */
  verifications: Array<PhaseView<VerifyResult>>;
  /** What each phase ran, grouped by action. */
  commands: Array<PhaseView<CommandGroup[]>>;
  files: FileAccess[];
  fileEdges: FileEdge[];
  editHistories: FileEditHistory[];
  debugSequences: DebugSequence[];
  concepts: Concept[];
  planRevisions: PlanRevision[];
  enrichment: 'none' | 'ollama';
}

// ---------------------------------------------------------------------------
// Analysis options
// ---------------------------------------------------------------------------

export interface OllamaOptions {
  /** Default http://localhost:11434 */
  baseUrl?: string;
  /** Default llama3.2:3b */
  model?: string;
  /** Total enrichment time budget. Default 30_000. */
  budgetMs?: number;
}

export interface AnalyzeOptions {
  /** false disables Ollama entirely (no probe). Default: probe and enrich if available. */
  ollama?: false | OllamaOptions;
}

export interface EnrichResult {
  analyzed: AnalyzedSession;
  brief: Brief;
  /** Whether Ollama was reachable and actually used. */
  used: boolean;
  /** Human-readable note for the CLI, e.g. a model-pull instruction. Null when nothing to say. */
  note: string | null;
}

/** Extra, optionally-available facts fed into brief generation. */
export interface BriefExtras {
  /** path → read count across OTHER sessions of the same project. */
  crossSessionReads?: Record<string, number>;
}

export interface AnalyzeResult {
  analyzed: AnalyzedSession;
  brief: Brief;
  skippedLines: number;
  /** Notes to surface in the CLI (e.g. Ollama fallback reasons). */
  notes: string[];
}
