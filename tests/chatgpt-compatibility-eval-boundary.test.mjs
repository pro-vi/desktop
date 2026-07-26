import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadChatGptCompatibilityProfile } from '../chatgpt-compatibility.mjs';
import {
  evaluateChatGptAnchor,
  parseChatGptAnchorEvaluation
} from '../chatgpt-compatibility-resolver.mjs';

test('eval boundary: malformed and unserializable-looking values become decode incomplete', async () => {
  const malformed = JSON.parse(await readFile(new URL('./fixtures/chatgpt-compatibility/malformed.json', import.meta.url), 'utf8'));
  for (const raw of [malformed, null, undefined, true, { ok: true }, { then: 'not-a-result' }]) {
    assert.deepEqual(parseChatGptAnchorEvaluation(raw), {
      kind: 'apparatus',
      stage: 'decode',
      verdict: 'incomplete',
      reasonCode: 'malformed-evaluation-result'
    });
  }
});

test('eval boundary: evaluator throws become eval incomplete rather than absence', async () => {
  const profile = await loadChatGptCompatibilityProfile();
  const result = await evaluateChatGptAnchor({
    page: { evaluate: async () => { throw new Error('sensitive browser detail'); } },
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
