import test from 'node:test';
import assert from 'node:assert/strict';

import { unwrapChromeCdpEvaluationResult } from '../chrome-cdp-backend.mjs';
import { loadChatGptCompatibilityProfile } from '../chatgpt-compatibility.mjs';
import { evaluateChatGptAnchor } from '../chatgpt-compatibility-resolver.mjs';

const profile = await loadChatGptCompatibilityProfile();
const validRaw = {
  type: 'chatgpt-anchor-resolution',
  schemaVersion: 1,
  ok: true,
  anchorId: 'prompt-textarea',
  branchId: null,
  branchKind: null,
  branchSource: null,
  selectorHash: null,
  rolloutSignature: 'a'.repeat(64),
  matchCount: 0,
  descriptor: null,
  postcondition: { status: 'fail', reasonCode: 'anchor-absent' }
};

test('backend parity: Electron direct and Chrome CDP wrapped values decode identically', async () => {
  const electron = await evaluateChatGptAnchor({ page: { evaluate: async () => validRaw }, profile, anchorId: 'prompt-textarea' });
  const chrome = await evaluateChatGptAnchor({
    page: { evaluate: async () => unwrapChromeCdpEvaluationResult({ result: { value: validRaw } }) },
    profile,
    anchorId: 'prompt-textarea'
  });
  assert.deepEqual(chrome, electron);
});

test('backend parity sentinel: CDP exceptionDetails is incomplete, never absence', async () => {
  const result = await evaluateChatGptAnchor({
    page: {
      evaluate: async () => unwrapChromeCdpEvaluationResult({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'sensitive' } },
        result: { type: 'object' }
      })
    },
    profile,
    anchorId: 'prompt-textarea'
  });
  assert.deepEqual(result, {
    kind: 'apparatus',
    stage: 'eval',
    verdict: 'incomplete',
    reasonCode: 'evaluation-threw'
  });
});
