import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ensureToken, readToken, writeToken, defaultSettings, normalizeSettings, readSettings, writeSettings } from '../state.mjs';
import { DEFAULT_CHAT_MODE_INTENT, DEFAULT_IMAGE_MODE_INTENT } from '../chatgpt-mode-intent.mjs';

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
  assert.equal(s.defaultProjectUrl, null);
  assert.equal(s.defaultChatModeIntent, DEFAULT_CHAT_MODE_INTENT);
  assert.equal(s.defaultChatModelIntent, null);
  assert.equal(s.defaultGpt55ProProjectUrl, null);
  assert.equal(s.defaultGpt54ProProjectUrl, null);
  assert.equal(s.defaultImageProjectUrl, null);
  assert.equal(s.defaultImageModeIntent, DEFAULT_IMAGE_MODE_INTENT);
  assert.equal(s.defaultImageKey, 'image-default');
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

test('state: writeSettings persists default image project URL', async () => {
  const dir = await tempDir();
  const saved = await writeSettings({
    defaultGpt55ProProjectUrl: ' https://chatgpt.com/g/g-p-55/project ',
    defaultGpt54ProProjectUrl: ' https://chatgpt.com/g/g-p-54/project ',
    defaultImageProjectUrl: ' https://chatgpt.com/g/g-p-image/project '
  }, dir);
  assert.equal(saved.defaultGpt55ProProjectUrl, 'https://chatgpt.com/g/g-p-55/project');
  assert.equal(saved.defaultGpt54ProProjectUrl, 'https://chatgpt.com/g/g-p-54/project');
  assert.equal(saved.defaultImageProjectUrl, 'https://chatgpt.com/g/g-p-image/project');
  const re = await readSettings(dir);
  assert.equal(re.defaultGpt55ProProjectUrl, 'https://chatgpt.com/g/g-p-55/project');
  assert.equal(re.defaultGpt54ProProjectUrl, 'https://chatgpt.com/g/g-p-54/project');
  assert.equal(re.defaultImageProjectUrl, 'https://chatgpt.com/g/g-p-image/project');
});

test('state: writeSettings normalizes ChatGPT mode intents', async () => {
  const dir = await tempDir();
  const saved = await writeSettings({ defaultChatModeIntent: ' Pro ', defaultChatModelIntent: ' legacy pro ', defaultImageModeIntent: ' reasoning ' }, dir);
  assert.equal(saved.defaultChatModeIntent, 'extended-pro');
  assert.equal(saved.defaultChatModelIntent, 'gpt-5.4-pro');
  assert.equal(saved.defaultImageModeIntent, 'thinking');
  const re = await readSettings(dir);
  assert.equal(re.defaultChatModeIntent, 'extended-pro');
  assert.equal(re.defaultChatModelIntent, 'gpt-5.4-pro');
  assert.equal(re.defaultImageModeIntent, 'thinking');
});

test('state: writeSettings persists default image key', async () => {
  const dir = await tempDir();
  const saved = await writeSettings({ defaultImageKey: ' images ' }, dir);
  assert.equal(saved.defaultImageKey, 'images');
  const re = await readSettings(dir);
  assert.equal(re.defaultImageKey, 'images');
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
