import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  INITIAL_PREPARED_IMPORT_BATCH_RECORDS,
  MAX_PREPARED_IMPORT_BATCH_RECORDS,
  initialImportCursor,
  nextImportCursor,
  parseCatalogPage
} from '../conversation-catalog-contract.mjs';
import {
  CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
  MAX_CONVERSATION_CATALOG_STATE_BYTES,
  createConversationCatalogStore
} from '../conversation-catalog-store.mjs';
import { MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS } from '../chatgpt-export-reader.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../library-blob-store.mjs';
import { createPrivateFileSystem } from '../private-filesystem.mjs';
import { normalizeArchiveConversation } from '../transcript-contract.mjs';

const NOW = '2026-07-31T12:00:00.000Z';

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
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-catalog-${name}-`));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function identity(providerConversationId, profileScopeId = 'profile-main') {
  return { provider: 'chatgpt', profileScopeId, providerConversationId };
}

function manifest(hashCharacter = 'a') {
  return {
    archiveHash: hashCharacter.repeat(64),
    layout: 'single-conversations-json',
    accountHint: null
  };
}

function assignment(profileScopeId = 'profile-main') {
  return { profileScopeId, confirmed: true };
}

function importCapacity(recordCount = 1) {
  return { recordCount };
}

function counts({ recordsSeen, cataloged = recordsSeen, snapshots = cataloged, problems = 0 }) {
  return { recordsSeen, cataloged, snapshots, problems };
}

function makeStore({
  stateDir,
  blobs,
  fileSystem,
  randomId = () => 'catalog-test',
  clock = () => NOW,
  maxStateBytes
}) {
  return createConversationCatalogStore({
    stateDir,
    blobs,
    ...(fileSystem ? { fileSystem } : {}),
    ...(maxStateBytes === undefined ? {} : { maxStateBytes }),
    randomId,
    clock
  });
}

async function commitOne(store, importId, record, cursor) {
  return await store.commitPreparedRecords(importId, [record], cursor);
}

async function rewriteCatalogStateAsLegacyV1(statePath) {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.schemaVersion = 1;
  for (const catalogImport of state.imports) {
    catalogImport.schemaVersion = 1;
    delete catalogImport.capacity;
    delete catalogImport.readOnlyReason;
  }
  for (const record of state.records) record.schemaVersion = 1;
  for (const history of state.routeHistories) history.schemaVersion = 1;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function completePrepared({
  blobs,
  importId,
  recordIndex,
  conversationId,
  profileScopeId = 'profile-main',
  observedAt = NOW,
  title = `Conversation ${conversationId}`,
  rawLabel = conversationId,
  originImportId = importId,
  snapshotIdentity = identity(conversationId, profileScopeId),
  originRawRecord = null
}) {
  const recordIdentity = identity(conversationId, profileScopeId);
  const rawRecord = await blobs.putRaw(Buffer.from(JSON.stringify({ fixture: rawLabel })));
  const snapshotRawRecord = originRawRecord || rawRecord;
  const messageIds = [`${conversationId}-message-1`, `${conversationId}-message-2`];
  const rawTurns = [
    { ordinal: 0, providerMessageId: messageIds[0], role: 'user', text: 'Fixture prompt' },
    { ordinal: 1, providerMessageId: messageIds[1], role: 'assistant', text: 'Fixture reply' }
  ];
  const snapshot = makeTranscriptSnapshot({
    identity: snapshotIdentity,
    normalizedTranscript: normalizeArchiveConversation({ status: 'complete', rawTurns }),
    origin: {
      kind: 'chatgpt-export',
      importId: originImportId,
      rawRecord: snapshotRawRecord,
      branchEvidence: {
        kind: 'active-node-chain',
        activeNodeId: messageIds.at(-1),
        messageIds
      }
    },
    capturedAt: observedAt
  });
  const importedSnapshot = await blobs.putSnapshot(snapshot);
  return {
    record: {
      identity: recordIdentity,
      title,
      rawRecord,
      importedSnapshot,
      observedAt,
      problem: null
    },
    rawRecord,
    importedSnapshot,
    snapshot
  };
}

async function catalogOnlyPrepared({
  blobs,
  recordIndex,
  conversationId,
  profileScopeId = 'profile-main',
  observedAt = NOW,
  reason = 'active-branch-ambiguous'
}) {
  const recordIdentity = conversationId === null ? null : identity(conversationId, profileScopeId);
  const rawRecord = await blobs.putRaw(Buffer.from(JSON.stringify({ fixture: `problem-${recordIndex}` })));
  return {
    identity: recordIdentity,
    title: conversationId === null ? null : `Conversation ${conversationId}`,
    rawRecord,
    importedSnapshot: null,
    observedAt,
    problem: { recordIndex, reason, identity: recordIdentity }
  };
}

function byImportId(imports, importId) {
  return imports.find((entry) => entry.id === importId);
}

function routeObservedAt(index) {
  return new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 1_000).toISOString();
}

test('catalog store: record and cursor publish atomically and exact replay/re-import are idempotent', async (t) => {
  const stateDir = await tempState(t, 'atomic');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs });

  await assert.rejects(store.beginImport(manifest(), assignment()), /catalog_import_invalid/);
  await assert.rejects(
    store.beginImport(manifest(), assignment(), { recordCount: MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS + 1 }),
    /catalog_import_invalid/
  );

  const started = await store.beginImport(manifest(), assignment(), importCapacity());
  assert.equal(started.status, 'open');
  assert.deepEqual(started.cursor, initialImportCursor());

  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'atomic-thread'
  });
  const cursor = nextImportCursor(started.cursor);
  const committed = await commitOne(store, started.id, prepared.record, cursor);
  assert.deepEqual(committed, {
    importId: started.id,
    cursor,
    changed: true,
    counts: counts({ recordsSeen: 1 })
  });
  assert.equal(await store.hasIdentity(prepared.record.identity), true);
  assert.deepEqual(await store.latestImportedSnapshot(prepared.record.identity), prepared.importedSnapshot);
  assert.equal((await store.get(prepared.record.identity)).route.kind, 'unverified');
  assert.deepEqual(byImportId(await store.listImports(), started.id).cursor, cursor);

  const replayed = await commitOne(store, started.id, prepared.record, cursor);
  assert.deepEqual(replayed, { ...committed, changed: false });

  await store.finishImport(started.id, {
    status: 'complete',
    importId: started.id,
    counts: counts({ recordsSeen: 1 })
  });
  const repeatedArchive = await store.beginImport(manifest(), assignment(), importCapacity());
  assert.equal(repeatedArchive.id, started.id);
  assert.equal(repeatedArchive.status, 'complete');
  assert.equal((await store.listImports()).length, 1);
  assert.equal((await store.list({})).items.length, 1);
  assert.deepEqual(await store.latestImportedSnapshot(prepared.record.identity), prepared.importedSnapshot);

  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(store.root)).mode & 0o777, 0o700);
  }
});

test('catalog store: a bounded contiguous batch publishes once and exact batch replay is idempotent', async (t) => {
  const stateDir = await tempState(t, 'batch');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'batch' });
  const started = await store.beginImport(manifest('9'), assignment(), importCapacity(3));
  const prepared = [];
  for (let recordIndex = 0; recordIndex < 3; recordIndex += 1) {
    prepared.push(await completePrepared({
      blobs,
      importId: started.id,
      recordIndex,
      conversationId: `batch-thread-${recordIndex}`,
      observedAt: `2026-07-31T12:0${recordIndex}:00.000Z`
    }));
  }
  const cursor = { schemaVersion: 1, recordIndex: prepared.length };
  const committed = await store.commitPreparedRecords(
    started.id,
    prepared.map(({ record }) => record),
    cursor
  );
  assert.deepEqual(committed, {
    importId: started.id,
    cursor,
    changed: true,
    counts: counts({ recordsSeen: 3 })
  });
  assert.equal((await store.list({ limit: 100 })).items.length, 3);

  assert.deepEqual(
    await store.commitPreparedRecords(started.id, prepared.map(({ record }) => record), cursor),
    { ...committed, changed: false }
  );
  await assert.rejects(
    () => store.commitPreparedRecords(started.id, [
      prepared[0].record,
      { ...prepared[1].record, title: 'Conflicting title' },
      prepared[2].record
    ], cursor),
    /catalog_import_replay_conflict/
  );
  assert.deepEqual(byImportId(await store.listImports(), started.id).cursor, cursor);

  await assert.rejects(
    () => store.commitPreparedRecords(started.id, [], cursor),
    /catalog_batch_invalid/
  );
  await assert.rejects(
    () => store.commitPreparedRecords(
      started.id,
      Array.from({ length: MAX_PREPARED_IMPORT_BATCH_RECORDS + 1 }, () => prepared[0].record),
      { schemaVersion: 1, recordIndex: MAX_PREPARED_IMPORT_BATCH_RECORDS + 1 }
    ),
    /catalog_batch_invalid/
  );
});

test('catalog store: the exact 4,096-record batch cap is accepted atomically', async (t) => {
  const stateDir = await tempState(t, 'maximum-batch');
  const blobStore = createPrivateLibraryBlobStore({ stateDir });
  const rawBytes = Buffer.from('{"fixture":"maximum-batch"}');
  const rawRecord = await blobStore.putRaw(rawBytes);
  let rawReads = 0;
  const blobs = {
    ...blobStore,
    async getRaw() {
      rawReads += 1;
      return rawBytes;
    }
  };
  const store = makeStore({ stateDir, blobs, randomId: () => 'maximum-batch' });
  const started = await store.beginImport(
    manifest('8'),
    assignment(),
    importCapacity(MAX_PREPARED_IMPORT_BATCH_RECORDS)
  );
  const records = Array.from({ length: MAX_PREPARED_IMPORT_BATCH_RECORDS }, (_, recordIndex) => ({
    identity: null,
    title: null,
    rawRecord,
    importedSnapshot: null,
    observedAt: NOW,
    problem: { recordIndex, reason: 'provider-id-missing', identity: null }
  }));
  const cursor = { schemaVersion: 1, recordIndex: MAX_PREPARED_IMPORT_BATCH_RECORDS };

  const committed = await store.commitPreparedRecords(started.id, records, cursor);

  assert.deepEqual(committed, {
    importId: started.id,
    cursor,
    changed: true,
    counts: counts({
      recordsSeen: MAX_PREPARED_IMPORT_BATCH_RECORDS,
      cataloged: 0,
      snapshots: 0,
      problems: MAX_PREPARED_IMPORT_BATCH_RECORDS
    })
  });
  assert.equal(rawReads, MAX_PREPARED_IMPORT_BATCH_RECORDS);
  assert.deepEqual(byImportId(await store.listImports(), started.id).cursor, cursor);
});

test('catalog store: startup recovery durably suspends an open import and resumes at its cursor', async (t) => {
  const stateDir = await tempState(t, 'recovery');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const first = makeStore({ stateDir, blobs, randomId: () => 'recoverable' });
  const started = await first.beginImport(manifest('b'), assignment(), importCapacity(2));
  const prepared0 = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'recover-thread-0'
  });
  const cursor1 = nextImportCursor(started.cursor);
  await commitOne(first, started.id, prepared0.record, cursor1);

  const restarted = makeStore({ stateDir, blobs, randomId: () => 'must-not-be-used' });
  const recovered = await restarted.recoverInterruptedImports();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, started.id);
  assert.equal(recovered[0].status, 'partial');
  assert.deepEqual(recovered[0].cursor, cursor1);
  assert.equal(recovered[0].suspension.reason, 'interrupted');
  assert.deepEqual(await restarted.recoverInterruptedImports(), []);

  const resumed = await restarted.beginImport(manifest('b'), assignment(), importCapacity(2));
  assert.equal(resumed.id, started.id);
  assert.equal(resumed.status, 'open');
  assert.deepEqual(resumed.cursor, cursor1);
  assert.equal(resumed.suspension, null);

  const prepared1 = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 1,
    conversationId: 'recover-thread-1',
    observedAt: '2026-07-31T12:01:00.000Z'
  });
  const cursor2 = nextImportCursor(cursor1);
  await commitOne(restarted, started.id, prepared1.record, cursor2);
  await restarted.finishImport(started.id, {
    status: 'complete',
    importId: started.id,
    counts: counts({ recordsSeen: 2 })
  });
  assert.equal(byImportId(await restarted.listImports(), started.id).status, 'complete');
});

test('catalog store: V1 evidence migrates and reserves before resume', async (t) => {
  const stateDir = await tempState(t, 'legacy-v1-resume');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'legacy-resume' });
  const started = await initial.beginImport(manifest('a'), assignment(), importCapacity(2));
  const prepared0 = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'legacy-thread-0'
  });
  const cursor1 = nextImportCursor(started.cursor);
  await commitOne(initial, started.id, prepared0.record, cursor1);
  await initial.verifyRoute(prepared0.record.identity, {
    canonicalUrl: 'https://chatgpt.com/c/legacy-thread-0',
    verifiedAt: '2026-07-31T12:02:00.000Z',
    evidence: 'direct-navigation'
  });
  const legacyState = await rewriteCatalogStateAsLegacyV1(initial.statePath);
  legacyState.records[0].title = '\ud800';
  await fs.writeFile(initial.statePath, `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o600 });

  const restarted = makeStore({
    stateDir,
    blobs,
    randomId: () => 'must-not-be-used',
    clock: () => '2026-07-31T12:03:00.000Z'
  });
  const [loaded] = await restarted.listImports();
  assert.equal(loaded.schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.deepEqual(loaded.cursor, cursor1);
  assert.deepEqual(loaded.counts, counts({ recordsSeen: 1 }));
  const migratedConversation = await restarted.get(prepared0.record.identity);
  assert.equal(migratedConversation.route.kind, 'verified');
  assert.equal(migratedConversation.title, null);
  assert.notEqual(migratedConversation.latestImportedSnapshot, null);

  const [recovered] = await restarted.recoverInterruptedImports();
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.suspension.reason, 'interrupted');
  const migrated = JSON.parse(await fs.readFile(restarted.statePath, 'utf8'));
  assert.equal(migrated.schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.equal(migrated.imports[0].schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.equal(migrated.imports[0].capacity, null);
  assert.equal(migrated.records[0].schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.equal(migrated.routeHistories[0].schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);

  await assert.rejects(
    restarted.commitPreparedRecords(started.id, [prepared0.record], cursor1),
    /catalog_import_capacity_required/
  );
  await assert.rejects(
    restarted.reassignScope(started.id, 'profile-other', true),
    /catalog_import_capacity_required/
  );
  await assert.rejects(
    restarted.beginImport(manifest('a'), assignment(), importCapacity(0)),
    /catalog_import_manifest_conflict/
  );

  const resumed = await restarted.beginImport(manifest('a'), assignment(), importCapacity(2));
  assert.equal(resumed.status, 'open');
  assert.deepEqual(resumed.cursor, cursor1);
  const reserved = JSON.parse(await fs.readFile(restarted.statePath, 'utf8'));
  assert.deepEqual(reserved.imports[0].capacity, importCapacity(2));

  const prepared1 = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 1,
    conversationId: 'legacy-thread-1',
    observedAt: '2026-07-31T12:04:00.000Z'
  });
  await commitOne(restarted, started.id, prepared1.record, nextImportCursor(cursor1));
  const completed = await restarted.finishImport(started.id, {
    status: 'complete',
    importId: started.id,
    counts: counts({ recordsSeen: 2 })
  });
  assert.equal(completed.status, 'complete');
});

