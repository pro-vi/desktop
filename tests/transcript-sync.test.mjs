import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { identityFromOwnedLocation } from '../conversation-identity.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import { createPrivateLibraryBlobStore } from '../library-blob-store.mjs';
import {
  createChatGptTranscriptCapture,
  createTranscriptSyncService
} from '../transcript-sync.mjs';
import { createTranscriptStore } from '../transcript-store.mjs';

async function tempState(t, name) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-sync-${name}-`));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function clockAt(second = 0) {
  let tick = second;
  return () => new Date(Date.UTC(2026, 6, 30, 14, 0, tick++)).toISOString();
}

function ids(prefix) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function completeCapture({
  thread = 'sync-thread',
  capturedAt = '2026-07-30T14:00:10.000Z',
  firstText = 'Sync fixture prompt'
} = {}) {
  const rawTurns = [
    { ordinal: 0, providerMessageId: `${thread}-message-1`, role: 'user', text: firstText },
    { ordinal: 1, providerMessageId: `${thread}-message-2`, role: 'assistant', text: 'Sync fixture reply' }
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

function partialCapture(reason = 'conversation_top_not_reached') {
  const complete = completeCapture();
  return {
    ...complete,
    status: 'partial',
    reason,
    evidence: { ...complete.evidence, topBoundary: false }
  };
}

function trackInput({ thread = 'sync-thread', key = 'sync-key', scope = 'personal' } = {}) {
  const location = locationFromConversationUrl(`https://chatgpt.com/c/${thread}`);
  return {
    label: 'Sync fixture',
    tags: ['fixture'],
    key,
    identity: identityFromOwnedLocation(scope, location),
    location
  };
}

function capturePort(handler) {
  return { captureOwnedSource: handler };
}

async function realParts(t, name, handler, { onChanged = null } = {}) {
  const stateDir = await tempState(t, name);
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids(name) });
  const service = createTranscriptSyncService({
    store,
    blobs,
    capture: capturePort(handler),
    ...(onChanged ? { onChanged } : {})
  });
  return { stateDir, blobs, store, service };
}

test('transcript capture port: recreation, navigation, and capture share one exclusive section', async () => {
  const events = [];
  const capture = completeCapture();
  const controller = {
    async runExclusive(operation) {
      events.push('exclusive:start');
      const result = await operation();
      events.push('exclusive:end');
      return result;
    },
    async prepareChatEntry(input) {
      events.push(['prepare', input]);
    },
    async captureConversation(input) {
      events.push(['capture', input]);
      return capture;
    }
  };
  const tabs = {
    async ensureTab(input) {
      events.push(['ensure', input]);
      return 'tab-1';
    },
    getControllerById(id) {
      events.push(['controller', id]);
      return controller;
    }
  };
  const port = createChatGptTranscriptCapture({
    tabs,
    maxCaptureBytes: 123_456,
    navigationTimeoutMs: 12_000
  });
  const input = trackInput();
  const source = {
    ...input,
    target: { kind: 'owned-conversation', location: input.location }
  };

  assert.deepEqual(await port.captureOwnedSource(source), capture);
  assert.deepEqual(events.map((event) => Array.isArray(event) ? event[0] : event), [
    'ensure', 'controller', 'exclusive:start', 'prepare', 'capture', 'exclusive:end'
  ]);
  assert.deepEqual(events[0][1], {
    key: 'sync-key',
    name: 'Sync fixture',
    url: 'https://chatgpt.com/c/sync-thread',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    show: false,
    projectUrl: null
  });
  assert.deepEqual(events[3][1], {
    chatUrl: 'https://chatgpt.com/c/sync-thread',
    timeoutMs: 12_000
  });
  assert.deepEqual(events[4][1], { maxCaptureBytes: 123_456 });
});

test('transcript capture port: a served route with another exact identity fails closed', async () => {
  const tabs = {
    async ensureTab() { return 'tab-1'; },
    getControllerById() {
      return {
        runExclusive: async (operation) => await operation(),
        prepareChatEntry: async () => {},
        captureConversation: async () => completeCapture({ thread: 'other-thread' })
      };
    }
  };
  const input = trackInput();
  const port = createChatGptTranscriptCapture({ tabs });
  await assert.rejects(() => port.captureOwnedSource({
    ...input,
    target: { kind: 'owned-conversation', location: input.location }
  }), /transcript_capture_identity_mismatch/);
});

