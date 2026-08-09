import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConversationArtifactDescriptor,
  parseConversationArtifactDescriptor,
  parseConversationArtifactInventory
} from '../conversation-artifact-contract.mjs';

function descriptor(overrides = {}) {
  return createConversationArtifactDescriptor({
    providerConversationId: 'conversation-1',
    providerMessageId: 'message-1',
    providerTurnIndex: 2,
    occurrenceWithinMessage: 0,
    name: 'report.md',
    ...overrides
  });
}

test('conversation-artifact-contract: filename is not artifact identity', () => {
  const first = descriptor({ name: 'first.md' });
  const renamed = descriptor({ name: 'renamed.md' });
  const otherMessage = descriptor({ providerMessageId: 'message-2', name: 'first.md' });

  assert.equal(first.artifactKey, renamed.artifactKey);
  assert.notEqual(first.artifactKey, otherMessage.artifactKey);
});

test('conversation-artifact-contract: descriptor rejects unknown and extra fields', () => {
  const valid = descriptor();
  assert.throws(
    () => parseConversationArtifactDescriptor({ ...valid, href: 'https://example.test/signed' }),
    /unexpected_fields/
  );
  assert.throws(
    () => parseConversationArtifactDescriptor({ ...valid, kind: 'canvas' }),
    /unknown_kind/
  );
});

test('conversation-artifact-contract: inventory rejects duplicate identities', () => {
  const item = descriptor();
  assert.throws(
    () => parseConversationArtifactInventory({ status: 'complete', items: [item, item] }),
    /duplicate_artifact_key/
  );
});
