import {
  LIBRARY_LOCAL_ID_PATTERN,
  parseChatGptConversationId,
  parseConversationIdentity,
  parseProfileScopeId,
  providerConversationIdFromOwnedLocation,
  sameConversationIdentity
} from './conversation-identity.mjs';
import { locationFromConversationUrl, parseChatGptEntryTarget } from './chatgpt-location.mjs';
import { parseRawRecordRef, parseSnapshotRef } from './library-blob-store.mjs';

export const CONVERSATION_CATALOG_SCHEMA_VERSION = 1;
export const IMPORT_CURSOR_SCHEMA_VERSION = 1;
export const INITIAL_PREPARED_IMPORT_BATCH_RECORDS = 64;
export const MAX_PREPARED_IMPORT_BATCH_RECORDS = 4_096;
export const MAX_CATALOG_IMPORT_PROBLEMS = 10_000;
export const CATALOG_LIST_CURSOR_PATTERN = /^catalog-v1\.[A-Za-z0-9_-]{1,295}$/;
export const CATALOG_IMPORT_PROBLEM_REASONS = Object.freeze([
  'provider-id-missing',
  'active-branch-ambiguous',
  'message-graph-invalid',
  'unsupported-content'
]);
export const CATALOG_UNAVAILABLE_REASONS = Object.freeze([
  'not-found',
  'forbidden',
  'foreign-profile',
  'challenge'
]);

const ROUTE_EVIDENCE = Object.freeze(['tracked-tab', 'direct-navigation']);
const REJECTED_IMPORT_REASONS = Object.freeze([
  'not-a-zip',
  'unsupported-export',
  'unsafe-archive',
  'scope-confirmation-required',
  'account-hint-conflict'
]);
const FAILED_VERIFICATION_REASONS = Object.freeze([
  'login',
  'challenge',
  'transport',
  'compatibility-drift'
]);

function catalogContractError(reason, field = null) {
  const error = new Error(`invalid_catalog_contract:${reason}`);
  error.code = 'invalid_catalog_contract';
  error.data = field ? { field, reason } : { reason };
  return error;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, field) {
  if (!isRecord(value)) throw catalogContractError('expected_object', field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw catalogContractError('unexpected_fields', field);
  }
}

function parseEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw catalogContractError('unknown_variant', field);
  return value;
}

function parseSafeId(value, field) {
  if (typeof value !== 'string' || !LIBRARY_LOCAL_ID_PATTERN.test(value)) {
    throw catalogContractError('invalid_id', field);
  }
  return value;
}

export function parseCatalogListCursor(value, field = 'cursor') {
  if (typeof value !== 'string' || !CATALOG_LIST_CURSOR_PATTERN.test(value)) {
    throw catalogContractError('invalid_cursor', field);
  }
  return value;
}

export function parseSha256(value, field = 'hash') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw catalogContractError('invalid_sha256', field);
  }
  return value;
}

export function parseIsoDateTime(value, field = 'observedAt') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw catalogContractError('invalid_datetime', field);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw catalogContractError('invalid_datetime', field);
  }
  return value;
}

function parseNonNegativeInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw catalogContractError('invalid_integer', field);
  }
  return value;
}

function parseNullableTitle(value, field = 'title') {
  if (value === null) return null;
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 512 ||
    value.trim() !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw catalogContractError('invalid_title', field);
  }
  return value;
}

function parseCanonicalUrl(value, field = 'canonicalUrl') {
  let target;
  try {
    target = parseChatGptEntryTarget(value);
  } catch {
    throw catalogContractError('invalid_conversation_url', field);
  }
  if (!target || target.kind !== 'canonical-conversation') {
    throw catalogContractError('invalid_conversation_url', field);
  }
  return target.chatUrl;
}

export function parseImportCursor(value, field = 'cursor') {
  assertExactKeys(value, ['schemaVersion', 'recordIndex'], field);
  if (value.schemaVersion !== IMPORT_CURSOR_SCHEMA_VERSION) {
    throw catalogContractError('unsupported_cursor_version', `${field}.schemaVersion`);
  }
  return Object.freeze({
    schemaVersion: IMPORT_CURSOR_SCHEMA_VERSION,
    recordIndex: parseNonNegativeInteger(value.recordIndex, `${field}.recordIndex`)
  });
}

export function initialImportCursor() {
  return Object.freeze({ schemaVersion: IMPORT_CURSOR_SCHEMA_VERSION, recordIndex: 0 });
}

export function nextImportCursor(value) {
  const cursor = parseImportCursor(value);
  if (cursor.recordIndex === Number.MAX_SAFE_INTEGER) {
    throw catalogContractError('cursor_overflow', 'cursor.recordIndex');
  }
  return Object.freeze({ schemaVersion: IMPORT_CURSOR_SCHEMA_VERSION, recordIndex: cursor.recordIndex + 1 });
}

