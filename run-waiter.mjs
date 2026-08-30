import { isTerminalRunStatus, validateCompletionReceipt } from './run-lifecycle.mjs';
import { requestJson } from './mcp-lib.mjs';

export const RUN_EXIT_CODE_BY_STATUS = Object.freeze({
  success: 0,
  error: 2,
  stopped: 3,
  interrupted: 4
});

export async function waitForRun({
  conn,
  runId,
  timeoutMs = 0,
  includeOutputText = true,
  maxOutputChars,
  signal,
  request = requestJson
} = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new Error('missing_run_id');
  const startedAt = Date.now();
  let afterRevision = 0;
  let lastData = null;
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('wait_aborted');
    const remaining = timeoutMs > 0 ? timeoutMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      const error = new Error('run_wait_timeout');
      error.data = lastData;
      throw error;
    }
    const data = await request({
      ...conn,
      method: 'POST',
      path: '/runs/wait',
      body: {
        runId: id,
        view: 'summary',
        afterRevision,
        waitTimeoutMs: Math.min(30_000, Number.isFinite(remaining) ? Math.max(1, remaining) : 25_000),
        includeOutputText,
        maxOutputChars
      },
      signal
    });
    lastData = data;
    const run = data?.run;
    if (!run) throw new Error('invalid_run_wait_response');
    afterRevision = Math.max(afterRevision, Number(run.revision) || 0);
    if (isTerminalRunStatus(run.status)) {
      if (run.status === 'success' && ['query', 'research'].includes(run.kind) && !validateCompletionReceipt(run.completionReceipt)) {
        throw new Error('success_without_completion_receipt');
      }
      return data;
    }
  }
}

export function exitCodeForRunStatus(status) {
  return RUN_EXIT_CODE_BY_STATUS[String(status || '').trim().toLowerCase()] ?? 64;
}
