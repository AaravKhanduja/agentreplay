import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Bundle core so the published package is self-contained (workspace dep).
  noExternal: ['@agentreplay/core'],
  external: ['commander', '@inquirer/prompts'],
});
