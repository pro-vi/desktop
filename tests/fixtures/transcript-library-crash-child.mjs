import fs from 'node:fs/promises';
import path from 'node:path';

import { createChatGptExportReader } from '../../chatgpt-export-reader.mjs';
import { locationFromConversationUrl } from '../../chatgpt-location.mjs';
import { INITIAL_PREPARED_IMPORT_BATCH_RECORDS } from '../../conversation-catalog-contract.mjs';
import { createConversationCatalogStore } from '../../conversation-catalog-store.mjs';
import { createConversationCatalogService } from '../../conversation-catalog-sync.mjs';
import { identityFromOwnedLocation } from '../../conversation-identity.mjs';
import { createElectronExportImportGrants } from '../../export-import-grants.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../../library-blob-store.mjs';
import {
  normalizeLiveCapture
} from '../../transcript-contract.mjs';
import { createTranscriptStore } from '../../transcript-store.mjs';
import { buildZip } from './zip-archive.mjs';

const [stateDir, mode] = process.argv.slice(2);
if (
  typeof stateDir !== 'string' || !path.isAbsolute(stateDir) ||
  !['crash', 'resume'].includes(mode) || typeof process.send !== 'function'
) {
  process.exit(64);
}

const PROFILE_SCOPE_ID = 'e2e-local';
const LIVE_CONVERSATION_ID = 'local-live-fixture';
const IMPORTED_CONVERSATION_ID = 'local-import-fixture';
const TRANSCRIPT_SENTINEL = 'E2E_PRIVATE_TRANSCRIPT_SENTINEL_DO_NOT_LOG';
const RAW_ARCHIVE_SENTINEL = 'E2E_PRIVATE_ARCHIVE_RECORD_SENTINEL_DO_NOT_LOG';
const ARCHIVE_BASENAME = 'PRIVATE-ARCHIVE-PATH.zip';
const OBSERVED_AT_SECONDS = Date.parse('2026-07-30T12:03:00.000Z') / 1000;
const CREATED_AT_SECONDS = Date.parse('2026-07-30T12:00:00.000Z') / 1000;

function clockAt(second = 0) {
  let tick = second;
  return () => new Date(Date.UTC(2026, 6, 30, 12, 0, tick++)).toISOString();
}

function ids(prefix) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function rawTurns(prefix, count = 3) {
  return Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    providerMessageId: `${prefix}-message-${ordinal + 1}`,
    role: ordinal % 2 === 0 ? 'user' : 'assistant',
    text: ordinal === 1
      ? `${prefix}-fixture-turn-${ordinal + 1} ${TRANSCRIPT_SENTINEL}`
      : `${prefix}-fixture-turn-${ordinal + 1}`
  }));
}

function evidence(turns) {
  return {
    topBoundary: true,
    bottomBoundary: true,
    orderedWindowStitching: true,
    scrollPasses: 2,
    windowCount: 2,
    messageCount: turns.length,
    providerIdCount: turns.length,
    byteCount: turns.reduce((total, turn) =>
      total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) +
        Buffer.byteLength(turn.providerMessageId), 0)
  };
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

function archiveConversation(index) {
  const conversationId = index === 0
    ? IMPORTED_CONVERSATION_ID
    : `${IMPORTED_CONVERSATION_ID}-extra-${String(index).padStart(3, '0')}`;
  const rootId = `${conversationId}-root`;
  const userId = `${conversationId}-user`;
  const assistantId = `${conversationId}-assistant`;
  return {
    id: conversationId,
    conversation_id: conversationId,
    title: `Local import fixture ${index + 1}`,
    create_time: CREATED_AT_SECONDS,
    update_time: OBSERVED_AT_SECONDS,
    current_node: assistantId,
    mapping: {
      [rootId]: { id: rootId, message: null, parent: null, children: [userId] },
      [userId]: {
        id: userId,
        message: message(userId, 'user', 'A harmless import fixture prompt'),
        parent: rootId,
        children: [assistantId]
      },
      [assistantId]: {
        id: assistantId,
        message: message(assistantId, 'assistant', `A harmless import fixture reply ${TRANSCRIPT_SENTINEL}`),
        parent: userId,
        children: []
      }
    },
    private_fixture_marker: RAW_ARCHIVE_SENTINEL,
    is_archived: false
  };
}

