#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { readState, readToken } from '../state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(__dirname);
const execFileAsync = promisify(execFile);
const PROFILE_SCOPE_ID = 'e2e-local';
const LIVE_IDENTITY = Object.freeze({
  provider: 'chatgpt',
  profileScopeId: PROFILE_SCOPE_ID,
  providerConversationId: 'local-live-fixture'
});
const IMPORTED_IDENTITY = Object.freeze({
  provider: 'chatgpt',
  profileScopeId: PROFILE_SCOPE_ID,
  providerConversationId: 'local-import-fixture'
});
const TRANSCRIPT_SENTINEL = 'E2E_PRIVATE_TRANSCRIPT_SENTINEL_DO_NOT_LOG';
const RAW_ARCHIVE_SENTINEL = 'E2E_PRIVATE_ARCHIVE_RECORD_SENTINEL_DO_NOT_LOG';
const PRIVATE_ARCHIVE_SENTINEL = '/PRIVATE-ARCHIVE-PATH.zip';
const PRIVATE_ARCHIVE_BASENAME = 'PRIVATE-ARCHIVE-PATH.zip';
const ALL_PRIVATE_MARKERS = Object.freeze([
  TRANSCRIPT_SENTINEL,
  RAW_ARCHIVE_SENTINEL,
  PRIVATE_ARCHIVE_BASENAME
]);
const OWNED_STATE_MARKER = '.agentify-transcript-e2e-owned.json';
const HTTP_TIMEOUT_MS = 8_000;
const CDP_TIMEOUT_MS = 8_000;
const REQUIRED_LIBRARY_TOOLS = Object.freeze([
  'agentify_import_selected_chatgpt_export',
  'agentify_import_chatgpt_export',
  'agentify_list_chatgpt_imports',
  'agentify_reassign_chatgpt_import',
  'agentify_verify_catalog_conversation',
  'agentify_list_chatgpt_catalog',
  'agentify_track_transcript',
  'agentify_sync_transcript',
  'agentify_list_transcripts',
  'agentify_get_transcript',
  'agentify_forget_transcript'
]);
const E2E_PHASES = Object.freeze([
  'preflight',
  'crash_fixture',
  'interrupted_launch',
  'interrupted_http',
  'interrupted_ui',
  'interrupted_shutdown',
  'resume_fixture',
  'completed_launch',
  'completed_http',
  'completed_ui',
  'completed_mcp',
  'completed_shutdown',
  'relaunch',
  'relaunch_http',
  'relaunch_ui',
  'relaunch_mcp',
  'forget_mcp',
  'relaunch_shutdown',
  'degraded_state_prepare',
  'degraded_launch',
  'degraded_observation',
  'degraded_shutdown',
  'degraded_state_restore'
]);
const SAFE_E2E_OUTPUT_ERROR_CODES = new Set([
  'e2e_failed',
  'e2e_monitor_stream_missing',
  'e2e_argument_missing',
  'e2e_argument_unknown',
  'e2e_launch_conflict',
  'e2e_state_dir_unsafe',
  'e2e_state_dir_not_empty',
  'e2e_cleanup_ownership_invalid',
  'e2e_cleanup_marker_invalid',
  'e2e_cleanup_incomplete',
  'e2e_fixture_blob_type_invalid',
  'e2e_fixture_failed',
  'e2e_control_center_heading_missing',
  'e2e_control_center_imports_ax_node_missing',
  'e2e_control_center_imports_heading_ignored',
  'e2e_control_center_imports_heading_role_invalid',
  'e2e_control_center_imports_heading_name_invalid',
  'e2e_control_center_sources_heading_missing',
  'e2e_control_center_catalog_heading_missing',
  'e2e_control_center_imports_list_missing',
  'e2e_control_center_sources_list_missing',
  'e2e_control_center_catalog_list_missing',
  'e2e_control_center_listitem_missing',
  'e2e_recovery_health_failed',
  'e2e_recovery_auth_failed',
  'e2e_recovery_live_state_failed',
  'e2e_recovery_catalog_visibility_failed',
  'e2e_recovery_transcript_read_failed',
  'e2e_binary_invalid',
  'e2e_result_missing',
  'http_request_timeout',
  'http_response_invalid',
  'electron_process_exited',
  'electron_start_timeout',
  'electron_app_pid_still_alive',
  'cdp_start_timeout',
  'cdp_connect_failed',
  'cdp_protocol_error',
  'cdp_closed',
  'cdp_not_connected',
  'cdp_call_timeout',
  'cdp_evaluate_failed',
  'control_center_target_missing',
  'control_center_render_timeout',
  'control_center_library_event_timeout',
  'mcp_stdout_missing',
  'mcp_process_missing',
  ...E2E_PHASES.map((phase) => `e2e_${phase}_failed`)
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

function createSentinelMonitor(label, {
  forbiddenMarkers = ALL_PRIVATE_MARKERS,
  expectedMarkers = []
} = {}) {
  const monitoredMarkers = [...new Set([...forbiddenMarkers, ...expectedMarkers])];
  const tailLimit = Math.max(...monitoredMarkers.map((marker) => marker.length)) - 1;
  let tail = '';
  let byteCount = 0;
  let violation = null;
  let streamCount = 0;
  const observedExpected = new Set();

  function scan(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.length;
    const combined = `${tail}${bytes.toString('utf8')}`;
    if (forbiddenMarkers.some((marker) => combined.includes(marker))) {
      violation = 'private_process_output';
    }
    for (const marker of expectedMarkers) {
      if (combined.includes(marker)) observedExpected.add(marker);
    }
    tail = combined.slice(-tailLimit);
  }

  function attach(stream) {
    if (!stream || typeof stream.on !== 'function') throw runnerError('e2e_monitor_stream_missing');
    streamCount += 1;
    stream.on('data', scan);
  }

  function assertClean() {
    assert.equal(violation, null, `${label}_private_output`);
    assert.equal(observedExpected.size, expectedMarkers.length, `${label}_expected_output_missing`);
  }

  function summary() {
    return Object.freeze({
      label,
      streams: streamCount,
      bytesScanned: byteCount,
      clean: violation === null,
      expectedMarkerObserved: expectedMarkers.length === 0 ? null : observedExpected.size === expectedMarkers.length
    });
  }

  return Object.freeze({ attach, assertClean, summary });
}

function safeErrorCode(error) {
  const code = String(error?.code || '').trim().toLowerCase();
  return SAFE_E2E_OUTPUT_ERROR_CODES.has(code) ? code : 'e2e_failed';
}

function parseArgs(argv) {
  const options = {
    keepState: false,
    stateDir: null,
    electron: null,
    packagedApp: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep-state') {
      options.keepState = true;
      continue;
    }
    if (['--state-dir', '--electron', '--packaged-app'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw runnerError('e2e_argument_missing');
      options[arg === '--state-dir' ? 'stateDir' : arg === '--electron' ? 'electron' : 'packagedApp'] = value;
      index += 1;
      continue;
    }
    throw runnerError('e2e_argument_unknown');
  }
  if (options.electron && options.packagedApp) throw runnerError('e2e_launch_conflict');
  return options;
}

async function makeStateDir(requestedPath) {
  const nonce = crypto.randomUUID();
  if (!requestedPath) {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-transcript-e2e-'));
    await fs.chmod(created, 0o700);
    const stateDir = await fs.realpath(created);
    const markerPath = path.join(stateDir, OWNED_STATE_MARKER);
    await fs.writeFile(markerPath, `${JSON.stringify({ schemaVersion: 1, nonce, realpath: stateDir })}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    return { stateDir, owned: true, nonce, markerPath };
  }
  const stateDir = path.resolve(requestedPath);
  const root = path.parse(stateDir).root;
  if (stateDir === root || stateDir === os.homedir()) throw runnerError('e2e_state_dir_unsafe');
  try {
    const entries = await fs.readdir(stateDir);
    if (entries.length) throw runnerError('e2e_state_dir_not_empty');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(stateDir, { recursive: false, mode: 0o700 });
  }
  await fs.chmod(stateDir, 0o700);
  return { stateDir: await fs.realpath(stateDir), owned: false, nonce: null, markerPath: null };
}

async function makeEvidenceDir() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-transcript-e2e-evidence-'));
  await fs.chmod(created, 0o700);
  return await fs.realpath(created);
}

async function cleanupOwnedState(state, keepState) {
  if (!state.owned) return 'caller-owned-state-retained';
  if (keepState) return 'owned-state-retained-by-request';
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const expectedPrefix = `${temporaryRoot}${path.sep}agentify-transcript-e2e-`;
  const rootStat = await fs.lstat(state.stateDir);
  if (
    rootStat.isSymbolicLink() || !rootStat.isDirectory() ||
    (rootStat.mode & 0o777) !== 0o700 ||
    !state.stateDir.startsWith(expectedPrefix) ||
    await fs.realpath(state.stateDir) !== state.stateDir
  ) {
    throw runnerError('e2e_cleanup_ownership_invalid');
  }
  const markerStat = await fs.lstat(state.markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || (markerStat.mode & 0o777) !== 0o600) {
    throw runnerError('e2e_cleanup_marker_invalid');
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(state.markerPath, 'utf8'));
  } catch {
    throw runnerError('e2e_cleanup_marker_invalid');
  }
  if (
    marker?.schemaVersion !== 1 || marker?.nonce !== state.nonce || marker?.realpath !== state.stateDir ||
    Object.keys(marker).sort().join(',') !== 'nonce,realpath,schemaVersion'
  ) {
    throw runnerError('e2e_cleanup_marker_invalid');
  }
  await fs.rm(state.stateDir, { recursive: true, force: false });
  try {
    await fs.lstat(state.stateDir);
    throw runnerError('e2e_cleanup_incomplete');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return 'owned-state-removed';
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100, code = 'e2e_wait_timeout' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw runnerError(code);
}

async function timedFetch(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw runnerError('http_request_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function countRegularFiles(root) {
  let count = 0;
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) count += 1;
      else throw runnerError('e2e_fixture_blob_type_invalid');
    }
  }
  await visit(root);
  return count;
}

async function runCrashFixture(stateDir) {
  const childPath = path.join(repoDir, 'tests', 'fixtures', 'transcript-library-crash-child.mjs');
  const monitor = createSentinelMonitor('crash-fixture');
  const child = spawn(process.execPath, [childPath, stateDir, 'crash'], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  monitor.attach(child.stdout);
  monitor.attach(child.stderr);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.event === 'post-blob-pre-catalog-commit') resolve(message);
      if (message?.event === 'fixture-failed') reject(runnerError(message.code || 'e2e_fixture_failed'));
    });
  });
  let checkpoint;
  try {
    checkpoint = await timeoutAfter(ready, 60_000, 'e2e_fixture_checkpoint_timeout');
  } catch (error) {
    child.kill('SIGKILL');
    await closed.catch(() => {});
    throw error;
  }
  assert.equal(checkpoint.stagedRecords, 64);
  assert.equal(checkpoint.nextRecordIndex, 64);
  const rawFiles = await countRegularFiles(path.join(stateDir, 'transcript-library', 'blobs', 'raw'));
  const snapshotFiles = await countRegularFiles(path.join(stateDir, 'transcript-library', 'blobs', 'snapshot'));
  assert.equal(rawFiles >= 64, true);
  assert.equal(snapshotFiles >= 66, true);
  assert.equal(child.kill('SIGKILL'), true);
  const result = await timeoutAfter(closed, 10_000, 'e2e_fixture_kill_timeout');
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  monitor.assertClean();
  return {
    checkpoint: 'post-blob-pre-catalog-commit',
    stagedRawFiles: rawFiles,
    stagedSnapshotFiles: snapshotFiles,
    exit: result,
    output: monitor.summary()
  };
}

async function runResumeFixture(stateDir) {
  const childPath = path.join(repoDir, 'tests', 'fixtures', 'transcript-library-crash-child.mjs');
  const monitor = createSentinelMonitor('resume-fixture');
  const child = spawn(process.execPath, [childPath, stateDir, 'resume'], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  monitor.attach(child.stdout);
  monitor.attach(child.stderr);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const completed = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.event === 'resume-complete') resolve(message);
      if (message?.event === 'fixture-failed') reject(runnerError(message.code || 'e2e_fixture_failed'));
    });
  });
  let receipt;
  try {
    receipt = await timeoutAfter(completed, 90_000, 'e2e_fixture_resume_timeout');
  } catch (error) {
    child.kill('SIGKILL');
    await closed.catch(() => {});
    throw error;
  }
  const exit = await timeoutAfter(closed, 10_000, 'e2e_fixture_resume_exit_timeout');
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual({
    firstStatus: receipt.firstStatus,
    replayStatus: receipt.replayStatus,
    importCount: receipt.importCount,
    catalogCount: receipt.catalogCount,
    cursorRecordIndex: receipt.cursorRecordIndex,
    stableSnapshot: receipt.stableSnapshot
  }, {
    firstStatus: 'complete',
    replayStatus: 'complete',
    importCount: 1,
    catalogCount: 64,
    cursorRecordIndex: 64,
    stableSnapshot: true
  });
  monitor.assertClean();
  return { ...receipt, exit, output: monitor.summary() };
}

function resolveLaunch(options) {
  if (options.packagedApp) {
    const appPath = path.resolve(options.packagedApp);
    const executable = process.platform === 'darwin'
      ? path.join(appPath, 'Contents', 'MacOS', 'Agentify Desktop')
      : appPath;
    return { executable, appArgs: [], kind: 'packaged' };
  }
  return {
    executable: path.resolve(options.electron || path.join(repoDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')),
    appArgs: [path.join(repoDir, 'main.mjs')],
    kind: 'development',
    usesBundledElectron: !options.electron
  };
}

async function launchElectron({ launch, stateDir }) {
  await fs.access(launch.executable);
  const debugPort = await reservePort();
  const args = [
    `--remote-debugging-port=${debugPort}`,
    ...launch.appArgs,
    '--state-dir', stateDir,
    '--port', '0',
    '--start-minimized'
  ];
  const child = spawn(launch.executable, args, {
    cwd: repoDir,
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const monitor = createSentinelMonitor('electron');
  monitor.attach(child.stdout);
  monitor.attach(child.stderr);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    const connection = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw runnerError('electron_process_exited');
      const state = await readState(stateDir);
      const token = await readToken(stateDir);
      if (!state?.port || !state?.pid || !state?.serverId || !token) return null;
      const response = await timedFetch(`http://127.0.0.1:${state.port}/health`, {}, 2_000);
      const body = await response.json();
      return response.ok && body?.serverId === state.serverId
        ? { baseUrl: `http://127.0.0.1:${state.port}`, token, state }
        : null;
    }, { timeoutMs: 45_000, code: 'electron_start_timeout' });

    await waitFor(async () => {
      const response = await timedFetch(`http://127.0.0.1:${debugPort}/json/list`, {}, 2_000);
      return response.ok;
    }, { timeoutMs: 20_000, code: 'cdp_start_timeout' });

    return {
      child,
      closed,
      appPid: connection.state.pid,
      debugPort,
      connection,
      monitor,
      sessionId: crypto.randomUUID()
    };
  } catch (error) {
    const published = await readState(stateDir).catch(() => null);
    if (Number.isSafeInteger(published?.pid) && published.pid > 1) {
      try {
        process.kill(published.pid, 'SIGTERM');
      } catch {}
    }
    try {
      child.kill('SIGTERM');
    } catch {}
    await Promise.race([closed.catch(() => null), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    throw error;
  }
}

async function httpJson(connection, requestPath, { method = 'GET', body, authenticated = true } = {}) {
  const headers = { accept: 'application/json' };
  if (authenticated) headers.authorization = `Bearer ${connection.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await timedFetch(`${connection.baseUrl}${requestPath}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }, HTTP_TIMEOUT_MS);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw runnerError('http_response_invalid');
  }
  return { status: response.status, data };
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await timeoutAfter(new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(runnerError('cdp_connect_failed')), { once: true });
    }), CDP_TIMEOUT_MS, 'cdp_connect_timeout');
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(runnerError('cdp_protocol_error'));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(runnerError('cdp_closed'));
      }
      this.pending.clear();
    });
  }

  async call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw runnerError('cdp_not_connected');
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(runnerError('cdp_call_timeout'));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await result;
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw runnerError('cdp_evaluate_failed');
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

