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

import { readState, readToken } from '../state.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(scriptDir);
const execFileAsync = promisify(execFile);
const OWNED_STATE_MARKER = '.agentify-mcp-local-state-e2e.json';
const CALL_TIMEOUT_MS = 30_000;
const SAFE_ERROR_CODES = new Set([
  'e2e_local_state_failed',
  'e2e_local_state_call_timeout',
  'e2e_local_state_owned_root_invalid',
  'e2e_local_state_cleanup_invalid',
  'e2e_local_state_shutdown_timeout'
]);

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
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-local-state-')));
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
  const expectedPrefix = `${temporaryRoot}${path.sep}agentify-mcp-local-state-`;
  const realStateDir = await fs.realpath(owned.stateDir);
  const rootStat = await fs.lstat(realStateDir);
  const markerStat = await fs.lstat(owned.markerPath);
  if (
    realStateDir !== owned.stateDir ||
    !realStateDir.startsWith(expectedPrefix) ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    (markerStat.mode & 0o777) !== 0o600
  ) {
    throw runnerError('e2e_local_state_owned_root_invalid');
  }
  const marker = JSON.parse(await fs.readFile(owned.markerPath, 'utf8'));
  if (marker?.nonce !== owned.nonce || marker?.stateDir !== owned.stateDir) {
    throw runnerError('e2e_local_state_owned_root_invalid');
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
  throw runnerError('e2e_local_state_cleanup_invalid');
}

function createClient(stateDir, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoDir, 'mcp-server.mjs'), '--tool-profile', 'full'],
    cwd: repoDir,
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir },
    stderr: 'pipe'
  });
  const client = new Client({ name: label, version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}

async function connectClient(stateDir, label) {
  const connection = createClient(stateDir, label);
  await timeoutAfter(connection.client.connect(connection.transport), CALL_TIMEOUT_MS, 'e2e_local_state_call_timeout');
  return connection;
}

async function closeClient(connection) {
  if (!connection) return;
  await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
}

async function callTool(client, name, args = {}) {
  try {
    const result = await timeoutAfter(
      client.callTool({ name, arguments: args }),
      CALL_TIMEOUT_MS,
      'e2e_local_state_call_timeout'
    );
    assert.notEqual(result?.isError, true, `${name}_returned_error`);
    return result?.structuredContent || {};
  } catch (error) {
    error.e2eMethod = name;
    throw error;
  }
}

async function waitForHealthDown({ port }) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw runnerError('e2e_local_state_shutdown_timeout');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessDown(pid) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw runnerError('e2e_local_state_shutdown_timeout');
}

async function buildRuntimeEvidence() {
  const electronPackageDir = path.join(repoDir, 'node_modules', 'electron');
  const relativeBinary = (await fs.readFile(path.join(electronPackageDir, 'path.txt'), 'utf8')).trim();
  const binaryPath = await fs.realpath(path.join(electronPackageDir, 'dist', relativeBinary));
  const binary = await sha256File(binaryPath);
  return { binaryPath, ...binary };
}

async function writeReceipt(evidenceDir, receipt) {
  const receiptPath = path.join(evidenceDir, 'receipt.json');
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receiptPath;
}