export function parseOpaqueAccountHint(value, field = 'accountHint') {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^chatgpt-user-id:sha256:[a-f0-9]{64}$/.test(value)) {
    throw catalogContractError('invalid_account_hint', field);
  }
  return value;
}

export function parseExportManifest(value) {
  assertExactKeys(value, ['archiveHash', 'layout', 'accountHint'], 'manifest');
  return Object.freeze({
    archiveHash: parseSha256(value.archiveHash, 'manifest.archiveHash'),
    layout: parseEnum(
      value.layout,
      ['single-conversations-json', 'numbered-conversations-json'],
      'manifest.layout'
    ),
    accountHint: parseOpaqueAccountHint(value.accountHint, 'manifest.accountHint')
  });
}

export function parseProfileScopeAssignment(value) {
  assertExactKeys(value, ['profileScopeId', 'confirmed'], 'assignment');
  if (value.confirmed !== true) {
    throw catalogContractError('scope_confirmation_required', 'assignment.confirmed');
  }
  return Object.freeze({
    profileScopeId: parseProfileScopeId(value.profileScopeId),
    confirmed: true
  });
}

export function parseCatalogRoute(value, identity = null) {
  if (!isRecord(value)) throw catalogContractError('expected_object', 'route');
  if (value.kind === 'unverified') {
    assertExactKeys(value, ['kind', 'claimedConversationId'], 'route');
    const claimedConversationId = parseChatGptConversationId(value.claimedConversationId);
    if (identity && claimedConversationId !== parseConversationIdentity(identity).providerConversationId) {
      throw catalogContractError('route_identity_mismatch', 'route.claimedConversationId');
    }
    return Object.freeze({ kind: 'unverified', claimedConversationId });
  }
  if (value.kind === 'verified') {
    assertExactKeys(value, ['kind', 'canonicalUrl', 'verifiedAt', 'evidence'], 'route');
    const canonicalUrl = parseCanonicalUrl(value.canonicalUrl, 'route.canonicalUrl');
    const target = parseChatGptEntryTarget(canonicalUrl);
    if (
      identity &&
      providerConversationIdFromOwnedLocation(locationFromConversationUrl(target.chatUrl)) !==
        parseConversationIdentity(identity).providerConversationId
    ) {
      throw catalogContractError('route_identity_mismatch', 'route.canonicalUrl');
    }
    return Object.freeze({
      kind: 'verified',
      canonicalUrl,
      verifiedAt: parseIsoDateTime(value.verifiedAt, 'route.verifiedAt'),
      evidence: parseEnum(value.evidence, ROUTE_EVIDENCE, 'route.evidence')
    });
  }
  if (value.kind === 'temporarily-unavailable') {
    assertExactKeys(value, ['kind', 'previousUrl', 'observedAt', 'reason', 'retryable'], 'route');
    const previousUrl = value.previousUrl === null
      ? null
      : parseCanonicalUrl(value.previousUrl, 'route.previousUrl');
    if (previousUrl && identity) {
      const target = parseChatGptEntryTarget(previousUrl);
      if (
        providerConversationIdFromOwnedLocation(locationFromConversationUrl(target.chatUrl)) !==
        parseConversationIdentity(identity).providerConversationId
      ) {
        throw catalogContractError('route_identity_mismatch', 'route.previousUrl');
      }
    }
    if (typeof value.retryable !== 'boolean') {
      throw catalogContractError('invalid_boolean', 'route.retryable');
    }
    return Object.freeze({
      kind: 'temporarily-unavailable',
      previousUrl,
      observedAt: parseIsoDateTime(value.observedAt, 'route.observedAt'),
      reason: parseEnum(value.reason, CATALOG_UNAVAILABLE_REASONS, 'route.reason'),
      retryable: value.retryable
    });
  }
  throw catalogContractError('unknown_route', 'route.kind');
}