test('catalog store: V1 open-import recovery fits its exact old terminal byte budget', async (t) => {
  const stateDir = await tempState(t, 'legacy-v1-headroom');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'legacy-headroom' });
  await initial.beginImport(manifest('f'), assignment(), importCapacity(0));
  const legacyOpen = await rewriteCatalogStateAsLegacyV1(initial.statePath);
  const legacyTerminal = structuredClone(legacyOpen);
  legacyTerminal.imports[0].status = 'partial';
  legacyTerminal.imports[0].suspension = { reason: 'interrupted', observedAt: NOW };
  const oldTerminalBytes = Buffer.from(`${JSON.stringify(legacyTerminal, null, 2)}\n`);
  const openBytes = Buffer.from(`${JSON.stringify(legacyOpen, null, 2)}\n`);
  assert.equal(openBytes.length <= oldTerminalBytes.length, true);
  await fs.writeFile(initial.statePath, openBytes, { mode: 0o600 });

  const restarted = makeStore({
    stateDir,
    blobs,
    maxStateBytes: oldTerminalBytes.length,
    clock: () => '2026-07-31T12:01:00.000Z'
  });
  const [recovered] = await restarted.recoverInterruptedImports();
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.suspension.reason, 'interrupted');
  const migratedBytes = await fs.readFile(restarted.statePath);
  assert.equal(migratedBytes.length <= oldTerminalBytes.length, true);
  const migrated = JSON.parse(migratedBytes);
  assert.equal(migrated.schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.equal(migrated.imports[0].capacity, null);

  const afterSecondRestart = makeStore({
    stateDir,
    blobs,
    maxStateBytes: oldTerminalBytes.length
  });
  assert.equal((await afterSecondRestart.listImports())[0].status, 'partial');
});

