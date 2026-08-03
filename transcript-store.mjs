import crypto from 'node:crypto';
import path from 'node:path';

import {
  LIBRARY_LOCAL_ID_PATTERN,
  formatConversationIdentity,
  parseConversationIdentity,
  providerConversationIdFromOwnedLocation,
  sameConversationIdentity
} from './conversation-identity.mjs';
import {
  conversationUrlForLocation,
  locationFromConversationUrl,
  parseChatGptEntryTarget
} from './chatgpt-location.mjs';
import { parseSnapshotRef } from './library-blob-store.mjs';
import { privateFileSystem } from './private-filesystem.mjs';
import { TRANSCRIPT_CAPTURE_REASONS } from './transcript-contract.mjs';
import {
  parseTranscriptSourceKey,
  parseTranscriptSourceLabel,
  parseTranscriptSourceTags
} from './transcript-source-contract.mjs';

export const TRANSCRIPT_STORE_SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_REF = Object.freeze({
  kind: 'snapshot',
  algorithm: 'sha256',
  hash: 'f'.repeat(64),
  contentHash: 'f'.repeat(64),
  byteLength: Number.MAX_SAFE_INTEGER
});
export const TRANSCRIPT_SYNC_FAILURE_REASONS = Object.freeze([
  'login',
  'challenge',
  'tab_closed',
  'navigation_failed',
  'provider_transport',
  'compatibility_drift',
  'capture_failed',
  'snapshot_write_failed'
]);

const STATE_KEYS = Object.freeze(['schemaVersion', 'revision', 'sources', 'attempts', 'deletedSources']);
const SOURCE_KEYS = Object.freeze([
  'schemaVersion', 'id', 'identity', 'label', 'tags', 'key', 'target', 'enabled',
  'latestLiveSnapshot', 'lastAttemptId', 'createdAt', 'updatedAt'
]);
const ATTEMPT_KEYS = Object.freeze([
  'schemaVersion', 'id', 'sourceId', 'trigger', 'startedAt', 'finishedAt', 'outcome'
]);
const TOMBSTONE_KEYS = Object.freeze([
  'schemaVersion', 'id', 'source', 'attempts', 'forgottenAt', 'recoveryLocation'
]);

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
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

function requireExact(value, keys) {
  if (!exactKeys(value, keys)) throw storeError('transcript_store_corrupt_state');
}

function parseSafeId(value) {
  if (typeof value !== 'string' || !LIBRARY_LOCAL_ID_PATTERN.test(value)) {
    throw storeError('transcript_store_corrupt_state');
  }
  return value;
}

function parseIsoDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw storeError('transcript_store_corrupt_state');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw storeError('transcript_store_corrupt_state');
  }
  return value;
}

function parseOwnedLocation(value) {
  if (!isRecord(value) || !['standalone-conversation', 'project-conversation'].includes(value.kind)) {
    throw storeError('transcript_source_invalid');
  }
  const expectedKeys = value.kind === 'project-conversation'
    ? ['kind', 'projectUrl', 'conversationUrl', ...(value.sourceUrl === undefined ? [] : ['sourceUrl'])]
    : ['kind', 'conversationUrl', ...(value.sourceUrl === undefined ? [] : ['sourceUrl'])];
  if (!exactKeys(value, expectedKeys)) throw storeError('transcript_source_invalid');
  let canonical;
  try {
    let sourceUrl = null;
    if (value.sourceUrl !== undefined) {
      const sourceTarget = parseChatGptEntryTarget(value.sourceUrl);
      if (sourceTarget?.kind !== 'shared-snapshot') throw storeError('transcript_source_invalid');
      sourceUrl = sourceTarget.chatUrl;
    }
    canonical = locationFromConversationUrl(value.conversationUrl, { sourceUrl });
  } catch {
    throw storeError('transcript_source_invalid');
  }
  if (
    canonical.kind !== value.kind ||
    (value.kind === 'project-conversation' && canonical.projectUrl !== value.projectUrl) ||
    (value.sourceUrl !== undefined && canonical.sourceUrl !== value.sourceUrl)
  ) {
    throw storeError('transcript_source_invalid');
  }
  return canonical;
}

