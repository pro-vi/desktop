function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function boundedInteger(value, fallback, max = 10_000) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : fallback;
}

function emptyCapability() {
  return {
    status: 'skip',
    reasonCode: 'not-observed',
    failureStreak: 0,
    degradedStreak: 0,
    lastSequence: null,
    lastObservedAt: null,
    rolloutSignature: null
  };
}

function capabilityTable(capabilityIds) {
  return Object.fromEntries(capabilityIds.map((id) => [id, emptyCapability()]));
}

function coverageFor(capabilities) {
  const rows = Object.values(capabilities);
  return {
    observed: rows.filter(({ status }) => status !== 'skip').length,
    total: rows.length
  };
}

function apparatusForCapabilities(capabilities) {
  const rows = Object.values(capabilities);
  if (rows.some(({ status }) => status === 'fail')) return { verdict: 'drift', reasonCode: 'capability-failure' };
  if (rows.some(({ status }) => status === 'ok' || status === 'degraded')) return { verdict: 'ok', reasonCode: 'observed-cohort' };
  return { verdict: 'incomplete', reasonCode: 'no-observations' };
}

export function createEmptyChatGptCompatibilityState({
  contractHash,
  capabilityIds,
  historyLimit = 100,
  priorMapLimit = 2,
  reasonCode = 'no-observations'
}) {
  const uniqueIds = [...new Set(capabilityIds || [])];
  const capabilities = capabilityTable(uniqueIds);
  return {
    schemaVersion: 1,
    contractHash,
    revision: 0,
    sequence: 0,
    apparatus: { verdict: 'incomplete', reasonCode },
    coverage: coverageFor(capabilities),
    capabilities,
    recentObservations: [],
    recentObservationIds: [],
    priorMaps: [],
    limits: {
      history: boundedInteger(historyLimit, 100),
      priorMaps: boundedInteger(priorMapLimit, 2, 20)
    }
  };
}

function appendBounded(items, item, limit) {
  return [...items, item].slice(-limit);
}

function applyCapabilityStatus(current, observation, sequence) {
  current.status = observation.status;
  current.reasonCode = observation.reasonCode;
  current.lastSequence = sequence;
  current.lastObservedAt = observation.observedAt;
  current.rolloutSignature = observation.rolloutSignature;
  if (observation.status === 'fail') {
    current.failureStreak += 1;
    current.degradedStreak = 0;
  } else if (observation.status === 'degraded') {
    current.failureStreak = 0;
    current.degradedStreak += 1;
  } else {
    current.failureStreak = 0;
    current.degradedStreak = 0;
  }
}

export function reduceChatGptCompatibilityObservation(inputState, observation, { capabilityModes = {} } = {}) {
  const state = clone(inputState);
  const terminalMechanism = observation.kind === 'terminal'
    ? [...state.recentObservations].reverse().find((row) =>
      row.kind === 'capability' && row.capabilityId === observation.capabilityId && row.attemptId === observation.attemptId)
    : null;
  state.sequence += 1;
  const row = { ...clone(observation), sequence: state.sequence };
  state.recentObservations = appendBounded(state.recentObservations, row, state.limits.history);
  state.recentObservationIds = appendBounded(
    state.recentObservationIds,
    observation.observationId,
    state.limits.history
  );

  if (observation.kind === 'capability') {
    const current = state.capabilities[observation.capabilityId];
    if (!current) throw new Error(`unknown_chatgpt_capability:${observation.capabilityId}`);
    if (observation.status !== 'skip') {
      const mode = capabilityModes[observation.capabilityId];
      if (mode === 'receipt-backed' || mode === 'artifact-backed') {
        current.status = 'skip';
        current.reasonCode = 'terminal-pending';
        current.lastSequence = state.sequence;
        current.lastObservedAt = observation.observedAt;
        current.rolloutSignature = observation.rolloutSignature;
        current.failureStreak = 0;
        current.degradedStreak = 0;
      } else {
        applyCapabilityStatus(current, observation, state.sequence);
      }
    } else if (current.status === 'skip') {
      current.reasonCode = observation.reasonCode;
      current.lastSequence = state.sequence;
      current.lastObservedAt = observation.observedAt;
    }
    state.apparatus = apparatusForCapabilities(state.capabilities);
  } else if (observation.kind === 'terminal') {
    const current = state.capabilities[observation.capabilityId];
    if (!current) throw new Error(`unknown_chatgpt_capability:${observation.capabilityId}`);
    if (observation.status === 'satisfied' && terminalMechanism) {
      applyCapabilityStatus(current, terminalMechanism, state.sequence);
      current.lastObservedAt = observation.observedAt;
    } else if (observation.status === 'failed') {
      applyCapabilityStatus(current, {
        status: 'fail', reasonCode: 'terminal-failed', observedAt: observation.observedAt,
        rolloutSignature: terminalMechanism?.rolloutSignature || current.rolloutSignature
      }, state.sequence);
    } else {
      current.status = 'skip';
      current.reasonCode = 'not-applicable';
      current.lastSequence = state.sequence;
      current.lastObservedAt = observation.observedAt;
      current.failureStreak = 0;
      current.degradedStreak = 0;
    }
    state.apparatus = apparatusForCapabilities(state.capabilities);
  } else if (observation.kind === 'apparatus') {
    state.apparatus = { verdict: 'incomplete', reasonCode: observation.reasonCode };
  }
  state.coverage = coverageFor(state.capabilities);
  return state;
}

export function transitionChatGptCompatibilityMap(inputState, { contractHash, capabilityIds }) {
  if (inputState.contractHash === contractHash) return clone(inputState);
  const priorSummary = {
    contractHash: inputState.contractHash,
    revision: inputState.revision,
    sequence: inputState.sequence,
    apparatus: clone(inputState.apparatus),
    coverage: clone(inputState.coverage)
  };
  const next = createEmptyChatGptCompatibilityState({
    contractHash,
    capabilityIds,
    historyLimit: inputState.limits.history,
    priorMapLimit: inputState.limits.priorMaps,
    reasonCode: 'new-map-unobserved'
  });
  next.revision = inputState.revision;
  next.sequence = inputState.sequence;
  next.priorMaps = appendBounded(
    inputState.priorMaps || [],
    priorSummary,
    inputState.limits.priorMaps
  );
  return next;
}

export function compatibilityStateWithIncomplete(inputState, reasonCode) {
  const state = clone(inputState);
  state.apparatus = { verdict: 'incomplete', reasonCode };
  return state;
}
