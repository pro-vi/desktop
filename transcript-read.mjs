import {
  LIBRARY_LOCAL_ID_PATTERN,
  formatConversationIdentity,
  identityFromOwnedLocation,
  parseConversationIdentity,
  sameConversationIdentity
} from './conversation-identity.mjs';
import { conversationUrlForLocation } from './chatgpt-location.mjs';
import { parseSnapshotRef } from './library-blob-store.mjs';
import { renderTranscript, TRANSCRIPT_PAGE_MAX_TEXT_CHARS } from './transcript-contract.mjs';
import { parseTranscriptSourceKey } from './transcript-source-contract.mjs';

export { TRANSCRIPT_PAGE_MAX_TEXT_CHARS };

export const TRANSCRIPT_READ_SCHEMA_VERSION = 1;
export const TRANSCRIPT_PAGE_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_PAGE_MAX_LIMIT = 100;

const REQUEST_KEYS = new Set(['identity', 'snapshot', 'cursor', 'limit', 'includePaths']);
const CURSOR_KEYS = Object.freeze(['schemaVersion', 'snapshotHash', 'afterTurnId']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function readError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRequest(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !REQUEST_KEYS.has(key)) || !('identity' in value)) {
    throw readError('transcript_request_invalid');
  }
  let identity;
  let snapshot = null;
  try {
    identity = parseConversationIdentity(value.identity);
    snapshot = value.snapshot === undefined ? null : parseSnapshotRef(value.snapshot);
  } catch {
    throw readError('transcript_request_invalid');
  }
  const limit = value.limit === undefined ? TRANSCRIPT_PAGE_DEFAULT_LIMIT : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRANSCRIPT_PAGE_MAX_LIMIT) {
    throw readError('transcript_page_limit');
  }
  if (value.includePaths !== undefined && typeof value.includePaths !== 'boolean') {
    throw readError('transcript_request_invalid');
  }
  return {
    identity,
    snapshot,
    cursor: value.cursor === undefined ? null : parseCursor(value.cursor),
    limit,
    includePaths: value.includePaths === true
  };
}

function parseCursor(value) {
  if (
    !exactKeys(value, CURSOR_KEYS) ||
    value.schemaVersion !== TRANSCRIPT_READ_SCHEMA_VERSION ||
    typeof value.snapshotHash !== 'string' ||
    !SHA256_PATTERN.test(value.snapshotHash) ||
    typeof value.afterTurnId !== 'string' ||
    value.afterTurnId.length < 1 ||
    value.afterTurnId.length > 600 ||
    /[\u0000-\u001f\u007f]/.test(value.afterTurnId)
  ) {
    throw readError('transcript_request_invalid');
  }
  return Object.freeze({
    schemaVersion: TRANSCRIPT_READ_SCHEMA_VERSION,
    snapshotHash: value.snapshotHash,
    afterTurnId: value.afterTurnId
  });
}

function parseIndexRef(value) {
  if (value === null) return null;
  try {
    return parseSnapshotRef(value);
  } catch {
    throw readError('transcript_import_index_invalid');
  }
}

function uniqueRefs(values) {
  const byHash = new Map();
  for (const value of values) {
    if (!value) continue;
    const existing = byHash.get(value.hash);
    if (
      existing &&
      (
        existing.kind !== value.kind ||
        existing.algorithm !== value.algorithm ||
        existing.contentHash !== value.contentHash ||
        existing.byteLength !== value.byteLength
      )
    ) {
      throw readError('transcript_import_index_invalid');
    }
    if (!existing) byHash.set(value.hash, value);
  }
  return [...byHash.values()];
}

function cursorStart(snapshot, cursor) {
  if (cursor === null) return 0;
  if (cursor.snapshotHash !== snapshot.snapshotHash) throw readError('transcript_cursor_mismatch');
  const index = snapshot.turns.findIndex(({ turnId }) => turnId === cursor.afterTurnId);
  if (index < 0 || index >= snapshot.turns.length - 1) throw readError('transcript_cursor_mismatch');
  return index + 1;
}

function transcriptPage(snapshot, start, limit, maxTextChars) {
  const limitEnd = Math.min(snapshot.turns.length, start + limit);
  let end = start;
  let textLength = 0;
  while (end < limitEnd) {
    const turnText = renderTranscript(snapshot, { startOrdinal: end, endOrdinal: end + 1 });
    const nextLength = textLength + (end === start ? 0 : 2) + turnText.length;
    if (nextLength > maxTextChars) break;
    textLength = nextLength;
    end += 1;
  }
  if (start < snapshot.turns.length && end === start) {
    throw readError('transcript_page_character_limit');
  }
  return {
    endOrdinal: end,
    text: renderTranscript(snapshot, { startOrdinal: start, endOrdinal: end })
  };
}

function liveBinding(source, identity) {
  if (source === null) return null;
  try {
    if (!sameConversationIdentity(source.identity, identity) || typeof source.enabled !== 'boolean') {
      throw readError('transcript_source_invalid');
    }
    const sourceKey = parseTranscriptSourceKey(source.key);
    const conversationUrl = conversationUrlForLocation(source.target?.location);
    if (
      typeof source.id !== 'string' ||
      !LIBRARY_LOCAL_ID_PATTERN.test(source.id) ||
      !conversationUrl ||
      !sameConversationIdentity(identityFromOwnedLocation(identity.profileScopeId, source.target.location), identity)
    ) {
      throw readError('transcript_source_invalid');
    }
    if (source.enabled === false) return null;
    return { source, sourceKey, conversationUrl };
  } catch (error) {
    if (error?.code === 'transcript_source_invalid') throw error;
    throw readError('transcript_source_invalid');
  }
}

