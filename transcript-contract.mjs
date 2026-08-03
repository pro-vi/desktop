import crypto from 'node:crypto';

import { parseChatGptEntryTarget } from './chatgpt-location.mjs';

export const TRANSCRIPT_SCHEMA_VERSION = 1;
export const TRANSCRIPT_NORMALIZATION_VERSION = 1;
export const TRANSCRIPT_PAGE_MAX_TEXT_CHARS = 1_000_000;
// "Assistant\n" is the longest rendered role label plus separator.
export const TRANSCRIPT_TURN_MAX_TEXT_CHARS = TRANSCRIPT_PAGE_MAX_TEXT_CHARS - 10;
export const TRANSCRIPT_CAPTURE_REASONS = Object.freeze([
  'conversation_messages_not_found',
  'conversation_top_not_reached',
  'conversation_leading_turn_missing',
  'conversation_scroll_stalled',
  'conversation_capture_timeout',
  'conversation_generation_active',
  'conversation_capture_limit_reached',
  'max_capture_bytes',
  'conversation_message_text_unavailable',
  'ambiguous_message_overlap',
  'compatibility_drift'
]);
export const LEGACY_CONVERSATION_TEXT_REASONS = Object.freeze([
  'conversation_messages_not_found',
  'conversation_scroller_not_found',
  'conversation_scroll_stalled',
  'conversation_scroll_limit_reached',
  'conversation_top_capture_timeout',
  'conversation_top_scroll_stalled',
  'conversation_top_not_reached',
  'conversation_capture_timeout',
  'max_chars',
  'leading_turn_missing',
  'conversation_capture_invalid'
]);
export const TRANSCRIPT_TURN_ROLES = Object.freeze(['user', 'assistant', 'system', 'tool', 'unknown']);
export const TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,511})$/;

const CAPTURE_KEYS = Object.freeze(['status', 'conversationUrl', 'capturedAt', 'rawTurns', 'evidence']);
const PARTIAL_CAPTURE_KEYS = Object.freeze([...CAPTURE_KEYS, 'reason']);
const CAPTURE_WINDOW_KEYS = Object.freeze(['status', 'rawTurns', 'evidence']);
const PARTIAL_CAPTURE_WINDOW_KEYS = Object.freeze([...CAPTURE_WINDOW_KEYS, 'reason']);
const EVIDENCE_KEYS = Object.freeze([
  'topBoundary',
  'bottomBoundary',
  'orderedWindowStitching',
  'scrollPasses',
  'windowCount',
  'messageCount',
  'providerIdCount',
  'byteCount'
]);
const RAW_TURN_KEYS = Object.freeze(['ordinal', 'providerMessageId', 'role', 'text']);
const NORMALIZED_KEYS = Object.freeze(['normalizationVersion', 'turns', 'characterCount', 'contentHash']);
const TURN_KEYS = Object.freeze(['turnId', 'ordinal', 'identity', 'role', 'rawRole', 'text']);
const MAX_TURNS = 100_000;
const LEGACY_REASON_BY_CAPTURE_REASON = Object.freeze({
  conversation_messages_not_found: 'conversation_messages_not_found',
  conversation_top_not_reached: 'conversation_top_not_reached',
  conversation_leading_turn_missing: 'leading_turn_missing',
  conversation_scroll_stalled: 'conversation_scroll_stalled',
  conversation_capture_timeout: 'conversation_capture_timeout',
  conversation_generation_active: 'conversation_capture_invalid',
  conversation_capture_limit_reached: 'conversation_scroll_limit_reached',
  max_capture_bytes: 'max_chars',
  conversation_message_text_unavailable: 'conversation_capture_invalid',
  ambiguous_message_overlap: 'conversation_capture_invalid',
  compatibility_drift: 'conversation_capture_invalid'
});
const STRUCTURED_REASONS_BY_LEGACY_DIAGNOSTIC = Object.freeze({
  conversation_top_capture_timeout: Object.freeze([
    'conversation_capture_timeout',
    'conversation_generation_active'
  ]),
  conversation_top_scroll_stalled: Object.freeze([
    'conversation_scroll_stalled',
    'conversation_generation_active'
  ])
});

