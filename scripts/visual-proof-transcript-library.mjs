#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.dirname(__dirname);
const fixtureMain = path.join(repoDir, 'tests', 'fixtures', 'transcript-library-visual-proof-main.cjs');
const EVIDENCE_PREFIX = 'agentify-transcript-library-visual-proof-';
const RUNTIME_PREFIX = 'agentify-transcript-library-visual-proof-runtime-';
const PROFILE_SCOPE_ID = 'visual-proof-scope';
const VIEWPORT = Object.freeze({ width: 720, height: 1800, device: 'desktop' });
const CDP_TIMEOUT_MS = 10_000;
const FORBIDDEN_PRIVATE_MARKERS = Object.freeze([
  'VISUAL_PROOF_PRIVATE_TRANSCRIPT_SENTINEL',
  'VISUAL_PROOF_PRIVATE_ARCHIVE_SENTINEL',
  'PRIVATE-ARCHIVE-PATH.zip'
]);
const SAFE_VISUAL_PROOF_OUTPUT_ERROR_CODES = new Set([
  'visual_proof_failed',
  'visual_proof_argument_unknown',
  'visual_proof_argument_missing',
  'visual_proof_capture_argument_invalid',
  'visual_proof_review_required',
  'visual_proof_finalize_argument_invalid',
  'visual_proof_evidence_path_unsafe',
  'visual_proof_evidence_path_invalid',
  'visual_proof_private_marker_detected',
  'visual_proof_artifact_mode_invalid',
  'visual_proof_renderer_not_ready',
  'visual_proof_fixture_state_not_rendered',
  'visual_proof_forget_state_not_rendered',
  'visual_proof_machine_inspection_failed',
  'visual_proof_screenshot_invalid',
  'visual_proof_capture_invalid',
  'visual_proof_stale_worktree',
  'visual_proof_pixel_review_invalid',
  'visual_proof_reviewer_invalid',
  'visual_proof_review_note_invalid',
  'visual_proof_screenshot_stale',
  'cdp_connect_failed',
  'cdp_protocol_error',
  'cdp_closed',
  'cdp_not_connected',
  'cdp_call_timeout',
  'cdp_evaluate_failed',
  'cdp_event_timeout',
  'electron_control_center_target_missing',
  'electron_fixture_exit_failed'
]);

const SCENARIOS = Object.freeze({
  states: {
    route: '/ui/control-center.html#transcript-library-states',
    fixture: 'transcript-library-control-center/states-v1',
    screenshotName: 'control-center-library-states.png',
    manifestName: 'control-center-library-states.manifest.json',
    expected: { imports: 1, catalog: 1, sources: 4 },
    ac: {
      id: 'AC-U6-STATES',
      claim: 'The Control Center visibly shows catalog route state, disabled, syncing, partial, and tracked sources, private storage, and local-forget controls.'
    },
    targets: [
      {
        label: 'temporarily unavailable catalog route',
        selector: '#libraryCatalogList .libraryItem:nth-child(1)',
        expectedText: ['temporarily unavailable', 'This is not a deletion']
      },
      {
        label: 'disabled source row',
        selector: '#librarySourcesList .libraryItem:nth-child(1)',
        expectedText: ['Disabled source', 'disabled', 'unavailable'],
        controls: 'all-disabled'
      },
      {
        label: 'syncing source row',
        selector: '#librarySourcesList .libraryItem:nth-child(2)',
        expectedText: ['Syncing source', 'syncing', 'unavailable'],
        controls: 'all-disabled'
      },
      {
        label: 'partial source row',
        selector: '#librarySourcesList .libraryItem:nth-child(3)',
        expectedText: ['Partial source', 'partial', 'latest complete snapshot was not advanced', 'Forget locally'],
        controls: 'all-enabled'
      },
      {
        label: 'tracked source row and forget control',
        selector: '#librarySourcesList .libraryItem:nth-child(4)',
        expectedText: ['Tracked source', 'tracked', 'Forget locally'],
        controls: 'all-enabled'
      },
      {
        label: 'private storage location',
        selector: '#libraryStorageLocation',
        expectedText: ['Local storage:', 'transcript-library', 'private directories and files']
      },
      {
        label: 'local-only privacy promise',
        selector: '#transcriptLibraryCard .privacyNote',
        expectedText: ['ZIP access is one-use', 'never deletes the provider conversation']
      }
    ]
  },
  forget: {
    route: '/ui/control-center.html#transcript-library-forget-empty',
    fixture: 'transcript-library-control-center/forget-v1',
    screenshotName: 'control-center-forget-empty.png',
    manifestName: 'control-center-forget-empty.manifest.json',
    expected: { imports: 0, catalog: 0, sources: 1 },
    ac: {
      id: 'AC-U6-FORGET',
      claim: 'A confirmed local Forget interaction visibly ends in a success message and an empty tracked-source state while preserving the provider-conversation promise.'
    },
    targets: [
      {
        label: 'confirmed local forget success',
        selector: '#libraryActionStatus',
        expectedText: ['Local source forgotten', 'active list', 'immutable blobs may remain locally', 'provider conversation was untouched']
      },
      {
        label: 'empty tracked-source state',
        selector: '#librarySourcesEmpty',
        expectedText: ['No live conversations are tracked locally']
      },
      {
        label: 'provider-preserving privacy promise',
        selector: '#transcriptLibraryCard .privacyNote',
        expectedText: ['active list', 'Recoverable deletion history', 'immutable transcript blobs may remain locally', 'never deletes the provider conversation']
      }
    ]
  }
});

