import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { writeState, writeToken } from '../state.mjs';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(repoDir, 'mcp-server.mjs');

async function listedToolDefinitions(profile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', profile],
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-profile-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
  }
}

async function listedTools(profile) {
  return (await listedToolDefinitions(profile)).map((tool) => tool.name);
}

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendJsonStatus(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const transcriptSnapshotRef = Object.freeze({
  kind: 'snapshot',
  algorithm: 'sha256',
  hash: 'a'.repeat(64),
  contentHash: 'b'.repeat(64),
  byteLength: 1234
});

function transcriptAttemptFixture() {
  return {
    schemaVersion: 1,
    id: 'attempt-1',
    sourceId: 'source-1',
    trigger: 'manual',
    startedAt: '2026-07-30T12:00:00.000Z',
    finishedAt: '2026-07-30T12:00:01.000Z',
    outcome: { kind: 'complete', snapshot: transcriptSnapshotRef, changed: true }
  };
}

function transcriptSourceFixture({ complete = false } = {}) {
  const attempt = complete ? transcriptAttemptFixture() : null;
  return {
    schemaVersion: 1,
    id: 'source-1',
    identity: {
      provider: 'chatgpt',
      profileScopeId: 'profile-main',
      providerConversationId: 'conversation-1'
    },
    label: 'PRIVATE LABEL MUST NOT CROSS MCP',
    tags: ['private-tag'],
    key: 'private-key',
    target: {
      kind: 'owned-conversation',
      location: {
        kind: 'standalone-conversation',
        conversationUrl: 'https://chatgpt.com/c/conversation-1',
        sourceUrl: 'https://chatgpt.com/c/private-route-must-not-cross-mcp'
      }
    },
    enabled: true,
    state: complete ? 'complete' : 'tracked',
    latestLiveSnapshot: complete ? transcriptSnapshotRef : null,
    lastAttempt: attempt,
    createdAt: '2026-07-30T11:59:00.000Z',
    updatedAt: complete ? '2026-07-30T12:00:01.000Z' : '2026-07-30T11:59:00.000Z'
  };
}

function transcriptSyncFixture() {
  const attempt = transcriptAttemptFixture();
  return {
    source: transcriptSourceFixture({ complete: true }),
    attempt,
    status: 'complete',
    outcome: attempt.outcome
  };
}

function transcriptSyncFixtureForSource(sourceId) {
  const response = transcriptSyncFixture();
  response.source.id = sourceId;
  response.source.lastAttempt.sourceId = sourceId;
  response.attempt.sourceId = sourceId;
  return response;
}

function transcriptPageFixture() {
  const identity = {
    provider: 'chatgpt',
    profileScopeId: 'profile-main',
    providerConversationId: 'conversation-1'
  };
  const structuredTurns = [
    {
      turnId: 'provider:message-1',
      ordinal: 0,
      identity: { kind: 'provider', providerMessageId: 'message-1' },
      role: 'user',
      rawRole: 'user',
      text: 'Bounded fixture prompt'
    },
    {
      turnId: 'provider:message-2',
      ordinal: 1,
      identity: { kind: 'provider', providerMessageId: 'message-2' },
      role: 'unknown',
      rawRole: null,
      text: 'Bounded fixture reply'
    }
  ];
  return {
    schemaVersion: 1,
    identity,
    snapshot: transcriptSnapshotRef,
    normalizationVersion: 1,
    capturedAt: '2026-07-30T12:00:01.000Z',
    startOrdinal: 0,
    endOrdinal: 2,
    totalTurns: 2,
    text: 'User\nBounded fixture prompt\n\nUnknown\nBounded fixture reply',
    structuredTurns,
    citations: structuredTurns.map(({ turnId }) => ({
      identity: 'chatgpt/profile-main/conversation-1',
      snapshotHash: transcriptSnapshotRef.hash,
      turnId
    })),
    nextCursor: null,
    liveSourceId: 'source-1',
    sourceKey: 'thread-key',
    conversationUrl: 'https://chatgpt.com/c/conversation-1'
  };
}

const catalogIdentity = Object.freeze({
  provider: 'chatgpt',
  profileScopeId: 'profile-main',
  providerConversationId: 'conversation-1'
});

const maxCatalogProfileScopeId = 's'.repeat(128);
function catalogCursor(offset) {
  return `catalog-v1.${Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 101,
    offset,
    profileScopeId: maxCatalogProfileScopeId
  })).toString('base64url')}`;
}
const catalogCursor1 = catalogCursor(1);
const catalogCursor2 = catalogCursor(2);

const catalogRawRecordRef = Object.freeze({
  kind: 'raw',
  algorithm: 'sha256',
  hash: 'c'.repeat(64),
  byteLength: 456
});

function catalogImportFixture() {
  return {
    status: 'complete',
    importId: 'import-1',
    counts: { recordsSeen: 1, cataloged: 1, snapshots: 1, problems: 0 }
  };
}

function catalogConversationFixture() {
  return {
    schemaVersion: 1,
    identity: catalogIdentity,
    title: 'Catalog fixture conversation',
    route: { kind: 'unverified', claimedConversationId: 'conversation-1' },
    firstObservedAt: '2026-07-30T12:00:00.000Z',
    lastObservedAt: '2026-07-30T12:00:01.000Z',
    latestArchiveRecord: catalogRawRecordRef,
    latestImportedSnapshot: transcriptSnapshotRef
  };
}

function catalogPageFixture() {
  return {
    items: [catalogConversationFixture()],
    nextCursor: catalogCursor2
  };
}

function catalogVerificationFixture() {
  return {
    status: 'verified',
    identity: catalogIdentity,
    canonicalUrl: 'https://chatgpt.com/c/conversation-1',
    evidence: 'direct-navigation'
  };
}

test('mcp server tools/list exposes only the selected core profile', async () => {
  const toolDefinitions = await listedToolDefinitions('core');
  const tools = toolDefinitions.map((tool) => tool.name);
  assert.equal(tools.length, 10);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_wait_run'));
  assert.equal(tools.includes('agentify_shutdown'), false);
  assert.equal(tools.includes('agentify_navigate'), false);

  const imageGen = toolDefinitions.find((tool) => tool.name === 'agentify_image_gen');
  assert.ok(imageGen, 'expected agentify_image_gen in the core profile');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.type, 'array');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.items?.type, 'string');
  assert.equal(imageGen.inputSchema?.required?.includes('attachments') || false, false);

  const query = toolDefinitions.find((tool) => tool.name === 'agentify_query');
  assert.equal(query.inputSchema?.properties?.liveSourceId?.type, 'string');
  assert.equal(query.inputSchema?.required?.includes('liveSourceId') || false, false);
});

