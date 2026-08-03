import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { identityFromOwnedLocation } from '../conversation-identity.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../library-blob-store.mjs';
import { createPrivateFileSystem } from '../private-filesystem.mjs';
import { normalizeLiveCapture } from '../transcript-contract.mjs';
import { createTranscriptStore } from '../transcript-store.mjs';

function proxiedOperations(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function tempState(t, name) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-live-state-${name}-`));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function clockAt(second = 0) {
  let tick = second;
  return () => new Date(Date.UTC(2026, 6, 30, 12, 0, tick++)).toISOString();
}

function ids(prefix = 'test') {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function sourceInput({
  thread = 'state-thread',
  key = 'state-key',
  label = 'State fixture',
  scope = 'personal'
} = {}) {
  const location = locationFromConversationUrl(`https://chatgpt.com/c/${thread}`);
  return {
    identity: identityFromOwnedLocation(scope, location),
    label,
    tags: ['fixture'],
    key,
    target: { kind: 'owned-conversation', location }
  };
}

function completeCapture({
  thread = 'state-thread',
  capturedAt = '2026-07-30T12:00:10.000Z',
  firstText = 'State fixture prompt'
} = {}) {
  const rawTurns = [
    { ordinal: 0, providerMessageId: `${thread}-message-1`, role: 'user', text: firstText },
    { ordinal: 1, providerMessageId: `${thread}-message-2`, role: 'assistant', text: 'State fixture reply' }
  ];
  return {
    status: 'complete',
    conversationUrl: `https://chatgpt.com/c/${thread}`,
    capturedAt,
    rawTurns,
    evidence: {
      topBoundary: true,
      bottomBoundary: true,
      orderedWindowStitching: true,
      scrollPasses: 3,
      windowCount: 2,
      messageCount: rawTurns.length,
      providerIdCount: rawTurns.length,
      byteCount: rawTurns.reduce((total, turn) =>
        total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0)
    }
  };
}

function snapshotFor(capture = completeCapture(), scope = 'personal') {
  return makeTranscriptSnapshot({
    identity: identityFromOwnedLocation(scope, locationFromConversationUrl(capture.conversationUrl)),
    normalizedTranscript: normalizeLiveCapture(capture),
    origin: {
      kind: 'live-capture',
      conversationUrl: capture.conversationUrl,
      captureEvidence: capture.evidence
    },
    capturedAt: capture.capturedAt
  });
}

async function setupOpenAttempt(t, name = 'open') {
  const stateDir = await tempState(t, name);
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids(name) });
  const source = await store.register(sourceInput());
  const attempt = await store.beginAttempt(source.id);
  const snapshot = snapshotFor();
  const ref = await blobs.putSnapshot(snapshot);
  return { stateDir, blobs, store, source, attempt, snapshot, ref };
}

async function childProcess(file, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: path.dirname(file),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
  });
}

test('transcript store: complete commit atomically terminalizes the attempt and advances latest', async (t) => {
  const { stateDir, blobs, store, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'complete');

  assert.equal((await store.getSource(source.id)).latestLiveSnapshot, null);
  const result = await store.commitComplete(attempt.id, ref, snapshot.contentHash);

  assert.equal(result.status, 'complete');
  assert.equal(result.outcome.changed, true);
  assert.equal(result.source.latestLiveSnapshot.hash, ref.hash);
  const durable = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  const durableSource = durable.sources.find(({ id }) => id === source.id);
  const durableAttempt = durable.attempts.find(({ id }) => id === attempt.id);
  assert.equal(durableSource.latestLiveSnapshot.hash, ref.hash);
  assert.equal(durableAttempt.outcome.snapshot.hash, ref.hash);
  assert.equal(durableAttempt.outcome.kind, 'complete');
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(store.root)).mode & 0o777, 0o700);
  }

  const beforeRetry = await fs.readFile(store.statePath);
  const restarted = createTranscriptStore({ stateDir, blobs, clock: clockAt(30), randomId: ids('restart') });
  assert.equal((await restarted.list())[0].latestLiveSnapshot.hash, ref.hash);
  assert.equal((await restarted.commitComplete(attempt.id, ref, snapshot.contentHash)).status, 'complete');
  assert.deepEqual(await fs.readFile(store.statePath), beforeRetry);
});

