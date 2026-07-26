import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './fs-utils.mjs';
import {
  compatibilityStateWithIncomplete,
  createEmptyChatGptCompatibilityState,
  reduceChatGptCompatibilityObservation,
  transitionChatGptCompatibilityMap
} from './chatgpt-capability-health.mjs';
import { parseChatGptCompatibilityObservation } from './chatgpt-compatibility-redaction.mjs';

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function statePath(stateDir) {
  return path.join(stateDir, 'compatibility', 'chatgpt', 'state.json');
}

async function defaultWriteFile(filePath, data, options) {
  await atomicWriteFile(filePath, data, options);
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

function validReason(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validNullableCount(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function validateApparatus(value) {
  return exactKeys(value, ['verdict', 'reasonCode']) &&
    ['ok', 'drift', 'incomplete'].includes(value.verdict) && validReason(value.reasonCode);
}

function validateCoverage(value) {
  return exactKeys(value, ['observed', 'total']) && validCount(value.observed) &&
    validCount(value.total) && value.observed <= value.total;
}

function parseStoredState(value) {
  if (!exactKeys(value, [
    'schemaVersion', 'contractHash', 'revision', 'sequence', 'apparatus', 'coverage',
    'capabilities', 'recentObservations', 'recentObservationIds', 'priorMaps', 'limits'
  ])) throw new Error('invalid_compatibility_state');
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.contractHash)) throw new Error('invalid_compatibility_state');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error('invalid_compatibility_state');
  }
  if (!validateApparatus(value.apparatus)) {
    throw new Error('invalid_compatibility_state');
  }
  if (!validateCoverage(value.coverage) || !isRecord(value.capabilities)) throw new Error('invalid_compatibility_state');
  if (!exactKeys(value.limits, ['history', 'priorMaps']) || !Number.isSafeInteger(value.limits.history) || value.limits.history < 1 || value.limits.history > 10_000 || !Number.isSafeInteger(value.limits.priorMaps) || value.limits.priorMaps < 1 || value.limits.priorMaps > 20) throw new Error('invalid_compatibility_state');
  if (!Array.isArray(value.recentObservations) || !Array.isArray(value.recentObservationIds) || !Array.isArray(value.priorMaps)) {
    throw new Error('invalid_compatibility_state');
  }
  if (value.recentObservations.length > value.limits.history || value.recentObservationIds.length > value.limits.history || value.priorMaps.length > value.limits.priorMaps) {
    throw new Error('invalid_compatibility_state');
  }
  for (const [capabilityId, item] of Object.entries(value.capabilities)) {
    if (!/^[a-z][a-z0-9-]*$/.test(capabilityId) || !exactKeys(item, [
      'status', 'reasonCode', 'failureStreak', 'degradedStreak', 'lastSequence', 'lastObservedAt', 'rolloutSignature'
    ])) throw new Error('invalid_compatibility_state');
    if (!['ok', 'degraded', 'fail', 'skip'].includes(item.status)) throw new Error('invalid_compatibility_state');
    if (!validReason(item.reasonCode) || !validCount(item.failureStreak) || !validCount(item.degradedStreak) ||
      !validNullableCount(item.lastSequence) || !validNullableCount(item.lastObservedAt) ||
      !(item.rolloutSignature === null || /^[a-f0-9]{64}$/.test(item.rolloutSignature))) {
      throw new Error('invalid_compatibility_state');
    }
    if ((item.status === 'fail') !== (item.failureStreak > 0)) throw new Error('invalid_compatibility_state');
    if ((item.status === 'degraded') !== (item.degradedStreak > 0)) throw new Error('invalid_compatibility_state');
  }
  const parsedRows = value.recentObservations.map((row) => {
    if (!isRecord(row) || !Number.isSafeInteger(row.sequence) || row.sequence <= 0) throw new Error('invalid_compatibility_state');
    const { sequence, ...observation } = row;
    return { ...parseChatGptCompatibilityObservation(observation, { contractHash: value.contractHash }), sequence };
  });
  const state = clone(value);
  state.recentObservations = parsedRows;
  if (!value.recentObservationIds.every((item) => typeof item === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(item))) {
    throw new Error('invalid_compatibility_state');
  }
  if (value.recentObservationIds.length !== parsedRows.length ||
    value.recentObservationIds.some((item, index) => item !== parsedRows[index].observationId)) {
    throw new Error('invalid_compatibility_state');
  }
  const sequences = parsedRows.map(({ sequence }) => sequence);
  if (sequences.some((sequence, index) => sequence > value.sequence || (index > 0 && sequence <= sequences[index - 1]))) {
    throw new Error('invalid_compatibility_state');
  }
  const observed = Object.values(value.capabilities).filter(({ status }) => status !== 'skip').length;
  if (value.coverage.observed !== observed || value.coverage.total !== Object.keys(value.capabilities).length) {
    throw new Error('invalid_compatibility_state');
  }
  if (value.apparatus.verdict !== 'incomplete') {
    const hasFailure = Object.values(value.capabilities).some(({ status }) => status === 'fail');
    if ((value.apparatus.verdict === 'drift') !== hasFailure) throw new Error('invalid_compatibility_state');
  }
  for (const prior of value.priorMaps) {
    if (!exactKeys(prior, ['contractHash', 'revision', 'sequence', 'apparatus', 'coverage']) ||
      !/^[a-f0-9]{64}$/.test(prior.contractHash) || !validCount(prior.revision) || !validCount(prior.sequence) ||
      !validateApparatus(prior.apparatus) || !validateCoverage(prior.coverage)) {
      throw new Error('invalid_compatibility_state');
    }
  }
  return state;
}

