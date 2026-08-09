import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConversationArtifactDescriptor,
  parseConversationArtifactDownloadBatch,
  parseConversationArtifactDownloadRequest,
  parseConversationArtifactDescriptor,
  parseConversationArtifactInventory,
  parseConversationArtifactProvenance
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

test('conversation-artifact-contract: download request rejects duplicate or excessive keys', () => {
  const key = descriptor().artifactKey;
  assert.throws(() => parseConversationArtifactDownloadRequest({
    artifactKeys: [key, key],
    maxFiles: 2,
    maxBytesPerFile: 1_024,
    timeoutMs: 1_000
  }), /duplicate_artifact_key/);
  assert.throws(() => parseConversationArtifactDownloadRequest({
    artifactKeys: [key, descriptor({ providerMessageId: 'message-2' }).artifactKey],
    maxFiles: 1,
    maxBytesPerFile: 1_024,
    timeoutMs: 1_000
  }), /invalid_item_count/);
});

test('conversation-artifact-contract: provenance is exact and credential-free', () => {
  const item = descriptor();
  const provenance = parseConversationArtifactProvenance({
    schemaVersion: item.schemaVersion,
    artifactKey: item.artifactKey,
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    providerConversationId: item.providerConversationId,
    providerMessageId: item.providerMessageId,
    providerTurnIndex: item.providerTurnIndex,
    occurrenceWithinMessage: item.occurrenceWithinMessage,
    name: item.name,
    kind: item.kind
  });
  assert.equal(provenance.artifactKey, item.artifactKey);
  assert.throws(() => parseConversationArtifactProvenance({
    ...provenance,
    signedUrl: 'https://chatgpt.com/signed'
  }), /unexpected_fields/);
});

test('conversation-artifact-contract: mixed batch preserves saved and failed outcomes', () => {
  const saved = descriptor();
  const missing = descriptor({ providerMessageId: 'message-missing' });
  const provenance = {
    schemaVersion: saved.schemaVersion,
    artifactKey: saved.artifactKey,
    conversationUrl: 'https://chatgpt.com/c/conversation-1',
    providerConversationId: saved.providerConversationId,
    providerMessageId: saved.providerMessageId,
    providerTurnIndex: saved.providerTurnIndex,
    occurrenceWithinMessage: saved.occurrenceWithinMessage,
    name: saved.name,
    kind: saved.kind
  };
  const batch = parseConversationArtifactDownloadBatch({
    outcomes: [
      {
        status: 'saved',
        artifactKey: saved.artifactKey,
        artifact: {
          id: 'artifact-1',
          path: '/tmp/report.md',
          name: 'report.md',
          mime: 'text/markdown',
          kind: 'file',
          savedAt: '2026-08-09T00:00:00.000Z'
        },
        provenance
      },
      { status: 'not_found', artifactKey: missing.artifactKey }
    ],
    requestedCount: 2,
    savedCount: 1
  });
  assert.equal(batch.savedCount, 1);
  assert.deepEqual(batch.outcomes.map((outcome) => outcome.status), ['saved', 'not_found']);
});