function parseTarget(value) {
  if (!exactKeys(value, ['kind', 'location']) || value.kind !== 'owned-conversation') {
    throw storeError('transcript_source_invalid');
  }
  return { kind: 'owned-conversation', location: parseOwnedLocation(value.location) };
}

function parseOutcome(value) {
  if (!isRecord(value) || !['complete', 'partial', 'failed', 'interrupted'].includes(value.kind)) {
    throw storeError('transcript_store_corrupt_state');
  }
  if (value.kind === 'complete') {
    requireExact(value, ['kind', 'snapshot', 'changed']);
    if (typeof value.changed !== 'boolean') throw storeError('transcript_store_corrupt_state');
    return { kind: 'complete', snapshot: parseSnapshotRef(value.snapshot), changed: value.changed };
  }
  if (value.kind === 'partial') {
    requireExact(value, ['kind', 'reason']);
    if (!TRANSCRIPT_CAPTURE_REASONS.includes(value.reason)) throw storeError('transcript_store_corrupt_state');
    return { kind: 'partial', reason: value.reason };
  }
  if (value.kind === 'failed') {
    requireExact(value, ['kind', 'reason']);
    if (!TRANSCRIPT_SYNC_FAILURE_REASONS.includes(value.reason)) throw storeError('transcript_store_corrupt_state');
    return { kind: 'failed', reason: value.reason };
  }
  requireExact(value, ['kind']);
  return { kind: 'interrupted' };
}

function parseAttempt(value) {
  requireExact(value, ATTEMPT_KEYS);
  if (value.schemaVersion !== TRANSCRIPT_STORE_SCHEMA_VERSION) throw storeError('transcript_store_schema_unsupported');
  const outcome = value.outcome === null ? null : parseOutcome(value.outcome);
  const finishedAt = value.finishedAt === null ? null : parseIsoDateTime(value.finishedAt);
  if ((outcome === null) !== (finishedAt === null)) throw storeError('transcript_store_corrupt_state');
  if (!['manual', 'post-query'].includes(value.trigger)) throw storeError('transcript_store_corrupt_state');
  return {
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    id: parseSafeId(value.id),
    sourceId: parseSafeId(value.sourceId),
    trigger: value.trigger,
    startedAt: parseIsoDateTime(value.startedAt),
    finishedAt,
    outcome
  };
}

function parseSource(value, { persisted = true } = {}) {
  if (!isRecord(value) || !exactKeys(value, SOURCE_KEYS)) {
    throw storeError(persisted ? 'transcript_store_corrupt_state' : 'transcript_source_invalid');
  }
  if (value.schemaVersion !== TRANSCRIPT_STORE_SCHEMA_VERSION) throw storeError('transcript_store_schema_unsupported');
  let identity;
  let target;
  let tags;
  try {
    identity = parseConversationIdentity(value.identity);
    target = parseTarget(value.target);
    tags = parseTranscriptSourceTags(value.tags);
  } catch (error) {
    if (persisted && error?.code !== 'transcript_store_schema_unsupported') {
      throw storeError('transcript_store_corrupt_state');
    }
    throw error;
  }
  if (providerConversationIdFromOwnedLocation(target.location) !== identity.providerConversationId) {
    throw storeError(persisted ? 'transcript_store_corrupt_state' : 'transcript_source_identity_mismatch');
  }
  if (typeof value.enabled !== 'boolean') throw storeError(persisted ? 'transcript_store_corrupt_state' : 'transcript_source_invalid');
  return {
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    id: parseSafeId(value.id),
    identity,
    label: parseTranscriptSourceLabel(value.label),
    tags,
    key: parseTranscriptSourceKey(value.key),
    target,
    enabled: value.enabled,
    latestLiveSnapshot: value.latestLiveSnapshot === null ? null : parseSnapshotRef(value.latestLiveSnapshot),
    lastAttemptId: value.lastAttemptId === null ? null : parseSafeId(value.lastAttemptId),
    createdAt: parseIsoDateTime(value.createdAt),
    updatedAt: parseIsoDateTime(value.updatedAt)
  };
}