async function main() {
  const owned = await makeOwnedStateRoot();
  const evidenceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-mcp-local-state-evidence-')));
  await fs.chmod(evidenceDir, 0o700);
  const fixtureDir = path.join(owned.stateDir, 'fixture-watch');
  const fixturePath = path.join(fixtureDir, 'sentinel.txt');
  const decoyDir = path.join(owned.stateDir, 'decoy-watch');
  const decoyPath = path.join(decoyDir, 'decoy.txt');
  const nonce = owned.nonce.slice(0, 8);
  const watchName = `e2e-watch-${nonce}`;
  const decoyWatchName = `e2e-watch-decoy-${nonce}`;
  const bundleName = `e2e-bundle-${nonce}`;
  const decoyBundleName = `e2e-bundle-decoy-${nonce}`;
  const promptPrefix = `LOCAL_STATE_E2E_${nonce}`;
  const decoyPromptPrefix = `LOCAL_STATE_E2E_DECOY_${nonce}`;
  let first = null;
  let second = null;
  let third = null;
  let cleanup = null;

  try {
    await fs.mkdir(fixtureDir, { mode: 0o700 });
    await fs.mkdir(decoyDir, { mode: 0o700 });
    await fs.writeFile(fixturePath, `sentinel-${nonce}\n`, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(decoyPath, `decoy-${nonce}\n`, { mode: 0o600, flag: 'wx' });
    first = await connectClient(owned.stateDir, 'agentify-mcp-local-state-e2e-1');

    const tools = await first.client.listTools();
    assert.equal(tools.tools.length, 47);

    const watchBefore = await callTool(first.client, 'agentify_list_watch_folders');
    assert.equal(watchBefore.folders.some(({ name }) => name === watchName), false);
    const added = await callTool(first.client, 'agentify_add_watch_folder', {
      name: watchName,
      folderPath: fixtureDir
    });
    assert.equal(added.folder?.name, watchName);
    assert.equal(added.folder?.path, await fs.realpath(fixtureDir));
    const addedDecoy = await callTool(first.client, 'agentify_add_watch_folder', {
      name: decoyWatchName,
      folderPath: decoyDir
    });
    assert.equal(addedDecoy.folder?.name, decoyWatchName);
    const watchAfter = await callTool(first.client, 'agentify_list_watch_folders');
    assert.equal(watchAfter.folders.filter(({ name }) => name === watchName).length, 1);
    assert.equal(watchAfter.folders.filter(({ name }) => name === decoyWatchName).length, 1);

    const firstScan = await callTool(first.client, 'agentify_scan_watch_folder');
    assert.equal(firstScan.ingested.filter(({ name }) => name === `${watchName}/sentinel.txt`).length, 1);
    assert.equal(firstScan.ingested.filter(({ name }) => name === `${decoyWatchName}/decoy.txt`).length, 1);
    const secondScan = await callTool(first.client, 'agentify_scan_watch_folder');
    assert.equal(secondScan.ingested.length, 0);
    await fs.appendFile(fixturePath, `mutation-${nonce}\n`);
    const thirdScan = await callTool(first.client, 'agentify_scan_watch_folder');
    assert.deepEqual(thirdScan.ingested.map(({ name }) => name), [`${watchName}/sentinel.txt`]);
    const openedWatch = await callTool(first.client, 'agentify_open_watch_folder', { name: watchName });
    assert.equal(openedWatch.folder?.name, watchName);

    const bundlesBefore = await callTool(first.client, 'agentify_list_bundles');
    assert.equal(bundlesBefore.bundles.some(({ name }) => name === bundleName), false);
    assert.equal(bundlesBefore.bundles.some(({ name }) => name === decoyBundleName), false);
    const savedDecoyBundle = await callTool(first.client, 'agentify_save_bundle', {
      name: decoyBundleName,
      promptPrefix: decoyPromptPrefix,
      contextPaths: [decoyPath]
    });
    assert.equal(savedDecoyBundle.bundle?.promptPrefix, decoyPromptPrefix);
    const savedBundle = await callTool(first.client, 'agentify_save_bundle', {
      name: bundleName,
      promptPrefix,
      contextPaths: [fixturePath]
    });
    assert.equal(savedBundle.bundle?.name, bundleName);
    assert.equal(savedBundle.bundle?.promptPrefix, promptPrefix);
    assert.deepEqual(savedBundle.bundle?.contextPaths, [await fs.realpath(fixturePath)]);
    const listedBundles = await callTool(first.client, 'agentify_list_bundles');
    assert.equal(listedBundles.bundles.filter(({ name }) => name === bundleName).length, 1);
    assert.equal(listedBundles.bundles.filter(({ name }) => name === decoyBundleName).length, 1);
    const loadedBundle = await callTool(first.client, 'agentify_get_bundle', { name: bundleName });
    assert.equal(loadedBundle.bundle?.promptPrefix, promptPrefix);

    const beforeRotationState = await readState(owned.stateDir);
    const oldToken = await readToken(owned.stateDir);
    assert.ok(beforeRotationState?.port);
    assert.ok(oldToken);
    await callTool(first.client, 'agentify_rotate_token');
    const oldTokenStatus = await fetch(`http://127.0.0.1:${beforeRotationState.port}/status`, {
      headers: { authorization: `Bearer ${oldToken}` }
    });
    assert.equal(oldTokenStatus.status, 401);
    await closeClient(first);
    first = null;

    second = await connectClient(owned.stateDir, 'agentify-mcp-local-state-e2e-2');
    const afterRotation = await callTool(second.client, 'agentify_list_bundles');
    assert.equal(afterRotation.bundles.some(({ name }) => name === bundleName), true);
    assert.equal(afterRotation.bundles.some(({ name }) => name === decoyBundleName), true);
    const beforeShutdownState = await readState(owned.stateDir);
    await callTool(second.client, 'agentify_shutdown');
    await waitForHealthDown(beforeShutdownState);
    await waitForProcessDown(beforeShutdownState.pid);
    await closeClient(second);
    second = null;

    third = await connectClient(owned.stateDir, 'agentify-mcp-local-state-e2e-3');
    const persistedBundle = await callTool(third.client, 'agentify_get_bundle', { name: bundleName });
    assert.equal(persistedBundle.bundle?.promptPrefix, promptPrefix);
    const afterRestartState = await readState(owned.stateDir);
    assert.notEqual(afterRestartState.serverId, beforeShutdownState.serverId);
    const persistedDecoyBundle = await callTool(third.client, 'agentify_get_bundle', { name: decoyBundleName });
    assert.equal(persistedDecoyBundle.bundle?.promptPrefix, decoyPromptPrefix);
    const deletedBundle = await callTool(third.client, 'agentify_delete_bundle', { name: bundleName });
    assert.equal(deletedBundle.deleted, true);
    const bundlesAfter = await callTool(third.client, 'agentify_list_bundles');
    assert.equal(bundlesAfter.bundles.some(({ name }) => name === bundleName), false);
    assert.equal(bundlesAfter.bundles.some(({ name }) => name === decoyBundleName), true);

    const removedWatch = await callTool(third.client, 'agentify_remove_watch_folder', { name: watchName });
    assert.equal(removedWatch.deleted, true);
    assert.equal((await fs.lstat(fixtureDir)).isDirectory(), true);
    const watchFinal = await callTool(third.client, 'agentify_list_watch_folders');
    assert.equal(watchFinal.folders.some(({ name }) => name === watchName), false);
    assert.equal(watchFinal.folders.some(({ name }) => name === decoyWatchName), true);
    await callTool(third.client, 'agentify_delete_bundle', { name: decoyBundleName });
    await callTool(third.client, 'agentify_remove_watch_folder', { name: decoyWatchName });
    await callTool(third.client, 'agentify_shutdown');
    await waitForHealthDown(afterRestartState);
    await waitForProcessDown(afterRestartState.pid);
    await closeClient(third);
    third = null;

    const runtime = await buildRuntimeEvidence();
    const [{ stdout: gitSha }, { stdout: gitStatus }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }),
      execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repoDir })
    ]);
    const receipt = {
      schemaVersion: 1,
      result: 'verified',
      journeyId: 'mcp-local-state-v1',
      checkpoint: 'token-rotation-and-electron-restart',
      command: ['node', 'scripts/e2e-mcp-local-state.mjs'],
      runtime: {
        binary: runtime.binaryPath,
        binarySha256: runtime.sha256,
        binaryBytes: runtime.byteLength,
        gitSha: gitSha.trim(),
        gitDirty: gitStatus.length > 0,
        mcpProfile: 'full',
        methodCount: tools.tools.length
      },
      fixture: {
        mode: 'run-owned-isolated-state',
        watchFileBytes: (await fs.lstat(fixturePath)).size
      },
      assertions: {
        watchFolderLifecycle: true,
        scanIngestedOnce: true,
        scanObservedMutation: true,
        watchFolderRemovalPreservedDecoy: true,
        watchFolderOpen: true,
        bundleLifecycle: true,
        bundlePersistedAcrossElectronRestart: true,
        bundleDeletionPreservedDecoy: true,
        removedWatchDirectoryRemainedOnDisk: true,
        oldTokenRejected: true,
        freshMcpConnectionAfterRotation: true,
        freshElectronServerAfterShutdown: true
      },
      methods: [
        'agentify_list_watch_folders',
        'agentify_add_watch_folder',
        'agentify_remove_watch_folder',
        'agentify_open_watch_folder',
        'agentify_scan_watch_folder',
        'agentify_save_bundle',
        'agentify_list_bundles',
        'agentify_get_bundle',
        'agentify_delete_bundle',
        'agentify_rotate_token',
        'agentify_shutdown'
      ],
      privacy: {
        personalStateUsed: false,
        providerDataUsed: false,
        tokenValuesPersistedOrPrinted: false
      },
      cleanup: 'pending'
    };

    cleanup = await cleanupOwnedStateRoot(owned);
    receipt.cleanup = cleanup;
    receipt.evidence = { receipt: path.join(evidenceDir, 'receipt.json') };
    const receiptPath = await writeReceipt(evidenceDir, receipt);
    return { ...receipt, evidence: { receipt: receiptPath } };
  } finally {
    await closeClient(first);
    await closeClient(second);
    await closeClient(third);
    if (cleanup === null) await cleanupOwnedStateRoot(owned).catch(() => {});
  }
}

main().then((receipt) => {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}).catch((error) => {
  const code = SAFE_ERROR_CODES.has(String(error?.code || ''))
    ? String(error.code)
    : 'e2e_local_state_failed';
  const method = /^agentify_[a-z_]+$/.test(String(error?.e2eMethod || ''))
    ? String(error.e2eMethod)
    : null;
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, result: 'product-fail', error: code, method })}\n`);
  process.exitCode = 1;
});