async function connectControlCenter(debugPort) {
  const target = await waitFor(async () => {
    const response = await timedFetch(`http://127.0.0.1:${debugPort}/json/list`, {}, 2_000);
    const targets = await response.json();
    return targets.find((candidate) =>
      candidate.type === 'page' && String(candidate.url || '').includes('/ui/control-center.html')) || null;
  }, { timeoutMs: 20_000, code: 'control_center_target_missing' });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

async function inspectAccessibleSelector(cdp, documentNodeId, selector) {
  const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: documentNodeId, selector });
  if (!nodeId) return null;
  const { node } = await cdp.call('DOM.describeNode', { nodeId });
  const tree = await cdp.call('Accessibility.getPartialAXTree', {
    backendNodeId: node.backendNodeId,
    fetchRelatives: false
  });
  const target = tree.nodes.find((candidate) => candidate.backendDOMNodeId === node.backendNodeId) || null;
  return target
    ? {
        ignored: target.ignored === true,
        name: target.name?.value ?? null,
        role: target.role?.value ?? null
      }
    : null;
}

async function exerciseControlCenter(debugPort, stateDir, {
  expectedImportStatus,
  expectedImportSuspension,
  expectedImportCursor,
  expectedCatalogCount,
  screenshotPath = null
}) {
  const cdp = await connectControlCenter(debugPort);
  try {
    await cdp.call('Page.enable');
    await cdp.call('DOM.enable');
    await cdp.call('Accessibility.enable');
    const driverVersion = await cdp.call('Browser.getVersion');
    const bridge = await cdp.evaluate(`(async () => {
      const api = window.agentifyDesktop;
      const state = await api.getState();
      const imports = await api.getCatalogImports();
      const sources = await api.getTranscriptSources();
      const catalog = await api.getCatalog({ profileScopeId: ${JSON.stringify(PROFILE_SCOPE_ID)}, limit: 100 });
      let arbitraryPathError = '';
      try {
        await api.importChatGptExport({ path: ${JSON.stringify(PRIVATE_ARCHIVE_SENTINEL)}, profileScopeId: ${JSON.stringify(PROFILE_SCOPE_ID)} });
      } catch (error) {
        arbitraryPathError = String(error?.message || error);
      }
      return {
        methods: Object.keys(api).sort(),
        stateDir: state.stateDir,
        importStatus: imports[0]?.status || null,
        importSuspension: imports[0]?.suspension?.reason || null,
        importCursor: imports[0]?.cursor?.recordIndex ?? null,
        sourceState: sources[0]?.state || null,
        catalogCount: catalog.items?.length || 0,
        arbitraryPathError,
        arbitraryPathReflected: arbitraryPathError.includes(${JSON.stringify(PRIVATE_ARCHIVE_SENTINEL)})
      };
    })()`);
    assert.equal(bridge.stateDir, stateDir);
    for (const method of [
      'requestExportGrant', 'importChatGptExport', 'getCatalog', 'getCatalogImports',
      'getTranscriptSources', 'syncTranscript', 'forgetTranscript',
      'verifyCatalogConversation', 'reassignCatalogImport'
    ]) assert.equal(bridge.methods.includes(method), true);
    assert.equal(bridge.importStatus, expectedImportStatus);
    assert.equal(bridge.importSuspension, expectedImportSuspension);
    assert.equal(bridge.importCursor, expectedImportCursor);
    assert.equal(bridge.sourceState, 'interrupted');
    assert.equal(bridge.catalogCount, expectedCatalogCount);
    assert.match(bridge.arbitraryPathError, /catalog_import_request_invalid/);
    assert.equal(bridge.arbitraryPathReflected, false);

    await cdp.evaluate(`(() => {
      const input = document.getElementById('libraryProfileScope');
      input.value = ${JSON.stringify(PROFILE_SCOPE_ID)};
      input.dispatchEvent(new Event('change'));
      return true;
    })()`);
    const rendered = await waitFor(async () => {
      const value = await cdp.evaluate(`(() => ({
        imports: document.getElementById('libraryImportsList')?.children.length || 0,
        catalog: document.getElementById('libraryCatalogList')?.children.length || 0,
        sources: document.getElementById('librarySourcesList')?.children.length || 0,
        bodyText: document.getElementById('transcriptLibraryCard')?.innerText || ''
      }))()`);
      return value.imports === 1 && value.catalog === expectedCatalogCount && value.sources === 1 ? value : null;
    }, { timeoutMs: 10_000, code: 'control_center_render_timeout' });
    assert.equal(rendered.bodyText.includes(TRANSCRIPT_SENTINEL), false);
    assert.equal(rendered.bodyText.includes(RAW_ARCHIVE_SENTINEL), false);
    assert.equal(rendered.bodyText.includes(PRIVATE_ARCHIVE_BASENAME), false);

    const geometry = await cdp.evaluate(`(() => {
      const card = document.getElementById('transcriptLibraryCard');
      card.scrollIntoView({ block: 'start', inline: 'nearest' });
      const rect = card.getBoundingClientRect();
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scale: window.devicePixelRatio
        },
        card: {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          clientWidth: card.clientWidth,
          scrollWidth: card.scrollWidth
        },
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth
      };
    })()`);
    assert.equal(geometry.viewport.width > 0, true);
    assert.equal(geometry.viewport.height > 0, true);
    assert.equal(geometry.viewport.scale > 0, true);
    assert.equal(geometry.card.left >= 0, true);
    assert.equal(geometry.card.right <= geometry.viewport.width + 1, true);
    assert.equal(geometry.card.scrollWidth <= geometry.card.clientWidth + 1, true);
    assert.equal(geometry.documentScrollWidth <= geometry.documentClientWidth + 1, true);

    const { root } = await cdp.call('DOM.getDocument', { depth: 0 });
    const semanticTargets = await Promise.all([
      inspectAccessibleSelector(cdp, root.nodeId, '#transcriptLibraryCard > .cardTitle'),
      inspectAccessibleSelector(cdp, root.nodeId, '#libraryImportsHeading'),
      inspectAccessibleSelector(cdp, root.nodeId, '#librarySourcesHeading'),
      inspectAccessibleSelector(cdp, root.nodeId, '#libraryCatalogHeading'),
      inspectAccessibleSelector(cdp, root.nodeId, '#libraryImportsList'),
      inspectAccessibleSelector(cdp, root.nodeId, '#librarySourcesList'),
      inspectAccessibleSelector(cdp, root.nodeId, '#libraryCatalogList'),
      inspectAccessibleSelector(cdp, root.nodeId, '#transcriptLibraryCard [role="listitem"]')
    ]);
    const [libraryHeading, importsHeading, sourcesHeading, catalogHeading,
      importsList, sourcesList, catalogList, firstListItem] = semanticTargets;
    const transcriptHeading = libraryHeading?.role === 'heading' && libraryHeading.name === 'Transcript Library';
    const subsectionHeadings = importsHeading?.role === 'heading' && importsHeading.name === 'IMPORTS' &&
      sourcesHeading?.role === 'heading' && sourcesHeading.name === 'TRACKED LIVE SOURCES' &&
      catalogHeading?.role === 'heading' && catalogHeading.name === 'CATALOG';
    const namedLists = importsList?.role === 'list' && importsList.name === 'IMPORTS' &&
      sourcesList?.role === 'list' && sourcesList.name === 'TRACKED LIVE SOURCES' &&
      catalogList?.role === 'list' && catalogList.name === 'CATALOG';
    const listItems = firstListItem?.role === 'listitem' && !firstListItem.ignored ? 1 : 0;
    if (!transcriptHeading) throw runnerError('e2e_control_center_heading_missing');
    if (!importsHeading) throw runnerError('e2e_control_center_imports_ax_node_missing');
    if (importsHeading.ignored) throw runnerError('e2e_control_center_imports_heading_ignored');
    if (importsHeading.role !== 'heading') throw runnerError('e2e_control_center_imports_heading_role_invalid');
    if (importsHeading.name !== 'IMPORTS') throw runnerError('e2e_control_center_imports_heading_name_invalid');
    if (sourcesHeading?.role !== 'heading' || sourcesHeading.name !== 'TRACKED LIVE SOURCES') {
      throw runnerError('e2e_control_center_sources_heading_missing');
    }
    if (catalogHeading?.role !== 'heading' || catalogHeading.name !== 'CATALOG') {
      throw runnerError('e2e_control_center_catalog_heading_missing');
    }
    if (importsList?.role !== 'list' || importsList.name !== 'IMPORTS') {
      throw runnerError('e2e_control_center_imports_list_missing');
    }
    if (sourcesList?.role !== 'list' || sourcesList.name !== 'TRACKED LIVE SOURCES') {
      throw runnerError('e2e_control_center_sources_list_missing');
    }
    if (catalogList?.role !== 'list' || catalogList.name !== 'CATALOG') {
      throw runnerError('e2e_control_center_catalog_list_missing');
    }
    if (listItems < 1) throw runnerError('e2e_control_center_listitem_missing');

    let screenshot = null;
    if (screenshotPath) {
      const capture = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: 0,
          y: 0,
          width: geometry.viewport.width,
          height: Math.max(1, geometry.viewport.height - 88),
          scale: 1
        }
      });
      const bytes = Buffer.from(capture.data, 'base64');
      assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
      await fs.writeFile(screenshotPath, bytes, { mode: 0o600, flag: 'wx' });
      const stat = await fs.lstat(screenshotPath);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.mode & 0o777, 0o600);
      screenshot = {
        path: screenshotPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      };
    }
    return {
      geometry,
      accessibility: { transcriptHeading, subsectionHeadings, namedLists, listItems },
      screenshot,
      driver: {
        name: 'Electron DevTools Protocol',
        product: driverVersion.product,
        protocolVersion: driverVersion.protocolVersion,
        userAgent: driverVersion.userAgent
      }
    };
  } finally {
    cdp.close();
  }
}