function parseTombstone(value) {
  requireExact(value, TOMBSTONE_KEYS);
  if (value.schemaVersion !== TRANSCRIPT_STORE_SCHEMA_VERSION) throw storeError('transcript_store_schema_unsupported');
  if (!Array.isArray(value.attempts)) throw storeError('transcript_store_corrupt_state');
  const source = parseSource(value.source);
  const attempts = Array.from(value.attempts, (attempt) => parseAttempt(attempt));
  if (
    new Set(attempts.map(({ id }) => id)).size !== attempts.length ||
    attempts.some(({ sourceId, outcome }) => sourceId !== source.id || outcome === null)
  ) {
    throw storeError('transcript_store_corrupt_state');
  }
  validateSourceHistory(source, attempts);
  const id = parseSafeId(value.id);
  if (value.recoveryLocation !== `local-trash/${id}`) throw storeError('transcript_store_corrupt_state');
  return {
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    id,
    source,
    attempts,
    forgottenAt: parseIsoDateTime(value.forgottenAt),
    recoveryLocation: value.recoveryLocation
  };
}

function sameSnapshotRef(left, right) {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind &&
    left.algorithm === right.algorithm &&
    left.hash === right.hash &&
    left.contentHash === right.contentHash &&
    left.byteLength === right.byteLength;
}

function validateSourceHistory(source, attempts) {
  const expectedLastAttemptId = attempts.at(-1)?.id || null;
  if (source.lastAttemptId !== expectedLastAttemptId) {
    throw storeError('transcript_store_corrupt_state');
  }
  if (attempts.some((attempt, index) => attempt.outcome === null && index !== attempts.length - 1)) {
    throw storeError('transcript_store_corrupt_state');
  }
  let latest = null;
  for (const attempt of attempts) {
    if (attempt.outcome?.kind !== 'complete') continue;
    const expectedChanged = latest === null || latest.contentHash !== attempt.outcome.snapshot.contentHash;
    if (attempt.outcome.changed !== expectedChanged) throw storeError('transcript_store_corrupt_state');
    latest = attempt.outcome.snapshot;
  }
  if (!sameSnapshotRef(source.latestLiveSnapshot, latest)) {
    throw storeError('transcript_store_corrupt_state');
  }
}

