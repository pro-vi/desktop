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
  assert.equal(isTerminalRunStatus('unverified'), true);
  assert.equal(isTerminalRunStatus('running'), false);
  assert.equal(phaseForRunStatus('interrupted', 'waiting_for_response'), 'interrupted');
  assert.equal(phaseForRunStatus('unverified', 'completed'), 'unverified');
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

test('query and research success require the matching receipt kind', () => {
  const base = {
    status: 'success',
    phase: 'completed',
    finishedAt: 1,
    completionReceipt: {
      version: 1,
      responsePath: '/tmp/response.md',
      artifactIds: ['response'],
      responseSha256: 'a'.repeat(64),
      capturedAt: 1
    }
  };
  assert.throws(() => assertRunLifecycle({
    ...base,
    kind: 'query',
    completionReceipt: { ...base.completionReceipt, kind: 'research-report' }
  }, { requireCompletionReceipt: true }), /completion_receipt_kind_mismatch/);
  assert.throws(() => assertRunLifecycle({
    ...base,
    kind: 'research',
    completionReceipt: { ...base.completionReceipt, kind: 'assistant-response' }
  }, { requireCompletionReceipt: true }), /completion_receipt_kind_mismatch/);
});

test('legacy unverified terminal state requires closed completion verification evidence', () => {
  const run = {
    kind: 'query',
    status: 'unverified',
    phase: 'unverified',
    finishedAt: 2,
    completionVerification: {
      status: 'legacy-unverified',
      legacyStatus: 'success',
      reason: 'missing_completion_receipt'
    }
  };
  assert.doesNotThrow(() => assertRunLifecycle(run, { requireCompletionReceipt: true }));
  assert.throws(() => assertRunLifecycle({ ...run, completionVerification: null }, {
    requireCompletionReceipt: true
  }), /missing_completion_verification/);
});