test('catalog store: terminal V1 imports infer exact capacity when scope reassignment suspends them', async (t) => {
  const stateDir = await tempState(t, 'legacy-v1-reassign');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'legacy-reassign' });
  const started = await initial.beginImport(manifest('b'), assignment('scope-old'), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'legacy-reassigned-thread',
    profileScopeId: 'scope-old'
  });
  await commitOne(initial, started.id, prepared.record, nextImportCursor(started.cursor));
  await initial.finishImport(started.id, {
    status: 'complete',
    importId: started.id,
    counts: counts({ recordsSeen: 1 })
  });
  await rewriteCatalogStateAsLegacyV1(initial.statePath);

  const restarted = makeStore({ stateDir, blobs });
  const reassigned = await restarted.reassignScope(started.id, 'scope-new', true);
  assert.equal(reassigned.changed, true);
  const migrated = JSON.parse(await fs.readFile(restarted.statePath, 'utf8'));
  assert.equal(migrated.schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.deepEqual(migrated.imports[0].capacity, importCapacity());
  assert.equal(migrated.imports[0].status, 'partial');
  assert.equal(migrated.imports[0].suspension.reason, 'scope-reassigned');
});

test('catalog store: over-limit V1 imports recover as terminal read-only partial history', { timeout: 30_000 }, async (t) => {
  const stateDir = await tempState(t, 'legacy-v1-over-limit');
  const catalogRoot = path.join(stateDir, 'transcript-library', 'catalog');
  await fs.mkdir(catalogRoot, { recursive: true, mode: 0o700 });
  const importId = 'legacy-over-limit';
  const recordCount = MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS + 1;
  const recordIdentity = identity('legacy-over-limit-thread');
  const rawRecord = {
    kind: 'raw',
    algorithm: 'sha256',
    hash: 'a'.repeat(64),
    byteLength: 2
  };
  const importedSnapshot = {
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    byteLength: 2
  };
  const state = {
    schemaVersion: 1,
    revision: 1,
    imports: [{
      schemaVersion: 1,
      id: importId,
      manifest: manifest('e'),
      assignment: assignment(),
      status: 'open',
      cursor: { schemaVersion: 1, recordIndex: recordCount },
      suspension: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    records: Array.from({ length: recordCount }, (_, recordIndex) => ({
      schemaVersion: 1,
      importId,
      recordIndex,
      identity: recordIdentity,
      title: null,
      rawRecord,
      importedSnapshot,
      observedAt: NOW,
      problem: null
    })),
    routeHistories: []
  };
  const legacyBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  assert.equal(legacyBytes.length < MAX_CONVERSATION_CATALOG_STATE_BYTES, true);
  const statePath = path.join(catalogRoot, 'state.json');
  await fs.writeFile(statePath, legacyBytes, { mode: 0o600 });

  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs });
  const [recovered] = await store.recoverInterruptedImports();
  assert.equal(recovered.status, 'partial');
  assert.equal(recovered.suspension, null);
  assert.equal(recovered.readOnlyReason, 'legacy-record-limit');
  assert.equal(recovered.counts.recordsSeen, recordCount);
  assert.equal(recovered.counts.snapshots, recordCount);
  const repeated = await store.beginImport(
    manifest('e'),
    assignment(),
    importCapacity(MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS)
  );
  assert.equal(repeated.status, 'partial');
  assert.equal(repeated.suspension, null);
  assert.equal(repeated.readOnlyReason, 'legacy-record-limit');
  await assert.rejects(
    store.reassignScope(importId, 'profile-other', true),
    /catalog_import_capacity_required/
  );

  const migrated = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(migrated.schemaVersion, CONVERSATION_CATALOG_STORE_SCHEMA_VERSION);
  assert.equal(migrated.imports[0].capacity, null);
  assert.equal(migrated.imports[0].readOnlyReason, 'legacy-record-limit');
  assert.equal(migrated.imports[0].suspension, null);
  const restarted = makeStore({ stateDir, blobs });
  const [restartedImport] = await restarted.listImports();
  assert.equal(restartedImport.counts.recordsSeen, recordCount);
  assert.equal(restartedImport.readOnlyReason, 'legacy-record-limit');

  state.imports[0].status = 'partial';
  state.imports[0].suspension = { reason: 'interrupted', observedAt: NOW };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const suspended = makeStore({ stateDir, blobs });
  assert.equal((await suspended.listImports())[0].readOnlyReason, 'legacy-record-limit');
  const [terminalizedSuspended] = await suspended.recoverInterruptedImports();
  assert.equal(terminalizedSuspended.status, 'partial');
  assert.equal(terminalizedSuspended.suspension, null);
  assert.equal(terminalizedSuspended.readOnlyReason, 'legacy-record-limit');

  state.imports[0].cursor.recordIndex = 1;
  state.records = state.records.slice(0, 1);
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const matchingPreflight = makeStore({ stateDir, blobs });
  assert.equal((await matchingPreflight.listImports())[0].readOnlyReason, null);
  const terminalizedPrefix = await matchingPreflight.terminalizeLegacyOverLimit(
    manifest('e'),
    'profile-main'
  );
  assert.equal(terminalizedPrefix.status, 'partial');
  assert.equal(terminalizedPrefix.suspension, null);
  assert.equal(terminalizedPrefix.readOnlyReason, 'legacy-record-limit');
  assert.equal(
    await matchingPreflight.terminalizeLegacyOverLimit(manifest('d'), 'profile-main'),
    null
  );

  state.imports[0].status = 'complete';
  state.imports[0].suspension = null;
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const completedLegacy = makeStore({ stateDir, blobs });
  const terminalizedComplete = await completedLegacy.terminalizeLegacyOverLimit(
    manifest('e'),
    'profile-main'
  );
  assert.equal(terminalizedComplete.status, 'complete');
  assert.equal(terminalizedComplete.suspension, null);
  assert.equal(terminalizedComplete.readOnlyReason, 'legacy-record-limit');
  const completedRestart = makeStore({ stateDir, blobs });
  assert.equal((await completedRestart.listImports())[0].status, 'complete');
  assert.equal((await completedRestart.listImports())[0].readOnlyReason, 'legacy-record-limit');
});