async function observeControlCenterSourceCount(debugPort, expectedCount, { screenshotPath = null } = {}) {
  const cdp = await connectControlCenter(debugPort);
  try {
    await cdp.call('Page.enable');
    const state = await waitFor(async () => {
      const state = await cdp.evaluate(`(() => ({
        count: document.getElementById('librarySourcesList')?.children.length ?? -1,
        emptyVisible: document.getElementById('librarySourcesEmpty')?.style.display !== 'none'
      }))()`);
      return state.count === expectedCount && state.emptyVisible === (expectedCount === 0) ? state : null;
    }, { timeoutMs: 10_000, code: 'control_center_library_event_timeout' });
    if (!screenshotPath) return state;
    const geometry = await cdp.evaluate(`(() => {
      const empty = document.getElementById('librarySourcesEmpty');
      const card = document.getElementById('transcriptLibraryCard');
      empty.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = card.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
        card: { left: rect.left, right: rect.right, clientWidth: card.clientWidth, scrollWidth: card.scrollWidth },
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth
      };
    })()`);
    assert.equal(geometry.card.left >= 0, true);
    assert.equal(geometry.card.right <= geometry.viewport.width + 1, true);
    assert.equal(geometry.card.scrollWidth <= geometry.card.clientWidth + 1, true);
    assert.equal(geometry.documentScrollWidth <= geometry.documentClientWidth + 1, true);
    const capture = await cdp.call('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        width: geometry.viewport.width,
        height: Math.max(1, geometry.viewport.height - 88),
        scale: 1
      }
    });
    const bytes = Buffer.from(capture.data, 'base64');
    assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
    await fs.writeFile(screenshotPath, bytes, { mode: 0o600, flag: 'wx' });
    const stat = await fs.lstat(screenshotPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o600);
    return {
      ...state,
      geometry,
      screenshot: {
        path: screenshotPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      }
    };
  } finally {
    cdp.close();
  }
}

