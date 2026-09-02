#!/usr/bin/env node
/**
 * Assert the build actually produced what the published package needs.
 *
 * This exists because of a silent failure that shipped: renaming the CLI
 * package left `pnpm --filter agentreplay build` matching nothing, and pnpm
 * exits 0 when a filter matches no projects. So `pnpm build` "succeeded"
 * while never building the CLI at all — CI passed its build step, and
 * `prepublishOnly` published a tarball with a stale README and a stale dist.
 *
 * A build that produces nothing must not look like a build that worked.
 * Runs last in the root `build` script; fails loudly.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages', 'cli');
const problems = [];

/** The file exists and is not suspiciously empty. */
function present(relative, minBytes) {
  const full = path.join(root, relative);
  try {
    const { size } = statSync(full);
    if (size < minBytes) {
      problems.push(`${relative} is only ${size} bytes (expected ≥ ${minBytes}) — build produced a stub`);
      return false;
    }
    return true;
  } catch {
    problems.push(`${relative} is missing — did the build step for that package actually run?`);
    return false;
  }
}

/** A copied file still matches its source. */
function copyIsFresh(sourceRelative, copyRelative) {
  try {
    const source = readFileSync(path.join(root, sourceRelative));
    const copy = readFileSync(path.join(root, copyRelative));
    if (!source.equals(copy)) {
      problems.push(
        `${copyRelative} is stale — it no longer matches ${sourceRelative}. ` +
          `npm reads the README and LICENSE from the package directory, so publishing now ` +
          `would ship the old text.`,
      );
    }
  } catch {
    problems.push(`${copyRelative} is missing — copy-assets did not run`);
  }
}

present('packages/cli/dist/index.js', 10_000);
present('packages/cli/assets/demo-session.jsonl', 1_000);

// The viewer must be a real single-file build with the placeholder the CLI
// replaces at runtime — an empty or partial inline is worse than a missing one.
if (present('packages/cli/assets/viewer.html', 100_000)) {
  const html = readFileSync(path.join(cli, 'assets', 'viewer.html'), 'utf8');
  if (!html.includes('__AGENTREPLAY_DATA__')) {
    problems.push('assets/viewer.html has no data placeholder — the CLI would have nothing to inject into');
  }
}

copyIsFresh('README.md', 'packages/cli/README.md');
copyIsFresh('LICENSE', 'packages/cli/LICENSE');

if (problems.length > 0) {
  console.error('\nBuild output check failed:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('build output ok — dist, viewer, demo session, README and LICENSE all present and current');