function contractError(reason, field = null) {
  const error = new Error(`invalid_transcript_contract:${reason}`);
  error.code = 'invalid_transcript_contract';
  error.data = field ? { field, reason } : { reason };
  return error;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, field) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw contractError('unexpected_fields', field);
  }
}

function assertInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw contractError('invalid_integer', field);
  }
  return value;
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw contractError('invalid_boolean', field);
  return value;
}

function assertSha256(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw contractError('invalid_sha256', field);
  }
  return value;
}

function parseIsoDateTime(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw contractError('invalid_datetime', field);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw contractError('invalid_datetime', field);
  }
  return value;
}

export function parseTranscriptProviderMessageId(value, field = 'providerMessageId') {
  if (
    typeof value !== 'string' ||
    !TRANSCRIPT_PROVIDER_MESSAGE_ID_PATTERN.test(value)
  ) {
    throw contractError('invalid_provider_message_id', field);
  }
  return value;
}

function parseCanonicalConversationUrl(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  let target;
  try {
    target = parseChatGptEntryTarget(value);
  } catch {
    throw contractError('invalid_conversation_url', 'conversationUrl');
  }
  if (!target || target.kind !== 'canonical-conversation') {
    throw contractError('invalid_conversation_url', 'conversationUrl');
  }
  return target.chatUrl;
}

function parseEvidence(value, rawTurns) {
  if (!isRecord(value)) throw contractError('expected_object', 'evidence');
  assertExactKeys(value, EVIDENCE_KEYS, 'evidence');
  const evidence = {
    topBoundary: assertBoolean(value.topBoundary, 'evidence.topBoundary'),
    bottomBoundary: assertBoolean(value.bottomBoundary, 'evidence.bottomBoundary'),
    orderedWindowStitching: assertBoolean(value.orderedWindowStitching, 'evidence.orderedWindowStitching'),
    scrollPasses: assertInteger(value.scrollPasses, 'evidence.scrollPasses'),
    windowCount: assertInteger(value.windowCount, 'evidence.windowCount', { min: 1 }),
    messageCount: assertInteger(value.messageCount, 'evidence.messageCount', { max: MAX_TURNS }),
    providerIdCount: assertInteger(value.providerIdCount, 'evidence.providerIdCount', { max: MAX_TURNS }),
    byteCount: assertInteger(value.byteCount, 'evidence.byteCount')
  };
  const providerIdCount = rawTurns.filter((turn) => turn.providerMessageId !== null).length;
  const byteCount = rawTurns.reduce((total, turn) =>
    total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId || ''), 0);
  if (
    evidence.messageCount !== rawTurns.length ||
    evidence.providerIdCount !== providerIdCount ||
    evidence.byteCount !== byteCount
  ) {
    throw contractError('evidence_count_mismatch', 'evidence');
  }
  return Object.freeze(evidence);
}

export function normalizeTranscriptRawRole(value, field = 'role') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw contractError('invalid_role', field);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw contractError('invalid_role', field);
  }
  return normalized;
}

function parseRawTurn(value, expectedOrdinal) {
  if (!isRecord(value)) throw contractError('expected_object', `rawTurns.${expectedOrdinal}`);
  assertExactKeys(value, RAW_TURN_KEYS, `rawTurns.${expectedOrdinal}`);
  const ordinal = assertInteger(value.ordinal, `rawTurns.${expectedOrdinal}.ordinal`, { max: MAX_TURNS - 1 });
  if (ordinal !== expectedOrdinal) throw contractError('contradictory_ordinal', `rawTurns.${expectedOrdinal}.ordinal`);
  const providerMessageId = value.providerMessageId === null
    ? null
    : parseTranscriptProviderMessageId(value.providerMessageId, `rawTurns.${expectedOrdinal}.providerMessageId`);
  normalizeTranscriptRawRole(value.role, `rawTurns.${expectedOrdinal}.role`);
  if (
    typeof value.text !== 'string' ||
    value.text.length < 1 ||
    value.text.length > TRANSCRIPT_TURN_MAX_TEXT_CHARS ||
    value.text.includes('\u0000')
  ) {
    throw contractError('invalid_text', `rawTurns.${expectedOrdinal}.text`);
  }
  return Object.freeze({
    ordinal,
    providerMessageId,
    role: value.role,
    text: value.text
  });
}

