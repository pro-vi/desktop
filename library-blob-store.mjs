import crypto from 'node:crypto';
import path from 'node:path';

import {
  LIBRARY_LOCAL_ID_PATTERN,
  parseConversationIdentity,
  providerConversationIdFromOwnedLocation
} from './conversation-identity.mjs';
import { locationFromConversationUrl, parseChatGptEntryTarget } from './chatgpt-location.mjs';
import { privateFileSystem } from './private-filesystem.mjs';
import {
  TRANSCRIPT_NORMALIZATION_VERSION,
  parseNormalizedTranscript,
  parseTranscriptProviderMessageId
} from './transcript-contract.mjs';

export const LIBRARY_BLOB_SCHEMA_VERSION = 1;
export const DEFAULT_LIBRARY_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'identity',
  'snapshotHash',
  'contentHash',
  'normalizationVersion',
  'origin',
  'capturedAt',
  'turns',
  'characterCount'
]);
const LIVE_ORIGIN_KEYS = Object.freeze(['kind', 'conversationUrl', 'captureEvidence']);
const ARCHIVE_ORIGIN_KEYS = Object.freeze(['kind', 'importId', 'rawRecord', 'branchEvidence']);
const CAPTURE_EVIDENCE_KEYS = Object.freeze([
  'topBoundary',
  'bottomBoundary',
  'orderedWindowStitching',
  'scrollPasses',
  'windowCount',
  'messageCount',
  'providerIdCount',
  'byteCount'
]);
const BRANCH_EVIDENCE_KEYS = Object.freeze(['kind', 'activeNodeId', 'messageIds']);
const RAW_REF_KEYS = Object.freeze(['kind', 'algorithm', 'hash', 'byteLength']);
const SNAPSHOT_REF_KEYS = Object.freeze(['kind', 'algorithm', 'hash', 'contentHash', 'byteLength']);

function blobError(code) {
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

function assertExactKeys(value, keys, code = 'library_blob_invalid_snapshot') {
  if (!exactKeys(value, keys)) throw blobError(code);
}

function parseSha256(value, code = 'library_blob_invalid_ref') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw blobError(code);
  return value;
}

function parsePositiveSize(value, code = 'library_blob_invalid_ref') {
  if (!Number.isSafeInteger(value) || value < 1) throw blobError(code);
  return value;
}

function parseIsoDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw blobError('library_blob_invalid_snapshot');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw blobError('library_blob_invalid_snapshot');
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw blobError('library_blob_non_json_value');
}

function defaultHashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function checkedHash(hashBytes, bytes) {
  const hash = hashBytes(bytes);
  return parseSha256(hash, 'library_blob_hash_failure');
}

function parseCanonicalConversationUrl(value) {
  let target = null;
  try {
    target = parseChatGptEntryTarget(value);
  } catch {}
  if (!target || target.kind !== 'canonical-conversation') throw blobError('library_blob_invalid_snapshot');
  return target.chatUrl;
}

function parseCaptureEvidence(value) {
  assertExactKeys(value, CAPTURE_EVIDENCE_KEYS);
  for (const field of ['topBoundary', 'bottomBoundary', 'orderedWindowStitching']) {
    if (typeof value[field] !== 'boolean') throw blobError('library_blob_invalid_snapshot');
  }
  for (const field of ['scrollPasses', 'windowCount', 'messageCount', 'providerIdCount', 'byteCount']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw blobError('library_blob_invalid_snapshot');
  }
  if (value.windowCount < 1 || value.providerIdCount > value.messageCount) {
    throw blobError('library_blob_invalid_snapshot');
  }
  return Object.freeze({ ...value });
}

function parseSafeId(value, code = 'library_blob_invalid_snapshot') {
  if (typeof value !== 'string' || !LIBRARY_LOCAL_ID_PATTERN.test(value)) {
    throw blobError(code);
  }
  return value;
}

function parseBranchEvidence(value) {
  assertExactKeys(value, BRANCH_EVIDENCE_KEYS);
  if (value.kind !== 'active-node-chain') throw blobError('library_blob_invalid_snapshot');
  let activeNodeId;
  try {
    activeNodeId = parseTranscriptProviderMessageId(value.activeNodeId, 'branchEvidence.activeNodeId');
  } catch {
    throw blobError('library_blob_invalid_snapshot');
  }
  if (!Array.isArray(value.messageIds) || value.messageIds.length < 1 || value.messageIds.length > 100_000) {
    throw blobError('library_blob_invalid_snapshot');
  }
  let messageIds;
  try {
    messageIds = Array.from(value.messageIds, (id, index) =>
      parseTranscriptProviderMessageId(id, `branchEvidence.messageIds.${index}`));
  } catch {
    throw blobError('library_blob_invalid_snapshot');
  }
  if (new Set(messageIds).size !== messageIds.length || messageIds.at(-1) !== activeNodeId) {
    throw blobError('library_blob_invalid_snapshot');
  }
  return Object.freeze({ kind: 'active-node-chain', activeNodeId, messageIds: Object.freeze(messageIds) });
}