function proofError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function timeoutAfter(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(proofError(code)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeOutputError(error) {
  const code = String(error?.code || '').trim().toLowerCase();
  return SAFE_VISUAL_PROOF_OUTPUT_ERROR_CODES.has(code) ? code : 'visual_proof_failed';
}

function parseArgs(argv) {
  let mode = 'capture';
  let index = 0;
  if (argv[0] === 'capture' || argv[0] === 'finalize') {
    mode = argv[0];
    index = 1;
  }
  const options = {
    mode,
    evidenceDir: null,
    electron: null,
    pixelReview: null,
    reviewer: null,
    reviewNote: null
  };
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    const field = new Map([
      ['--evidence-dir', 'evidenceDir'],
      ['--electron', 'electron'],
      ['--pixel-review', 'pixelReview'],
      ['--reviewer', 'reviewer'],
      ['--review-note', 'reviewNote']
    ]).get(argument);
    if (!field) throw proofError('visual_proof_argument_unknown');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw proofError('visual_proof_argument_missing');
    options[field] = value;
    index += 1;
  }
  if (mode === 'capture' && (options.pixelReview || options.reviewer || options.reviewNote)) {
    throw proofError('visual_proof_capture_argument_invalid');
  }
  if (mode === 'finalize' && (!options.evidenceDir || !options.pixelReview || !options.reviewer || !options.reviewNote)) {
    throw proofError('visual_proof_review_required');
  }
  if (mode === 'finalize' && options.electron) throw proofError('visual_proof_finalize_argument_invalid');
  return options;
}

async function privateTemporaryRoot() {
  return await fs.realpath('/tmp');
}

async function assertTemporaryEvidencePath(value, { mustExist }) {
  const temporaryRoot = await privateTemporaryRoot();
  const requested = path.resolve(value);
  const parent = await fs.realpath(path.dirname(requested)).catch(() => null);
  const resolved = parent ? path.join(parent, path.basename(requested)) : requested;
  if (
    resolved === temporaryRoot ||
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith(EVIDENCE_PREFIX)
  ) {
    throw proofError('visual_proof_evidence_path_unsafe');
  }
  if (mustExist) {
    const real = await fs.realpath(resolved).catch(() => null);
    if (real !== resolved) throw proofError('visual_proof_evidence_path_invalid');
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
      throw proofError('visual_proof_evidence_path_invalid');
    }
  }
  return resolved;
}

async function createEvidenceDirectory(requested) {
  if (!requested) {
    const directory = await fs.mkdtemp(path.join(await privateTemporaryRoot(), EVIDENCE_PREFIX));
    await fs.chmod(directory, 0o700);
    return await fs.realpath(directory);
  }
  const directory = await assertTemporaryEvidencePath(requested, { mustExist: false });
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return await fs.realpath(directory);
}

