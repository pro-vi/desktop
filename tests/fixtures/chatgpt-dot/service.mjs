import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ChatGPTController } from '../../../chatgpt-controller.mjs';
import { startHttpApi } from '../../../http-api.mjs';
import { TabManager } from '../../../tab-manager.mjs';
import { createProviderTabOperationLeases } from '../../../provider-tab-operation-leases.mjs';
import { writeState, writeToken } from '../../../state.mjs';
import { binding, createNativeDotPage } from './native-page.mjs';

export async function createDotServiceFixture({ native = createNativeDotPage(), stateDir = null } = {}) {
  const ownsDirectory = stateDir === null;
  stateDir ||= await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-dot-messaging-'));
  const token = 'synthetic-dot-fixture-token';
  const serverId = 'synthetic-dot-fixture-server';
  const tabs = new TabManager({
    browserBackend: { createSession: async () => ({ page: native.page, presenter: {}, close: async () => {}, isClosed: () => false }) },
    createController: async ({ recipient }) => recipient.kind === 'dot' ? new ChatGPTController({ vendorId: 'chatgpt', recipient, page: native.page, selectors: {} }) : {
      getUrl: async () => 'https://chatgpt.com/c/fixture-chat',
      query: async () => ({ text: 'ordinary Chat response', meta: { completionEvidence: { source: 'assistant-node', observedAt: Date.now() } } }),
      prepareChatEntry: async () => {}, ensureReady: async () => ({ ok: true })
    }
  });
  const defaultTabId = await tabs.createTab({ key: 'default', vendorId: 'chatgpt', url: 'https://chatgpt.com/' });
  const api = await startHttpApi({ port: 0, token, serverId, tabs, defaultTabId, stateDir, providerTabOperations: createProviderTabOperationLeases(), getStatus: async () => ({ ok: true, url: 'https://chatgpt.com/' }), getSettings: async () => ({ maxInflightQueries: 3, maxQueriesPerMinute: 100, minTabGapMs: 0, minGlobalGapMs: 0 }) });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);
  const call = async (route, body, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${api.address().port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ...options });
    return { status: response.status, data: await response.json() };
  };
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server.mjs'), '--tool-profile', 'core'], env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir }, stderr: 'pipe' });
    const client = new Client({ name: 'dot-messaging-fixture', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return client;
  };
  const close = async ({ remove = ownsDirectory } = {}) => { api.closeAllConnections(); await new Promise((resolve) => api.close(resolve)); if (remove) await fs.rm(stateDir, { recursive: true, force: false }); };
  return { native, tabs, api, call, connect, close, stateDir, binding };
}

export async function exerciseDotMessaging() {
  let fixture = await createDotServiceFixture();
  let client;
  try {
    client = await fixture.connect();
    const catalog = await client.listTools();
    for (const name of ['agentify_dot_talk', 'agentify_dot_read', 'agentify_dot_wait']) assert.ok(catalog.tools.some((tool) => tool.name === name));
    assert.equal(catalog.tools.some((tool) => tool.name === 'agentify_dot_query'), false);
    const talk = await client.callTool({ name: 'agentify_dot_talk', arguments: { text: 'fixture connection' } });
    assert.equal(talk.isError, undefined, JSON.stringify(talk));
    assert.equal(talk.structuredContent.dotSubmission.state, 'submitted');
    const start = talk.structuredContent.dotCursor;
    fixture.native.state.messages.push(fixture.native.incoming('first', 'FIRST_DOT_BODY'), fixture.native.incoming('second', 'SECOND_DOT_BODY'));
    const first = await client.callTool({ name: 'agentify_dot_read', arguments: { after: start, limit: 1 } });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(first.structuredContent.hasMore, true);
    assert.equal(JSON.stringify(first).split('FIRST_DOT_BODY').length - 1, 1);
    assert.equal(Object.hasOwn(first.structuredContent.messages[0], 'text'), false);
    const second = await client.callTool({ name: 'agentify_dot_wait', arguments: { after: first.structuredContent.cursor, timeoutMs: 1_000 } });
    assert.equal(second.isError, undefined, JSON.stringify(second));
    assert.deepEqual(second.structuredContent.messages.map(({ id }) => id), ['second']);
    const cursor = second.structuredContent.cursor;
    const independent = await client.callTool({ name: 'agentify_dot_read', arguments: { after: start } });
    assert.deepEqual(independent.structuredContent.messages.map(({ id }) => id), ['first', 'second']);
    await client.close(); client = null;
    const { native, stateDir } = fixture;
    await fixture.close({ remove: false });
    fixture = await createDotServiceFixture({ native, stateDir });
    client = await fixture.connect();
    const empty = await client.callTool({ name: 'agentify_dot_wait', arguments: { after: cursor, timeoutMs: 20 } });
    assert.equal(empty.structuredContent.timedOut, true);
    assert.equal(empty.structuredContent.cursor, cursor);
    native.state.messages.push(native.incoming('later', 'LATER_DOT_BODY'));
    const later = await client.callTool({ name: 'agentify_dot_wait', arguments: { after: cursor, timeoutMs: 1_000 } });
    assert.deepEqual(later.structuredContent.messages.map(({ id }) => id), ['later']);
    const retry = await fixture.call('/runs/retry', { runId: talk.structuredContent.runId });
    assert.equal(retry.status, 200);
    assert.equal(native.state.inputCount, 1);
    return { tools: 3, delivery: 'accepted', initialIncomingPosts: 2, laterIncomingPosts: 1, independentReaders: true, restartCursor: true, repeatedInputCount: native.state.inputCount, bodiesDuplicated: false, runtime: 'synthetic native page; no provider send' };
  } finally {
    await client?.close();
    await fixture.close({ remove: true });
  }
}
