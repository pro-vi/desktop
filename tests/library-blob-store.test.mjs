import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { identityFromOwnedLocation } from '../conversation-identity.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../library-blob-store.mjs';
import { createPrivateFileSystem } from '../private-filesystem.mjs';
import {
  normalizeArchiveConversation,
  normalizeLiveCapture
} from '../transcript-contract.mjs';

function proxiedOperations(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tempState(t, name) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-library-${name}-`));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function completeCapture({ capturedAt = '2026-07-30T12:00:00.000Z', text = 'Hello transcript' } = {}) {
  const rawTurns = [
    { ordinal: 0, providerMessageId: 'message-1', role: 'user', text },
    { ordinal: 1, providerMessageId: 'message-2', role: 'assistant', text: 'Stored reply' }
  ];
  return {
    status: 'complete',
    conversationUrl: 'https://chatgpt.com/c/blob-thread',
    capturedAt,
    rawTurns,
    evidence: {
      topBoundary: true,
      bottomBoundary: true,
      orderedWindowStitching: true,
      scrollPasses: 4,
      windowCount: 3,
      messageCount: rawTurns.length,
      providerIdCount: rawTurns.length,
      byteCount: rawTurns.reduce((total, turn) =>
        total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0)
    }
  };
}

function snapshotFor(capture = completeCapture()) {
  return makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl(capture.conversationUrl)),
    normalizedTranscript: normalizeLiveCapture(capture),
    origin: {
      kind: 'live-capture',
      conversationUrl: capture.conversationUrl,
      captureEvidence: capture.evidence
    },
    capturedAt: capture.capturedAt
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withNullableRawRole(normalizedTranscript, ordinal) {
  const turns = normalizedTranscript.turns.map((turn, index) => index === ordinal
    ? { ...turn, role: 'unknown', rawRole: null }
    : turn);
  return {
    ...normalizedTranscript,
    turns,
    contentHash: crypto.createHash('sha256').update(canonicalJson({
      normalizationVersion: normalizedTranscript.normalizationVersion,
      turns
    })).digest('hex')
  };
}

async function allNames(root) {
  try {
    return await fs.readdir(root, { recursive: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

test('library blob store: raw and snapshot writes are private immutable and idempotent', async (t) => {
  const stateDir = await tempState(t, 'idempotent');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const rawBytes = Buffer.from('{"safe":"archive-record"}');
  const snapshot = snapshotFor();

  const [rawA, rawB] = await Promise.all([store.putRaw(rawBytes), store.putRaw(rawBytes)]);
  const [snapshotA, snapshotB] = await Promise.all([store.putSnapshot(snapshot), store.putSnapshot(snapshot)]);

  assert.deepEqual(rawB, rawA);
  assert.deepEqual(snapshotB, snapshotA);
  assert.deepEqual(await store.getRaw(rawA), rawBytes);
  assert.deepEqual(await store.getSnapshot(snapshotA), snapshot);
  assert.equal((await fs.stat(store.pathFor(rawA))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.pathFor(snapshotA))).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    for (const directory of [
      path.join(stateDir, 'transcript-library'),
      store.root,
      path.join(store.root, 'raw'),
      path.join(store.root, 'raw', 'sha256'),
      path.join(store.root, 'snapshot'),
      path.join(store.root, 'snapshot', 'sha256'),
      path.dirname(store.pathFor(rawA)),
      path.dirname(store.pathFor(snapshotA))
    ]) {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700, directory);
    }
  }
  assert.equal((await allNames(store.root)).filter((name) => String(name).includes('.tmp-')).length, 0);
});

test('library blob store: canonical snapshots are stable across object key insertion order', async (t) => {
  const stateDir = await tempState(t, 'canonical');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor();
  const reordered = {
    turns: snapshot.turns,
    capturedAt: snapshot.capturedAt,
    origin: snapshot.origin,
    normalizationVersion: snapshot.normalizationVersion,
    contentHash: snapshot.contentHash,
    identity: snapshot.identity,
    characterCount: snapshot.characterCount,
    snapshotHash: snapshot.snapshotHash,
    schemaVersion: snapshot.schemaVersion
  };

  assert.deepEqual(await store.putSnapshot(reordered), await store.putSnapshot(snapshot));
});

test('library blob store: immutable snapshot parsing preserves a canonical null raw role', async (t) => {
  const stateDir = await tempState(t, 'nullable-raw-role');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const capture = completeCapture();
  const normalizedTranscript = withNullableRawRole(normalizeLiveCapture(capture), 1);
  const snapshot = makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl(capture.conversationUrl)),
    normalizedTranscript,
    origin: {
      kind: 'live-capture',
      conversationUrl: capture.conversationUrl,
      captureEvidence: capture.evidence
    },
    capturedAt: capture.capturedAt
  });

  const ref = await store.putSnapshot(snapshot);
  assert.deepEqual(await store.getSnapshot(ref), snapshot);
  assert.equal((await store.getSnapshot(ref)).turns[1].rawRole, null);
  assert.equal(JSON.parse(await fs.readFile(store.pathFor(ref), 'utf8')).turns[1].rawRole, null);

  await assert.rejects(
    () => store.putSnapshot({
      ...snapshot,
      turns: snapshot.turns.map((turn, index) => index === 1 ? { ...turn, role: 'assistant' } : turn)
    }),
    /library_blob_invalid_snapshot/
  );
});

test('library blob store: injected hash collision never overwrites immutable bytes', async (t) => {
  const stateDir = await tempState(t, 'collision');
  const store = createPrivateLibraryBlobStore({ stateDir, hashBytes: () => 'a'.repeat(64) });
  const first = await store.putRaw(Buffer.from('first immutable record'));
  const before = await fs.readFile(store.pathFor(first));

  await assert.rejects(() => store.putRaw(Buffer.from('different immutable record')), /library_blob_hash_collision/);

  assert.deepEqual(await fs.readFile(store.pathFor(first)), before);
});

test('library blob store: an injected snapshot hash collision never overwrites the first snapshot', async (t) => {
  const stateDir = await tempState(t, 'snapshot-collision');
  const constantHash = () => 'd'.repeat(64);
  const store = createPrivateLibraryBlobStore({ stateDir, hashBytes: constantHash });
  const firstSnapshot = makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl('https://chatgpt.com/c/blob-thread')),
    normalizedTranscript: normalizeLiveCapture(completeCapture()),
    origin: {
      kind: 'live-capture',
      conversationUrl: 'https://chatgpt.com/c/blob-thread',
      captureEvidence: completeCapture().evidence
    },
    capturedAt: '2026-07-30T12:00:00.000Z'
  }, { hashBytes: constantHash });
  const changedCapture = completeCapture({ text: 'Different normalized transcript' });
  const changedSnapshot = makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl(changedCapture.conversationUrl)),
    normalizedTranscript: normalizeLiveCapture(changedCapture),
    origin: {
      kind: 'live-capture',
      conversationUrl: changedCapture.conversationUrl,
      captureEvidence: changedCapture.evidence
    },
    capturedAt: changedCapture.capturedAt
  }, { hashBytes: constantHash });
  const firstRef = await store.putSnapshot(firstSnapshot);
  const before = await fs.readFile(store.pathFor(firstRef));

  await assert.rejects(() => store.putSnapshot(changedSnapshot), /library_blob_hash_collision/);
  assert.deepEqual(await fs.readFile(store.pathFor(firstRef)), before);
});

test('library blob store: corruption and unsupported schema fail distinctly on verified read', async (t) => {
  const stateDir = await tempState(t, 'corrupt');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const ref = await store.putSnapshot(snapshotFor());
  await fs.writeFile(store.pathFor(ref), Buffer.from('{"schemaVersion":1,"tampered":true}'), { mode: 0o600 });
  await assert.rejects(() => store.getSnapshot(ref), /library_blob_corrupt/);

  const unsupportedRef = {
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    byteLength: Buffer.byteLength('{"schemaVersion":2}')
  };
  const unsupportedPath = store.pathFor(unsupportedRef);
  await fs.mkdir(path.dirname(unsupportedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(unsupportedPath, '{"schemaVersion":2}', { mode: 0o600 });
  await assert.rejects(() => store.getSnapshot(unsupportedRef), /library_blob_schema_unsupported/);

  const unsupportedNormalizationBytes = Buffer.from(JSON.stringify({
    ...snapshotFor(),
    normalizationVersion: 2
  }));
  const unsupportedNormalizationRef = {
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: 'e'.repeat(64),
    contentHash: snapshotFor().contentHash,
    byteLength: unsupportedNormalizationBytes.length
  };
  const unsupportedNormalizationPath = store.pathFor(unsupportedNormalizationRef);
  await fs.mkdir(path.dirname(unsupportedNormalizationPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(unsupportedNormalizationPath, unsupportedNormalizationBytes, { mode: 0o600 });
  await assert.rejects(
    () => store.getSnapshot(unsupportedNormalizationRef),
    /library_blob_schema_unsupported/
  );
});

test('library blob store: snapshot replay preserves an unsupported-schema error', async (t) => {
  const stateDir = await tempState(t, 'unsupported-replay');
  const constantHash = () => 'f'.repeat(64);
  const store = createPrivateLibraryBlobStore({ stateDir, hashBytes: constantHash });
  const capture = completeCapture();
  const snapshot = makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl(capture.conversationUrl)),
    normalizedTranscript: normalizeLiveCapture(capture),
    origin: {
      kind: 'live-capture',
      conversationUrl: capture.conversationUrl,
      captureEvidence: capture.evidence
    },
    capturedAt: capture.capturedAt
  }, { hashBytes: constantHash });
  const unsupportedBytes = Buffer.from('{"schemaVersion":2}');
  const existingPath = store.pathFor({
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: snapshot.snapshotHash,
    contentHash: snapshot.contentHash,
    byteLength: unsupportedBytes.length
  });
  await fs.mkdir(path.dirname(existingPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(existingPath, unsupportedBytes, { mode: 0o600 });

  await assert.rejects(() => store.putSnapshot(snapshot), (error) => {
    assert.equal(error.code, 'library_blob_schema_unsupported');
    assert.equal(error.message, 'library_blob_schema_unsupported');
    return true;
  });
  assert.deepEqual(await fs.readFile(existingPath), unsupportedBytes);
});

test('library blob store: archive branch evidence shares the U1 provider-message-id boundary', async (t) => {
  const stateDir = await tempState(t, 'provider-id-boundary');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const firstId = `a${'x'.repeat(510)}1`;
  const activeNodeId = `a${'y'.repeat(510)}2`;
  const rawTurns = [
    { ordinal: 0, providerMessageId: firstId, role: 'user', text: 'Archive boundary fixture' },
    { ordinal: 1, providerMessageId: activeNodeId, role: 'assistant', text: 'Archive boundary reply' }
  ];
  const rawRecord = await store.putRaw(Buffer.from('{"bounded":"record"}'));
  const snapshot = makeTranscriptSnapshot({
    identity: identityFromOwnedLocation('personal', locationFromConversationUrl('https://chatgpt.com/c/archive-boundary')),
    normalizedTranscript: normalizeArchiveConversation({ status: 'complete', rawTurns }),
    origin: {
      kind: 'chatgpt-export',
      importId: 'import-boundary',
      rawRecord,
      branchEvidence: {
        kind: 'active-node-chain',
        activeNodeId,
        messageIds: [firstId, activeNodeId]
      }
    },
    capturedAt: '2026-07-30T12:00:00.000Z'
  });

  const ref = await store.putSnapshot(snapshot);
  assert.deepEqual(await store.getSnapshot(ref), snapshot);
});

test('library blob store: temp write failure cleans up and a restart can retry', async (t) => {
  const stateDir = await tempState(t, 'write-failure');
  let failWrite = true;
  const operations = proxiedOperations({
    async open(...args) {
      const handle = await fs.open(...args);
      if (args[1] !== 'wx') return handle;
      return {
        writeFile: async (...writeArgs) => {
          if (failWrite) {
            failWrite = false;
            throw Object.assign(new Error('injected'), { code: 'ENOSPC' });
          }
          return await handle.writeFile(...writeArgs);
        },
        sync: async () => await handle.sync(),
        close: async () => await handle.close()
      };
    }
  });
  const failing = createPrivateLibraryBlobStore({
    stateDir,
    fileSystem: createPrivateFileSystem({ operations })
  });

  await assert.rejects(() => failing.putRaw(Buffer.from('retryable bytes')), /library_blob_io/);
  assert.equal((await allNames(path.join(stateDir, 'transcript-library'))).some((name) => String(name).includes('.tmp-')), false);

  const restarted = createPrivateLibraryBlobStore({ stateDir });
  const ref = await restarted.putRaw(Buffer.from('retryable bytes'));
  assert.deepEqual(await restarted.getRaw(ref), Buffer.from('retryable bytes'));
});

test('library blob store: publish failure leaves no visible final and retry succeeds', async (t) => {
  const stateDir = await tempState(t, 'publish-failure');
  let failLink = true;
  const operations = proxiedOperations({
    async link(...args) {
      if (failLink) {
        failLink = false;
        throw Object.assign(new Error('injected'), { code: 'EIO' });
      }
      return await fs.link(...args);
    }
  });
  const failing = createPrivateLibraryBlobStore({
    stateDir,
    fileSystem: createPrivateFileSystem({ operations })
  });
  await assert.rejects(() => failing.putRaw(Buffer.from('publish retry')), /library_blob_io/);
  assert.equal((await allNames(path.join(stateDir, 'transcript-library'))).some((name) => String(name).endsWith('.blob')), false);

  const restarted = createPrivateLibraryBlobStore({ stateDir });
  const ref = await restarted.putRaw(Buffer.from('publish retry'));
  assert.deepEqual(await restarted.getRaw(ref), Buffer.from('publish retry'));
});

test('library blob store: symlink and hard-link substitutions are rejected', async (t) => {
  const stateDir = await tempState(t, 'links');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const hardRef = await store.putRaw(Buffer.from('hard-link bytes'));
  const hardAlias = `${store.pathFor(hardRef)}.alias`;
  await fs.link(store.pathFor(hardRef), hardAlias);
  await assert.rejects(() => store.getRaw(hardRef), /library_blob_corrupt/);
  await fs.unlink(hardAlias);
  assert.deepEqual(await store.getRaw(hardRef), Buffer.from('hard-link bytes'));

  const symlinkRef = await store.putRaw(Buffer.from('symlink bytes'));
  const target = `${store.pathFor(symlinkRef)}.target`;
  await fs.rename(store.pathFor(symlinkRef), target);
  await fs.symlink(target, store.pathFor(symlinkRef));
  await assert.rejects(() => store.getRaw(symlinkRef), /library_blob_corrupt/);
});

test('library blob store: replay settles only a crashed publisher temp hard link', async (t) => {
  const stateDir = await tempState(t, 'settle-temp-link');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const bytes = Buffer.from('publisher crash replay');
  const ref = await store.putRaw(bytes);
  const finalPath = store.pathFor(ref);
  const abandonedTemp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tmp-999-abandoned`);
  await fs.link(finalPath, abandonedTemp);

  await assert.rejects(() => store.getRaw(ref), /library_blob_corrupt/);
  assert.deepEqual(await store.putRaw(bytes), ref);
  assert.deepEqual(await store.getRaw(ref), bytes);
  await assert.rejects(() => fs.lstat(abandonedTemp), { code: 'ENOENT' });
});