async function writePrivateJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const serialized = bytes.toString('utf8');
  if (FORBIDDEN_PRIVATE_MARKERS.some((marker) => serialized.includes(marker))) {
    throw proofError('visual_proof_private_marker_detected');
  }
  await fs.writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw proofError('visual_proof_artifact_mode_invalid');
  }
}

async function gitText(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function listGitFiles(args) {
  return (await gitText([...args, '-z'])).split('\0').filter(Boolean);
}

async function fingerprintFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of [...new Set(files)].sort()) {
    const absolutePath = path.join(repoDir, relativePath);
    let bytes;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      bytes = Buffer.from('<missing>');
    }
    hash.update(relativePath);
    hash.update('\0');
    hash.update(sha256(bytes));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function captureProvenance() {
  const [head, branch, trackedFiles, untrackedFiles, dirtyTrackedNames, dirtyDiff] = await Promise.all([
    gitText(['rev-parse', 'HEAD']).then((value) => value.trim()),
    gitText(['branch', '--show-current']).then((value) => value.trim()),
    listGitFiles(['ls-files']),
    listGitFiles(['ls-files', '--others', '--exclude-standard']),
    gitText(['diff', '--name-only', '-z', 'HEAD', '--']).then((value) => value.split('\0').filter(Boolean)),
    gitText(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'])
  ]);
  const packageLockBytes = await fs.readFile(path.join(repoDir, 'package-lock.json'));
  const renderInputs = [
    'ui/control-center.html',
    'ui/control-center.css',
    'ui/control-center.js',
    'ui/preload.cjs',
    'tests/fixtures/transcript-library-visual-proof-main.cjs',
    'scripts/visual-proof-transcript-library.mjs'
  ];
  return Object.freeze({
    git: {
      head,
      branch,
      status: dirtyTrackedNames.length || untrackedFiles.length ? 'dirty' : 'clean',
      dirty_tracked_count: dirtyTrackedNames.length,
      untracked_count: untrackedFiles.length,
      tracked_diff_sha256: await fingerprintFiles(trackedFiles),
      dirty_tracked_diff_sha256: sha256(dirtyDiff)
    },
    worktree_fingerprint: await fingerprintFiles([...trackedFiles, ...untrackedFiles]),
    package_lock_sha256: sha256(packageLockBytes),
    render_input_sha256: await fingerprintFiles(renderInputs),
    dev_server: {
      boot_id: `electron-fixture-run-${crypto.randomUUID()}`,
      vite_version: null,
      app_build_fingerprint: await fingerprintFiles(renderInputs)
    },
    data_fixture: 'transcript-library-control-center-v1'
  });
}

function sameProvenance(left, right) {
  return left?.git?.head === right?.git?.head &&
    left?.git?.branch === right?.git?.branch &&
    left?.git?.tracked_diff_sha256 === right?.git?.tracked_diff_sha256 &&
    left?.git?.dirty_tracked_diff_sha256 === right?.git?.dirty_tracked_diff_sha256 &&
    left?.worktree_fingerprint === right?.worktree_fingerprint &&
    left?.package_lock_sha256 === right?.package_lock_sha256 &&
    left?.render_input_sha256 === right?.render_input_sha256;
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

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100, code = 'visual_proof_wait_timeout' } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw proofError(code);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await timeoutAfter(new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(proofError('cdp_connect_failed')), { once: true });
    }), CDP_TIMEOUT_MS, 'cdp_connect_timeout');
    this.socket.addEventListener('message', (event) => this.#receive(event));
    this.socket.addEventListener('close', () => this.#closePending());
  }

  #receive(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(proofError('cdp_protocol_error'));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const waiters = this.eventWaiters.get(message.method);
    if (!waiters?.length) return;
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(message.params || {});
  }

  #closePending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(proofError('cdp_closed'));
    }
    this.pending.clear();
    for (const waiters of this.eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(proofError('cdp_closed'));
      }
    }
    this.eventWaiters.clear();
  }

  async call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw proofError('cdp_not_connected');
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(proofError('cdp_call_timeout'));
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
    if (result.exceptionDetails) throw proofError('cdp_evaluate_failed');
    return result.result?.value;
  }

  waitForEvent(method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) || [];
        this.eventWaiters.set(method, waiters.filter((waiter) => waiter.resolve !== resolve));
        reject(proofError('cdp_event_timeout'));
      }, CDP_TIMEOUT_MS);
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push({ resolve, reject, timer });
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

