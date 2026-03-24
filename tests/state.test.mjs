import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ensureToken, readToken, writeToken, defaultSettings, normalizeSettings, readSettings, writeSettings } from '../state.mjs';

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

test('state: ensureToken creates and is readable', async () => {
  const dir = await tempDir();
  const token = await ensureToken(dir);
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 20);
  const token2 = await readToken(dir);
  assert.equal(token2, token);
});

test('state: writeToken overrides existing', async () => {
  const dir = await tempDir();
  await writeToken('abc123', dir);
  assert.equal(await readToken(dir), 'abc123');
  await writeToken('def456', dir);
  assert.equal(await readToken(dir), 'def456');
});

test('state: normalizeSettings defaults allowAuthPopups to true', () => {
  const s = normalizeSettings({});
  assert.equal(s.allowAuthPopups, true);
  assert.equal(s.browserBackend, 'electron');
  assert.equal(s.chromeDebugPort, 9222);
  assert.equal(s.chromeProfileMode, 'isolated');
  assert.equal(s.chromeProfileName, 'Default');
});

test('state: readSettings returns defaults when file missing', async () => {
  const dir = await tempDir();
  const s = await readSettings(dir);
  assert.deepEqual(s, defaultSettings());
});

test('state: writeSettings persists allowAuthPopups', async () => {
  const dir = await tempDir();
  const saved = await writeSettings({ allowAuthPopups: false }, dir);
  assert.equal(saved.allowAuthPopups, false);
  const re = await readSettings(dir);
  assert.equal(re.allowAuthPopups, false);
});

test('state: normalizeSettings clamps backend fields', () => {
  const s = normalizeSettings({
    browserBackend: 'chrome-cdp',
    chromeDebugPort: 70000,
    chromeExecutablePath: ' /Applications/Google Chrome.app/Contents/MacOS/Google Chrome ',
    chromeProfileMode: 'existing',
    chromeProfileName: ' Profile 2 '
  });
  assert.equal(s.browserBackend, 'chrome-cdp');
  assert.equal(s.chromeDebugPort, 65535);
  assert.equal(s.chromeExecutablePath, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(s.chromeProfileMode, 'existing');
  assert.equal(s.chromeProfileName, 'Profile 2');
});
