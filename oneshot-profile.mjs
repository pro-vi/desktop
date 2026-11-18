// Page-element profile for a one-shot site: capabilities -> anchors -> branches,
// a subset of the chatgpt-compatibility.json shape, plus each branch's source.
// This parser reads only that subset. The ChatGPT profile's compatibility store, primitives and terminal
// modes stay with the ChatGPT controller (ADR 0017).

export const ONESHOT_PROFILE_SCHEMA_VERSION = 1;

// Where a branch's selector came from, so a reader can tell a selector seen on
// the signed-in page from one read off a public share page or written blind.
export const ONESHOT_BRANCH_SOURCES = Object.freeze(['live-page', 'share-page', 'guess']);

// Anchors the engine cannot run a query without. Every other anchor the
// engine reads (stop control, citations, a sign-in marker) is optional.
export const ONESHOT_REQUIRED_ANCHORS = Object.freeze([
  'composer', 'send-button', 'file-input', 'attachment-item', 'user-turn', 'assistant-turn', 'answer-body'
]);

const BRANCH_KINDS = new Set(['canonical', 'legacy']);

function profileError(reason, data = {}) {
  const error = new Error('oneshot_profile_invalid');
  error.data = { reason, ...data };
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseOneShotProfile(raw, { vendorId, requiredAnchorIds = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw profileError('profile_not_object');
  if (raw.schemaVersion !== ONESHOT_PROFILE_SCHEMA_VERSION) {
    throw profileError('schema_version_unsupported', { schemaVersion: raw.schemaVersion ?? null });
  }
  const profileVendorId = nonEmptyString(raw.vendorId);
  if (!profileVendorId || (vendorId && profileVendorId !== vendorId)) {
    throw profileError('vendor_mismatch', { expected: vendorId || null, actual: profileVendorId });
  }
  const contractVersion = nonEmptyString(raw.contractVersion);
  if (!contractVersion) throw profileError('contract_version_missing');

  const anchors = new Map();
  for (const anchor of Array.isArray(raw.anchors) ? raw.anchors : []) {
    const id = nonEmptyString(anchor?.id);
    if (!id) throw profileError('anchor_id_missing');
    if (anchors.has(id)) throw profileError('anchor_duplicate', { anchorId: id });
    const branches = [];
    for (const branch of Array.isArray(anchor.branches) ? anchor.branches : []) {
      const branchId = nonEmptyString(branch?.id);
      const selector = nonEmptyString(branch?.selector);
      if (!branchId || !selector) throw profileError('branch_incomplete', { anchorId: id, branchId });
      if (!BRANCH_KINDS.has(branch.kind)) throw profileError('branch_kind_invalid', { anchorId: id, branchId, kind: branch.kind ?? null });
      if (!ONESHOT_BRANCH_SOURCES.includes(branch.source)) {
        throw profileError('branch_source_invalid', { anchorId: id, branchId, source: branch.source ?? null });
      }
      branches.push({ id: branchId, kind: branch.kind, source: branch.source, selector });
    }
    if (!branches.length) throw profileError('anchor_without_branches', { anchorId: id });
    // Canonical branches are tried before legacy ones; order within a kind is kept.
    branches.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'canonical' ? -1 : 1));
    anchors.set(id, Object.freeze({ id, branches: Object.freeze(branches) }));
  }

  const capabilities = new Map();
  for (const capability of Array.isArray(raw.capabilities) ? raw.capabilities : []) {
    const id = nonEmptyString(capability?.id);
    if (!id) throw profileError('capability_id_missing');
    const anchorIds = Array.isArray(capability.anchorIds) ? capability.anchorIds.map(nonEmptyString) : [];
    if (!anchorIds.length || anchorIds.some((anchorId) => !anchorId)) throw profileError('capability_anchors_missing', { capabilityId: id });
    for (const anchorId of anchorIds) {
      if (!anchors.has(anchorId)) throw profileError('capability_anchor_unknown', { capabilityId: id, anchorId });
    }
    capabilities.set(id, Object.freeze([...anchorIds]));
  }

  for (const anchorId of requiredAnchorIds) {
    if (!anchors.has(anchorId)) throw profileError('required_anchor_missing', { anchorId });
  }

  return Object.freeze({
    vendorId: profileVendorId,
    contractVersion,
    anchors,
    capabilities,
    // An anchor the profile does not declare matches nothing, so optional
    // surfaces (a terms gate, a citation marker) can be absent for a site.
    selectorsFor: (anchorId) => anchors.get(anchorId)?.branches.map((branch) => branch.selector) || []
  });
}
