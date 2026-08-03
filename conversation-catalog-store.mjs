import crypto from 'node:crypto';
import path from 'node:path';

import {
  CONVERSATION_CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_IMPORT_RECORDS,
  MAX_PREPARED_IMPORT_BATCH_RECORDS,
  emptyImportCounts,
  initialImportCursor,
  parseCatalogListCursor,
  parseCatalogConversation,
  parseCatalogRoute,
  parseCatalogTitle,
  parseExportImportOutcome,
  parseExportManifest,
  parseImportCapacity,
  parseImportCursor,
  parseImportProblem,
  parseIsoDateTime,
  parseListCatalogRequest,
  parsePreparedArchiveCommit,
  parseProfileScopeAssignment,
  parseUnavailableRouteObservation,
  parseVerifiedRoute
} from './conversation-catalog-contract.mjs';
import {
  LIBRARY_LOCAL_ID_PATTERN,
  formatConversationIdentity,
  parseConversationIdentity,
  parseProfileScopeId,
  providerConversationIdFromOwnedLocation,
  sameConversationIdentity
} from './conversation-identity.mjs';
import { locationFromConversationUrl, parseChatGptEntryTarget } from './chatgpt-location.mjs';
import { parseRawRecordRef, parseSnapshotRef } from './library-blob-store.mjs';
import { privateFileSystem } from './private-filesystem.mjs';

export const CONVERSATION_CATALOG_STORE_SCHEMA_VERSION = 2;
const LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION = 1;
export const MAX_CONVERSATION_CATALOG_STATE_BYTES = 64 * 1024 * 1024;
const STATE_KEYS = Object.freeze(['schemaVersion', 'revision', 'imports', 'records', 'routeHistories']);
const IMPORT_KEYS = Object.freeze([
  'schemaVersion', 'id', 'manifest', 'assignment', 'capacity', 'readOnlyReason', 'status', 'cursor', 'suspension',
  'createdAt', 'updatedAt'
]);
const LEGACY_IMPORT_KEYS = Object.freeze(IMPORT_KEYS.filter((key) =>
  key !== 'capacity' && key !== 'readOnlyReason'));
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'importId', 'recordIndex', 'identity', 'title', 'rawRecord',
  'importedSnapshot', 'observedAt', 'problem'
]);
const ROUTE_HISTORY_KEYS = Object.freeze(['schemaVersion', 'identity', 'observations']);
const SUSPENSION_KEYS = Object.freeze(['reason', 'observedAt']);
// The latest route and most recent verified URL drive current behavior. Retaining
// 256 semantic transitions leaves ample local diagnostic history while bounding
// one repeatedly verified identity to tens of kilobytes. The parser keeps the
// original V0 ceiling so an existing large history can load and compact on its
// next mutation.
const MAX_RETAINED_ROUTE_OBSERVATIONS = 256;
const MAX_LEGACY_ROUTE_OBSERVATIONS = 100_000;

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
  if (!exactKeys(value, keys)) throw storeError('catalog_store_corrupt_state');
}

function parseSafeId(value) {
  if (typeof value !== 'string' || !LIBRARY_LOCAL_ID_PATTERN.test(value)) {
    throw storeError('catalog_store_corrupt_state');
  }
  return value;
}

function parseNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw storeError('catalog_store_corrupt_state');
  return value;
}

function parseContract(parse, value, corruptCode = 'catalog_store_corrupt_state') {
  try {
    return parse(value);
  } catch {
    throw storeError(corruptCode);
  }
}

function parseStoredTitle(value, sourceSchemaVersion) {
  if (sourceSchemaVersion !== LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION) {
    return parseContract(parseCatalogTitle, value);
  }
  if (value === null) return null;
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 512 || value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw storeError('catalog_store_corrupt_state');
  }
  try {
    return parseCatalogTitle(value);
  } catch {
    // V1 admitted ill-formed UTF-16 in this optional display field. Keep the
    // immutable raw record and exact identity, but do not carry malformed text
    // into the stricter V2 catalog projection.
    return null;
  }
}

function parseSuspension(value) {
  if (value === null) return null;
  requireExact(value, SUSPENSION_KEYS);
  if (!['interrupted', 'scope-reassigned'].includes(value.reason)) {
    throw storeError('catalog_store_corrupt_state');
  }
  return {
    reason: value.reason,
    observedAt: parseContract((candidate) => parseIsoDateTime(candidate, 'suspension.observedAt'), value.observedAt)
  };
}

function parseReadOnlyReason(value) {
  if (value === null || value === 'legacy-record-limit') return value;
  throw storeError('catalog_store_corrupt_state');
}

function parseImport(value, sourceSchemaVersion = CONVERSATION_CATALOG_STORE_SCHEMA_VERSION) {
  requireExact(value, sourceSchemaVersion === LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION
    ? LEGACY_IMPORT_KEYS
    : IMPORT_KEYS);
  if (value.schemaVersion !== sourceSchemaVersion) {
    throw storeError('catalog_store_schema_unsupported');
  }
  if (!['open', 'partial', 'complete'].includes(value.status)) {
    throw storeError('catalog_store_corrupt_state');
  }
  const createdAt = parseContract((candidate) => parseIsoDateTime(candidate, 'createdAt'), value.createdAt);
  const updatedAt = parseContract((candidate) => parseIsoDateTime(candidate, 'updatedAt'), value.updatedAt);
  if (updatedAt < createdAt) throw storeError('catalog_store_corrupt_state');
  const suspension = parseSuspension(value.suspension);
  if (value.status === 'complete' && suspension !== null) throw storeError('catalog_store_corrupt_state');
  const capacity = sourceSchemaVersion === LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION || value.capacity === null
    ? null
    : parseContract(parseImportCapacity, value.capacity);
  const readOnlyReason = sourceSchemaVersion === LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION
    ? null
    : parseReadOnlyReason(value.readOnlyReason);
  if (
    readOnlyReason !== null &&
    (capacity !== null || !['partial', 'complete'].includes(value.status) || suspension !== null)
  ) {
    throw storeError('catalog_store_corrupt_state');
  }
  return {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    id: parseSafeId(value.id),
    manifest: parseContract(parseExportManifest, value.manifest),
    assignment: parseContract(parseProfileScopeAssignment, value.assignment),
    capacity,
    readOnlyReason,
    status: value.status,
    cursor: parseContract(parseImportCursor, value.cursor),
    suspension,
    createdAt,
    updatedAt
  };
}

