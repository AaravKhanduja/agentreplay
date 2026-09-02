// Copies everything the published package needs but does not own: the bundled
// demo session, and the root README + LICENSE (npm only ever reads those from
// the package directory, so a monorepo's root copies would never ship — the
// npm page would be blank and the tarball unlicensed).
// viewer.html is placed in assets/ by the viewer's own build.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(packageRoot, '../../examples/demo-session.jsonl');
const target = path.join(packageRoot, 'assets', 'demo-session.jsonl');

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`copied demo-session.jsonl -> ${target}`);

for (const name of ['README.md', 'LICENSE']) {
  const from = path.resolve(packageRoot, '../..', name);
  const to = path.join(packageRoot, name);
  await copyFile(from, to);
  console.log(`copied ${name} -> ${to}`);
}
