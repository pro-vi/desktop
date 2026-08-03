import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  closeGrantedArchive,
  createChatGptExportReader,
  createGrantedArchiveFromFileHandle
} from '../chatgpt-export-reader.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import { createConversationCatalogService } from '../conversation-catalog-sync.mjs';
import { createConversationCatalogStore } from '../conversation-catalog-store.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../library-blob-store.mjs';
import { createPrivateFileSystem } from '../private-filesystem.mjs';
import {
  TRANSCRIPT_TURN_MAX_TEXT_CHARS,
  normalizeLiveCapture
} from '../transcript-contract.mjs';
import { createTranscriptReadService } from '../transcript-read.mjs';
import { buildZip, crc32 } from './fixtures/zip-archive.mjs';

const PROFILE_SCOPE_ID = 'profile-main';
const OTHER_PROFILE_SCOPE_ID = 'profile-other';
const CREATED_AT = '2026-07-31T12:00:00.000Z';
const CREATED_AT_SECONDS = Date.parse(CREATED_AT) / 1000;
const OBSERVED_AT = '2026-07-31T12:05:00.000Z';
const OBSERVED_AT_SECONDS = Date.parse(OBSERVED_AT) / 1000;
const VERIFIED_AT = '2026-07-31T12:10:00.000Z';

function identity(providerConversationId, profileScopeId = PROFILE_SCOPE_ID) {
  return { provider: 'chatgpt', profileScopeId, providerConversationId };
}

function message(id, role, text) {
  return {
    id,
    author: { role, name: null, metadata: {} },
    create_time: CREATED_AT_SECONDS,
    update_time: null,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all'
  };
}

function conversationRecord({
  conversationId = 'catalog-sync-thread',
  title = `Conversation ${conversationId}`,
  userText = 'A harmless import fixture prompt',
  assistantText = 'A harmless import fixture reply',
  ambiguous = false
} = {}) {
  const rootId = `${conversationId}-root`;
  const userId = `${conversationId}-user`;
  const assistantId = `${conversationId}-assistant`;
  return {
    id: conversationId,
    conversation_id: conversationId,
    title,
    create_time: CREATED_AT_SECONDS,
    update_time: OBSERVED_AT_SECONDS,
    current_node: ambiguous ? null : assistantId,
    mapping: {
      [rootId]: { id: rootId, message: null, parent: null, children: [userId] },
      [userId]: {
        id: userId,
        message: message(userId, 'user', userText),
        parent: rootId,
        children: [assistantId]
      },
      [assistantId]: {
        id: assistantId,
        message: message(assistantId, 'assistant', assistantText),
        parent: userId,
        children: []
      }
    },
    is_archived: false
  };
}

function recordsJson(records) {
  return Buffer.from(`[${records.map((record) => JSON.stringify(record)).join(',')}]`);
}

function exportZip(records, { accountId = null, extraEntries = [], method = 'deflate' } = {}) {
  const entries = [
    { name: 'conversations.json', data: recordsJson(records), method },
    ...extraEntries
  ];
  if (accountId !== null) {
    entries.push({
      name: 'user.json',
      data: JSON.stringify({ id: accountId, email: 'private@example.test' }),
      method: 'deflate'
    });
  }
  return buildZip(entries);
}

function safeError(error, forbidden = []) {
  assert.equal(typeof error?.code, 'string');
  const exposed = `${error.message}\n${JSON.stringify(error.data ?? null)}`;
  for (const marker of forbidden) assert.equal(exposed.includes(marker), false);
  return true;
}