async function connectControlCenter(debugPort) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((candidate) =>
      candidate.type === 'page' && String(candidate.url || '').includes('/ui/control-center.html')) || null;
  }, { timeoutMs: 30_000, code: 'electron_control_center_target_missing' });
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  return client;
}

function inspectionExpression(config) {
  return `(() => {
    const targets = ${JSON.stringify(config.targets)};
    const forbiddenMarkers = ${JSON.stringify(FORBIDDEN_PRIVATE_MARKERS)};
    const parseColor = (value) => {
      const match = String(value || '').match(/rgba?\\(([^)]+)\\)/i);
      if (!match) return null;
      const parts = match[1].replace(/\\//g, ' ').split(/[ ,]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some((item) => !Number.isFinite(item))) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
    };
    const composite = (front, back) => ({
      r: (front.r * front.a) + (back.r * (1 - front.a)),
      g: (front.g * front.a) + (back.g * (1 - front.a)),
      b: (front.b * front.a) + (back.b * (1 - front.a)),
      a: 1
    });
    const backgroundFor = (element) => {
      let current = element;
      const layers = [];
      while (current) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0) layers.push(color);
        current = current.parentElement;
      }
      let background = { r: 17, g: 18, b: 20, a: 1 };
      for (let index = layers.length - 1; index >= 0; index -= 1) background = composite(layers[index], background);
      return background;
    };
    const luminance = (color) => {
      const linear = [color.r, color.g, color.b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
    };
    const contrast = (foreground, background) => {
      const fg = luminance(composite(foreground, background));
      const bg = luminance(background);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    };
    const hex = (color) => '#' + [color.r, color.g, color.b]
      .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('');
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    };
    const bbox = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height
      };
    };
    const inspect = (target) => {
      const element = document.querySelector(target.selector);
      if (!element) return {
        label: target.label,
        selector: target.selector,
        bbox: null,
        observations: [{ kind: 'selector', found: false }],
        verdict: 'unknown',
        evidence: 'selector not found'
      };
      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      const background = backgroundFor(element);
      const ratio = foreground ? contrast(foreground, background) : 0;
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const threshold = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700) ? 3 : 4.5;
      const text = String(element.innerText || element.textContent || '').trim().replace(/\\s+/g, ' ');
      const expectedText = target.expectedText || [];
      const textMatches = expectedText.every((expected) => text.toLowerCase().includes(String(expected).toLowerCase()));
      const controls = Array.from(element.querySelectorAll('button'));
      const controlsMatch = target.controls === 'all-disabled'
        ? controls.length > 0 && controls.every((control) => control.disabled)
        : target.controls === 'all-enabled'
          ? controls.length > 0 && controls.every((control) => !control.disabled)
          : true;
      const isVisible = visible(element);
      const rect = element.getBoundingClientRect();
      const isWithinViewport = rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
      const contrastPasses = !!foreground && ratio >= threshold;
      const verdict = isVisible && isWithinViewport && textMatches && controlsMatch && contrastPasses ? 'pass' : 'fail';
      return {
        label: target.label,
        selector: target.selector,
        bbox: bbox(element),
        observations: [
          { kind: 'contrast', fg: foreground ? hex(composite(foreground, background)) : null, bg: hex(background), ratio: Number(ratio.toFixed(2)), threshold, wcag_aa: contrastPasses ? 'pass' : 'fail' },
          { kind: 'text', expected: expectedText, matched: textMatches, content: text.slice(0, 300) },
          { kind: 'visibility', visible: isVisible },
          { kind: 'viewport', fullyWithin: isWithinViewport },
          { kind: 'controls', expectation: target.controls || null, count: controls.length, matched: controlsMatch }
        ],
        verdict,
        evidence: verdict === 'pass'
          ? 'Visible target matched expected copy, control state, and scoped contrast.'
          : 'One or more visibility, copy, control-state, or scoped-contrast checks failed.'
      };
    };
    const regions = targets.map(inspect);
    const overlaps = (left, right) => !!left && !!right &&
      left.x < right.x + right.width && left.x + left.width > right.x &&
      left.y < right.y + right.height && left.y + left.height > right.y;
    const sweep = [];
    const seen = new Set();
    const card = document.getElementById('transcriptLibraryCard');
    for (const element of card.querySelectorAll('h1, h2, h3, h4, p, button, a, span, label, .title, .sub, .hint, .empty, .badge')) {
      if (seen.has(element) || !visible(element) || !String(element.textContent || '').trim()) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      if (!foreground) continue;
      const background = backgroundFor(element);
      const ratio = contrast(foreground, background);
      const fontSize = Number.parseFloat(style.fontSize) || 0;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const threshold = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700) ? 3 : 4.5;
      const regionBox = bbox(element);
      const exempt = element.matches(':disabled') ? 'disabled-control' : null;
      if (ratio >= threshold || exempt) continue;
      sweep.push({
        selector: element.id ? '#' + element.id : element.className ? '.' + String(element.className).trim().split(/\\s+/).join('.') : element.tagName.toLowerCase(),
        bbox: regionBox,
        ratio: Number(ratio.toFixed(2)),
        threshold,
        text: String(element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
        scoped: regions.some((region) => overlaps(region.bbox, regionBox))
      });
    }
    const cardRect = card.getBoundingClientRect();
    const main = document.querySelector('.main');
    const privacyMarkersAbsent = !forbiddenMarkers.some((marker) => document.body.innerText.includes(marker));
    return {
      regions,
      objective: {
        contrastSweep: {
          regionsBelowAa: sweep.length,
          scoped: sweep.filter((item) => item.scoped),
          collateral: sweep.filter((item) => !item.scoped)
        },
        overflow: {
          htmlOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          bodyOverflowX: document.body.scrollWidth > document.body.clientWidth + 1,
          cardOverflowX: card.scrollWidth > card.clientWidth + 1,
          mainOverflowX: main.scrollWidth > main.clientWidth + 1,
          bodyOverflowY: document.body.scrollHeight > document.body.clientHeight,
          mainOverflowY: main.scrollHeight > main.clientHeight + 1,
          mainScrollHeight: main.scrollHeight,
          mainClientHeight: main.clientHeight
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scale: window.devicePixelRatio
        },
        privacyMarkersAbsent
      },
      cardClip: {
        x: Math.max(0, Math.floor(cardRect.x + window.scrollX)),
        y: Math.max(0, Math.floor(cardRect.y + window.scrollY)),
        width: Math.ceil(cardRect.width),
        height: Math.ceil(cardRect.height)
      }
    };
  })()`;
}

