import test from 'node:test';
import assert from 'node:assert/strict';

import {
  derivedDotKey,
  dotConversationScope,
  initialDotSubmission,
  parseChatGptRecipient,
  parseDotBinding,
  parseDotKeyMeta,
  parseDotQueryRequest,
  parseDotRunFields,
  parseDotSubmission,
  parseDotUrl,
  sameDotBinding
} from '../chatgpt-recipient.mjs';
import {
  assertDotReplyEvidence,
  completionEvidenceFor,
  parseCompletionEvidence
} from '../chatgpt-completion-evidence.mjs';
import { normalizePersistedChatGptKeyMeta } from '../chatgpt-mode-intent.mjs';

// These locators and identifiers are synthetic; they establish no provider
// pathname, DOM selector, or runtime capability.
const dotUrl = 'https://chatgpt.com/dot/fixture?conversation=fixture#view';
const recipient = { kind: 'dot', dotUrl };
const binding = {
  dotId: 'fixture-dot', dotUrl,
  conversationId: 'fixture-conversation',
  conversationUrl: dotUrl,
  accountId: 'fixture-account'
};

test('Dot locators preserve route state without claiming provider identity', () => {
  assert.equal(parseDotUrl(` ${dotUrl} `), dotUrl);
  assert.equal(parseDotUrl('https://chatgpt.com/work/fixture'), 'https://chatgpt.com/work/fixture');
  for (const value of ['', null, 1, 'broken', 'http://chatgpt.com/', 'https://example.com/', 'https://chatgpt.com:8443/', 'https://fixture:fixture@chatgpt.com/']) {
    assert.throws(() => parseDotUrl(value), { code: 'invalid_dot_url' });
  }
});

test('Dot requires an explicit recipient and has no reasoning aliases', () => {
  assert.deepEqual(parseChatGptRecipient(), { kind: 'chat' });
  assert.deepEqual(parseChatGptRecipient(recipient), recipient);
  for (const input of [null, 'dot', [], { kind: 'work' }, { kind: 'none' }, { kind: 'dot' }, { kind: 'chat', dotUrl }]) {
    assert.throws(() => parseChatGptRecipient(input), { code: 'invalid_recipient' });
  }
});

test('Dot request validation preserves prompt bytes and rejects unowned fields', () => {
  const input = { recipient, prompt: '  keep these\nlines  ', key: ' fixture ', timeoutMs: 100, fireAndForget: false };
  assert.deepEqual(parseDotQueryRequest(input), { ...input, key: 'fixture' });
  const forbidden = ['dotBinding', 'dotSubmission', 'observedAuthor', 'modeIntent', 'modelIntent', 'model', 'chatUrl', 'projectUrl', 'imageGeneration', 'attachments', 'contextPaths', 'bundleName', 'liveSourceId'];
  for (const field of forbidden) {
    assert.throws(() => parseDotQueryRequest({ recipient, prompt: 'test', [field]: null }), { code: 'invalid_dot_request' });
  }
  for (const extra of [{ key: '' }, { tabId: 1 }, { timeoutMs: 0 }, { timeoutMs: '1' }, { fireAndForget: 'false' }]) {
    assert.throws(() => parseDotQueryRequest({ recipient, prompt: 'test', ...extra }), { code: 'invalid_dot_request' });
  }
});

test('Dot binding validation carries identity independently from locator spelling', () => {
  assert.deepEqual(parseDotBinding(binding), binding);
  assert.equal(sameDotBinding(binding, { ...binding, dotUrl: 'https://chatgpt.com/renamed-fixture' }), true);
  for (const patch of [{ dotId: '' }, { conversationId: null }, { accountId: '' }, { extra: true }]) {
    assert.throws(() => parseDotBinding({ ...binding, ...patch }), { code: 'invalid_dot_binding' });
  }
  assert.equal(sameDotBinding(binding, { ...binding, accountId: 'other-account' }), false);
  assert.equal(sameDotBinding(binding, { ...binding, dotId: 'other-dot' }), false);
  assert.equal(sameDotBinding(binding, { ...binding, conversationId: 'other-conversation' }), false);
});

test('Dot conversation leases use observed identity rather than caller key or route alias', () => {
  assert.equal(dotConversationScope(binding), dotConversationScope({ ...binding, dotUrl: 'https://chatgpt.com/alias' }));
  assert.notEqual(dotConversationScope(binding), dotConversationScope({ ...binding, conversationId: 'other' }));
  assert.notEqual(dotConversationScope(binding), dotConversationScope({ ...binding, accountId: 'other' }));
  assert.match(dotConversationScope(binding), /^dot:[a-f0-9]{64}$/);
  assert.equal(derivedDotKey(dotUrl), derivedDotKey(` ${dotUrl} `));
});

