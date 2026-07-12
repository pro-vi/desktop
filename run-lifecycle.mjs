export const LIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'blocked']);
export const TERMINAL_RUN_STATUSES = Object.freeze(['success', 'error', 'stopped', 'interrupted']);
export const RUN_STATUSES = Object.freeze([...LIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]);

export const TERMINAL_PHASE_BY_STATUS = Object.freeze({
  success: 'completed',
  error: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted'
});

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || '').trim().toLowerCase());
}

export function normalizeRunStatus(value, { fallback = 'queued' } = {}) {
  const status = String(value || '').trim().toLowerCase();
  if (RUN_STATUSES.includes(status)) return status;
  if (value == null || value === '') return fallback;
  throw new Error(`invalid_run_status:${status}`);
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

export function assertRunLifecycle(run, { requireCompletionReceipt = false } = {}) {
  const status = normalizeRunStatus(run?.status);
  const terminal = isTerminalRunStatus(status);
  if (terminal !== !!run?.finishedAt) throw new Error('invalid_run_finished_at');
  if (terminal && phaseForRunStatus(status, run?.phase) !== run?.phase) throw new Error('invalid_run_terminal_phase');
  if (run?.phase === 'reconciling_response' && (status !== 'running' || run?.finishedAt)) {
    throw new Error('invalid_run_reconciling_state');
  }
  const receipt = validateCompletionReceipt(run?.completionReceipt);
  if (run?.completionReceipt && !receipt) throw new Error('invalid_completion_receipt');
  if (requireCompletionReceipt && status === 'success' && ['query', 'research'].includes(run?.kind) && !receipt) {
    throw new Error('missing_completion_receipt');
  }
  if (receipt && status !== 'success') throw new Error('completion_receipt_requires_success');
  return run;
}