test('library blob store: independent writers racing from missing remain idempotent', async (t) => {
  const stateDir = await tempState(t, 'independent-race');
  const secondObservedMissing = deferred();
  const firstLinked = deferred();
  const releaseFirst = deferred();
  const firstOperations = proxiedOperations({
    async link(...args) {
      await fs.link(...args);
      firstLinked.resolve();
      await releaseFirst.promise;
    }
  });
  const firstBase = createPrivateFileSystem({ operations: firstOperations });
  const secondBase = createPrivateFileSystem();
  const firstFileSystem = Object.freeze({
    ...firstBase,
    async pathKind(filePath, options) {
      const result = await firstBase.pathKind(filePath, options);
      if (result === 'missing' && filePath.endsWith('.blob')) await secondObservedMissing.promise;
      return result;
    }
  });
  const secondFileSystem = Object.freeze({
    ...secondBase,
    async pathKind(filePath, options) {
      const result = await secondBase.pathKind(filePath, options);
      if (result === 'missing' && filePath.endsWith('.blob')) {
        secondObservedMissing.resolve();
        await firstLinked.promise;
      }
      return result;
    }
  });
  const first = createPrivateLibraryBlobStore({ stateDir, fileSystem: firstFileSystem });
  const second = createPrivateLibraryBlobStore({ stateDir, fileSystem: secondFileSystem });
  const bytes = Buffer.from('independent writer race');

  const firstPut = first.putRaw(bytes);
  const secondPut = second.putRaw(bytes);
  const secondOutcome = await secondPut.then(
    (ref) => ({ status: 'fulfilled', ref }),
    (error) => ({ status: 'rejected', error })
  );
  releaseFirst.resolve();
  const firstRef = await firstPut;

  assert.equal(secondOutcome.status, 'fulfilled', secondOutcome.error?.code);
  const secondRef = secondOutcome.ref;
  assert.deepEqual(firstRef, secondRef);
  assert.deepEqual(await first.getRaw(firstRef), bytes);
  assert.deepEqual(await second.getRaw(secondRef), bytes);
});

