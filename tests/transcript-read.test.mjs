import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { identityFromOwnedLocation } from '../conversation-identity.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../library-blob-store.mjs';
import {
  normalizeLiveCapture,
  TRANSCRIPT_TURN_MAX_TEXT_CHARS
} from '../transcript-contract.mjs';
import {
  createTranscriptReadService,
  TRANSCRIPT_PAGE_MAX_LIMIT,
  TRANSCRIPT_PAGE_MAX_TEXT_CHARS
} from '../transcript-read.mjs';

async function tempState(t, name) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-read-${name}-`));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function capture({ thread = 'read-thread', capturedAt = '2026-07-30T15:00:00.000Z', texts = null } = {}) {
  const values = texts || ['first prompt', 'first reply', 'second prompt', 'second reply', 'final prompt'];
  const rawTurns = values.map((text, ordinal) => ({
    ordinal,
    providerMessageId: `${thread}-message-${ordinal + 1}`,
    role: ordinal % 2 === 0 ? 'user' : 'assistant',
    text
  }));
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

function snapshotFor(captureValue) {
  const identity = identityFromOwnedLocation('profile-main', locationFromConversationUrl(captureValue.conversationUrl));
  return makeTranscriptSnapshot({
    identity,
    normalizedTranscript: normalizeLiveCapture(captureValue),
    origin: {
      kind: 'live-capture',
      conversationUrl: captureValue.conversationUrl,
      captureEvidence: captureValue.evidence
    },
    capturedAt: captureValue.capturedAt
  });
}

function sourceFor(identity, ref, { id = 'source-read', key = 'read-key' } = {}) {
  const location = locationFromConversationUrl(`https://chatgpt.com/c/${identity.providerConversationId}`);
  return {
    id,
    identity,
    key,
    enabled: true,
    target: { kind: 'owned-conversation', location },
    latestLiveSnapshot: ref
  };
}

function serviceFor({ blobs, source = null, importedRef = null, importedKnown = false, maxPageTextChars } = {}) {
  return createTranscriptReadService({
    sources: { findSource: async () => source },
    imported: {
      latestImportedSnapshot: async () => importedRef,
      hasIdentity: async () => importedKnown
    },
    blobs,
    ...(maxPageTextChars ? { maxPageTextChars } : {})
  });
}

test('transcript read: pages whole structured turns with exact immutable citations and cursor binding', async (t) => {
  const stateDir = await tempState(t, 'pages');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture());
  const ref = await blobs.putSnapshot(snapshot);
  const source = sourceFor(snapshot.identity, ref);
  const service = serviceFor({ blobs, source });

  const first = await service.get({ identity: snapshot.identity, limit: 2 });
  assert.equal(first.text, 'User\nfirst prompt\n\nAssistant\nfirst reply');
  assert.deepEqual(first.structuredTurns, snapshot.turns.slice(0, 2));
  assert.deepEqual(first.citations, snapshot.turns.slice(0, 2).map(({ turnId }) => ({
    identity: 'chatgpt/profile-main/read-thread',
    snapshotHash: snapshot.snapshotHash,
    turnId
  })));
  assert.deepEqual(first.nextCursor, {
    schemaVersion: 1,
    snapshotHash: snapshot.snapshotHash,
    afterTurnId: snapshot.turns[1].turnId
  });
  assert.equal(first.liveSourceId, 'source-read');
  assert.equal(first.sourceKey, 'read-key');
  assert.equal(first.conversationUrl, 'https://chatgpt.com/c/read-thread');
  assert.equal(Object.hasOwn(first, 'paths'), false);

  const second = await service.get({
    identity: snapshot.identity,
    snapshot: first.snapshot,
    cursor: first.nextCursor,
    limit: 2
  });
  assert.equal(second.startOrdinal, 2);
  assert.equal(second.endOrdinal, 4);
  assert.deepEqual(second.structuredTurns, snapshot.turns.slice(2, 4));
});

test('transcript read: malformed source keys from the source dependency fail closed', async (t) => {
  const stateDir = await tempState(t, 'invalid-source-key');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture());
  const ref = await blobs.putSnapshot(snapshot);
  const validSource = sourceFor(snapshot.identity, ref);

  for (const source of [
    { ...validSource, key: ' padded-key ' },
    { ...validSource, key: 'control\nkey' },
    { ...validSource, key: ' disabled-and-padded ', enabled: false }
  ]) {
    const service = serviceFor({ blobs, source });
    await assert.rejects(
      () => service.get({ identity: snapshot.identity, limit: 1 }),
      /transcript_source_invalid/
    );
  }
});