function proxiedOperations(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

async function temporaryDirectory(t, label) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-catalog-sync-${label}-`));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function createGrantPort(t, directory) {
  const grants = new Map();
  const failures = new Map();
  const consumeCalls = [];

  async function add(grantId, bytes, profileScopeId = PROFILE_SCOPE_ID) {
    const archivePath = path.join(directory, `${grantId}.zip`);
    await fs.writeFile(archivePath, bytes, { mode: 0o600 });
    const fileHandle = await fs.open(archivePath, 'r');
    const archive = await createGrantedArchiveFromFileHandle({
      fileHandle,
      displayName: `${grantId}.zip`,
      profileScopeId,
      expectedStat: await fileHandle.stat()
    });
    grants.set(grantId, { archive, fileHandle, profileScopeId, consumed: false, closed: false });
    t.after(async () => await closeGrantedArchive(archive).catch(() => {}));
    return grantId;
  }

  function fail(grantId, error) {
    failures.set(grantId, error);
  }

  async function consume(grantId, requestedScope) {
    consumeCalls.push({ grantId, profileScopeId: requestedScope });
    if (failures.has(grantId)) throw failures.get(grantId);
    const entry = grants.get(grantId);
    if (!entry || entry.consumed) {
      throw Object.assign(new Error('grant unavailable'), { code: 'export_grant_unavailable' });
    }
    entry.consumed = true;
    if (entry.profileScopeId !== requestedScope) {
      await closeGrantedArchive(entry.archive).catch(() => {});
      entry.closed = true;
      throw Object.assign(new Error('scope mismatch'), { code: 'export_grant_scope_mismatch' });
    }
    return entry.archive;
  }

  async function close(archive) {
    const entry = Array.from(grants.values()).find((candidate) => candidate.archive === archive);
    if (!entry || entry.closed) return;
    entry.closed = true;
    await closeGrantedArchive(archive);
  }

  return Object.freeze({ add, fail, consume, close, consumeCalls });
}

async function harness(t, label, { profileAccountHints = null, readerLimits = {} } = {}) {
  const stateDir = await temporaryDirectory(t, label);
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  let nextImportId = 1;
  const store = createConversationCatalogStore({
    stateDir,
    blobs,
    clock: () => VERIFIED_AT,
    randomId: () => `${label}-${nextImportId++}`
  });
  const commitBatchSizes = [];
  const changeEvents = [];
  const serviceStore = {
    ...store,
    async commitPreparedRecords(importId, records, cursor) {
      commitBatchSizes.push(records.length);
      return await store.commitPreparedRecords(importId, records, cursor);
    }
  };
  const grants = createGrantPort(t, stateDir);
  const routeOutcomes = [];
  const routeCalls = [];
  const routeVerifier = {
    async verify(requestedIdentity, key) {
      routeCalls.push({ identity: requestedIdentity, key });
      if (!routeOutcomes.length) throw new Error('no scripted route outcome');
      const outcome = routeOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return typeof outcome === 'function' ? await outcome(requestedIdentity, key) : outcome;
    }
  };
  const service = createConversationCatalogService({
    store: serviceStore,
    blobs,
    grants,
    exportReader: createChatGptExportReader({ limits: { readChunkBytes: 19, ...readerLimits } }),
    routeVerifier,
    onChanged: () => changeEvents.push('changed'),
    ...(profileAccountHints ? { profileAccountHints } : {}),
    clock: () => VERIFIED_AT
  });
  return { stateDir, blobs, store, grants, routeOutcomes, routeCalls, commitBatchSizes, changeEvents, service };
}

async function importArchive(t, fixture, records, {
  grantId = 'grant-import',
  profileScopeId = PROFILE_SCOPE_ID,
  selectedScopeId = profileScopeId,
  zipOptions = {}
} = {}) {
  await fixture.grants.add(grantId, exportZip(records, zipOptions), selectedScopeId);
  return await fixture.service.importExport({ grantId, profileScopeId });
}

test('catalog service: real import stages exact raw/snapshot blobs and exact re-import is stable', async (t) => {
  const fixture = await harness(t, 'stable');
  const record = conversationRecord();
  const zipBytes = exportZip([record]);
  await fixture.grants.add('grant-first', zipBytes);

  const first = await fixture.service.importExport({
    grantId: 'grant-first',
    profileScopeId: PROFILE_SCOPE_ID
  });
  assert.deepEqual(first, {
    status: 'complete',
    importId: 'import-stable-1',
    counts: { recordsSeen: 1, cataloged: 1, snapshots: 1, problems: 0 }
  });
  assert.equal(fixture.changeEvents.length, 3, 'begin, committed batch, and finish must each notify');

  const firstPage = await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 10 });
  assert.equal(firstPage.items.length, 1);
  const firstItem = firstPage.items[0];
  assert.deepEqual(firstItem.identity, identity(record.id));
  assert.deepEqual(await fixture.blobs.getRaw(firstItem.latestArchiveRecord), Buffer.from(JSON.stringify(record)));
  const snapshot = await fixture.blobs.getSnapshot(firstItem.latestImportedSnapshot);
  assert.deepEqual(snapshot.identity, identity(record.id));
  assert.equal(snapshot.capturedAt, VERIFIED_AT);
  assert.deepEqual(snapshot.origin, {
    kind: 'chatgpt-export',
    importId: first.importId,
    rawRecord: firstItem.latestArchiveRecord,
    branchEvidence: {
      kind: 'active-node-chain',
      activeNodeId: `${record.id}-assistant`,
      messageIds: [`${record.id}-user`, `${record.id}-assistant`]
    }
  });
  assert.deepEqual(snapshot.turns.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'A harmless import fixture prompt' },
    { role: 'assistant', text: 'A harmless import fixture reply' }
  ]);

  await fixture.grants.add('grant-repeat', zipBytes);
  const repeated = await fixture.service.importExport({
    grantId: 'grant-repeat',
    profileScopeId: PROFILE_SCOPE_ID
  });
  assert.deepEqual(repeated, first);
  const repeatedPage = await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 10 });
  assert.equal(repeatedPage.items.length, 1);
  assert.deepEqual(repeatedPage.items[0].latestArchiveRecord, firstItem.latestArchiveRecord);
  assert.deepEqual(repeatedPage.items[0].latestImportedSnapshot, firstItem.latestImportedSnapshot);
  assert.equal((await fixture.service.listImports()).length, 1);
});

test('catalog service: extended-year timestamps cannot strand import preflight or publish invalid snapshots', async (t) => {
  const fixture = await harness(t, 'timestamp-fallback');
  const fallsBackToCreate = conversationRecord({ conversationId: 'timestamp-create-fallback' });
  fallsBackToCreate.update_time = 300_000_000_000;
  const fallsBackToEpoch = conversationRecord({ conversationId: 'timestamp-epoch-fallback' });
  fallsBackToEpoch.update_time = 300_000_000_000;
  fallsBackToEpoch.create_time = 300_000_000_000;

  const outcome = await importArchive(t, fixture, [fallsBackToCreate, fallsBackToEpoch], {
    grantId: 'grant-timestamp-fallback'
  });

  assert.deepEqual(outcome, {
    status: 'complete',
    importId: 'import-timestamp-fallback-1',
    counts: { recordsSeen: 2, cataloged: 2, snapshots: 2, problems: 0 }
  });
  assert.deepEqual(fixture.commitBatchSizes, [2]);
  const imports = await fixture.service.listImports();
  assert.equal(imports.length, 1);
  assert.equal(imports[0].status, 'complete');
  assert.deepEqual(imports[0].cursor, { schemaVersion: 1, recordIndex: 2 });
  assert.equal(imports[0].suspension, null);

  const page = await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 10 });
  const capturedAtByIdentity = new Map();
  for (const item of page.items) {
    const snapshot = await fixture.blobs.getSnapshot(item.latestImportedSnapshot);
    capturedAtByIdentity.set(item.identity.providerConversationId, snapshot.capturedAt);
  }
  assert.deepEqual(Object.fromEntries(capturedAtByIdentity), {
    'timestamp-create-fallback': VERIFIED_AT,
    'timestamp-epoch-fallback': VERIFIED_AT
  });
});

test('catalog service: future provider time cannot outrank a later live snapshot across replay and restart', async (t) => {
  const fixture = await harness(t, 'future-provider-time');
  const record = conversationRecord({ conversationId: 'future-order-thread' });
  record.update_time = Date.parse('9999-01-01T00:00:00.000Z') / 1000;
  const zipBytes = exportZip([record]);
  await fixture.grants.add('grant-future-time', zipBytes);

  const imported = await fixture.service.importExport({
    grantId: 'grant-future-time',
    profileScopeId: PROFILE_SCOPE_ID
  });
  assert.equal(imported.status, 'complete');
  const [catalogImport] = await fixture.service.listImports();
  assert.equal(catalogImport.createdAt, VERIFIED_AT);
  const importedItem = (await fixture.service.list({
    profileScopeId: PROFILE_SCOPE_ID,
    limit: 10
  })).items[0];
  const importedSnapshot = await fixture.blobs.getSnapshot(importedItem.latestImportedSnapshot);
  assert.equal(importedItem.firstObservedAt, catalogImport.createdAt);
  assert.equal(importedItem.lastObservedAt, catalogImport.createdAt);
  assert.equal(importedSnapshot.capturedAt, catalogImport.createdAt);
  assert.deepEqual(
    await fixture.blobs.getRaw(importedItem.latestArchiveRecord),
    Buffer.from(JSON.stringify(record))
  );

  await fixture.grants.add('grant-future-time-replay', zipBytes);
  assert.deepEqual(await fixture.service.importExport({
    grantId: 'grant-future-time-replay',
    profileScopeId: PROFILE_SCOPE_ID
  }), imported);
  const replayedItem = (await fixture.service.list({
    profileScopeId: PROFILE_SCOPE_ID,
    limit: 10
  })).items[0];
  assert.deepEqual(replayedItem.latestImportedSnapshot, importedItem.latestImportedSnapshot);

  const liveCapturedAt = '2026-07-31T12:11:00.000Z';
  const conversationUrl = `https://chatgpt.com/c/${record.id}`;
  const rawTurns = [
    {
      ordinal: 0,
      providerMessageId: `${record.id}-user`,
      role: 'user',
      text: 'A harmless import fixture prompt'
    },
    {
      ordinal: 1,
      providerMessageId: `${record.id}-assistant`,
      role: 'assistant',
      text: 'A harmless import fixture reply'
    }
  ];
  const evidence = {
    topBoundary: true,
    bottomBoundary: true,
    orderedWindowStitching: true,
    scrollPasses: 1,
    windowCount: 1,
    messageCount: rawTurns.length,
    providerIdCount: rawTurns.length,
    byteCount: rawTurns.reduce((total, turn) =>
      total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0)
  };
  const recordIdentity = identity(record.id);
  const liveSnapshot = makeTranscriptSnapshot({
    identity: recordIdentity,
    normalizedTranscript: normalizeLiveCapture({
      status: 'complete',
      conversationUrl,
      capturedAt: liveCapturedAt,
      rawTurns,
      evidence
    }),
    origin: { kind: 'live-capture', conversationUrl, captureEvidence: evidence },
    capturedAt: liveCapturedAt
  });
  const liveRef = await fixture.blobs.putSnapshot(liveSnapshot);
  assert.equal(liveSnapshot.contentHash, importedSnapshot.contentHash);
  assert.notEqual(liveSnapshot.snapshotHash, importedSnapshot.snapshotHash);

  const restartedBlobs = createPrivateLibraryBlobStore({ stateDir: fixture.stateDir });
  const restartedStore = createConversationCatalogStore({
    stateDir: fixture.stateDir,
    blobs: restartedBlobs,
    clock: () => '2026-08-01T00:00:00.000Z',
    randomId: () => 'restart-unused'
  });
  assert.deepEqual(await restartedStore.recoverInterruptedImports(), []);
  assert.deepEqual(
    await restartedStore.latestImportedSnapshot(recordIdentity),
    importedItem.latestImportedSnapshot
  );
  const read = createTranscriptReadService({
    sources: {
      async findSource() {
        return {
          id: 'source-future-order',
          identity: recordIdentity,
          key: 'future-order-key',
          enabled: true,
          target: {
            kind: 'owned-conversation',
            location: locationFromConversationUrl(conversationUrl)
          },
          latestLiveSnapshot: liveRef
        };
      }
    },
    imported: restartedStore,
    blobs: restartedBlobs
  });

  const selected = await read.get({ identity: recordIdentity, limit: 10 });
  assert.deepEqual(selected.snapshot, liveRef);
  assert.equal(selected.capturedAt, liveCapturedAt);
});