test('catalog store: mixed top-level and nested schema versions fail closed', async (t) => {
  const templateStateDir = await tempState(t, 'mixed-schema-template');
  const templateBlobs = createPrivateLibraryBlobStore({ stateDir: templateStateDir });
  const initial = makeStore({
    stateDir: templateStateDir,
    blobs: templateBlobs,
    randomId: () => 'mixed-schema'
  });
  const started = await initial.beginImport(manifest('c'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs: templateBlobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'mixed-schema-thread'
  });
  await commitOne(initial, started.id, prepared.record, nextImportCursor(started.cursor));
  await initial.verifyRoute(prepared.record.identity, {
    canonicalUrl: 'https://chatgpt.com/c/mixed-schema-thread',
    verifiedAt: '2026-07-31T12:02:00.000Z',
    evidence: 'direct-navigation'
  });
  const current = JSON.parse(await fs.readFile(initial.statePath, 'utf8'));
  const legacy = structuredClone(current);
  legacy.schemaVersion = 1;
  for (const catalogImport of legacy.imports) {
    catalogImport.schemaVersion = 1;
    delete catalogImport.capacity;
    delete catalogImport.readOnlyReason;
  }
  for (const record of legacy.records) record.schemaVersion = 1;
  for (const history of legacy.routeHistories) history.schemaVersion = 1;

  for (const { name, base, collection, nestedVersion } of [
    { name: 'V1 top with V2 import', base: legacy, collection: 'imports', nestedVersion: 2 },
    { name: 'V1 top with V2 record', base: legacy, collection: 'records', nestedVersion: 2 },
    { name: 'V1 top with V2 route', base: legacy, collection: 'routeHistories', nestedVersion: 2 },
    { name: 'V2 top with V1 import', base: current, collection: 'imports', nestedVersion: 1 },
    { name: 'V2 top with V1 record', base: current, collection: 'records', nestedVersion: 1 },
    { name: 'V2 top with V1 route', base: current, collection: 'routeHistories', nestedVersion: 1 }
  ]) {
    await t.test(name, async (t) => {
      const stateDir = await tempState(t, name.toLowerCase().replaceAll(' ', '-'));
      const catalogRoot = path.join(stateDir, 'transcript-library', 'catalog');
      await fs.mkdir(catalogRoot, { recursive: true, mode: 0o700 });
      const mixed = structuredClone(base);
      mixed[collection][0].schemaVersion = nestedVersion;
      const mixedBytes = Buffer.from(`${JSON.stringify(mixed, null, 2)}\n`);
      const statePath = path.join(catalogRoot, 'state.json');
      await fs.writeFile(statePath, mixedBytes, { mode: 0o600 });
      const blobs = createPrivateLibraryBlobStore({ stateDir });
      const restarted = makeStore({ stateDir, blobs });
      await assert.rejects(restarted.listImports(), /catalog_store_schema_unsupported/);
      assert.deepEqual(await fs.readFile(statePath), mixedBytes);
    });
  }
});

test('catalog store: catalog-only records remain known without becoming retrievable snapshots', async (t) => {
  const stateDir = await tempState(t, 'catalog-only');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'catalog-only' });
  const started = await store.beginImport(manifest('c'), assignment(), importCapacity(2));
  const record = await catalogOnlyPrepared({
    blobs,
    recordIndex: 0,
    conversationId: 'ambiguous-thread'
  });
  const committed = await commitOne(store,
    started.id,
    record,
    nextImportCursor(started.cursor)
  );

  assert.deepEqual(committed.counts, counts({ recordsSeen: 1, cataloged: 1, snapshots: 0, problems: 1 }));
  assert.equal(await store.hasIdentity(record.identity), true);
  assert.equal(await store.latestImportedSnapshot(record.identity), null);
  assert.equal((await store.get(record.identity)).route.kind, 'unverified');

  const missingIdentity = await catalogOnlyPrepared({
    blobs,
    recordIndex: 1,
    conversationId: null,
    reason: 'provider-id-missing'
  });
  await commitOne(store,
    started.id,
    missingIdentity,
    { schemaVersion: 1, recordIndex: 2 }
  );
  assert.deepEqual(
    byImportId(await store.listImports(), started.id).counts,
    counts({ recordsSeen: 2, cataloged: 1, snapshots: 0, problems: 2 })
  );
  assert.equal((await store.list({})).items.length, 1);
});

