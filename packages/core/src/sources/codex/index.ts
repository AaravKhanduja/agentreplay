/** OpenAI Codex CLI as a session source. */

import { access } from 'node:fs/promises';

import { AGENTS } from '../../types.js';
import type { SessionRef } from '../../types.js';
import type { SessionSource } from '../types.js';
import {
  discoverCodexSessions,
  getCodexSessionsDir,
  readTitles,
  resolveCodexRef,
  sniffCodex,
} from './discover.js';
import { parseCodexFile } from './parser.js';

export const codexSource: SessionSource = {
  id: 'codex',
  label: AGENTS.codex.label,
  speaker: AGENTS.codex.speaker,
  memoryFile: AGENTS.codex.memoryFile,
  root: () => getCodexSessionsDir(),
  isAvailable: async () => {
    try {
      await access(getCodexSessionsDir());
      return true;
    } catch {
      return false;
    }
  },
  discover: (opts) => discoverCodexSessions(opts),
  resolve: (ref) => resolveCodexRef(ref),
  sniff: sniffCodex,
  load: async (ref: SessionRef) => {
    // Codex names its threads in a side index, so the name is a second read —
    // worth it, because it beats any title derived from the opening message.
    const titles = await readTitles();
    return parseCodexFile(ref.filePath, titles.get(ref.sessionId) ?? null);
  },
  // No cross-session reads: rollouts are foldered by date, so a file's
  // neighbours are that day's sessions across every unrelated repo. Counting
  // those would put a confidently wrong number inside a takeaway's data bar.
};