test('catalog service: import interruption persistence retries once and reports unresolved recovery exactly', async (t) => {
  for (const failureCount of [1, 2]) {
    await t.test(`${failureCount}-replace-failure${failureCount === 1 ? '' : 's'}`, async (t) => {
      const stateDir = await temporaryDirectory(t, `interrupt-persist-${failureCount}`);
      let failuresRemaining = 0;
      const operations = proxiedOperations({
        async rename(...args) {
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw Object.assign(new Error('injected replace failure'), { code: 'EIO' });
          }
          return await fs.rename(...args);
        }
      });
      const fileSystem = createPrivateFileSystem({ operations });
      const blobs = createPrivateLibraryBlobStore({ stateDir, fileSystem });
      const store = createConversationCatalogStore({
        stateDir,
        blobs,
        fileSystem,
        clock: () => VERIFIED_AT,
        randomId: () => `interrupt-persist-${failureCount}`
      });
      let streamPass = 0;
      const decoded = {
        status: 'catalog-only',
        reason: 'provider-id-missing',
        identity: null,
        title: null,
        observedAt: OBSERVED_AT,
        rawRecord: Buffer.from('{}')
      };
      const service = createConversationCatalogService({
        store,
        blobs,
        grants: {
          async consume() { return Object.freeze({}); },
          async close() {}
        },
        exportReader: {
          async inspect() {
            return {
              archiveHash: 'a'.repeat(64),
              layout: 'single-conversations-json',
              accountHint: null
            };
          },
          async *streamConversations() {
            streamPass += 1;
            yield decoded;
            if (streamPass === 2) {
              failuresRemaining = failureCount;
              throw new Error('injected archive interruption');
            }
          }
        },
        routeVerifier: { async verify() { throw new Error('not expected'); } },
        clock: () => VERIFIED_AT
      });

      const expected = failureCount === 1
        ? 'catalog_import_interrupted'
        : 'catalog_import_recovery_required';
      await assert.rejects(
        () => service.importExport({ grantId: 'grant-interrupted', profileScopeId: PROFILE_SCOPE_ID }),
        (error) => error?.code === expected
      );
      const [catalogImport] = await store.listImports();
      assert.equal(catalogImport.status, failureCount === 1 ? 'partial' : 'open');
      if (failureCount === 2) {
        assert.equal((await store.recoverInterruptedImports()).length, 1);
        assert.equal((await store.listImports())[0].status, 'partial');
      }
    });
  }
});

