import test from 'node:test';
import assert from 'node:assert/strict';
import { modeIntentForResponseModelSlug, readChatGptResponseMode, responseModeFromConversation } from '../chatgpt-response-mode.mjs';

const conversationUrl = 'https://chatgpt.com/c/conversation';
const providerMessageId = 'answer';
const payload = () => ({
  conversation_id: 'conversation',
  default_model_slug: 'gpt-6-thinking',
  messages: [{ id: 'answer', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5-6-pro', requested_model_slug: 'gpt-5-6-pro', default_model_slug: 'gpt-6-thinking' } }]
});

test('response mode uses the exact assistant message, not the conversation default', () => {
  const observed = responseModeFromConversation(payload(), { conversationUrl, providerMessageId });
  assert.equal(observed.modelSlug, 'gpt-5-6-pro');
  assert.equal(modeIntentForResponseModelSlug(observed.modelSlug), 'extended-pro');
  const fallback = payload();
  fallback.messages[0].metadata.model_slug = 'gpt-6-thinking';
  assert.equal(modeIntentForResponseModelSlug(responseModeFromConversation(fallback, { conversationUrl, providerMessageId }).modelSlug), 'thinking');
  fallback.messages[0].metadata.resolved_model_slug = 'gpt-6-pro';
  assert.equal(responseModeFromConversation(fallback, { conversationUrl, providerMessageId }).resolvedModelSlug, 'gpt-6-pro');
  assert.equal(modeIntentForResponseModelSlug('new-provider-model'), null);
});

test('response mode refuses wrong conversation, wrong message, duplicate identity, and requested-only metadata', () => {
  for (const change of [
    (p) => { p.conversation_id = 'other'; },
    (p) => { p.messages[0].id = 'other'; },
    (p) => { p.messages[0].author.role = 'user'; },
    (p) => { p.messages.push({ ...p.messages[0] }); },
    (p) => { delete p.messages[0].metadata.model_slug; }
  ]) {
    const data = payload();
    change(data);
    assert.equal(responseModeFromConversation(data, { conversationUrl, providerMessageId }), null);
  }
});

function transport({ omitResponse = false, invalidBody = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const emit = async (method, params) => { for (const handler of handlers.get(method) || []) await handler(params); };
  return {
    calls,
    handlers,
    subscribe(method, handler) {
      const group = handlers.get(method) || [];
      handlers.set(method, [...group, handler]);
      return () => handlers.set(method, handlers.get(method).filter((item) => item !== handler));
    },
    async sendCommand(method, params) {
      calls.push({ method, params });
      if (method === 'Page.reload' && !omitResponse) {
        await emit('Network.responseReceived', { requestId: 'foreign', response: { status: 200, url: 'https://example.test/backend-api/conversations/conversation' } });
        await emit('Network.loadingFinished', { requestId: 'foreign' });
        await emit('Network.responseReceived', { requestId: 'other', response: { status: 200, url: 'https://chatgpt.com/backend-api/conversations/other' } });
        await emit('Network.loadingFinished', { requestId: 'other' });
        await emit('Network.responseReceived', { requestId: 'owned', response: { status: 200, url: 'https://chatgpt.com/backend-api/conversations/conversation' } });
        await emit('Network.loadingFinished', { requestId: 'owned' });
      }
      if (method === 'Network.getResponseBody') return { base64Encoded: true, body: Buffer.from(invalidBody ? 'invalid' : JSON.stringify(payload())).toString('base64') };
      return {};
    }
  };
}

test('response metadata read reloads the completed conversation without submitting a prompt', async () => {
  const api = transport();
  const evidence = await readChatGptResponseMode({ ...api, conversationUrl, providerMessageId });
  assert.equal(evidence.modelSlug, 'gpt-5-6-pro');
  assert.deepEqual(api.calls.map(({ method }) => method), ['Network.enable', 'Page.reload', 'Network.getResponseBody', 'Network.disable']);
  assert.equal(api.calls.find(({ method }) => method === 'Network.getResponseBody').params.requestId, 'owned');
  assert.ok([...api.handlers.values()].every((group) => group.length === 0));
});

test('failed or missing response metadata stays unknown and disposes every listener', async () => {
  for (const options of [{ omitResponse: true }, { invalidBody: true }]) {
    const api = transport(options);
    assert.equal(await readChatGptResponseMode({ ...api, conversationUrl, providerMessageId, timeoutMs: 5 }), null);
    assert.ok([...api.handlers.values()].every((group) => group.length === 0));
    assert.equal(api.calls.at(-1).method, 'Network.disable');
  }
});

test('response metadata read does not reload unowned or non-conversation locations', async () => {
  for (const url of ['https://example.test/c/conversation', 'https://chatgpt.com/', 'https://chatgpt.com/dots/home']) {
    const api = transport();
    assert.equal(await readChatGptResponseMode({ ...api, conversationUrl: url, providerMessageId }), null);
    assert.equal(api.calls.length, 0);
  }
});
