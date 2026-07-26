import { createHash } from 'node:crypto';

const RESULT_TYPE = 'chatgpt-anchor-resolution';
const RESULT_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function apparatus(stage, reasonCode) {
  return Object.freeze({ kind: 'apparatus', stage, verdict: 'incomplete', reasonCode });
}

function anchorPlan({ profile, uiContract, anchorId }) {
  const structuredProfile = uiContract?.kind === 'chatgpt' ? uiContract.profile : profile;
  if (!structuredProfile || structuredProfile.vendorId !== 'chatgpt') {
    throw new Error('invalid_chatgpt_resolver_profile');
  }
  const anchor = structuredProfile.anchors.find((item) => item.id === anchorId);
  if (!anchor) throw new Error(`unknown_chatgpt_anchor:${anchorId}`);
  const overrideBranches = (uiContract?.operatorOverrides || [])
    .filter((item) => item.anchorId === anchorId)
    .map((item, index) => ({
      id: `${anchorId}-operator-${String(index + 1).padStart(2, '0')}-${sha256(item.selector).slice(0, 12)}`,
      kind: 'legacy',
      source: 'operator-override',
      selector: item.selector
    }));
  const branches = [...overrideBranches, ...anchor.branches].map((branch) => ({
    ...branch,
    selectorHash: sha256(branch.selector)
  }));
  return {
    anchorId,
    primitiveId: anchor.primitiveId,
    branches,
    rolloutSignature: sha256(
      JSON.stringify(branches.map(({ id, kind, source, selectorHash }) => ({ id, kind, source, selectorHash })))
    )
  };
}