test('catalog service: a real archive is committed in bounded batches', async (t) => {
  const fixture = await harness(t, 'bounded-batches');
  const records = Array.from({ length: 65 }, (_, index) => ({
    title: `Bounded ${index}`,
    update_time: OBSERVED_AT_SECONDS
  }));
  const outcome = await importArchive(t, fixture, records, { grantId: 'grant-bounded-import' });
  assert.equal(outcome.status, 'partial');
  assert.equal(outcome.importId, 'import-bounded-batches-1');
  assert.deepEqual(outcome.counts, { recordsSeen: 65, cataloged: 0, snapshots: 0, problems: 65 });
  assert.equal(outcome.problems.length, 65);
  assert.deepEqual(outcome.resume, { schemaVersion: 1, recordIndex: 65 });
  assert.deepEqual(fixture.commitBatchSizes, [64, 1]);
  assert.equal((await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 100 })).items.length, 0);
});

test('catalog service: bounded batches grow geometrically through the 10,000-problem outcome ceiling', async () => {
  async function runSchedule(recordCount, startRecordIndex = 0) {
    const commitBatchSizes = [];
    const priorProblems = Array.from({ length: startRecordIndex }, (_, recordIndex) => ({
      recordIndex,
      reason: 'provider-id-missing',
      identity: null
    }));
    const catalogImport = {
      id: 'import-geometric-batches',
      status: 'open',
      createdAt: VERIFIED_AT,
      cursor: { schemaVersion: 1, recordIndex: startRecordIndex },
      counts: {
        recordsSeen: startRecordIndex,
        cataloged: 0,
        snapshots: 0,
        problems: startRecordIndex
      },
      problems: priorProblems
    };
    const store = {
      async beginImport() { return structuredClone(catalogImport); },
      async commitPreparedRecords(importId, records, cursor) {
        assert.equal(importId, catalogImport.id);
        commitBatchSizes.push(records.length);
        catalogImport.cursor = structuredClone(cursor);
        catalogImport.problems.push(...records.map(({ problem }) => problem));
        catalogImport.counts = {
          recordsSeen: cursor.recordIndex,
          cataloged: 0,
          snapshots: 0,
          problems: cursor.recordIndex
        };
        return { importId, cursor: structuredClone(cursor), changed: true, counts: catalogImport.counts };
      },
      async finishImport(_importId, outcome) {
        catalogImport.status = outcome.status;
        return structuredClone(catalogImport);
      },
      async interruptImport() { throw new Error('not expected'); },
      async listImports() { return [structuredClone(catalogImport)]; },
      async verifyRoute() { throw new Error('not expected'); },
      async observeUnavailable() { throw new Error('not expected'); },
      async reassignScope() { throw new Error('not expected'); },
      async list() { throw new Error('not expected'); }
    };
    const exportReader = {
      async inspect() {
        return { archiveHash: 'a'.repeat(64), layout: 'single-conversations-json', accountHint: null };
      },
      async *streamConversations(_archive, _profileScopeId, cursor) {
        for (let recordIndex = cursor.recordIndex; recordIndex < recordCount; recordIndex += 1) {
          yield {
            status: 'catalog-only',
            reason: 'provider-id-missing',
            identity: null,
            title: null,
            observedAt: OBSERVED_AT,
            rawRecord: Buffer.from('{}')
          };
        }
      }
    };
    const service = createConversationCatalogService({
      store,
      blobs: {
        async putRaw() { return { kind: 'raw', algorithm: 'sha256', hash: 'b'.repeat(64), byteLength: 2 }; },
        async putSnapshot() { throw new Error('not expected'); }
      },
      grants: {
        async consume() { return Object.freeze({}); },
        async close() {}
      },
      exportReader,
      routeVerifier: { async verify() { throw new Error('not expected'); } },
      clock: () => VERIFIED_AT
    });
    const outcome = await service.importExport({
      grantId: 'grant-geometric-import',
      profileScopeId: PROFILE_SCOPE_ID
    });
    return { outcome, commitBatchSizes };
  }

  const fresh = await runSchedule(10_000);
  assert.equal(fresh.outcome.status, 'partial');
  assert.equal(fresh.outcome.counts.recordsSeen, 10_000);
  assert.deepEqual(fresh.commitBatchSizes, [64, 128, 256, 512, 1_024, 2_048, 4_096, 1_872]);
  assert.equal(fresh.commitBatchSizes.reduce((sum, size) => sum + size, 0), 10_000);

  const resumed = await runSchedule(449, 192);
  assert.equal(resumed.outcome.counts.recordsSeen, 449);
  assert.deepEqual(resumed.commitBatchSizes, [256, 1]);
});

