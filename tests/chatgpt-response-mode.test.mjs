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

test('response mode names why it refuses a conversation payload', () => {
  for (const [change, reason] of [
    [(p) => { delete p.messages; }, 'conversation_messages_missing'],
    [(p) => { p.conversation_id = 'other'; }, 'answer_metadata_invalid'],
    [(p) => { p.messages[0].id = 'other'; }, 'answer_message_not_found'],
    [(p) => { p.messages[0].author.role = 'user'; }, 'answer_message_not_assistant'],
    [(p) => { p.messages.push({ ...p.messages[0] }); }, 'answer_message_ambiguous'],
    [(p) => { delete p.messages[0].metadata.model_slug; }, 'answer_model_slug_missing'],
    [(p) => { p.messages[0].metadata.model_slug = 'gpt 6'; }, 'answer_metadata_invalid']
  ]) {
    const data = payload();
    change(data);
    assert.deepEqual(responseModeFromConversation(data, { conversationUrl, providerMessageId }), { unavailable: reason });
  }
});

function transport({ omitResponse = false, invalidBody = false, unfinishedBody = false, refusedStatus = null, failingCommand = null } = {}) {
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
      if (method === failingCommand) throw new Error('Debugger is not attached');
      if (method === 'Page.reload' && refusedStatus) {
        await emit('Network.responseReceived', { requestId: 'owned', response: { status: refusedStatus, url: 'https://chatgpt.com/backend-api/conversations/conversation' } });
        await emit('Network.loadingFinished', { requestId: 'owned' });
      } else if (method === 'Page.reload' && unfinishedBody) {
        await emit('Network.responseReceived', { requestId: 'owned', response: { status: 200, url: 'https://chatgpt.com/backend-api/conversations/conversation' } });
      } else if (method === 'Page.reload' && !omitResponse) {
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

test('failed or missing response metadata stays unknown, names where it stopped, and disposes every listener', async () => {
  for (const [options, reason] of [
    [{ omitResponse: true }, 'conversation_response_not_seen'],
    [{ unfinishedBody: true }, 'conversation_body_timeout'],
    [{ refusedStatus: 404 }, 'conversation_response_status_404'],
    [{ invalidBody: true }, 'conversation_body_not_json'],
    [{ failingCommand: 'Network.getResponseBody' }, 'conversation_body_unreadable'],
    [{ failingCommand: 'Network.enable' }, 'network_enable_failed'],
    [{ failingCommand: 'Page.reload' }, 'page_reload_failed']
  ]) {
    const api = transport(options);
    assert.deepEqual(await readChatGptResponseMode({ ...api, conversationUrl, providerMessageId, timeoutMs: 5 }), { unavailable: reason });
    assert.ok([...api.handlers.values()].every((group) => group.length === 0));
    assert.equal(api.calls.at(-1).method, 'Network.disable');
  }
});

test('response metadata read does not reload unowned or non-conversation locations', async () => {
  for (const url of ['https://example.test/c/conversation', 'https://chatgpt.com/', 'https://chatgpt.com/dots/home']) {
    const api = transport();
    assert.deepEqual(await readChatGptResponseMode({ ...api, conversationUrl: url, providerMessageId }), { unavailable: 'conversation_url_unowned' });
    assert.equal(api.calls.length, 0);
  }
});