test('Dot submission state and accepted user identity change together', () => {
  assert.deepEqual(parseDotSubmission(initialDotSubmission()), { state: 'not-submitted', userMessageId: null });
  assert.deepEqual(parseDotSubmission({ state: 'unknown', userMessageId: null }), { state: 'unknown', userMessageId: null });
  assert.deepEqual(parseDotSubmission({ state: 'submitted', userMessageId: 'user-turn' }), { state: 'submitted', userMessageId: 'user-turn' });
  for (const input of [undefined, { state: 'unknown' }, { state: 'submitted', userMessageId: null }, { state: 'unknown', userMessageId: 'turn' }, { state: 'not-submitted', userMessageId: 'turn' }, { state: 'other', userMessageId: null }]) {
    assert.throws(() => parseDotSubmission(input), { code: 'invalid_dot_submission' });
  }
});

test('Dot stored affinity fails closed without becoming ordinary home', () => {
  assert.deepEqual(parseDotKeyMeta({ recipient, dotBinding: binding }), { recipient, dotBinding: binding });
  for (const input of [{ recipient }, { recipient, dotBinding: {} }, { recipient, dotBinding: binding, modeIntent: 'none' }, { recipient: { ...recipient, dotUrl: 'https://chatgpt.com/other' }, dotBinding: binding }]) {
    assert.throws(() => parseDotKeyMeta(input), { code: 'saved_dot_binding_invalid' });
  }
  for (const malformed of [{ dotBinding: binding }, { recipient: { kind: 'chat' }, dotBinding: binding }]) {
    assert.throws(() => normalizePersistedChatGptKeyMeta(malformed), /saved_dot_binding_invalid/);
  }
});

test('Dot runs never default missing delivery evidence to permission to resend', () => {
  assert.deepEqual(parseDotRunFields({ recipient, dotBinding: null, dotSubmission: initialDotSubmission() }), { recipient, dotBinding: null, dotSubmission: initialDotSubmission() });
  assert.throws(() => parseDotRunFields({ recipient, dotBinding: binding }), { code: 'invalid_dot_submission' });
  assert.throws(() => parseDotRunFields({ recipient, dotBinding: null, dotSubmission: { state: 'unknown', userMessageId: null } }), { code: 'invalid_dot_run' });
});

function dotReplyEvidence() {
  return {
    source: 'dot-message', observedAt: 1, dotBinding: binding,
    userMessageId: 'user-turn', providerMessageId: 'dot-turn',
    authorDotId: binding.dotId, replyToUserMessageId: 'user-turn', completed: true
  };
}

test('Dot completion requires bound author and reply association, not a source label', () => {
  assert.equal(completionEvidenceFor('dot-message'), null);
  assert.deepEqual(parseCompletionEvidence(dotReplyEvidence()), dotReplyEvidence());
  for (const patch of [{ completed: false }, { authorDotId: 'other-dot' }, { replyToUserMessageId: 'unrelated-user-turn' }, { providerMessageId: '' }, { observedAt: 0 }, { taskStatus: 'complete' }]) {
    assert.equal(parseCompletionEvidence({ ...dotReplyEvidence(), ...patch }), null);
  }
  assert.equal(parseCompletionEvidence({ source: 'dot-message', observedAt: 1 }), null);
});

test('Dot output qualification compares evidence with the durable submission', () => {
  const context = { dotBinding: binding, dotSubmission: { state: 'submitted', userMessageId: 'user-turn' } };
  assert.deepEqual(assertDotReplyEvidence(dotReplyEvidence(), context), dotReplyEvidence());
  for (const patch of [
    { dotBinding: { ...binding, accountId: 'another-account' } },
    { dotSubmission: { state: 'unknown', userMessageId: null } },
    { dotSubmission: { state: 'submitted', userMessageId: 'another-user-turn' } }
  ]) {
    assert.throws(() => assertDotReplyEvidence(dotReplyEvidence(), { ...context, ...patch }), { code: 'dot_reply_unconfirmed' });
  }
  assert.throws(() => assertDotReplyEvidence(completionEvidenceFor('assistant-node'), context), { code: 'dot_reply_unconfirmed' });
});