test('catalog service: a real archive over the representable problem bound is rejected before begin', async (t) => {
  const fixture = await harness(t, 'record-bound');
  const privateMarker = 'private-record-bound-marker';
  const records = Array.from({ length: 10_001 }, (_, index) => ({
    title: `${privateMarker}-${index}`,
    update_time: OBSERVED_AT_SECONDS
  }));

  const outcome = await importArchive(t, fixture, records, { grantId: 'grant-record-bound-import' });
  assert.deepEqual(outcome, { status: 'rejected', reason: 'unsafe-archive' });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  assert.deepEqual(await fixture.store.listImports(), []);
  assert.deepEqual(fixture.commitBatchSizes, []);
  assert.deepEqual(fixture.changeEvents, []);
});

test('catalog service: an immutable snapshot over 32 MiB is rejected before begin', async (t) => {
  // Other reader tests use 19-byte chunks to stress framing boundaries. Keep
  // this scale-boundary case representative of the production 64 KiB reader
  // so it does not turn 32 MiB into millions of artificial file reads.
  const fixture = await harness(t, 'snapshot-bound', {
    readerLimits: { readChunkBytes: 64 * 1024 }
  });
  const privateMarker = 'private-snapshot-bound-marker';
  const text = `${privateMarker}${'A'.repeat(TRANSCRIPT_TURN_MAX_TEXT_CHARS - privateMarker.length)}`;
  const record = conversationRecord({ conversationId: 'snapshot-bound-thread' });
  const rootId = `${record.id}-root`;
  const turnIds = Array.from({ length: 34 }, (_, index) => `${record.id}-turn-${index}`);
  record.mapping = {
    [rootId]: { id: rootId, message: null, parent: null, children: [turnIds[0]] }
  };
  for (let index = 0; index < turnIds.length; index += 1) {
    const id = turnIds[index];
    record.mapping[id] = {
      id,
      message: message(id, index % 2 === 0 ? 'user' : 'assistant', text),
      parent: index === 0 ? rootId : turnIds[index - 1],
      children: index === turnIds.length - 1 ? [] : [turnIds[index + 1]]
    };
  }
  record.current_node = turnIds.at(-1);

  const outcome = await importArchive(t, fixture, [record], {
    grantId: 'grant-snapshot-bound-import',
    zipOptions: { method: 'store' }
  });
  assert.deepEqual(outcome, { status: 'rejected', reason: 'unsafe-archive' });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  assert.deepEqual(await fixture.store.listImports(), []);
  assert.deepEqual(fixture.commitBatchSizes, []);
  assert.deepEqual(fixture.changeEvents, []);
});

test('catalog service: an oversized export turn commits one closed catalog-only partial outcome', async (t) => {
  const fixture = await harness(t, 'oversized-turn');
  const privateMarker = 'private-oversized-turn-marker';
  const assistantText = `${privateMarker}${'A'.repeat(
    TRANSCRIPT_TURN_MAX_TEXT_CHARS + 1 - privateMarker.length
  )}`;
  const record = conversationRecord({
    conversationId: 'oversized-turn-thread',
    assistantText
  });

  const outcome = await importArchive(t, fixture, [record], {
    grantId: 'grant-oversized-turn',
    zipOptions: { method: 'store' }
  });

  assert.deepEqual(outcome, {
    status: 'partial',
    importId: 'import-oversized-turn-1',
    counts: { recordsSeen: 1, cataloged: 1, snapshots: 0, problems: 1 },
    problems: [{
      recordIndex: 0,
      reason: 'unsupported-content',
      identity: identity(record.id)
    }],
    resume: { schemaVersion: 1, recordIndex: 1 }
  });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  const page = await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 10 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].latestImportedSnapshot, null);
  assert.equal(page.items[0].route.kind, 'unverified');
  assert.equal(page.items[0].latestArchiveRecord.byteLength, Buffer.byteLength(JSON.stringify(record)));
  assert.equal((await fixture.service.listImports())[0].status, 'partial');
});

