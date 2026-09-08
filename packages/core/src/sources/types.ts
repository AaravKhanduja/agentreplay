/**
 * What every agent's reader has to provide.
 *
 * The boundary is deliberately narrow: finding sessions, addressing one, and
 * turning it into a normalized `Session`. It does not extend into the
 * heuristics — a heuristic takes a bare `ToolCall` and has no source in scope,
 * and a source cannot ride on `Session` without breaking the JSON round-trip
 * the artifact depends on. So anything a heuristic needs is already a field on
 * the normalized call by the time it gets there.
 */

import type { AgentId, ParsedSession, SessionMeta, SessionRef } from '../types.js';

export interface SessionSource {
  readonly id: AgentId;
  /** Named in the picker column and in "is it installed?" messages. */
  readonly label: string;
  /** Who the assistant turns are attributed to in the evidence drawer. */
  readonly speaker: string;
  /** The file this agent reads project instructions from. */
  readonly memoryFile: string;
  /** Where its sessions live, for the message when there are none. */
  root(): string;
  /** False when the agent isn't installed here, so it stays out of the picker. */
  isAvailable(): Promise<boolean>;
  discover(opts: { limit?: number }): Promise<SessionMeta[]>;
  /**
   * Files that look like this agent's sessions, whether or not they read.
   *
   * `discover` returns only what it understood, so on its own it cannot tell
   * "you have no sessions" from "I rejected all of them" — and those printed
   * identically as `0 sessions` while a format change hid behind it.
   */
  countFiles(): Promise<number>;
  /**
   * Every session of this agent's that the reference matches. The dispatcher
   * decides what none and what several mean, so that an id shared by two
   * agents and a prefix shared by two sessions read the same way.
   */
  resolve(ref: string): Promise<SessionRef[]>;
  /** Recognizes a file handed straight to the CLI, by its first line. */
  sniff(firstLine: string): boolean;
  load(ref: SessionRef): Promise<ParsedSession>;
  /**
   * Reads of these paths in the agent's *other* sessions for the same project.
   * Optional: omitted where the sessions aren't laid out in a way that makes
   * the answer cheap, because a wrong count here lands inside a takeaway.
   */
  crossSessionReads?(
    ref: SessionRef,
    candidates: string[],
    projectPath: string,
  ): Promise<Record<string, number> | undefined>;
}
