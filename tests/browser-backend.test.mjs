import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBrowserBackend,
  rendererEvaluationError,
  resolveBrowserBackend,
  resolveChromeDebugPort,
  resolveChromeExecutablePath,
  resolveChromeProfileMode,
  resolveChromeProfileName
} from '../browser-backend.mjs';
import { buildChromeLaunchArgs, defaultChromeUserDataDir } from '../chrome-cdp-backend.mjs';

test('browser-backend: renderer evidence keeps exception fields without source payloads', () => {
  const error = rendererEvaluationError({
    text: 'Uncaught', lineNumber: 2, columnNumber: 4,
    exception: { className: 'TypeError', description: 'TypeError: synthetic_failure\nraw source payload', preview: { body: 'file contents' } },
    stackTrace: { callFrames: [{ functionName: 'inject', scriptId: '12', lineNumber: 2, columnNumber: 4, url: 'https://fixture.invalid/source.js?private=value' }] }
  });
  assert.equal(error.data.rendererError.message, 'TypeError: synthetic_failure');
  assert.match(error.data.rendererError.stack, /inject \(script 12:3:5\)/);
  for (const text of ['raw source payload', 'file contents', 'private=value']) {
    assert.equal(JSON.stringify(error.data).includes(text), false);
  }
});

test('browser-backend: native description frames survive without protocol stackTrace', () => {
  const error = rendererEvaluationError({
    text: 'Uncaught (in promise)',
    exception: { className: 'TypeError', description: [
      'TypeError: synthetic_failure',
      '    at asynchronousFailure (https://fixture.invalid/source.js?private=value:3:5)',
      '    at <anonymous>:1:9',
      'raw source payload'
    ].join('\n') }
  });
  assert.match(error.data.rendererError.stack, /at asynchronousFailure \(line 3:5\)/);
  assert.match(error.data.rendererError.stack, /at <anonymous> \(line 1:9\)/);
  for (const text of ['fixture.invalid', 'private=value', 'raw source payload']) {
    assert.equal(JSON.stringify(error.data).includes(text), false);
  }
});

test('browser-backend: normalizes aliases', () => {
  assert.equal(normalizeBrowserBackend('chrome'), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('cdp'), 'chrome-cdp');
  assert.equal(normalizeBrowserBackend('electron'), 'electron');
  assert.equal(normalizeBrowserBackend('unknown'), 'electron');
});

test('browser-backend: argv overrides env and settings', () => {
  const value = resolveBrowserBackend({
    argv: ['node', 'main.mjs', '--browser-backend', 'chrome-cdp'],
    env: { AGENTIFY_DESKTOP_BROWSER_BACKEND: 'electron' },
    settings: { browserBackend: 'electron' }
  });
  assert.equal(value, 'chrome-cdp');
});

test('browser-backend: resolves chrome debug port and binary path', () => {
  assert.equal(
    resolveChromeDebugPort({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_DEBUG_PORT: '9333' },
      settings: { chromeDebugPort: 9444 }
    }),
    9333
  );
  assert.equal(
    resolveChromeExecutablePath({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_BIN: '/tmp/chrome' },
      settings: {}
    }),
    '/tmp/chrome'
  );
  assert.equal(
    resolveChromeProfileMode({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_MODE: 'existing' },
      settings: {}
    }),
    'existing'
  );
  assert.equal(
    resolveChromeProfileName({
      argv: ['node', 'main.mjs'],
      env: { AGENTIFY_DESKTOP_CHROME_PROFILE_NAME: 'Profile 3' },
      settings: {}
    }),
    'Profile 3'
  );
});

test('browser-backend: builds chrome launch args with managed profile', () => {
  const args = buildChromeLaunchArgs({
    debugPort: 9222,
    userDataDir: '/tmp/agentify-chrome',
    profileName: 'Default',
    startUrl: 'https://chatgpt.com/'
  });
  assert.ok(args.includes('--remote-debugging-port=9222'));
  assert.ok(args.includes('--user-data-dir=/tmp/agentify-chrome'));
  assert.ok(args.includes('--profile-directory=Default'));
  assert.ok(args.includes('https://chatgpt.com/'));
});

test('browser-backend: default chrome user data dir is non-empty', () => {
  const p = defaultChromeUserDataDir();
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
});