test('transcript read: a maximum valid turn is retrievable at the default page boundary', async (t) => {
  const stateDir = await tempState(t, 'default-turn-boundary');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture({
    thread: 'read-max-turn',
    texts: ['short first turn', 'A'.repeat(TRANSCRIPT_TURN_MAX_TEXT_CHARS)]
  }));
  const ref = await blobs.putSnapshot(snapshot);
  const service = serviceFor({ blobs, source: sourceFor(snapshot.identity, ref) });

  const first = await service.get({ identity: snapshot.identity, limit: 1 });
  const second = await service.get({ identity: snapshot.identity, cursor: first.nextCursor, limit: 1 });
  assert.equal(second.text.length, TRANSCRIPT_PAGE_MAX_TEXT_CHARS);
  assert.equal(second.structuredTurns.length, 1);
  assert.equal(second.nextCursor, null);
});

test('transcript read: page sizing inspects only the requested bounded turn window', async (t) => {
  const stateDir = await tempState(t, 'bounded-window');
  const realBlobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture({
    thread: 'read-bounded-window',
    texts: Array.from({ length: 150 }, (_, ordinal) => `turn ${ordinal}`)
  }));
  const ref = await realBlobs.putSnapshot(snapshot);
  let highestTurnRead = -1;
  const turns = new Proxy(snapshot.turns, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/.test(property)) {
        highestTurnRead = Math.max(highestTurnRead, Number(property));
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const blobs = {
    getSnapshot: async () => ({ ...snapshot, turns }),
    pathFor: (value) => realBlobs.pathFor(value)
  };
  const service = serviceFor({ blobs, source: sourceFor(snapshot.identity, ref) });

  const page = await service.get({ identity: snapshot.identity, limit: TRANSCRIPT_PAGE_MAX_LIMIT });
  assert.equal(page.structuredTurns.length, TRANSCRIPT_PAGE_MAX_LIMIT);
  assert.equal(page.endOrdinal, TRANSCRIPT_PAGE_MAX_LIMIT);
  assert.equal(highestTurnRead, TRANSCRIPT_PAGE_MAX_LIMIT - 1);
});

test('transcript read: every page request re-verifies the immutable snapshot bytes', async (t) => {
  const stateDir = await tempState(t, 'reverify-between-pages');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture({ thread: 'read-reverify-pages' }));
  const ref = await blobs.putSnapshot(snapshot);
  const service = serviceFor({ blobs, source: sourceFor(snapshot.identity, ref) });
  const first = await service.get({ identity: snapshot.identity, limit: 2 });

  await fs.writeFile(blobs.pathFor(ref), '{"tampered":true}', { mode: 0o600 });
  await assert.rejects(
    () => service.get({
      identity: snapshot.identity,
      snapshot: first.snapshot,
      cursor: first.nextCursor,
      limit: 2
    }),
    /library_blob_/
  );
});

test('transcript read: cursor fails closed when latest changes and succeeds with its explicit snapshot', async (t) => {
  const stateDir = await tempState(t, 'cursor-change');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const oldSnapshot = snapshotFor(capture({ capturedAt: '2026-07-30T15:00:00.000Z' }));
  const newSnapshot = snapshotFor(capture({ capturedAt: '2026-07-30T15:01:00.000Z', texts: [
    'first prompt', 'first reply', 'second prompt', 'second reply', 'new final reply'
  ] }));
  const oldRef = await blobs.putSnapshot(oldSnapshot);
  const newRef = await blobs.putSnapshot(newSnapshot);
  let liveRef = oldRef;
  const source = sourceFor(oldSnapshot.identity, oldRef);
  const service = createTranscriptReadService({
    sources: { findSource: async () => ({ ...source, latestLiveSnapshot: liveRef }) },
    imported: { latestImportedSnapshot: async () => null, hasIdentity: async () => false },
    blobs
  });
  const first = await service.get({ identity: oldSnapshot.identity, limit: 2 });
  liveRef = newRef;

  await assert.rejects(
    () => service.get({ identity: oldSnapshot.identity, cursor: first.nextCursor, limit: 2 }),
    /transcript_cursor_mismatch/
  );
  const continued = await service.get({
    identity: oldSnapshot.identity,
    snapshot: oldRef,
    cursor: first.nextCursor,
    limit: 2
  });
  assert.equal(continued.snapshot.hash, oldRef.hash);
  assert.deepEqual(continued.structuredTurns, oldSnapshot.turns.slice(2, 4));
});

