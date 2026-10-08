#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exerciseDotMessaging } from '../tests/fixtures/chatgpt-dot/service.mjs';
import { binding } from '../tests/fixtures/chatgpt-dot/native-page.mjs';
import { ChatGPTController } from '../chatgpt-controller.mjs';
import { parseDotCursor } from '../chatgpt-recipient.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(scriptPath));

function installNativeFixture(binding) {
  const sidebar = document.querySelector('button');
  const main = document.querySelector('main');
  const state = { messages: [], texts: [] };
  const services = {
    conversations: { timeline: () => ({ getSnapshot: () => ({ messages: state.messages, loaded: true, cursors: { after: null, before: null } }) }) },
    composer: {
      state: { getSnapshot: () => ({ drafts: new Map([[binding.roomId, { text: '' }]]), unconfirmedSends: [] }) },
      getAttachmentDraft: () => [],
      sendPrepared: (roomId, request) => {
        state.texts.push(request.text);
        state.messages.push({ id: `accepted-${state.texts.length}`, roomId, requestId: request.requestId, text: request.text, self: true, senderId: 'fixture-owner', senderAeonId: null, deliveryState: '', createdAt: request.createdAt, attachments: [] });
        return true;
      }
    }
  };
  const account = { accountKey: binding.accountKey };
  sidebar.__reactProps$fixture = account;
  sidebar.__reactFiber$fixture = { memoizedProps: account, return: null };
  sidebar.onclick = () => history.pushState(null, '', '/dots/fixture-conversation');
  const props = { conversationId: binding.conversationId, roomId: binding.roomId, room: { id: binding.roomId, aeon_id: binding.peerAeonId, members: [{ id: 'fixture-peer-member', aeon_id: binding.peerAeonId }, { id: 'fixture-owner', aeon_id: null }] }, services };
  main.__reactProps$fixture = props;
  main.__reactFiber$fixture = { memoizedProps: props, return: null };
  window.dotFixture = {
    post: (id, text) => state.messages.push({ id, text, roomId: binding.roomId, requestId: '', self: false, senderId: 'fixture-peer-member', senderAeonId: binding.peerAeonId, deliveryState: '', createdAt: '2026-10-08T00:00:00Z', attachments: [] }),
    inputCount: () => state.texts.length
  };
}

async function browserFixture() {
  const { app, session } = await import('electron');
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-dot-browser-fixture-'));
  app.setPath('userData', owned);
  await app.whenReady();
  const partition = `dot-fixture-${crypto.randomUUID()}`;
  const html = `<html><body><button data-sidebar-destination="builtin:orbit" aria-current="page">Personal fixture</button><main><div contenteditable="true" role="textbox" style="width:200px;height:30px"></div></main><script>(${installNativeFixture.toString()})(${JSON.stringify(binding)})</script></body></html>`;
  session.fromPartition(partition).protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  const { ElectronBrowserBackend } = await import('../electron-browser-backend.mjs');
  const backend = new ElectronBrowserBackend({ windowDefaults: { width: 900, height: 700, show: false, webPreferences: { partition } } });
  let windowSession;
  try {
    windowSession = await backend.createSession({ url: binding.dotUrl, show: false, vendorId: 'chatgpt' });
    const controller = new ChatGPTController({ vendorId: 'chatgpt', recipient: { kind: 'dot', dotUrl: binding.dotUrl }, page: windowSession.page, selectors: {} });
    assert.deepEqual(await controller.prepareDotEntry(), binding);
    let cursor;
    const checkpoints = [];
    const delivered = await controller.talkDot({ text: 'synthetic browser message', binding, recordDotCursor: async (value) => { cursor = value; }, recordDotSubmission: async (value) => checkpoints.push(value) });
    assert.equal(delivered.userMessageId, 'accepted-1');
    assert.equal(parseDotCursor(cursor).messageId, null);
    await windowSession.page.evaluate("dotFixture.post('first', 'browser first'); dotFixture.post('second', 'browser second'); true");
    const received = await controller.readDotMessages({ binding, after: cursor });
    assert.deepEqual(received.messages.map(({ id }) => id), ['first', 'second']);
    assert.equal(await windowSession.page.evaluate('dotFixture.inputCount()'), 1);
    process.stdout.write(`${JSON.stringify({ browserFixture: 'passed', electron: process.versions.electron, deliveredOnce: true, messages: 2, checkpoints: checkpoints.map(({ state }) => state) })}\n`);
  } finally {
    await windowSession?.close();
    await fs.rm(owned, { recursive: true, force: false });
    app.quit();
  }
}

if (process.versions.electron) {
  browserFixture().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
} else {
  const transport = await exerciseDotMessaging();
  const electron = (await import('electron')).default;
  const { stdout } = await promisify(execFile)(electron, [scriptPath], { cwd: repoRoot, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const browser = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(browser.browserFixture, 'passed');
  const output = path.join(repoRoot, '.inbox/.work/dot-messaging-e2e.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const run = promisify(execFile);
  const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
  const fixtureBytes = await fs.readFile(path.join(repoRoot, 'tests/fixtures/chatgpt-dot/native-page.mjs'));
  const source = { gitSha: sha.trim(), dirty: !!dirty.trim(), fixtureSha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex') };
  await fs.writeFile(output, `${JSON.stringify({ command: 'node scripts/e2e-mcp-dot-messaging.mjs', source, transport, browser, cleanup: 'owned service, MCP connections, Electron window and temporary profiles closed' }, null, 2)}\n`);
  process.stdout.write(`Dot fixture transport and browser passed. Evidence: ${output}\n`);
}