export function parseRawRecordRef(value) {
  assertExactKeys(value, RAW_REF_KEYS, 'library_blob_invalid_ref');
  if (value.kind !== 'raw' || value.algorithm !== 'sha256') throw blobError('library_blob_invalid_ref');
  return Object.freeze({
    kind: 'raw',
    algorithm: 'sha256',
    hash: parseSha256(value.hash),
    byteLength: parsePositiveSize(value.byteLength)
  });
}

export function parseSnapshotRef(value) {
  assertExactKeys(value, SNAPSHOT_REF_KEYS, 'library_blob_invalid_ref');
  if (value.kind !== 'snapshot' || value.algorithm !== 'sha256') throw blobError('library_blob_invalid_ref');
  return Object.freeze({
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: parseSha256(value.hash),
    contentHash: parseSha256(value.contentHash),
    byteLength: parsePositiveSize(value.byteLength)
  });
}

function parseOrigin(value) {
  if (!isRecord(value)) throw blobError('library_blob_invalid_snapshot');
  if (value.kind === 'live-capture') {
    assertExactKeys(value, LIVE_ORIGIN_KEYS);
    return Object.freeze({
      kind: 'live-capture',
      conversationUrl: parseCanonicalConversationUrl(value.conversationUrl),
      captureEvidence: parseCaptureEvidence(value.captureEvidence)
    });
  }
  if (value.kind === 'chatgpt-export') {
    assertExactKeys(value, ARCHIVE_ORIGIN_KEYS);
    return Object.freeze({
      kind: 'chatgpt-export',
      importId: parseSafeId(value.importId),
      rawRecord: parseRawRecordRef(value.rawRecord),
      branchEvidence: parseBranchEvidence(value.branchEvidence)
    });
  }
  throw blobError('library_blob_invalid_snapshot');
}

function snapshotPayload(value) {
  return {
    schemaVersion: LIBRARY_BLOB_SCHEMA_VERSION,
    identity: value.identity,
    contentHash: value.contentHash,
    normalizationVersion: value.normalizationVersion,
    origin: value.origin,
    capturedAt: value.capturedAt,
    turns: value.turns,
    characterCount: value.characterCount
  };
}

export function parseTranscriptSnapshot(value, { hashBytes = defaultHashBytes } = {}) {
  if (!isRecord(value)) throw blobError('library_blob_invalid_snapshot');
  if (value.schemaVersion !== LIBRARY_BLOB_SCHEMA_VERSION) throw blobError('library_blob_schema_unsupported');
  assertExactKeys(value, SNAPSHOT_KEYS);
  if (value.normalizationVersion !== TRANSCRIPT_NORMALIZATION_VERSION) {
    throw blobError('library_blob_schema_unsupported');
  }
  const identity = parseConversationIdentity(value.identity);
  const normalized = parseNormalizedTranscript({
    normalizationVersion: value.normalizationVersion,
    turns: value.turns,
    characterCount: value.characterCount,
    contentHash: value.contentHash
  });
  if (normalized.normalizationVersion !== TRANSCRIPT_NORMALIZATION_VERSION) {
    throw blobError('library_blob_schema_unsupported');
  }
  const origin = parseOrigin(value.origin);
  if (origin.kind === 'live-capture') {
    const providerConversationId = providerConversationIdFromOwnedLocation(
      locationFromConversationUrl(origin.conversationUrl)
    );
    const providerIdCount = normalized.turns.filter(({ identity }) => identity.kind === 'provider').length;
    if (
      providerConversationId !== identity.providerConversationId ||
      !origin.captureEvidence.topBoundary ||
      !origin.captureEvidence.bottomBoundary ||
      !origin.captureEvidence.orderedWindowStitching ||
      origin.captureEvidence.messageCount !== normalized.turns.length ||
      origin.captureEvidence.providerIdCount !== providerIdCount
    ) {
      throw blobError('library_blob_invalid_snapshot');
    }
  } else {
    if (origin.branchEvidence.messageIds.length !== normalized.turns.length) {
      throw blobError('library_blob_invalid_snapshot');
    }
    for (let index = 0; index < normalized.turns.length; index += 1) {
      const turnIdentity = normalized.turns[index].identity;
      if (turnIdentity.kind === 'provider' && turnIdentity.providerMessageId !== origin.branchEvidence.messageIds[index]) {
        throw blobError('library_blob_invalid_snapshot');
      }
    }
  }
  const parsed = {
    schemaVersion: LIBRARY_BLOB_SCHEMA_VERSION,
    identity,
    contentHash: normalized.contentHash,
    normalizationVersion: normalized.normalizationVersion,
    origin,
    capturedAt: parseIsoDateTime(value.capturedAt),
    turns: normalized.turns,
    characterCount: normalized.characterCount
  };
  const snapshotHash = checkedHash(hashBytes, Buffer.from(canonicalJson(snapshotPayload(parsed))));
  if (value.snapshotHash !== snapshotHash) throw blobError('library_blob_snapshot_hash_mismatch');
  return Object.freeze({ ...parsed, snapshotHash });
}