function assertCitationPage(page, identity, expectedStart) {
  assert.equal(page.schemaVersion, 1);
  assert.deepEqual(page.identity, identity);
  assert.equal(page.startOrdinal, expectedStart);
  assert.equal(page.structuredTurns.length, page.citations.length);
  assert.equal(page.structuredTurns.length > 0, true);
  for (let index = 0; index < page.structuredTurns.length; index += 1) {
    assert.deepEqual(page.citations[index], {
      identity: `chatgpt/${identity.profileScopeId}/${identity.providerConversationId}`,
      snapshotHash: page.snapshot.hash,
      turnId: page.structuredTurns[index].turnId
    });
  }
}

async function exerciseRecoveryHttp(connection) {
  const health = await httpJson(connection, '/health', { authenticated: false });
  if (health.status !== 200 || health.data.serverId !== connection.state.serverId) {
    throw runnerError('e2e_recovery_health_failed');
  }
  const unauthorized = await httpJson(connection, '/status', { authenticated: false });
  if (unauthorized.status !== 401 || unauthorized.data?.error !== 'unauthorized') {
    throw runnerError('e2e_recovery_auth_failed');
  }
  const sources = await httpJson(connection, '/transcripts/list');
  if (
    sources.status !== 200 || sources.data.length !== 1 ||
    sources.data[0].state !== 'interrupted' || !sources.data[0].latestLiveSnapshot
  ) {
    throw runnerError('e2e_recovery_live_state_failed');
  }
  const catalog = await httpJson(connection, `/catalog/list?profileScopeId=${PROFILE_SCOPE_ID}&limit=100`);
  if (
    catalog.status !== 200 || catalog.data?.items?.length !== 0 || catalog.data?.nextCursor !== null
  ) {
    throw runnerError('e2e_recovery_catalog_visibility_failed');
  }
  const first = await httpJson(connection, '/transcripts/get', {
    method: 'POST',
    body: { identity: LIVE_IDENTITY, limit: 1 }
  });
  if (first.status !== 200) throw runnerError('e2e_recovery_transcript_read_failed');
  assertCitationPage(first.data, LIVE_IDENTITY, 0);
  return {
    liveSnapshotHash: first.data.snapshot.hash,
    liveContentHash: first.data.snapshot.contentHash
  };
}

