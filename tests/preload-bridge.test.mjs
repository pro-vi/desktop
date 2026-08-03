import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIBRARY_IPC = Object.freeze({
  requestExportGrant: 'agentify:requestExportGrant',
  importChatGptExport: 'agentify:importChatGptExport',
  getCatalog: 'agentify:getCatalog',
  getCatalogImports: 'agentify:getCatalogImports',
  getTranscriptSources: 'agentify:getTranscriptSources',
  syncTranscript: 'agentify:syncTranscript',
  forgetTranscript: 'agentify:forgetTranscript',
  verifyCatalogConversation: 'agentify:verifyCatalogConversation',
  reassignCatalogImport: 'agentify:reassignCatalogImport'
});

function extractInvokeMap(source) {
  return Object.fromEntries(Array.from(
    source.matchAll(/^\s{2}([a-zA-Z0-9_]+):[^\n]*ipcRenderer\.invoke\('([^']+)'/gm),
    (match) => [match[1], match[2]]
  ));
}

test('preload bridges expose the durable run IPC surface in both CJS and ESM builds', async () => {
  const preloadCjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.cjs'), 'utf8');
  const preloadMjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.mjs'), 'utf8');
  const requiredSnippets = [
    'getState:',
    'getRuns:',
    'openRun:',
    'retryRun:',
    'archiveRun:',
    'onRunsChanged:',
    'onLibraryChanged:'
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(preloadCjs.includes(snippet), `expected preload.cjs to include ${snippet}`);
    assert.ok(preloadMjs.includes(snippet), `expected preload.mjs to include ${snippet}`);
  }
});

test('preload bridges expose exactly matching Transcript Library methods and IPC channels', async () => {
  const sources = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'ui', 'preload.cjs'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'ui', 'preload.mjs'), 'utf8')
  ]);
  const expectedNames = Object.keys(LIBRARY_IPC).sort();

  for (const source of sources) {
    const invokeMap = extractInvokeMap(source);
    const libraryNames = Object.entries(invokeMap)
      .filter(([name, channel]) => /(?:Export|Catalog|Transcript|Library)/i.test(`${name}:${channel}`))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(libraryNames, expectedNames);
    assert.deepEqual(
      Object.fromEntries(expectedNames.map((name) => [name, invokeMap[name]])),
      LIBRARY_IPC
    );
    assert.match(source, /onLibraryChanged:[\s\S]*ipcRenderer\.on\('agentify:libraryChanged'/);
    assert.match(source, /removeListener\('agentify:libraryChanged'/);
  }

  assert.deepEqual(extractInvokeMap(sources[0]), extractInvokeMap(sources[1]));
});