test('transcript store: duplicate identities, keys, and concurrent attempts fail closed', async (t) => {
  const stateDir = await tempState(t, 'duplicates');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('duplicate') });
  const first = await store.register(sourceInput());

  await assert.rejects(() => store.register(sourceInput({ key: 'another-key' })), /transcript_source_exists/);
  await assert.rejects(() => store.register(sourceInput({ thread: 'other-thread', key: first.key })), /transcript_source_key_exists/);

  const starts = await Promise.allSettled([
    store.beginAttempt(first.id),
    store.beginAttempt(first.id)
  ]);
  assert.equal(starts.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(starts.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(starts.find(({ status }) => status === 'rejected').reason.code, 'transcript_sync_active');
});

test('transcript store: an owned private copy retains its canonical shared source URL', async (t) => {
  const stateDir = await tempState(t, 'shared-source');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('shared-source') });
  const input = sourceInput();
  input.target.location = locationFromConversationUrl('https://chatgpt.com/c/state-thread', {
    sourceUrl: 'https://chatgpt.com/share/shared-source'
  });

  const source = await store.register(input);
  assert.equal(source.target.location.sourceUrl, 'https://chatgpt.com/share/shared-source');
  const restarted = createTranscriptStore({ stateDir, blobs });
  assert.equal((await restarted.getSource(source.id)).target.location.sourceUrl, 'https://chatgpt.com/share/shared-source');
});

test('transcript store: partial, failed, and interrupted attempts never advance latest', async (t) => {
  const stateDir = await tempState(t, 'incomplete');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('incomplete') });
  const source = await store.register(sourceInput());

  const partial = await store.beginAttempt(source.id);
  const partialResult = await store.finishIncomplete(partial.id, {
    kind: 'partial', reason: 'conversation_top_not_reached'
  });
  assert.equal(partialResult.status, 'partial');
  assert.equal(partialResult.source.latestLiveSnapshot, null);
  assert.equal((await store.finishIncomplete(partial.id, {
    kind: 'partial', reason: 'conversation_top_not_reached'
  })).status, 'partial');
  await assert.rejects(() => store.finishIncomplete(partial.id, {
    kind: 'failed', reason: 'capture_failed'
  }), /transcript_attempt_already_finished/);

  const failed = await store.beginAttempt(source.id);
  assert.equal((await store.finishIncomplete(failed.id, {
    kind: 'failed', reason: 'navigation_failed'
  })).status, 'failed');
  assert.equal((await store.getSource(source.id)).latestLiveSnapshot, null);

  const interrupted = await store.beginAttempt(source.id);
  const restarted = createTranscriptStore({ stateDir, blobs, clock: clockAt(40), randomId: ids('recovered') });
  assert.equal(await restarted.recoverInterrupted(), 1);
  assert.equal((await restarted.getSource(source.id)).lastAttempt.id, interrupted.id);
  assert.equal((await restarted.getSource(source.id)).lastAttempt.outcome.kind, 'interrupted');
  assert.equal((await restarted.getSource(source.id)).latestLiveSnapshot, null);
  assert.equal(await restarted.recoverInterrupted(), 0);
});

test('transcript store: unchanged content advances to a newer immutable snapshot with changed false', async (t) => {
  const stateDir = await tempState(t, 'unchanged');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('unchanged') });
  const source = await store.register(sourceInput());

  const firstSnapshot = snapshotFor(completeCapture({ capturedAt: '2026-07-30T12:01:00.000Z' }));
  const firstRef = await blobs.putSnapshot(firstSnapshot);
  const firstAttempt = await store.beginAttempt(source.id);
  assert.equal((await store.commitComplete(firstAttempt.id, firstRef, firstSnapshot.contentHash)).outcome.changed, true);

  const newerSnapshot = snapshotFor(completeCapture({ capturedAt: '2026-07-30T12:02:00.000Z' }));
  const newerRef = await blobs.putSnapshot(newerSnapshot);
  assert.equal(newerSnapshot.contentHash, firstSnapshot.contentHash);
  assert.notEqual(newerRef.hash, firstRef.hash);
  const newerAttempt = await store.beginAttempt(source.id);
  const result = await store.commitComplete(newerAttempt.id, newerRef, newerSnapshot.contentHash);
  assert.equal(result.outcome.changed, false);
  assert.equal(result.source.latestLiveSnapshot.hash, newerRef.hash);
});