function parseStoredRecord(value, sourceSchemaVersion = CONVERSATION_CATALOG_STORE_SCHEMA_VERSION) {
  requireExact(value, RECORD_KEYS);
  if (value.schemaVersion !== sourceSchemaVersion) {
    throw storeError('catalog_store_schema_unsupported');
  }
  const identity = value.identity === null
    ? null
    : parseContract(parseConversationIdentity, value.identity);
  const problem = value.problem === null
    ? null
    : parseContract(parseImportProblem, value.problem);
  const importedSnapshot = value.importedSnapshot === null
    ? null
    : parseContract(parseSnapshotRef, value.importedSnapshot);
  if (problem && importedSnapshot) throw storeError('catalog_store_corrupt_state');
  if (!problem && !identity) throw storeError('catalog_store_corrupt_state');
  const recordIndex = parseNonNegativeInteger(value.recordIndex);
  if (problem && problem.recordIndex !== recordIndex) throw storeError('catalog_store_corrupt_state');
  if (
    problem && ((identity === null) !== (problem.identity === null) ||
      (identity && !sameConversationIdentity(identity, problem.identity)))
  ) {
    throw storeError('catalog_store_corrupt_state');
  }
  return {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    importId: parseSafeId(value.importId),
    recordIndex,
    identity,
    title: parseStoredTitle(value.title, sourceSchemaVersion),
    rawRecord: parseContract(parseRawRecordRef, value.rawRecord),
    importedSnapshot,
    observedAt: parseContract((candidate) => parseIsoDateTime(candidate, 'observedAt'), value.observedAt),
    problem
  };
}

function parseRouteHistory(value, sourceSchemaVersion = CONVERSATION_CATALOG_STORE_SCHEMA_VERSION) {
  requireExact(value, ROUTE_HISTORY_KEYS);
  if (value.schemaVersion !== sourceSchemaVersion) {
    throw storeError('catalog_store_schema_unsupported');
  }
  const identity = parseContract(parseConversationIdentity, value.identity);
  if (
    !Array.isArray(value.observations) || value.observations.length < 1 ||
    value.observations.length > MAX_LEGACY_ROUTE_OBSERVATIONS
  ) {
    throw storeError('catalog_store_corrupt_state');
  }
  const observations = value.observations.map((observation) =>
    parseContract((candidate) => parseCatalogRoute(candidate, identity), observation));
  if (observations.some(({ kind }) => kind === 'unverified')) throw storeError('catalog_store_corrupt_state');
  return {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    identity,
    observations
  };
}

function parseState(value) {
  requireExact(value, STATE_KEYS);
  const sourceSchemaVersion = value.schemaVersion;
  if (
    sourceSchemaVersion !== CONVERSATION_CATALOG_STORE_SCHEMA_VERSION &&
    sourceSchemaVersion !== LEGACY_CONVERSATION_CATALOG_STORE_SCHEMA_VERSION
  ) {
    throw storeError('catalog_store_schema_unsupported');
  }
  if (!Array.isArray(value.imports) || !Array.isArray(value.records) || !Array.isArray(value.routeHistories)) {
    throw storeError('catalog_store_corrupt_state');
  }
  const revision = parseNonNegativeInteger(value.revision);
  const imports = value.imports.map((entry) => parseImport(entry, sourceSchemaVersion));
  const records = value.records.map((entry) => parseStoredRecord(entry, sourceSchemaVersion));
  const routeHistories = value.routeHistories.map((entry) => parseRouteHistory(entry, sourceSchemaVersion));
  if (
    new Set(imports.map(({ id }) => id)).size !== imports.length ||
    new Set(imports.map(({ manifest }) => manifest.archiveHash)).size !== imports.length ||
    new Set(records.map(({ importId, recordIndex }) => `${importId}:${recordIndex}`)).size !== records.length ||
    new Set(routeHistories.map(({ identity }) => formatConversationIdentity(identity))).size !== routeHistories.length
  ) {
    throw storeError('catalog_store_corrupt_state');
  }
  const importsById = new Map(imports.map((entry) => [entry.id, entry]));
  for (const record of records) {
    const catalogImport = importsById.get(record.importId);
    if (!catalogImport) throw storeError('catalog_store_corrupt_state');
    if (record.identity && record.identity.profileScopeId !== catalogImport.assignment.profileScopeId) {
      throw storeError('catalog_store_corrupt_state');
    }
  }
  const recordsByImportId = new Map(imports.map(({ id }) => [id, []]));
  for (const record of records) recordsByImportId.get(record.importId).push(record);
  for (const catalogImport of imports) {
    const importRecords = recordsByImportId.get(catalogImport.id)
      .sort((left, right) => left.recordIndex - right.recordIndex);
    if (importRecords.some((record, index) => record.recordIndex !== index)) {
      throw storeError('catalog_store_corrupt_state');
    }
    if (catalogImport.cursor.recordIndex > importRecords.length) {
      throw storeError('catalog_store_corrupt_state');
    }
    if (
      catalogImport.capacity !== null &&
      (
        importRecords.length > catalogImport.capacity.recordCount ||
        (
          catalogImport.status !== 'open' && catalogImport.suspension === null &&
          importRecords.length !== catalogImport.capacity.recordCount
        )
      )
    ) {
      throw storeError('catalog_store_corrupt_state');
    }
    if (
      catalogImport.status === 'complete' &&
      (
        catalogImport.cursor.recordIndex !== importRecords.length ||
        importRecords.some(({ problem, importedSnapshot }) => problem !== null || importedSnapshot === null)
      )
    ) {
      throw storeError('catalog_store_corrupt_state');
    }
    if (importRecords.some((record) =>
      record.problem === null && record.importedSnapshot === null && record.recordIndex < catalogImport.cursor.recordIndex)) {
      throw storeError('catalog_store_corrupt_state');
    }
  }
  return {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    revision,
    imports,
    records,
    routeHistories
  };
}

function emptyState() {
  return {
    schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
    revision: 0,
    imports: [],
    records: [],
    routeHistories: []
  };
}

function terminalImportProjection(state) {
  let openCount = 0;
  const recordCountsByImport = new Map();
  for (const { importId } of state.records) {
    recordCountsByImport.set(importId, (recordCountsByImport.get(importId) ?? 0) + 1);
  }
  const imports = state.imports.map((catalogImport) => {
    if (catalogImport.status !== 'open') return catalogImport;
    openCount += 1;
    return {
      ...catalogImport,
      status: 'partial',
      readOnlyReason: catalogImport.capacity === null &&
        (recordCountsByImport.get(catalogImport.id) ?? 0) > MAX_CATALOG_IMPORT_RECORDS
        ? 'legacy-record-limit'
        : null,
      suspension: catalogImport.capacity === null &&
          (recordCountsByImport.get(catalogImport.id) ?? 0) > MAX_CATALOG_IMPORT_RECORDS
        ? null
        : { reason: 'interrupted', observedAt: catalogImport.updatedAt }
    };
  });
  if (state.revision > Number.MAX_SAFE_INTEGER - openCount) {
    throw storeError('catalog_store_size_limit');
  }
  return { ...state, revision: state.revision + openCount, imports };
}