test('mcp query forwards an optional live continuation binding through real stdio and preserves generic queries', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-live-continuation-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const token = 'mcp-live-continuation-token';
  const serverId = 'mcp-live-continuation-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/query') {
      return sendJson(res, {
        ok: true,
        tabId: 'tab-thread',
        runId: `run-${requests.length}`,
        result: { text: 'receipt-backed reply', codeBlocks: [], meta: null }
      });
    }
    return sendJsonStatus(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'core'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-live-continuation-test', version: '1.0.0' }, { capabilities: {} });
  let continued;
  let generic;
  const malformed = [];
  try {
    await client.connect(transport);
    continued = await client.callTool({
      name: 'agentify_query',
      arguments: {
        liveSourceId: 'source-1',
        key: 'thread-key',
        chatUrl: 'https://chatgpt.com/c/conversation-1',
        prompt: 'Harmless continuation'
      }
    });
    generic = await client.callTool({
      name: 'agentify_query',
      arguments: { key: 'ordinary-key', prompt: 'Ordinary query' }
    });
    for (const key of [' thread-key ', 'thread-key\n']) {
      malformed.push(await client.callTool({
        name: 'agentify_query',
        arguments: {
          liveSourceId: 'source-1',
          key,
          chatUrl: 'https://chatgpt.com/c/conversation-1',
          prompt: 'Must not reach HTTP'
        }
      }));
    }
  } finally {
    await client.close();
  }

  assert.equal(continued.isError, undefined);
  assert.equal(continued.content[0].text, 'receipt-backed reply');
  assert.equal(generic.isError, undefined);
  assert.equal(malformed.every(({ isError }) => isError === true), true);
  for (const result of malformed) assert.match(result.content[0].text, /conversation-not-live-bound/);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    method: 'POST',
    path: '/query',
    authorization: `Bearer ${token}`,
    body: {
      source: 'mcp',
      key: 'thread-key',
      chatUrl: 'https://chatgpt.com/c/conversation-1',
      liveSourceId: 'source-1',
      prompt: 'Harmless continuation',
      attachments: [],
      contextPaths: [],
      timeoutMs: 10 * 60_000
    }
  });
  assert.equal(Object.hasOwn(requests[1].body, 'liveSourceId'), false);
  assert.equal(requests[1].body.key, 'ordinary-key');
  assert.equal(requests[1].body.prompt, 'Ordinary query');
});