test('transcript store: missing, corrupt, and wrong-identity blobs cannot enter visible state', async (t) => {
  const { blobs, store, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'invalid-blob');
  const missing = { ...ref, hash: 'f'.repeat(64) };
  await assert.rejects(() => store.commitComplete(attempt.id, missing, snapshot.contentHash), /library_blob_not_found/);
  assert.equal((await store.getSource(source.id)).latestLiveSnapshot, null);

  await fs.writeFile(blobs.pathFor(ref), '{"tampered":true}', { mode: 0o600 });
  await assert.rejects(() => store.commitComplete(attempt.id, ref, snapshot.contentHash), /library_blob_corrupt/);
  assert.equal((await store.getSource(source.id)).latestLiveSnapshot, null);

  const otherSnapshot = snapshotFor(completeCapture({ thread: 'other-thread' }));
  const otherRef = await blobs.putSnapshot(otherSnapshot);
  await assert.rejects(() => store.commitComplete(attempt.id, otherRef, otherSnapshot.contentHash), /transcript_snapshot_identity_mismatch/);
  assert.equal((await store.getSource(source.id)).latestLiveSnapshot, null);
});

test('transcript store: rename failure before publication stays retryable in-process', async (t) => {
  const { stateDir, blobs, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'rename-before');
  let failRename = true;
  const operations = proxiedOperations({
    async rename(...args) {
      if (failRename) {
        failRename = false;
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return await fs.rename(...args);
    }
  });
  const uncertain = createTranscriptStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations }),
    clock: clockAt(50),
    randomId: ids('uncertain')
  });

  await assert.rejects(() => uncertain.commitComplete(attempt.id, ref, snapshot.contentHash), /transcript_store_io/);
  assert.equal((await uncertain.getSource(source.id)).state, 'syncing');
  assert.equal((await uncertain.getSource(source.id)).latestLiveSnapshot, null);
  assert.equal((await uncertain.commitComplete(attempt.id, ref, snapshot.contentHash)).status, 'complete');
  assert.equal((await uncertain.getSource(source.id)).latestLiveSnapshot.hash, ref.hash);
  assert.deepEqual(await blobs.getSnapshot(ref), snapshot);
});

test('transcript store: a rename that lands before reporting failure is reconciled in-process', async (t) => {
  const { stateDir, blobs, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'rename-after');
  let inject = true;
  const operations = proxiedOperations({
    async rename(...args) {
      await fs.rename(...args);
      if (inject) {
        inject = false;
        throw Object.assign(new Error('injected ambiguous rename'), { code: 'EIO' });
      }
    }
  });
  const uncertain = createTranscriptStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations }),
    clock: clockAt(70),
    randomId: ids('uncertain')
  });
  const committed = await uncertain.commitComplete(attempt.id, ref, snapshot.contentHash);
  assert.equal(committed.status, 'complete');
  const visible = await uncertain.getSource(source.id);
  assert.equal(visible.state, 'complete');
  assert.equal(visible.latestLiveSnapshot.hash, ref.hash);
  assert.equal((await uncertain.commitComplete(attempt.id, ref, snapshot.contentHash)).status, 'complete');
});

test('transcript store: genuinely uncertain replacement reloads durable state on the next operation', async (t) => {
  const { stateDir, blobs, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'reload-uncertain');
  let injectRename = true;
  let injectRead = false;
  const operations = proxiedOperations({
    async rename(...args) {
      await fs.rename(...args);
      if (injectRename) {
        injectRename = false;
        injectRead = true;
        throw Object.assign(new Error('injected ambiguous rename'), { code: 'EIO' });
      }
    },
    async lstat(...args) {
      if (injectRead) {
        injectRead = false;
        throw Object.assign(new Error('injected reconciliation read failure'), { code: 'EIO' });
      }
      return await fs.lstat(...args);
    }
  });
  const uncertain = createTranscriptStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations }),
    clock: clockAt(75),
    randomId: ids('reload-uncertain')
  });

  await assert.rejects(() => uncertain.commitComplete(attempt.id, ref, snapshot.contentHash), /transcript_store_io/);
  const visible = await uncertain.getSource(source.id);
  assert.equal(visible.state, 'complete');
  assert.equal(visible.latestLiveSnapshot.hash, ref.hash);
});

