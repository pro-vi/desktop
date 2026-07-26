import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const CHATGPT_COMPATIBILITY_SCHEMA_VERSION = 1;
export const CHATGPT_COMPATIBILITY_MAP_URL = new URL('./chatgpt-compatibility.json', import.meta.url);

export const CHATGPT_BRANCH_KINDS = Object.freeze(['canonical', 'legacy']);
export const CHATGPT_BRANCH_SOURCES = Object.freeze(['contract', 'operator-override']);
export const CHATGPT_TERMINAL_MODES = Object.freeze([
  'dispatch',
  'predicate',
  'receipt-backed',
  'artifact-backed'
]);
export const CHATGPT_ANCHOR_STATUSES = Object.freeze(['ok', 'degraded', 'fail', 'skip']);
export const CHATGPT_APPARATUS_VERDICTS = Object.freeze(['ok', 'drift', 'incomplete']);
export const CHATGPT_COMPATIBILITY_STATUS_SCHEMA_VERSION = 1;
export const CHATGPT_COMPATIBILITY_STATUS_VERDICTS = Object.freeze([
  'observed-healthy',
  'observed-degraded',
  'drift',
  'incomplete',
  'unobserved',
  'stale',
  'incompatible'
]);

const ANCHOR_PRIMITIVE_IDS = Object.freeze([
  'editable-composer',
  'action-control',
  'assistant-output',
  'container-surface',
  'menu-surface',
  'menu-option',
  'active-state'
]);
const PRECONDITION_IDS = Object.freeze([
  'always',
  'after-submit',
  'when-attachment-requested',
  'when-mode-or-model-requested',
  'when-research-requested',
  'when-image-requested',
  'when-file-export-requested'
]);
const POSTCONDITION_IDS = Object.freeze([
  'interface-ready',
  'composer-editable',
  'submit-acknowledged',
  'attachment-accepted',
  'mode-model-confirmed',
  'stable-response',
  'research-completed',
  'image-artifacts-saved',
  'file-exported'
]);
const CAPTURE_DESCRIPTOR_FIELDS = Object.freeze([
  'tagName',
  'role',
  'ariaLabel',
  'dataTestId',
  'visible',
  'enabled'
]);

export const CHATGPT_SEMANTIC_PRIMITIVE_IDS = Object.freeze({
  anchor: ANCHOR_PRIMITIVE_IDS,
  precondition: PRECONDITION_IDS,
  postcondition: POSTCONDITION_IDS
});

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTRACT_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXEMPTION_KINDS = Object.freeze(['dependency']);