export function createCompatibilityStore(stateDir, {
  contractHash,
  capabilityIds,
  capabilityModes = {},
  historyLimit = 100,
  priorMapLimit = 2,
  writeFile = defaultWriteFile,
  renameFile = fs.rename,
  readFile = fs.readFile,
  now = Date.now
} = {}) {
  const filePath = statePath(stateDir);
  const currentCapabilityIds = [...new Set(capabilityIds || [])];
  let durableState = createEmptyChatGptCompatibilityState({ contractHash, capabilityIds: currentCapabilityIds, historyLimit, priorMapLimit });
  let transientState = null;
  let loadPromise = null;
  let queue = Promise.resolve();
  const listeners = new Set();

  function snapshot() {
    return clone(transientState || durableState);
  }

  async function loadOnce() {
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      durableState = parseStoredState(raw);
      transientState = null;
    } catch (error) {
      if (error?.code === 'ENOENT') return snapshot();
      try {
        await renameFile(filePath, `${filePath}.corrupt-${now()}`);
      } catch {}
      durableState = createEmptyChatGptCompatibilityState({
        contractHash,
        capabilityIds: currentCapabilityIds,
        historyLimit,
        priorMapLimit,
        reasonCode: 'corrupt-state'
      });
      transientState = null;
    }
    return snapshot();
  }

  async function load() {
    if (!loadPromise) loadPromise = loadOnce();
    return clone(await loadPromise);
  }

  async function record(input) {
    await load();
    let observation;
    try {
      observation = parseChatGptCompatibilityObservation(input, {
        contractHash,
        capabilityIds: currentCapabilityIds
      });
    } catch {
      transientState = compatibilityStateWithIncomplete(durableState, 'invalid-observation');
      return { accepted: false, reason: 'invalid-observation', state: snapshot() };
    }

    const operation = async () => {
      let base = durableState;
      if (base.contractHash !== contractHash) {
        base = transitionChatGptCompatibilityMap(base, { contractHash, capabilityIds: currentCapabilityIds });
      }
      if (base.recentObservationIds.includes(observation.observationId)) {
        return { accepted: true, duplicate: true, state: snapshot() };
      }
      if (observation.kind === 'terminal') {
        const rows = base.recentObservations.filter((row) => row.capabilityId === observation.capabilityId);
        const latestMechanism = [...rows].reverse().find((row) => row.kind === 'capability');
        const alreadyFinalized = rows.some((row) => row.kind === 'terminal' && row.attemptId === observation.attemptId);
        if (!latestMechanism || latestMechanism.attemptId !== observation.attemptId || alreadyFinalized ||
          (capabilityModes[observation.capabilityId] && capabilityModes[observation.capabilityId] !== observation.mode)) {
          return { accepted: false, reason: 'stale-terminal', state: snapshot() };
        }
      }
      const candidate = reduceChatGptCompatibilityObservation(base, observation, { capabilityModes });
      candidate.revision = base.revision + 1;
      try {
        await writeFile(filePath, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
      } catch {
        transientState = compatibilityStateWithIncomplete(durableState, 'store-write-failed');
        return { accepted: false, reason: 'store-write-failed', state: snapshot() };
      }
      durableState = candidate;
      transientState = null;
      const published = snapshot();
      for (const listener of listeners) listener(clone(published));
      return { accepted: true, duplicate: false, state: published };
    };

    const result = queue.catch(() => {}).then(operation);
    queue = result.then(() => undefined, () => undefined);
    return await result;
  }

  return {
    load,
    record,
    getSnapshot: snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('compatibility_listener_required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
