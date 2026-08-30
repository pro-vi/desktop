#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const execFileAsync = promisify(execFile);
const TAB_KEY = 'wiki-e2e-live-browser';
const CALL_TIMEOUT_MS = 60_000;

function runnerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function timeoutAfter(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runnerError(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), byteLength };
}

function textDigest(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function createConnection() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoDir, 'mcp-server.mjs'), '--tool-profile', 'full'],
    cwd: repoDir,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-mcp-live-browser-e2e', version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}

async function callToolResult(client, name, args = {}) {
  try {
    const result = await timeoutAfter(
      client.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      'e2e_live_browser_call_timeout'
    );
    assert.notEqual(result?.isError, true, `${name}_returned_error`);
    return result;
  } catch (error) {
    error.e2eMethod = name;
    throw error;
  }
}

async function callTool(client, name, args = {}) {
  const result = await callToolResult(client, name, args);
  return result?.structuredContent || {};
}

async function readPage(client, args) {
  const result = await callToolResult(client, 'agentify_read_page', args);
  const text = result?.content?.find(({ type }) => type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return text;
}

async function currentTabs(client) {
  const result = await callTool(client, 'agentify_tabs');
  return Array.isArray(result.tabs) ? result.tabs : [];
}

async function closeOwnedTabs(client) {
  const tabs = await currentTabs(client);
  for (const tab of tabs) {
    if (tab?.key !== TAB_KEY || tab?.protectedTab === true || !tab?.id) continue;
    await callTool(client, 'agentify_tab_close', { tabId: tab.id });
  }
}

async function runtimeEvidence() {
  const electronPackageDir = path.join(repoDir, 'node_modules', 'electron');
  const relativeBinary = (await fs.readFile(path.join(electronPackageDir, 'path.txt'), 'utf8')).trim();
  const binaryPath = await fs.realpath(path.join(electronPackageDir, 'dist', relativeBinary));
  const binary = await sha256File(binaryPath);
  const [{ stdout: gitSha }, { stdout: gitStatus }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }),
    execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repoDir })
  ]);
  return {
    binary: binaryPath,
    binarySha256: binary.sha256,
    binaryBytes: binary.byteLength,
    gitSha: gitSha.trim(),
    gitDirty: gitStatus.length > 0
  };
}

async function main() {
  const connection = createConnection();
  const evidenceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-live-browser-evidence-')));
  await fs.chmod(evidenceDir, 0o700);
  let tabId = null;
  let cleanup = 'pending';
  try {
    await timeoutAfter(connection.client.connect(connection.transport), CALL_TIMEOUT_MS, 'e2e_live_browser_connect_timeout');
    await closeOwnedTabs(connection.client);
    const before = await currentTabs(connection.client);
    assert.equal(before.some(({ key }) => key === TAB_KEY), false);

    const created = await callTool(connection.client, 'agentify_tab_create', {
      model: 'chatgpt',
      key: TAB_KEY,
      name: 'Wiki E2E Live Browser',
      modeIntent: 'instant',
      show: false
    });
    tabId = created.tabId;
    assert.ok(tabId);
    const afterCreate = await currentTabs(connection.client);
    assert.equal(afterCreate.filter((tab) => tab.key === TAB_KEY && tab.id === tabId).length, 1);

    const coldReady = await callTool(connection.client, 'agentify_ensure_ready', {
      tabId,
      timeoutMs: 45_000
    });
    assert.equal(coldReady.ok, true);
    const firstStatus = await callTool(connection.client, 'agentify_status', { tabId });
    assert.equal(firstStatus.ok, true);
    assert.equal(firstStatus.blocked, false);
    const firstPage = await readPage(connection.client, { tabId, maxChars: 20_000 });
    assert.equal(firstPage.length > 0, true);

    await callTool(connection.client, 'agentify_show', { tabId });
    await callTool(connection.client, 'agentify_hide', { tabId });
    const navigated = await callTool(connection.client, 'agentify_navigate', {
      tabId,
      url: 'https://chatgpt.com/'
    });
    assert.equal(new URL(navigated.url).origin, 'https://chatgpt.com');
    const warmReady = await callTool(connection.client, 'agentify_ensure_ready', {
      tabId,
      timeoutMs: 45_000
    });
    assert.equal(warmReady.ok, true);
    const secondStatus = await callTool(connection.client, 'agentify_status', { tabId });
    assert.equal(secondStatus.ok, true);
    assert.equal(secondStatus.blocked, false);
    const secondPage = await readPage(connection.client, { tabId, maxChars: 20_000 });
    assert.equal(secondPage.length > 0, true);

    await callTool(connection.client, 'agentify_tab_close', { tabId });
    tabId = null;
    const afterClose = await currentTabs(connection.client);
    assert.equal(afterClose.some(({ key }) => key === TAB_KEY), false);
    cleanup = 'owned-tab-closed';

    const receipt = {
      schemaVersion: 1,
      result: 'verified',
      journeyId: 'mcp-live-browser-v1',
      checkpoint: 'owned-tab-closed',
      command: ['node', 'scripts/e2e-mcp-live-browser.mjs'],
      runtime: await runtimeEvidence(),
      fixture: {
        mode: 'authenticated-personal-chatgpt-session',
        ownedKey: TAB_KEY,
        providerTextPersistedOrPrinted: false,
        providerTextDigestsPersisted: true
      },
      assertions: {
        tabAbsentPresentAbsent: true,
        coldReady: true,
        warmReady: true,
        statusReadyCount: 2,
        pageReadCount: 2,
        firstPageChars: firstPage.length,
        firstPageSha256: textDigest(firstPage),
        secondPageChars: secondPage.length,
        secondPageSha256: textDigest(secondPage),
        navigatedOrigin: new URL(navigated.url).origin,
        showAndHide: true
      },
      methods: [
        'agentify_read_page',
        'agentify_status',
        'agentify_navigate',
        'agentify_ensure_ready',
        'agentify_show',
        'agentify_hide',
        'agentify_tabs',
        'agentify_tab_create',
        'agentify_tab_close'
      ],
      cleanup
    };
    const receiptPath = path.join(evidenceDir, 'receipt.json');
    receipt.evidence = { receipt: receiptPath };
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return receipt;
  } finally {
    if (tabId) await closeOwnedTabs(connection.client).catch(() => {});
    await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
  }
}

main().then((receipt) => {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}).catch((error) => {
  const method = /^agentify_[a-z_]+$/.test(String(error?.e2eMethod || ''))
    ? String(error.e2eMethod)
    : null;
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    result: 'product-fail',
    error: String(error?.code || 'e2e_live_browser_failed'),
    method
  })}\n`);
  process.exitCode = 1;
});