test('catalog service: a real ambiguous record produces visible catalog-only partial state', async (t) => {
  const fixture = await harness(t, 'partial');
  const complete = conversationRecord({ conversationId: 'complete-thread' });
  const ambiguous = conversationRecord({ conversationId: 'ambiguous-thread', ambiguous: true });

  const outcome = await importArchive(t, fixture, [complete, ambiguous]);
  assert.deepEqual(outcome, {
    status: 'partial',
    importId: 'import-partial-1',
    counts: { recordsSeen: 2, cataloged: 2, snapshots: 1, problems: 1 },
    problems: [{
      recordIndex: 1,
      reason: 'active-branch-ambiguous',
      identity: identity(ambiguous.id)
    }],
    resume: { schemaVersion: 1, recordIndex: 2 }
  });

  const page = await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 10 });
  assert.equal(page.items.length, 2);
  const completeItem = page.items.find(({ identity: value }) => value.providerConversationId === complete.id);
  const ambiguousItem = page.items.find(({ identity: value }) => value.providerConversationId === ambiguous.id);
  assert.notEqual(completeItem.latestImportedSnapshot, null);
  assert.equal(ambiguousItem.latestImportedSnapshot, null);
  assert.equal(ambiguousItem.route.kind, 'unverified');
  assert.deepEqual(
    await fixture.blobs.getRaw(ambiguousItem.latestArchiveRecord),
    Buffer.from(JSON.stringify(ambiguous))
  );
  assert.equal((await fixture.service.listImports())[0].status, 'partial');
});

test('catalog service: a rejected grant close cannot undo a durable completed import', async (t) => {
  const privateMarker = 'private grant close marker';
  const fixture = await harness(t, 'close-failure');
  let closeCalls = 0;
  const grants = {
    consume: async (...args) => await fixture.grants.consume(...args),
    async close(archive) {
      closeCalls += 1;
      await fixture.grants.close(archive);
      throw Object.assign(new Error(privateMarker), { code: 'EIO' });
    }
  };
  const service = createConversationCatalogService({
    store: fixture.store,
    blobs: fixture.blobs,
    grants,
    exportReader: createChatGptExportReader({ limits: { readChunkBytes: 19 } }),
    routeVerifier: { async verify() { throw new Error('unused route verifier'); } },
    clock: () => VERIFIED_AT
  });
  const record = conversationRecord({ conversationId: 'close-failure-thread' });
  await fixture.grants.add('grant-close-failure', exportZip([record]));

  const outcome = await service.importExport({
    grantId: 'grant-close-failure',
    profileScopeId: PROFILE_SCOPE_ID
  });
  assert.deepEqual(outcome, {
    status: 'complete',
    importId: 'import-close-failure-1',
    counts: { recordsSeen: 1, cataloged: 1, snapshots: 1, problems: 0 }
  });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  assert.equal(closeCalls, 1);

  const restartedBlobs = createPrivateLibraryBlobStore({ stateDir: fixture.stateDir });
  const restartedStore = createConversationCatalogStore({
    stateDir: fixture.stateDir,
    blobs: restartedBlobs,
    clock: () => VERIFIED_AT,
    randomId: () => 'unused-restart-id'
  });
  const [restartedImport] = await restartedStore.listImports();
  assert.equal(restartedImport.status, 'complete');
  assert.deepEqual(restartedImport.counts, outcome.counts);
  assert.equal((await restartedStore.list({ profileScopeId: PROFILE_SCOPE_ID })).items.length, 1);
  assert.equal(closeCalls, 1);
});

