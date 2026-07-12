import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRunLifecycle,
  isTerminalRunStatus,
  normalizeRunStatus,
  phaseForRunStatus,
  validateCompletionReceipt
} from '../run-lifecycle.mjs';

test('run lifecycle closes statuses and derives terminal phases', () => {
  assert.equal(isTerminalRunStatus('success'), true);
  assert.equal(isTerminalRunStatus('running'), false);
  assert.equal(phaseForRunStatus('interrupted', 'waiting_for_response'), 'interrupted');
  assert.throws(() => normalizeRunStatus('timeout'), /invalid_run_status:timeout/);
});

test('run lifecycle rejects finished live and live reconciling contradictions', () => {
  assert.throws(() => assertRunLifecycle({ status: 'running', phase: 'waiting_for_response', finishedAt: 1 }), /invalid_run_finished_at/);
  assert.throws(() => assertRunLifecycle({ status: 'blocked', phase: 'reconciling_response', finishedAt: null }), /invalid_run_reconciling_state/);
});

test('completion receipt validates proof-bearing fields', () => {
  const receipt = validateCompletionReceipt({
    version: 1,
    kind: 'assistant-response',
    responsePath: '/tmp/response.md',
    artifactIds: ['response'],
    responseSha256: 'a'.repeat(64),
    capturedAt: 123
  });
  assert.equal(receipt?.responsePath, '/tmp/response.md');
  assert.equal(validateCompletionReceipt({ version: 1, kind: 'assistant-response' }), null);
});

test('output-bearing success requires a completion receipt', () => {
  assert.throws(() => assertRunLifecycle({
    kind: 'query',
    status: 'success',
    phase: 'completed',
    finishedAt: 1
  }, { requireCompletionReceipt: true }), /missing_completion_receipt/);
});
