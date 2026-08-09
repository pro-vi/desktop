import crypto from 'node:crypto';
import {
  identityFromOwnedLocation,
  sameConversationIdentity
} from './conversation-identity.mjs';
import {
  conversationUrlForLocation,
  locationFromConversationUrl,
  projectUrlForLocation
} from './chatgpt-location.mjs';
import { makeTranscriptSnapshot } from './library-blob-store.mjs';
import {
  normalizeLiveCapture,
  parseConversationCapture
} from './transcript-contract.mjs';

const TRACK_KEYS = Object.freeze(['label', 'tags', 'key', 'identity', 'location']);
const TRANSPORT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EPROTO',
  'ETIMEDOUT',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET'
]);
const LOGIN_CODES = new Set(['authentication_required', 'login_required', 'not_authenticated']);
const CHALLENGE_CODES = new Set(['captcha_required', 'challenge_required', 'protective_challenge']);
const TAB_CODES = new Set(['page_closed', 'tab_closed', 'tab_not_found', 'target_closed']);
const COMPATIBILITY_CODES = new Set([
  'compatibility_drift',
  'transcript_capture_identity_mismatch',
  'transcript_capture_route_mismatch',
  'invalid_provider_conversation_id'
]);
const NAVIGATION_CODES = new Set([
  'invalid_chatgpt_url',
  'key_vendor_mismatch',
  'max_tabs_reached',
  'navigation_failed',
  'tab_busy',
  'timeout_waiting_for_prompt'
]);
const PRECOMMIT_SNAPSHOT_CODES = new Set([
  'transcript_snapshot_content_hash_mismatch',
  'transcript_snapshot_identity_mismatch',
  'transcript_snapshot_origin_mismatch'
]);