test('catalog service: real reader refusals, account hints, and grant scope fail closed without private data', async (t) => {
  const privateMarker = 'private archive marker must stay hidden';
  const fixture = await harness(t, 'refusals');
  const rejectedCases = [
    ['grant-not-zip', Buffer.from(`${privateMarker}: not a zip`), 'not-a-zip'],
    [
      'grant-unsafe',
      buildZip([
        { name: 'conversations.json', data: recordsJson([conversationRecord()]) },
        { name: '../private.txt', data: privateMarker }
      ]),
      'unsafe-archive'
    ],
    ['grant-unsupported', buildZip([{ name: 'notes.txt', data: privateMarker }]), 'unsupported-export']
  ];
  for (const [grantId, bytes, reason] of rejectedCases) {
    await fixture.grants.add(grantId, bytes);
    const outcome = await fixture.service.importExport({ grantId, profileScopeId: PROFILE_SCOPE_ID });
    assert.deepEqual(outcome, { status: 'rejected', reason });
    assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  }

  await fixture.grants.add('grant-wrong-scope', exportZip([conversationRecord()]), OTHER_PROFILE_SCOPE_ID);
  assert.deepEqual(
    await fixture.service.importExport({ grantId: 'grant-wrong-scope', profileScopeId: PROFILE_SCOPE_ID }),
    { status: 'rejected', reason: 'scope-confirmation-required' }
  );
  assert.deepEqual(await fixture.service.listImports(), []);

  const accountFixture = await harness(t, 'account-hint', {
    profileAccountHints: { async get() { return `chatgpt-user-id:sha256:${'f'.repeat(64)}`; } }
  });
  const conflict = await importArchive(t, accountFixture, [conversationRecord()], {
    zipOptions: { accountId: 'a different stable account id' }
  });
  assert.deepEqual(conflict, { status: 'rejected', reason: 'account-hint-conflict' });
  assert.deepEqual(await accountFixture.service.listImports(), []);

  const malformed = conversationRecord({ title: privateMarker });
  malformed.id = '../malformed-provider-id';
  malformed.conversation_id = '../malformed-provider-id';
  const malformedOutcome = await importArchive(t, fixture, [malformed], { grantId: 'grant-malformed' });
  assert.deepEqual(malformedOutcome, { status: 'rejected', reason: 'unsafe-archive' });
  assert.equal(JSON.stringify(malformedOutcome).includes(privateMarker), false);

  const duplicateRecord = conversationRecord({ conversationId: 'duplicate-key-thread', title: privateMarker });
  const { id: _id, ...withoutId } = duplicateRecord;
  const duplicateJson = `[{"id":"../malformed-id","\\u0069d":"${duplicateRecord.id}",${JSON.stringify(withoutId).slice(1)}]`;
  await fixture.grants.add('grant-duplicate-key', buildZip([
    { name: 'conversations.json', data: duplicateJson, method: 'deflate' }
  ]));
  const duplicateOutcome = await fixture.service.importExport({
    grantId: 'grant-duplicate-key',
    profileScopeId: PROFILE_SCOPE_ID
  });
  assert.deepEqual(duplicateOutcome, { status: 'rejected', reason: 'unsafe-archive' });
  assert.deepEqual(await fixture.service.listImports(), []);
  assert.equal(JSON.stringify(duplicateOutcome).includes(privateMarker), false);
});

test('catalog service: late entry corruption after valid records rejects before import visibility', async (t) => {
  const fixture = await harness(t, 'late-corruption');
  const privateMarker = 'private late-corruption transcript marker';
  const records = [
    conversationRecord({ conversationId: 'valid-before-corrupt-tail' }),
    conversationRecord({
      conversationId: 'private-corrupt-tail',
      assistantText: privateMarker
    })
  ];
  const conversationBytes = recordsJson(records);
  const corruptChecksum = (crc32(conversationBytes) + 1) >>> 0;
  const archiveBytes = buildZip([{
    name: 'conversations.json',
    data: conversationBytes,
    method: 'store',
    crc32: corruptChecksum
  }]);
  await fixture.grants.add('grant-late-corruption', archiveBytes);

  const outcome = await fixture.service.importExport({
    grantId: 'grant-late-corruption',
    profileScopeId: PROFILE_SCOPE_ID
  });

  assert.deepEqual(outcome, { status: 'rejected', reason: 'unsafe-archive' });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  assert.deepEqual(await fixture.store.listImports(), []);
  assert.deepEqual((await fixture.store.list({ profileScopeId: PROFILE_SCOPE_ID })).items, []);
  assert.deepEqual(fixture.commitBatchSizes, []);
  assert.deepEqual(fixture.changeEvents, []);
});

test('catalog service: grant and verifier failures expose symbolic outcomes only', async (t) => {
  const privateMarker = '/private/export/path with transcript contents';
  const fixture = await harness(t, 'redaction');
  fixture.grants.fail(
    'grant-expired-private',
    Object.assign(new Error(privateMarker), { code: 'desktop_picker_failed' })
  );
  await assert.rejects(
    () => fixture.service.importExport({
      grantId: 'grant-expired-private',
      profileScopeId: PROFILE_SCOPE_ID
    }),
    (error) => safeError(error, [privateMarker])
  );

  const record = conversationRecord({ conversationId: 'redaction-thread' });
  await importArchive(t, fixture, [record], { grantId: 'grant-redaction-import' });
  fixture.routeOutcomes.push(Object.assign(new Error(privateMarker), { code: 'ECONNRESET' }));
  const outcome = await fixture.service.verifyByNavigation(identity(record.id), 'catalog-key');
  assert.deepEqual(outcome, { status: 'failed', reason: 'transport' });
  assert.equal(JSON.stringify(outcome).includes(privateMarker), false);
  assert.equal((await fixture.store.get(identity(record.id))).route.kind, 'unverified');

  const selectorLikePrivateMarker = 'private data-message-author-role transcript fragment';
  fixture.routeOutcomes.push(new Error(selectorLikePrivateMarker));
  const selectorLikeOutcome = await fixture.service.verifyByNavigation(identity(record.id), 'catalog-key');
  assert.deepEqual(selectorLikeOutcome, { status: 'failed', reason: 'transport' });
  assert.equal(JSON.stringify(selectorLikeOutcome).includes(selectorLikePrivateMarker), false);
  assert.equal((await fixture.store.get(identity(record.id))).route.kind, 'unverified');
});