export function makeTranscriptSnapshot({ identity, normalizedTranscript, origin, capturedAt }, {
  hashBytes = defaultHashBytes
} = {}) {
  const parsedIdentity = parseConversationIdentity(identity);
  const normalized = parseNormalizedTranscript(normalizedTranscript);
  const parsed = {
    schemaVersion: LIBRARY_BLOB_SCHEMA_VERSION,
    identity: parsedIdentity,
    contentHash: normalized.contentHash,
    normalizationVersion: normalized.normalizationVersion,
    origin: parseOrigin(origin),
    capturedAt: parseIsoDateTime(capturedAt),
    turns: normalized.turns,
    characterCount: normalized.characterCount
  };
  const snapshotHash = checkedHash(hashBytes, Buffer.from(canonicalJson(snapshotPayload(parsed))));
  return parseTranscriptSnapshot({ ...parsed, snapshotHash }, { hashBytes });
}

export function transcriptSnapshotByteLength(value) {
  return Buffer.byteLength(canonicalJson(parseTranscriptSnapshot(value)));
}

function bytesFromRawRecord(value, maxBytes) {
  const bytes = typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : null;
  if (!bytes || bytes.length < 1) throw blobError('library_blob_invalid_raw_record');
  if (bytes.length > maxBytes) throw blobError('library_blob_size_limit');
  return bytes;
}