export function parseCatalogConversation(value) {
  assertExactKeys(value, [
    'schemaVersion', 'identity', 'title', 'route', 'firstObservedAt', 'lastObservedAt',
    'latestArchiveRecord', 'latestImportedSnapshot'
  ], 'conversation');
  if (value.schemaVersion !== CONVERSATION_CATALOG_SCHEMA_VERSION) {
    throw catalogContractError('unsupported_catalog_version', 'conversation.schemaVersion');
  }
  const identity = parseConversationIdentity(value.identity);
  const firstObservedAt = parseIsoDateTime(value.firstObservedAt, 'conversation.firstObservedAt');
  const lastObservedAt = parseIsoDateTime(value.lastObservedAt, 'conversation.lastObservedAt');
  if (lastObservedAt < firstObservedAt) {
    throw catalogContractError('observation_order', 'conversation.lastObservedAt');
  }
  return Object.freeze({
    schemaVersion: CONVERSATION_CATALOG_SCHEMA_VERSION,
    identity,
    title: parseNullableTitle(value.title),
    route: parseCatalogRoute(value.route, identity),
    firstObservedAt,
    lastObservedAt,
    latestArchiveRecord: parseRawRecordRef(value.latestArchiveRecord),
    latestImportedSnapshot: value.latestImportedSnapshot === null
      ? null
      : parseSnapshotRef(value.latestImportedSnapshot)
  });
}

export function parseImportProblem(value, field = 'problem') {
  assertExactKeys(value, ['recordIndex', 'reason', 'identity'], field);
  return Object.freeze({
    recordIndex: parseNonNegativeInteger(value.recordIndex, `${field}.recordIndex`),
    reason: parseEnum(value.reason, CATALOG_IMPORT_PROBLEM_REASONS, `${field}.reason`),
    identity: value.identity === null ? null : parseConversationIdentity(value.identity)
  });
}

export function parseImportCounts(value, field = 'counts') {
  assertExactKeys(value, ['recordsSeen', 'cataloged', 'snapshots', 'problems'], field);
  const counts = {
    recordsSeen: parseNonNegativeInteger(value.recordsSeen, `${field}.recordsSeen`),
    cataloged: parseNonNegativeInteger(value.cataloged, `${field}.cataloged`),
    snapshots: parseNonNegativeInteger(value.snapshots, `${field}.snapshots`),
    problems: parseNonNegativeInteger(value.problems, `${field}.problems`)
  };
  if (
    counts.cataloged > counts.recordsSeen || counts.snapshots > counts.cataloged ||
    counts.problems > counts.recordsSeen
  ) {
    throw catalogContractError('contradictory_counts', field);
  }
  return Object.freeze(counts);
}

export function emptyImportCounts() {
  return Object.freeze({ recordsSeen: 0, cataloged: 0, snapshots: 0, problems: 0 });
}

export function parseExportImportOutcome(value) {
  if (!isRecord(value)) throw catalogContractError('expected_object', 'outcome');
  if (value.status === 'complete') {
    assertExactKeys(value, ['status', 'importId', 'counts'], 'outcome');
    const counts = parseImportCounts(value.counts);
    if (counts.problems !== 0) throw catalogContractError('complete_with_problems', 'outcome.counts');
    return Object.freeze({ status: 'complete', importId: parseSafeId(value.importId, 'outcome.importId'), counts });
  }
  if (value.status === 'partial') {
    assertExactKeys(value, ['status', 'importId', 'counts', 'problems', 'resume'], 'outcome');
    const counts = parseImportCounts(value.counts);
    if (
      !Array.isArray(value.problems) || value.problems.length < 1 ||
      value.problems.length > MAX_CATALOG_IMPORT_PROBLEMS
    ) {
      throw catalogContractError('invalid_problems', 'outcome.problems');
    }
    const problems = Object.freeze(Array.from(value.problems, (problem, index) =>
      parseImportProblem(problem, `outcome.problems.${index}`)));
    if (counts.problems !== problems.length) {
      throw catalogContractError('problem_count_mismatch', 'outcome.problems');
    }
    return Object.freeze({
      status: 'partial',
      importId: parseSafeId(value.importId, 'outcome.importId'),
      counts,
      problems,
      resume: parseImportCursor(value.resume, 'outcome.resume')
    });
  }
  if (value.status === 'rejected') {
    assertExactKeys(value, ['status', 'reason'], 'outcome');
    return Object.freeze({
      status: 'rejected',
      reason: parseEnum(value.reason, REJECTED_IMPORT_REASONS, 'outcome.reason')
    });
  }
  throw catalogContractError('unknown_import_status', 'outcome.status');
}

export function parsePreparedArchiveCommit(value) {
  assertExactKeys(value, [
    'identity', 'title', 'rawRecord', 'importedSnapshot', 'observedAt', 'problem'
  ], 'preparedRecord');
  const identity = value.identity === null ? null : parseConversationIdentity(value.identity);
  const importedSnapshot = value.importedSnapshot === null ? null : parseSnapshotRef(value.importedSnapshot);
  const problem = value.problem === null ? null : parseImportProblem(value.problem);
  if (problem) {
    if (importedSnapshot !== null) throw catalogContractError('problem_with_snapshot', 'preparedRecord');
    if (
      (problem.identity === null) !== (identity === null) ||
      (identity && !sameConversationIdentity(problem.identity, identity))
    ) {
      throw catalogContractError('problem_identity_mismatch', 'preparedRecord.problem.identity');
    }
  } else if (identity === null || importedSnapshot === null) {
    throw catalogContractError('complete_record_required', 'preparedRecord');
  }
  return Object.freeze({
    identity,
    title: parseNullableTitle(value.title),
    rawRecord: parseRawRecordRef(value.rawRecord),
    importedSnapshot,
    observedAt: parseIsoDateTime(value.observedAt, 'preparedRecord.observedAt'),
    problem
  });
}

