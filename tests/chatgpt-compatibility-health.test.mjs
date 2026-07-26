import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyChatGptCompatibilityState,
  reduceChatGptCompatibilityObservation,
  transitionChatGptCompatibilityMap
} from '../chatgpt-capability-health.mjs';

const hash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const capabilityIds = ['submit', 'response'];
let serial = 0;

function capability(status, overrides = {}) {
  serial += 1;
  return {
    schemaVersion: 1,
    observationId: `obs-${serial}`,
    attemptId: `attempt-${serial}`,
    observedAt: 1_700_000_000_000 + serial,
    contractHash: hash,
    vendorId: 'chatgpt',
    backend: 'electron',
    capabilityId: 'submit',
    kind: 'capability',
    postconditionId: 'submit-acknowledged',
    status,
    reasonCode: status === 'skip' ? 'not-applicable' : 'postcondition-satisfied',
    rolloutSignature: 'c'.repeat(64),
    ...overrides
  };
}

test('compatibility health: ok/degraded/fail cells and streak precedence are honest', () => {
  let state = createEmptyChatGptCompatibilityState({ contractHash: hash, capabilityIds, historyLimit: 8 });
  state = reduceChatGptCompatibilityObservation(state, capability('ok'));
  assert.deepEqual([state.capabilities.submit.status, state.capabilities.submit.failureStreak, state.apparatus.verdict], ['ok', 0, 'ok']);
  state = reduceChatGptCompatibilityObservation(state, capability('fail'));
  state = reduceChatGptCompatibilityObservation(state, capability('fail'));
  assert.deepEqual([state.capabilities.submit.status, state.capabilities.submit.failureStreak, state.apparatus.verdict], ['fail', 2, 'drift']);
  state = reduceChatGptCompatibilityObservation(state, capability('degraded'));
  assert.deepEqual([state.capabilities.submit.status, state.capabilities.submit.failureStreak, state.capabilities.submit.degradedStreak], ['degraded', 0, 1]);
  state = reduceChatGptCompatibilityObservation(state, capability('ok'));
  assert.deepEqual([state.capabilities.submit.status, state.capabilities.submit.failureStreak, state.capabilities.submit.degradedStreak], ['ok', 0, 0]);
});

test('compatibility health: skip and apparatus incomplete preserve authoritative streaks', () => {
  let state = createEmptyChatGptCompatibilityState({ contractHash: hash, capabilityIds });
  state = reduceChatGptCompatibilityObservation(state, capability('fail'));
  state = reduceChatGptCompatibilityObservation(state, capability('skip'));
  assert.deepEqual([state.capabilities.submit.status, state.capabilities.submit.failureStreak], ['fail', 1]);
  state = reduceChatGptCompatibilityObservation(state, {
    ...capability('skip'), kind: 'apparatus', stage: 'store', verdict: 'incomplete', reasonCode: 'write-failed'
  });
  assert.equal(state.apparatus.verdict, 'incomplete');
  assert.equal(state.capabilities.submit.failureStreak, 1);
  state = reduceChatGptCompatibilityObservation(state, capability('ok'));
  assert.equal(state.apparatus.verdict, 'ok');
});

test('compatibility health: history is bounded and map transition starts cold with bounded prior summary', () => {
  let state = createEmptyChatGptCompatibilityState({ contractHash: hash, capabilityIds, historyLimit: 3, priorMapLimit: 1 });
  for (let i = 0; i < 5; i++) state = reduceChatGptCompatibilityObservation(state, capability(i % 2 ? 'ok' : 'degraded'));
  assert.equal(state.recentObservations.length, 3);
  assert.equal(state.recentObservationIds.length, 3);
  const transitioned = transitionChatGptCompatibilityMap(state, { contractHash: nextHash, capabilityIds });
  assert.equal(transitioned.contractHash, nextHash);
  assert.equal(transitioned.recentObservations.length, 0);
  assert.equal(transitioned.capabilities.submit.status, 'skip');
  assert.equal(transitioned.apparatus.reasonCode, 'new-map-unobserved');
  assert.equal(transitioned.priorMaps.length, 1);
});