export function createEmptyImportedConversationIndex() {
  return Object.freeze({
    latestImportedSnapshot: async () => null,
    hasIdentity: async () => false
  });
}

export function createTranscriptReadService({
  sources,
  imported = createEmptyImportedConversationIndex(),
  blobs,
  maxPageTextChars = TRANSCRIPT_PAGE_MAX_TEXT_CHARS
} = {}) {
  if (!sources || typeof sources.findSource !== 'function') throw readError('transcript_sources_required');
  if (!imported || typeof imported.latestImportedSnapshot !== 'function') {
    throw readError('transcript_import_index_required');
  }
  if (typeof imported.hasIdentity !== 'function') throw readError('transcript_import_index_required');
  if (!blobs || typeof blobs.getSnapshot !== 'function' || typeof blobs.pathFor !== 'function') {
    throw readError('transcript_blobs_required');
  }
  if (!Number.isSafeInteger(maxPageTextChars) || maxPageTextChars < 1 || maxPageTextChars > TRANSCRIPT_PAGE_MAX_TEXT_CHARS) {
    throw readError('transcript_page_character_limit_invalid');
  }

  async function get(requestValue) {
    const request = parseRequest(requestValue);
    const [source, importedRefValue, importedKnownValue] = await Promise.all([
      sources.findSource(request.identity),
      request.snapshot === null ? imported.latestImportedSnapshot(request.identity) : Promise.resolve(null),
      request.snapshot === null ? imported.hasIdentity(request.identity) : Promise.resolve(false)
    ]);
    const importedRef = parseIndexRef(importedRefValue);
    if (typeof importedKnownValue !== 'boolean') throw readError('transcript_import_index_invalid');

    let selectedRef = request.snapshot;
    let selectedSnapshot = null;
    if (selectedRef === null) {
      const candidates = uniqueRefs([source?.latestLiveSnapshot || null, importedRef]);
      if (!candidates.length) {
        if (!source && !importedKnownValue) throw readError('transcript_identity_not_found');
        throw readError('transcript_no_complete_snapshot');
      }
      const loaded = await Promise.all(candidates.map(async (ref) => ({ ref, snapshot: await blobs.getSnapshot(ref) })));
      for (const candidate of loaded) {
        if (!sameConversationIdentity(candidate.snapshot.identity, request.identity)) {
          throw readError('transcript_snapshot_identity_mismatch');
        }
      }
      loaded.sort((left, right) =>
        right.snapshot.capturedAt.localeCompare(left.snapshot.capturedAt) ||
        left.snapshot.snapshotHash.localeCompare(right.snapshot.snapshotHash));
      ({ ref: selectedRef, snapshot: selectedSnapshot } = loaded[0]);
    } else {
      try {
        selectedSnapshot = await blobs.getSnapshot(selectedRef);
      } catch (error) {
        if (error?.code === 'library_blob_not_found') throw readError('transcript_snapshot_not_found');
        throw error;
      }
      if (!sameConversationIdentity(selectedSnapshot.identity, request.identity)) {
        throw readError('transcript_snapshot_identity_mismatch');
      }
    }

    const startOrdinal = cursorStart(selectedSnapshot, request.cursor);
    const page = transcriptPage(selectedSnapshot, startOrdinal, request.limit, maxPageTextChars);
    const endOrdinal = page.endOrdinal;
    const structuredTurns = selectedSnapshot.turns.slice(startOrdinal, endOrdinal);
    const identityKey = formatConversationIdentity(request.identity);
    const citations = structuredTurns.map(({ turnId }) => ({
      identity: identityKey,
      snapshotHash: selectedSnapshot.snapshotHash,
      turnId
    }));
    const nextCursor = endOrdinal < selectedSnapshot.turns.length
      ? {
          schemaVersion: TRANSCRIPT_READ_SCHEMA_VERSION,
          snapshotHash: selectedSnapshot.snapshotHash,
          afterTurnId: structuredTurns.at(-1).turnId
        }
      : null;
    const binding = liveBinding(source, request.identity);
    const liveSource = binding?.source || null;
    const conversationUrl = binding?.conversationUrl || null;

    return {
      schemaVersion: TRANSCRIPT_READ_SCHEMA_VERSION,
      identity: request.identity,
      snapshot: selectedRef,
      normalizationVersion: selectedSnapshot.normalizationVersion,
      capturedAt: selectedSnapshot.capturedAt,
      startOrdinal,
      endOrdinal,
      totalTurns: selectedSnapshot.turns.length,
      text: page.text,
      structuredTurns,
      citations,
      nextCursor,
      liveSourceId: liveSource?.id || null,
      sourceKey: binding?.sourceKey || null,
      conversationUrl,
      ...(request.includePaths ? { paths: { snapshot: blobs.pathFor(selectedRef) } } : {})
    };
  }

  return Object.freeze({ get });
}