function parseRawTurns(value, { allowEmpty }) {
  if (!Array.isArray(value) || value.length > MAX_TURNS || (!allowEmpty && value.length === 0)) {
    throw contractError('invalid_turn_count', 'rawTurns');
  }
  return Object.freeze(Array.from(value, (turn, index) => parseRawTurn(turn, index)));
}

function parseCaptureWindowFields(value) {
  if (value.status !== 'complete' && value.status !== 'partial') {
    throw contractError('unknown_capture_status', 'status');
  }
  const rawTurns = parseRawTurns(value.rawTurns, { allowEmpty: value.status === 'partial' });
  const evidence = parseEvidence(value.evidence, rawTurns);
  if (value.status === 'complete') {
    if (!evidence.topBoundary || !evidence.bottomBoundary || !evidence.orderedWindowStitching) {
      throw contractError('complete_without_boundaries', 'evidence');
    }
    return Object.freeze({ status: 'complete', rawTurns, evidence });
  }
  if (!TRANSCRIPT_CAPTURE_REASONS.includes(value.reason)) {
    throw contractError('unknown_capture_reason', 'reason');
  }
  return Object.freeze({ status: 'partial', reason: value.reason, rawTurns, evidence });
}

function parseConversationCaptureWindow(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'captureWindow');
  if (value.status !== 'complete' && value.status !== 'partial') {
    throw contractError('unknown_capture_status', 'status');
  }
  assertExactKeys(
    value,
    value.status === 'complete' ? CAPTURE_WINDOW_KEYS : PARTIAL_CAPTURE_WINDOW_KEYS,
    'captureWindow'
  );
  return parseCaptureWindowFields(value);
}

export function parseConversationCapture(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'capture');
  if (value.status !== 'complete' && value.status !== 'partial') {
    throw contractError('unknown_capture_status', 'status');
  }
  assertExactKeys(value, value.status === 'complete' ? CAPTURE_KEYS : PARTIAL_CAPTURE_KEYS, 'capture');
  const window = parseCaptureWindowFields(value);
  const common = {
    conversationUrl: parseCanonicalConversationUrl(value.conversationUrl, { nullable: value.status === 'partial' }),
    capturedAt: parseIsoDateTime(value.capturedAt, 'capturedAt'),
    rawTurns: window.rawTurns,
    evidence: window.evidence
  };
  return window.status === 'complete'
    ? Object.freeze({ status: 'complete', ...common })
    : Object.freeze({ status: 'partial', reason: window.reason, ...common });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
}

function normalizeTurnText(value, field) {
  const text = normalizeText(value);
  if (!text) throw contractError('empty_normalized_text', field);
  if (text.length > TRANSCRIPT_TURN_MAX_TEXT_CHARS) {
    throw contractError('invalid_text', field);
  }
  return text;
}

