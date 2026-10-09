import test from 'node:test';
import assert from 'node:assert/strict';
import { unwrapChromeCdpEvaluationResult } from '../chrome-cdp-backend.mjs';
import {
  encodeDotCursor,
  parseDotCursor,
  parseDotBinding,
  parseDotMessageBatch,
  parseDotOperationRequest,
  parseDotSubmission,
  parseChatGptRecipient,
  sameDotBinding,
  dotConversationScope
} from '../chatgpt-recipient.mjs';
import { parseDotPageObservation } from '../chatgpt-dot-ui.mjs';

const binding = {
  dotUrl: 'https://chatgpt.com/dots/fixture-conversation',
  conversationId: 'fixture-conversation', roomId: 'fixture-room',
  peerAeonId: 'fixture-peer', accountKey: 'fixture-account'
};
const message = (id, text = id) => ({ id, sender: 'dot', text, createdAt: '2026-10-08T00:00:00Z', hasAttachments: false, taskCardOnly: false });
const observation = () => ({
  state: 'ready', binding, draftChars: 0, uploadCount: 0, historyAfter: null,
  unconfirmedRequestIds: [], messages: [{
    id: 'user-message', direction: 'outgoing', requestId: 'native-request',
    deliveryState: '', createdAt: '2026-10-08T00:00:00Z',
    hasAttachments: false, taskCardOnly: false, deleted: false
  }]
});

test('Dot binding retains distinct conversation, room, peer, and account identities', () => {
  assert.deepEqual(parseDotBinding(binding), binding);
  assert.deepEqual(parseChatGptRecipient({ kind: 'dot' }), { kind: 'dot', dotUrl: null });
  assert.deepEqual(parseChatGptRecipient(), { kind: 'chat' });
  for (const key of ['conversationId', 'roomId', 'peerAeonId', 'accountKey']) {
    assert.equal(sameDotBinding(binding, { ...binding, [key]: 'another', ...(key === 'conversationId' ? { dotUrl: 'https://chatgpt.com/dots/another' } : {}) }), false);
    assert.notEqual(dotConversationScope(binding), dotConversationScope({ ...binding, [key]: 'another', ...(key === 'conversationId' ? { dotUrl: 'https://chatgpt.com/dots/another' } : {}) }));
  }
  assert.throws(() => parseDotBinding({ ...binding, dotUrl: 'https://chatgpt.com/c/fixture-conversation' }), /invalid_dot_binding/);
  assert.throws(() => parseDotBinding({ ...binding, accountKey: null }), /invalid_dot_binding/);
  assert.deepEqual(parseDotBinding({ ...binding, dotUrl: 'https://chatgpt.com/dots/fixture-route' }), { ...binding, dotUrl: 'https://chatgpt.com/dots/fixture-route' });
});

test('Dot operation schemas preserve text bytes and refuse caller observation stamps', () => {
  assert.deepEqual(parseDotOperationRequest({ text: ' keep\nbytes ' }, 'talk'), { text: ' keep\nbytes ' });
  for (const operation of ['talk', 'read', 'wait']) {
    const valid = operation === 'talk' ? { text: 'fixture' } : operation === 'wait' ? { after: encodeDotCursor(binding, 'tail') } : {};
    for (const key of ['recipient', 'dotBinding', 'dotSubmission', 'sender', 'modeIntent', 'modelIntent', 'attachments', 'contextPaths', 'projectUrl', 'chatUrl']) {
      assert.throws(() => parseDotOperationRequest({ ...valid, [key]: null }, operation), /invalid_dot_request/);
    }
    assert.deepEqual(parseDotOperationRequest(valid, operation), valid);
  }
  assert.throws(() => parseDotOperationRequest({}, 'wait'), /invalid_dot_request/);
  assert.throws(() => parseDotOperationRequest({ text: ' ' }, 'talk'), /invalid_dot_request/);
});

test('Dot cursor remains valid at the current tail and preserves an empty position', () => {
  for (const position of [null, 'current-tail']) {
    const cursor = encodeDotCursor(binding, position);
    assert.deepEqual(parseDotCursor(cursor), { binding, messageId: position });
    assert.deepEqual(parseDotMessageBatch({ binding, messages: [], cursor, hasMore: false, timedOut: true }), { binding, messages: [], cursor, hasMore: false, timedOut: true });
  }
  assert.throws(() => parseDotCursor('bad.cursor'), /invalid_dot_cursor/);
  assert.throws(() => parseDotCursor(Buffer.from(JSON.stringify({ binding, messageId: 'x', observedSender: 'dot' })).toString('base64url')), /invalid_dot_cursor/);
});

test('Dot batches allow several proactive messages without reply parents', () => {
  const messages = [message('first'), message('second')];
  const cursor = encodeDotCursor(binding, 'second');
  assert.deepEqual(parseDotMessageBatch({ binding, messages, cursor, hasMore: false }), { binding, messages, cursor, hasMore: false });
  assert.throws(() => parseDotMessageBatch({ binding, messages, cursor: encodeDotCursor(binding, 'later-unreturned'), hasMore: true }), /invalid_dot_batch/);
  assert.throws(() => parseDotMessageBatch({ binding, messages: [message('first'), message('first')], cursor: encodeDotCursor(binding, 'first'), hasMore: false }), /invalid_dot_batch/);
  assert.throws(() => parseDotMessageBatch({ binding, messages, cursor, hasMore: false, timedOut: true }), /invalid_dot_batch/);
});

test('Dot batches reject a cursor from another native room', () => {
  const foreign = { ...binding, roomId: 'another-room' };
  assert.throws(() => parseDotMessageBatch({ binding, messages: [], cursor: encodeDotCursor(foreign, 'tail'), hasMore: false }), /invalid_dot_batch/);
});

test('Dot checkpoint cannot claim delivery without native request and accepted IDs', () => {
  assert.deepEqual(parseDotSubmission({ state: 'unknown', requestId: 'native-request', userMessageId: null }), { state: 'unknown', requestId: 'native-request', userMessageId: null });
  assert.deepEqual(parseDotSubmission({ state: 'submitted', requestId: 'native-request', userMessageId: 'accepted-id' }), { state: 'submitted', requestId: 'native-request', userMessageId: 'accepted-id' });
  assert.throws(() => parseDotSubmission({ state: 'submitted', requestId: null, userMessageId: 'accepted-id' }), /invalid_dot_submission/);
  assert.throws(() => parseDotSubmission({ state: 'not-submitted', requestId: 'native-request', userMessageId: null }), /invalid_dot_submission/);
});

test('Dot observation decoding agrees for Electron values and CDP envelopes', () => {
  const native = observation();
  assert.deepEqual(parseDotPageObservation(native), parseDotPageObservation(unwrapChromeCdpEvaluationResult({ result: { value: native } })));
  assert.throws(() => parseDotPageObservation({ ...native, binding: { ...binding, roomId: 'another-room' } }, { binding }), /dot_binding_mismatch/);
  assert.throws(() => parseDotPageObservation({ state: 'unconfirmed' }), /dot_binding_unconfirmed/);
  assert.throws(() => parseDotPageObservation({ ...native, messages: [...native.messages, ...native.messages] }), /dot_binding_unconfirmed/);
});
