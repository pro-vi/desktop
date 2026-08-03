import crypto from 'node:crypto';

import {
  INITIAL_PREPARED_IMPORT_BATCH_RECORDS,
  MAX_PREPARED_IMPORT_BATCH_RECORDS,
  emptyImportCounts,
  initialImportCursor,
  nextImportCursor,
  parseExportImportOutcome,
  parseIsoDateTime,
  parseOpaqueAccountHint,
  parseRouteVerificationOutcome
} from './conversation-catalog-contract.mjs';
import {
  LIBRARY_LOCAL_ID_PATTERN,
  identityFromOwnedLocation,
  parseConversationIdentity,
  parseProfileScopeId,
  sameConversationIdentity
} from './conversation-identity.mjs';
import {
  locationFromConversationUrl,
  parseChatGptEntryTarget
} from './chatgpt-location.mjs';
import {
  DEFAULT_LIBRARY_MAX_SNAPSHOT_BYTES,
  makeTranscriptSnapshot,
  transcriptSnapshotByteLength
} from './library-blob-store.mjs';
import { normalizeArchiveConversation } from './transcript-contract.mjs';
import { parseTranscriptSourceKey } from './transcript-source-contract.mjs';
import { parseExportGrantId } from './export-import-grants.mjs';

const IMPORT_REQUEST_KEYS = Object.freeze(['grantId', 'profileScopeId']);
const REASSIGN_KEYS = Object.freeze(['importId', 'newProfileScopeId', 'confirm']);
const READER_REJECTION = new Map([
  ['export_not_a_zip', 'not-a-zip'],
  ['export_unsupported_layout', 'unsupported-export'],
  ['export_unsafe_archive', 'unsafe-archive'],
  ['export_corrupt_archive', 'unsafe-archive'],
  ['export_corrupt_json', 'unsafe-archive'],
  ['export_malformed_identity', 'unsafe-archive'],
  ['export_archive_changed', 'unsafe-archive'],
  ['export_scope_mismatch', 'scope-confirmation-required']
]);

