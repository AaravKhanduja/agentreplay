/** Claude Code as a session source. */

import { access } from 'node:fs/promises';

import type { SessionRef } from '../../types.js';
import type { SessionSource } from '../types.js';
import {
  countCrossSessionReads,
  discoverClaudeSessions,
  getClaudeProjectsDir,
  resolveClaudeRef,
  sniffClaude,
} from './discover.js';
import { parseSessionFile } from './parser.js';

export const claudeSource: SessionSource = {
  id: 'claude',
  label: 'Claude Code',
  speaker: 'Claude',
  memoryFile: 'CLAUDE.md',
  root: () => getClaudeProjectsDir(),
  isAvailable: async () => {
    try {
      await access(getClaudeProjectsDir());
      return true;
    } catch {
      return false;
    }
  },
  discover: (opts) => discoverClaudeSessions(opts),
  resolve: (ref) => resolveClaudeRef(ref),
  sniff: sniffClaude,
  load: (ref: SessionRef) => parseSessionFile(ref.filePath),
  // One directory per project, so the siblings of a session file are the same
  // project's other sessions — which is exactly what makes this cheap.
  crossSessionReads: (ref, candidates) =>
    countCrossSessionReads(ref.filePath, candidates, ref.sessionId),
};
