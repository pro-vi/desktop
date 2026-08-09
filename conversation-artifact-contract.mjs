import crypto from 'node:crypto';
import path from 'node:path';

import { parseChatGptEntryTarget } from './chatgpt-location.mjs';
import { TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN } from './transcript-contract.mjs';

export const CONVERSATION_ARTIFACT_CONTRACT_VERSION = 1;

const PROVIDER_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,511})$/;
const ARTIFACT_KEY_PATTERN = /^ca1_[a-f0-9]{64}$/;
const DOWNLOAD_FAILURE_REASONS = Object.freeze([
  'artifact_invalid',
  'capture_unavailable',
  'download_unavailable',
  'interrupted',
  'name_mismatch',
  'timeout'
]);
const INVENTORY_REASONS = Object.freeze([
  'artifact_identity_unavailable',
  'compatibility_drift',
  'conversation_boundary_incomplete',
  'conversation_capture_timeout',
  'conversation_generation_active'
]);

function contractError(reason, field = null) {
  const error = new Error(`invalid_conversation_artifact_contract:${reason}`);
  error.code = 'invalid_conversation_artifact_contract';
  error.data = field ? { field, reason } : { reason };
  return error;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, field) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw contractError('unexpected_fields', field);
  }
}

function parseProviderConversationId(value, field = 'providerConversationId') {
  if (typeof value !== 'string' || !PROVIDER_CONVERSATION_ID_PATTERN.test(value)) {
    throw contractError('invalid_provider_conversation_id', field);
  }
  return value;
}

function parseProviderMessageId(value, field = 'providerMessageId') {
  if (typeof value !== 'string' || !TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN.test(value)) {
    throw contractError('invalid_provider_message_id', field);
  }
  return value;
}

function parseInteger(value, field, max = 100_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw contractError('invalid_integer', field);
  }
  return value;
}

function parseName(value, field = 'name') {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1_024 ||
    value.includes('\u0000') ||
    !value.trim()
  ) {
    throw contractError('invalid_name', field);
  }
  return value.trim();
}

function parseArtifactKey(value, field = 'artifactKey') {
  if (typeof value !== 'string' || !ARTIFACT_KEY_PATTERN.test(value)) {
    throw contractError('invalid_artifact_key', field);
  }
  return value;
}

function parseCanonicalConversationUrl(value, field = 'conversationUrl') {
  let target;
  try {
    target = parseChatGptEntryTarget(value);
  } catch {
    throw contractError('invalid_conversation_url', field);
  }
  if (target?.kind !== 'canonical-conversation') {
    throw contractError('invalid_conversation_url', field);
  }
  return target.chatUrl;
}