test('transcript capture port: raw Electron load failures become a safe navigation code', async () => {
  const tabs = {
    async ensureTab() { return 'tab-1'; },
    getControllerById() {
      return {
        runExclusive: async (operation) => await operation(),
        prepareChatEntry: async () => { throw new Error('ERR_NAME_NOT_RESOLVED (-105)'); },
        captureConversation: async () => { throw new Error('must not capture'); }
      };
    }
  };
  const input = trackInput();
  const port = createChatGptTranscriptCapture({ tabs });

  await assert.rejects(() => port.captureOwnedSource({
    ...input,
    target: { kind: 'owned-conversation', location: input.location }
  }), (error) => {
    assert.equal(error.code, 'navigation_failed');
    assert.equal(error.message, 'navigation_failed');
    return true;
  });
});

test('transcript capture port: a tab destroyed after controller resolution remains distinct', async () => {
  let closed = false;
  const controller = {
    runExclusive: async (operation) => await operation(),
    prepareChatEntry: async () => {
      closed = true;
      throw new Error('Render frame was disposed during load');
    },
    captureConversation: async () => { throw new Error('must not capture'); }
  };
  const tabs = {
    async ensureTab() { return 'tab-1'; },
    getControllerById() {
      if (closed) throw new Error('tab_closed');
      return controller;
    }
  };
  const input = trackInput();
  const port = createChatGptTranscriptCapture({ tabs });

  await assert.rejects(() => port.captureOwnedSource({
    ...input,
    target: { kind: 'owned-conversation', location: input.location }
  }), (error) => {
    assert.equal(error.code, 'tab_closed');
    assert.equal(error.message, 'tab_closed');
    return true;
  });
});

test('transcript sync: track delegates the exact owned target and rejects extra fields', async (t) => {
  const { service, store } = await realParts(t, 'track', async () => completeCapture());
  const input = trackInput();
  const source = await service.track(input);

  assert.deepEqual(source.identity, input.identity);
  assert.deepEqual(source.target, { kind: 'owned-conversation', location: input.location });
  assert.deepEqual(await store.findSource(input.identity), source);
  await assert.rejects(() => service.track({ ...trackInput({ thread: 'extra' }), extra: true }), /transcript_track_invalid/);
});

test('transcript sync: content-free change notifications cover durable track, attempt, completion, and forget states', async (t) => {
  const changes = [];
  const { service } = await realParts(t, 'changes', async () => completeCapture(), {
    onChanged: () => changes.push('changed')
  });
  const source = await service.track(trackInput({ thread: 'changes-thread', key: 'changes-key' }));
  assert.equal(changes.length, 1);
  await service.sync(source.id);
  assert.equal(changes.length, 3);
  await service.forget(source.id);
  assert.equal(changes.length, 4);
});

test('transcript sync: complete flow is begin then capture then blob then one atomic commit', async (t) => {
  const stateDir = await tempState(t, 'ordering');
  const events = [];
  const realBlobs = createPrivateLibraryBlobStore({ stateDir });
  const realStore = createTranscriptStore({
    stateDir,
    blobs: realBlobs,
    clock: clockAt(),
    randomId: ids('ordering')
  });
  const store = {
    ...realStore,
    async beginAttempt(...args) {
      events.push('begin');
      return await realStore.beginAttempt(...args);
    },
    async commitComplete(...args) {
      events.push('commit');
      return await realStore.commitComplete(...args);
    }
  };
  const blobs = {
    ...realBlobs,
    async putSnapshot(...args) {
      events.push('blob');
      return await realBlobs.putSnapshot(...args);
    }
  };
  const service = createTranscriptSyncService({
    store,
    blobs,
    capture: capturePort(async () => {
      events.push('capture');
      return completeCapture();
    })
  });
  const source = await service.track(trackInput());

  const result = await service.sync(source.id);

  assert.deepEqual(events, ['begin', 'capture', 'blob', 'commit']);
  assert.equal(result.status, 'complete');
  assert.equal(result.outcome.changed, true);
  assert.equal(result.source.latestLiveSnapshot.contentHash, result.outcome.snapshot.contentHash);
  assert.equal((await realBlobs.getSnapshot(result.outcome.snapshot)).identity.providerConversationId, 'sync-thread');
});

test('transcript sync: partial capture is durable and never publishes a snapshot', async (t) => {
  const stateDir = await tempState(t, 'partial');
  const realBlobs = createPrivateLibraryBlobStore({ stateDir });
  let putCalls = 0;
  const blobs = {
    ...realBlobs,
    async putSnapshot(...args) {
      putCalls += 1;
      return await realBlobs.putSnapshot(...args);
    }
  };
  const store = createTranscriptStore({ stateDir, blobs: realBlobs, clock: clockAt(), randomId: ids('partial') });
  const service = createTranscriptSyncService({
    store,
    blobs,
    capture: capturePort(async () => partialCapture())
  });
  const source = await service.track(trackInput());

  const result = await service.sync(source.id);

  assert.equal(result.status, 'partial');
  assert.equal(result.outcome.reason, 'conversation_top_not_reached');
  assert.equal(result.source.latestLiveSnapshot, null);
  assert.equal(putCalls, 0);
});