export function createPrivateLibraryBlobStore({
  stateDir,
  fileSystem = privateFileSystem,
  hashBytes = defaultHashBytes,
  maxRawBytes = 64 * 1024 * 1024,
  maxSnapshotBytes = DEFAULT_LIBRARY_MAX_SNAPSHOT_BYTES
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw blobError('library_blob_state_dir_required');
  const root = path.join(stateDir, 'transcript-library', 'blobs');
  const queues = new Map();

  function filePathFor(kind, hash) {
    const extension = kind === 'raw' ? '.blob' : '.json';
    return path.join(root, kind, 'sha256', hash.slice(0, 2), `${hash}${extension}`);
  }

  async function ensureLayout() {
    try {
      await fileSystem.ensurePrivateDirectory(path.join(root, 'raw', 'sha256'), { boundaryPath: stateDir });
      await fileSystem.ensurePrivateDirectory(path.join(root, 'snapshot', 'sha256'), { boundaryPath: stateDir });
    } catch (error) {
      throw mapIoError(error);
    }
  }

  function enqueue(key, operation) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const settled = next.finally(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    queues.set(key, settled);
    return settled;
  }

  function mapIoError(error) {
    if (typeof error?.code === 'string' && error.code.startsWith('library_blob_')) return error;
    if (error?.code === 'ENOENT') return blobError('library_blob_not_found');
    if (typeof error?.code === 'string' && error.code.startsWith('private_')) {
      return blobError('library_blob_corrupt');
    }
    return blobError('library_blob_io');
  }

  async function readRawAt(filePath, ref) {
    let bytes;
    try {
      bytes = await fileSystem.readPrivateFile(filePath, { maxBytes: maxRawBytes, boundaryPath: stateDir });
    } catch (error) {
      throw mapIoError(error);
    }
    if (bytes.length !== ref.byteLength || checkedHash(hashBytes, bytes) !== ref.hash) {
      throw blobError('library_blob_corrupt');
    }
    return bytes;
  }

  async function readSnapshotAt(filePath, ref) {
    let bytes;
    try {
      bytes = await fileSystem.readPrivateFile(filePath, { maxBytes: maxSnapshotBytes, boundaryPath: stateDir });
    } catch (error) {
      throw mapIoError(error);
    }
    if (bytes.length !== ref.byteLength) throw blobError('library_blob_corrupt');
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw blobError('library_blob_corrupt');
    }
    let snapshot;
    try {
      snapshot = parseTranscriptSnapshot(raw, { hashBytes });
    } catch (error) {
      if (error?.code === 'library_blob_schema_unsupported') throw error;
      throw blobError('library_blob_corrupt');
    }
    if (snapshot.snapshotHash !== ref.hash || snapshot.contentHash !== ref.contentHash) {
      throw blobError('library_blob_corrupt');
    }
    const canonicalBytes = Buffer.from(canonicalJson(snapshot));
    if (!canonicalBytes.equals(bytes)) throw blobError('library_blob_corrupt');
    return snapshot;
  }

  async function publish(kind, ref, bytes, verifyExisting) {
    await ensureLayout();
    const filePath = filePathFor(kind, ref.hash);
    return await enqueue(filePath, async () => {
      try {
        const kindAtPath = await fileSystem.pathKind(filePath, { boundaryPath: stateDir });
        if (kindAtPath !== 'missing') {
          if (kindAtPath !== 'file') throw blobError('library_blob_corrupt');
          await fileSystem.settleImmutable(filePath, { boundaryPath: stateDir });
          const existing = await fileSystem.readPrivateFile(filePath, {
            maxBytes: kind === 'raw' ? maxRawBytes : maxSnapshotBytes,
            boundaryPath: stateDir
          });
          await verifyExisting(existing);
          if (!existing.equals(bytes)) throw blobError('library_blob_hash_collision');
          return ref;
        }
        const result = await fileSystem.publishImmutable(filePath, bytes, { boundaryPath: stateDir });
        if (!result.published) {
          await fileSystem.settleImmutable(filePath, { boundaryPath: stateDir });
          const existing = await fileSystem.readPrivateFile(filePath, {
            maxBytes: kind === 'raw' ? maxRawBytes : maxSnapshotBytes,
            boundaryPath: stateDir
          });
          await verifyExisting(existing);
          if (!existing.equals(bytes)) throw blobError('library_blob_hash_collision');
        }
        return ref;
      } catch (error) {
        throw mapIoError(error);
      }
    });
  }

  async function putRaw(value) {
    const bytes = bytesFromRawRecord(value, maxRawBytes);
    const hash = checkedHash(hashBytes, bytes);
    const ref = Object.freeze({ kind: 'raw', algorithm: 'sha256', hash, byteLength: bytes.length });
    return await publish('raw', ref, bytes, async (existing) => {
      if (existing.length < 1 || checkedHash(hashBytes, existing) !== hash) throw blobError('library_blob_corrupt');
    });
  }

  async function putSnapshot(value) {
    let snapshot;
    try {
      snapshot = parseTranscriptSnapshot(value, { hashBytes });
    } catch (error) {
      if (error?.code === 'library_blob_schema_unsupported') throw error;
      throw blobError('library_blob_invalid_snapshot');
    }
    const bytes = Buffer.from(canonicalJson(snapshot));
    if (bytes.length > maxSnapshotBytes) throw blobError('library_blob_size_limit');
    const ref = Object.freeze({
      kind: 'snapshot',
      algorithm: 'sha256',
      hash: snapshot.snapshotHash,
      contentHash: snapshot.contentHash,
      byteLength: bytes.length
    });
    return await publish('snapshot', ref, bytes, async (existing) => {
      let parsed;
      try {
        parsed = parseTranscriptSnapshot(JSON.parse(existing.toString('utf8')), { hashBytes });
      } catch (error) {
        if (error?.code === 'library_blob_schema_unsupported') throw error;
        throw blobError('library_blob_corrupt');
      }
      if (parsed.snapshotHash !== ref.hash || !Buffer.from(canonicalJson(parsed)).equals(existing)) {
        throw blobError('library_blob_corrupt');
      }
    });
  }

  return Object.freeze({
    putRaw,
    putSnapshot,
    createSnapshot: (input) => makeTranscriptSnapshot(input, { hashBytes }),
    async getRaw(value) {
      const ref = parseRawRecordRef(value);
      await ensureLayout();
      return await readRawAt(filePathFor('raw', ref.hash), ref);
    },
    async getSnapshot(value) {
      const ref = parseSnapshotRef(value);
      await ensureLayout();
      return await readSnapshotAt(filePathFor('snapshot', ref.hash), ref);
    },
    pathFor(value) {
      const ref = value?.kind === 'raw' ? parseRawRecordRef(value) : parseSnapshotRef(value);
      return filePathFor(ref.kind === 'raw' ? 'raw' : 'snapshot', ref.hash);
    },
    root
  });
}
