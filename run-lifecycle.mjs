export const LIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'blocked']);
export const TERMINAL_RUN_STATUSES = Object.freeze(['success', 'error', 'stopped', 'interrupted', 'unverified']);
export const RUN_STATUSES = Object.freeze([...LIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);

export const TERMINAL_PHASE_BY_STATUS = Object.freeze({
  success: 'completed',
  error: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
  unverified: 'unverified'
});

const COMPLETION_VERIFICATION_REASONS = Object.freeze([
  'missing_completion_receipt',
  'invalid_completion_receipt',
  'completion_receipt_kind_mismatch'
]);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || '').trim().toLowerCase());
}

export function normalizeRunStatus(value, { fallback = 'queued' } = {}) {
  const status = String(value || '').trim().toLowerCase();
  if (RUN_STATUSES.includes(status)) return status;
  if (value == null || value === '') return fallback;
  throw new Error(`invalid_run_status:${status}`);
}

export function normalizeRunKind(value, { fallback = 'query' } = {}) {
  const kind = String(value || '').trim().toLowerCase();
  return kind || fallback;
}

export function phaseForRunStatus(status, phase = null) {
  const normalizedStatus = normalizeRunStatus(status);
  if (normalizedStatus === 'blocked') return String(phase || '').trim() || 'blocked';
  return TERMINAL_PHASE_BY_STATUS[normalizedStatus] || String(phase || '').trim() || null;
}

export function validateCompletionReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || '').trim();
  const responsePath = String(value.responsePath || '').trim();
  const responseSha256 = String(value.responseSha256 || '').trim().toLowerCase();
  const capturedAt = Number(value.capturedAt);
  if (Number(value.version) !== 1) return null;
  if (!['assistant-response', 'research-report'].includes(kind)) return null;
  if (!responsePath || !/^[a-f0-9]{64}$/.test(responseSha256)) return null;
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return null;
  return {
    version: 1,
    kind,
    responsePath,
    metadataPath: String(value.metadataPath || '').trim() || null,
    artifactIds: Array.isArray(value.artifactIds)
      ? value.artifactIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    responseSha256,
    conversationUrl: String(value.conversationUrl || '').trim() || null,
    capturedAt
  };
}

export function validateCompletionVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'legacyStatus' || keys[1] !== 'reason' || keys[2] !== 'status') return null;
  if (value.status !== 'legacy-unverified' || value.legacyStatus !== 'success') return null;
  if (!COMPLETION_VERIFICATION_REASONS.includes(value.reason)) return null;
  return {
    status: 'legacy-unverified',
    legacyStatus: 'success',
    reason: value.reason
  };
}

export function assertRunLifecycle(run, { requireCompletionReceipt = false } = {}) {
  const status = normalizeRunStatus(run?.status);
  const kind = normalizeRunKind(run?.kind);
  const terminal = isTerminalRunStatus(status);
  if (terminal !== !!run?.finishedAt) throw new Error('invalid_run_finished_at');
  if (terminal && phaseForRunStatus(status, run?.phase) !== run?.phase) throw new Error('invalid_run_terminal_phase');
  if (run?.phase === 'reconciling_response' && (status !== 'running' || run?.finishedAt)) {
    throw new Error('invalid_run_reconciling_state');
  }
  const receipt = validateCompletionReceipt(run?.completionReceipt);
  const completionVerification = validateCompletionVerification(run?.completionVerification);
  if (run?.completionReceipt && !receipt) throw new Error('invalid_completion_receipt');
  if (run?.completionVerification && !completionVerification) throw new Error('invalid_completion_verification');
  if (requireCompletionReceipt && status === 'success' && ['query', 'research'].includes(kind) && !receipt) {
    throw new Error('missing_completion_receipt');
  }
  const expectedReceiptKind = kind === 'query'
    ? 'assistant-response'
    : kind === 'research'
      ? 'research-report'
      : null;
  if (receipt && expectedReceiptKind && receipt.kind !== expectedReceiptKind) {
    throw new Error('completion_receipt_kind_mismatch');
  }
  if (receipt && status !== 'success') throw new Error('completion_receipt_requires_success');
  if (status === 'unverified' && !['query', 'research'].includes(kind)) {
    throw new Error('invalid_unverified_run_kind');
  }
  if (status === 'unverified' && !completionVerification) throw new Error('missing_completion_verification');
  if (completionVerification && status !== 'unverified') {
    throw new Error('completion_verification_requires_unverified');
  }
  return run;
}