test('library blob store: insecure file modes and a symlinked library directory fail closed', async (t) => {
  const stateDir = await tempState(t, 'private-boundary');
  const store = createPrivateLibraryBlobStore({ stateDir });
  const ref = await store.putRaw(Buffer.from('private mode fixture'));
  if (process.platform !== 'win32') {
    await fs.chmod(store.pathFor(ref), 0o644);
    await assert.rejects(() => store.getRaw(ref), /library_blob_corrupt/);
    await fs.chmod(store.pathFor(ref), 0o600);
  }

  const linkedStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-library-linked-'));
  t.after(async () => await fs.rm(linkedStateDir, { recursive: true, force: true }));
  const outside = path.join(linkedStateDir, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, path.join(linkedStateDir, 'transcript-library'));
  const linked = createPrivateLibraryBlobStore({ stateDir: linkedStateDir });
  await assert.rejects(() => linked.putRaw(Buffer.from('must not escape')), /library_blob_corrupt/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('library blob store: a mode change between path check and file open fails closed', async (t) => {
  const stateDir = await tempState(t, 'mode-race');
  const initial = createPrivateLibraryBlobStore({ stateDir });
  const ref = await initial.putRaw(Buffer.from('mode race fixture'));
  const finalPath = initial.pathFor(ref);
  let changedMode = false;
  const operations = proxiedOperations({
    async open(filePath, ...args) {
      if (filePath === finalPath && !changedMode) {
        changedMode = true;
        await fs.chmod(finalPath, 0o644);
      }
      return await fs.open(filePath, ...args);
    }
  });
  const raced = createPrivateLibraryBlobStore({
    stateDir,
    fileSystem: createPrivateFileSystem({ operations })
  });

  await assert.rejects(() => raced.getRaw(ref), /library_blob_corrupt/);
  assert.equal(changedMode, true);
});

test('library blob store: post-initialization ancestor substitution cannot redirect a write', async (t) => {
  const stateDir = await tempState(t, 'ancestor-substitution');
  const store = createPrivateLibraryBlobStore({ stateDir });
  await store.putRaw(Buffer.from('establish trusted layout'));
  const shaDirectory = path.join(store.root, 'raw', 'sha256');
  const displaced = path.join(store.root, 'raw', 'sha256-displaced');
  const outside = path.join(stateDir, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.rename(shaDirectory, displaced);
  await fs.symlink(outside, shaDirectory);

  await assert.rejects(() => store.putRaw(Buffer.from('must remain inside')), /library_blob_corrupt/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('library blob store: first-use directory sync failure is reported and retry repairs durability', async (t) => {
  const stateDir = await tempState(t, 'directory-sync');
  let failDirectorySync = true;
  const operations = proxiedOperations({
    async open(filePath, ...args) {
      const handle = await fs.open(filePath, ...args);
      if (filePath !== stateDir || !failDirectorySync) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              failDirectorySync = false;
              throw Object.assign(new Error('injected directory sync failure'), { code: 'EPERM' });
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  });
  const failing = createPrivateLibraryBlobStore({
    stateDir,
    fileSystem: createPrivateFileSystem({ operations })
  });
  await assert.rejects(() => failing.putRaw(Buffer.from('first durable write')), /library_blob_io/);

  const restarted = createPrivateLibraryBlobStore({ stateDir });
  const ref = await restarted.putRaw(Buffer.from('first durable write'));
  assert.deepEqual(await restarted.getRaw(ref), Buffer.from('first durable write'));
});

test('library blob store: retry re-syncs a final blob whose publication sync was ambiguous', async (t) => {
  const stateDir = await tempState(t, 'publication-sync');
  let prefixSyncAttempts = 0;
  const operations = proxiedOperations({
    async open(filePath, ...args) {
      const handle = await fs.open(filePath, ...args);
      const isRawHashPrefix = path.dirname(filePath).endsWith(path.join('raw', 'sha256')) &&
        /^[a-f0-9]{2}$/.test(path.basename(filePath));
      if (!isRawHashPrefix) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              prefixSyncAttempts += 1;
              if (prefixSyncAttempts === 1) {
                throw Object.assign(new Error('injected publication sync ambiguity'), { code: 'EIO' });
              }
              return await target.sync();
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  });
  const store = createPrivateLibraryBlobStore({
    stateDir,
    fileSystem: createPrivateFileSystem({ operations })
  });
  const bytes = Buffer.from('ambiguous publication sync');
  await assert.rejects(() => store.putRaw(bytes), /library_blob_io/);
  const ref = await store.putRaw(bytes);

  assert.equal(prefixSyncAttempts, 2);
  assert.deepEqual(await store.getRaw(ref), bytes);
});

test('library blob store: a restarted store verifies and reuses an orphan snapshot', async (t) => {
  const stateDir = await tempState(t, 'restart');
  const first = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor();
  const ref = await first.putSnapshot(snapshot);

  const restarted = createPrivateLibraryBlobStore({ stateDir });
  assert.deepEqual(await restarted.getSnapshot(ref), snapshot);
  assert.deepEqual(await restarted.putSnapshot(snapshot), ref);
});
