import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePersistedChatGptLocation,
  derivedChatKey,
  parseChatGptEntryTarget,
  resolveChatGptLocation
} from '../chatgpt-location.mjs';

test('chatgpt-location: parses supported entry URL families', () => {
  assert.deepEqual(parseChatGptEntryTarget('https://chatgpt.com/c/abc?x=1'), {
    kind: 'canonical-conversation',
    chatUrl: 'https://chatgpt.com/c/abc'
  });
  assert.deepEqual(parseChatGptEntryTarget('https://chatgpt.com/share/shared-1'), {
    kind: 'shared-snapshot',
    chatUrl: 'https://chatgpt.com/share/shared-1'
  });
});

test('chatgpt-location: rejects foreign malformed and ambiguous URLs', () => {
  for (const value of ['http://chatgpt.com/c/a', 'https://example.com/c/a', 'https://chatgpt.com/g/g-custom/c/a', 'nope']) {
    assert.throws(() => parseChatGptEntryTarget(value), /invalid_chatgpt_url/);
  }
});

test('chatgpt-location: legacy standalone conversation clears stale project', () => {
  assert.deepEqual(decodePersistedChatGptLocation({
    projectUrl: 'https://chatgpt.com/g/g-p-agentify/project',
    conversationUrl: 'https://chatgpt.com/c/private-copy'
  }), {
    kind: 'standalone-conversation',
    conversationUrl: 'https://chatgpt.com/c/private-copy'
  });
});

test('chatgpt-location: explicit chat outranks saved and default project', () => {
  const resolved = resolveChatGptLocation({
    chatUrl: 'https://chatgpt.com/c/private-copy',
    savedMeta: { projectUrl: 'https://chatgpt.com/g/g-p-saved/project' },
    defaultProjectUrl: 'https://chatgpt.com/g/g-p-default/project'
  });
  assert.equal(resolved.source, 'explicit-chat');
  assert.equal(resolved.location.kind, 'standalone-conversation');
});

test('chatgpt-location: explicit chat and project conflict', () => {
  assert.throws(() => resolveChatGptLocation({
    chatUrl: 'https://chatgpt.com/c/a',
    projectUrl: 'https://chatgpt.com/g/g-p-a/project'
  }), /chatgpt_location_conflict/);
});

test('chatgpt-location: derives stable isolated keys', () => {
  assert.equal(derivedChatKey('https://chatgpt.com/share/a'), derivedChatKey('https://chatgpt.com/share/a#fragment'));
  assert.match(derivedChatKey('https://chatgpt.com/share/a'), /^chat-[a-f0-9]{16}$/);
});