test('catalog store: unavailable route observations preserve exact prior verification across restart', async (t) => {
  const stateDir = await tempState(t, 'route-history');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'route-history' });
  const started = await store.beginImport(manifest('d'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'route-thread'
  });
  await commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  assert.equal((await store.list({ profileScopeId: 'profile-main', limit: 10 })).items[0].route.kind, 'unverified');

  const canonicalUrl = 'https://chatgpt.com/c/route-thread';
  const verified = await store.verifyRoute(prepared.record.identity, {
    canonicalUrl,
    verifiedAt: '2026-07-31T12:02:00.000Z',
    evidence: 'direct-navigation'
  });
  assert.equal(verified.route.kind, 'verified');
  assert.equal(verified.route.canonicalUrl, canonicalUrl);
  assert.equal((await store.list({ profileScopeId: 'profile-main', limit: 10 })).items[0].route.kind, 'verified');

  await assert.rejects(
    () => store.verifyRoute(prepared.record.identity, {
      canonicalUrl: 'https://chatgpt.com/c/different-thread',
      verifiedAt: '2026-07-31T12:03:00.000Z',
      evidence: 'direct-navigation'
    }),
    /catalog_/
  );
  assert.equal((await store.get(prepared.record.identity)).route.kind, 'verified');

  const unavailable = await store.observeUnavailable(prepared.record.identity, {
    observedAt: '2026-07-31T12:04:00.000Z',
    reason: 'not-found',
    retryable: true
  });
  assert.deepEqual(unavailable.route, {
    kind: 'temporarily-unavailable',
    previousUrl: canonicalUrl,
    observedAt: '2026-07-31T12:04:00.000Z',
    reason: 'not-found',
    retryable: true
  });
  assert.deepEqual(
    (await store.list({ profileScopeId: 'profile-main', limit: 10 })).items[0].route,
    unavailable.route
  );

  const restarted = makeStore({ stateDir, blobs });
  assert.deepEqual((await restarted.get(prepared.record.identity)).route, unavailable.route);
  assert.deepEqual(
    (await restarted.list({ profileScopeId: 'profile-main', limit: 10 })).items[0].route,
    unavailable.route
  );
  const verifiedAgain = await restarted.verifyRoute(prepared.record.identity, {
    canonicalUrl,
    verifiedAt: '2026-07-31T12:05:00.000Z',
    evidence: 'direct-navigation'
  });
  assert.equal(verifiedAgain.route.kind, 'verified');
});

test('catalog store: equivalent route observations refresh time without growing history', async (t) => {
  const stateDir = await tempState(t, 'route-semantic-dedup');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'route-semantic-dedup' });
  const started = await store.beginImport(manifest('8'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'route-semantic-thread'
  });
  await commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  const canonicalUrl = 'https://chatgpt.com/c/route-semantic-thread';

  await store.verifyRoute(prepared.record.identity, {
    canonicalUrl,
    verifiedAt: routeObservedAt(0),
    evidence: 'direct-navigation'
  });
  await store.verifyRoute(prepared.record.identity, {
    canonicalUrl,
    verifiedAt: routeObservedAt(1),
    evidence: 'direct-navigation'
  });
  let durable = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  assert.equal(durable.routeHistories[0].observations.length, 1);
  assert.equal(durable.routeHistories[0].observations[0].verifiedAt, routeObservedAt(1));

  await store.observeUnavailable(prepared.record.identity, {
    observedAt: routeObservedAt(2),
    reason: 'not-found',
    retryable: true
  });
  await store.observeUnavailable(prepared.record.identity, {
    observedAt: routeObservedAt(3),
    reason: 'not-found',
    retryable: true
  });
  durable = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  assert.equal(durable.routeHistories[0].observations.length, 2);
  assert.equal(durable.routeHistories[0].observations[1].observedAt, routeObservedAt(3));
  assert.equal((await store.get(prepared.record.identity)).route.previousUrl, canonicalUrl);
});

test('catalog store: route history retains only the newest 256 semantic transitions', async (t) => {
  const stateDir = await tempState(t, 'route-retention');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'route-retention' });
  const started = await store.beginImport(manifest('9'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'route-retention-thread'
  });
  await commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  const canonicalUrl = 'https://chatgpt.com/c/route-retention-thread';

  for (let index = 0; index < 300; index += 1) {
    if (index % 2 === 0) {
      await store.verifyRoute(prepared.record.identity, {
        canonicalUrl,
        verifiedAt: routeObservedAt(index),
        evidence: 'direct-navigation'
      });
    } else {
      await store.observeUnavailable(prepared.record.identity, {
        observedAt: routeObservedAt(index),
        reason: 'not-found',
        retryable: true
      });
    }
  }

  const durable = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  const observations = durable.routeHistories[0].observations;
  assert.equal(observations.length, 256);
  assert.equal(observations[0].verifiedAt, routeObservedAt(44));
  assert.equal(observations.at(-1).observedAt, routeObservedAt(299));
  assert.equal((await store.get(prepared.record.identity)).route.previousUrl, canonicalUrl);
});

test('catalog store: legacy large route history loads and compacts on the next catalog mutation', async (t) => {
  const stateDir = await tempState(t, 'route-legacy-retention');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'route-legacy-retention' });
  const started = await store.beginImport(manifest('a'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'route-legacy-thread'
  });
  await commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  const canonicalUrl = 'https://chatgpt.com/c/route-legacy-thread';
  await store.verifyRoute(prepared.record.identity, {
    canonicalUrl,
    verifiedAt: routeObservedAt(0),
    evidence: 'direct-navigation'
  });

  const durable = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  durable.routeHistories[0].observations = Array.from({ length: 300 }, (_, index) => index % 2 === 0
    ? {
        kind: 'verified',
        canonicalUrl,
        verifiedAt: routeObservedAt(index),
        evidence: 'direct-navigation'
      }
    : {
        kind: 'temporarily-unavailable',
        previousUrl: canonicalUrl,
        observedAt: routeObservedAt(index),
        reason: 'not-found',
        retryable: true
      });
  await fs.writeFile(store.statePath, `${JSON.stringify(durable, null, 2)}\n`, { mode: 0o600 });

  const restarted = makeStore({
    stateDir,
    blobs,
    randomId: () => 'route-legacy-next'
  });
  assert.equal((await restarted.load()).routeHistories[0].observations.length, 300);
  await restarted.beginImport(manifest('b'), assignment(), importCapacity(0));

  const compacted = JSON.parse(await fs.readFile(restarted.statePath, 'utf8'));
  assert.equal(compacted.routeHistories[0].observations.length, 256);
  assert.equal(compacted.routeHistories[0].observations[0].verifiedAt, routeObservedAt(44));
  assert.equal(compacted.routeHistories[0].observations.at(-1).observedAt, routeObservedAt(299));
});

test('catalog store: catalog pagination is deterministic, filtered, bounded, and non-duplicating', async (t) => {
  const stateDir = await tempState(t, 'pagination');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'pagination-main' });
  const started = await store.beginImport(manifest('e'), assignment(), importCapacity(4));
  const fixtures = [
    ['old-thread', '2026-07-31T12:00:00.000Z'],
    ['middle-thread', '2026-07-31T12:01:00.000Z'],
    ['new-thread', '2026-07-31T12:02:00.000Z']
  ];
  let cursor = initialImportCursor();
  for (let recordIndex = 0; recordIndex < fixtures.length; recordIndex += 1) {
    const [conversationId, observedAt] = fixtures[recordIndex];
    const prepared = await completePrepared({
      blobs,
      importId: started.id,
      recordIndex,
      conversationId,
      observedAt
    });
    cursor = nextImportCursor(cursor);
    await commitOne(store, started.id, prepared.record, cursor);
  }

  const first = await store.list({ profileScopeId: 'profile-main', limit: 2 });
  assert.deepEqual(first.items.map(({ identity: value }) => value.providerConversationId), [
    'new-thread',
    'middle-thread'
  ]);
  assert.equal(typeof first.nextCursor, 'string');
  assert.deepEqual(await store.list({ profileScopeId: 'profile-main', limit: 2 }), first);
  const callerCopy = await store.list({ profileScopeId: 'profile-main', limit: 2 });
  callerCopy.items[0].title = 'caller mutation';
  assert.notEqual(
    (await store.list({ profileScopeId: 'profile-main', limit: 2 })).items[0].title,
    'caller mutation'
  );
  const second = await store.list({ profileScopeId: 'profile-main', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(({ identity: value }) => value.providerConversationId), ['old-thread']);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(({ identity: value }) => value.providerConversationId)).size, 3);
  assert.deepEqual((await store.list({ profileScopeId: 'another-profile', limit: 100 })).items, []);

  const latest = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: fixtures.length,
    conversationId: 'latest-thread',
    observedAt: '2026-07-31T12:03:00.000Z'
  });
  cursor = nextImportCursor(cursor);
  await commitOne(store, started.id, latest.record, cursor);
  await assert.rejects(
    () => store.list({ profileScopeId: 'profile-main', limit: 2, cursor: first.nextCursor }),
    /catalog_cursor_mismatch/
  );
  assert.equal(
    (await store.list({ profileScopeId: 'profile-main', limit: 2 })).items[0].identity.providerConversationId,
    'latest-thread'
  );

  await assert.rejects(() => store.list({ limit: 101 }), /invalid_catalog_contract/);
  await assert.rejects(() => store.list({ cursor: 'not-a-real-cursor' }), /catalog_/);
});