test('transcript sync: unavailable message text stays partial and preserves the prior complete snapshot', async (t) => {
  const captures = [
    completeCapture(),
    partialCapture('conversation_message_text_unavailable')
  ];
  const { service } = await realParts(t, 'message-text-unavailable', async () => captures.shift());
  const source = await service.track(trackInput());

  const complete = await service.sync(source.id);
  const partial = await service.sync(source.id);

  assert.equal(partial.status, 'partial');
  assert.equal(partial.outcome.reason, 'conversation_message_text_unavailable');
  assert.equal(partial.source.latestLiveSnapshot.hash, complete.outcome.snapshot.hash);
  assert.equal(partial.source.latestLiveSnapshot.contentHash, complete.outcome.snapshot.contentHash);
});

test('transcript sync: provider and capture failures become closed content-free outcomes', async (t) => {
  const failures = [
    [Object.assign(new Error('private words'), { data: { kind: 'login', excerpt: 'private words' } }), 'login'],
    [Object.assign(new Error('private words'), { data: { kind: 'captcha', excerpt: 'private words' } }), 'challenge'],
    [Object.assign(new Error('tab_closed: private words'), { code: 'tab_closed' }), 'tab_closed'],
    [Object.assign(new Error('private words'), { code: 'ECONNRESET' }), 'provider_transport'],
    [Object.assign(new Error('private words'), { code: 'transcript_capture_identity_mismatch' }), 'compatibility_drift'],
    [Object.assign(new Error('private words'), { code: 'key_vendor_mismatch' }), 'navigation_failed'],
    [Object.assign(new Error('private words'), { code: 'invalid_transcript_contract' }), 'capture_failed'],
    [new Error('private login journal excerpt'), 'capture_failed']
  ];
  const queue = failures.map(([error]) => error);
  const { service } = await realParts(t, 'failure-map', async () => { throw queue.shift(); });
  const source = await service.track(trackInput());

  for (const [, expected] of failures) {
    const result = await service.sync(source.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.outcome.reason, expected);
    assert.equal(JSON.stringify(result).includes('private words'), false);
    assert.equal(result.source.latestLiveSnapshot, null);
  }
});

test('transcript sync: blob failure is terminalized without persisting exception content', async (t) => {
  const stateDir = await tempState(t, 'blob-failure');
  const realBlobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({ stateDir, blobs: realBlobs, clock: clockAt(), randomId: ids('blob-failure') });
  const service = createTranscriptSyncService({
    store,
    blobs: {
      ...realBlobs,
      async putSnapshot() {
        throw new Error('private transcript and /private/archive/path');
      }
    },
    capture: capturePort(async () => completeCapture())
  });
  const source = await service.track(trackInput());

  const result = await service.sync(source.id);

  assert.equal(result.outcome.reason, 'snapshot_write_failed');
  assert.equal(result.source.latestLiveSnapshot, null);
  assert.equal(JSON.stringify(result).includes('private transcript'), false);
  assert.equal(JSON.stringify(result).includes('/private/archive/path'), false);
});

test('transcript sync: metadata commit failure propagates and restart recovers the open attempt', async (t) => {
  const stateDir = await tempState(t, 'commit-failure');
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const realStore = createTranscriptStore({ stateDir, blobs, clock: clockAt(), randomId: ids('commit-failure') });
  const store = {
    ...realStore,
    async commitComplete() {
      throw Object.assign(new Error('injected metadata boundary'), { code: 'transcript_store_io' });
    }
  };
  const service = createTranscriptSyncService({
    store,
    blobs,
    capture: capturePort(async () => completeCapture())
  });
  const source = await service.track(trackInput());

  await assert.rejects(() => service.sync(source.id), /injected metadata boundary/);
  assert.equal((await realStore.getSource(source.id)).state, 'syncing');
  const restarted = createTranscriptStore({ stateDir, blobs, clock: clockAt(50), randomId: ids('restart') });
  assert.equal(await restarted.recoverInterrupted(), 1);
  assert.equal((await restarted.getSource(source.id)).state, 'interrupted');
  assert.equal((await restarted.getSource(source.id)).latestLiveSnapshot, null);
  const snapshotNames = await fs.readdir(path.join(blobs.root, 'snapshot', 'sha256'), { recursive: true });
  assert.equal(snapshotNames.filter((name) => String(name).endsWith('.json')).length, 1);
});