export function parseUnavailableRouteObservation(value, field = 'observation') {
  assertExactKeys(value, ['observedAt', 'reason', 'retryable'], field);
  if (typeof value.retryable !== 'boolean') throw catalogContractError('invalid_boolean', `${field}.retryable`);
  return Object.freeze({
    observedAt: parseIsoDateTime(value.observedAt, `${field}.observedAt`),
    reason: parseEnum(value.reason, CATALOG_UNAVAILABLE_REASONS, `${field}.reason`),
    retryable: value.retryable
  });
}

export function parseVerifiedRoute(value, field = 'verifiedRoute') {
  assertExactKeys(value, ['canonicalUrl', 'verifiedAt', 'evidence'], field);
  return Object.freeze({
    canonicalUrl: parseCanonicalUrl(value.canonicalUrl, `${field}.canonicalUrl`),
    verifiedAt: parseIsoDateTime(value.verifiedAt, `${field}.verifiedAt`),
    evidence: parseEnum(value.evidence, ROUTE_EVIDENCE, `${field}.evidence`)
  });
}

export function parseRouteVerificationOutcome(value) {
  if (!isRecord(value)) throw catalogContractError('expected_object', 'verification');
  if (value.status === 'verified') {
    assertExactKeys(value, ['status', 'identity', 'canonicalUrl', 'evidence'], 'verification');
    const identity = parseConversationIdentity(value.identity);
    const canonicalUrl = parseCanonicalUrl(value.canonicalUrl, 'verification.canonicalUrl');
    const target = parseChatGptEntryTarget(canonicalUrl);
    if (providerConversationIdFromOwnedLocation(locationFromConversationUrl(target.chatUrl)) !== identity.providerConversationId) {
      throw catalogContractError('route_identity_mismatch', 'verification.canonicalUrl');
    }
    if (value.evidence !== 'direct-navigation') {
      throw catalogContractError('unknown_variant', 'verification.evidence');
    }
    return Object.freeze({ status: 'verified', identity, canonicalUrl, evidence: 'direct-navigation' });
  }
  if (value.status === 'unavailable') {
    assertExactKeys(value, ['status', 'identity', 'observation'], 'verification');
    return Object.freeze({
      status: 'unavailable',
      identity: parseConversationIdentity(value.identity),
      observation: parseUnavailableRouteObservation(value.observation, 'verification.observation')
    });
  }
  if (value.status === 'failed') {
    assertExactKeys(value, ['status', 'reason'], 'verification');
    return Object.freeze({
      status: 'failed',
      reason: parseEnum(value.reason, FAILED_VERIFICATION_REASONS, 'verification.reason')
    });
  }
  throw catalogContractError('unknown_verification_status', 'verification.status');
}

export function parseListCatalogRequest(value = {}) {
  const input = value === undefined ? {} : value;
  if (!isRecord(input)) throw catalogContractError('expected_object', 'request');
  const allowed = ['profileScopeId', 'cursor', 'limit'];
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.includes(key))) {
    throw catalogContractError('unexpected_fields', 'request');
  }
  const profileScopeId = input.profileScopeId === undefined ? null : parseProfileScopeId(input.profileScopeId);
  const cursor = input.cursor === undefined || input.cursor === null
    ? null
    : parseCatalogListCursor(input.cursor, 'request.cursor');
  const limit = input.limit === undefined
    ? 50
    : parseNonNegativeInteger(input.limit, 'request.limit', 100);
  if (limit < 1) throw catalogContractError('invalid_integer', 'request.limit');
  return Object.freeze({ profileScopeId, cursor, limit });
}

export function parseCatalogPage(value) {
  assertExactKeys(value, ['items', 'nextCursor'], 'page');
  if (!Array.isArray(value.items) || value.items.length > 100) {
    throw catalogContractError('invalid_items', 'page.items');
  }
  return Object.freeze({
    items: Object.freeze(Array.from(value.items, parseCatalogConversation)),
    nextCursor: value.nextCursor === null ? null : parseCatalogListCursor(value.nextCursor, 'page.nextCursor')
  });
}
