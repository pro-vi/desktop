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

import { createChatGptExportReader } from '../chatgpt-export-reader.mjs';
import { createConversationCatalogStore } from '../conversation-catalog-store.mjs';
import { createConversationCatalogService } from '../conversation-catalog-sync.mjs';
import { createElectronExportImportGrants } from '../export-import-grants.mjs';
import { startHttpApi } from '../http-api.mjs';
import { createPrivateLibraryBlobStore } from '../library-blob-store.mjs';
import { createProviderTabOperationLeases } from '../provider-tab-operation-leases.mjs';
import { writeState, writeToken } from '../state.mjs';
import { buildZip } from '../tests/fixtures/zip-archive.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const execFileAsync = promisify(execFile);
const PROFILE_SCOPE_ID = 'e2e-catalog-import';
const PROVIDER_CONVERSATION_ID = '6bd95d30-1229-4fa2-b155-0fe60d3cc304';
const VERIFY_KEY = 'e2e-catalog-verification';
const OWNED_STATE_MARKER = '.agentify-mcp-catalog-import-e2e.json';
const CALL_TIMEOUT_MS = 30_000;
const FIXED_TIME = '2026-08-30T12:00:00.000Z';
let activePhase = 'startup';

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

async function makeOwnedStateRoot() {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-catalog-import-')));
  await fs.chmod(stateDir, 0o700);
  const nonce = crypto.randomUUID();
  const markerPath = path.join(stateDir, OWNED_STATE_MARKER);
  await fs.writeFile(markerPath, `${JSON.stringify({ schemaVersion: 1, nonce, stateDir })}\n`, {
    mode: 0o600,
    flag: 'wx'
  });
  return { stateDir, markerPath, nonce };
}

async function assertOwnedStateRoot(owned) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const expectedPrefix = `${temporaryRoot}${path.sep}agentify-mcp-catalog-import-`;
  const realStateDir = await fs.realpath(owned.stateDir);
  const rootStat = await fs.lstat(realStateDir);
  const markerStat = await fs.lstat(owned.markerPath);
  const marker = JSON.parse(await fs.readFile(owned.markerPath, 'utf8'));
  if (
    realStateDir !== owned.stateDir ||
    !realStateDir.startsWith(expectedPrefix) ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    (markerStat.mode & 0o777) !== 0o600 ||
    marker?.nonce !== owned.nonce ||
    marker?.stateDir !== owned.stateDir
  ) {
    throw runnerError('e2e_catalog_import_owned_root_invalid');
  }
}

async function cleanupOwnedStateRoot(owned) {
  await assertOwnedStateRoot(owned);
  await fs.rm(owned.stateDir, { recursive: true, force: false });
  try {
    await fs.lstat(owned.stateDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'owned-state-removed';
  }
  throw runnerError('e2e_catalog_import_cleanup_invalid');
}

function message(id, role, text, createdAtSeconds) {
  return {
    id,
    author: { role, name: null, metadata: {} },
    create_time: createdAtSeconds,
    update_time: null,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all'
  };
}

function fixtureConversation() {
  const rootId = `${PROVIDER_CONVERSATION_ID}-root`;
  const userId = `${PROVIDER_CONVERSATION_ID}-user`;
  const assistantId = `${PROVIDER_CONVERSATION_ID}-assistant`;
  const createdAtSeconds = Date.parse(FIXED_TIME) / 1000;
  return {
    id: PROVIDER_CONVERSATION_ID,
    conversation_id: PROVIDER_CONVERSATION_ID,
    title: 'MCP catalog import E2E fixture',
    create_time: createdAtSeconds,
    update_time: createdAtSeconds + 60,
    current_node: assistantId,
    mapping: {
      [rootId]: { id: rootId, message: null, parent: null, children: [userId] },
      [userId]: {
        id: userId,
        message: message(userId, 'user', 'Catalog import E2E prompt', createdAtSeconds),
        parent: rootId,
        children: [assistantId]
      },
      [assistantId]: {
        id: assistantId,
        message: message(assistantId, 'assistant', 'Catalog import E2E response', createdAtSeconds + 60),
        parent: userId,
        children: []
      }
    },
    is_archived: false
  };
}

async function writeFixtureArchive(stateDir) {
  const fixtureDir = path.join(stateDir, 'fixture');
  const archivePath = path.join(fixtureDir, 'chatgpt-export.zip');
  await fs.mkdir(fixtureDir, { mode: 0o700 });
  const bytes = buildZip([{
    name: 'conversations.json',
    data: Buffer.from(JSON.stringify([fixtureConversation()])),
    method: 'deflate'
  }]);
  await fs.writeFile(archivePath, bytes, { mode: 0o600, flag: 'wx' });
  return { archivePath, ...(await sha256File(archivePath)) };
}

function deterministicDialog(archivePath) {
  let requests = 0;
  return {
    get requestCount() {
      return requests;
    },
    async showOpenDialog() {
      requests += 1;
      return { canceled: false, filePaths: [archivePath] };
    }
  };
}

function createTabsFixture() {
  return {
    listTabs: () => [],
    ensureTab: async () => 'catalog-fixture-tab',
    createTab: async () => 'catalog-fixture-tab',
    closeTab: async () => true,
    getControllerById: () => ({})
  };
}

function createMcpConnection(stateDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoDir, 'mcp-server.mjs'), '--tool-profile', 'library'],
    cwd: repoDir,
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'agentify-mcp-catalog-import-e2e', version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  try {
    const result = await timeoutAfter(
      client.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      'e2e_catalog_import_call_timeout'
    );
    assert.notEqual(result?.isError, true, `${name}_returned_error`);
    return result?.structuredContent || {};
  } catch (error) {
    error.e2eMethod = name;
    throw error;
  }
}