test('catalog store: a maximum-length scope paginates through its dedicated cursor contract', async (t) => {
  const stateDir = await tempState(t, 'max-scope-cursor');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'max-scope-cursor' });
  const profileScopeId = 's'.repeat(128);
  const started = await store.beginImport(manifest('f'), assignment(profileScopeId), importCapacity(101));
  const rawRecord = await blobs.putRaw(Buffer.from('{"fixture":"max-scope-cursor"}'));
  const prepared = Array.from({ length: 101 }, (_, recordIndex) => {
    const recordIdentity = identity(`cursor-thread-${String(recordIndex).padStart(3, '0')}`, profileScopeId);
    return {
      identity: recordIdentity,
      title: `Cursor thread ${recordIndex}`,
      rawRecord,
      importedSnapshot: null,
      observedAt: NOW,
      problem: {
        recordIndex,
        reason: 'active-branch-ambiguous',
        identity: recordIdentity
      }
    };
  });
  await store.commitPreparedRecords(
    started.id,
    prepared.slice(0, INITIAL_PREPARED_IMPORT_BATCH_RECORDS),
    { schemaVersion: 1, recordIndex: INITIAL_PREPARED_IMPORT_BATCH_RECORDS }
  );
  await store.commitPreparedRecords(
    started.id,
    prepared.slice(INITIAL_PREPARED_IMPORT_BATCH_RECORDS),
    { schemaVersion: 1, recordIndex: prepared.length }
  );

  const first = parseCatalogPage(await store.list({ profileScopeId, limit: 100 }));
  assert.equal(first.items.length, 100);
  assert.equal(first.nextCursor.length > 256, true);
  assert.equal(first.nextCursor.length <= 306, true);
  const second = parseCatalogPage(await store.list({ profileScopeId, cursor: first.nextCursor, limit: 100 }));
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(({ identity: value }) =>
    value.providerConversationId)).size, 101);
});