test('mcp query surfaces the stable live-continuation guard error through real stdio', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-live-continuation-error-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const token = 'mcp-live-continuation-error-token';
  const serverId = 'mcp-live-continuation-error-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/query') {
      return sendJsonStatus(res, 409, { error: 'conversation-not-live-bound' });
    }
    return sendJsonStatus(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'core'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-live-continuation-error-test', version: '1.0.0' }, { capabilities: {} });
  let result;
  try {
    await client.connect(transport);
    result = await client.callTool({
      name: 'agentify_query',
      arguments: {
        liveSourceId: 'source-1',
        key: 'thread-key',
        chatUrl: 'https://chatgpt.com/c/conversation-1',
        prompt: 'Harmless continuation'
      }
    });
  } finally {
    await client.close();
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${token}`);
  assert.equal(requests[0].body.liveSourceId, 'source-1');
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'conversation-not-live-bound');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('<div'), false);
});

test('mcp server tools/list composes profiles without duplicate tools', async () => {
  const tools = await listedTools('core,browser');
  assert.equal(tools.length, new Set(tools).size);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_navigate'));
  assert.equal(tools.includes('agentify_shutdown'), false);
});

test('mcp server library profile exposes the exact eight catalog and transcript schemas', async () => {
  const definitions = await listedToolDefinitions('library');
  assert.deepEqual(definitions.map(({ name }) => name), [
    'agentify_import_chatgpt_export',
    'agentify_verify_catalog_conversation',
    'agentify_list_chatgpt_catalog',
    'agentify_track_transcript',
    'agentify_sync_transcript',
    'agentify_list_transcripts',
    'agentify_get_transcript',
    'agentify_forget_transcript'
  ]);

  const byName = new Map(definitions.map((definition) => [definition.name, definition.inputSchema]));
  const importExport = byName.get('agentify_import_chatgpt_export');
  assert.deepEqual(Object.keys(importExport.properties).sort(), ['grantId', 'profileScopeId']);
  assert.deepEqual([...importExport.required].sort(), ['grantId', 'profileScopeId']);
  assert.equal(importExport.additionalProperties, false);

  const verifyCatalog = byName.get('agentify_verify_catalog_conversation');
  assert.deepEqual(Object.keys(verifyCatalog.properties).sort(), ['identity', 'key']);
  assert.deepEqual([...verifyCatalog.required].sort(), ['identity', 'key']);
  assert.equal(verifyCatalog.additionalProperties, false);
  assert.equal(verifyCatalog.properties.identity.additionalProperties, false);
  assert.deepEqual(
    [...verifyCatalog.properties.identity.required].sort(),
    ['profileScopeId', 'provider', 'providerConversationId']
  );

  const listCatalog = byName.get('agentify_list_chatgpt_catalog');
  assert.deepEqual(Object.keys(listCatalog.properties).sort(), ['cursor', 'limit', 'profileScopeId']);
  assert.equal(listCatalog.required, undefined);
  assert.equal(listCatalog.additionalProperties, false);

  const track = byName.get('agentify_track_transcript');
  assert.deepEqual(Object.keys(track.properties).sort(), ['key', 'label', 'profileScopeId', 'tags']);
  assert.deepEqual([...track.required].sort(), ['key', 'label', 'profileScopeId', 'tags']);
  assert.equal(track.additionalProperties, false);

  const sync = byName.get('agentify_sync_transcript');
  assert.deepEqual(Object.keys(sync.properties), ['sourceId']);
  assert.deepEqual(sync.required, ['sourceId']);
  assert.equal(sync.additionalProperties, false);

  const list = byName.get('agentify_list_transcripts');
  assert.deepEqual(list.properties, {});
  assert.equal(list.additionalProperties, false);

  const get = byName.get('agentify_get_transcript');
  assert.deepEqual(Object.keys(get.properties).sort(), ['cursor', 'identity', 'includePaths', 'limit', 'snapshot']);
  assert.deepEqual(get.required, ['identity']);
  assert.equal(get.additionalProperties, false);
  assert.equal(get.properties.identity.additionalProperties, false);
  assert.equal(get.properties.snapshot.additionalProperties, false);
  assert.equal(get.properties.cursor.additionalProperties, false);

  const forget = byName.get('agentify_forget_transcript');
  assert.deepEqual(Object.keys(forget.properties).sort(), ['confirm', 'sourceId']);
  assert.deepEqual([...forget.required].sort(), ['confirm', 'sourceId']);
  assert.equal(forget.additionalProperties, false);
  assert.equal(forget.properties.confirm.const, true);
});

test('mcp catalog tools forward authenticated HTTP through the real stdio server', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-catalog-state-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const token = 'mcp-catalog-test-token';
  const serverId = 'mcp-catalog-test-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/catalog/import') return sendJson(res, catalogImportFixture());
    if (req.url === '/catalog/verify') return sendJson(res, catalogVerificationFixture());
    if (req.url?.startsWith('/catalog/list')) return sendJson(res, catalogPageFixture());
    return sendJsonStatus(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'library'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-catalog-test', version: '1.0.0' }, { capabilities: {} });
  const results = {};
  try {
    await client.connect(transport);
    results.import = await client.callTool({
      name: 'agentify_import_chatgpt_export',
      arguments: { grantId: 'grant-stdio-1', profileScopeId: 'profile-main' }
    });
    results.verify = await client.callTool({
      name: 'agentify_verify_catalog_conversation',
      arguments: { identity: catalogIdentity, key: 'catalog-verification' }
    });
    results.list = await client.callTool({
      name: 'agentify_list_chatgpt_catalog',
      arguments: { profileScopeId: maxCatalogProfileScopeId, cursor: catalogCursor1, limit: 1 }
    });
    results.extraImportField = await client.callTool({
      name: 'agentify_import_chatgpt_export',
      arguments: {
        grantId: 'grant-stdio-2',
        profileScopeId: 'profile-main',
        archivePath: '/Users/private/export.zip'
      }
    });
    results.invalidGrant = await client.callTool({
      name: 'agentify_import_chatgpt_export',
      arguments: { grantId: 'not-a-grant', profileScopeId: 'profile-main' }
    });
    results.invalidVerificationKey = await client.callTool({
      name: 'agentify_verify_catalog_conversation',
      arguments: { identity: catalogIdentity, key: ' padded ' }
    });
  } finally {
    await client.close();
  }

  assert.deepEqual(requests, [
    {
      method: 'POST',
      path: '/catalog/import',
      authorization: `Bearer ${token}`,
      body: { grantId: 'grant-stdio-1', profileScopeId: 'profile-main' }
    },
    {
      method: 'POST',
      path: '/catalog/verify',
      authorization: `Bearer ${token}`,
      body: { identity: catalogIdentity, key: 'catalog-verification' }
    },
    {
      method: 'GET',
      path: `/catalog/list?profileScopeId=${maxCatalogProfileScopeId}&cursor=${catalogCursor1}&limit=1`,
      authorization: `Bearer ${token}`,
      body: undefined
    }
  ]);
  assert.equal(results.import.content[0].text, 'status=complete importId=import-1 records=1 snapshots=1 problems=0');
  assert.deepEqual(results.import.structuredContent, catalogImportFixture());
  assert.equal(results.verify.content[0].text, 'status=verified');
  assert.deepEqual(results.verify.structuredContent, catalogVerificationFixture());
  assert.equal(results.list.content[0].text, 'count=1 nextCursor=available');
  assert.deepEqual(results.list.structuredContent, catalogPageFixture());
  assert.equal(results.extraImportField.isError, true);
  assert.equal(results.invalidGrant.isError, true);
  assert.equal(results.invalidVerificationKey.isError, true);
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes('/Users/private'), false);
  assert.equal(serialized.includes('export.zip'), false);
});

test('mcp catalog tools fail closed and redact malformed or private HTTP responses', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-catalog-redaction-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const token = 'mcp-catalog-redaction-token';
  const serverId = 'mcp-catalog-redaction-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    if (req.url === '/catalog/import' && body.grantId === 'grant-malformed-200') {
      return sendJson(res, {
        ...catalogImportFixture(),
        archivePath: '/Users/private/export.zip',
        transcript: 'PRIVATE TRANSCRIPT BODY'
      });
    }
    if (req.url === '/catalog/import' && body.grantId === 'grant-private-error') {
      return sendJsonStatus(res, 500, {
        error: 'internal_error',
        message: 'PRIVATE EXCEPTION /Users/private/export.zip',
        data: { transcript: 'PRIVATE TRANSCRIPT BODY' }
      });
    }
    if (req.url === '/catalog/verify' && body.key === 'identity-mismatch') {
      return sendJson(res, {
        status: 'verified',
        identity: { ...catalogIdentity, providerConversationId: 'conversation-2' },
        canonicalUrl: 'https://chatgpt.com/c/conversation-2',
        evidence: 'direct-navigation'
      });
    }
    if (req.url === '/catalog/verify' && body.key === 'missing-safe') {
      return sendJsonStatus(res, 404, { error: 'catalog_conversation_not_found' });
    }
    if (req.url?.startsWith('/catalog/list')) {
      return sendJson(res, {
        ...catalogPageFixture(),
        archivePath: '/Users/private/export.zip',
        transcript: 'PRIVATE TRANSCRIPT BODY'
      });
    }
    return sendJsonStatus(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'library'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-catalog-redaction-test', version: '1.0.0' }, { capabilities: {} });
  const results = [];
  try {
    await client.connect(transport);
    for (const grantId of ['grant-malformed-200', 'grant-private-error']) {
      results.push(await client.callTool({
        name: 'agentify_import_chatgpt_export',
        arguments: { grantId, profileScopeId: 'profile-main' }
      }));
    }
    for (const key of ['identity-mismatch', 'missing-safe']) {
      results.push(await client.callTool({
        name: 'agentify_verify_catalog_conversation',
        arguments: { identity: catalogIdentity, key }
      }));
    }
    results.push(await client.callTool({
      name: 'agentify_list_chatgpt_catalog',
      arguments: { profileScopeId: 'profile-main' }
    }));
  } finally {
    await client.close();
  }

  assert.equal(results.every(({ isError }) => isError === true), true);
  assert.match(results[0].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[1].content[0].text, /transcript_mcp_request_failed/);
  assert.match(results[2].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[3].content[0].text, /catalog_conversation_not_found/);
  assert.match(results[4].content[0].text, /transcript_mcp_response_invalid/);
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('/Users/private'), false);
  assert.equal(serialized.includes('export.zip'), false);
});

test('mcp transcript tools forward authenticated HTTP and return only safe metadata', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-transcript-state-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const requests = [];
  const token = 'mcp-transcript-test-token';
  const serverId = 'mcp-transcript-test-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/transcripts/track') return sendJson(res, transcriptSourceFixture());
    if (req.url === '/transcripts/sync') return sendJson(res, transcriptSyncFixture());
    if (req.url === '/transcripts/list') return sendJson(res, [transcriptSourceFixture({ complete: true })]);
    if (req.url === '/transcripts/get') return sendJson(res, transcriptPageFixture());
    if (req.url === '/transcripts/forget') {
      return sendJson(res, {
        sourceId: 'source-1',
        recoverable: true,
        recoveryLocation: 'local-trash/deleted-1',
        forgottenAt: '2026-07-30T12:01:00.000Z'
      });
    }
    return sendJsonStatus(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'library'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-transcript-test', version: '1.0.0' }, { capabilities: {} });
  const results = {};
  try {
    await client.connect(transport);
    results.track = await client.callTool({
      name: 'agentify_track_transcript',
      arguments: { label: 'Local label', tags: ['acceptance'], key: 'thread-key', profileScopeId: 'profile-main' }
    });
    results.sync = await client.callTool({
      name: 'agentify_sync_transcript',
      arguments: { sourceId: 'source-1' }
    });
    results.list = await client.callTool({ name: 'agentify_list_transcripts', arguments: {} });
    results.get = await client.callTool({
      name: 'agentify_get_transcript',
      arguments: {
        identity: {
          provider: 'chatgpt',
          profileScopeId: 'profile-main',
          providerConversationId: 'conversation-1'
        },
        limit: 2
      }
    });
    results.forget = await client.callTool({
      name: 'agentify_forget_transcript',
      arguments: { sourceId: 'source-1', confirm: true }
    });
    results.extraTrackField = await client.callTool({
      name: 'agentify_track_transcript',
      arguments: {
        label: 'PRIVATE INVALID LABEL',
        tags: [],
        key: 'thread-key',
        profileScopeId: 'profile-main',
        tabId: 'not-in-contract'
      }
    });
    results.unconfirmedForget = await client.callTool({
      name: 'agentify_forget_transcript',
      arguments: { sourceId: 'source-1', confirm: false }
    });
    results.invalidTrackLabel = await client.callTool({
      name: 'agentify_track_transcript',
      arguments: { label: ' padded ', tags: [], key: 'thread-key', profileScopeId: 'profile-main' }
    });
    results.invalidTrackKey = await client.callTool({
      name: 'agentify_track_transcript',
      arguments: { label: 'Local label', tags: [], key: ' padded ', profileScopeId: 'profile-main' }
    });
    results.duplicateTrackTags = await client.callTool({
      name: 'agentify_track_transcript',
      arguments: { label: 'Local label', tags: ['same', 'same'], key: 'thread-key', profileScopeId: 'profile-main' }
    });
  } finally {
    await client.close();
  }

  assert.deepEqual(requests, [
    {
      method: 'POST',
      path: '/transcripts/track',
      authorization: `Bearer ${token}`,
      body: { label: 'Local label', tags: ['acceptance'], key: 'thread-key', profileScopeId: 'profile-main' }
    },
    {
      method: 'POST',
      path: '/transcripts/sync',
      authorization: `Bearer ${token}`,
      body: { sourceId: 'source-1' }
    },
    {
      method: 'GET',
      path: '/transcripts/list',
      authorization: `Bearer ${token}`,
      body: undefined
    },
    {
      method: 'POST',
      path: '/transcripts/get',
      authorization: `Bearer ${token}`,
      body: {
        identity: {
          provider: 'chatgpt',
          profileScopeId: 'profile-main',
          providerConversationId: 'conversation-1'
        },
        limit: 2
      }
    },
    {
      method: 'POST',
      path: '/transcripts/forget',
      authorization: `Bearer ${token}`,
      body: { sourceId: 'source-1', confirm: true }
    }
  ]);
  assert.equal(results.track.content[0].text, 'sourceId=source-1 status=tracked');
  assert.equal(results.sync.content[0].text, 'sourceId=source-1 status=complete changed=true');
  assert.equal(results.list.content[0].text, 'count=1');
  assert.equal(results.get.content[0].text, transcriptPageFixture().text);
  assert.deepEqual(results.get.structuredContent.citations, transcriptPageFixture().citations);
  assert.equal(results.forget.content[0].text, 'sourceId=source-1 status=forgotten');
  assert.equal(results.extraTrackField.isError, true);
  assert.equal(results.unconfirmedForget.isError, true);
  assert.equal(results.invalidTrackLabel.isError, true);
  assert.equal(results.invalidTrackKey.isError, true);
  assert.equal(results.duplicateTrackTags.isError, true);
  assert.equal(results.track.structuredContent.label, undefined);
  assert.equal(results.track.structuredContent.tags, undefined);
  assert.equal(results.track.structuredContent.key, undefined);
  assert.equal(results.track.structuredContent.target, undefined);
  assert.equal(results.list.structuredContent.count, 1);
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes('PRIVATE LABEL'), false);
  assert.equal(serialized.includes('PRIVATE INVALID LABEL'), false);
  assert.equal(serialized.includes('private-route'), false);
  assert.equal(serialized.includes('private-key'), false);
  assert.equal(serialized.includes('private-tag'), false);
});

test('mcp transcript tools fail closed and redact malformed or private HTTP responses', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-transcript-redaction-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const token = 'mcp-transcript-redaction-token';
  const serverId = 'mcp-transcript-redaction-server';
  const privateResponseMarker = 'PRIVATE_MCP_RESPONSE_MARKER';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') return sendJson(res, { ok: true, serverId });
    if (req.url === '/status') return sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    if (req.url === '/transcripts/sync' && body.sourceId === 'malformed-200') {
      return sendJson(res, { status: 'complete', transcript: 'PRIVATE TRANSCRIPT BODY' });
    }
    if (req.url === '/transcripts/sync' && body.sourceId === 'private-error') {
      return sendJsonStatus(res, 500, {
        error: 'internal_error',
        message: 'PRIVATE EXCEPTION /Users/private/export.zip',
        data: { transcript: 'PRIVATE TRANSCRIPT BODY' }
      });
    }
    if (req.url === '/transcripts/sync' && body.sourceId === 'identity-route-mismatch') {
      const response = transcriptSyncFixture();
      response.source.target.location.conversationUrl = 'https://chatgpt.com/c/different-conversation';
      return sendJson(res, response);
    }
    if (req.url === '/transcripts/sync' && body.sourceId === 'invalid-source-key') {
      const response = transcriptSyncFixtureForSource(body.sourceId);
      response.source.key = ` ${privateResponseMarker}\n`;
      return sendJson(res, response);
    }
    if (req.url === '/transcripts/sync' && body.sourceId === 'duplicate-source-tags') {
      const response = transcriptSyncFixtureForSource(body.sourceId);
      response.source.tags = [privateResponseMarker, privateResponseMarker];
      return sendJson(res, response);
    }
    if (req.url === '/transcripts/get') {
      const response = transcriptPageFixture();
      if (body.limit === 2) {
        response.structuredTurns[0].role = 'assistant';
        response.text = `Assistant\n${response.structuredTurns[0].text}\n\nAssistant\n${response.structuredTurns[1].text}`;
        return sendJson(res, response);
      }
      if (body.limit === 3) {
        response.structuredTurns[0].text = `${privateResponseMarker}\r\nnoncanonical `;
        response.text = `User\n${response.structuredTurns[0].text}\n\nAssistant\n${response.structuredTurns[1].text}`;
        return sendJson(res, response);
      }
      if (body.limit === 4) {
        const localHash = 'c'.repeat(64);
        response.structuredTurns[1].identity = { kind: 'snapshot-local', ordinal: 1, turnContentHash: localHash };
        response.structuredTurns[1].turnId = `snapshot-local:1:${localHash}`;
        response.citations[1].turnId = response.structuredTurns[1].turnId;
        return sendJson(res, response);
      }
      if (body.limit === 5) {
        response.sourceKey = ` ${privateResponseMarker} `;
        return sendJson(res, response);
      }
      if (body.limit === 6) {
        response.sourceKey = `${privateResponseMarker}\n`;
        return sendJson(res, response);
      }
      if (body.limit === 7) {
        response.structuredTurns[1].role = 'assistant';
        response.text = 'User\nBounded fixture prompt\n\nAssistant\nBounded fixture reply';
        return sendJson(res, response);
      }
      response.text = 'PRIVATE TRANSCRIPT BODY THAT DOES NOT MATCH TURNS';
      return sendJson(res, response);
    }
    return sendJsonStatus(res, 404, { error: 'transcript_source_not_found' });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  await writeToken(token, stateDir);
  await writeState({ ok: true, port: api.address().port, serverId }, stateDir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'library'],
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-transcript-redaction-test', version: '1.0.0' }, { capabilities: {} });
  const results = [];
  try {
    await client.connect(transport);
    for (const sourceId of [
      'malformed-200',
      'private-error',
      'missing-source',
      'identity-route-mismatch',
      'invalid-source-key',
      'duplicate-source-tags'
    ]) {
      results.push(await client.callTool({ name: 'agentify_sync_transcript', arguments: { sourceId } }));
    }
    for (const limit of [undefined, 2, 3, 4, 5, 6, 7]) {
      results.push(await client.callTool({
        name: 'agentify_get_transcript',
        arguments: {
          identity: {
            provider: 'chatgpt',
            profileScopeId: 'profile-main',
            providerConversationId: 'conversation-1'
          },
          ...(limit === undefined ? {} : { limit })
        }
      }));
    }
  } finally {
    await client.close();
  }

  assert.equal(results.every(({ isError }) => isError === true), true);
  assert.match(results[0].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[1].content[0].text, /transcript_mcp_request_failed/);
  assert.match(results[2].content[0].text, /transcript_source_not_found/);
  assert.match(results[3].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[4].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[5].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[6].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[7].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[8].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[9].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[10].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[11].content[0].text, /transcript_mcp_response_invalid/);
  assert.match(results[12].content[0].text, /transcript_mcp_response_invalid/);
  const serialized = JSON.stringify(results);
  assert.equal(serialized.includes(privateResponseMarker), false);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('/Users/private'), false);
  assert.equal(serialized.includes('export.zip'), false);
});

test('mcp image generation resolves and forwards reference attachments', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-image-state-'));
  const mcpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-image-cwd-'));
  t.after(() => Promise.all([
    fs.rm(stateDir, { recursive: true, force: true }),
    fs.rm(mcpCwd, { recursive: true, force: true })
  ]));
  const requests = [];
  const token = 'mcp-image-test-token';
  const serverId = 'mcp-image-test-server';
  const api = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      requests.push({ method: req.method, path: req.url });
      sendJson(res, { ok: true, serverId });
      return;
    }
    if (req.url === '/status') {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
      sendJson(res, { ok: true, url: 'https://chatgpt.com/' });
      return;
    }
    if (req.method === 'POST' && (req.url === '/query' || req.url === '/artifacts/save')) {
      requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: await readJsonBody(req) });
      if (req.url === '/query') {
        sendJson(res, { tabId: 'generated-image-tab', result: { text: 'image created' } });
      } else {
        sendJson(res, { artifacts: ['/tmp/generated-image.png'], dir: '/tmp/generated-images' });
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    if (api.listening) await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  });
  const port = api.address().port;
  await writeToken(token, stateDir);
  await writeState({ ok: true, port, serverId }, stateDir);

  const absoluteReference = path.join(stateDir, 'absolute-reference.png');
  await fs.mkdir(path.join(mcpCwd, 'references'), { recursive: true });
  await fs.writeFile(path.join(mcpCwd, 'references', 'style.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(absoluteReference, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const canonicalMcpCwd = await fs.realpath(mcpCwd);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--tool-profile', 'core'],
    cwd: mcpCwd,
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir, AGENTIFY_DESKTOP_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-image-test', version: '1.0.0' }, { capabilities: {} });

  let result;
  try {
    await client.connect(transport);
    result = await client.callTool({
      name: 'agentify_image_gen',
      arguments: {
        prompt: 'Generate from these references.',
        key: 'image-test',
        attachments: [' references/style.png ', absoluteReference],
        maxImages: 2
      }
    });
    await client.callTool({
      name: 'agentify_image_gen',
      arguments: { prompt: 'Generate without a reference.' }
    });
  } finally {
    await client.close();
  }

  assert.deepEqual(requests.map((request) => request.path), [
    '/health', '/status', '/query', '/artifacts/save',
    '/health', '/status', '/query', '/artifacts/save'
  ]);
  const statusRequest = requests.find((request) => request.path === '/status');
  const queryRequests = requests.filter((request) => request.path === '/query');
  const saveRequests = requests.filter((request) => request.path === '/artifacts/save');
  const queryRequest = queryRequests[0];
  const saveRequest = saveRequests[0];
  assert.equal(statusRequest?.authorization, `Bearer ${token}`);
  assert.equal(queryRequest?.authorization, `Bearer ${token}`);
  assert.equal(queryRequest?.body?.source, 'mcp');
  assert.equal(queryRequest?.body?.imageGeneration, true);
  assert.equal(queryRequest?.body?.prompt, 'Generate from these references.');
  assert.equal(queryRequest?.body?.key, 'image-test');
  assert.deepEqual(queryRequest?.body?.attachments, [path.join(canonicalMcpCwd, 'references/style.png'), absoluteReference]);
  assert.deepEqual(queryRequests[1]?.body?.attachments, []);
  assert.deepEqual(saveRequest?.body, { tabId: 'generated-image-tab', key: 'image-test', mode: 'images', maxImages: 2 });
  assert.deepEqual(result.structuredContent, {
    tabId: 'generated-image-tab',
    text: 'image created',
    files: ['/tmp/generated-image.png'],
    dir: '/tmp/generated-images'
  });
});