function syncError(code) {
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

function failureReason(error) {
  const explicitCode = String(error?.code || '').trim();
  const message = String(error?.message || '').trim();
  const code = (explicitCode || (
    LOGIN_CODES.has(message) ||
    CHALLENGE_CODES.has(message) ||
    TAB_CODES.has(message) ||
    COMPATIBILITY_CODES.has(message) ||
    NAVIGATION_CODES.has(message)
      ? message
      : ''
  )).toLowerCase();
  const blockedKind = String(error?.data?.kind || error?.blockedKind || '').trim().toLowerCase();
  if (blockedKind === 'login' || LOGIN_CODES.has(code)) return 'login';
  if (['captcha', 'challenge', 'blocked'].includes(blockedKind) || CHALLENGE_CODES.has(code)) return 'challenge';
  if (TAB_CODES.has(code)) return 'tab_closed';
  if (TRANSPORT_CODES.has(code.toUpperCase()) || ['provider_transport', 'browser_transport', 'cdp_disconnected'].includes(code)) {
    return 'provider_transport';
  }
  if (COMPATIBILITY_CODES.has(code)) return 'compatibility_drift';
  if (NAVIGATION_CODES.has(code)) return 'navigation_failed';
  return 'capture_failed';
}

function capturePortFailure(error, phase) {
  const explicitCode = String(error?.code || '');
  if (['transcript_capture_identity_mismatch', 'transcript_capture_route_mismatch'].includes(explicitCode)) {
    return syncError(explicitCode);
  }
  const reason = failureReason(error);
  if (reason !== 'capture_failed') {
    const codeForReason = {
      login: 'login_required',
      challenge: 'challenge_required',
      tab_closed: 'tab_closed',
      navigation_failed: 'navigation_failed',
      provider_transport: 'provider_transport',
      compatibility_drift: 'compatibility_drift'
    };
    return syncError(codeForReason[reason]);
  }
  return syncError(phase === 'navigation' || phase === 'tab' ? 'navigation_failed' : 'capture_failed');
}

function isProvablyPrecommitSnapshotFailure(error) {
  const code = String(error?.code || error?.message || '');
  return code.startsWith('library_blob_') || PRECOMMIT_SNAPSHOT_CODES.has(code);
}

function tabClosedAfterFailure(tabs, tabId) {
  try {
    tabs.getControllerById(tabId);
    return false;
  } catch (error) {
    return failureReason(error) === 'tab_closed';
  }
}

function assertCapturePort(value) {
  if (!value || typeof value.captureOwnedSource !== 'function') {
    throw syncError('transcript_capture_port_required');
  }
  return value;
}

function assertServiceDependencies(store, blobs) {
  for (const method of [
    'register', 'list', 'getSource', 'beginAttempt', 'commitComplete', 'finishIncomplete', 'forget'
  ]) {
    if (typeof store?.[method] !== 'function') throw syncError('transcript_store_required');
  }
  if (typeof blobs?.putSnapshot !== 'function') throw syncError('transcript_blobs_required');
}

export function createChatGptTranscriptCapture({
  tabs,
  providerTabOperations,
  maxCaptureBytes = 4 * 1024 * 1024,
  navigationTimeoutMs = 30_000,
  vendorId = 'chatgpt',
  vendorName = 'ChatGPT'
} = {}) {
  if (
    !tabs ||
    typeof tabs.ensureTab !== 'function' ||
    typeof tabs.getControllerById !== 'function'
  ) {
    throw syncError('transcript_tabs_required');
  }
  const captureLimit = Math.floor(Number(maxCaptureBytes));
  if (!Number.isSafeInteger(captureLimit) || captureLimit < 1 || captureLimit > 16 * 1024 * 1024) {
    throw syncError('transcript_capture_limit_invalid');
  }
  const timeoutMs = Math.floor(Number(navigationTimeoutMs));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw syncError('transcript_navigation_timeout_invalid');
  }
  const operationScopes = providerTabOperations;
  if (
    !operationScopes ||
    typeof operationScopes.currentOwnerId !== 'function' ||
    typeof operationScopes.reserve !== 'function' ||
    typeof operationScopes.release !== 'function'
  ) {
    throw syncError('transcript_tab_operations_required');
  }

  async function captureOwnedSource(source) {
    const conversationUrl = conversationUrlForLocation(source?.target?.location);
    if (!conversationUrl || !source?.identity || !source?.key) {
      throw syncError('transcript_capture_source_invalid');
    }
    const ownerId = operationScopes.currentOwnerId() || crypto.randomUUID();
    const operation = {
      id: ownerId,
      kind: 'transcript-sync',
      key: source.key,
      source: 'transcript-library',
      phase: 'resolving_tab',
      startedAt: Date.now()
    };
    const acquiredScopes = [];
    const reserveScope = (scope) => {
      if (!scope || acquiredScopes.includes(scope)) return;
      if (operationScopes.reserve(scope, operation)) acquiredScopes.push(scope);
    };
    let tabId = null;
    let controller = null;
    try {
      try {
        reserveScope(`key:${source.key}`);
        const existingTabId = (tabs.listTabs?.() || []).find((tab) => tab?.key === source.key)?.id || null;
        if (existingTabId) reserveScope(`tab:${existingTabId}`);
        tabId = await tabs.ensureTab({
          key: source.key,
          name: source.label,
          url: conversationUrl,
          vendorId,
          vendorName,
          show: false,
          projectUrl: projectUrlForLocation(source.target.location)
        });
        reserveScope(`tab:${tabId}`);
        controller = tabs.getControllerById(tabId);
      } catch (error) {
        throw capturePortFailure(error, 'tab');
      }
      if (
        !controller ||
        typeof controller.runExclusive !== 'function' ||
        typeof controller.prepareChatEntry !== 'function' ||
        typeof controller.captureConversation !== 'function'
      ) {
        throw syncError('transcript_capture_controller_invalid');
      }
      try {
        return await controller.runExclusive(async () => {
          try {
            await controller.prepareChatEntry({ chatUrl: conversationUrl, timeoutMs });
          } catch (error) {
            throw capturePortFailure(error, 'navigation');
          }
          try {
            const capture = parseConversationCapture(
              await controller.captureConversation({ maxCaptureBytes: captureLimit })
            );
            if (capture.conversationUrl !== null) {
              const observedIdentity = identityFromOwnedLocation(
                source.identity.profileScopeId,
                locationFromConversationUrl(capture.conversationUrl)
              );
              if (!sameConversationIdentity(observedIdentity, source.identity)) {
                throw syncError('transcript_capture_identity_mismatch');
              }
            }
            return capture;
          } catch (error) {
            throw capturePortFailure(error, 'capture');
          }
        });
      } catch (error) {
        if (tabClosedAfterFailure(tabs, tabId)) throw syncError('tab_closed');
        throw capturePortFailure(error, 'capture');
      }
    } finally {
      for (const scope of acquiredScopes.reverse()) operationScopes.release(scope, ownerId);
    }
  }

  return Object.freeze({ captureOwnedSource });
}

