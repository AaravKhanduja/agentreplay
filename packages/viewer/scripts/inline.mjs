#!/usr/bin/env node
/**
 * Post-build step: collapse the Next.js static export into ONE self-contained
 * HTML file — every script, stylesheet and font inlined, plus the data
 * placeholder the CLI replaces at runtime.
 *
 *   out/index.html  →  packages/cli/assets/viewer.html
 *
 * The artifact must open from file:// and work fully offline, forever.
 * Nothing here touches the network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const viewerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(viewerRoot, 'out');
const htmlPath = join(outDir, 'index.html');
const targetPath = resolve(viewerRoot, '..', 'cli', 'assets', 'viewer.html');
const MAX_BYTES = 3 * 1024 * 1024;

function fail(message) {
  console.error(`inline.mjs: ${message}`);
  process.exit(1);
}

if (!existsSync(htmlPath)) {
  fail(`missing ${htmlPath} — run \`next build\` first`);
}

let html = readFileSync(htmlPath, 'utf8');

/** Map an asset href like "/_next/static/chunks/x.js" onto a file in out/. */
function assetFile(href) {
  const clean = href.replace(/^\.?\//, '').split('?')[0];
  return join(outDir, clean);
}

/** Inline <script> text may not contain "</script" or the parser ends the tag early. */
function escapeScriptText(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

// --- 1. Inline every external <script src="/_next/..."> in document order. ---
// Inline bootstrap scripts (no src attribute) are left untouched.
html = html.replace(/<script\s[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
  if (!src.includes('_next/')) return tag;
  const file = assetFile(src);
  if (!existsSync(file)) fail(`script asset not found: ${src}`);
  // Keep nomodule semantics: Next's polyfill chunk must not run in modern browsers.
  const noModule = /\bnomodule\b/i.test(tag) ? ' nomodule' : '';
  return `<script${noModule}>${escapeScriptText(readFileSync(file, 'utf8'))}</script>`;
});

// --- 2. Inline every stylesheet as a <style> block. ---
html = html.replace(/<link\s[^>]*\brel="stylesheet"[^>]*\/?>/g, (tag) => {
  const href = tag.match(/\bhref="([^"]+)"/)?.[1];
  if (!href || !href.includes('_next/')) return tag;
  const file = assetFile(href);
  if (!existsSync(file)) fail(`stylesheet asset not found: ${href}`);
  let css = readFileSync(file, 'utf8');
  // Drop @font-face rules pointing at exported font files — replaced below by
  // base64-embedded faces. (@font-face bodies never nest, so this regex is safe.)
  css = css.replace(/@font-face\s*\{[^{}]*\}/g, '');
  // Belt and braces: neutralize any url(...) still pointing at /_next assets.
  css = css.replace(/url\((['"]?)\/?_next\/[^)]*\)/g, 'none');
  return `<style>${css}</style>`;
});

// Stylesheets can also appear href-before-rel; handle that ordering too.
html = html.replace(/<link\s[^>]*\bhref="([^"]+)"[^>]*\brel="stylesheet"[^>]*\/?>/g, (tag, href) => {
  if (!href.includes('_next/')) return tag;
  const file = assetFile(href);
  if (!existsSync(file)) fail(`stylesheet asset not found: ${href}`);
  let css = readFileSync(file, 'utf8');
  css = css.replace(/@font-face\s*\{[^{}]*\}/g, '');
  css = css.replace(/url\((['"]?)\/?_next\/[^)]*\)/g, 'none');
  return `<style>${css}</style>`;
});

// --- 3. Remove preload/prefetch hints for assets we just inlined. ---
html = html.replace(
  /<link\s[^>]*\brel="(?:preload|modulepreload|prefetch|preconnect|dns-prefetch)"[^>]*\/?>\s*/g,
  '',
);

// --- 3b. Neutralize the stylesheet the client router re-injects at runtime. ---
// The CSS is inlined above, but Next's flight payload still carries a preload
// hint and a <link rel="stylesheet"> descriptor pointing at the emitted file.
// From file:// that becomes a failed request for a path this artifact does not
// contain, so point both at an empty data: URL instead.
html = html.replace(/\/_next\/static\/css\/[A-Za-z0-9_-]+\.css/g, 'data:text/css,');

// --- 4. Embed IBM Plex woff2 files as base64 @font-face rules. ---
function fontDir(pkg) {
  const candidates = [];
  try {
    candidates.push(join(dirname(require.resolve(`${pkg}/package.json`)), 'files'));
  } catch {
    // package.json may not be an exported subpath — fall through to path guesses
  }
  candidates.push(join(viewerRoot, 'node_modules', pkg, 'files'));
  candidates.push(resolve(viewerRoot, '..', '..', 'node_modules', pkg, 'files'));
  const hit = candidates.find((dir) => existsSync(dir));
  if (!hit) fail(`cannot locate ${pkg}/files — is it installed?`);
  return hit;
}

const sansDir = fontDir('@fontsource/ibm-plex-sans');
const monoDir = fontDir('@fontsource/ibm-plex-mono');
const faces = [
  ['IBM Plex Sans', 400, join(sansDir, 'ibm-plex-sans-latin-400-normal.woff2')],
  ['IBM Plex Sans', 500, join(sansDir, 'ibm-plex-sans-latin-500-normal.woff2')],
  ['IBM Plex Sans', 600, join(sansDir, 'ibm-plex-sans-latin-600-normal.woff2')],
  ['IBM Plex Mono', 400, join(monoDir, 'ibm-plex-mono-latin-400-normal.woff2')],
  ['IBM Plex Mono', 500, join(monoDir, 'ibm-plex-mono-latin-500-normal.woff2')],
];

const fontCss = faces
  .map(([family, weight, file]) => {
    if (!existsSync(file)) fail(`font file missing: ${file}`);
    const b64 = readFileSync(file).toString('base64');
    return (
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
      `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
    );
  })
  .join('\n');

// --- 5. Inject fonts + the data placeholder at the very top of <head>, ---
// before any app script. At runtime the CLI replaces the quoted token
// "__AGENTREPLAY_DATA__" (quotes included) with the raw session JSON.
html = html.replace(
  /<head([^>]*)>/,
  (_m, attrs) =>
    `<head${attrs}>` +
    `<script>window.__AGENTREPLAY_DATA__ = "__AGENTREPLAY_DATA__";</script>` +
    `<style>${fontCss}</style>`,
);

// --- 6. Sanity checks, then write. ---
if (!html.includes('window.__AGENTREPLAY_DATA__')) {
  fail('data placeholder was not injected — <head> tag not found?');
}
const leftover = html.match(/(?:src|href)="\/?_next\/[^"]*"/);
if (leftover) {
  fail(`external asset reference remains after inlining: ${leftover[0]}`);
}

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, html);

const bytes = Buffer.byteLength(html);
const pretty =
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
if (bytes > MAX_BYTES) {
  fail(`viewer.html is ${pretty} — exceeds the 3 MB budget`);
}
console.log(`viewer.html → ${targetPath} (${pretty})`);