function encodeState(state) {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
}

function encodeCompactState(state) {
  return Buffer.from(`${JSON.stringify(state)}\n`);
}

function minimumEncodedStateByteLength(state) {
  return encodeCompactState(state).length;
}

function encodeStateWithinLimit(state, maxBytes) {
  const readable = encodeState(state);
  if (readable.length <= maxBytes) return readable;
  const compact = encodeCompactState(state);
  return compact.length <= maxBytes ? compact : null;
}

// Capacity is reserved against the largest metadata shape the closed catalog
// contract accepts. The contribution calculation uses the same pretty-JSON
// encoder as persistence and takes the larger first/subsequent array element.
// A fixed cushion makes small schema-neutral formatting changes fail safe.
const IMPORT_CAPACITY_ENCODING_CUSHION_BYTES = 64 * 1024;
const MAX_CAPACITY_IDENTITY = Object.freeze({
  provider: 'chatgpt',
  profileScopeId: 's'.repeat(128),
  providerConversationId: 'c'.repeat(256)
});
const MAX_CAPACITY_RAW_REF = Object.freeze({
  kind: 'raw',
  algorithm: 'sha256',
  hash: 'a'.repeat(64),
  byteLength: Number.MAX_SAFE_INTEGER
});
const MAX_CAPACITY_IMPORT_ID = 'i'.repeat(256);
const MAX_CAPACITY_RECORD_BASE = Object.freeze({
  schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
  importId: MAX_CAPACITY_IMPORT_ID,
  recordIndex: MAX_CATALOG_IMPORT_RECORDS - 1,
  identity: MAX_CAPACITY_IDENTITY,
  title: '界'.repeat(512),
  rawRecord: MAX_CAPACITY_RAW_REF,
  observedAt: '9999-12-31T23:59:59.999Z'
});

function maximumArrayElementContribution(field, value) {
  const baseline = { ...emptyState(), revision: Number.MAX_SAFE_INTEGER };
  const once = { ...baseline, [field]: [value] };
  const twice = { ...baseline, [field]: [value, value] };
  return Math.max(
    encodeState(once).length - encodeState(baseline).length,
    encodeState(twice).length - encodeState(once).length
  );
}

const MAX_PROBLEM_RECORD_CAPACITY_BYTES = maximumArrayElementContribution('records', {
  ...MAX_CAPACITY_RECORD_BASE,
  importedSnapshot: null,
  problem: {
    recordIndex: MAX_CATALOG_IMPORT_RECORDS - 1,
    reason: 'active-branch-ambiguous',
    identity: MAX_CAPACITY_IDENTITY
  }
});
const MAX_IMPORT_ROW_CAPACITY_BYTES = maximumArrayElementContribution('imports', {
  schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
  id: MAX_CAPACITY_IMPORT_ID,
  manifest: {
    archiveHash: 'd'.repeat(64),
    layout: 'numbered-conversations-json',
    accountHint: `chatgpt-user-id:sha256:${'e'.repeat(64)}`
  },
  assignment: { profileScopeId: 's'.repeat(128), confirmed: true },
  capacity: { recordCount: MAX_CATALOG_IMPORT_RECORDS },
  readOnlyReason: null,
  status: 'partial',
  cursor: { schemaVersion: 1, recordIndex: MAX_CATALOG_IMPORT_RECORDS },
  suspension: { reason: 'scope-reassigned', observedAt: '9999-12-31T23:59:59.999Z' },
  createdAt: '9999-12-31T23:59:59.999Z',
  updatedAt: '9999-12-31T23:59:59.999Z'
});

function importCapacityUpperBound(capacity) {
  return MAX_IMPORT_ROW_CAPACITY_BYTES + IMPORT_CAPACITY_ENCODING_CUSHION_BYTES +
    (capacity.recordCount * MAX_PROBLEM_RECORD_CAPACITY_BYTES);
}

function hasActiveCapacityReservation(catalogImport) {
  return catalogImport.capacity !== null &&
    (catalogImport.status === 'open' || catalogImport.suspension !== null);
}

function capacityProjectionByteLength(state) {
  const activeImports = state.imports.filter(hasActiveCapacityReservation);
  if (activeImports.length === 0) return minimumEncodedStateByteLength(state);
  const activeIds = new Set(activeImports.map(({ id }) => id));
  const unreservedState = {
    ...state,
    imports: state.imports.filter(({ id }) => !activeIds.has(id)),
    records: state.records.filter(({ importId }) => !activeIds.has(importId))
  };
  return minimumEncodedStateByteLength(unreservedState) + activeImports.reduce(
    (total, catalogImport) => total + importCapacityUpperBound(catalogImport.capacity),
    0
  );
}

function recordCounts(records) {
  const counts = { recordsSeen: 0, cataloged: 0, snapshots: 0, problems: 0 };
  for (const record of records) {
    counts.recordsSeen += 1;
    if (record.identity !== null) counts.cataloged += 1;
    if (record.importedSnapshot !== null) counts.snapshots += 1;
    if (record.problem !== null) counts.problems += 1;
  }
  return counts;
}

function recordsForImport(state, importId) {
  return state.records
    .filter((record) => record.importId === importId)
    .sort((left, right) => left.recordIndex - right.recordIndex);
}

function isOverLimitLegacyImport(state, catalogImport) {
  return catalogImport.capacity === null &&
    recordsForImport(state, catalogImport.id).length > MAX_CATALOG_IMPORT_RECORDS;
}

function publicImport(catalogImport, records) {
  const readOnlyReason = catalogImport.readOnlyReason ?? (
    catalogImport.capacity === null && records.length > MAX_CATALOG_IMPORT_RECORDS
      ? 'legacy-record-limit'
      : null
  );
  return {
    schemaVersion: catalogImport.schemaVersion,
    id: catalogImport.id,
    manifest: clone(catalogImport.manifest),
    assignment: clone(catalogImport.assignment),
    readOnlyReason,
    status: catalogImport.status,
    cursor: clone(catalogImport.cursor),
    counts: recordCounts(records),
    problems: records.filter(({ problem }) => problem !== null).map(({ problem }) => clone(problem)),
    suspension: clone(catalogImport.suspension),
    createdAt: catalogImport.createdAt,
    updatedAt: catalogImport.updatedAt
  };
}