async function requestGrant({ port, token }) {
  const response = await fetch(`http://127.0.0.1:${port}/catalog/export-grant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ profileScopeId: PROFILE_SCOPE_ID }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'granted');
  assert.equal(typeof data.grant?.grantId, 'string');
  return data.grant.grantId;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  activePhase = 'create-owned-state';
  const owned = await makeOwnedStateRoot();
  const evidenceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-catalog-import-evidence-')));
  await fs.chmod(evidenceDir, 0o700);
  let server = null;
  let grants = null;
  let connection = null;
  let cleanup = null;
  try {
    activePhase = 'create-fixture';
    const archive = await writeFixtureArchive(owned.stateDir);
    const dialog = deterministicDialog(archive.archivePath);
    grants = createElectronExportImportGrants({ dialog });
    const blobs = createPrivateLibraryBlobStore({ stateDir: owned.stateDir });
    const store = createConversationCatalogStore({
      stateDir: owned.stateDir,
      blobs,
      clock: () => FIXED_TIME,
      randomId: () => 'catalog-import-e2e'
    });
    const expectedIdentity = {
      provider: 'chatgpt',
      profileScopeId: PROFILE_SCOPE_ID,
      providerConversationId: PROVIDER_CONVERSATION_ID
    };
    const routeCalls = [];
    const catalogSync = createConversationCatalogService({
      store,
      blobs,
      grants,
      exportReader: createChatGptExportReader(),
      routeVerifier: {
        async verify(identity, key) {
          routeCalls.push({ identity, key });
          return {
            status: 'verified',
            identity,
            canonicalUrl: `https://chatgpt.com/c/${PROVIDER_CONVERSATION_ID}`,
            evidence: 'direct-navigation'
          };
        }
      },
      clock: () => FIXED_TIME
    });
    const token = crypto.randomBytes(24).toString('hex');
    const serverId = crypto.randomUUID();
    activePhase = 'start-http';
    server = await startHttpApi({
      port: 0,
      token,
      tabs: createTabsFixture(),
      defaultTabId: 'catalog-fixture-tab',
      serverId,
      stateDir: owned.stateDir,
      catalogSync,
      requestExportGrant: async ({ profileScopeId }) => await grants.request({ profileScopeId }),
      providerTabOperations: createProviderTabOperationLeases(),
      getStatus: async () => ({ ok: true, blocked: false })
    });
    const port = server.address().port;
    await writeToken(token, owned.stateDir);
    await writeState({ ok: true, port, pid: process.pid, serverId, startedAt: FIXED_TIME }, owned.stateDir);

    activePhase = 'connect-mcp';
    connection = createMcpConnection(owned.stateDir);
    await timeoutAfter(connection.client.connect(connection.transport), CALL_TIMEOUT_MS, 'e2e_catalog_import_connect_timeout');
    activePhase = 'list-tools';
    const tools = await connection.client.listTools();
    assert.equal(tools.tools.some(({ name }) => name === 'agentify_import_selected_chatgpt_export'), true);
    assert.equal(tools.tools.some(({ name }) => name === 'agentify_import_chatgpt_export'), true);
    assert.equal(tools.tools.some(({ name }) => name === 'agentify_verify_catalog_conversation'), true);

    activePhase = 'selected-import';
    const selectedImport = await callTool(connection.client, 'agentify_import_selected_chatgpt_export', {
      profileScopeId: PROFILE_SCOPE_ID
    });
    assert.equal(selectedImport.status, 'complete');
    activePhase = 'direct-grant';
    const directGrantId = await requestGrant({ port, token });
    activePhase = 'direct-import';
    const directImport = await callTool(connection.client, 'agentify_import_chatgpt_export', {
      grantId: directGrantId,
      profileScopeId: PROFILE_SCOPE_ID
    });
    assert.equal(directImport.status, 'complete');
    activePhase = 'verify-route';
    const verification = await callTool(connection.client, 'agentify_verify_catalog_conversation', {
      identity: expectedIdentity,
      key: VERIFY_KEY
    });
    assert.equal(verification.status, 'verified');
    assert.deepEqual(routeCalls, [{ identity: expectedIdentity, key: VERIFY_KEY }]);
    activePhase = 'read-catalog';
    const catalog = await callTool(connection.client, 'agentify_list_chatgpt_catalog', {
      profileScopeId: PROFILE_SCOPE_ID,
      limit: 10
    });
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.items[0].route.kind, 'verified');
    assert.equal(dialog.requestCount, 2);

    activePhase = 'close-mcp';
    await connection.client.close();
    connection = null;
    await closeServer(server);
    server = null;
    await grants.closeAll();
    grants = null;
    const mcpEntryPath = path.join(repoDir, 'mcp-server.mjs');
    const mcpEntry = await sha256File(mcpEntryPath);
    const [{ stdout: gitSha }, { stdout: gitStatus }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }),
      execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repoDir })
    ]);
    activePhase = 'cleanup-owned-state';
    cleanup = await cleanupOwnedStateRoot(owned);
    const receiptPath = path.join(evidenceDir, 'receipt.json');
    const receipt = {
      schemaVersion: 1,
      result: 'verified',
      journeyId: 'mcp-catalog-import-v1',
      checkpoint: 'verified-imported-route',
      command: ['node', 'scripts/e2e-mcp-catalog-import.mjs'],
      runtime: {
        entry: mcpEntryPath,
        entrySha256: mcpEntry.sha256,
        entryBytes: mcpEntry.byteLength,
        gitSha: gitSha.trim(),
        gitDirty: gitStatus.length > 0,
        mcpProfile: 'library'
      },
      fixture: {
        mode: 'contract-fixture',
        identity: 'real-zip/production-grant-reader-catalog-service/deterministic-dialog-and-route-v1',
        archiveSha256: archive.sha256,
        archiveBytes: archive.byteLength,
        nativePickerUsed: false,
        liveProviderNavigationUsed: false
      },
      assertions: {
        selectedImportComplete: true,
        directGrantImportComplete: true,
        exactRouteVerified: true,
        verifiedRoutePersisted: true,
        dialogRequests: dialog.requestCount,
        catalogRows: catalog.items.length
      },
      methods: [
        'agentify_import_selected_chatgpt_export',
        'agentify_import_chatgpt_export',
        'agentify_verify_catalog_conversation',
        'agentify_list_chatgpt_catalog'
      ],
      limitations: [
        'The native macOS picker remains unautomated.',
        'The remote ChatGPT route verifier is replaced at its production contract boundary.'
      ],
      cleanup,
      evidence: { receipt: receiptPath }
    };
    await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    activePhase = 'complete';
    return receipt;
  } finally {
    if (connection) await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
    if (server) await closeServer(server).catch(() => {});
    if (grants) await grants.closeAll().catch(() => {});
    if (cleanup === null) await cleanupOwnedStateRoot(owned).catch(() => {});
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
    error: String(error?.code || 'e2e_catalog_import_failed'),
    phase: activePhase,
    method
  })}\n`);
  process.exitCode = 1;
});