test('catalog store: missing blobs, cursor skips, and snapshot provenance mismatches never advance the cursor', async (t) => {
  const stateDir = await tempState(t, 'refusals');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'refusals' });
  const started = await store.beginImport(manifest('f'), assignment(), importCapacity());
  const valid = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'refusal-thread'
  });

  await assert.rejects(
    () => commitOne(store, started.id, valid.record, { schemaVersion: 1, recordIndex: 2 }),
    /catalog_/
  );

  const missingRaw = await catalogOnlyPrepared({
    blobs,
    recordIndex: 0,
    conversationId: null,
    reason: 'provider-id-missing'
  });
  missingRaw.rawRecord = { ...missingRaw.rawRecord, hash: '9'.repeat(64) };
  await assert.rejects(
    () => commitOne(store, started.id, missingRaw, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  await assert.rejects(
    () => commitOne(store, started.id, {
      ...valid.record,
      importedSnapshot: { ...valid.importedSnapshot, hash: '8'.repeat(64) }
    }, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  const wrongOrigin = await completePrepared({
    blobs,
    importId: started.id,
    originImportId: 'another-import',
    recordIndex: 0,
    conversationId: 'refusal-thread',
    rawLabel: 'wrong-origin'
  });
  await assert.rejects(
    () => commitOne(store, started.id, wrongOrigin.record, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  const wrongIdentity = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'refusal-thread',
    snapshotIdentity: identity('snapshot-other-thread'),
    rawLabel: 'wrong-identity'
  });
  await assert.rejects(
    () => commitOne(store, started.id, wrongIdentity.record, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  const otherRaw = await blobs.putRaw(Buffer.from('{"fixture":"different-raw"}'));
  await assert.rejects(
    () => commitOne(store, started.id, {
      ...valid.record,
      rawRecord: otherRaw
    }, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  const wrongProblemIndex = await catalogOnlyPrepared({
    blobs,
    recordIndex: 1,
    conversationId: 'problem-index-thread'
  });
  await assert.rejects(
    () => commitOne(store, started.id, wrongProblemIndex, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_/
  );

  const current = byImportId(await store.listImports(), started.id);
  assert.deepEqual(current.cursor, initialImportCursor());
  assert.deepEqual(current.counts, counts({ recordsSeen: 0, cataloged: 0, snapshots: 0, problems: 0 }));
  assert.equal(await store.hasIdentity(valid.record.identity), false);
});

test('catalog store: explicit scope reassignment rekeys raw catalog evidence and clears old-scope snapshots', async (t) => {
  const stateDir = await tempState(t, 'reassign');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  let nextImportId = 0;
  const store = makeStore({ stateDir, blobs, randomId: () => `reassign-${++nextImportId}` });
  const started = await store.beginImport(manifest('1'), assignment('scope-old'), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'reassigned-thread',
    profileScopeId: 'scope-old'
  });
  await commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  await store.verifyRoute(prepared.record.identity, {
    canonicalUrl: 'https://chatgpt.com/c/reassigned-thread',
    verifiedAt: '2026-07-31T12:03:00.000Z',
    evidence: 'direct-navigation'
  });
  await store.finishImport(started.id, {
    status: 'complete',
    importId: started.id,
    counts: counts({ recordsSeen: 1 })
  });

  await assert.rejects(
    () => store.reassignScope(started.id, 'scope-new', false),
    /catalog_/
  );
  const reassigned = await store.reassignScope(started.id, 'scope-new', true);
  assert.equal(reassigned.changed, true);
  assert.equal(reassigned.previousProfileScopeId, 'scope-old');
  assert.equal(reassigned.profileScopeId, 'scope-new');

  const oldIdentity = identity('reassigned-thread', 'scope-old');
  const newIdentity = identity('reassigned-thread', 'scope-new');
  assert.equal(await store.hasIdentity(oldIdentity), false);
  assert.equal(await store.hasIdentity(newIdentity), true);
  assert.equal(await store.latestImportedSnapshot(newIdentity), null);
  assert.equal((await store.get(newIdentity)).route.kind, 'unverified');
  const importState = byImportId(await store.listImports(), started.id);
  assert.equal(importState.status, 'partial');
  assert.deepEqual(importState.cursor, initialImportCursor());
  assert.equal(importState.suspension.reason, 'scope-reassigned');

  const resumed = await store.beginImport(manifest('1'), assignment('scope-new'), importCapacity());
  const replay = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'reassigned-thread',
    profileScopeId: 'scope-new'
  });
  await commitOne(store, resumed.id, replay.record, { schemaVersion: 1, recordIndex: 1 });
  assert.deepEqual(await store.latestImportedSnapshot(newIdentity), replay.importedSnapshot);

  const replacement = await store.beginImport(manifest('2'), assignment('scope-old'), importCapacity());
  const replacementPrepared = await completePrepared({
    blobs,
    importId: replacement.id,
    recordIndex: 0,
    conversationId: 'reassigned-thread',
    profileScopeId: 'scope-old'
  });
  await commitOne(store, replacement.id, replacementPrepared.record, { schemaVersion: 1, recordIndex: 1 });
  assert.equal((await store.get(oldIdentity)).route.kind, 'unverified');
});

test('catalog store: real replace failures reconcile or remain retryable without splitting batch and cursor', async (t) => {
  for (const failurePoint of ['before-rename', 'after-rename']) {
    await t.test(failurePoint, async (t) => {
      const stateDir = await tempState(t, `replace-${failurePoint}`);
      const blobs = createPrivateLibraryBlobStore({ stateDir });
      const initial = makeStore({ stateDir, blobs, randomId: () => `replace-${failurePoint}` });
      const started = await initial.beginImport(
        manifest(failurePoint === 'before-rename' ? '2' : '3'),
        assignment(),
        importCapacity(2)
      );
      const prepared = await Promise.all([0, 1].map(async (recordIndex) => await completePrepared({
        blobs,
        importId: started.id,
        recordIndex,
        conversationId: `${failurePoint}-thread-${recordIndex}`
      })));

      let failNextRename = false;
      const operations = proxiedOperations({
        async rename(...args) {
          if (failNextRename && failurePoint === 'before-rename') {
            failNextRename = false;
            throw Object.assign(new Error('injected replace failure'), { code: 'EIO' });
          }
          const result = await fs.rename(...args);
          if (failNextRename) {
            failNextRename = false;
            throw Object.assign(new Error('injected ambiguous replace result'), { code: 'EIO' });
          }
          return result;
        }
      });
      const failing = makeStore({
        stateDir,
        blobs,
        fileSystem: createPrivateFileSystem({ operations })
      });
      await failing.load();
      failNextRename = true;
      const operation = () => failing.commitPreparedRecords(
          started.id,
          prepared.map(({ record }) => record),
          { schemaVersion: 1, recordIndex: 2 }
        );
      if (failurePoint === 'before-rename') await assert.rejects(operation, /catalog_store_io/);
      else await operation();

      const durableImport = byImportId(await failing.listImports(), started.id);
      const visibility = await Promise.all(prepared.map(({ record }) => failing.hasIdentity(record.identity)));
      if (failurePoint === 'before-rename') {
        assert.deepEqual(durableImport.cursor, initialImportCursor());
        assert.deepEqual(visibility, [false, false]);
        await operation();
        assert.deepEqual(byImportId(await failing.listImports(), started.id).cursor, {
          schemaVersion: 1,
          recordIndex: 2
        });
      } else {
        assert.deepEqual(durableImport.cursor, { schemaVersion: 1, recordIndex: 2 });
        assert.deepEqual(visibility, [true, true]);
        for (const fixture of prepared) {
          assert.deepEqual(
            await failing.latestImportedSnapshot(fixture.record.identity),
            fixture.importedSnapshot
          );
        }
      }
    });
  }
});

test('catalog store: uncertain reload is coalesced before interruption can persist', async (t) => {
  const stateDir = await tempState(t, 'reload-coalesced');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'reload-coalesced' });
  const started = await initial.beginImport(manifest('6'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'reload-coalesced-thread'
  });
  const baseFileSystem = createPrivateFileSystem();
  let armUncertainWrite = false;
  let gateMetadataReads = false;
  let metadataReads = 0;
  let resolveCaptured;
  let resolveRelease;
  const captured = new Promise((resolve) => { resolveCaptured = resolve; });
  const release = new Promise((resolve) => { resolveRelease = resolve; });
  const fileSystem = Object.freeze({
    ...baseFileSystem,
    async replaceFile(...args) {
      await baseFileSystem.replaceFile(...args);
      if (armUncertainWrite) {
        armUncertainWrite = false;
        gateMetadataReads = true;
        const error = new Error('injected uncertain replacement');
        error.code = 'private_replace_uncertain';
        throw error;
      }
    },
    async readPrivateFile(filePath, options) {
      const bytes = await baseFileSystem.readPrivateFile(filePath, options);
      if (gateMetadataReads && filePath === initial.statePath) {
        metadataReads += 1;
        if (metadataReads === 1) {
          resolveCaptured();
          await release;
        }
      }
      return bytes;
    }
  });
  const store = makeStore({ stateDir, blobs, fileSystem });
  await store.load();
  armUncertainWrite = true;
  await assert.rejects(
    commitOne(store, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 }),
    /catalog_store_io/
  );

  const firstRead = store.listImports();
  await captured;
  const secondRead = store.listImports();
  let interruptSettled = false;
  const interrupt = store.interruptImport(started.id).then((value) => {
    interruptSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(metadataReads, 1);
  assert.equal(interruptSettled, false);

  resolveRelease();
  await Promise.all([firstRead, secondRead]);
  const interrupted = await interrupt;
  assert.equal(interrupted.status, 'partial');
  assert.equal(interrupted.suspension.reason, 'interrupted');
  const restarted = makeStore({ stateDir, blobs });
  assert.equal((await restarted.listImports())[0].status, 'partial');
  assert.equal((await store.beginImport(manifest('6'), assignment(), importCapacity())).status, 'open');
});

test('catalog store: a transient initial filesystem read failure is retryable', async (t) => {
  const stateDir = await tempState(t, 'load-retry');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'load-retry' });
  await initial.beginImport(manifest('7'), assignment(), importCapacity(0));
  let failPathKind = true;
  const operations = proxiedOperations({
    async lstat(...args) {
      if (failPathKind) {
        failPathKind = false;
        throw Object.assign(new Error('injected transient path read'), { code: 'EIO' });
      }
      return await fs.lstat(...args);
    }
  });
  const retrying = makeStore({
    stateDir,
    blobs,
    fileSystem: createPrivateFileSystem({ operations })
  });
  await assert.rejects(retrying.listImports(), /catalog_store_io/);
  assert.equal((await retrying.listImports()).length, 1);
});

test('catalog store: invalid UTF-8 metadata fails closed without normalizing corrupt bytes', async (t) => {
  const stateDir = await tempState(t, 'invalid-utf8');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'invalid-utf8' });
  const started = await initial.beginImport(manifest('8'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'invalid-utf8-thread',
    title: 'Utf8Title'
  });
  await commitOne(initial, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  const bytes = await fs.readFile(initial.statePath);
  const offset = bytes.indexOf(Buffer.from('Utf8Title'));
  assert.notEqual(offset, -1);
  bytes[offset] = 0xff;
  await fs.writeFile(initial.statePath, bytes, { mode: 0o600 });

  const restarted = makeStore({ stateDir, blobs });
  await assert.rejects(restarted.listImports(), /catalog_store_corrupt_state/);
  assert.deepEqual(await fs.readFile(initial.statePath), bytes);
});