async function exerciseDegradedLibraryStartup(runtime) {
  const health = await httpJson(runtime.connection, '/health', { authenticated: false });
  assert.equal(health.status, 200);
  assert.equal(health.data.serverId, runtime.connection.state.serverId);

  const tabs = await httpJson(runtime.connection, '/tabs');
  assert.equal(tabs.status, 200);
  assert.equal(tabs.data.ok, true);
  assert.equal(Array.isArray(tabs.data.tabs), true);
  assert.equal(tabs.data.tabs.length > 0, true);
  assert.equal(tabs.data.tabs.some(({ id }) => id === tabs.data.defaultTabId), true);

  const unavailable = await httpJson(runtime.connection, '/transcripts/list');
  assert.deepEqual(unavailable, {
    status: 500,
    data: { error: 'transcript_store_corrupt_state' }
  });

  const cdp = await connectControlCenter(runtime.debugPort);
  try {
    const bridge = await cdp.evaluate(`(async () => {
      const state = await window.agentifyDesktop.getState();
      return {
        bridgeAvailable: typeof window.agentifyDesktop.getTranscriptSources === 'function',
        transcriptStartup: state.libraryStartup?.transcripts || null,
        catalogStartup: state.libraryStartup?.catalog || null,
        ordinaryTabCount: Array.isArray(state.tabs) ? state.tabs.length : 0,
        defaultTabPresent: Array.isArray(state.tabs) && state.tabs.some(({ id }) => id === state.defaultTabId)
      };
    })()`);
    assert.equal(bridge.bridgeAvailable, true);
    assert.deepEqual(bridge.transcriptStartup, {
      status: 'unavailable',
      code: 'transcript_store_corrupt_state'
    });
    assert.equal(bridge.catalogStartup?.status, 'ready');
    assert.equal(bridge.ordinaryTabCount > 0, true);
    assert.equal(bridge.defaultTabPresent, true);
    return {
      health: true,
      authenticatedTabs: true,
      controlCenterPreload: true,
      transcriptStartup: bridge.transcriptStartup,
      catalogStartup: bridge.catalogStartup.status,
      safeLibraryError: unavailable.data.error
    };
  } finally {
    cdp.close();
  }
}

async function exerciseHttp(connection) {
  const health = await httpJson(connection, '/health', { authenticated: false });
  assert.equal(health.status, 200);
  assert.equal(health.data.serverId, connection.state.serverId);
  const unauthorized = await httpJson(connection, '/status', { authenticated: false });
  assert.deepEqual(unauthorized, { status: 401, data: { error: 'unauthorized' } });
  const status = await httpJson(connection, '/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.ok, true);

  const malformedImport = await httpJson(connection, '/catalog/import', {
    method: 'POST',
    body: { path: PRIVATE_ARCHIVE_SENTINEL, profileScopeId: PROFILE_SCOPE_ID }
  });
  assert.equal(malformedImport.status, 400);
  assert.equal(JSON.stringify(malformedImport.data).includes(PRIVATE_ARCHIVE_SENTINEL), false);

  const sources = await httpJson(connection, '/transcripts/list');
  assert.equal(sources.status, 200);
  assert.equal(sources.data.length, 1);
  assert.equal(sources.data[0].state, 'interrupted');
  assert.ok(sources.data[0].latestLiveSnapshot);

  const first = await httpJson(connection, '/transcripts/get', {
    method: 'POST',
    body: { identity: LIVE_IDENTITY, limit: 1 }
  });
  assert.equal(first.status, 200);
  assertCitationPage(first.data, LIVE_IDENTITY, 0);
  assert.ok(first.data.nextCursor);
  const second = await httpJson(connection, '/transcripts/get', {
    method: 'POST',
    body: {
      identity: LIVE_IDENTITY,
      snapshot: first.data.snapshot,
      cursor: first.data.nextCursor,
      limit: 2
    }
  });
  assert.equal(second.status, 200);
  assertCitationPage(second.data, LIVE_IDENTITY, 1);
  assert.equal(second.data.nextCursor, null);
  assert.equal(second.data.snapshot.hash, first.data.snapshot.hash);
  assert.equal(
    [...first.data.structuredTurns, ...second.data.structuredTurns]
      .some(({ text }) => String(text).includes(TRANSCRIPT_SENTINEL)),
    true
  );

  const catalog = await httpJson(connection, `/catalog/list?profileScopeId=${PROFILE_SCOPE_ID}&limit=100`);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.items.length, 64);
  const importedCatalogEntry = catalog.data.items.find(({ identity }) =>
    identity.provider === IMPORTED_IDENTITY.provider &&
    identity.profileScopeId === IMPORTED_IDENTITY.profileScopeId &&
    identity.providerConversationId === IMPORTED_IDENTITY.providerConversationId);
  assert.ok(importedCatalogEntry);
  assert.equal(importedCatalogEntry.route.kind, 'unverified');
  assert.ok(importedCatalogEntry.latestImportedSnapshot);

  const imported = await httpJson(connection, '/transcripts/get', {
    method: 'POST',
    body: { identity: IMPORTED_IDENTITY, limit: 2 }
  });
  assert.equal(imported.status, 200);
  assertCitationPage(imported.data, IMPORTED_IDENTITY, 0);
  assert.equal(imported.data.sourceKey, null);
  assert.equal(imported.data.conversationUrl, null);
  assert.equal(imported.data.structuredTurns.some(({ text }) => String(text).includes(TRANSCRIPT_SENTINEL)), true);

  return {
    liveSnapshotHash: first.data.snapshot.hash,
    liveContentHash: first.data.snapshot.contentHash,
    importedSnapshotHash: imported.data.snapshot.hash
  };
}

class MonitoredStdioClientTransport extends StdioClientTransport {
  constructor(server, { stdoutMonitor, stderrMonitor }) {
    super(server);
    this.stdoutMonitor = stdoutMonitor;
    this.stderrMonitor = stderrMonitor;
    this.closedReceipt = null;
    this.stderrMonitor.attach(this.stderr);
  }

  async start() {
    await super.start();
    const child = this._process;
    if (!child?.stdout) throw runnerError('mcp_stdout_missing');
    this.stdoutMonitor.attach(child.stdout);
    this.closedReceipt = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  }

  async assertCleanExit() {
    if (!this.closedReceipt) throw runnerError('mcp_process_missing');
    const exit = await timeoutAfter(this.closedReceipt, 8_000, 'mcp_exit_timeout');
    assert.deepEqual(exit, { code: 0, signal: null });
    this.stdoutMonitor.assertClean();
    this.stderrMonitor.assertClean();
    return {
      exit,
      output: {
        stdout: this.stdoutMonitor.summary(),
        stderr: this.stderrMonitor.summary()
      }
    };
  }
}

function mcpTransport(stateDir, label, { expectTranscriptPayload = false } = {}) {
  const stdoutMonitor = createSentinelMonitor(`${label}-stdout`, {
    forbiddenMarkers: [RAW_ARCHIVE_SENTINEL, PRIVATE_ARCHIVE_BASENAME],
    expectedMarkers: expectTranscriptPayload ? [TRANSCRIPT_SENTINEL] : []
  });
  const stderrMonitor = createSentinelMonitor(`${label}-stderr`);
  return new MonitoredStdioClientTransport({
    command: process.execPath,
    args: [path.join(repoDir, 'mcp-server.mjs'), '--tool-profile', 'library'],
    cwd: repoDir,
    env: { ...process.env, AGENTIFY_DESKTOP_STATE_DIR: stateDir },
    stderr: 'pipe'
  }, { stdoutMonitor, stderrMonitor });
}

