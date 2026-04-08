import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('preload bridges expose the durable run IPC surface in both CJS and ESM builds', async () => {
  const preloadCjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.cjs'), 'utf8');
  const preloadMjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.mjs'), 'utf8');
  const requiredSnippets = [
    'getRuns:',
    'openRun:',
    'retryRun:',
    'archiveRun:',
    'onRunsChanged:'
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(preloadCjs.includes(snippet), `expected preload.cjs to include ${snippet}`);
    assert.ok(preloadMjs.includes(snippet), `expected preload.mjs to include ${snippet}`);
  }
});