export function compileChatGptAnchorEvaluator({ profile = null, uiContract = null, anchorId }) {
  const plan = anchorPlan({ profile, uiContract, anchorId });
  return `(() => {
    const plan = ${JSON.stringify(plan)};
    const attr = (node, name) => {
      try { return String(node?.getAttribute?.(name) || '').slice(0, 160); } catch { return ''; }
    };
    const visible = (node) => {
      try {
        const rect = node?.getBoundingClientRect?.();
        const style = node?.ownerDocument?.defaultView?.getComputedStyle?.(node);
        return !!rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
      } catch { return false; }
    };
    const enabled = (node) => !node?.disabled && attr(node, 'aria-disabled').toLowerCase() !== 'true';
    const descriptor = (node) => ({
      tagName: String(node?.tagName || '').toLowerCase().slice(0, 40),
      role: attr(node, 'role'),
      ariaLabel: attr(node, 'aria-label'),
      dataTestId: attr(node, 'data-testid'),
      visible: visible(node),
      enabled: enabled(node)
    });
    const postcondition = (node, item) => {
      const d = descriptor(node);
      if (!d.visible) return { status: 'fail', reasonCode: 'anchor-hidden' };
      if (!d.enabled) return { status: 'fail', reasonCode: 'anchor-disabled' };
      const editable = d.tagName === 'textarea' || node?.isContentEditable === true || attr(node, 'contenteditable') === 'true' || d.role === 'textbox';
      const buttonLike = d.tagName === 'button' || d.role === 'button' || d.role === 'tab' || d.role === 'switch';
      const menuLike = d.role === 'menu' || d.role === 'listbox' || d.role === 'dialog' || !!attr(node, 'popover');
      const optionLike = d.tagName === 'button' || d.role === 'button' || d.role === 'menuitem' || d.role === 'option';
      const valid =
        item.primitiveId === 'editable-composer' ? editable :
        item.primitiveId === 'action-control' ? buttonLike :
        item.primitiveId === 'menu-surface' ? menuLike :
        item.primitiveId === 'menu-option' ? optionLike :
        item.primitiveId === 'active-state' ? buttonLike || optionLike :
        item.primitiveId === 'assistant-output' ? d.tagName !== 'script' && d.tagName !== 'style' :
        item.primitiveId === 'container-surface' ? ['form', 'main', 'div', 'section'].includes(d.tagName) : false;
      return valid ? { status: 'ok', reasonCode: 'postcondition-satisfied' } : { status: 'fail', reasonCode: 'wrong-node' };
    };
    try {
      for (const branch of plan.branches) {
        const matches = Array.from(document.querySelectorAll(branch.selector));
        if (!matches.length) continue;
        const node = matches[0];
        return {
          type: '${RESULT_TYPE}', schemaVersion: ${RESULT_SCHEMA_VERSION}, ok: true,
          anchorId: plan.anchorId, branchId: branch.id, branchKind: branch.kind,
          branchSource: branch.source, selectorHash: branch.selectorHash,
          rolloutSignature: plan.rolloutSignature, matchCount: matches.length,
          descriptor: descriptor(node), postcondition: postcondition(node, plan)
        };
      }
      return {
        type: '${RESULT_TYPE}', schemaVersion: ${RESULT_SCHEMA_VERSION}, ok: true,
        anchorId: plan.anchorId, branchId: null, branchKind: null, branchSource: null,
        selectorHash: null, rolloutSignature: plan.rolloutSignature, matchCount: 0,
        descriptor: null, postcondition: { status: 'fail', reasonCode: 'anchor-absent' }
      };
    } catch {
      return {
        type: '${RESULT_TYPE}', schemaVersion: ${RESULT_SCHEMA_VERSION}, ok: false,
        stage: 'eval', reasonCode: 'selector-evaluation-failed'
      };
    }
  })()`;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validPostcondition(value) {
  return isRecord(value) && ['ok', 'fail'].includes(value.status) && typeof value.reasonCode === 'string' && !!value.reasonCode;
}

function validDescriptor(value) {
  return isRecord(value) &&
    typeof value.tagName === 'string' &&
    typeof value.role === 'string' &&
    typeof value.ariaLabel === 'string' &&
    typeof value.dataTestId === 'string' &&
    typeof value.visible === 'boolean' &&
    typeof value.enabled === 'boolean';
}

export function parseChatGptAnchorEvaluation(raw) {
  if (!isRecord(raw) || raw.type !== RESULT_TYPE || raw.schemaVersion !== RESULT_SCHEMA_VERSION) {
    return apparatus('decode', 'malformed-evaluation-result');
  }
  if (raw.ok === false) {
    if (raw.stage !== 'eval' || typeof raw.reasonCode !== 'string' || !raw.reasonCode) {
      return apparatus('decode', 'malformed-evaluation-result');
    }
    return apparatus('eval', raw.reasonCode);
  }
  if (
    raw.ok !== true ||
    typeof raw.anchorId !== 'string' || !raw.anchorId ||
    !HASH_PATTERN.test(raw.rolloutSignature) ||
    !Number.isInteger(raw.matchCount) || raw.matchCount < 0 ||
    !validPostcondition(raw.postcondition)
  ) {
    return apparatus('decode', 'malformed-evaluation-result');
  }
  const absent = raw.branchId === null;
  if (absent) {
    if (
      raw.branchKind !== null || raw.branchSource !== null || raw.selectorHash !== null ||
      raw.matchCount !== 0 || raw.descriptor !== null ||
      raw.postcondition.status !== 'fail' || raw.postcondition.reasonCode !== 'anchor-absent'
    ) return apparatus('decode', 'malformed-evaluation-result');
  } else if (
    typeof raw.branchId !== 'string' || !raw.branchId ||
    !['canonical', 'legacy'].includes(raw.branchKind) ||
    !['contract', 'operator-override'].includes(raw.branchSource) ||
    !HASH_PATTERN.test(raw.selectorHash) || raw.matchCount < 1 || !validDescriptor(raw.descriptor)
  ) {
    return apparatus('decode', 'malformed-evaluation-result');
  }
  const postcondition = Object.freeze({
    status: raw.postcondition.status,
    reasonCode: raw.postcondition.reasonCode
  });
  return Object.freeze({
    kind: 'resolution',
    status: absent ? 'absent' : 'resolved',
    anchorId: raw.anchorId,
    branchId: absent ? null : raw.branchId,
    branchKind: absent ? null : raw.branchKind,
    branchSource: absent ? null : raw.branchSource,
    selectorHash: absent ? null : raw.selectorHash,
    rolloutSignature: raw.rolloutSignature,
    matchCount: raw.matchCount,
    descriptor: absent ? null : Object.freeze({ ...raw.descriptor }),
    postcondition,
    healthStatus:
      postcondition.status === 'fail' ? 'fail' : raw.branchKind === 'canonical' ? 'ok' : 'degraded'
  });
}

export async function evaluateChatGptAnchor({ page, profile = null, uiContract = null, anchorId }) {
  try {
    const raw = await page.evaluate(compileChatGptAnchorEvaluator({ profile, uiContract, anchorId }));
    return parseChatGptAnchorEvaluation(raw);
  } catch {
    return apparatus('eval', 'evaluation-threw');
  }
}
