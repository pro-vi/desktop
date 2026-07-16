import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

test('mcp server tools/list exposes only the selected core profile', async () => {
  const tools = await listedTools('core');
  assert.equal(tools.length, 9);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_wait_run'));
  assert.equal(tools.includes('agentify_shutdown'), false);
  assert.equal(tools.includes('agentify_navigate'), false);
});

test('mcp server tools/list composes profiles without duplicate tools', async () => {
  const tools = await listedTools('core,browser');
  assert.equal(tools.length, new Set(tools).size);
  assert.ok(tools.includes('agentify_query'));
  assert.ok(tools.includes('agentify_navigate'));
  assert.equal(tools.includes('agentify_shutdown'), false);
});

test('mcp server tools/list exposes optional image-generation attachments', async () => {
  const tools = await listedToolDefinitions('core');
  const imageGen = tools.find((tool) => tool.name === 'agentify_image_gen');

  assert.ok(imageGen, 'expected agentify_image_gen in the core profile');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.type, 'array');
  assert.equal(imageGen.inputSchema?.properties?.attachments?.items?.type, 'string');
  assert.equal(imageGen.inputSchema?.required?.includes('attachments') || false, false);
});