test('transcript store: interrupted recovery itself is retryable across a rename failure', async (t) => {
  const { stateDir, blobs, source } = await setupOpenAttempt(t, 'recover-retry');
  let failRename = true;
  const operations = proxiedOperations({
    async rename(...args) {
      if (failRename) {
        failRename = false;
        throw Object.assign(new Error('injected recovery rename'), { code: 'EIO' });
      }
      return await fs.rename(...args);
    }
  });
  const failing = createTranscriptStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations }),
    clock: clockAt(90),
    randomId: ids('failing')
  });
  await assert.rejects(() => failing.recoverInterrupted(), /transcript_store_io/);
  assert.equal((await failing.getSource(source.id)).state, 'syncing');
  assert.equal(await failing.recoverInterrupted(), 1);
  assert.equal((await failing.getSource(source.id)).state, 'interrupted');
});

test('transcript store: corrupt and unsupported durable state fail closed without rewriting bytes', async (t) => {
  const stateDir = await tempState(t, 'corrupt-state');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('corrupt') });
  await store.register(sourceInput());

  const valid = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  const corruptBytes = Buffer.from(JSON.stringify({ ...valid, unexpected: true }));
  await fs.writeFile(store.statePath, corruptBytes, { mode: 0o600 });
  const corrupt = createTranscriptStore({ stateDir, blobs });
  await assert.rejects(() => corrupt.load(), /transcript_store_corrupt_state/);
  assert.deepEqual(await fs.readFile(store.statePath), corruptBytes);

  const unsupportedBytes = Buffer.from(JSON.stringify({ ...valid, schemaVersion: 99 }));
  await fs.writeFile(store.statePath, unsupportedBytes, { mode: 0o600 });
  const unsupported = createTranscriptStore({ stateDir, blobs });
  await assert.rejects(() => unsupported.load(), /transcript_store_schema_unsupported/);
  assert.deepEqual(await fs.readFile(store.statePath), unsupportedBytes);
});

test('transcript store: filesystem read failures remain IO errors and contain no state bytes', async (t) => {
  const stateDir = await tempState(t, 'read-io');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('read-io') });
  await initial.register(sourceInput());
  const operations = proxiedOperations({
    async open(filePath, ...args) {
      if (filePath === initial.statePath) {
        throw Object.assign(new Error('injected read failure with no payload'), { code: 'EIO' });
      }
      return await fs.open(filePath, ...args);
    }
  });
  const failing = createTranscriptStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations })
  });
  await assert.rejects(() => failing.load(), (error) => {
    assert.equal(error.code, 'transcript_store_io');
    assert.equal(error.message, 'transcript_store_io');
    return true;
  });
});

test('transcript store: latest and attempt history are derived invariants on restart', async (t) => {
  const { stateDir, blobs, store } = await setupOpenAttempt(t, 'history-drift');
  const raw = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  raw.sources[0].lastAttemptId = null;
  await fs.writeFile(store.statePath, JSON.stringify(raw), { mode: 0o600 });
  await assert.rejects(
    () => createTranscriptStore({ stateDir, blobs }).load(),
    /transcript_store_corrupt_state/
  );
});

test('transcript store: an open attempt cannot precede a later terminal attempt', async (t) => {
  const { stateDir, blobs, store, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'open-order');
  await store.commitComplete(attempt.id, ref, snapshot.contentHash);
  const open = await store.beginAttempt(source.id);
  const raw = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  const completeAttempt = raw.attempts.find(({ id }) => id === attempt.id);
  const openAttempt = raw.attempts.find(({ id }) => id === open.id);
  raw.attempts = [openAttempt, completeAttempt];
  raw.sources[0].lastAttemptId = completeAttempt.id;
  await fs.writeFile(store.statePath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  await assert.rejects(
    () => createTranscriptStore({ stateDir, blobs }).load(),
    /transcript_store_corrupt_state/
  );
});

test('transcript store: abandoned temp metadata is invisible and a symlink state file is rejected', async (t) => {
  const stateDir = await tempState(t, 'temp-and-link');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const root = path.join(stateDir, 'transcript-library', 'live');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, '.state.json.tmp-abandoned'), '{"private":"fixture"}', { mode: 0o600 });
  const clean = createTranscriptStore({ stateDir, blobs });
  assert.deepEqual(await clean.list(), []);

  const target = path.join(root, 'outside-state.json');
  await fs.writeFile(target, '{}', { mode: 0o600 });
  await fs.symlink(target, clean.statePath);
  const linked = createTranscriptStore({ stateDir, blobs });
  await assert.rejects(() => linked.load(), /transcript_store_corrupt_state/);
});

