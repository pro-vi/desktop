import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatConversationIdentity,
  identityFromOwnedLocation,
  parseConversationIdentity,
  parseProfileScopeId,
  providerConversationIdFromOwnedLocation,
  sameConversationIdentity
} from '../conversation-identity.mjs';
import { locationFromConversationUrl } from '../chatgpt-location.mjs';

test('conversation identity: scope plus exact provider id is the stable identity', () => {
  const standalone = identityFromOwnedLocation('personal', locationFromConversationUrl('https://chatgpt.com/c/thread-123?ignored=1'));
  const project = identityFromOwnedLocation('personal', locationFromConversationUrl('https://chatgpt.com/g/g-p-work/c/thread-123'));

  assert.deepEqual(standalone, {
    provider: 'chatgpt',
    profileScopeId: 'personal',
    providerConversationId: 'thread-123'
  });
  assert.equal(formatConversationIdentity(standalone), 'chatgpt/personal/thread-123');
  assert.equal(sameConversationIdentity(standalone, project), true);
});

test('conversation identity: label title time and route never enter the key', () => {
  const identity = parseConversationIdentity({
    provider: 'chatgpt',
    profileScopeId: 'profile.one',
    providerConversationId: 'same-id'
  });
  assert.equal(formatConversationIdentity(identity), 'chatgpt/profile.one/same-id');
  assert.throws(() => parseConversationIdentity({ ...identity, title: 'not identity' }), /invalid_conversation_identity/);
});

test('conversation identity: malformed scopes locations and provider ids fail closed', () => {
  for (const value of ['', ' has-space', 'has/slash', '../escape', null]) {
    assert.throws(() => parseProfileScopeId(value), /invalid_profile_scope_id/);
  }
  assert.throws(() => providerConversationIdFromOwnedLocation({ kind: 'home' }), /owned_conversation_required/);
  assert.throws(
    () => providerConversationIdFromOwnedLocation({ kind: 'standalone-conversation', conversationUrl: 'https://chatgpt.com/c/%2F' }),
    /invalid_provider_conversation_id/
  );
});