function normalizeRawTurn(raw, ordinal, providerIds, fieldPrefix = 'rawTurns') {
  if (raw.ordinal !== ordinal) throw contractError('contradictory_ordinal', `${fieldPrefix}.${ordinal}.ordinal`);
  const rawRole = normalizeTranscriptRawRole(raw.role, `${fieldPrefix}.${ordinal}.role`);
  const role = TRANSCRIPT_TURN_ROLES.includes(rawRole) && rawRole !== 'unknown' ? rawRole : 'unknown';
  const text = normalizeTurnText(raw.text, `${fieldPrefix}.${ordinal}.text`);
  let identity;
  let turnId;
  if (raw.providerMessageId !== null) {
    if (providerIds.has(raw.providerMessageId)) {
      throw contractError('duplicate_provider_message_id', `${fieldPrefix}.${ordinal}.providerMessageId`);
    }
    providerIds.add(raw.providerMessageId);
    identity = { kind: 'provider', providerMessageId: raw.providerMessageId };
    turnId = `provider:${raw.providerMessageId}`;
  } else {
    const turnContentHash = sha256(canonicalJson({ role, rawRole, text }));
    identity = { kind: 'snapshot-local', ordinal, turnContentHash };
    turnId = `snapshot-local:${ordinal}:${turnContentHash}`;
  }
  return Object.freeze({ turnId, ordinal, identity: Object.freeze(identity), role, rawRole, text });
}

function normalizeNullRawRoleTurn(value, ordinal, identity, providerIds) {
  if (value.role !== 'unknown') {
    throw contractError('normalized_turn_mismatch', `turns.${ordinal}.rawRole`);
  }
  const text = normalizeTurnText(value.text, `turns.${ordinal}.text`);
  if (identity.kind === 'provider') {
    if (providerIds.has(identity.providerMessageId)) {
      throw contractError('duplicate_provider_message_id', `turns.${ordinal}.identity.providerMessageId`);
    }
    providerIds.add(identity.providerMessageId);
  } else {
    const turnContentHash = sha256(canonicalJson({ role: 'unknown', rawRole: null, text }));
    if (identity.turnContentHash !== turnContentHash) {
      throw contractError('normalized_turn_mismatch', `turns.${ordinal}.identity.turnContentHash`);
    }
  }
  return Object.freeze({
    turnId: value.turnId,
    ordinal,
    identity: Object.freeze(identity),
    role: 'unknown',
    rawRole: null,
    text
  });
}

function normalizeRawTurns(rawTurns) {
  const providerIds = new Set();
  return Object.freeze(rawTurns.map((raw, ordinal) => normalizeRawTurn(raw, ordinal, providerIds)));
}

function normalizedTranscript(rawTurns) {
  const turns = normalizeRawTurns(rawTurns);
  const characterCount = turns.reduce((total, turn) => total + turn.text.length, 0);
  const contentHash = sha256(canonicalJson({
    normalizationVersion: TRANSCRIPT_NORMALIZATION_VERSION,
    turns
  }));
  return Object.freeze({
    normalizationVersion: TRANSCRIPT_NORMALIZATION_VERSION,
    turns,
    characterCount,
    contentHash
  });
}

export function normalizeLiveCapture(value) {
  const capture = parseConversationCapture(value);
  if (capture.status !== 'complete') throw contractError('complete_capture_required', 'status');
  return normalizedTranscript(capture.rawTurns);
}

export function normalizeArchiveConversation(value) {
  if (!isRecord(value) || value.status !== 'complete') {
    throw contractError('complete_archive_conversation_required', 'status');
  }
  const rawTurns = parseRawTurns(value.rawTurns, { allowEmpty: false });
  return normalizedTranscript(rawTurns);
}

function parseTurnIdentity(value, ordinal) {
  if (!isRecord(value) || (value.kind !== 'provider' && value.kind !== 'snapshot-local')) {
    throw contractError('invalid_turn_identity', `turns.${ordinal}.identity`);
  }
  if (value.kind === 'provider') {
    assertExactKeys(value, ['kind', 'providerMessageId'], `turns.${ordinal}.identity`);
    return {
      kind: 'provider',
      providerMessageId: parseTranscriptProviderMessageId(
        value.providerMessageId,
        `turns.${ordinal}.identity.providerMessageId`
      )
    };
  }
  assertExactKeys(value, ['kind', 'ordinal', 'turnContentHash'], `turns.${ordinal}.identity`);
  if (assertInteger(value.ordinal, `turns.${ordinal}.identity.ordinal`) !== ordinal) {
    throw contractError('contradictory_ordinal', `turns.${ordinal}.identity.ordinal`);
  }
  return { kind: 'snapshot-local', ordinal, turnContentHash: assertSha256(value.turnContentHash, `turns.${ordinal}.identity.turnContentHash`) };
}