async function ensureFixtureArchive() {
  const fixtureDir = path.join(stateDir, 'e2e-fixture');
  const archivePath = path.join(fixtureDir, ARCHIVE_BASENAME);
  if (mode === 'crash') {
    await fs.mkdir(fixtureDir, { recursive: true, mode: 0o700 });
    await fs.chmod(fixtureDir, 0o700);
    const bytes = buildZip([{
      name: 'conversations.json',
      data: Buffer.from(JSON.stringify(Array.from(
        { length: INITIAL_PREPARED_IMPORT_BATCH_RECORDS },
        (_, index) => archiveConversation(index)
      ))),
      method: 'deflate'
    }]);
    await fs.writeFile(archivePath, bytes, { mode: 0o600, flag: 'wx' });
  }
  const stat = await fs.lstat(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('e2e_fixture_archive_invalid');
  return archivePath;
}

async function seedLiveRecovery(blobs) {
  const liveStore = createTranscriptStore({
    stateDir,
    blobs,
    clock: clockAt(),
    randomId: ids('live')
  });
  const liveUrl = `https://chatgpt.com/c/${LIVE_CONVERSATION_ID}`;
  const liveLocation = locationFromConversationUrl(liveUrl);
  const liveIdentity = identityFromOwnedLocation(PROFILE_SCOPE_ID, liveLocation);
  const source = await liveStore.register({
    identity: liveIdentity,
    label: 'Local recovery fixture',
    tags: ['e2e'],
    key: 'e2e-local-source',
    target: { kind: 'owned-conversation', location: liveLocation }
  });

  const firstTurns = rawTurns('live-stable', 3);
  const firstCapture = {
    status: 'complete',
    conversationUrl: liveUrl,
    capturedAt: '2026-07-30T12:01:00.000Z',
    rawTurns: firstTurns,
    evidence: evidence(firstTurns)
  };
  const firstSnapshot = makeTranscriptSnapshot({
    identity: liveIdentity,
    normalizedTranscript: normalizeLiveCapture(firstCapture),
    origin: {
      kind: 'live-capture',
      conversationUrl: liveUrl,
      captureEvidence: firstCapture.evidence
    },
    capturedAt: firstCapture.capturedAt
  });
  const firstRef = await blobs.putSnapshot(firstSnapshot);
  const completedAttempt = await liveStore.beginAttempt(source.id);
  await liveStore.commitComplete(completedAttempt.id, firstRef, firstSnapshot.contentHash);

  await liveStore.beginAttempt(source.id);
  const orphanTurns = rawTurns('live-orphan', 4);
  const orphanCapture = {
    status: 'complete',
    conversationUrl: liveUrl,
    capturedAt: '2026-07-30T12:02:00.000Z',
    rawTurns: orphanTurns,
    evidence: evidence(orphanTurns)
  };
  await blobs.putSnapshot(makeTranscriptSnapshot({
    identity: liveIdentity,
    normalizedTranscript: normalizeLiveCapture(orphanCapture),
    origin: {
      kind: 'live-capture',
      conversationUrl: liveUrl,
      captureEvidence: orphanCapture.evidence
    },
    capturedAt: orphanCapture.capturedAt
  }));
}

function deterministicDialog(archivePath) {
  return Object.freeze({
    async showOpenDialog() {
      return { canceled: false, filePaths: [archivePath] };
    }
  });
}

async function requestGrant(grants) {
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });
  if (result.status !== 'granted') throw new Error('e2e_fixture_grant_failed');
  return result.grant.grantId;
}

function noRouteVerification() {
  return Object.freeze({
    async verify() {
      throw new Error('e2e_fixture_route_not_used');
    }
  });
}

