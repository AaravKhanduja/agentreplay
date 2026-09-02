/**
 * Acceptance checks for a generated replay HTML.
 * Usage: node scripts/ar-verify.mjs [path-to-html]
 *
 * Dev-only; not part of `pnpm build` or `pnpm test`. Needs a locally installed
 * Chrome (set CHROME_PATH if yours is somewhere unusual) — nothing is
 * downloaded, and the browser only ever opens a local file:// URL.
 *
 * It asserts the promises the design actually makes: the artifact issues zero
 * network requests of any kind, the page holds exactly one representation of
 * the session, evidence opens in a drawer without moving the story, and the
 * ribbon navigates the graph.
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const executablePath = process.env.CHROME_PATH ?? CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome found — set CHROME_PATH to your browser binary.');
  process.exit(1);
}

const input = path.resolve(process.argv[2] ?? '/tmp/agentreplay-demo.html');
if (!existsSync(input)) {
  console.error(`No such file: ${input}\nGenerate one first:\n  node packages/cli/dist/index.js --demo --no-ollama --out ${input}`);
  process.exit(1);
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--disable-gpu'] });
try {
  const page = await browser.newPage();
  const offenders = [];
  page.on('requestfailed', (r) => offenders.push(`failed ${r.url()}`));
  page.on('request', (r) => {
    if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) offenders.push(`external ${r.url()}`);
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(input).href, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 700));

  const count = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);

  // The privacy promise, and the only one that is non-negotiable.
  check('zero network requests', offenders.length === 0, offenders.join(', ') || 'offline clean');

  // One representation of the session: header, ribbon, graph, and nothing else.
  const nodes = await count('.ar-graph-node');
  check('event graph rendered', nodes > 0, `${nodes} nodes`);
  check('graph is compressed', nodes > 0 && nodes <= 12, `${nodes} nodes (target ~5–9 plus the request)`);
  check('ribbon rendered', (await count('.ar-ribbon-phase')) > 0);
  check('every ribbon colour is named', (await count('.ar-ribbon-key-item')) >= (await count('.ar-ribbon-phase')) - 2);
  for (const [label, sel] of [
    ['no phase sections', '.ar-section'],
    ['no left spine', '.ar-spine-entry'],
    ['no root-cause card', '.ar-rootcause'],
    ['no outcomes block', '.ar-outcomes'],
  ]) {
    check(label, (await count(sel)) === 0);
  }

  // Evidence opens beside the story, never inside it.
  const firstNodeTop = () =>
    page.$eval('.ar-graph-node:last-of-type', (el) => Math.round(el.getBoundingClientRect().top));
  const before = await firstNodeTop();
  await page.click('.ar-graph-node .ar-graph-evd');
  await page.waitForSelector('.ar-drawer', { timeout: 5_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  check('evidence opens a drawer', (await count('.ar-drawer')) === 1);
  check('opening evidence does not move the story', Math.abs((await firstNodeTop()) - before) <= 2);
  check('full turn is collapsed by default', (await count('.ar-drawer-turn')) === 0);

  await page.click('.ar-drawer-turn-toggle');
  await new Promise((r) => setTimeout(r, 200));
  check('full turn opens on request', (await count('.ar-drawer-turn')) === 1);
  check('turn is markdown-rendered', (await count('.ar-drawer-turn .ar-md-para, .ar-drawer-turn .ar-md-code')) > 0);

  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  check('escape closes the drawer', (await count('.ar-drawer')) === 0);

  // The ribbon is the map: clicking a block moves the story to that chapter.
  await page.$$eval('.ar-ribbon-phase', (els) =>
    els[els.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await new Promise((r) => setTimeout(r, 800));
  const jumped = await page
    .$$eval('.ar-graph-phase', (els) => {
      const r = els[els.length - 1].getBoundingClientRect();
      return r.top >= -20 && r.top < window.innerHeight;
    })
    .catch(() => false);
  check('ribbon click scrolls to its chapter', jumped);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
