/**
 * Capture the README screenshots from a generated brief HTML file.
 *
 * Usage: node scripts/screenshots.mjs [path-to-html]
 *   Default input: /tmp/agentreplay-brief.html
 *   (generate it first: node packages/cli/dist/index.js --demo --no-ollama --out /tmp/agentreplay-brief.html)
 *
 * Uses the locally installed Chrome via puppeteer-core — nothing is downloaded.
 * Shoots the whole page (header + ribbon + graph), the event graph alone, and
 * the evidence drawer opened on the strongest moment.
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] ?? '/tmp/agentreplay-brief.html';
const outDir = path.join(repoRoot, 'docs', 'screenshots');

const executablePath = process.env.CHROME_PATH ?? CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome found — set CHROME_PATH to your browser binary.');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
// The screenshot set changes with the UI — clear stale shots first.
for (const name of await readdir(outDir)) {
  if (name.endsWith('.png')) await unlink(path.join(outDir, name));
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--disable-gpu', '--force-device-scale-factor=2'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.resolve(input)).href, { waitUntil: 'load' });
  await page.waitForSelector('.ar-graph-node', { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 400));

  // 1. The page as it opens: header, ribbon, and the top of the story.
  await page.screenshot({ path: path.join(outDir, 'header.png') });
  console.log('wrote header.png');

  // 2. The event graph on its own — the primary artifact. The topbar is
  //    sticky, so it overlaps the top of the element's box and leaves a
  //    clipped fragment of the project path in the shot; hide it for this
  //    capture only.
  const graph = await page.$('.ar-graph');
  if (graph) {
    await page.$eval('.ar-topbar', (el) => (el.style.visibility = 'hidden'));
    await graph.screenshot({ path: path.join(outDir, 'graph.png') });
    await page.$eval('.ar-topbar', (el) => (el.style.visibility = ''));
    console.log('wrote graph.png');
  }

  // 3. The evidence drawer, opened on the heaviest moment the page has: a root
  //    cause if the session stated one, else the first key event.
  const target =
    (await page.$('.ar-graph-node--k-rootCause .ar-graph-evd')) ??
    (await page.$('.ar-graph-node--key .ar-graph-evd'));
  if (target) {
    await target.click();
    await page.waitForSelector('.ar-drawer', { timeout: 5_000 });
    // Clicking scrolls the node into view; the shot wants the whole page.
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 350));
    await page.screenshot({ path: path.join(outDir, 'evidence.png') });
    console.log('wrote evidence.png');
  }
} finally {
  await browser.close();
}
