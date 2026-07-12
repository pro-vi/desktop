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
});

test('run waiter refuses a legacy output success without completion proof', async () => {
  await assert.rejects(() => waitForRun({
    conn: {},
    runId: 'legacy-success',
    request: async () => ({ ok: true, run: { id: 'legacy-success', kind: 'query', status: 'success', revision: 1 } })
  }), /success_without_completion_receipt/);
});

test('run waiter exit codes distinguish every terminal outcome', () => {
  assert.equal(exitCodeForRunStatus('success'), 0);
  assert.equal(exitCodeForRunStatus('error'), 2);
  assert.equal(exitCodeForRunStatus('stopped'), 3);
  assert.equal(exitCodeForRunStatus('interrupted'), 4);
  assert.equal(exitCodeForRunStatus('running'), 64);
});