function rawRefEqual(left, right) {
  return left.kind === right.kind && left.algorithm === right.algorithm &&
    left.hash === right.hash && left.byteLength === right.byteLength;
}

function snapshotRefEqual(left, right) {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.algorithm === right.algorithm && left.hash === right.hash &&
    left.contentHash === right.contentHash && left.byteLength === right.byteLength;
}

function recordEquivalent(left, right) {
  return left.importId === right.importId && left.recordIndex === right.recordIndex &&
    ((left.identity === null && right.identity === null) ||
      (left.identity && right.identity && sameConversationIdentity(left.identity, right.identity))) &&
    left.title === right.title && rawRefEqual(left.rawRecord, right.rawRecord) &&
    snapshotRefEqual(left.importedSnapshot, right.importedSnapshot) &&
    left.observedAt === right.observedAt && JSON.stringify(left.problem) === JSON.stringify(right.problem);
}

function replacementEquivalent(left, right) {
  const leftProvider = left.identity?.providerConversationId ?? null;
  const rightProvider = right.identity?.providerConversationId ?? null;
  return leftProvider === rightProvider && left.title === right.title &&
    rawRefEqual(left.rawRecord, right.rawRecord) && left.observedAt === right.observedAt &&
    left.problem?.reason === right.problem?.reason &&
    (left.problem === null) === (right.problem === null);
}

function candidateOrder(left, right, refField) {
  return right.observedAt.localeCompare(left.observedAt) ||
    String(left[refField]?.hash || '').localeCompare(String(right[refField]?.hash || '')) ||
    left.importId.localeCompare(right.importId) || left.recordIndex - right.recordIndex;
}

function identityRecords(state, identity) {
  return state.records.filter((record) =>
    record.identity && sameConversationIdentity(record.identity, identity));
}

function routeHistoryFor(state, identity) {
  return state.routeHistories.find((history) => sameConversationIdentity(history.identity, identity)) || null;
}

function sameRouteObservationSemantics(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'verified') {
    return left.canonicalUrl === right.canonicalUrl && left.evidence === right.evidence;
  }
  if (left.kind === 'temporarily-unavailable') {
    return left.previousUrl === right.previousUrl && left.reason === right.reason && left.retryable === right.retryable;
  }
  return false;
}

function appendRouteObservation(observations, observation) {
  const previous = observations.at(-1) || null;
  const next = previous && sameRouteObservationSemantics(previous, observation)
    ? [...observations.slice(0, -1), observation]
    : [...observations, observation];
  return next.slice(-MAX_RETAINED_ROUTE_OBSERVATIONS);
}

function compactRouteHistories(state) {
  let changed = false;
  const routeHistories = state.routeHistories.map((history) => {
    if (history.observations.length <= MAX_RETAINED_ROUTE_OBSERVATIONS) return history;
    changed = true;
    return {
      ...history,
      observations: history.observations.slice(-MAX_RETAINED_ROUTE_OBSERVATIONS)
    };
  });
  return changed ? { ...state, routeHistories } : state;
}

function mostRecentVerifiedUrl(history) {
  const verified = history?.observations.slice().reverse().find(({ kind }) => kind === 'verified');
  if (verified) return verified.canonicalUrl;
  const carried = history?.observations.slice().reverse()
    .find(({ kind, previousUrl }) => kind === 'temporarily-unavailable' && previousUrl !== null);
  return carried?.previousUrl || null;
}

function projectConversationFromRecords(records, identity, history = null) {
  if (!records.length) return null;
  const byLatestRaw = records.slice().sort((left, right) => candidateOrder(left, right, 'rawRecord'));
  const latestRecord = byLatestRaw[0];
  const snapshots = records.filter(({ importedSnapshot }) => importedSnapshot !== null)
    .sort((left, right) => candidateOrder(left, right, 'importedSnapshot'));
  const route = history?.observations.at(-1) || {
    kind: 'unverified',
    claimedConversationId: identity.providerConversationId
  };
  return parseContract(parseCatalogConversation, {
    schemaVersion: CONVERSATION_CATALOG_SCHEMA_VERSION,
    identity,
    title: latestRecord.title,
    route,
    firstObservedAt: records.reduce((earliest, record) =>
      record.observedAt < earliest ? record.observedAt : earliest, records[0].observedAt),
    lastObservedAt: records.reduce((latest, record) =>
      record.observedAt > latest ? record.observedAt : latest, records[0].observedAt),
    latestArchiveRecord: latestRecord.rawRecord,
    latestImportedSnapshot: snapshots[0]?.importedSnapshot || null
  });
}

function projectConversation(state, identity) {
  return projectConversationFromRecords(
    identityRecords(state, identity),
    identity,
    routeHistoryFor(state, identity)
  );
}

function allProjectedConversations(state) {
  const recordsByIdentity = new Map();
  for (const record of state.records) {
    if (!record.identity) continue;
    const key = formatConversationIdentity(record.identity);
    const grouped = recordsByIdentity.get(key);
    if (grouped) grouped.records.push(record);
    else recordsByIdentity.set(key, { identity: record.identity, records: [record] });
  }
  const historiesByIdentity = new Map(state.routeHistories.map((history) => [
    formatConversationIdentity(history.identity),
    history
  ]));
  return Array.from(recordsByIdentity, ([key, grouped]) =>
    projectConversationFromRecords(grouped.records, grouped.identity, historiesByIdentity.get(key) || null));
}

function compareProjectedConversations(left, right) {
  return right.lastObservedAt.localeCompare(left.lastObservedAt) ||
    formatConversationIdentity(left.identity).localeCompare(formatConversationIdentity(right.identity));
}

function encodeListCursor({ revision, offset, profileScopeId }) {
  const body = Buffer.from(JSON.stringify({ schemaVersion: 1, revision, offset, profileScopeId })).toString('base64url');
  return parseCatalogListCursor(`catalog-v1.${body}`);
}

function decodeListCursor(value) {
  if (typeof value !== 'string' || !value.startsWith('catalog-v1.')) throw storeError('catalog_cursor_mismatch');
  let parsed;
  try {
    const encoded = value.slice('catalog-v1.'.length);
    if (!encoded || Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) throw new Error();
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw storeError('catalog_cursor_mismatch');
  }
  if (!exactKeys(parsed, ['schemaVersion', 'revision', 'offset', 'profileScopeId']) || parsed.schemaVersion !== 1) {
    throw storeError('catalog_cursor_mismatch');
  }
  if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0 ||
      !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
      (parsed.profileScopeId !== null && typeof parsed.profileScopeId !== 'string')) {
    throw storeError('catalog_cursor_mismatch');
  }
  return parsed;
}