test('catalog service: exact verification mutates routes, unavailable preserves history, and failed does not mutate', async (t) => {
  const fixture = await harness(t, 'routes');
  const record = conversationRecord({ conversationId: 'route-service-thread' });
  await importArchive(t, fixture, [record], { grantId: 'grant-route-import' });
  const recordIdentity = identity(record.id);
  const canonicalUrl = `https://chatgpt.com/c/${record.id}`;

  fixture.routeOutcomes.push({
    status: 'verified',
    identity: recordIdentity,
    canonicalUrl,
    evidence: 'direct-navigation'
  });
  const verified = await fixture.service.verifyByNavigation(recordIdentity, 'owned-route-key');
  assert.deepEqual(verified, {
    status: 'verified',
    identity: recordIdentity,
    canonicalUrl,
    evidence: 'direct-navigation'
  });
  assert.deepEqual((await fixture.store.get(recordIdentity)).route, {
    kind: 'verified',
    canonicalUrl,
    verifiedAt: VERIFIED_AT,
    evidence: 'direct-navigation'
  });
  assert.deepEqual(fixture.routeCalls[0], { identity: recordIdentity, key: 'owned-route-key' });

  fixture.routeOutcomes.push({
    status: 'unavailable',
    identity: recordIdentity,
    observation: {
      observedAt: '2026-07-31T12:11:00.000Z',
      reason: 'not-found',
      retryable: true
    }
  });
  await fixture.service.verifyByNavigation(recordIdentity, 'owned-route-key');
  const unavailableRoute = (await fixture.store.get(recordIdentity)).route;
  assert.deepEqual(unavailableRoute, {
    kind: 'temporarily-unavailable',
    previousUrl: canonicalUrl,
    observedAt: '2026-07-31T12:11:00.000Z',
    reason: 'not-found',
    retryable: true
  });

  fixture.routeOutcomes.push({ status: 'failed', reason: 'challenge' });
  assert.deepEqual(
    await fixture.service.verifyByNavigation(recordIdentity, 'owned-route-key'),
    { status: 'failed', reason: 'challenge' }
  );
  assert.deepEqual((await fixture.store.get(recordIdentity)).route, unavailableRoute);

  fixture.routeOutcomes.push({
    status: 'verified',
    identity: identity('another-thread'),
    canonicalUrl: 'https://chatgpt.com/c/another-thread',
    evidence: 'direct-navigation'
  });
  await assert.rejects(
    () => fixture.service.verifyByNavigation(recordIdentity, 'owned-route-key'),
    (error) => safeError(error)
  );
  assert.deepEqual((await fixture.store.get(recordIdentity)).route, unavailableRoute);

  fixture.routeOutcomes.push({
    status: 'verified',
    identity: recordIdentity,
    canonicalUrl: 'https://chatgpt.com/c/another-thread',
    evidence: 'direct-navigation'
  });
  assert.deepEqual(
    await fixture.service.verifyByNavigation(recordIdentity, 'owned-route-key'),
    { status: 'failed', reason: 'transport' }
  );
  assert.deepEqual((await fixture.store.get(recordIdentity)).route, unavailableRoute);
});

test('catalog service: confirmed scope reassignment replays the same archive under only the new scope', async (t) => {
  const fixture = await harness(t, 'reassign');
  const record = conversationRecord({ conversationId: 'scope-service-thread' });
  const zipBytes = exportZip([record]);
  await fixture.grants.add('grant-scope-old-import', zipBytes, PROFILE_SCOPE_ID);
  const imported = await fixture.service.importExport({
    grantId: 'grant-scope-old-import',
    profileScopeId: PROFILE_SCOPE_ID
  });

  await assert.rejects(
    () => fixture.service.reassignImportScope({
      importId: imported.importId,
      newProfileScopeId: OTHER_PROFILE_SCOPE_ID,
      confirm: false
    }),
    (error) => safeError(error)
  );
  const reassigned = await fixture.service.reassignImportScope({
    importId: imported.importId,
    newProfileScopeId: OTHER_PROFILE_SCOPE_ID,
    confirm: true
  });
  assert.deepEqual(reassigned, {
    importId: imported.importId,
    changed: true,
    previousProfileScopeId: PROFILE_SCOPE_ID,
    profileScopeId: OTHER_PROFILE_SCOPE_ID,
    cursor: { schemaVersion: 1, recordIndex: 0 }
  });
  assert.deepEqual((await fixture.service.list({ profileScopeId: PROFILE_SCOPE_ID })).items, []);
  const reassignedPage = await fixture.service.list({ profileScopeId: OTHER_PROFILE_SCOPE_ID });
  assert.equal(reassignedPage.items.length, 1);
  assert.deepEqual(reassignedPage.items[0].identity, identity(record.id, OTHER_PROFILE_SCOPE_ID));
  assert.equal(reassignedPage.items[0].latestImportedSnapshot, null);
  assert.equal(reassignedPage.items[0].route.kind, 'unverified');

  await fixture.grants.add('grant-scope-new-import', zipBytes, OTHER_PROFILE_SCOPE_ID);
  const replayed = await fixture.service.importExport({
    grantId: 'grant-scope-new-import',
    profileScopeId: OTHER_PROFILE_SCOPE_ID
  });
  assert.equal(replayed.status, 'complete');
  assert.equal(replayed.importId, imported.importId);
  const finalPage = await fixture.service.list({ profileScopeId: OTHER_PROFILE_SCOPE_ID });
  assert.equal(finalPage.items.length, 1);
  assert.notEqual(finalPage.items[0].latestImportedSnapshot, null);
  const [finalImport] = await fixture.service.listImports();
  assert.equal(finalImport.status, 'complete');
  assert.equal(finalImport.assignment.profileScopeId, OTHER_PROFILE_SCOPE_ID);
});