test('transcript store: local forget moves metadata to a recoverable tombstone and leaves blobs', async (t) => {
  const { blobs, store, source, attempt, snapshot, ref } = await setupOpenAttempt(t, 'forget');
  await store.commitComplete(attempt.id, ref, snapshot.contentHash);

  const forgotten = await store.forget(source.id);
  assert.equal(forgotten.recoverable, true);
  assert.match(forgotten.recoveryLocation, /^local-trash\/deleted-/);
  assert.deepEqual(await store.list(), []);
  const deleted = await store.listDeleted();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].source.id, source.id);
  assert.equal(deleted[0].attempts[0].outcome.kind, 'complete');
  assert.deepEqual(await blobs.getSnapshot(ref), snapshot);
});

test('transcript store: a real subprocess crash after blob publication recovers an interrupted attempt', async (t) => {
  const stateDir = await tempState(t, 'subprocess');
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript-store-crash-child.mjs');
  const child = await childProcess(fixture, [stateDir]);

  assert.equal(child.code, 73, child.stderr);
  assert.equal(child.signal, null);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');

  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const restarted = createTranscriptStore({ stateDir, blobs, clock: clockAt(110), randomId: ids('parent') });
  const before = await restarted.list();
  assert.equal(before.length, 1);
  assert.equal(before[0].state, 'syncing');
  assert.equal(before[0].latestLiveSnapshot, null);
  const snapshotDirectory = path.join(blobs.root, 'snapshot', 'sha256');
  const blobNames = await fs.readdir(snapshotDirectory, { recursive: true });
  assert.equal(blobNames.filter((name) => String(name).endsWith('.json')).length, 1);

  assert.equal(await restarted.recoverInterrupted(), 1);
  const after = await createTranscriptStore({ stateDir, blobs }).list();
  assert.equal(after[0].state, 'interrupted');
  assert.equal(after[0].latestLiveSnapshot, null);
});

test('transcript store: every write reserves room to terminalize accepted open attempts', async (t) => {
  const probeStateDir = await tempState(t, 'terminal-reserve-probe');
  const probeBlobs = createPrivateLibraryBlobStore({ stateDir: probeStateDir });
  const probe = createTranscriptStore({
    stateDir: probeStateDir,
    blobs: probeBlobs,
    clock: clockAt(),
    randomId: ids('terminal-reserve')
  });
  const probeSource = await probe.register(sourceInput());
  await probe.beginAttempt(probeSource.id);
  await probe.register(sourceInput({
    thread: 'second-state-thread',
    key: 'second-state-key',
    label: 'Second state fixture'
  }));
  const byteLimit = (await fs.stat(probe.statePath)).size;

  const stateDir = await tempState(t, 'terminal-reserve-limited');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({
    stateDir,
    blobs,
    clock: clockAt(),
    randomId: ids('terminal-reserve'),
    maxStateBytes: byteLimit
  });
  const source = await store.register(sourceInput());
  await store.beginAttempt(source.id);

  await assert.rejects(
    () => store.register(sourceInput({
      thread: 'second-state-thread',
      key: 'second-state-key',
      label: 'Second state fixture'
    })),
    /transcript_store_size_limit/
  );
  assert.ok((await fs.stat(store.statePath)).size <= byteLimit);

  const restarted = createTranscriptStore({
    stateDir,
    blobs,
    clock: clockAt(120),
    randomId: ids('terminal-reserve-restart'),
    maxStateBytes: byteLimit
  });
  assert.equal(await restarted.recoverInterrupted(), 1);
  assert.equal((await restarted.getSource(source.id)).state, 'interrupted');
  assert.ok((await fs.stat(restarted.statePath)).size <= byteLimit);
});