export function createTranscriptSyncService({
  store,
  blobs,
  capture,
  onChanged = null,
  providerTabOperations
} = {}) {
  assertServiceDependencies(store, blobs);
  const capturePort = assertCapturePort(capture);
  if (onChanged !== null && typeof onChanged !== 'function') {
    throw syncError('transcript_change_listener_invalid');
  }
  const operationScopes = providerTabOperations;
  if (
    !operationScopes ||
    typeof operationScopes.currentOwnerId !== 'function' ||
    typeof operationScopes.reserve !== 'function' ||
    typeof operationScopes.release !== 'function' ||
    typeof operationScopes.runWithOwner !== 'function'
  ) {
    throw syncError('transcript_tab_operations_required');
  }

  function notifyChanged() {
    if (!onChanged) return;
    try {
      Promise.resolve(onChanged()).catch(() => {});
    } catch {}
  }

  async function changedAfter(operation) {
    const result = await operation;
    notifyChanged();
    return result;
  }

  async function track(input) {
    if (!exactKeys(input, TRACK_KEYS)) throw syncError('transcript_track_invalid');
    return await changedAfter(store.register({
      label: input.label,
      tags: input.tags,
      key: input.key,
      identity: input.identity,
      target: { kind: 'owned-conversation', location: input.location }
    }));
  }

  async function syncOwnedSource(source, trigger) {
    const attempt = await changedAfter(store.beginAttempt(source.id, trigger));
    let captured;
    try {
      captured = parseConversationCapture(await capturePort.captureOwnedSource(source));
    } catch (error) {
      return await changedAfter(store.finishIncomplete(attempt.id, {
        kind: 'failed',
        reason: failureReason(error)
      }));
    }
    if (captured.status === 'partial') {
      return await changedAfter(store.finishIncomplete(attempt.id, {
        kind: 'partial',
        reason: captured.reason
      }));
    }

    let normalized;
    let snapshot;
    try {
      normalized = normalizeLiveCapture(captured);
      snapshot = makeTranscriptSnapshot({
        identity: source.identity,
        normalizedTranscript: normalized,
        origin: {
          kind: 'live-capture',
          conversationUrl: captured.conversationUrl,
          captureEvidence: captured.evidence
        },
        capturedAt: captured.capturedAt
      });
    } catch {
      return await changedAfter(store.finishIncomplete(attempt.id, {
        kind: 'failed',
        reason: 'capture_failed'
      }));
    }

    let snapshotRef;
    try {
      snapshotRef = await blobs.putSnapshot(snapshot);
    } catch {
      return await changedAfter(store.finishIncomplete(attempt.id, {
        kind: 'failed',
        reason: 'snapshot_write_failed'
      }));
    }

    try {
      return await changedAfter(store.commitComplete(attempt.id, snapshotRef, normalized.contentHash));
    } catch (error) {
      if (!isProvablyPrecommitSnapshotFailure(error)) throw error;
      return await changedAfter(store.finishIncomplete(attempt.id, {
        kind: 'failed',
        reason: 'snapshot_write_failed'
      }));
    }
  }

  async function sync(sourceId, trigger = 'manual') {
    if (trigger !== 'manual' && trigger !== 'post-query') {
      throw syncError('transcript_attempt_trigger_invalid');
    }
    const source = await store.getSource(sourceId);
    const ownerId = (
      trigger === 'post-query'
        ? operationScopes.currentOwnerId()
        : null
    ) || crypto.randomUUID();
    const operation = {
      id: ownerId,
      kind: 'transcript-sync',
      key: source.key,
      source: 'transcript-library',
      phase: 'starting_attempt',
      startedAt: Date.now()
    };
    let acquiredKeyScope = false;
    try {
      acquiredKeyScope = operationScopes.reserve(`key:${source.key}`, operation);
      return await operationScopes.runWithOwner(
        ownerId,
        async () => await syncOwnedSource(source, trigger)
      );
    } finally {
      if (acquiredKeyScope) operationScopes.release(`key:${source.key}`, ownerId);
    }
  }

  return Object.freeze({
    track,
    sync,
    list: async () => await store.list(),
    forget: async (sourceId) => await changedAfter(store.forget(sourceId))
  });
}
