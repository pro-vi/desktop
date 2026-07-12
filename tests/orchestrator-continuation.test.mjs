import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { sendNoWait } from '../orchestrator.mjs';

test('orchestrator: chat URL is browser-thread context, not workspace input', async () => {
  const source = await fs.readFile(new URL('../orchestrator.mjs', import.meta.url), 'utf8');
  assert.match(source, /argValue\('--chat-url'\)/);
  assert.match(source, /path: '\/navigate', body: \{ key, url: chatUrl \}/);
  assert.match(source, /chatUrl: continuation\?\.chatUrl \|\| undefined/);
  assert.match(source, /if \(continuation\?\.chatUrl\) continuation\.chatUrl = null/);
  assert.doesNotMatch(source, /detectWorkspaceRoot\(chatUrl\)/);
  assert.doesNotMatch(source, /setWorkspace[^\n]+chatUrl/);
});

test('orchestrator: final result posting failures are not swallowed', async () => {
  const source = await fs.readFile(new URL('../orchestrator.mjs', import.meta.url), 'utf8');
  assert.match(source, /await sendNoWait\(conn, \{ key, text: m, stopAfterSend: true, continuation \}\);/);
  assert.doesNotMatch(source, /text: m, stopAfterSend: true, continuation \}\)\.catch/);

  const continuation = { chatUrl: 'https://chatgpt.com/share/source' };
  await assert.rejects(
    sendNoWait(
      { port: 1, token: 'test' },
      { key: 'external', text: 'result', continuation },
      async () => { throw new Error('post_failed'); }
    ),
    /post_failed/
  );
  assert.equal(continuation.chatUrl, 'https://chatgpt.com/share/source');
});