function parseState(value) {
  requireExact(value, STATE_KEYS);
  if (value.schemaVersion !== TRANSCRIPT_STORE_SCHEMA_VERSION) throw storeError('transcript_store_schema_unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw storeError('transcript_store_corrupt_state');
  if (!Array.isArray(value.sources) || !Array.isArray(value.attempts) || !Array.isArray(value.deletedSources)) {
    throw storeError('transcript_store_corrupt_state');
  }
  const sources = Array.from(value.sources, (source) => parseSource(source));
  const attempts = Array.from(value.attempts, (attempt) => parseAttempt(attempt));
  const deletedSources = Array.from(value.deletedSources, (tombstone) => parseTombstone(tombstone));
  const deletedSourceIds = deletedSources.map(({ source }) => source.id);
  const deletedAttemptIds = deletedSources.flatMap(({ attempts: tombstoneAttempts }) =>
    tombstoneAttempts.map(({ id }) => id));
  if (
    new Set(sources.map(({ id }) => id)).size !== sources.length ||
    new Set(sources.map(({ identity }) => formatConversationIdentity(identity))).size !== sources.length ||
    new Set(sources.map(({ key }) => key)).size !== sources.length ||
    new Set(attempts.map(({ id }) => id)).size !== attempts.length ||
    new Set(deletedSources.map(({ id }) => id)).size !== deletedSources.length ||
    new Set([...sources.map(({ id }) => id), ...deletedSourceIds]).size !== sources.length + deletedSourceIds.length ||
    new Set([...attempts.map(({ id }) => id), ...deletedAttemptIds]).size !== attempts.length + deletedAttemptIds.length
  ) {
    throw storeError('transcript_store_corrupt_state');
  }
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const attemptsBySourceId = new Map(sources.map(({ id }) => [id, []]));
  const openBySource = new Set();
  for (const attempt of attempts) {
    if (!sourceById.has(attempt.sourceId)) throw storeError('transcript_store_corrupt_state');
    attemptsBySourceId.get(attempt.sourceId).push(attempt);
    if (attempt.outcome === null) {
      if (openBySource.has(attempt.sourceId)) throw storeError('transcript_store_corrupt_state');
      openBySource.add(attempt.sourceId);
    }
  }
  for (const source of sources) {
    validateSourceHistory(source, attemptsBySourceId.get(source.id));
  }
  return {
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    revision: value.revision,
    sources,
    attempts,
    deletedSources
  };
}

function emptyState() {
  return {
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    revision: 0,
    sources: [],
    attempts: [],
    deletedSources: []
  };
}

function terminalAttemptProjection(state) {
  const sourceById = new Map(state.sources.map((source) => [source.id, source]));
  const terminalBySourceId = new Map();
  let openCount = 0;
  const attempts = state.attempts.map((attempt) => {
    if (attempt.outcome !== null) return attempt;
    openCount += 1;
    const source = sourceById.get(attempt.sourceId);
    const snapshot = {
      ...MAX_SNAPSHOT_REF,
      contentHash: source.latestLiveSnapshot?.contentHash || MAX_SNAPSHOT_REF.contentHash
    };
    terminalBySourceId.set(source.id, { attempt, snapshot });
    return {
      ...attempt,
      finishedAt: attempt.startedAt,
      outcome: {
        kind: 'complete',
        snapshot,
        changed: source.latestLiveSnapshot === null
      }
    };
  });
  if (state.revision > Number.MAX_SAFE_INTEGER - openCount) {
    throw storeError('transcript_store_size_limit');
  }
  const sources = state.sources.map((source) => {
    const terminal = terminalBySourceId.get(source.id);
    return terminal
      ? {
          ...source,
          latestLiveSnapshot: terminal.snapshot,
          updatedAt: terminal.attempt.startedAt
        }
      : source;
  });
  return { ...state, revision: state.revision + openCount, sources, attempts };
}

function encodeState(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

function parseRegisterInput(value, randomId, now) {
  if (!exactKeys(value, ['identity', 'label', 'tags', 'key', 'target'])) throw storeError('transcript_source_invalid');
  const identity = parseConversationIdentity(value.identity);
  const target = parseTarget(value.target);
  if (providerConversationIdFromOwnedLocation(target.location) !== identity.providerConversationId) {
    throw storeError('transcript_source_identity_mismatch');
  }
  return parseSource({
    schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
    id: `source-${randomId()}`,
    identity,
    label: parseTranscriptSourceLabel(value.label),
    tags: parseTranscriptSourceTags(value.tags),
    key: parseTranscriptSourceKey(value.key),
    target,
    enabled: true,
    latestLiveSnapshot: null,
    lastAttemptId: null,
    createdAt: now,
    updatedAt: now
  }, { persisted: false });
}

function publicAttempt(attempt) {
  return attempt ? clone(attempt) : null;
}

function sourceState(source, lastAttempt) {
  if (!source.enabled) return 'disabled';
  if (lastAttempt?.outcome === null) return 'syncing';
  if (!lastAttempt) return 'tracked';
  return lastAttempt.outcome.kind;
}

function publicSource(source, attempts) {
  const lastAttempt = source.lastAttemptId ? attempts.get(source.lastAttemptId) || null : null;
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    identity: clone(source.identity),
    label: source.label,
    tags: [...source.tags],
    key: source.key,
    target: clone(source.target),
    enabled: source.enabled,
    state: sourceState(source, lastAttempt),
    latestLiveSnapshot: source.latestLiveSnapshot ? clone(source.latestLiveSnapshot) : null,
    lastAttempt: publicAttempt(lastAttempt),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
}

function resultFor(source, attempt, attempts) {
  return {
    source: publicSource(source, attempts),
    attempt: publicAttempt(attempt),
    status: attempt.outcome.kind,
    outcome: clone(attempt.outcome)
  };
}

export function createTranscriptStore({
  stateDir,
  blobs,
  fileSystem = privateFileSystem,
  clock = () => new Date().toISOString(),
  randomId = crypto.randomUUID,
  maxStateBytes = MAX_STATE_BYTES
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw storeError('transcript_store_state_dir_required');
  if (!blobs || typeof blobs.getSnapshot !== 'function') throw storeError('transcript_store_blobs_required');
  if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1 || maxStateBytes > MAX_STATE_BYTES) {
    throw storeError('transcript_store_size_limit_invalid');
  }
  const root = path.join(stateDir, 'transcript-library', 'live');
  const filePath = path.join(root, 'state.json');
  let durableState = emptyState();
  let loadPromise = null;
  let queue = Promise.resolve();
  let writeUncertain = false;

  function nowIso() {
    try {
      return parseIsoDateTime(clock());
    } catch {
      throw storeError('transcript_store_clock_invalid');
    }
  }

  async function loadOnce() {
    try {
      await fileSystem.ensurePrivateDirectory(root, { boundaryPath: stateDir });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('private_')) {
        throw storeError('transcript_store_corrupt_state');
      }
      throw storeError('transcript_store_io');
    }
    let kind;
    try {
      kind = await fileSystem.pathKind(filePath, { boundaryPath: stateDir });
    } catch (error) {
      throw storeError('transcript_store_io');
    }
    if (kind === 'missing') {
      durableState = emptyState();
      return clone(durableState);
    }
    if (kind !== 'file') throw storeError('transcript_store_corrupt_state');
    let bytes;
    try {
      bytes = await fileSystem.readPrivateFile(filePath, {
        maxBytes: maxStateBytes,
        boundaryPath: stateDir
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('private_')) {
        throw storeError('transcript_store_corrupt_state');
      }
      throw storeError('transcript_store_io');
    }
    let raw;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw storeError('transcript_store_corrupt_state');
    }
    try {
      durableState = parseState(raw);
    } catch (error) {
      if (error?.code === 'transcript_store_schema_unsupported') throw error;
      throw storeError('transcript_store_corrupt_state');
    }
    return clone(durableState);
  }

  async function load() {
    if (writeUncertain) throw storeError('transcript_store_reload_required');
    if (!loadPromise) loadPromise = loadOnce();
    const loaded = await loadPromise;
    if (writeUncertain) throw storeError('transcript_store_reload_required');
    return clone(loaded);
  }

  function enqueue(operation) {
    const next = queue.catch(() => {}).then(async () => {
      await load();
      if (writeUncertain) throw storeError('transcript_store_reload_required');
      return await operation();
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function persist(candidate) {
    const parsed = parseState({ ...candidate, revision: durableState.revision + 1 });
    const bytes = encodeState(parsed);
    if (bytes.length > maxStateBytes) throw storeError('transcript_store_size_limit');
    const terminalBytes = encodeState(terminalAttemptProjection(parsed));
    if (terminalBytes.length > maxStateBytes) throw storeError('transcript_store_size_limit');
    try {
      await fileSystem.replaceFile(filePath, bytes, { boundaryPath: stateDir });
    } catch {
      writeUncertain = true;
      throw storeError('transcript_store_io');
    }
    durableState = parsed;
    return parsed;
  }

  function maps(state = durableState) {
    return {
      sources: new Map(state.sources.map((source) => [source.id, source])),
      attempts: new Map(state.attempts.map((attempt) => [attempt.id, attempt]))
    };
  }

  async function register(input) {
    return await enqueue(async () => {
      const now = nowIso();
      const source = parseRegisterInput(input, randomId, now);
      if (durableState.sources.some(({ identity }) => sameConversationIdentity(identity, source.identity))) {
        throw storeError('transcript_source_exists');
      }
      if (durableState.sources.some(({ key }) => key === source.key)) throw storeError('transcript_source_key_exists');
      const persisted = await persist({ ...clone(durableState), sources: [...durableState.sources, source] });
      return publicSource(source, maps(persisted).attempts);
    });
  }

  async function list() {
    await load();
    const { attempts } = maps();
    return durableState.sources
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map((source) => publicSource(source, attempts));
  }

  async function getSource(sourceId) {
    await load();
    const { sources, attempts } = maps();
    const source = sources.get(parseSafeId(sourceId));
    if (!source) throw storeError('transcript_source_not_found');
    return publicSource(source, attempts);
  }

  async function findSource(identity) {
    await load();
    const parsedIdentity = parseConversationIdentity(identity);
    const { attempts } = maps();
    const source = durableState.sources.find((candidate) => sameConversationIdentity(candidate.identity, parsedIdentity));
    return source ? publicSource(source, attempts) : null;
  }

  async function beginAttempt(sourceId, trigger = 'manual') {
    return await enqueue(async () => {
      const id = parseSafeId(sourceId);
      if (!['manual', 'post-query'].includes(trigger)) throw storeError('transcript_attempt_trigger_invalid');
      const sourceIndex = durableState.sources.findIndex((source) => source.id === id);
      if (sourceIndex < 0) throw storeError('transcript_source_not_found');
      const source = durableState.sources[sourceIndex];
      if (!source.enabled) throw storeError('transcript_source_disabled');
      if (durableState.attempts.some((attempt) => attempt.sourceId === id && attempt.outcome === null)) {
        throw storeError('transcript_sync_active');
      }
      const now = nowIso();
      const attempt = parseAttempt({
        schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
        id: `attempt-${randomId()}`,
        sourceId: id,
        trigger,
        startedAt: now,
        finishedAt: null,
        outcome: null
      });
      const nextSource = { ...source, lastAttemptId: attempt.id, updatedAt: now };
      const sources = durableState.sources.slice();
      sources[sourceIndex] = nextSource;
      await persist({ ...clone(durableState), sources, attempts: [...durableState.attempts, attempt] });
      return publicAttempt(attempt);
    });
  }

  async function commitComplete(attemptId, snapshotValue, contentHash) {
    const snapshotRef = parseSnapshotRef(snapshotValue);
    if (snapshotRef.contentHash !== contentHash) throw storeError('transcript_snapshot_content_hash_mismatch');
    const snapshot = await blobs.getSnapshot(snapshotRef);
    if (snapshot.contentHash !== contentHash || snapshot.snapshotHash !== snapshotRef.hash) {
      throw storeError('transcript_snapshot_content_hash_mismatch');
    }
    return await enqueue(async () => {
      const id = parseSafeId(attemptId);
      const attemptIndex = durableState.attempts.findIndex((attempt) => attempt.id === id);
      if (attemptIndex < 0) throw storeError('transcript_attempt_not_found');
      const attempt = durableState.attempts[attemptIndex];
      const sourceIndex = durableState.sources.findIndex((source) => source.id === attempt.sourceId);
      if (sourceIndex < 0) throw storeError('transcript_source_not_found');
      const source = durableState.sources[sourceIndex];
      if (!sameConversationIdentity(source.identity, snapshot.identity)) throw storeError('transcript_snapshot_identity_mismatch');
      if (snapshot.origin.kind !== 'live-capture') throw storeError('transcript_snapshot_origin_mismatch');
      if (attempt.outcome !== null) {
        if (
          attempt.outcome.kind === 'complete' &&
          attempt.outcome.snapshot.hash === snapshotRef.hash &&
          attempt.outcome.snapshot.contentHash === snapshotRef.contentHash
        ) {
          return resultFor(source, attempt, maps().attempts);
        }
        throw storeError('transcript_attempt_already_finished');
      }
      if (!source.enabled) throw storeError('transcript_source_disabled');
      const now = nowIso();
      const changed = source.latestLiveSnapshot?.contentHash !== contentHash;
      const completeAttempt = {
        ...attempt,
        finishedAt: now,
        outcome: { kind: 'complete', snapshot: snapshotRef, changed }
      };
      const nextSource = {
        ...source,
        latestLiveSnapshot: snapshotRef,
        lastAttemptId: attempt.id,
        updatedAt: now
      };
      const sources = durableState.sources.slice();
      const attempts = durableState.attempts.slice();
      sources[sourceIndex] = nextSource;
      attempts[attemptIndex] = completeAttempt;
      const persisted = await persist({ ...clone(durableState), sources, attempts });
      const persistedMaps = maps(persisted);
      return resultFor(persistedMaps.sources.get(source.id), persistedMaps.attempts.get(attempt.id), persistedMaps.attempts);
    });
  }

  async function finishIncomplete(attemptId, outcomeValue) {
    let outcome;
    try {
      outcome = parseOutcome(outcomeValue);
    } catch {
      throw storeError('transcript_attempt_outcome_invalid');
    }
    if (outcome.kind === 'complete') throw storeError('transcript_attempt_outcome_invalid');
    return await enqueue(async () => {
      const id = parseSafeId(attemptId);
      const attemptIndex = durableState.attempts.findIndex((attempt) => attempt.id === id);
      if (attemptIndex < 0) throw storeError('transcript_attempt_not_found');
      const attempt = durableState.attempts[attemptIndex];
      const sourceIndex = durableState.sources.findIndex((source) => source.id === attempt.sourceId);
      if (sourceIndex < 0) throw storeError('transcript_source_not_found');
      const source = durableState.sources[sourceIndex];
      if (attempt.outcome !== null) {
        if (JSON.stringify(attempt.outcome) === JSON.stringify(outcome)) return resultFor(source, attempt, maps().attempts);
        throw storeError('transcript_attempt_already_finished');
      }
      const now = nowIso();
      const completeAttempt = { ...attempt, finishedAt: now, outcome };
      const nextSource = { ...source, lastAttemptId: attempt.id, updatedAt: now };
      const sources = durableState.sources.slice();
      const attempts = durableState.attempts.slice();
      sources[sourceIndex] = nextSource;
      attempts[attemptIndex] = completeAttempt;
      const persisted = await persist({ ...clone(durableState), sources, attempts });
      const persistedMaps = maps(persisted);
      return resultFor(persistedMaps.sources.get(source.id), persistedMaps.attempts.get(attempt.id), persistedMaps.attempts);
    });
  }

  async function recoverInterrupted() {
    return await enqueue(async () => {
      const open = durableState.attempts.filter((attempt) => attempt.outcome === null);
      if (!open.length) return 0;
      const now = nowIso();
      const openIds = new Set(open.map(({ id }) => id));
      const attempts = durableState.attempts.map((attempt) => openIds.has(attempt.id)
        ? { ...attempt, finishedAt: now, outcome: { kind: 'interrupted' } }
        : attempt);
      const sources = durableState.sources.map((source) => {
        const interrupted = open.find((attempt) => attempt.sourceId === source.id);
        return interrupted ? { ...source, lastAttemptId: interrupted.id, updatedAt: now } : source;
      });
      await persist({ ...clone(durableState), sources, attempts });
      return open.length;
    });
  }

  async function setEnabled(sourceId, enabled) {
    if (typeof enabled !== 'boolean') throw storeError('transcript_source_invalid');
    return await enqueue(async () => {
      const id = parseSafeId(sourceId);
      const sourceIndex = durableState.sources.findIndex((source) => source.id === id);
      if (sourceIndex < 0) throw storeError('transcript_source_not_found');
      if (durableState.attempts.some((attempt) => attempt.sourceId === id && attempt.outcome === null)) {
        throw storeError('transcript_sync_active');
      }
      const source = durableState.sources[sourceIndex];
      if (source.enabled === enabled) return publicSource(source, maps().attempts);
      const sources = durableState.sources.slice();
      sources[sourceIndex] = { ...source, enabled, updatedAt: nowIso() };
      const persisted = await persist({ ...clone(durableState), sources });
      return publicSource(maps(persisted).sources.get(id), maps(persisted).attempts);
    });
  }

  async function forget(sourceId) {
    return await enqueue(async () => {
      const id = parseSafeId(sourceId);
      const sourceIndex = durableState.sources.findIndex((source) => source.id === id);
      if (sourceIndex < 0) throw storeError('transcript_source_not_found');
      if (durableState.attempts.some((attempt) => attempt.sourceId === id && attempt.outcome === null)) {
        throw storeError('transcript_sync_active');
      }
      const source = durableState.sources[sourceIndex];
      const attemptsForSource = durableState.attempts.filter((attempt) => attempt.sourceId === id);
      const tombstoneId = `deleted-${randomId()}`;
      const forgottenAt = nowIso();
      const recoveryLocation = `local-trash/${tombstoneId}`;
      const tombstone = parseTombstone({
        schemaVersion: TRANSCRIPT_STORE_SCHEMA_VERSION,
        id: tombstoneId,
        source,
        attempts: attemptsForSource,
        forgottenAt,
        recoveryLocation
      });
      await persist({
        ...clone(durableState),
        sources: durableState.sources.filter((candidate) => candidate.id !== id),
        attempts: durableState.attempts.filter((attempt) => attempt.sourceId !== id),
        deletedSources: [...durableState.deletedSources, tombstone]
      });
      return { sourceId: id, recoverable: true, recoveryLocation, forgottenAt };
    });
  }

  async function listDeleted() {
    await load();
    return clone(durableState.deletedSources);
  }

  return Object.freeze({
    load,
    register,
    list,
    getSource,
    findSource,
    beginAttempt,
    commitComplete,
    finishIncomplete,
    recoverInterrupted,
    setEnabled,
    forget,
    listDeleted,
    root,
    statePath: filePath
  });
}