test('transcript read: explicit snapshot wins and default selection is newest with a hash tie-break', async (t) => {
  const stateDir = await tempState(t, 'selection');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const liveSnapshot = snapshotFor(capture({ capturedAt: '2026-07-30T15:00:00.000Z', texts: ['live prompt'] }));
  const importedSnapshot = snapshotFor(capture({ capturedAt: '2026-07-30T15:02:00.000Z', texts: ['imported prompt'] }));
  const liveRef = await blobs.putSnapshot(liveSnapshot);
  const importedRef = await blobs.putSnapshot(importedSnapshot);
  const source = sourceFor(liveSnapshot.identity, liveRef);
  const service = serviceFor({ blobs, source, importedRef, importedKnown: true });

  assert.equal((await service.get({ identity: liveSnapshot.identity })).snapshot.hash, importedRef.hash);
  assert.equal((await service.get({ identity: liveSnapshot.identity, snapshot: liveRef })).snapshot.hash, liveRef.hash);

  const sameTimeImported = snapshotFor(capture({ capturedAt: liveSnapshot.capturedAt, texts: ['same-time import'] }));
  const sameTimeRef = await blobs.putSnapshot(sameTimeImported);
  const tieService = serviceFor({ blobs, source, importedRef: sameTimeRef, importedKnown: true });
  assert.equal(
    (await tieService.get({ identity: liveSnapshot.identity })).snapshot.hash,
    [liveRef.hash, sameTimeRef.hash].sort()[0]
  );

  await assert.rejects(
    () => serviceFor({
      blobs,
      source,
      importedRef: { ...liveRef, contentHash: 'f'.repeat(64) },
      importedKnown: true
    }).get({ identity: liveSnapshot.identity }),
    /transcript_import_index_invalid/
  );
});

test('transcript read: unknown identity and known identity without a complete snapshot stay distinct', async (t) => {
  const stateDir = await tempState(t, 'absence');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const identity = snapshotFor(capture()).identity;

  await assert.rejects(
    () => serviceFor({ blobs }).get({ identity }),
    /transcript_identity_not_found/
  );
  await assert.rejects(
    () => serviceFor({ blobs, source: sourceFor(identity, null) }).get({ identity }),
    /transcript_no_complete_snapshot/
  );
  await assert.rejects(
    () => serviceFor({ blobs, importedKnown: true }).get({ identity }),
    /transcript_no_complete_snapshot/
  );
});

test('transcript read: exact requests, bounded pages, and whole-turn character limits fail distinctly', async (t) => {
  const stateDir = await tempState(t, 'limits');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture({ texts: ['0123456789', 'short reply'] }));
  const ref = await blobs.putSnapshot(snapshot);
  const source = sourceFor(snapshot.identity, ref);
  const service = serviceFor({ blobs, source, maxPageTextChars: 14 });

  await assert.rejects(
    () => service.get({ identity: snapshot.identity, limit: TRANSCRIPT_PAGE_MAX_LIMIT + 1 }),
    /transcript_page_limit/
  );
  await assert.rejects(
    () => service.get({ identity: snapshot.identity, extra: true }),
    /transcript_request_invalid/
  );
  await assert.rejects(
    () => service.get({ identity: snapshot.identity, cursor: { schemaVersion: 1, snapshotHash: ref.hash, afterTurnId: 'missing' } }),
    /transcript_cursor_mismatch/
  );
  await assert.rejects(
    () => service.get({ identity: snapshot.identity, limit: 1 }),
    /transcript_page_character_limit/
  );
});

test('transcript read: explicit missing and mismatched snapshots fail without fallback', async (t) => {
  const stateDir = await tempState(t, 'explicit');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture());
  const ref = await blobs.putSnapshot(snapshot);
  const source = sourceFor(snapshot.identity, ref);
  const service = serviceFor({ blobs, source });

  await assert.rejects(
    () => service.get({ identity: { ...snapshot.identity, profileScopeId: 'other-profile' }, snapshot: ref }),
    /transcript_snapshot_identity_mismatch/
  );
  await assert.rejects(
    () => service.get({ identity: snapshot.identity, snapshot: { ...ref, hash: 'f'.repeat(64) } }),
    /transcript_snapshot_not_found/
  );
});

test('transcript read: local snapshot paths require an explicit request and imported-only pages are non-continuable', async (t) => {
  const stateDir = await tempState(t, 'paths');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const snapshot = snapshotFor(capture());
  const ref = await blobs.putSnapshot(snapshot);
  const importedOnly = serviceFor({ blobs, importedRef: ref, importedKnown: true });

  const hidden = await importedOnly.get({ identity: snapshot.identity });
  assert.equal(Object.hasOwn(hidden, 'paths'), false);
  assert.equal(hidden.liveSourceId, null);
  assert.equal(hidden.sourceKey, null);
  assert.equal(hidden.conversationUrl, null);

  const explicit = await importedOnly.get({ identity: snapshot.identity, includePaths: true });
  assert.deepEqual(explicit.paths, { snapshot: blobs.pathFor(ref) });

  const disabled = serviceFor({
    blobs,
    source: { ...sourceFor(snapshot.identity, ref), enabled: false }
  });
  const disabledPage = await disabled.get({ identity: snapshot.identity });
  assert.equal(disabledPage.liveSourceId, null);
  assert.equal(disabledPage.sourceKey, null);
  assert.equal(disabledPage.conversationUrl, null);

  const mismatchedRoute = serviceFor({
    blobs,
    source: {
      ...sourceFor(snapshot.identity, ref),
      target: {
        kind: 'owned-conversation',
        location: locationFromConversationUrl('https://chatgpt.com/c/different-thread')
      }
    }
  });
  await assert.rejects(
    () => mismatchedRoute.get({ identity: snapshot.identity }),
    /transcript_source_invalid/
  );
});
