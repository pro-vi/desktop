export const CHATGPT_COMPATIBILITY_OBSERVATION_SCHEMA_VERSION = 1;
export const CHATGPT_COMPATIBILITY_OBSERVATION_KINDS = Object.freeze([
  'resolution', 'capability', 'terminal', 'apparatus'
]);

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BACKENDS = ['electron', 'chrome-cdp'];
const COMMON_KEYS = [
  'schemaVersion', 'observationId', 'attemptId', 'observedAt', 'contractHash',
  'vendorId', 'backend', 'kind'
];
const VARIANT_KEYS = Object.freeze({
  resolution: ['capabilityId', 'anchorId', 'branchId', 'branchKind', 'branchSource', 'selectorHash', 'rolloutSignature'],
  capability: ['capabilityId', 'postconditionId', 'status', 'reasonCode', 'rolloutSignature'],
  terminal: ['capabilityId', 'mode', 'status', 'artifactCount'],
  apparatus: ['stage', 'verdict', 'reasonCode']
});

function invalid(reason) {
  const error = new Error(`invalid_chatgpt_compatibility_observation:${reason}`);
  error.code = 'invalid_chatgpt_compatibility_observation';
  return error;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label}:expected-object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) throw invalid(`${label}:unknown-field:${key}`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) throw invalid(`${label}:missing-field:${key}`);
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(`${label}:invalid-id`);
  return value;
}

function reason(value, label) {
  if (typeof value !== 'string' || !REASON.test(value)) throw invalid(`${label}:invalid-reason`);
  return value;
}

function enumValue(value, choices, label) {
  if (!choices.includes(value)) throw invalid(`${label}:unknown-variant`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw invalid(`${label}:invalid-hash`);
  return value;
}

function common(value, { contractHash }) {
  if (value.schemaVersion !== CHATGPT_COMPATIBILITY_OBSERVATION_SCHEMA_VERSION) throw invalid('unknown-schema-version');
  if (value.vendorId !== 'chatgpt') throw invalid('vendor-not-chatgpt');
  const parsedHash = hash(value.contractHash, 'contractHash');
  if (contractHash && parsedHash !== contractHash) throw invalid('contract-hash-mismatch');
  const observedAt = Number(value.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw invalid('invalid-observedAt');
  return {
    schemaVersion: 1,
    observationId: id(value.observationId, 'observationId'),
    attemptId: id(value.attemptId, 'attemptId'),
    observedAt,
    contractHash: parsedHash,
    vendorId: 'chatgpt',
    backend: enumValue(value.backend, BACKENDS, 'backend'),
    kind: enumValue(value.kind, CHATGPT_COMPATIBILITY_OBSERVATION_KINDS, 'kind')
  };
}

export function parseChatGptCompatibilityObservation(input, options = {}) {
  const value = record(input, 'root');
  const kind = enumValue(value.kind, CHATGPT_COMPATIBILITY_OBSERVATION_KINDS, 'kind');
  exactKeys(value, [...COMMON_KEYS, ...VARIANT_KEYS[kind]], kind);
  const base = common(value, options);
  const capabilityId = kind === 'apparatus' ? null : id(value.capabilityId, 'capabilityId');
  if (capabilityId && options.capabilityIds && !options.capabilityIds.includes(capabilityId)) throw invalid('unknown-capability');
  if (kind === 'resolution') {
    return Object.freeze({
      ...base,
      capabilityId,
      anchorId: id(value.anchorId, 'anchorId'),
      branchId: id(value.branchId, 'branchId'),
      branchKind: enumValue(value.branchKind, ['canonical', 'legacy'], 'branchKind'),
      branchSource: enumValue(value.branchSource, ['contract', 'operator-override'], 'branchSource'),
      selectorHash: hash(value.selectorHash, 'selectorHash'),
      rolloutSignature: hash(value.rolloutSignature, 'rolloutSignature')
    });
  }
  if (kind === 'capability') {
    return Object.freeze({
      ...base,
      capabilityId,
      postconditionId: id(value.postconditionId, 'postconditionId'),
      status: enumValue(value.status, ['ok', 'degraded', 'fail', 'skip'], 'status'),
      reasonCode: reason(value.reasonCode, 'reasonCode'),
      rolloutSignature: hash(value.rolloutSignature, 'rolloutSignature')
    });
  }
  if (kind === 'terminal') {
    const artifactCount = Number(value.artifactCount);
    if (!Number.isSafeInteger(artifactCount) || artifactCount < 0 || artifactCount > 10_000) throw invalid('invalid-artifact-count');
    return Object.freeze({
      ...base,
      capabilityId,
      mode: enumValue(value.mode, ['dispatch', 'predicate', 'receipt-backed', 'artifact-backed'], 'mode'),
      status: enumValue(value.status, ['satisfied', 'failed', 'not-applicable'], 'terminal-status'),
      artifactCount
    });
  }
  return Object.freeze({
    ...base,
    stage: enumValue(value.stage, ['map-parse', 'eval', 'decode', 'store', 'projection'], 'stage'),
    verdict: enumValue(value.verdict, ['incomplete'], 'verdict'),
    reasonCode: reason(value.reasonCode, 'reasonCode')
  });
}