function parseTranscriptTurnWithProviderIds(value, ordinal, providerIds) {
  if (!isRecord(value)) throw contractError('expected_object', `turns.${ordinal}`);
  assertExactKeys(value, TURN_KEYS, `turns.${ordinal}`);
  if (assertInteger(value.ordinal, `turns.${ordinal}.ordinal`) !== ordinal) {
    throw contractError('contradictory_ordinal', `turns.${ordinal}.ordinal`);
  }
  const identity = parseTurnIdentity(value.identity, ordinal);
  const expectedTurnId = identity.kind === 'provider'
    ? `provider:${identity.providerMessageId}`
    : `snapshot-local:${ordinal}:${identity.turnContentHash}`;
  if (value.turnId !== expectedTurnId) throw contractError('turn_id_mismatch', `turns.${ordinal}.turnId`);
  if (!TRANSCRIPT_TURN_ROLES.includes(value.role)) throw contractError('unknown_turn_role', `turns.${ordinal}.role`);
  if ((value.rawRole !== null && typeof value.rawRole !== 'string') || typeof value.text !== 'string') {
    throw contractError('invalid_turn_fields', `turns.${ordinal}`);
  }
  const normalized = value.rawRole === null
    ? normalizeNullRawRoleTurn(value, ordinal, identity, providerIds)
    : normalizeRawTurn({
        ordinal,
        providerMessageId: identity.kind === 'provider' ? identity.providerMessageId : null,
        role: value.rawRole,
        text: value.text
      }, ordinal, providerIds, 'turns');
  if (canonicalJson(normalized) !== canonicalJson(value)) {
    throw contractError('normalized_turn_mismatch', `turns.${ordinal}`);
  }
  return normalized;
}

export function parseTranscriptTurn(value, expectedOrdinal = undefined) {
  if (!isRecord(value)) throw contractError('expected_object', 'turn');
  const ordinal = expectedOrdinal === undefined
    ? assertInteger(value.ordinal, 'turn.ordinal', { max: MAX_TURNS - 1 })
    : assertInteger(expectedOrdinal, 'expectedOrdinal', { max: MAX_TURNS - 1 });
  return parseTranscriptTurnWithProviderIds(value, ordinal, new Set());
}

export function parseNormalizedTranscript(value) {
  if (!isRecord(value)) throw contractError('expected_object', 'normalizedTranscript');
  assertExactKeys(value, NORMALIZED_KEYS, 'normalizedTranscript');
  if (value.normalizationVersion !== TRANSCRIPT_NORMALIZATION_VERSION) {
    throw contractError('unsupported_normalization_version', 'normalizationVersion');
  }
  if (!Array.isArray(value.turns) || value.turns.length === 0 || value.turns.length > MAX_TURNS) {
    throw contractError('invalid_turn_count', 'turns');
  }
  const providerIds = new Set();
  const turns = Object.freeze(Array.from(value.turns, (turn, ordinal) =>
    parseTranscriptTurnWithProviderIds(turn, ordinal, providerIds)));
  const recomputed = Object.freeze({
    normalizationVersion: TRANSCRIPT_NORMALIZATION_VERSION,
    turns,
    characterCount: turns.reduce((total, turn) => total + turn.text.length, 0),
    contentHash: sha256(canonicalJson({
      normalizationVersion: TRANSCRIPT_NORMALIZATION_VERSION,
      turns
    }))
  });
  if (recomputed.characterCount !== value.characterCount) throw contractError('character_count_mismatch', 'characterCount');
  if (recomputed.contentHash !== assertSha256(value.contentHash, 'contentHash')) throw contractError('content_hash_mismatch', 'contentHash');
  if (canonicalJson(recomputed.turns) !== canonicalJson(value.turns)) throw contractError('normalized_turn_mismatch', 'turns');
  return recomputed;
}

