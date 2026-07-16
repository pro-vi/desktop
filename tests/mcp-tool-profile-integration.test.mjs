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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

test('mcp server tools/list exposes only the selected core profile', async () => {
  const toolDefinitions = await listedToolDefinitions('core');
  const tools = toolDefinitions.map((tool) => tool.name);
  assert.equal(tools.length, 9);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_wait_run'));
  assert.equal(tools.includes('agentify_shutdown'), false);
  assert.equal(tools.includes('agentify_navigate'), false);

  const imageGen = toolDefinitions.find((tool) => tool.name === 'agentify_image_gen');
  assert.ok(imageGen, 'expected agentify_image_gen in the core profile');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.type, 'array');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.items?.type, 'string');
  assert.equal(imageGen.inputSchema?.required?.includes('attachments') || false, false);
});

test('mcp server tools/list composes profiles without duplicate tools', async () => {
  const tools = await listedTools('core,browser');
  assert.equal(tools.length, new Set(tools).size);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_navigate'));
  assert.equal(tools.includes('agentify_shutdown'), false);
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