export function createConversationArtifactKey({
  providerConversationId,
  providerMessageId,
  occurrenceWithinMessage
} = {}) {
  const conversationId = parseProviderConversationId(providerConversationId);
  const messageId = parseProviderMessageId(providerMessageId);
  const occurrence = parseInteger(occurrenceWithinMessage, 'occurrenceWithinMessage');
  const identity = JSON.stringify([
    CONVERSATION_ARTIFACT_CONTRACT_VERSION,
    conversationId,
    messageId,
    occurrence
  ]);
  return `ca1_${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

export function createConversationArtifactDescriptor({
  providerConversationId,
  providerMessageId,
  providerTurnIndex,
  occurrenceWithinMessage,
  name,
  kind = 'file'
} = {}) {
  const value = {
    schemaVersion: CONVERSATION_ARTIFACT_CONTRACT_VERSION,
    artifactKey: createConversationArtifactKey({
      providerConversationId,
      providerMessageId,
      occurrenceWithinMessage
    }),
    providerConversationId,
    providerMessageId,
    providerTurnIndex,
    occurrenceWithinMessage,
    name,
    kind
  };
  return parseConversationArtifactDescriptor(value);
}

export function parseConversationArtifactDescriptor(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'descriptor');
  assertExactKeys(value, [
    'schemaVersion',
    'artifactKey',
    'providerConversationId',
    'providerMessageId',
    'providerTurnIndex',
    'occurrenceWithinMessage',
    'name',
    'kind'
  ], 'descriptor');
  if (value.schemaVersion !== CONVERSATION_ARTIFACT_CONTRACT_VERSION) {
    throw contractError('unknown_schema_version', 'schemaVersion');
  }
  if (value.kind !== 'file') throw contractError('unknown_kind', 'kind');
  const providerConversationId = parseProviderConversationId(value.providerConversationId);
  const providerMessageId = parseProviderMessageId(value.providerMessageId);
  const providerTurnIndex = parseInteger(value.providerTurnIndex, 'providerTurnIndex');
  const occurrenceWithinMessage = parseInteger(value.occurrenceWithinMessage, 'occurrenceWithinMessage');
  const expectedKey = createConversationArtifactKey({
    providerConversationId,
    providerMessageId,
    occurrenceWithinMessage
  });
  parseArtifactKey(value.artifactKey);
  if (value.artifactKey !== expectedKey) throw contractError('contradictory_artifact_key', 'artifactKey');
  return Object.freeze({
    schemaVersion: CONVERSATION_ARTIFACT_CONTRACT_VERSION,
    artifactKey: expectedKey,
    providerConversationId,
    providerMessageId,
    providerTurnIndex,
    occurrenceWithinMessage,
    name: parseName(value.name),
    kind: 'file'
  });
}

export function parseConversationArtifactInventory(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'artifactInventory');
  if (value.status !== 'complete' && value.status !== 'partial') {
    throw contractError('unknown_inventory_status', 'status');
  }
  assertExactKeys(
    value,
    value.status === 'complete' ? ['status', 'items'] : ['status', 'reason', 'items'],
    'artifactInventory'
  );
  if (!Array.isArray(value.items) || value.items.length > 10_000) {
    throw contractError('invalid_item_count', 'items');
  }
  const items = Object.freeze(Array.from(value.items, parseConversationArtifactDescriptor));
  const keys = new Set();
  for (const item of items) {
    if (keys.has(item.artifactKey)) throw contractError('duplicate_artifact_key', 'items');
    keys.add(item.artifactKey);
  }
  if (value.status === 'complete') return Object.freeze({ status: 'complete', items });
  if (!INVENTORY_REASONS.includes(value.reason)) {
    throw contractError('unknown_inventory_reason', 'reason');
  }
  return Object.freeze({ status: 'partial', reason: value.reason, items });
}

export function emptyPartialConversationArtifactInventory(reason = 'compatibility_drift') {
  return parseConversationArtifactInventory({ status: 'partial', reason, items: [] });
}

export function parseConversationArtifactProvenance(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'provenance');
  assertExactKeys(value, [
    'schemaVersion',
    'artifactKey',
    'conversationUrl',
    'providerConversationId',
    'providerMessageId',
    'providerTurnIndex',
    'occurrenceWithinMessage',
    'name',
    'kind'
  ], 'provenance');
  if (value.schemaVersion !== CONVERSATION_ARTIFACT_CONTRACT_VERSION) {
    throw contractError('unknown_schema_version', 'provenance.schemaVersion');
  }
  if (value.kind !== 'file') throw contractError('unknown_kind', 'provenance.kind');
  const providerConversationId = parseProviderConversationId(
    value.providerConversationId,
    'provenance.providerConversationId'
  );
  const providerMessageId = parseProviderMessageId(
    value.providerMessageId,
    'provenance.providerMessageId'
  );
  const occurrenceWithinMessage = parseInteger(
    value.occurrenceWithinMessage,
    'provenance.occurrenceWithinMessage'
  );
  const expectedKey = createConversationArtifactKey({
    providerConversationId,
    providerMessageId,
    occurrenceWithinMessage
  });
  if (parseArtifactKey(value.artifactKey, 'provenance.artifactKey') !== expectedKey) {
    throw contractError('contradictory_artifact_key', 'provenance.artifactKey');
  }
  return Object.freeze({
    schemaVersion: CONVERSATION_ARTIFACT_CONTRACT_VERSION,
    artifactKey: expectedKey,
    conversationUrl: parseCanonicalConversationUrl(value.conversationUrl, 'provenance.conversationUrl'),
    providerConversationId,
    providerMessageId,
    providerTurnIndex: parseInteger(value.providerTurnIndex, 'provenance.providerTurnIndex'),
    occurrenceWithinMessage,
    name: parseName(value.name, 'provenance.name'),
    kind: 'file'
  });
}

export function parseConversationArtifactDownloadRequest(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'downloadRequest');
  assertExactKeys(value, [
    'artifactKeys',
    'maxFiles',
    'maxBytesPerFile',
    'timeoutMs'
  ], 'downloadRequest');
  const maxFiles = parseInteger(value.maxFiles, 'maxFiles', 50);
  if (maxFiles < 1) throw contractError('invalid_integer', 'maxFiles');
  if (!Array.isArray(value.artifactKeys) || value.artifactKeys.length > maxFiles) {
    throw contractError('invalid_item_count', 'artifactKeys');
  }
  const artifactKeys = Object.freeze(Array.from(value.artifactKeys, (key, index) =>
    parseArtifactKey(key, `artifactKeys.${index}`)));
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    throw contractError('duplicate_artifact_key', 'artifactKeys');
  }
  const maxBytesPerFile = parseInteger(value.maxBytesPerFile, 'maxBytesPerFile', 1024 * 1024 * 1024);
  if (maxBytesPerFile < 1_024) throw contractError('invalid_integer', 'maxBytesPerFile');
  const timeoutMs = parseInteger(value.timeoutMs, 'timeoutMs', 120_000);
  if (timeoutMs < 1_000) throw contractError('invalid_integer', 'timeoutMs');
  return Object.freeze({ artifactKeys, maxFiles, maxBytesPerFile, timeoutMs });
}

function parseSavedArtifactProjection(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'artifact');
  assertExactKeys(value, ['id', 'path', 'name', 'mime', 'kind', 'savedAt'], 'artifact');
  if (typeof value.id !== 'string' || !value.id.trim()) throw contractError('invalid_id', 'artifact.id');
  if (typeof value.path !== 'string' || !path.isAbsolute(value.path)) {
    throw contractError('invalid_path', 'artifact.path');
  }
  if (value.kind !== 'file') throw contractError('unknown_kind', 'artifact.kind');
  if (value.mime !== null && (typeof value.mime !== 'string' || value.mime.length > 256)) {
    throw contractError('invalid_mime', 'artifact.mime');
  }
  if (typeof value.savedAt !== 'string' || !Number.isFinite(new Date(value.savedAt).getTime())) {
    throw contractError('invalid_datetime', 'artifact.savedAt');
  }
  return Object.freeze({
    id: value.id,
    path: value.path,
    name: parseName(value.name, 'artifact.name'),
    mime: value.mime,
    kind: 'file',
    savedAt: value.savedAt
  });
}

export function parseConversationArtifactDownloadOutcome(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'downloadOutcome');
  const status = value.status;
  const artifactKey = parseArtifactKey(value.artifactKey);
  if (status === 'saved') {
    assertExactKeys(value, ['status', 'artifactKey', 'artifact', 'provenance'], 'downloadOutcome');
    const provenance = parseConversationArtifactProvenance(value.provenance);
    if (provenance.artifactKey !== artifactKey) {
      throw contractError('contradictory_artifact_key', 'downloadOutcome.provenance');
    }
    return Object.freeze({
      status,
      artifactKey,
      artifact: parseSavedArtifactProjection(value.artifact),
      provenance
    });
  }
  if (status === 'not_found' || status === 'conversation_changed') {
    assertExactKeys(value, ['status', 'artifactKey'], 'downloadOutcome');
    return Object.freeze({ status, artifactKey });
  }
  if (status === 'unsupported') {
    assertExactKeys(value, ['status', 'artifactKey', 'kind'], 'downloadOutcome');
    if (value.kind !== 'file') throw contractError('unknown_kind', 'downloadOutcome.kind');
    return Object.freeze({ status, artifactKey, kind: value.kind });
  }
  if (status === 'download_failed') {
    assertExactKeys(value, ['status', 'artifactKey', 'reason'], 'downloadOutcome');
    if (!DOWNLOAD_FAILURE_REASONS.includes(value.reason)) {
      throw contractError('unknown_download_failure_reason', 'downloadOutcome.reason');
    }
    return Object.freeze({ status, artifactKey, reason: value.reason });
  }
  if (status === 'size_limit_exceeded') {
    assertExactKeys(value, ['status', 'artifactKey', 'maxBytes'], 'downloadOutcome');
    return Object.freeze({
      status,
      artifactKey,
      maxBytes: parseInteger(value.maxBytes, 'downloadOutcome.maxBytes', 1024 * 1024 * 1024)
    });
  }
  throw contractError('unknown_download_status', 'downloadOutcome.status');
}

export function parseConversationArtifactDownloadBatch(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'downloadBatch');
  assertExactKeys(value, ['outcomes', 'requestedCount', 'savedCount'], 'downloadBatch');
  if (!Array.isArray(value.outcomes) || value.outcomes.length > 50) {
    throw contractError('invalid_item_count', 'downloadBatch.outcomes');
  }
  const outcomes = Object.freeze(Array.from(value.outcomes, parseConversationArtifactDownloadOutcome));
  const requestedCount = parseInteger(value.requestedCount, 'downloadBatch.requestedCount', 50);
  const savedCount = parseInteger(value.savedCount, 'downloadBatch.savedCount', 50);
  if (requestedCount !== outcomes.length) throw contractError('count_mismatch', 'requestedCount');
  if (savedCount !== outcomes.filter((outcome) => outcome.status === 'saved').length) {
    throw contractError('count_mismatch', 'savedCount');
  }
  if (new Set(outcomes.map((outcome) => outcome.artifactKey)).size !== outcomes.length) {
    throw contractError('duplicate_artifact_key', 'downloadBatch.outcomes');
  }
  return Object.freeze({ outcomes, requestedCount, savedCount });
}
