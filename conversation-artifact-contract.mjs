import crypto from 'node:crypto';

import { TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN } from './transcript-contract.mjs';

export const CONVERSATION_ARTIFACT_CONTRACT_VERSION = 1;

const PROVIDER_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,511})$/;
const ARTIFACT_KEY_PATTERN = /^ca1_[a-f0-9]{64}$/;
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
  if (typeof value.artifactKey !== 'string' || !ARTIFACT_KEY_PATTERN.test(value.artifactKey)) {
    throw contractError('invalid_artifact_key', 'artifactKey');
  }
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