test('transcript sync: corrupt-after-publication verification failure is durable and retryable', async (t) => {
  const stateDir = await tempState(t, 'corrupt-after-put');
  const realBlobs = createPrivateLibraryBlobStore({ stateDir });
  const store = createTranscriptStore({
    stateDir,
    blobs: realBlobs,
    clock: clockAt(),
    randomId: ids('corrupt-after-put')
  });
  let tamper = true;
  const blobs = {
    ...realBlobs,
    async putSnapshot(snapshot) {
      const ref = await realBlobs.putSnapshot(snapshot);
      if (tamper) {
        tamper = false;
        await fs.writeFile(realBlobs.pathFor(ref), '{"tampered":true}', { mode: 0o600 });
      }
      return ref;
    }
  };
  const service = createTranscriptSyncService({
    store,
    blobs,
    capture: capturePort(async () => completeCapture())
  });
  const source = await service.track(trackInput());

  const first = await service.sync(source.id);
  assert.equal(first.status, 'failed');
  assert.equal(first.outcome.reason, 'snapshot_write_failed');
  assert.equal(first.source.latestLiveSnapshot, null);
  assert.equal((await store.getSource(source.id)).state, 'failed');

  const retry = await service.sync(source.id);
  assert.equal(retry.status, 'failed');
  assert.equal(retry.outcome.reason, 'snapshot_write_failed');
  assert.notEqual(retry.source.state, 'syncing');
  assert.equal(retry.source.latestLiveSnapshot, null);
});

test('transcript sync: restart and unchanged recapture preserve content hash with changed false', async (t) => {
  const stateDir = await tempState(t, 'restart');
  const firstCapture = completeCapture({ capturedAt: '2026-07-30T14:01:00.000Z' });
  const firstBlobs = createPrivateLibraryBlobStore({ stateDir });
  const firstStore = createTranscriptStore({ stateDir, blobs: firstBlobs, clock: clockAt(), randomId: ids('first') });
  const firstService = createTranscriptSyncService({
    store: firstStore,
    blobs: firstBlobs,
    capture: capturePort(async () => firstCapture)
  });
  const source = await firstService.track(trackInput());
  const first = await firstService.sync(source.id);

  const secondBlobs = createPrivateLibraryBlobStore({ stateDir });
  const secondStore = createTranscriptStore({ stateDir, blobs: secondBlobs, clock: clockAt(60), randomId: ids('second') });
  assert.equal(await secondStore.recoverInterrupted(), 0);
  const secondService = createTranscriptSyncService({
    store: secondStore,
    blobs: secondBlobs,
    capture: capturePort(async () => completeCapture({ capturedAt: '2026-07-30T14:02:00.000Z' }))
  });
  const second = await secondService.sync(source.id);

  assert.equal(second.outcome.changed, false);
  assert.equal(second.outcome.snapshot.contentHash, first.outcome.snapshot.contentHash);
  assert.notEqual(second.outcome.snapshot.hash, first.outcome.snapshot.hash);
  assert.equal((await secondStore.getSource(source.id)).latestLiveSnapshot.hash, second.outcome.snapshot.hash);
});

test('transcript sync: post-query uses the same durable attempt and publication primitive', async (t) => {
  const capture = completeCapture({ thread: 'post-query-thread' });
  const { stateDir, blobs, service } = await realParts(t, 'post-query', async () => capture);
  const source = await service.track(trackInput({ thread: 'post-query-thread', key: 'post-query-key' }));

  const result = await service.sync(source.id, 'post-query');
  assert.equal(result.status, 'complete');
  assert.equal(result.attempt.trigger, 'post-query');
  assert.equal(result.source.lastAttempt.trigger, 'post-query');
  assert.deepEqual(await blobs.getSnapshot(result.outcome.snapshot), await blobs.getSnapshot(result.source.latestLiveSnapshot));

  const reloaded = createTranscriptStore({ stateDir, blobs });
  const persisted = await reloaded.getSource(source.id);
  assert.equal(persisted.lastAttempt.trigger, 'post-query');
  assert.equal(persisted.latestLiveSnapshot.hash, result.outcome.snapshot.hash);
});

test('transcript sync: forget is local metadata work and never calls the provider port', async (t) => {
  let captureCalls = 0;
  const { service } = await realParts(t, 'forget', async () => {
    captureCalls += 1;
    return completeCapture();
  });
  const source = await service.track(trackInput());

  const forgotten = await service.forget(source.id);

  assert.equal(forgotten.recoverable, true);
  assert.equal(captureCalls, 0);
  assert.deepEqual(await service.list(), []);
});
