/**
 * Turn an AnalyzedSession into a self-contained HTML file and open it.
 *
 * The viewer template ships as assets/viewer.html (built by the viewer
 * package) with a `"__AGENTREPLAY_DATA__"` placeholder that we replace with
 * the serialized session.
 */

import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalyzedSession, Brief } from '@agentreplay/core';

const DATA_TOKEN = '"__AGENTREPLAY_DATA__"';

/** What gets injected into the viewer: the analysis plus its brief. */
export interface ViewerPayload {
  analyzed: AnalyzedSession;
  brief: Brief;
}

/**
 * Write the injected HTML and open it in the default browser.
 * With an explicit outPath the file is written but not opened.
 * Returns the written path.
 */
export async function generateAndOpen(
  payload: ViewerPayload,
  outPath: string | null,
  log: (message: string) => void,
): Promise<string> {
  const template = await readViewerTemplate();
  if (!template.includes(DATA_TOKEN)) {
    throw new Error('Viewer template has no data placeholder — run "pnpm build" at the repo root first.');
  }

  // Function replacement so `$` sequences inside the JSON are never
  // interpreted as String.replace patterns.
  const html = template.replace(DATA_TOKEN, () => serializeForScript(payload));

  const target = outPath
    ? path.resolve(outPath)
    : path.join(os.tmpdir(), `agentreplay-${payload.analyzed.session.id}.html`);
  await writeFile(target, html, 'utf8');

  if (outPath) {
    log(`Wrote ${target}`);
  } else {
    openInBrowser(target);
    log(`Wrote and opened ${target}`);
  }
  return target;
}

/**
 * Serialize for injection inside a <script> tag. `<` only ever appears inside
 * JSON string literals, where the \u003c escape is legal — replacing it
 * neutralizes "</script>" and "<!--" without changing the parsed value.
 * U+2028/U+2029 are escaped for the same reason (legacy JS line terminators).
 */
export function serializeForScript(payload: ViewerPayload): string {
  return JSON.stringify(payload)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

async function readViewerTemplate(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/ when built, src/ under tsx
  const candidates = [
    path.resolve(here, '../assets/viewer.html'), // <package-root>/assets, published layout
    path.resolve(here, 'assets/viewer.html'),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return readFile(candidate, 'utf8');
  }
  throw new Error('Viewer not built — run "pnpm build" at the repo root first.');
}

/** Best-effort platform opener; errors are ignored (the path was printed). */
function openInBrowser(filePath: string): void {
  try {
    const child =
      process.platform === 'darwin'
        ? spawn('open', [filePath], { detached: true, stdio: 'ignore' })
        : process.platform === 'win32'
          ? spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // opening is best-effort
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