test('catalog store: a persisted lone-surrogate title fails closed on restart', async (t) => {
  const stateDir = await tempState(t, 'invalid-title-unicode');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initial = makeStore({ stateDir, blobs, randomId: () => 'invalid-title-unicode' });
  const started = await initial.beginImport(manifest('3'), assignment(), importCapacity());
  const prepared = await completePrepared({
    blobs,
    importId: started.id,
    recordIndex: 0,
    conversationId: 'invalid-title-unicode',
    title: 'Valid title'
  });
  await commitOne(initial, started.id, prepared.record, { schemaVersion: 1, recordIndex: 1 });
  const state = JSON.parse(await fs.readFile(initial.statePath, 'utf8'));
  state.records[0].title = '\udc00';
  const corruptBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(initial.statePath, corruptBytes, { mode: 0o600 });

  const restarted = makeStore({ stateDir, blobs });
  await assert.rejects(restarted.listImports(), /catalog_store_corrupt_state/);
  assert.deepEqual(await fs.readFile(initial.statePath), corruptBytes);
});

test('catalog store: malformed persisted state fails closed after restart', async (t) => {
  const stateDir = await tempState(t, 'corrupt-state');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = makeStore({ stateDir, blobs, randomId: () => 'corrupt-state' });
  await store.beginImport(manifest('4'), assignment(), importCapacity(0));
  const state = JSON.parse(await fs.readFile(store.statePath, 'utf8'));
  state.unexpected = 'must not be accepted';
  await fs.writeFile(store.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

  const restarted = makeStore({ stateDir, blobs });
  await assert.rejects(() => restarted.load(), /catalog_store_corrupt_state/);
});

test('catalog store: a maximum import reserves capacity through interruption and restart', async (t) => {
  const stateDir = await tempState(t, 'capacity-reservation');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  let nextId = 0;
  const store = makeStore({ stateDir, blobs, randomId: () => `capacity-${++nextId}` });
  const maximum = importCapacity(MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS);
  const firstBegin = store.beginImport(manifest('5'), assignment(), maximum);
  const competingBegin = store.beginImport(manifest('6'), assignment(), maximum);
  const started = await firstBegin;
  await assert.rejects(competingBegin, /catalog_store_size_limit/);
  assert.equal((await store.listImports()).length, 1);

  await store.interruptImport(started.id);
  const restarted = makeStore({
    stateDir,
    blobs,
    randomId: () => 'capacity-second',
    clock: () => '2026-07-31T12:01:00.000Z'
  });
  assert.deepEqual(await restarted.recoverInterruptedImports(), []);
  await assert.rejects(
    restarted.beginImport(manifest('6'), assignment(), maximum),
    /catalog_store_size_limit/
  );
  assert.equal((await restarted.listImports()).length, 1);

  const resumed = await restarted.beginImport(manifest('5'), assignment(), maximum);
  assert.equal(resumed.id, started.id);
  assert.equal(resumed.status, 'open');
  assert.deepEqual(resumed.cursor, initialImportCursor());
});

test('catalog store: the archive record ceiling fits worst accepted metadata shapes', { timeout: 30_000 }, async (t) => {
  const stateDir = await tempState(t, 'archive-capacity');
  const catalogRoot = path.join(stateDir, 'transcript-library', 'catalog');
  await fs.mkdir(catalogRoot, { recursive: true, mode: 0o700 });
  const importId = 'i'.repeat(256);
  const profileScopeId = 'a'.repeat(128);
  const recordIdentity = identity('b'.repeat(256), profileScopeId);
  const rawRecord = {
    kind: 'raw',
    algorithm: 'sha256',
    hash: 'a'.repeat(64),
    byteLength: Number.MAX_SAFE_INTEGER
  };
  const importedSnapshot = {
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: 'b'.repeat(64),
    contentHash: 'c'.repeat(64),
    byteLength: Number.MAX_SAFE_INTEGER
  };
  const records = Array.from(
    { length: MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS },
    (_, recordIndex) => {
      const problem = recordIndex < 10_000
        ? { recordIndex, reason: 'active-branch-ambiguous', identity: recordIdentity }
        : null;
      return {
        schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
        importId,
        recordIndex,
        identity: recordIdentity,
        title: '界'.repeat(512),
        rawRecord,
        importedSnapshot: problem === null ? importedSnapshot : null,
        observedAt: '9999-12-31T23:59:59.999Z',
        problem
      };
    }
  );
  const persisted = {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    revision: 1,
    imports: [{
      schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
      id: importId,
      manifest: {
        archiveHash: 'd'.repeat(64),
        layout: 'numbered-conversations-json',
        accountHint: `chatgpt-user-id:sha256:${'e'.repeat(64)}`
      },
      assignment: { profileScopeId, confirmed: true },
      capacity: { recordCount: records.length },
      readOnlyReason: null,
      status: 'partial',
      cursor: { schemaVersion: 1, recordIndex: records.length },
      suspension: null,
      createdAt: NOW,
      updatedAt: NOW
    }],
    records,
    routeHistories: []
  };
  const bytes = Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`);
  const maximumProblemProjection = {
    ...persisted,
    imports: persisted.imports.map((catalogImport) => ({
      ...catalogImport,
      suspension: { reason: 'scope-reassigned', observedAt: '9999-12-31T23:59:59.999Z' }
    })),
    records: records.map((record) => ({
      ...record,
      importedSnapshot: null,
      problem: {
        recordIndex: record.recordIndex,
        reason: 'active-branch-ambiguous',
        identity: record.identity
      }
    }))
  };
  const maximumProblemBytes = Buffer.from(`${JSON.stringify(maximumProblemProjection, null, 2)}\n`);
  assert.equal(MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS, 20_000);
  assert.equal(bytes.length < MAX_CONVERSATION_CATALOG_STATE_BYTES, true);
  assert.equal(maximumProblemBytes.length < MAX_CONVERSATION_CATALOG_STATE_BYTES, true);

  const limitedStateDir = await tempState(t, 'archive-capacity-limited');
  const limitedBlobs = createPrivateLibraryBlobStore({ stateDir: limitedStateDir });
  const limited = makeStore({
    stateDir: limitedStateDir,
    blobs: limitedBlobs,
    randomId: () => 'limited-capacity',
    maxStateBytes: maximumProblemBytes.length - 1
  });
  await assert.rejects(
    limited.beginImport(manifest('e'), assignment(), importCapacity(MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS)),
    /catalog_store_size_limit/
  );
  assert.deepEqual(await limited.listImports(), []);

  await fs.writeFile(path.join(catalogRoot, 'state.json'), bytes, { mode: 0o600 });

  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createConversationCatalogStore({ stateDir, blobs });
  const [catalogImport] = await store.listImports();
  assert.equal(catalogImport.cursor.recordIndex, MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS);
  assert.equal(catalogImport.counts.recordsSeen, MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS);
  assert.equal(catalogImport.counts.problems, 10_000);
});