export function renderTranscript(value, { startOrdinal = 0, endOrdinal = null, maxChars = null } = {}) {
  const turns = Array.isArray(value?.turns) ? value.turns : [];
  const start = assertInteger(startOrdinal, 'startOrdinal', { max: turns.length });
  const end = endOrdinal === null ? turns.length : assertInteger(endOrdinal, 'endOrdinal', { min: start, max: turns.length });
  for (let ordinal = start; ordinal < end; ordinal += 1) {
    const turn = turns[ordinal];
    if (
      !isRecord(turn) ||
      turn.ordinal !== ordinal ||
      !TRANSCRIPT_TURN_ROLES.includes(turn.role) ||
      typeof turn.text !== 'string' ||
      turn.text.length > TRANSCRIPT_TURN_MAX_TEXT_CHARS ||
      turn.text.includes('\u0000')
    ) {
      throw contractError('invalid_render_turn', `turns.${ordinal}`);
    }
  }
  const labels = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool', unknown: 'Unknown' };
  const text = turns.slice(start, end).map((turn) => `${labels[turn.role] || 'Unknown'}\n${turn.text}`).join('\n\n');
  if (maxChars === null) return text;
  const cap = assertInteger(maxChars, 'maxChars', { min: 1, max: 1_000_000 });
  return text.slice(0, cap);
}

function projectParsedLegacyConversationText(capture, {
  maxChars = 200_000,
  legacyDiagnosticReason = null
} = {}) {
  const cap = assertInteger(Math.floor(Number(maxChars)), 'maxChars', { min: 1, max: 1_000_000 });
  if (legacyDiagnosticReason !== null) {
    const compatibleReasons = STRUCTURED_REASONS_BY_LEGACY_DIAGNOSTIC[legacyDiagnosticReason];
    if (
      capture.status !== 'partial' ||
      !compatibleReasons ||
      !compatibleReasons.includes(capture.reason)
    ) {
      throw contractError('invalid_legacy_diagnostic_reason', 'legacyDiagnosticReason');
    }
  }
  const turns = capture.rawTurns.map((raw, ordinal) => {
    const rawRole = raw.role.trim().toLowerCase();
    return { ordinal, role: TRANSCRIPT_TURN_ROLES.includes(rawRole) ? rawRole : 'unknown', text: normalizeText(raw.text) };
  });
  const fullText = renderTranscript({ turns });
  const clipped = fullText.length > cap;
  let reason = capture.status === 'partial'
    ? legacyDiagnosticReason || LEGACY_REASON_BY_CAPTURE_REASON[capture.reason] || 'conversation_capture_invalid'
    : null;
  if (clipped) reason = 'max_chars';
  // Captures recorded before conversation_leading_turn_missing existed folded an
  // assistant-first head into conversation_top_not_reached. Keep projecting those
  // to the same legacy reason so stored transcripts read the same as fresh ones.
  else if (capture.status === 'partial' && capture.reason === 'conversation_top_not_reached' && turns[0]?.role === 'assistant') {
    reason = 'leading_turn_missing';
  }
  return {
    text: fullText.slice(0, cap),
    complete: capture.status === 'complete' && !clipped,
    truncated: capture.status !== 'complete' || clipped,
    reason,
    messageCount: turns.length,
    scrollPasses: capture.evidence.scrollPasses
  };
}

export function projectLegacyConversationText(value, { maxChars = 200_000 } = {}) {
  return projectParsedLegacyConversationText(parseConversationCapture(value), { maxChars });
}

export function projectLegacyConversationWindowText(value, options = {}) {
  return projectParsedLegacyConversationText(parseConversationCaptureWindow(value), options);
}
