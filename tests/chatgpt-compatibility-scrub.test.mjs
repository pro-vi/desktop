import test from 'node:test';
import assert from 'node:assert/strict';

import { parseChatGptCompatibilityObservation } from '../chatgpt-compatibility-redaction.mjs';

const hash = 'a'.repeat(64);
const common = {
  schemaVersion: 1,
  observationId: 'obs-1',
  attemptId: 'attempt-1',
  observedAt: 1_700_000_000_000,
  contractHash: hash,
  vendorId: 'chatgpt',
  backend: 'electron',
  capabilityId: 'submit'
};

test('compatibility scrub: validates every closed observation variant', () => {
  const { capabilityId: _capabilityId, ...apparatusCommon } = common;
  const rows = [
    { ...common, kind: 'resolution', anchorId: 'send-button', branchId: 'send-button-canonical', branchKind: 'canonical', branchSource: 'contract', selectorHash: 'b'.repeat(64), rolloutSignature: 'c'.repeat(64) },
    { ...common, kind: 'capability', postconditionId: 'submit-acknowledged', status: 'ok', reasonCode: 'postcondition-satisfied', rolloutSignature: 'c'.repeat(64) },
    { ...common, kind: 'terminal', mode: 'dispatch', status: 'satisfied', artifactCount: 0 },
    { ...apparatusCommon, kind: 'apparatus', stage: 'store', verdict: 'incomplete', reasonCode: 'write-failed' }
  ];
  for (const row of rows) assert.deepEqual(parseChatGptCompatibilityObservation(row, { contractHash: hash }), row);
});

test('compatibility scrub sentinel: recursively rejects unknown content-bearing fields', () => {
  for (const leak of [
    { prompt: 'private prompt' },
    { nested: { token: 'secret-token' } },
    { evidence: { url: 'https://example.test/private' } },
    { metadata: { filename: 'private-report.md' } },
    { tabId: 'tab-private' },
    { runId: 'run-private' }
  ]) {
    assert.throws(
      () => parseChatGptCompatibilityObservation({ ...common, kind: 'capability', postconditionId: 'submit-acknowledged', status: 'ok', reasonCode: 'postcondition-satisfied', rolloutSignature: 'c'.repeat(64), ...leak }, { contractHash: hash }),
      /invalid_chatgpt_compatibility_observation/
    );
  }
});

test('compatibility scrub: rejects provider/hash/schema/variant drift', () => {
  const { capabilityId: _capabilityId, ...apparatusCommon } = common;
  const valid = { ...apparatusCommon, kind: 'apparatus', stage: 'decode', verdict: 'incomplete', reasonCode: 'malformed-result' };
  for (const patch of [
    { vendorId: 'gemini' },
    { contractHash: 'b'.repeat(64) },
    { schemaVersion: 2 },
    { kind: 'patch' },
    { backend: 'unknown' },
    { reasonCode: 'https://private.example/token.txt' }
  ]) {
    assert.throws(() => parseChatGptCompatibilityObservation({ ...valid, ...patch }, { contractHash: hash }), /invalid_chatgpt_compatibility_observation/);
  }
});