export function createConversationCatalogStore({
  stateDir,
  blobs,
  fileSystem = privateFileSystem,
  clock = () => new Date().toISOString(),
  randomId = crypto.randomUUID,
  maxStateBytes = MAX_CONVERSATION_CATALOG_STATE_BYTES
} = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw storeError('catalog_store_state_dir_required');
  }
  if (
    !blobs || typeof blobs.getRaw !== 'function' || typeof blobs.getSnapshot !== 'function' ||
    typeof blobs.putSnapshot !== 'function'
  ) {
    throw storeError('catalog_store_blobs_required');
  }
  if (
    !Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1 ||
    maxStateBytes > MAX_CONVERSATION_CATALOG_STATE_BYTES
  ) {
    throw storeError('catalog_store_size_limit_invalid');
  }
  const root = path.join(stateDir, 'transcript-library', 'catalog');
  const filePath = path.join(root, 'state.json');
  let durableState = emptyState();
  let loadPromise = null;
  let reloadPromise = null;
  let queue = Promise.resolve();
  let writeUncertain = false;
  let catalogProjectionCache = null;

  function installDurableState(state) {
    durableState = state;
    catalogProjectionCache = null;
  }

  function nowIso() {
    try {
      return parseIsoDateTime(clock(), 'clock');
    } catch {
      throw storeError('catalog_store_clock_invalid');
    }
  }

  function projectedConversations(profileScopeId) {
    if (!catalogProjectionCache || catalogProjectionCache.revision !== durableState.revision) {
      catalogProjectionCache = {
        revision: durableState.revision,
        all: Object.freeze(allProjectedConversations(durableState).sort(compareProjectedConversations)),
        byScope: new Map()
      };
    }
    if (profileScopeId === null) return catalogProjectionCache.all;
    const cached = catalogProjectionCache.byScope.get(profileScopeId);
    if (cached) return cached;
    const scoped = Object.freeze(catalogProjectionCache.all.filter(({ identity }) =>
      identity.profileScopeId === profileScopeId));
    catalogProjectionCache.byScope.set(profileScopeId, scoped);
    return scoped;
  }

  async function loadOnce() {
    try {
      await fileSystem.ensurePrivateDirectory(root, { boundaryPath: stateDir });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('private_')) {
        throw storeError('catalog_store_corrupt_state');
      }
      throw storeError('catalog_store_io');
    }
    let kind;
    try {
      kind = await fileSystem.pathKind(filePath, { boundaryPath: stateDir });
    } catch {
      throw storeError('catalog_store_io');
    }
    if (kind === 'missing') {
      installDurableState(emptyState());
      return;
    }
    if (kind !== 'file') throw storeError('catalog_store_corrupt_state');
    let bytes;
    try {
      bytes = await fileSystem.readPrivateFile(filePath, { maxBytes: maxStateBytes, boundaryPath: stateDir });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('private_')) {
        throw storeError('catalog_store_corrupt_state');
      }
      throw storeError('catalog_store_io');
    }
    let raw;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      throw storeError('catalog_store_corrupt_state');
    }
    try {
      const parsed = parseState(raw);
      if (capacityProjectionByteLength(parsed) > maxStateBytes) {
        throw storeError('catalog_store_corrupt_state');
      }
      installDurableState(parsed);
    } catch (error) {
      if (error?.code === 'catalog_store_schema_unsupported') throw error;
      throw storeError('catalog_store_corrupt_state');
    }
  }

  async function reloadAfterUncertainWrite() {
    if (reloadPromise === null) {
      loadPromise = null;
      const reloading = (async () => {
        try {
          await fileSystem.settleReplacement(filePath, { boundaryPath: stateDir });
          await loadOnce();
          writeUncertain = false;
          loadPromise = Promise.resolve();
        } catch {
          loadPromise = null;
          throw storeError('catalog_store_reload_required');
        }
      })();
      const shared = reloading.finally(() => {
        if (reloadPromise === shared) reloadPromise = null;
      });
      reloadPromise = shared;
    }
    await reloadPromise;
  }

  async function ensureLoaded() {
    if (writeUncertain || reloadPromise !== null) {
      await reloadAfterUncertainWrite();
    }
    if (!loadPromise) {
      let guarded;
      guarded = loadOnce().catch((error) => {
        if (error?.code === 'catalog_store_io' && loadPromise === guarded) loadPromise = null;
        throw error;
      });
      loadPromise = guarded;
    }
    await loadPromise;
  }

  async function load() {
    await ensureLoaded();
    return clone(durableState);
  }

  function enqueue(operation) {
    const next = queue.catch(() => {}).then(async () => {
      await ensureLoaded();
      if (writeUncertain) throw storeError('catalog_store_reload_required');
      return await operation();
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function persist(candidate) {
    const parsed = compactRouteHistories(parseState({ ...candidate, revision: durableState.revision + 1 }));
    const bytes = encodeStateWithinLimit(parsed, maxStateBytes);
    if (bytes === null) throw storeError('catalog_store_size_limit');
    if (capacityProjectionByteLength(parsed) > maxStateBytes) throw storeError('catalog_store_size_limit');
    const terminalProjection = terminalImportProjection(parsed);
    const terminalBytes = encodeStateWithinLimit(terminalProjection, maxStateBytes);
    if (terminalBytes === null) throw storeError('catalog_store_size_limit');
    if (capacityProjectionByteLength(terminalProjection) > maxStateBytes) {
      throw storeError('catalog_store_size_limit');
    }
    try {
      await fileSystem.replaceFile(filePath, bytes, { boundaryPath: stateDir });
    } catch (error) {
      if (error?.code !== 'private_replace_not_applied') writeUncertain = true;
      throw storeError('catalog_store_io');
    }
    installDurableState(parsed);
    return parsed;
  }

  async function beginImport(manifestValue, assignmentValue, capacityValue) {
    let manifest;
    let assignment;
    let capacity;
    try {
      manifest = parseExportManifest(manifestValue);
      assignment = parseProfileScopeAssignment(assignmentValue);
      capacity = parseImportCapacity(capacityValue);
    } catch {
      throw storeError('catalog_import_invalid');
    }
    return await enqueue(async () => {
      const existingIndex = durableState.imports.findIndex((entry) =>
        entry.manifest.archiveHash === manifest.archiveHash);
      if (existingIndex >= 0) {
        const existing = durableState.imports[existingIndex];
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) {
          throw storeError('catalog_import_manifest_conflict');
        }
        if (existing.assignment.profileScopeId !== assignment.profileScopeId) {
          throw storeError('catalog_scope_confirmation_required');
        }
        if (existing.capacity !== null && existing.capacity.recordCount !== capacity.recordCount) {
          throw storeError('catalog_import_manifest_conflict');
        }
        if (existing.status === 'open') throw storeError('catalog_import_active');
        if (existing.status === 'complete' || existing.suspension === null) {
          return publicImport(existing, recordsForImport(durableState, existing.id));
        }
        const records = recordsForImport(durableState, existing.id);
        if (
          existing.cursor.recordIndex > capacity.recordCount ||
          records.length > capacity.recordCount
        ) {
          throw storeError('catalog_import_manifest_conflict');
        }
        const imports = durableState.imports.slice();
        imports[existingIndex] = {
          ...existing,
          capacity,
          status: 'open',
          suspension: null,
          updatedAt: nowIso()
        };
        const persisted = await persist({ ...durableState, imports });
        const reopened = persisted.imports[existingIndex];
        return publicImport(reopened, recordsForImport(persisted, reopened.id));
      }
      const now = nowIso();
      const catalogImport = parseImport({
        schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
        id: `import-${randomId()}`,
        manifest,
        assignment,
        capacity,
        readOnlyReason: null,
        status: 'open',
        cursor: initialImportCursor(),
        suspension: null,
        createdAt: now,
        updatedAt: now
      });
      const persisted = await persist({ ...durableState, imports: [...durableState.imports, catalogImport] });
      return publicImport(catalogImport, recordsForImport(persisted, catalogImport.id));
    });
  }

  async function validatePreparedBlobs(importId, prepared) {
    try {
      await blobs.getRaw(prepared.rawRecord);
    } catch {
      throw storeError('catalog_raw_blob_invalid');
    }
    if (prepared.importedSnapshot === null) return null;
    let snapshot;
    try {
      snapshot = await blobs.getSnapshot(prepared.importedSnapshot);
    } catch {
      throw storeError('catalog_snapshot_blob_invalid');
    }
    if (
      !prepared.identity || !sameConversationIdentity(snapshot.identity, prepared.identity) ||
      snapshot.origin.kind !== 'chatgpt-export' || snapshot.origin.importId !== importId ||
      !rawRefEqual(snapshot.origin.rawRecord, prepared.rawRecord) ||
      snapshot.capturedAt !== prepared.observedAt
    ) {
      throw storeError('catalog_snapshot_mismatch');
    }
    return snapshot;
  }

  async function commitPreparedRecords(importIdValue, recordValues, nextCursorValue) {
    const importId = parseSafeId(importIdValue);
    let preparedRecords;
    let nextCursor;
    try {
      if (
        !Array.isArray(recordValues) || recordValues.length < 1 ||
        recordValues.length > MAX_PREPARED_IMPORT_BATCH_RECORDS
      ) {
        throw new Error('invalid batch');
      }
      preparedRecords = recordValues.map(parsePreparedArchiveCommit);
      nextCursor = parseImportCursor(nextCursorValue);
    } catch {
      throw storeError('catalog_batch_invalid');
    }
    for (const prepared of preparedRecords) await validatePreparedBlobs(importId, prepared);
    return await enqueue(async () => {
      const importIndex = durableState.imports.findIndex(({ id }) => id === importId);
      if (importIndex < 0) throw storeError('catalog_import_not_found');
      const catalogImport = durableState.imports[importIndex];
      const currentIndex = catalogImport.cursor.recordIndex;
      if (catalogImport.capacity === null) throw storeError('catalog_import_capacity_required');
      if (nextCursor.recordIndex > catalogImport.capacity.recordCount) {
        throw storeError('catalog_import_cursor_mismatch');
      }
      const firstRecordIndex = nextCursor.recordIndex - preparedRecords.length;
      if (firstRecordIndex < 0) throw storeError('catalog_import_cursor_mismatch');
      const candidates = preparedRecords.map((prepared, offset) => {
        const recordIndex = firstRecordIndex + offset;
        if (prepared.problem && prepared.problem.recordIndex !== recordIndex) {
          throw storeError('catalog_record_index_mismatch');
        }
        return parseStoredRecord({
          schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
          importId,
          recordIndex,
          identity: prepared.identity,
          title: prepared.title,
          rawRecord: prepared.rawRecord,
          importedSnapshot: prepared.importedSnapshot,
          observedAt: prepared.observedAt,
          problem: prepared.problem
        });
      });
      const existingByIndex = new Map(recordsForImport(durableState, importId)
        .map((record) => [record.recordIndex, record]));
      if (nextCursor.recordIndex <= currentIndex) {
        if (candidates.every((candidate) => {
          const existing = existingByIndex.get(candidate.recordIndex);
          return existing && recordEquivalent(existing, candidate);
        })) {
          return { importId, cursor: clone(catalogImport.cursor), changed: false, counts: recordCounts(recordsForImport(durableState, importId)) };
        }
        throw storeError('catalog_import_replay_conflict');
      }
      if (catalogImport.status !== 'open') throw storeError('catalog_import_not_open');
      if (firstRecordIndex !== currentIndex) {
        throw storeError('catalog_import_cursor_mismatch');
      }
      const records = durableState.records.slice();
      const durableRecordIndexes = new Map(durableState.records.map((record, index) => [record, index]));
      for (const candidate of candidates) {
        const existing = existingByIndex.get(candidate.recordIndex);
        if (existing) {
          if (!replacementEquivalent(existing, candidate)) throw storeError('catalog_import_replay_conflict');
          const recordIndex = durableRecordIndexes.get(existing);
          if (recordIndex === undefined) throw storeError('catalog_store_corrupt_state');
          records[recordIndex] = candidate;
        } else {
          records.push(candidate);
        }
      }
      const now = nowIso();
      const imports = durableState.imports.slice();
      imports[importIndex] = { ...catalogImport, cursor: nextCursor, updatedAt: now };
      const persisted = await persist({ ...durableState, imports, records });
      return {
        importId,
        cursor: clone(nextCursor),
        changed: true,
        counts: recordCounts(recordsForImport(persisted, importId))
      };
    });
  }

  async function finishImport(importIdValue, outcomeValue) {
    const importId = parseSafeId(importIdValue);
    let outcome;
    try {
      outcome = parseExportImportOutcome(outcomeValue);
    } catch {
      throw storeError('catalog_import_outcome_invalid');
    }
    if (outcome.status === 'rejected' || outcome.importId !== importId) {
      throw storeError('catalog_import_outcome_invalid');
    }
    return await enqueue(async () => {
      const importIndex = durableState.imports.findIndex(({ id }) => id === importId);
      if (importIndex < 0) throw storeError('catalog_import_not_found');
      const catalogImport = durableState.imports[importIndex];
      const records = recordsForImport(durableState, importId);
      const counts = recordCounts(records);
      if (catalogImport.capacity === null) throw storeError('catalog_import_capacity_required');
      if (
        JSON.stringify(outcome.counts) !== JSON.stringify(counts) ||
        catalogImport.cursor.recordIndex !== catalogImport.capacity.recordCount ||
        records.length !== catalogImport.capacity.recordCount ||
        (outcome.status === 'partial' && (
          JSON.stringify(outcome.problems) !== JSON.stringify(records.filter(({ problem }) => problem).map(({ problem }) => problem)) ||
          JSON.stringify(outcome.resume) !== JSON.stringify(catalogImport.cursor)
        )) ||
        (outcome.status === 'complete' && (
          counts.problems !== 0 || catalogImport.cursor.recordIndex !== records.length ||
          records.some(({ importedSnapshot }) => importedSnapshot === null)
        ))
      ) {
        throw storeError('catalog_import_outcome_mismatch');
      }
      if (catalogImport.status === outcome.status) {
        return publicImport(catalogImport, records);
      }
      if (catalogImport.status !== 'open') throw storeError('catalog_import_not_open');
      const imports = durableState.imports.slice();
      imports[importIndex] = {
        ...catalogImport,
        status: outcome.status,
        suspension: null,
        updatedAt: nowIso()
      };
      const persisted = await persist({ ...durableState, imports });
      return publicImport(persisted.imports[importIndex], recordsForImport(persisted, importId));
    });
  }

  async function recoverInterruptedImports() {
    return await enqueue(async () => {
      const recoverable = durableState.imports.filter((catalogImport) =>
        catalogImport.status === 'open' ||
        (
          catalogImport.status === 'partial' && catalogImport.suspension !== null &&
          isOverLimitLegacyImport(durableState, catalogImport)
        ));
      if (!recoverable.length) return [];
      const observedAt = nowIso();
      const recoverableIds = new Set(recoverable.map(({ id }) => id));
      const imports = durableState.imports.map((catalogImport) => recoverableIds.has(catalogImport.id)
        ? {
            ...catalogImport,
            status: 'partial',
            readOnlyReason: isOverLimitLegacyImport(durableState, catalogImport)
              ? 'legacy-record-limit'
              : null,
            suspension: isOverLimitLegacyImport(durableState, catalogImport)
              ? null
              : { reason: 'interrupted', observedAt },
            updatedAt: observedAt
          }
        : catalogImport);
      const persisted = await persist({ ...durableState, imports });
      return persisted.imports.filter(({ id }) => recoverableIds.has(id))
        .map((catalogImport) => publicImport(catalogImport, recordsForImport(persisted, catalogImport.id)));
    });
  }

  async function interruptImport(importIdValue) {
    const importId = parseSafeId(importIdValue);
    return await enqueue(async () => {
      const importIndex = durableState.imports.findIndex(({ id }) => id === importId);
      if (importIndex < 0) throw storeError('catalog_import_not_found');
      const catalogImport = durableState.imports[importIndex];
      const records = recordsForImport(durableState, importId);
      if (catalogImport.status !== 'open') return publicImport(catalogImport, records);
      const observedAt = nowIso();
      const imports = durableState.imports.slice();
      imports[importIndex] = {
        ...catalogImport,
        status: 'partial',
        readOnlyReason: isOverLimitLegacyImport(durableState, catalogImport)
          ? 'legacy-record-limit'
          : null,
        suspension: isOverLimitLegacyImport(durableState, catalogImport)
          ? null
          : { reason: 'interrupted', observedAt },
        updatedAt: observedAt
      };
      const persisted = await persist({ ...durableState, imports });
      return publicImport(persisted.imports[importIndex], recordsForImport(persisted, importId));
    });
  }

  async function terminalizeLegacyOverLimit(manifestValue, profileScopeIdValue) {
    let manifest;
    let profileScopeId;
    try {
      manifest = parseExportManifest(manifestValue);
      profileScopeId = parseProfileScopeId(profileScopeIdValue);
    } catch {
      throw storeError('catalog_import_invalid');
    }
    return await enqueue(async () => {
      const importIndex = durableState.imports.findIndex(({ manifest: stored }) =>
        stored.archiveHash === manifest.archiveHash);
      if (importIndex < 0) return null;
      const catalogImport = durableState.imports[importIndex];
      if (
        catalogImport.capacity !== null ||
        catalogImport.assignment.profileScopeId !== profileScopeId ||
        JSON.stringify(catalogImport.manifest) !== JSON.stringify(manifest)
      ) {
        return null;
      }
      const records = recordsForImport(durableState, catalogImport.id);
      if (catalogImport.readOnlyReason === 'legacy-record-limit') {
        return publicImport(catalogImport, records);
      }
      const imports = durableState.imports.slice();
      imports[importIndex] = {
        ...catalogImport,
        status: catalogImport.status === 'complete' ? 'complete' : 'partial',
        readOnlyReason: 'legacy-record-limit',
        suspension: null,
        updatedAt: nowIso()
      };
      const persisted = await persist({ ...durableState, imports });
      return publicImport(
        persisted.imports[importIndex],
        recordsForImport(persisted, catalogImport.id)
      );
    });
  }

  async function latestImportedSnapshot(identityValue) {
    await ensureLoaded();
    const identity = parseConversationIdentity(identityValue);
    const snapshots = identityRecords(durableState, identity)
      .filter(({ importedSnapshot }) => importedSnapshot !== null)
      .sort((left, right) => candidateOrder(left, right, 'importedSnapshot'));
    return snapshots[0] ? clone(snapshots[0].importedSnapshot) : null;
  }

  async function hasIdentity(identityValue) {
    await ensureLoaded();
    const identity = parseConversationIdentity(identityValue);
    return identityRecords(durableState, identity).length > 0;
  }

  async function get(identityValue) {
    await ensureLoaded();
    const identity = parseConversationIdentity(identityValue);
    const projected = projectConversation(durableState, identity);
    if (!projected) throw storeError('catalog_conversation_not_found');
    return clone(projected);
  }

  async function list(requestValue = {}) {
    await ensureLoaded();
    const request = parseListCatalogRequest(requestValue);
    let offset = 0;
    if (request.cursor !== null) {
      const cursor = decodeListCursor(request.cursor);
      if (cursor.revision !== durableState.revision || cursor.profileScopeId !== request.profileScopeId) {
        throw storeError('catalog_cursor_mismatch');
      }
      offset = cursor.offset;
    }
    const conversations = projectedConversations(request.profileScopeId);
    if (offset > conversations.length) throw storeError('catalog_cursor_mismatch');
    const items = conversations.slice(offset, offset + request.limit).map(clone);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < conversations.length
        ? encodeListCursor({ revision: durableState.revision, offset: nextOffset, profileScopeId: request.profileScopeId })
        : null
    };
  }

  async function listImports() {
    await ensureLoaded();
    const recordsByImportId = new Map(durableState.imports.map(({ id }) => [id, []]));
    for (const record of durableState.records) recordsByImportId.get(record.importId)?.push(record);
    return durableState.imports.slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map((catalogImport) => publicImport(catalogImport, recordsByImportId.get(catalogImport.id)));
  }

  async function verifyRoute(identityValue, resultValue) {
    const identity = parseConversationIdentity(identityValue);
    let result;
    try {
      result = parseVerifiedRoute(resultValue);
    } catch {
      throw storeError('catalog_route_invalid');
    }
    const target = parseChatGptEntryTarget(result.canonicalUrl);
    if (providerConversationIdFromOwnedLocation(locationFromConversationUrl(target.chatUrl)) !== identity.providerConversationId) {
      throw storeError('catalog_route_identity_mismatch');
    }
    return await enqueue(async () => {
      if (!identityRecords(durableState, identity).length) throw storeError('catalog_conversation_not_found');
      const observation = parseCatalogRoute({ kind: 'verified', ...result }, identity);
      const historyIndex = durableState.routeHistories.findIndex((history) =>
        sameConversationIdentity(history.identity, identity));
      const histories = durableState.routeHistories.slice();
      if (historyIndex >= 0) {
        const history = histories[historyIndex];
        histories[historyIndex] = {
          ...history,
          observations: appendRouteObservation(history.observations, observation)
        };
      } else {
        histories.push({
          schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
          identity,
          observations: [observation]
        });
      }
      const persisted = await persist({ ...durableState, routeHistories: histories });
      return clone(projectConversation(persisted, identity));
    });
  }

  async function observeUnavailable(identityValue, resultValue) {
    const identity = parseConversationIdentity(identityValue);
    let result;
    try {
      result = parseUnavailableRouteObservation(resultValue);
    } catch {
      throw storeError('catalog_route_invalid');
    }
    return await enqueue(async () => {
      if (!identityRecords(durableState, identity).length) throw storeError('catalog_conversation_not_found');
      const historyIndex = durableState.routeHistories.findIndex((history) =>
        sameConversationIdentity(history.identity, identity));
      const current = historyIndex >= 0 ? durableState.routeHistories[historyIndex] : null;
      const previousUrl = mostRecentVerifiedUrl(current);
      const observation = parseCatalogRoute({
        kind: 'temporarily-unavailable',
        previousUrl,
        ...result
      }, identity);
      const histories = durableState.routeHistories.slice();
      if (current) {
        histories[historyIndex] = {
          ...current,
          observations: appendRouteObservation(current.observations, observation)
        };
      } else {
        histories.push({
          schemaVersion: CONVERSATION_CATALOG_STORE_SCHEMA_VERSION,
          identity,
          observations: [observation]
        });
      }
      const persisted = await persist({ ...durableState, routeHistories: histories });
      return clone(projectConversation(persisted, identity));
    });
  }

  async function reassignScope(importIdValue, newScopeValue, confirm) {
    const importId = parseSafeId(importIdValue);
    let newScope;
    try {
      newScope = parseProfileScopeId(newScopeValue);
    } catch {
      throw storeError('catalog_scope_invalid');
    }
    if (confirm !== true) throw storeError('catalog_scope_confirmation_required');
    return await enqueue(async () => {
      const importIndex = durableState.imports.findIndex(({ id }) => id === importId);
      if (importIndex < 0) throw storeError('catalog_import_not_found');
      const catalogImport = durableState.imports[importIndex];
      if (catalogImport.status === 'open') throw storeError('catalog_import_active');
      if (catalogImport.assignment.profileScopeId === newScope) {
        return {
          importId,
          changed: false,
          previousProfileScopeId: newScope,
          profileScopeId: newScope,
          cursor: clone(catalogImport.cursor)
        };
      }
      const ownRecords = recordsForImport(durableState, importId);
      if (
        (catalogImport.readOnlyReason !== null) ||
        (catalogImport.capacity === null &&
        (catalogImport.suspension !== null || ownRecords.length > MAX_CATALOG_IMPORT_RECORDS)
        )
      ) {
        throw storeError('catalog_import_capacity_required');
      }
      const capacity = catalogImport.capacity ?? { recordCount: ownRecords.length };
      const previousKeys = new Set(ownRecords.filter(({ identity }) => identity).map(({ identity }) =>
        formatConversationIdentity(identity)));
      const targetKeys = new Set(ownRecords.filter(({ identity }) => identity).map(({ identity }) =>
        formatConversationIdentity({ ...identity, profileScopeId: newScope })));
      if (durableState.records.some((record) =>
        record.importId !== importId && record.identity && targetKeys.has(formatConversationIdentity(record.identity)))) {
        throw storeError('catalog_scope_conflict');
      }
      const now = nowIso();
      const records = durableState.records.map((record) => {
        if (record.importId !== importId) return record;
        const identity = record.identity ? { ...record.identity, profileScopeId: newScope } : null;
        const problem = record.problem
          ? { ...record.problem, identity: identity ? clone(identity) : null }
          : null;
        return { ...record, identity, importedSnapshot: null, problem };
      });
      const retainedRecordKeys = new Set(records.filter(({ identity }) => identity).map(({ identity }) =>
        formatConversationIdentity(identity)));
      const routeHistories = durableState.routeHistories.filter((history) => {
        const key = formatConversationIdentity(history.identity);
        if (targetKeys.has(key)) return false;
        return !previousKeys.has(key) || retainedRecordKeys.has(key);
      });
      const imports = durableState.imports.slice();
      imports[importIndex] = {
        ...catalogImport,
        assignment: { profileScopeId: newScope, confirmed: true },
        capacity,
        readOnlyReason: null,
        status: 'partial',
        cursor: initialImportCursor(),
        suspension: { reason: 'scope-reassigned', observedAt: now },
        updatedAt: now
      };
      const persisted = await persist({ ...durableState, imports, records, routeHistories });
      return {
        importId,
        changed: true,
        previousProfileScopeId: catalogImport.assignment.profileScopeId,
        profileScopeId: newScope,
        cursor: clone(persisted.imports[importIndex].cursor)
      };
    });
  }

  return Object.freeze({
    load,
    beginImport,
    commitPreparedRecords,
    finishImport,
    recoverInterruptedImports,
    interruptImport,
    terminalizeLegacyOverLimit,
    verifyRoute,
    observeUnavailable,
    reassignScope,
    list,
    listImports,
    get,
    latestImportedSnapshot,
    hasIdentity,
    root,
    statePath: filePath
  });
}