async function catalogComposition({ archivePath, blobs, pauseAfterStagedBatch }) {
  const store = createConversationCatalogStore({
    stateDir,
    blobs,
    clock: clockAt(20),
    randomId: ids('catalog')
  });
  let stagedSnapshots = 0;
  const serviceBlobs = pauseAfterStagedBatch
    ? {
        ...blobs,
        async putSnapshot(snapshot) {
          const ref = await blobs.putSnapshot(snapshot);
          stagedSnapshots += 1;
          if (stagedSnapshots === INITIAL_PREPARED_IMPORT_BATCH_RECORDS) {
            process.send({
              event: 'post-blob-pre-catalog-commit',
              stagedRecords: stagedSnapshots,
              nextRecordIndex: INITIAL_PREPARED_IMPORT_BATCH_RECORDS
            });
            await new Promise((resolve) => process.once('message', resolve));
            throw new Error('e2e_fixture_commit_seam_released');
          }
          return ref;
        }
      }
    : blobs;
  const grants = createElectronExportImportGrants({
    dialog: deterministicDialog(archivePath),
    randomId: ids('grant'),
    clock: () => Date.parse('2026-07-30T12:10:00.000Z')
  });
  const service = createConversationCatalogService({
    store,
    blobs: serviceBlobs,
    grants,
    exportReader: createChatGptExportReader({ limits: { readChunkBytes: 19 } }),
    routeVerifier: noRouteVerification(),
    clock: clockAt(40)
  });
  return { store, service, grants };
}

async function crashAtCommit(archivePath, blobs) {
  await seedLiveRecovery(blobs);
  const { service, grants } = await catalogComposition({ archivePath, blobs, pauseAfterStagedBatch: true });
  const grantId = await requestGrant(grants);
  await service.importExport({ grantId, profileScopeId: PROFILE_SCOPE_ID });
  throw new Error('e2e_fixture_commit_seam_released');
}

async function resumeAndReplay(archivePath, blobs) {
  const { store, service, grants } = await catalogComposition({ archivePath, blobs, pauseAfterStagedBatch: false });
  const firstGrantId = await requestGrant(grants);
  const resumed = await service.importExport({ grantId: firstGrantId, profileScopeId: PROFILE_SCOPE_ID });
  const afterResume = await service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 100 });
  const importsAfterResume = await service.listImports();
  const secondGrantId = await requestGrant(grants);
  const replayed = await service.importExport({ grantId: secondGrantId, profileScopeId: PROFILE_SCOPE_ID });
  const afterReplay = await service.list({ profileScopeId: PROFILE_SCOPE_ID, limit: 100 });
  const importsAfterReplay = await service.listImports();
  const matchesFixtureIdentity = ({ identity }) =>
    identity?.provider === 'chatgpt' &&
    identity?.profileScopeId === PROFILE_SCOPE_ID &&
    identity?.providerConversationId === IMPORTED_CONVERSATION_ID;
  const resumeSnapshot = afterResume.items.find(matchesFixtureIdentity)?.latestImportedSnapshot?.hash || null;
  const replaySnapshot = afterReplay.items.find(matchesFixtureIdentity)?.latestImportedSnapshot?.hash || null;
  if (
    resumed.status !== 'complete' || replayed.status !== 'complete' ||
    importsAfterResume.length !== 1 || importsAfterReplay.length !== 1 ||
    afterResume.items.length !== INITIAL_PREPARED_IMPORT_BATCH_RECORDS ||
    afterReplay.items.length !== INITIAL_PREPARED_IMPORT_BATCH_RECORDS ||
    resumeSnapshot === null || replaySnapshot !== resumeSnapshot
  ) {
    throw new Error('e2e_fixture_resume_assertion_failed');
  }
  process.send({
    event: 'resume-complete',
    firstStatus: resumed.status,
    replayStatus: replayed.status,
    importCount: importsAfterReplay.length,
    catalogCount: afterReplay.items.length,
    cursorRecordIndex: importsAfterReplay[0].cursor.recordIndex,
    stableSnapshot: replaySnapshot === resumeSnapshot
  });
  await grants.closeAll();
  await store.load();
}

async function main() {
  const archivePath = await ensureFixtureArchive();
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  if (mode === 'crash') await crashAtCommit(archivePath, blobs);
  else await resumeAndReplay(archivePath, blobs);
}

main().then(() => {
  process.exitCode = 0;
}).catch((error) => {
  process.send?.({
    event: 'fixture-failed',
    code: /^e2e_[a-z0-9_]+$/i.test(String(error?.message || ''))
      ? String(error.message).toLowerCase()
      : 'e2e_fixture_failed'
  });
  process.exitCode = 1;
});