function mcpCall(promise, code = 'mcp_call_timeout') {
  return timeoutAfter(promise, 12_000, code);
}

async function exerciseMcp(stateDir) {
  const transport = mcpTransport(stateDir, 'mcp-library', { expectTranscriptPayload: true });
  const client = new Client({ name: 'transcript-library-e2e', version: '1.0.0' }, { capabilities: {} });
  let connected = false;
  try {
    await mcpCall(client.connect(transport), 'mcp_connect_timeout');
    connected = true;
    const tools = await mcpCall(client.listTools());
    assert.deepEqual(tools.tools.map(({ name }) => name), REQUIRED_LIBRARY_TOOLS);
    const sources = await mcpCall(client.callTool({ name: 'agentify_list_transcripts', arguments: {} }));
    assert.equal(sources.isError === true, false);
    assert.equal(sources.structuredContent.count, 1);
    assert.equal(JSON.stringify(sources).includes(TRANSCRIPT_SENTINEL), false);
    const page = await mcpCall(client.callTool({
      name: 'agentify_get_transcript',
      arguments: { identity: LIVE_IDENTITY, limit: 1 }
    }));
    assert.equal(page.isError === true, false);
    assert.equal(page.structuredContent.citations.length, 1);
    assertCitationPage(page.structuredContent, LIVE_IDENTITY, 0);
    assert.ok(page.structuredContent.nextCursor);
    const sentinelPage = await mcpCall(client.callTool({
      name: 'agentify_get_transcript',
      arguments: {
        identity: LIVE_IDENTITY,
        snapshot: page.structuredContent.snapshot,
        cursor: page.structuredContent.nextCursor,
        limit: 2
      }
    }));
    assert.equal(sentinelPage.isError === true, false);
    assertCitationPage(sentinelPage.structuredContent, LIVE_IDENTITY, 1);
    assert.equal(
      sentinelPage.structuredContent.structuredTurns
        .some(({ text }) => String(text).includes(TRANSCRIPT_SENTINEL)),
      true
    );
    const catalog = await mcpCall(client.callTool({
      name: 'agentify_list_chatgpt_catalog',
      arguments: { profileScopeId: PROFILE_SCOPE_ID, limit: 100 }
    }));
    assert.equal(catalog.isError === true, false);
    assert.equal(catalog.structuredContent.items.length, 64);
    assert.equal(catalog.structuredContent.items.some(({ identity }) =>
      identity.provider === IMPORTED_IDENTITY.provider &&
      identity.profileScopeId === IMPORTED_IDENTITY.profileScopeId &&
      identity.providerConversationId === IMPORTED_IDENTITY.providerConversationId), true);
    const imports = await mcpCall(client.callTool({ name: 'agentify_list_chatgpt_imports', arguments: {} }));
    assert.equal(imports.isError === true, false);
    assert.equal(imports.structuredContent.items.length, 1);
    assert.equal(imports.structuredContent.truncated, false);
    assert.equal(imports.structuredContent.items[0].profileScopeId, PROFILE_SCOPE_ID);
    assert.equal(imports.structuredContent.items[0].status, 'complete');
    const reassigned = await mcpCall(client.callTool({
      name: 'agentify_reassign_chatgpt_import',
      arguments: {
        importId: imports.structuredContent.items[0].importId,
        newProfileScopeId: PROFILE_SCOPE_ID,
        confirm: true
      }
    }));
    assert.equal(reassigned.isError === true, false);
    assert.equal(reassigned.structuredContent.changed, false);
    assert.equal(reassigned.structuredContent.profileScopeId, PROFILE_SCOPE_ID);
    const serializedImportStatus = JSON.stringify({ imports, reassigned });
    assert.equal(serializedImportStatus.includes(RAW_ARCHIVE_SENTINEL), false);
    assert.equal(serializedImportStatus.includes(PRIVATE_ARCHIVE_BASENAME), false);
  } finally {
    if (connected) await client.close();
    else await transport.close().catch(() => {});
  }
  return await transport.assertCleanExit();
}

async function forgetThroughMcp(stateDir) {
  const transport = mcpTransport(stateDir, 'mcp-forget');
  const client = new Client({ name: 'transcript-library-e2e-forget', version: '1.0.0' }, { capabilities: {} });
  let connected = false;
  try {
    await mcpCall(client.connect(transport), 'mcp_connect_timeout');
    connected = true;
    const listed = await mcpCall(client.callTool({ name: 'agentify_list_transcripts', arguments: {} }));
    const sourceId = listed.structuredContent.sources[0]?.id;
    assert.ok(sourceId);
    const forgotten = await mcpCall(client.callTool({
      name: 'agentify_forget_transcript',
      arguments: { sourceId, confirm: true }
    }));
    assert.equal(forgotten.isError === true, false);
    assert.equal(forgotten.structuredContent.sourceId, sourceId);
    assert.equal(forgotten.structuredContent.recoverable, true);
    const after = await mcpCall(client.callTool({ name: 'agentify_list_transcripts', arguments: {} }));
    assert.equal(after.structuredContent.count, 0);
  } finally {
    if (connected) await client.close();
    else await transport.close().catch(() => {});
  }
  return await transport.assertCleanExit();
}

async function verifyPrivateLibraryModes(stateDir) {
  if (process.platform === 'win32') return { directories: 0, files: 0, checked: false };
  const root = path.join(stateDir, 'transcript-library');
  let directories = 0;
  let files = 0;
  async function visit(current) {
    const stat = await fs.lstat(current);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) {
      assert.equal(stat.mode & 0o777, 0o700);
      directories += 1;
      for (const name of await fs.readdir(current)) await visit(path.join(current, name));
      return;
    }
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    files += 1;
  }
  await visit(root);
  assert.equal(directories > 3, true);
  assert.equal(files > 3, true);
  return { directories, files, checked: true };
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

async function forceStopElectron(runtime) {
  if (!runtime) return;
  if (Number.isSafeInteger(runtime.appPid) && runtime.appPid > 1 && processIsAlive(runtime.appPid)) {
    try {
      process.kill(runtime.appPid, 'SIGTERM');
    } catch {}
  }
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    try {
      runtime.child.kill('SIGTERM');
    } catch {}
  }
  await Promise.race([
    runtime.closed.catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function shutdownElectron(runtime) {
  let response;
  try {
    response = await httpJson(runtime.connection, '/shutdown', {
      method: 'POST',
      body: { scope: 'app' }
    });
    assert.equal(response.status, 200);
    const result = await timeoutAfter(runtime.closed, 20_000, 'electron_shutdown_timeout');
    assert.deepEqual(result, { code: 0, signal: null });
    await waitFor(() => !processIsAlive(runtime.appPid), {
      timeoutMs: 5_000,
      intervalMs: 50,
      code: 'electron_app_pid_still_alive'
    });
    runtime.monitor.assertClean();
    return { exit: result, output: runtime.monitor.summary() };
  } catch (error) {
    await forceStopElectron(runtime);
    throw error;
  }
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

async function buildReceiptContext(launch) {
  const entryPath = await fs.realpath(launch.executable);
  const entryDigest = await sha256File(entryPath);
  let binaryPath = entryPath;
  if (launch.kind === 'development' && launch.usesBundledElectron) {
    const electronPackageDir = path.join(repoDir, 'node_modules', 'electron');
    const relativeBinary = (await fs.readFile(path.join(electronPackageDir, 'path.txt'), 'utf8')).trim();
    binaryPath = await fs.realpath(path.join(electronPackageDir, 'dist', relativeBinary));
  }
  const binaryStat = await fs.lstat(binaryPath);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw runnerError('e2e_binary_invalid');
  const binaryDigest = await sha256File(binaryPath);
  const [{ stdout: gitSha }, { stdout: gitStatus }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, maxBuffer: 1024 * 1024 }),
    execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repoDir, maxBuffer: 8 * 1024 * 1024 })
  ]);
  return {
    launchEntry: {
      path: entryPath,
      sha256: entryDigest.sha256,
      byteLength: entryDigest.byteLength
    },
    binary: {
      path: binaryPath,
      sha256: binaryDigest.sha256,
      byteLength: binaryDigest.byteLength
    },
    buildConfig: launch.kind === 'packaged'
      ? 'packaged-distribution-entry'
      : 'development-electron-with-source-main',
    gitSha: gitSha.trim(),
    gitDirty: gitStatus.length > 0
  };
}

