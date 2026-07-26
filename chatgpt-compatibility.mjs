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
  assertExactKeys(exemption, ['id', 'capabilityId', 'kind', 'dependency', 'reason'], `exemption:${index}`);
  const id = assertId(exemption.id, `exemption:${index}:id`);
  return {
    id,
    capabilityId: assertId(exemption.capabilityId, `exemption:${id}:capabilityId`),
    kind: assertEnum(exemption.kind, EXEMPTION_KINDS, `exemption:${id}:kind`),
    dependency: assertId(exemption.dependency, `exemption:${id}:dependency`),
    reason: assertNonEmptyString(exemption.reason, `exemption:${id}:reason`).trim()
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