function machineVerdict(inspection) {
  if (inspection.regions.some(({ verdict }) => verdict === 'unknown')) return 'unknown';
  if (inspection.regions.some(({ verdict }) => verdict === 'fail')) return 'fail';
  if (
    inspection.objective.contrastSweep.scoped.length > 0 ||
    inspection.objective.overflow.htmlOverflowX ||
    inspection.objective.overflow.bodyOverflowX ||
    inspection.objective.overflow.cardOverflowX ||
    inspection.objective.overflow.mainOverflowX ||
    inspection.objective.viewport.width !== VIEWPORT.width ||
    inspection.objective.viewport.height !== VIEWPORT.height ||
    !inspection.objective.privacyMarkersAbsent
  ) {
    return 'fail';
  }
  return 'pass';
}

async function closeOwnedRuntime({ client, child, closed, runtimeDir }) {
  try {
    await client?.evaluate('window.close()');
  } catch {}
  client?.close();
  let exit = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000))
  ]);
  if (!exit) {
    try {
      child.kill('SIGTERM');
    } catch {}
    exit = await timeoutAfter(closed, 5_000, 'electron_fixture_shutdown_timeout').catch(() => null);
  }
  const temporaryRoot = await privateTemporaryRoot();
  if (
    runtimeDir &&
    path.dirname(runtimeDir) === temporaryRoot &&
    path.basename(runtimeDir).startsWith(RUNTIME_PREFIX)
  ) {
    await fs.rm(runtimeDir, { recursive: true, force: false }).catch(() => {});
  }
  return exit;
}