async function writePrivateJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (const marker of ALL_PRIVATE_MARKERS) assert.equal(serialized.includes(marker), false);
  await fs.writeFile(filePath, serialized, { mode: 0o600, flag: 'wx' });
  const stat = await fs.lstat(filePath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
}

function invocationSummary(options, launch) {
  const args = ['node', 'scripts/e2e-transcript-library.mjs'];
  if (options.keepState) args.push('--keep-state');
  if (options.stateDir) args.push('--state-dir', '<caller-provided-private-state>');
  if (options.electron) args.push('--electron', launch.executable);
  if (options.packagedApp) args.push('--packaged-app', path.resolve(options.packagedApp));
  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const state = await makeStateDir(options.stateDir);
  const launch = resolveLaunch(options);
  let evidenceDir = null;
  let context = null;
  let partialScreenshotPath = null;
  let completeScreenshotPath = null;
  let forgetScreenshotPath = null;
  let stepsPath = null;
  let receiptPath = null;
  let recoveryRuntime = null;
  let completedRuntime = null;
  let relaunchedRuntime = null;
  let degradedRuntime = null;
  let recoverySessionId = null;
  let completedSessionId = null;
  let relaunchSessionId = null;
  let cleanup = null;
  let result = null;
  let transcriptStateMode = null;
  const transcriptStatePath = path.join(state.stateDir, 'transcript-library', 'live', 'state.json');
  let phase = 'setup';
  try {
    phase = 'preflight';
    evidenceDir = await makeEvidenceDir();
    context = await buildReceiptContext(launch);
    partialScreenshotPath = path.join(evidenceDir, 'control-center-interrupted.png');
    completeScreenshotPath = path.join(evidenceDir, 'control-center-complete.png');
    forgetScreenshotPath = path.join(evidenceDir, 'control-center-forgotten.png');
    stepsPath = path.join(evidenceDir, 'steps.json');
    receiptPath = path.join(evidenceDir, 'receipt.json');
    phase = 'crash_fixture';
    const crash = await runCrashFixture(state.stateDir);

    phase = 'interrupted_launch';
    recoveryRuntime = await launchElectron({ launch, stateDir: state.stateDir });
    recoverySessionId = recoveryRuntime.sessionId;
    phase = 'interrupted_http';
    const recoveryHttp = await exerciseRecoveryHttp(recoveryRuntime.connection);
    phase = 'interrupted_ui';
    const interruptedUi = await exerciseControlCenter(recoveryRuntime.debugPort, state.stateDir, {
      expectedImportStatus: 'partial',
      expectedImportSuspension: 'interrupted',
      expectedImportCursor: 0,
      expectedCatalogCount: 0,
      screenshotPath: partialScreenshotPath
    });
    const recoveryServerId = recoveryRuntime.connection.state.serverId;
    phase = 'interrupted_shutdown';
    const recoveryExit = await shutdownElectron(recoveryRuntime);
    recoveryRuntime = null;

    phase = 'resume_fixture';
    const resumed = await runResumeFixture(state.stateDir);
    const rawFilesAfterReplay = await countRegularFiles(path.join(
      state.stateDir, 'transcript-library', 'blobs', 'raw'
    ));
    const snapshotFilesAfterReplay = await countRegularFiles(path.join(
      state.stateDir, 'transcript-library', 'blobs', 'snapshot'
    ));
    assert.equal(rawFilesAfterReplay, crash.stagedRawFiles);
    assert.equal(snapshotFilesAfterReplay, crash.stagedSnapshotFiles);

    phase = 'completed_launch';
    completedRuntime = await launchElectron({ launch, stateDir: state.stateDir });
    completedSessionId = completedRuntime.sessionId;
    assert.notEqual(completedRuntime.connection.state.serverId, recoveryServerId);
    phase = 'completed_http';
    const completedHttp = await exerciseHttp(completedRuntime.connection);
    assert.equal(completedHttp.liveSnapshotHash, recoveryHttp.liveSnapshotHash);
    assert.equal(completedHttp.liveContentHash, recoveryHttp.liveContentHash);
    phase = 'completed_ui';
    const completedUi = await exerciseControlCenter(completedRuntime.debugPort, state.stateDir, {
      expectedImportStatus: 'complete',
      expectedImportSuspension: null,
      expectedImportCursor: 64,
      expectedCatalogCount: 64,
      screenshotPath: completeScreenshotPath
    });
    phase = 'completed_mcp';
    const completedMcp = await exerciseMcp(state.stateDir);
    const completedServerId = completedRuntime.connection.state.serverId;
    phase = 'completed_shutdown';
    const completedExit = await shutdownElectron(completedRuntime);
    completedRuntime = null;

    phase = 'relaunch';
    relaunchedRuntime = await launchElectron({ launch, stateDir: state.stateDir });
    relaunchSessionId = relaunchedRuntime.sessionId;
    assert.notEqual(relaunchedRuntime.connection.state.serverId, completedServerId);
    phase = 'relaunch_http';
    const relaunchedHttp = await exerciseHttp(relaunchedRuntime.connection);
    assert.deepEqual(relaunchedHttp, completedHttp);
    phase = 'relaunch_ui';
    const relaunchedUi = await exerciseControlCenter(relaunchedRuntime.debugPort, state.stateDir, {
      expectedImportStatus: 'complete',
      expectedImportSuspension: null,
      expectedImportCursor: 64,
      expectedCatalogCount: 64
    });
    phase = 'relaunch_mcp';
    const relaunchedMcp = await exerciseMcp(state.stateDir);
    phase = 'forget_mcp';
    const forgetMcp = await forgetThroughMcp(state.stateDir);
    const forgetUi = await observeControlCenterSourceCount(relaunchedRuntime.debugPort, 0, {
      screenshotPath: forgetScreenshotPath
    });
    const afterForget = await httpJson(relaunchedRuntime.connection, '/transcripts/list');
    assert.deepEqual(afterForget, { status: 200, data: [] });
    const catalogAfterForget = await httpJson(
      relaunchedRuntime.connection,
      `/catalog/list?profileScopeId=${PROFILE_SCOPE_ID}&limit=100`
    );
    assert.equal(catalogAfterForget.data.items.length, 64);
    phase = 'relaunch_shutdown';
    const relaunchedExit = await shutdownElectron(relaunchedRuntime);
    relaunchedRuntime = null;

    let degradedStartup = {
      tested: false,
      reason: 'private_mode_fixture_not_supported_on_windows'
    };
    let degradedExit = null;
    if (process.platform !== 'win32') {
      phase = 'degraded_state_prepare';
      const transcriptStateStat = await fs.lstat(transcriptStatePath);
      assert.equal(transcriptStateStat.isFile(), true);
      assert.equal(transcriptStateStat.isSymbolicLink(), false);
      transcriptStateMode = transcriptStateStat.mode & 0o777;
      assert.equal(transcriptStateMode, 0o600);
      await fs.chmod(transcriptStatePath, 0o644);

      phase = 'degraded_launch';
      degradedRuntime = await launchElectron({ launch, stateDir: state.stateDir });
      phase = 'degraded_observation';
      degradedStartup = {
        tested: true,
        fixture: 'transcript_state_mode_0644',
        ...(await exerciseDegradedLibraryStartup(degradedRuntime))
      };
      phase = 'degraded_shutdown';
      degradedExit = await shutdownElectron(degradedRuntime);
      degradedRuntime = null;
      phase = 'degraded_state_restore';
      await fs.chmod(transcriptStatePath, transcriptStateMode);
      transcriptStateMode = null;
    }

    const modes = await verifyPrivateLibraryModes(state.stateDir);
    assert.deepEqual(completedUi.driver, relaunchedUi.driver);
    const steps = {
      journeyId: 'transcript-library-local-recovery-v0',
      actions: [
        'stage-real-archive-batch',
        'external-sigkill-before-catalog-commit',
        'launch-and-observe-interrupted-import',
        'subprocess-resume-and-same-archive-replay',
        'launch-and-observe-complete-catalog',
        'relaunch-and-observe-persistence',
        'forget-local-source',
        'observe-content-free-mutation-event-in-control-center',
        ...(degradedStartup.tested
          ? ['launch-with-invalid-transcript-state-mode-and-observe-isolated-degradation']
          : [])
      ],
      observed: {
        stagedRecords: crash.stagedRawFiles,
        catalogRowsAfterCrash: 0,
        catalogRowsAfterResume: 64,
        stableLiveSnapshotAcrossRelaunch: true,
        stableImportedSnapshotAcrossRelaunch: true,
        requestedMcpSecondPageContainedTranscriptFixture: true
      }
    };

    result = {
      schemaVersion: 1,
      result: 'verified',
      status: 'pass',
      journeyId: steps.journeyId,
      checkpoint: 'relaunch-after-import-resume',
      command: invocationSummary(options, launch),
      mode: 'local-fixture',
      launch: launch.kind,
      runtime: {
        launchEntry: context.launchEntry,
        binary: context.binary,
        buildConfig: context.buildConfig,
        gitSha: context.gitSha,
        gitDirty: context.gitDirty,
        driver: completedUi.driver,
        window: completedUi.geometry.viewport
      },
      fixture: {
        mode: 'contract-fixture',
        identity: 'real-zip32/64-record-batch/production-grant-reader-service-v1',
        providerDataUsed: false
      },
      dependencies: {
        desktop: launch.kind === 'packaged'
          ? 'packaged application executable and packaged renderer/preload resources'
          : 'development Electron launcher and checkout main.mjs',
        mcp: 'checkout mcp-server.mjs over stdio, attached to the running desktop HTTP state',
        archive: 'real ZIP32 bytes through production one-use grant, reader, blob store, and catalog service',
        picker: 'deterministic dialog adapter; the native OS picker is reserved for authorized live-export acceptance',
        filesystem: 'real private filesystem under a run-owned disposable root'
      },
      processes: {
        electronLaunches: degradedStartup.tested ? 4 : 3,
        electronExits: [recoveryExit, completedExit, relaunchedExit, degradedExit].filter(Boolean),
        mcpStdioLaunches: 3,
        mcpExits: [completedMcp, relaunchedMcp, forgetMcp],
        crashFixtureExit: crash.exit,
        resumeFixtureExit: resumed.exit,
        http: true,
        controlCenterPreload: true
      },
      recovery: {
        liveAttemptInterrupted: true,
        priorLatestPreserved: true,
        importSuspendedAtCursorZero: true,
        stagedBatchWasNotVisibleBeforeCommit: true,
        realArchiveResumeCompleted: true,
        sameArchiveReplayCreatedNoNewBlobs: true,
        unreachableBlobsStayedUnpublished: true,
        restartStable: true,
        isolatedStartupDegradation: degradedStartup
      },
      contracts: {
        authenticatedHttp: true,
        twoPageCitations: true,
        importedRetrieval: true,
        mcpLibraryProfile: REQUIRED_LIBRARY_TOOLS.length,
        arbitraryArchivePathsRejected: true,
        localForget: true,
        controlCenterMutationEvent: forgetUi.count === 0 && forgetUi.emptyVisible,
        mcpSecondPageTranscriptPayload: true
      },
      privacy: {
        privateModeCheck: modes.checked,
        privateDirectoriesChecked: modes.directories,
        privateFilesChecked: modes.files,
        exactDirectoryMode: process.platform === 'win32' ? null : '0700',
        exactFileMode: process.platform === 'win32' ? null : '0600',
        rawArchiveAndArchivePathMarkersAbsentFromAllMonitoredProcessStreams: true,
        transcriptMarkerAbsentFromElectronOutputAndMcpStderr: true,
        transcriptMarkerObservedInRequestedMcpStdoutProtocolPayload:
          completedMcp.output.stdout.expectedMarkerObserved === true &&
          relaunchedMcp.output.stdout.expectedMarkerObserved === true,
        receiptAndRunnerOutputExcludeAllPrivateMarkers: true,
        controlCenterDomExcludesAllPrivateMarkers: true
      },
      lifecycle: {
        launchSession: recoverySessionId,
        completedSession: completedSessionId,
        relaunchSession: relaunchSessionId,
        persistenceObservation: 'same live and imported snapshot hashes after a fresh Electron/MCP relaunch'
      },
      evidence: {
        receipt: receiptPath,
        steps: stepsPath,
        screenshots: [interruptedUi.screenshot, completedUi.screenshot, forgetUi.screenshot],
        semanticState: [
          interruptedUi.accessibility,
          completedUi.accessibility,
          relaunchedUi.accessibility
        ],
        geometry: [
          interruptedUi.geometry,
          completedUi.geometry,
          relaunchedUi.geometry
        ],
        visualDiffs: []
      },
      limitations: [
        'The deterministic local run does not automate the native OS file picker.',
        launch.kind === 'packaged'
          ? 'The packaged desktop is exercised directly; MCP remains the checkout stdio entry because the package has no standalone MCP executable.'
          : 'This receipt verifies the development Electron entry; packaged verification requires --packaged-app.'
      ]
    };
    await writePrivateJson(stepsPath, steps);
  } catch (error) {
    if (!SAFE_E2E_OUTPUT_ERROR_CODES.has(String(error?.code || '').trim().toLowerCase())) {
      error.code = `e2e_${phase}_failed`;
    }
    throw error;
  } finally {
    if (recoveryRuntime) await forceStopElectron(recoveryRuntime);
    if (completedRuntime) await forceStopElectron(completedRuntime);
    if (relaunchedRuntime) await forceStopElectron(relaunchedRuntime);
    if (degradedRuntime) await forceStopElectron(degradedRuntime);
    if (transcriptStateMode !== null) {
      await fs.chmod(transcriptStatePath, transcriptStateMode).catch(() => {});
      transcriptStateMode = null;
    }
    cleanup = await cleanupOwnedState(state, options.keepState);
  }
  if (!result) throw runnerError('e2e_result_missing');
  result.cleanup = cleanup;
  result.stateRetained = cleanup !== 'owned-state-removed';
  await writePrivateJson(receiptPath, result);
  return result;
}

main().then((report) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: 'fail', error: safeErrorCode(error) })}\n`);
  process.exitCode = 1;
});
