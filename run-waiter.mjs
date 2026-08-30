import {
  isTerminalRunStatus,
  normalizeRunKind,
  normalizeRunStatus,
  validateCompletionReceipt
} from './run-lifecycle.mjs';
import { requestJson } from './mcp-lib.mjs';

export const RUN_EXIT_CODE_BY_STATUS = Object.freeze({
  success: 0,
  error: 2,
  stopped: 3,
  interrupted: 4,
  unverified: 5
});

function runWaitTimeout(lastData) {
  const error = new Error('run_wait_timeout');
  error.data = lastData;
  return error;
}

async function requestWithinDeadline({ request, requestOptions, remaining, signal, lastData }) {
  const controller = new AbortController();
  let timeoutId = null;
  let deadlineWon = false;
  const onAbort = () => controller.abort(signal?.reason || new Error('wait_aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const running = Promise.resolve().then(async () => await request({
    ...requestOptions,
    signal: controller.signal
  }));
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      deadlineWon = true;
      const error = runWaitTimeout(lastData);
      controller.abort(error);
      reject(error);
    }, Math.max(1, remaining));
  });
  try {
    return await Promise.race([running, deadline]);
  } catch (error) {
    if (deadlineWon) {
      running.catch(() => {});
      throw runWaitTimeout(lastData);
    }
    throw error;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

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
    if (remaining <= 0) throw runWaitTimeout(lastData);
    const requestOptions = {
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
      }
    };
    const data = Number.isFinite(remaining)
      ? await requestWithinDeadline({ request, requestOptions, remaining, signal, lastData })
      : await request({ ...requestOptions, signal });
    lastData = data;
    const run = data?.run;
    if (!run) throw new Error('invalid_run_wait_response');
    afterRevision = Math.max(afterRevision, Number(run.revision) || 0);
    const status = normalizeRunStatus(run.status);
    const kind = normalizeRunKind(run.kind);
    if (isTerminalRunStatus(status)) {
      if (status === 'success' && ['query', 'research'].includes(kind)) {
        const receipt = validateCompletionReceipt(run.completionReceipt);
        const expectedReceiptKind = kind === 'query' ? 'assistant-response' : 'research-report';
        if (!receipt || receipt.kind !== expectedReceiptKind) {
          throw new Error('success_without_completion_receipt');
        }
      }
      return data;
    }
  }
}

export function exitCodeForRunStatus(status) {
  return RUN_EXIT_CODE_BY_STATUS[String(status || '').trim().toLowerCase()] ?? 64;
}