async function captureScenario({ scenario, config, evidenceDir, electron }) {
  const debugPort = await reservePort();
  const runtimeDir = await fs.mkdtemp(path.join(await privateTemporaryRoot(), RUNTIME_PREFIX));
  await fs.chmod(runtimeDir, 0o700);
  const executable = path.resolve(electron || path.join(repoDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'));
  await fs.access(executable);
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${runtimeDir}`,
    fixtureMain,
    `--scenario=${scenario}`
  ], {
    cwd: repoDir,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let bytesScanned = 0;
  let privateMarkerObserved = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      bytesScanned += Buffer.byteLength(chunk);
      const text = String(chunk);
      if (FORBIDDEN_PRIVATE_MARKERS.some((marker) => text.includes(marker))) privateMarkerObserved = true;
    });
  }
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let client = null;
  try {
    client = await connectControlCenter(debugPort);
    await client.call('Page.enable');
    await client.call('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    const browser = await client.call('Browser.getVersion');
    await waitFor(async () => await client.evaluate(`(() => !!document.getElementById('libraryProfileScope') && !!window.agentifyDesktop)()`), {
      code: 'visual_proof_renderer_not_ready'
    });
    await client.evaluate(`(() => {
      const input = document.getElementById('libraryProfileScope');
      input.value = ${JSON.stringify(PROFILE_SCOPE_ID)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(async () => await client.evaluate(`(() => {
      const imports = document.querySelectorAll('#libraryImportsList .libraryItem').length;
      const catalog = document.querySelectorAll('#libraryCatalogList .libraryItem').length;
      const sources = document.querySelectorAll('#librarySourcesList .libraryItem').length;
      const selected = document.getElementById('libraryActionStatus')?.textContent.includes('Profile scope selected');
      return imports === ${config.expected.imports} && catalog === ${config.expected.catalog} && sources === ${config.expected.sources} && selected;
    })()`), { code: 'visual_proof_fixture_state_not_rendered' });

    let confirmation = null;
    if (scenario === 'forget') {
      const dialogPromise = client.waitForEvent('Page.javascriptDialogOpening');
      const clickPromise = client.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('#librarySourcesList button'))
          .find((candidate) => candidate.textContent.trim() === 'Forget locally');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`);
      const dialog = await dialogPromise;
      assert.equal(dialog.type, 'confirm');
      assert.match(String(dialog.message || ''), /Forget this local tracked source/);
      await client.call('Page.handleJavaScriptDialog', { accept: true });
      assert.equal(await clickPromise, true);
      await waitFor(async () => {
        const value = await client.evaluate(`(() => ({
          sources: document.querySelectorAll('#librarySourcesList .libraryItem').length,
          empty: document.getElementById('librarySourcesEmpty')?.style.display !== 'none',
          status: document.getElementById('libraryActionStatus')?.textContent || ''
        }))()`);
        return value.sources === 0 && value.empty && /Local source forgotten/.test(value.status)
          ? value
          : null;
      }, { code: 'visual_proof_forget_state_not_rendered' });
      confirmation = {
        kind: 'javascript-confirm',
        accepted: true,
        messageMatched: true,
        observableResult: 'success-and-empty-state'
      };
    }

    await client.evaluate(`document.getElementById('transcriptLibraryCard').scrollIntoView({ block: 'start', inline: 'nearest' })`);
    const inspection = await client.evaluate(inspectionExpression(config));
    inspection.machineVerdict = machineVerdict(inspection);
    if (inspection.machineVerdict !== 'pass') {
      await writePrivateJson(path.join(evidenceDir, `${scenario}.machine-failure.json`), {
        schema: 'transcript-library-visual-proof-machine-failure/v1',
        scenario,
        inspection
      });
      throw proofError('visual_proof_machine_inspection_failed');
    }
    if (privateMarkerObserved) throw proofError('visual_proof_private_marker_detected');

    const capture = await client.call('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { ...inspection.cardClip, scale: 1 }
    });
    const screenshotBytes = Buffer.from(capture.data, 'base64');
    if (!screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw proofError('visual_proof_screenshot_invalid');
    }
    const screenshotPath = path.join(evidenceDir, config.screenshotName);
    await fs.writeFile(screenshotPath, screenshotBytes, { mode: 0o600, flag: 'wx' });
    const screenshotStat = await fs.lstat(screenshotPath);
    if (screenshotStat.isSymbolicLink() || !screenshotStat.isFile() || (screenshotStat.mode & 0o777) !== 0o600) {
      throw proofError('visual_proof_artifact_mode_invalid');
    }
    return {
      scenario,
      route: config.route,
      fixture: config.fixture,
      ac: config.ac,
      screenshot: {
        path: screenshotPath,
        sha256: sha256(screenshotBytes),
        bytes: screenshotBytes.length,
        capture_clip: inspection.cardClip
      },
      viewport: VIEWPORT,
      browser: {
        engine: 'electron-chromium',
        version: browser.product,
        protocolVersion: browser.protocolVersion,
        userAgent: browser.userAgent
      },
      runtime: {
        binary: executable,
        binary_sha256: sha256(await fs.readFile(executable)),
        driver: 'Electron DevTools Protocol',
        process_output_bytes_scanned: bytesScanned,
        process_output_private_markers_absent: !privateMarkerObserved
      },
      confirmation,
      inspection
    };
  } finally {
    const exit = await closeOwnedRuntime({ client, child, closed, runtimeDir });
    if (exit && exit.code !== 0 && exit.signal === null) throw proofError('electron_fixture_exit_failed');
  }
}

async function capture(options) {
  const evidenceDir = await createEvidenceDirectory(options.evidenceDir);
  const provenance = await captureProvenance();
  const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  const captures = [];
  for (const [scenario, config] of Object.entries(SCENARIOS)) {
    captures.push(await captureScenario({ scenario, config, evidenceDir, electron: options.electron }));
  }
  const record = {
    schema: 'transcript-library-visual-proof-capture/v1',
    status: 'captured-awaiting-pixel-review',
    ticket: 'transcript-library-v0',
    run_id: runId,
    captured_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    provenance,
    captures,
    privacy: {
      forbidden_markers_absent: captures.every(({ inspection, runtime }) =>
        inspection.objective.privacyMarkersAbsent && runtime.process_output_private_markers_absent)
    }
  };
  const capturePath = path.join(evidenceDir, 'capture.json');
  await writePrivateJson(capturePath, record);
  return {
    schemaVersion: 1,
    status: record.status,
    evidenceDir,
    capture: capturePath,
    screenshots: captures.map(({ screenshot }) => screenshot.path),
    next: `Inspect both PNGs, then run finalize with --evidence-dir, --pixel-review pass|fail, --reviewer, and --review-note.`
  };
}

function parseReview(value, field, { min, max, pattern = null }) {
  if (
    typeof value !== 'string' || value.length < min || value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))
  ) {
    throw proofError(`visual_proof_${field}_invalid`);
  }
  return value;
}

function objectiveChecks(inspection) {
  return [
    {
      kind: 'contrast_sweep',
      regions_below_aa: inspection.objective.contrastSweep.regionsBelowAa,
      scoped: inspection.objective.contrastSweep.scoped,
      collateral: inspection.objective.contrastSweep.collateral
    },
    {
      kind: 'overflow_check',
      html_overflow_x: inspection.objective.overflow.htmlOverflowX,
      body_overflow_x: inspection.objective.overflow.bodyOverflowX,
      card_overflow_x: inspection.objective.overflow.cardOverflowX,
      main_overflow_x: inspection.objective.overflow.mainOverflowX,
      body_overflow_y: inspection.objective.overflow.bodyOverflowY,
      main_overflow_y: inspection.objective.overflow.mainOverflowY,
      expected_main_overflow_y: true,
      result: !inspection.objective.overflow.htmlOverflowX &&
        !inspection.objective.overflow.bodyOverflowX &&
        !inspection.objective.overflow.cardOverflowX &&
        !inspection.objective.overflow.mainOverflowX &&
        inspection.objective.overflow.mainOverflowY
        ? 'pass'
        : 'fail'
    },
    {
      kind: 'viewport_match',
      requested: [VIEWPORT.width, VIEWPORT.height],
      actual: [inspection.objective.viewport.width, inspection.objective.viewport.height],
      result: inspection.objective.viewport.width === VIEWPORT.width && inspection.objective.viewport.height === VIEWPORT.height
        ? 'match'
        : 'mismatch'
    },
    {
      kind: 'private_marker_check',
      forbidden_markers_absent: inspection.objective.privacyMarkersAbsent
    }
  ];
}

async function finalize(options) {
  const evidenceDir = await assertTemporaryEvidencePath(options.evidenceDir, { mustExist: true });
  const capturePath = path.join(evidenceDir, 'capture.json');
  let record;
  try {
    record = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  } catch {
    throw proofError('visual_proof_capture_invalid');
  }
  if (
    record?.schema !== 'transcript-library-visual-proof-capture/v1' ||
    record?.status !== 'captured-awaiting-pixel-review' ||
    record?.evidence_dir !== evidenceDir ||
    !Array.isArray(record?.captures) ||
    record.captures.length !== Object.keys(SCENARIOS).length
  ) {
    throw proofError('visual_proof_capture_invalid');
  }
  const currentProvenance = await captureProvenance();
  if (!sameProvenance(record.provenance, currentProvenance)) throw proofError('visual_proof_stale_worktree');
  if (options.pixelReview !== 'pass' && options.pixelReview !== 'fail') {
    throw proofError('visual_proof_pixel_review_invalid');
  }
  const reviewer = parseReview(options.reviewer, 'reviewer', { min: 2, max: 128, pattern: /^[A-Za-z0-9._:-]+$/ });
  const reviewNote = parseReview(options.reviewNote, 'review_note', { min: 12, max: 500 });
  const manifests = [];
  for (const captured of record.captures) {
    const config = SCENARIOS[captured.scenario];
    if (!config || captured.inspection?.machineVerdict !== 'pass') {
      throw proofError('visual_proof_capture_invalid');
    }
    const screenshotBytes = await fs.readFile(captured.screenshot.path);
    if (sha256(screenshotBytes) !== captured.screenshot.sha256 || screenshotBytes.length !== captured.screenshot.bytes) {
      throw proofError('visual_proof_screenshot_stale');
    }
    const finalVerdict = options.pixelReview === 'pass' ? 'pass' : 'fail';
    const regionLabels = captured.inspection.regions.map(({ label }) => label);
    const manifest = {
      schema: 'visual-proof/v1',
      ticket: 'transcript-library-v0',
      run_id: record.run_id,
      captured_at: record.captured_at,
      screenshot: captured.screenshot,
      route: captured.route,
      viewport: captured.viewport,
      browser: captured.browser,
      capture_mode: 'hybrid-electron-fixture',
      provenance: record.provenance,
      fixture: {
        mode: 'contract-fixture',
        identity: captured.fixture,
        actual_product_surfaces: ['ui/control-center.html', 'ui/control-center.css', 'ui/control-center.js', 'ui/preload.cjs'],
        replaced_boundary: 'Electron main-process IPC responses only'
      },
      runtime: captured.runtime,
      interaction: captured.confirmation,
      inspection: {
        regions: captured.inspection.regions,
        objective_checks: objectiveChecks(captured.inspection),
        pixel_review: {
          verdict: options.pixelReview,
          reviewer,
          reviewed_at: new Date().toISOString(),
          note: reviewNote
        },
        summary_verdict: finalVerdict
      },
      ac_mapping: [{
        ac_id: captured.ac.id,
        claim: captured.ac.claim,
        evidence_regions: regionLabels,
        verdict: finalVerdict,
        evidence: finalVerdict === 'pass'
          ? 'Every named region and objective check passed, and the captured pixels received an explicit review.'
          : 'The explicit pixel review rejected this visual state.'
      }],
      privacy: {
        transcript_bodies_absent: true,
        raw_archive_paths_absent: true,
        forbidden_markers_absent: record.privacy.forbidden_markers_absent
      }
    };
    const manifestPath = path.join(evidenceDir, config.manifestName);
    await writePrivateJson(manifestPath, manifest);
    manifests.push({ path: manifestPath, verdict: finalVerdict, screenshot: captured.screenshot.path });
  }
  return {
    schemaVersion: 1,
    status: options.pixelReview === 'pass' ? 'verified' : 'rejected-by-pixel-review',
    evidenceDir,
    aggregate: {
      pass: manifests.filter(({ verdict }) => verdict === 'pass').length,
      fail: manifests.filter(({ verdict }) => verdict === 'fail').length,
      unknown: 0
    },
    manifests
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.mode === 'capture' ? await capture(options) : await finalize(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: 'fail', error: safeOutputError(error) })}\n`);
  process.exitCode = 1;
});
