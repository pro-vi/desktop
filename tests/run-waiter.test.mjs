import test from 'node:test';
import assert from 'node:assert/strict';

import { exitCodeForRunStatus, waitForRun } from '../run-waiter.mjs';

test('run waiter follows revisions until a receipt-backed terminal result', async () => {
  const bodies = [];
  const responses = [
    { ok: true, run: { id: 'run-1', status: 'running', revision: 3 } },
    { ok: true, run: { id: 'run-1', kind: 'query', status: 'success', revision: 4, completionReceipt: {
      version: 1,
      kind: 'assistant-response',
      responsePath: '/tmp/response.md',
      responseSha256: 'a'.repeat(64),
      capturedAt: 1
    } }, outputText: 'done' }
  ];
  const result = await waitForRun({
    conn: { baseUrl: 'http://127.0.0.1', token: 't' },
    runId: 'run-1',
    request: async ({ body }) => {
      bodies.push(body);
      return responses.shift();
    }
  });
  assert.equal(result.run.status, 'success');
  assert.equal(result.outputText, 'done');
  assert.deepEqual(bodies.map((body) => body.afterRevision), [0, 3]);
  assert.ok(bodies.every((body) => body.view === 'summary'));
});

test('run waiter refuses a legacy output success without completion proof', async () => {
  await assert.rejects(() => waitForRun({
    conn: {},
    runId: 'legacy-success',
    request: async () => ({ ok: true, run: { id: 'legacy-success', kind: 'query', status: 'success', revision: 1 } })
  }), /success_without_completion_receipt/);
});

test('run waiter applies normalized matching-receipt checks before returning success', async () => {
  const cases = [
    { kind: 'query', status: 'SUCCESS', completionReceipt: null },
    { kind: 'QUERY', status: 'success', completionReceipt: null },
    {
      kind: 'research',
      status: 'success',
      completionReceipt: {
        version: 1,
        kind: 'assistant-response',
        responsePath: '/tmp/response.md',
        responseSha256: 'a'.repeat(64),
        capturedAt: 1
      }
    }
  ];
  for (const [index, run] of cases.entries()) {
    await assert.rejects(() => waitForRun({
      conn: {},
      runId: `invalid-success-${index}`,
      request: async () => ({
        ok: true,
        run: { id: `invalid-success-${index}`, revision: 1, ...run }
      })
    }), /success_without_completion_receipt/);
  }
});

test('run waiter returns explicit legacy unverified terminal history without claiming success', async () => {
  const result = await waitForRun({
    conn: {},
    runId: 'legacy-unverified',
    timeoutMs: 20,
    request: async () => ({
      ok: true,
      run: {
        id: 'legacy-unverified',
        kind: 'query',
        status: 'unverified',
        phase: 'unverified',
        finishedAt: 2,
        revision: 1,
        completionVerification: {
          status: 'legacy-unverified',
          legacyStatus: 'success',
          reason: 'missing_completion_receipt'
        }
      }
    })
  });
  assert.equal(result.run.status, 'unverified');
  assert.equal(exitCodeForRunStatus(result.run.status), 5);
});

test('run waiter timeout carries the latest non-mutating run snapshot', async () => {
  let requests = 0;
  await assert.rejects(() => waitForRun({
    conn: {},
    runId: 'still-running',
    timeoutMs: 20,
    request: async ({ signal }) => {
      requests += 1;
      if (requests === 1) {
        return {
          ok: true,
          run: {
            id: 'still-running',
            kind: 'query',
            status: 'running',
            phase: 'reconciling_response',
            revision: 3,
            responseDebug: { version: 1, count: 0 }
          }
        };
      }
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  }), (error) => {
    assert.equal(error?.message, 'run_wait_timeout');
    assert.equal(error?.data?.run?.phase, 'reconciling_response');
    assert.equal(error?.data?.run?.responseDebug?.count, 0);
    return true;
  });
  assert.equal(requests, 2);
});

test('run waiter deadline wins over a terminal response that arrives too late', async () => {
  await assert.rejects(() => waitForRun({
    conn: {},
    runId: 'late-terminal',
    timeoutMs: 5,
    request: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        run: {
          id: 'late-terminal',
          kind: 'query',
          status: 'success',
          revision: 2,
          completionReceipt: {
            version: 1,
            kind: 'assistant-response',
            responsePath: '/tmp/response.md',
            responseSha256: 'a'.repeat(64),
            capturedAt: 1
          }
        }
      };
    }
  }), /run_wait_timeout/);
});

test('run waiter exit codes distinguish every terminal outcome', () => {
  assert.equal(exitCodeForRunStatus('success'), 0);
  assert.equal(exitCodeForRunStatus('error'), 2);
  assert.equal(exitCodeForRunStatus('stopped'), 3);
  assert.equal(exitCodeForRunStatus('interrupted'), 4);
  assert.equal(exitCodeForRunStatus('unverified'), 5);
  assert.equal(exitCodeForRunStatus('running'), 64);
});