function serviceError(code) {
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

function parseSafeId(value, code) {
  if (typeof value !== 'string' || !LIBRARY_LOCAL_ID_PATTERN.test(value)) {
    throw serviceError(code);
  }
  return value;
}

function parseKey(value) {
  try {
    return parseTranscriptSourceKey(value);
  } catch {
    throw serviceError('catalog_verification_key_invalid');
  }
}

function rejected(reason) {
  return parseExportImportOutcome({ status: 'rejected', reason });
}

function rejectionFor(error) {
  const reason = READER_REJECTION.get(String(error?.code || error?.message || ''));
  return reason ? rejected(reason) : null;
}

function assertDependencies(store, blobs, grants, exportReader, routeVerifier) {
  for (const method of [
    'beginImport', 'commitPreparedRecords', 'finishImport', 'interruptImport', 'listImports',
    'verifyRoute', 'observeUnavailable', 'reassignScope', 'list'
  ]) {
    if (typeof store?.[method] !== 'function') throw serviceError('catalog_store_required');
  }
  for (const method of ['putRaw', 'putSnapshot']) {
    if (typeof blobs?.[method] !== 'function') throw serviceError('catalog_blobs_required');
  }
  if (typeof grants?.consume !== 'function' || typeof grants?.close !== 'function') {
    throw serviceError('catalog_grants_required');
  }
  if (typeof exportReader?.inspect !== 'function' || typeof exportReader?.streamConversations !== 'function') {
    throw serviceError('catalog_export_reader_required');
  }
  if (typeof routeVerifier?.verify !== 'function') throw serviceError('catalog_route_verifier_required');
}

function profileHintPort(value) {
  if (value === undefined || value === null) return Object.freeze({ get: async () => null });
  if (typeof value === 'function') return Object.freeze({ get: value });
  if (typeof value.get !== 'function') throw serviceError('catalog_profile_hints_invalid');
  return value;
}

function comparableHint(value) {
  if (value === null || value === undefined) return null;
  try {
    return parseOpaqueAccountHint(value);
  } catch {
    throw serviceError('catalog_profile_hint_invalid');
  }
}

function prepareDecoded(decoded, recordIndex) {
  if (!decoded || (decoded.status !== 'complete' && decoded.status !== 'catalog-only')) {
    throw serviceError('catalog_archive_record_invalid');
  }
  if (!Buffer.isBuffer(decoded.rawRecord) || decoded.rawRecord.length < 1) {
    throw serviceError('catalog_archive_record_invalid');
  }
  if (decoded.status === 'complete') {
    return { decoded, normalized: normalizeArchiveConversation(decoded), problem: null };
  }
  if (!['provider-id-missing', 'active-branch-ambiguous', 'message-graph-invalid', 'unsupported-content'].includes(decoded.reason)) {
    throw serviceError('catalog_archive_record_invalid');
  }
  return {
    decoded,
    normalized: null,
    problem: {
      recordIndex,
      reason: decoded.reason,
      identity: decoded.identity
    }
  };
}

function preparedImportBatchLimit(recordIndex) {
  let limit = INITIAL_PREPARED_IMPORT_BATCH_RECORDS;
  while (limit < MAX_PREPARED_IMPORT_BATCH_RECORDS && recordIndex >= limit) {
    limit *= 2;
  }
  return Math.min(limit, MAX_PREPARED_IMPORT_BATCH_RECORDS);
}

async function validateArchiveRecords(exportReader, archive, profileScopeId) {
  let recordIndex = 0;
  for await (const decoded of exportReader.streamConversations(archive, profileScopeId, initialImportCursor())) {
    const prepared = prepareDecoded(decoded, recordIndex);
    if (decoded.status === 'complete') {
      const rawRecord = {
        kind: 'raw',
        algorithm: 'sha256',
        hash: crypto.createHash('sha256').update(decoded.rawRecord).digest('hex'),
        byteLength: decoded.rawRecord.length
      };
      const snapshot = makeTranscriptSnapshot({
        identity: decoded.identity,
        normalizedTranscript: prepared.normalized,
        origin: {
          kind: 'chatgpt-export',
          importId: 'i'.repeat(256),
          rawRecord,
          branchEvidence: decoded.activeBranchEvidence
        },
        capturedAt: decoded.observedAt
      });
      if (transcriptSnapshotByteLength(snapshot) > DEFAULT_LIBRARY_MAX_SNAPSHOT_BYTES) {
        throw serviceError('export_unsafe_archive');
      }
    }
    recordIndex += 1;
  }
}

export function createConversationCatalogService({
  store,
  blobs,
  grants,
  exportReader,
  routeVerifier,
  profileAccountHints = null,
  onChanged = null,
  clock = () => new Date().toISOString()
} = {}) {
  assertDependencies(store, blobs, grants, exportReader, routeVerifier);
  if (onChanged !== null && typeof onChanged !== 'function') {
    throw serviceError('catalog_change_listener_invalid');
  }
  const accountHints = profileHintPort(profileAccountHints);

  function notifyChanged() {
    if (!onChanged) return;
    try {
      Promise.resolve(onChanged()).catch(() => {});
    } catch {}
  }

  function nowIso() {
    try {
      return parseIsoDateTime(clock(), 'clock');
    } catch {
      throw serviceError('catalog_clock_invalid');
    }
  }

  async function importExport(request) {
    if (!exactKeys(request, IMPORT_REQUEST_KEYS)) throw serviceError('catalog_import_request_invalid');
    let grantId;
    try {
      grantId = parseExportGrantId(request.grantId);
    } catch {
      throw serviceError('catalog_import_grant_invalid');
    }
    const profileScopeId = parseProfileScopeId(request.profileScopeId);
    let archive;
    try {
      archive = await grants.consume(grantId, profileScopeId);
    } catch (error) {
      const rejection = rejectionFor(error);
      if (rejection) return rejection;
      if (String(error?.code || '') === 'export_grant_scope_mismatch') {
        return rejected('scope-confirmation-required');
      }
      throw serviceError('catalog_import_grant_unavailable');
    }
    let catalogImport = null;
    try {
      let manifest;
      try {
        manifest = await exportReader.inspect(archive);
        const localHint = comparableHint(await accountHints.get(profileScopeId));
        const exportHint = comparableHint(manifest.accountHint);
        if (localHint !== null && exportHint !== null && localHint !== exportHint) {
          return rejected('account-hint-conflict');
        }
        await validateArchiveRecords(exportReader, archive, profileScopeId);
      } catch (error) {
        const rejection = rejectionFor(error);
        if (rejection) return rejection;
        throw serviceError('catalog_import_inspection_failed');
      }

      try {
        catalogImport = await store.beginImport(manifest, { profileScopeId, confirmed: true });
        notifyChanged();
      } catch (error) {
        if (String(error?.code || '') === 'catalog_scope_confirmation_required') {
          return rejected('scope-confirmation-required');
        }
        throw error;
      }
      if (catalogImport.status === 'complete') {
        return parseExportImportOutcome({
          status: 'complete',
          importId: catalogImport.id,
          counts: catalogImport.counts
        });
      }

      let cursor = catalogImport.cursor;
      let preparedBatch = [];
      let preparedBatchLimit = preparedImportBatchLimit(cursor.recordIndex);
      const commitBatch = async () => {
        if (preparedBatch.length === 0) return;
        await store.commitPreparedRecords(catalogImport.id, preparedBatch, cursor);
        preparedBatch = [];
        preparedBatchLimit = preparedImportBatchLimit(cursor.recordIndex);
        notifyChanged();
      };
      try {
        for await (const decoded of exportReader.streamConversations(archive, profileScopeId, cursor)) {
          const recordIndex = cursor.recordIndex;
          const prepared = prepareDecoded(decoded, recordIndex);
          const rawRecord = await blobs.putRaw(decoded.rawRecord);
          let importedSnapshot = null;
          if (decoded.status === 'complete') {
            const snapshot = makeTranscriptSnapshot({
              identity: decoded.identity,
              normalizedTranscript: prepared.normalized,
              origin: {
                kind: 'chatgpt-export',
                importId: catalogImport.id,
                rawRecord,
                branchEvidence: decoded.activeBranchEvidence
              },
              capturedAt: decoded.observedAt
            });
            importedSnapshot = await blobs.putSnapshot(snapshot);
          }
          cursor = nextImportCursor(cursor);
          preparedBatch.push({
            identity: decoded.identity,
            title: decoded.title,
            rawRecord,
            importedSnapshot,
            observedAt: decoded.observedAt,
            problem: prepared.problem
          });
          if (preparedBatch.length === preparedBatchLimit) await commitBatch();
        }
        await commitBatch();
      } catch {
        let interrupted = false;
        for (let attempt = 0; attempt < 2 && !interrupted; attempt += 1) {
          interrupted = await store.interruptImport(catalogImport.id).then(() => true, () => false);
        }
        if (!interrupted) throw serviceError('catalog_import_recovery_required');
        notifyChanged();
        throw serviceError('catalog_import_interrupted');
      }

      const current = (await store.listImports()).find(({ id }) => id === catalogImport.id);
      if (!current) throw serviceError('catalog_import_state_missing');
      const outcome = current.counts.problems === 0
        ? parseExportImportOutcome({ status: 'complete', importId: current.id, counts: current.counts })
        : parseExportImportOutcome({
            status: 'partial',
            importId: current.id,
            counts: current.counts,
            problems: current.problems,
            resume: current.cursor
          });
      await store.finishImport(current.id, outcome);
      notifyChanged();
      return outcome;
    } finally {
      // The catalog outcome is already durable. Grant cleanup is one-shot, so
      // never retry or expose a potentially private close error to the caller.
      await grants.close(archive).catch(() => {});
    }
  }

  async function verifyByNavigation(identityValue, keyValue) {
    const identity = parseConversationIdentity(identityValue);
    const key = parseKey(keyValue);
    let outcome;
    try {
      outcome = parseRouteVerificationOutcome(await routeVerifier.verify(identity, key));
    } catch {
      // Route verifiers own provider-state classification and return a closed
      // outcome. An unexpected throw is only a local transport failure; never
      // infer provider state by scanning a potentially private error message.
      return parseRouteVerificationOutcome({ status: 'failed', reason: 'transport' });
    }
    if (outcome.status === 'failed') return outcome;
    if (!sameConversationIdentity(outcome.identity, identity)) {
      throw serviceError('catalog_verification_identity_mismatch');
    }
    if (outcome.status === 'verified') {
      await store.verifyRoute(identity, {
        canonicalUrl: outcome.canonicalUrl,
        verifiedAt: nowIso(),
        evidence: outcome.evidence
      });
      notifyChanged();
    } else {
      await store.observeUnavailable(identity, outcome.observation);
      notifyChanged();
    }
    return outcome;
  }

  async function reassignImportScope(input) {
    if (!exactKeys(input, REASSIGN_KEYS)) throw serviceError('catalog_reassign_request_invalid');
    const outcome = await store.reassignScope(
      parseSafeId(input.importId, 'catalog_import_id_invalid'),
      parseProfileScopeId(input.newProfileScopeId),
      input.confirm
    );
    notifyChanged();
    return outcome;
  }

  async function list(request = {}) {
    return await store.list(request);
  }

  async function listImports() {
    return await store.listImports();
  }

  return Object.freeze({ importExport, verifyByNavigation, reassignImportScope, list, listImports });
}

function failedVerification(reason) {
  return parseRouteVerificationOutcome({ status: 'failed', reason });
}

function unavailableVerification(identity, reason, retryable, observedAt) {
  return parseRouteVerificationOutcome({
    status: 'unavailable',
    identity,
    observation: { observedAt, reason, retryable }
  });
}

export function createChatGptRouteVerifier({
  tabs,
  navigationTimeoutMs = 30_000,
  clock = () => new Date().toISOString(),
  vendorId = 'chatgpt',
  vendorName = 'ChatGPT'
} = {}) {
  if (!tabs || typeof tabs.ensureTab !== 'function' || typeof tabs.getControllerById !== 'function') {
    throw serviceError('catalog_verification_tabs_required');
  }
  if (!Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs < 1 || navigationTimeoutMs > 10 * 60_000) {
    throw serviceError('catalog_verification_timeout_invalid');
  }

  function observedAt() {
    try {
      return parseIsoDateTime(clock(), 'clock');
    } catch {
      throw serviceError('catalog_clock_invalid');
    }
  }

  function failureFrom(error) {
    const code = String(error?.code || '').trim().toLowerCase();
    const kind = String(error?.data?.kind || error?.blockedKind || '').trim().toLowerCase();
    if (
      kind === 'login' ||
      ['login', 'login_required', 'auth_required', 'authentication_required', 'provider_login_required'].includes(code)
    ) {
      return failedVerification('login');
    }
    if (
      ['captcha', 'challenge', 'blocked'].includes(kind) ||
      ['captcha', 'captcha_required', 'challenge', 'challenge_required', 'provider_challenge'].includes(code)
    ) {
      return failedVerification('challenge');
    }
    if (['compatibility_drift', 'invalid_chatgpt_compatibility_map'].includes(code)) {
      return failedVerification('compatibility-drift');
    }
    if (['not_found', 'not-found', 'route_not_found', 'provider_not_found'].includes(code)) return 'not-found';
    if (['forbidden', 'http_403', 'http_403_forbidden', 'route_forbidden', 'provider_forbidden'].includes(code)) {
      return 'forbidden';
    }
    return failedVerification('transport');
  }

  async function verify(identityValue, keyValue) {
    const identity = parseConversationIdentity(identityValue);
    const key = parseKey(keyValue);
    const canonicalUrl = `https://chatgpt.com/c/${identity.providerConversationId}`;
    let controller;
    try {
      const tabId = await tabs.ensureTab({
        key,
        name: 'Catalog verification',
        url: canonicalUrl,
        vendorId,
        vendorName,
        show: false,
        projectUrl: null
      });
      controller = tabs.getControllerById(tabId);
    } catch {
      return failedVerification('transport');
    }
    if (!controller) return failedVerification('transport');
    if (
      typeof controller.runExclusive !== 'function' ||
      typeof controller.prepareChatEntry !== 'function' ||
      typeof controller.inspectConversationRoute !== 'function' ||
      typeof controller.detectChallenge !== 'function' ||
      typeof controller.getUrl !== 'function'
    ) {
      return failedVerification('compatibility-drift');
    }
    return await controller.runExclusive(async () => {
      let expired = false;
      const assertActive = () => {
        if (!expired) return;
        throw serviceError('catalog_verification_timeout');
      };
      const failureOutcome = async (error) => {
        if (expired || error?.code === 'catalog_verification_timeout') {
          return failedVerification('transport');
        }
        if (typeof controller.detectChallenge === 'function') {
          const challenge = await controller.detectChallenge().catch(() => null);
          assertActive();
          if (challenge?.kind === 'login') return failedVerification('login');
          if (challenge?.blocked) return failedVerification('challenge');
        }
        const failure = failureFrom(error);
        if (typeof failure !== 'string') return failure;
        return unavailableVerification(identity, failure, true, observedAt());
      };
      const readExactRoute = async () => {
        const rawUrl = await controller.getUrl();
        assertActive();
        let target;
        try {
          target = parseChatGptEntryTarget(rawUrl);
        } catch {
          return { outcome: unavailableVerification(identity, 'not-found', true, observedAt()) };
        }
        if (!target || target.kind !== 'canonical-conversation') {
          return { outcome: unavailableVerification(identity, 'not-found', true, observedAt()) };
        }
        let observedIdentity;
        try {
          observedIdentity = identityFromOwnedLocation(
            identity.profileScopeId,
            locationFromConversationUrl(target.chatUrl)
          );
        } catch {
          return { outcome: failedVerification('compatibility-drift') };
        }
        if (!sameConversationIdentity(identity, observedIdentity)) {
          return {
            outcome: unavailableVerification(identity, 'foreign-profile', false, observedAt())
          };
        }
        return { target };
      };
      const hasExactKeys = (value, expected) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Object.keys(value).sort();
        return keys.length === expected.length && expected.every((key, index) => keys[index] === key);
      };
      const protectiveFailure = async () => {
        const state = await controller.detectChallenge();
        assertActive();
        if (!state || typeof state !== 'object' || typeof state.blocked !== 'boolean') {
          return failedVerification('compatibility-drift');
        }
        if (!state.blocked) return null;
        return failedVerification(state.kind === 'login' ? 'login' : 'challenge');
      };

      const operation = (async () => {
        try {
          await controller.prepareChatEntry({
            chatUrl: canonicalUrl,
            timeoutMs: navigationTimeoutMs,
            forceNavigation: true
          });
          assertActive();
          const beforeProtection = await protectiveFailure();
          if (beforeProtection) return beforeProtection;
          const before = await readExactRoute();
          if (before.outcome) return before.outcome;

          const observation = await controller.inspectConversationRoute();
          assertActive();
          const afterProtection = await protectiveFailure();
          if (afterProtection) return afterProtection;
          const after = await readExactRoute();
          if (after.outcome) return after.outcome;
          if (before.target.chatUrl !== after.target.chatUrl) {
            return unavailableVerification(identity, 'not-found', true, observedAt());
          }

          if (
            hasExactKeys(observation, ['status', 'visibleTurnCount']) &&
            observation.status === 'served' &&
            Number.isSafeInteger(observation.visibleTurnCount) &&
            observation.visibleTurnCount > 0
          ) {
            return parseRouteVerificationOutcome({
              status: 'verified',
              identity,
              canonicalUrl: after.target.chatUrl,
              evidence: 'direct-navigation'
            });
          }
          if (
            hasExactKeys(observation, ['reason', 'status']) &&
            observation.status === 'unavailable' && observation.reason === 'not-found'
          ) {
            return unavailableVerification(identity, 'not-found', true, observedAt());
          }
          if (
            hasExactKeys(observation, ['reason', 'status']) &&
            observation.status === 'failed' && observation.reason === 'compatibility-drift'
          ) {
            return failedVerification('compatibility-drift');
          }
          return failedVerification('compatibility-drift');
        } catch (error) {
          return await failureOutcome(error);
        }
      })();
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          expired = true;
          resolve(failedVerification('transport'));
        }, navigationTimeoutMs);
      });
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  return Object.freeze({ verify });
}