function invalid(reason) {
  const error = new Error(`invalid_chatgpt_compatibility_map:${reason}`);
  error.code = 'invalid_chatgpt_compatibility_map';
  return error;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw invalid(`${label}:expected_object`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw invalid(`${label}:unknown_field:${unknown[0]}`);
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalid(`${label}:invalid_id`);
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label}:expected_string`);
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw invalid(`${label}:unknown_variant`);
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw invalid(`${label}:duplicate:${value}`);
    seen.add(value);
  }
}

function parseBranch(value, { anchorId, index }) {
  const branch = assertRecord(value, `anchor:${anchorId}:branch:${index}`);
  assertExactKeys(branch, ['id', 'kind', 'source', 'selector'], `anchor:${anchorId}:branch:${index}`);
  const id = assertId(branch.id, `anchor:${anchorId}:branch:${index}:id`);
  const kind = assertEnum(branch.kind, CHATGPT_BRANCH_KINDS, `branch:${id}:kind`);
  const source = assertEnum(branch.source, CHATGPT_BRANCH_SOURCES, `branch:${id}:source`);
  const selector = assertNonEmptyString(branch.selector, `branch:${id}:selector`).trim();
  if (selector.includes(',')) throw invalid(`branch:${id}:comma_priority`);
  if (source === 'operator-override' && kind !== 'legacy') {
    throw invalid(`branch:${id}:operator_override_requires_legacy`);
  }
  return { id, kind, source, selector };
}

function parseAnchor(value, index) {
  const anchor = assertRecord(value, `anchor:${index}`);
  assertExactKeys(
    anchor,
    ['id', 'legacySelectorKey', 'primitiveId', 'capture', 'branches'],
    `anchor:${index}`
  );
  const id = assertId(anchor.id, `anchor:${index}:id`);
  const legacySelectorKey = assertNonEmptyString(anchor.legacySelectorKey, `anchor:${id}:legacySelectorKey`);
  const primitiveId = assertEnum(anchor.primitiveId, ANCHOR_PRIMITIVE_IDS, `anchor:${id}:primitiveId`);
  const capture = assertRecord(anchor.capture, `anchor:${id}:capture`);
  assertExactKeys(capture, ['descriptorFields'], `anchor:${id}:capture`);
  if (!Array.isArray(capture.descriptorFields) || capture.descriptorFields.length === 0) {
    throw invalid(`anchor:${id}:capture:descriptorFields`);
  }
  const descriptorFields = capture.descriptorFields.map((field, fieldIndex) =>
    assertEnum(field, CAPTURE_DESCRIPTOR_FIELDS, `anchor:${id}:capture:${fieldIndex}`)
  );
  assertUnique(descriptorFields, `anchor:${id}:capture`);
  if (!Array.isArray(anchor.branches) || anchor.branches.length === 0) {
    throw invalid(`anchor:${id}:branches_required`);
  }
  const branches = anchor.branches.map((branch, branchIndex) =>
    parseBranch(branch, { anchorId: id, index: branchIndex })
  );
  assertUnique(branches.map((branch) => branch.id), `anchor:${id}:branches`);
  if (branches[0].kind !== 'canonical') throw invalid(`anchor:${id}:canonical_branch_required_first`);
  let legacySeen = false;
  for (const branch of branches) {
    if (branch.kind === 'legacy') legacySeen = true;
    if (legacySeen && branch.kind === 'canonical') throw invalid(`anchor:${id}:legacy_before_canonical`);
  }
  return {
    id,
    legacySelectorKey,
    primitiveId,
    capture: { descriptorFields },
    branches
  };
}

function parseCapability(value, index) {
  const capability = assertRecord(value, `capability:${index}`);
  assertExactKeys(
    capability,
    ['id', 'anchorIds', 'preconditionId', 'postconditionId', 'terminalMode'],
    `capability:${index}`
  );
  const id = assertId(capability.id, `capability:${index}:id`);
  if (!Array.isArray(capability.anchorIds) || capability.anchorIds.length === 0) {
    throw invalid(`capability:${id}:anchorIds_required`);
  }
  const anchorIds = capability.anchorIds.map((anchorId, anchorIndex) =>
    assertId(anchorId, `capability:${id}:anchor:${anchorIndex}`)
  );
  assertUnique(anchorIds, `capability:${id}:anchorIds`);
  return {
    id,
    anchorIds,
    preconditionId: assertEnum(
      capability.preconditionId,
      PRECONDITION_IDS,
      `capability:${id}:preconditionId`
    ),
    postconditionId: assertEnum(
      capability.postconditionId,
      POSTCONDITION_IDS,
      `capability:${id}:postconditionId`
    ),
    terminalMode: assertEnum(capability.terminalMode, CHATGPT_TERMINAL_MODES, `capability:${id}:terminalMode`)
  };
}

function parseExemption(value, index) {
  const exemption = assertRecord(value, `exemption:${index}`);
  assertExactKeys(exemption, ['id', 'capabilityId', 'kind', 'dependency', 'reason', 'selector'], `exemption:${index}`);
  const id = assertId(exemption.id, `exemption:${index}:id`);
  return {
    id,
    capabilityId: assertId(exemption.capabilityId, `exemption:${id}:capabilityId`),
    kind: assertEnum(exemption.kind, EXEMPTION_KINDS, `exemption:${id}:kind`),
    dependency: assertId(exemption.dependency, `exemption:${id}:dependency`),
    reason: assertNonEmptyString(exemption.reason, `exemption:${id}:reason`).trim(),
    selector: exemption.selector === null
      ? null
      : assertNonEmptyString(exemption.selector, `exemption:${id}:selector`).trim()
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const STATUS_STALENESS = Object.freeze(['cold', 'current', 'stale', 'stale-map', 'unknown']);
const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

function incompatibleStatus(reasonCode = 'projection-incompatible') {
  return deepFreeze({
    schemaVersion: CHATGPT_COMPATIBILITY_STATUS_SCHEMA_VERSION,
    contractHash: null,
    cohort: 'observed',
    verdict: 'incompatible',
    apparatus: { verdict: 'incomplete', reasonCode },
    coverage: { observed: 0, total: 0 },
    staleness: { status: 'unknown', lastObservedAt: null, staleAfterMs: DEFAULT_STALE_AFTER_MS },
    capabilities: []
  });
}

function parseStatusStrict(input) {
  if (!isRecord(input)) throw new Error('status-not-object');
  const rootKeys = ['schemaVersion', 'contractHash', 'cohort', 'verdict', 'apparatus', 'coverage', 'staleness', 'capabilities'];
  if (Object.keys(input).length !== rootKeys.length || rootKeys.some((key) => !Object.hasOwn(input, key))) {
    throw new Error('status-fields');
  }
  if (input.schemaVersion !== CHATGPT_COMPATIBILITY_STATUS_SCHEMA_VERSION || input.cohort !== 'observed') {
    throw new Error('status-version');
  }
  if (!CHATGPT_COMPATIBILITY_STATUS_VERDICTS.includes(input.verdict)) throw new Error('status-verdict');
  const incompatible = input.verdict === 'incompatible';
  if (!(incompatible && input.contractHash === null) && !/^[a-f0-9]{64}$/.test(input.contractHash)) {
    throw new Error('status-hash');
  }
  if (!isRecord(input.apparatus) || Object.keys(input.apparatus).length !== 2 ||
    !CHATGPT_APPARATUS_VERDICTS.includes(input.apparatus.verdict) ||
    !ID_PATTERN.test(input.apparatus.reasonCode)) throw new Error('status-apparatus');
  if (!isRecord(input.coverage) || Object.keys(input.coverage).length !== 2 ||
    !Number.isSafeInteger(input.coverage.observed) || input.coverage.observed < 0 ||
    !Number.isSafeInteger(input.coverage.total) || input.coverage.total < input.coverage.observed) {
    throw new Error('status-coverage');
  }
  if (!isRecord(input.staleness) || Object.keys(input.staleness).length !== 3 ||
    !STATUS_STALENESS.includes(input.staleness.status) ||
    !(input.staleness.lastObservedAt === null || (Number.isSafeInteger(input.staleness.lastObservedAt) && input.staleness.lastObservedAt > 0)) ||
    !Number.isSafeInteger(input.staleness.staleAfterMs) || input.staleness.staleAfterMs <= 0) {
    throw new Error('status-staleness');
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length !== input.coverage.total) {
    throw new Error('status-capabilities');
  }
  const seen = new Set();
  for (const capability of input.capabilities) {
    if (!isRecord(capability) || Object.keys(capability).length !== 4 ||
      !ID_PATTERN.test(capability.id) || seen.has(capability.id) ||
      !CHATGPT_ANCHOR_STATUSES.includes(capability.status) ||
      !ID_PATTERN.test(capability.reasonCode) ||
      !(capability.lastObservedAt === null || (Number.isSafeInteger(capability.lastObservedAt) && capability.lastObservedAt > 0))) {
      throw new Error('status-capability');
    }
    seen.add(capability.id);
  }
  const observed = input.capabilities.filter(({ status }) => status !== 'skip').length;
  if (observed !== input.coverage.observed) throw new Error('status-coverage-mismatch');
  const hasFailure = input.capabilities.some(({ status }) => status === 'fail');
  const hasDegraded = input.capabilities.some(({ status }) => status === 'degraded');
  if (input.verdict === 'incompatible' && (
    input.apparatus.verdict !== 'incomplete' || input.staleness.status !== 'unknown' ||
    input.coverage.observed !== 0 || input.coverage.total !== 0 || input.capabilities.length !== 0
  )) throw new Error('status-incompatible-mismatch');
  if (input.verdict === 'unobserved' && input.coverage.observed !== 0) throw new Error('status-unobserved-mismatch');
  if (input.verdict === 'observed-healthy' && (
    input.apparatus.verdict !== 'ok' || input.coverage.observed === 0 || hasFailure || hasDegraded
  )) throw new Error('status-healthy-mismatch');
  if (input.verdict === 'observed-degraded' && (!hasDegraded || hasFailure)) throw new Error('status-degraded-mismatch');
  if (input.verdict === 'drift' && input.apparatus.verdict !== 'drift' && !hasFailure) throw new Error('status-drift-mismatch');
  if (input.verdict === 'incomplete' && input.apparatus.verdict !== 'incomplete') throw new Error('status-incomplete-mismatch');
  if (input.verdict === 'stale' && !['stale', 'stale-map'].includes(input.staleness.status)) throw new Error('status-stale-mismatch');
  return deepFreeze(structuredClone(input));
}

export function parseChatGptCompatibilityStatus(input) {
  try {
    return parseStatusStrict(input);
  } catch {
    return incompatibleStatus();
  }
}

export function serializeChatGptCompatibilityStatus(state, {
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS
} = {}) {
  try {
    if (!isRecord(state) || !/^[a-f0-9]{64}$/.test(state.contractHash) || !isRecord(state.apparatus) ||
      !isRecord(state.coverage) || !isRecord(state.capabilities)) throw new Error('invalid-state');
    const capabilities = Object.entries(state.capabilities).map(([id, capability]) => ({
      id,
      status: capability.status,
      reasonCode: capability.reasonCode,
      lastObservedAt: capability.lastObservedAt
    }));
    const lastObservedAt = capabilities.reduce(
      (latest, capability) => Math.max(latest, Number(capability.lastObservedAt || 0)),
      0
    ) || null;
    const hasPriorMap = Array.isArray(state.priorMaps) && state.priorMaps.length > 0;
    const stalenessStatus = hasPriorMap && state.coverage.observed === 0
      ? 'stale-map'
      : lastObservedAt === null ? 'cold'
        : now - lastObservedAt > staleAfterMs ? 'stale' : 'current';
    const hasFailure = capabilities.some(({ status }) => status === 'fail');
    const hasDegraded = capabilities.some(({ status }) => status === 'degraded');
    const coldReason = ['no-observations', 'new-map-unobserved'].includes(state.apparatus.reasonCode);
    const verdict = stalenessStatus === 'stale-map'
      ? 'stale'
      : state.coverage.observed === 0 && coldReason ? 'unobserved'
        : state.apparatus.verdict === 'incomplete' ? 'incomplete'
          : state.apparatus.verdict === 'drift' || hasFailure ? 'drift'
            : stalenessStatus === 'stale' ? 'stale'
              : hasDegraded ? 'observed-degraded' : 'observed-healthy';
    return parseStatusStrict({
      schemaVersion: CHATGPT_COMPATIBILITY_STATUS_SCHEMA_VERSION,
      contractHash: state.contractHash,
      cohort: 'observed',
      verdict,
      apparatus: { verdict: state.apparatus.verdict, reasonCode: state.apparatus.reasonCode },
      coverage: { observed: state.coverage.observed, total: state.coverage.total },
      staleness: { status: stalenessStatus, lastObservedAt, staleAfterMs },
      capabilities
    });
  } catch {
    return incompatibleStatus();
  }
}

export function hashChatGptCompatibilityMap(map) {
  return createHash('sha256').update(canonicalJson(map)).digest('hex');
}

export function parseChatGptCompatibilityMap(value) {
  const map = assertRecord(value, 'root');
  assertExactKeys(
    map,
    ['schemaVersion', 'contractVersion', 'capturedAt', 'vendorId', 'capabilities', 'anchors', 'exemptions'],
    'root'
  );
  if (map.schemaVersion !== CHATGPT_COMPATIBILITY_SCHEMA_VERSION) throw invalid('root:unknown_schema_version');
  if (typeof map.contractVersion !== 'string' || !CONTRACT_VERSION_PATTERN.test(map.contractVersion)) {
    throw invalid('root:invalid_contract_version');
  }
  if (typeof map.capturedAt !== 'string' || !Number.isFinite(Date.parse(map.capturedAt))) {
    throw invalid('root:invalid_captured_at');
  }
  if (map.vendorId !== 'chatgpt') throw invalid('root:vendor_must_be_chatgpt');
  if (!Array.isArray(map.capabilities) || map.capabilities.length === 0) throw invalid('root:capabilities_required');
  if (!Array.isArray(map.anchors) || map.anchors.length === 0) throw invalid('root:anchors_required');
  if (!Array.isArray(map.exemptions)) throw invalid('root:exemptions_required');

  const capabilities = map.capabilities.map(parseCapability);
  const anchors = map.anchors.map(parseAnchor);
  const exemptions = map.exemptions.map(parseExemption);
  assertUnique(capabilities.map(({ id }) => id), 'capabilities');
  assertUnique(anchors.map(({ id }) => id), 'anchors');
  assertUnique(anchors.flatMap(({ branches }) => branches.map(({ id }) => id)), 'branches');
  assertUnique(anchors.map(({ legacySelectorKey }) => legacySelectorKey), 'legacySelectorKeys');
  assertUnique(exemptions.map(({ id }) => id), 'exemptions');

  const capabilityIds = new Set(capabilities.map(({ id }) => id));
  const anchorIds = new Set(anchors.map(({ id }) => id));
  for (const capability of capabilities) {
    for (const anchorId of capability.anchorIds) {
      if (!anchorIds.has(anchorId)) throw invalid(`capability:${capability.id}:unknown_anchor:${anchorId}`);
    }
  }
  for (const exemption of exemptions) {
    if (!capabilityIds.has(exemption.capabilityId)) {
      throw invalid(`exemption:${exemption.id}:unknown_capability:${exemption.capabilityId}`);
    }
  }

  return deepFreeze({
    schemaVersion: CHATGPT_COMPATIBILITY_SCHEMA_VERSION,
    contractVersion: map.contractVersion,
    capturedAt: map.capturedAt,
    vendorId: 'chatgpt',
    capabilities,
    anchors,
    exemptions
  });
}

export function createChatGptCompatibilityProfile(value) {
  const parsed = parseChatGptCompatibilityMap(value);
  return deepFreeze({ ...parsed, contractHash: hashChatGptCompatibilityMap(parsed) });
}

export async function loadChatGptCompatibilityProfile(url = CHATGPT_COMPATIBILITY_MAP_URL) {
  let raw;
  try {
    raw = JSON.parse(await readFile(url, 'utf8'));
  } catch (error) {
    throw invalid(`load:${error?.code || error?.name || 'unknown'}`);
  }
  return createChatGptCompatibilityProfile(raw);
}

function copySelectorRecord(selectors) {
  if (!isRecord(selectors)) throw invalid('selectors:expected_object');
  return Object.fromEntries(
    Object.entries(selectors).map(([key, value]) => [
      assertNonEmptyString(key, 'selectors:key'),
      assertNonEmptyString(value, `selectors:${key}`).trim()
    ])
  );
}

export function createLegacyUiContract({ vendorId = null, vendorName = null, selectors }) {
  return deepFreeze({
    kind: 'legacy',
    vendorId: vendorId || null,
    vendorName: vendorName || null,
    selectors: copySelectorRecord(selectors)
  });
}

function operatorOverridesForProfile(profile, selectorOverrides) {
  if (!isRecord(selectorOverrides)) throw invalid('selector_overrides:expected_object');
  const anchorBySelectorKey = new Map(
    profile.anchors.map((anchor) => [anchor.legacySelectorKey, anchor.id])
  );
  const overrides = [];
  for (const [selectorKey, rawSelector] of Object.entries(selectorOverrides)) {
    const anchorId = anchorBySelectorKey.get(selectorKey);
    if (!anchorId) throw invalid(`selector_overrides:unknown_key:${selectorKey}`);
    const selectors = assertNonEmptyString(rawSelector, `selector_overrides:${selectorKey}`)
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean);
    if (selectors.length === 0) throw invalid(`selector_overrides:${selectorKey}:empty`);
    for (const selector of selectors) {
      overrides.push({
        anchorId,
        selectorKey,
        selector,
        kind: 'legacy',
        source: 'operator-override'
      });
    }
  }
  return overrides;
}

export function projectChatGptLegacySelectors(profile, selectorOverrides = {}) {
  if (!profile || profile.vendorId !== 'chatgpt' || !Array.isArray(profile.anchors)) {
    throw invalid('profile:chatgpt_profile_required');
  }
  const projected = Object.fromEntries(
    profile.anchors.map((anchor) => [
      anchor.legacySelectorKey,
      anchor.branches.map(({ selector }) => selector).join(', ')
    ])
  );
  for (const [key, value] of Object.entries(selectorOverrides)) {
    if (!Object.hasOwn(projected, key)) throw invalid(`selector_overrides:unknown_key:${key}`);
    projected[key] = assertNonEmptyString(value, `selector_overrides:${key}`).trim();
  }
  return deepFreeze(projected);
}

export function createProviderCompatibilityBridge({
  vendorId = null,
  vendorName = null,
  selectors,
  selectorOverrides = {},
  profile,
  onCompatibilityObservation = null
}) {
  const isChatGpt = vendorId === 'chatgpt';
  if (!isChatGpt) {
    return deepFreeze({
      uiContract: createLegacyUiContract({ vendorId, vendorName, selectors }),
      onCompatibilityObservation: null
    });
  }
  if (!profile || profile.vendorId !== 'chatgpt' || !profile.contractHash) {
    throw invalid('profile:chatgpt_profile_required');
  }
  const operatorOverrides = operatorOverridesForProfile(profile, selectorOverrides);
  return deepFreeze({
    uiContract: {
      kind: 'chatgpt',
      vendorId,
      vendorName: vendorName || null,
      profile,
      legacySelectors: projectChatGptLegacySelectors(profile, selectorOverrides),
      operatorOverrides,
      provenance: operatorOverrides.length ? 'operator-override' : 'contract',
      degraded: operatorOverrides.length > 0
    },
    onCompatibilityObservation:
      typeof onCompatibilityObservation === 'function' ? onCompatibilityObservation : null
  });
}
