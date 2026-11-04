import { locationFromConversationUrl } from './chatgpt-location.mjs';
import { providerConversationIdFromOwnedLocation } from './conversation-identity.mjs';

export function modeIntentForResponseModelSlug(value) {
  const match = /^gpt-\d+(?:[.-]\d+)*-(pro|thinking|instant)$/.exec(String(value || ''));
  if (!match) return null;
  return match[1] === 'pro' ? 'extended-pro' : match[1];
}

export function responseModeEvidenceForMessage(value, { conversationUrl, providerMessageId } = {}) {
  if (!value || value.source !== 'response_metadata' || !providerMessageId || value.providerMessageId !== providerMessageId) return null;
  let conversationId;
  try { conversationId = providerConversationIdFromOwnedLocation(locationFromConversationUrl(conversationUrl)); } catch { return null; }
  if (value.conversationId !== conversationId || typeof value.modelSlug !== 'string' || !/^[a-z0-9._-]{1,160}$/i.test(value.modelSlug)) return null;
  return {
    source: 'response_metadata',
    conversationId,
    providerMessageId,
    modelSlug: value.modelSlug,
    resolvedModelSlug: typeof value.resolvedModelSlug === 'string' && /^[a-z0-9._-]{1,160}$/i.test(value.resolvedModelSlug) ? value.resolvedModelSlug : null,
    requestedModelSlug: typeof value.requestedModelSlug === 'string' && /^[a-z0-9._-]{1,160}$/i.test(value.requestedModelSlug) ? value.requestedModelSlug : null
  };
}

// Each refusal returns { unavailable: <reason> } naming the check that failed,
// so a run left unverified can record why.
export function responseModeFromConversation(payload, { conversationUrl, providerMessageId } = {}) {
  if (!Array.isArray(payload?.messages)) return { unavailable: 'conversation_messages_missing' };
  const matches = payload.messages.filter((item) => item?.id === providerMessageId);
  if (matches.length === 0) return { unavailable: 'answer_message_not_found' };
  if (matches.length > 1) return { unavailable: 'answer_message_ambiguous' };
  const message = matches[0];
  if (message.author?.role !== 'assistant') return { unavailable: 'answer_message_not_assistant' };
  if (message.metadata?.model_slug == null) return { unavailable: 'answer_model_slug_missing' };
  return responseModeEvidenceForMessage({
    source: 'response_metadata',
    conversationId: payload.conversation_id,
    providerMessageId: message.id,
    modelSlug: message.metadata?.model_slug,
    resolvedModelSlug: message.metadata?.resolved_model_slug,
    requestedModelSlug: message.metadata?.requested_model_slug
  }, { conversationUrl, providerMessageId }) || { unavailable: 'answer_metadata_invalid' };
}

// ChatGPT web observed 2026-10-11 loads saved message metadata through its own
// authenticated request when a conversation reloads. The composer reflects the
// next request's mode; it is not evidence of the model used for this answer.
export async function readChatGptResponseMode({ conversationUrl, providerMessageId, sendCommand, subscribe, timeoutMs = 30_000 } = {}) {
  let conversationId;
  try { conversationId = providerConversationIdFromOwnedLocation(locationFromConversationUrl(conversationUrl)); } catch { return { unavailable: 'conversation_url_unowned' }; }
  if (!providerMessageId) return { unavailable: 'answer_message_id_missing' };
  const expectedPath = `/backend-api/conversations/${conversationId}`;
  let settled = false;
  let finish;
  const outcome = new Promise((resolve) => { finish = (value) => { if (!settled) { settled = true; resolve(value); } }; });
  const requests = new Set();
  const bodyReads = new Set();
  let sawConversationResponse = false;
  let refusedStatus = null;
  const unsubscribeResponse = subscribe('Network.responseReceived', ({ requestId, response }) => {
    if (settled) return;
    let url;
    try { url = new URL(response?.url); } catch { return; }
    if (url.origin !== 'https://chatgpt.com' || url.pathname !== expectedPath) return;
    if (response.status === 200) {
      sawConversationResponse = true;
      requests.add(requestId);
    } else if (Number.isInteger(response.status)) refusedStatus = response.status;
  });
  const unsubscribeFinished = subscribe('Network.loadingFinished', async ({ requestId }) => {
    if (settled || !requests.delete(requestId)) return;
    const reading = Promise.resolve().then(() => sendCommand('Network.getResponseBody', { requestId }));
    bodyReads.add(reading);
    let payload;
    try {
      const response = await reading;
      payload = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
    } catch (error) {
      return finish({ unavailable: error instanceof SyntaxError ? 'conversation_body_not_json' : 'conversation_body_unreadable' });
    } finally { bodyReads.delete(reading); }
    finish(responseModeFromConversation(payload, { conversationUrl, providerMessageId }));
  });
  const timer = setTimeout(() => finish({
    unavailable: sawConversationResponse
      ? 'conversation_body_timeout'
      : refusedStatus ? `conversation_response_status_${refusedStatus}` : 'conversation_response_not_seen'
  }), Math.max(1, timeoutMs));
  let step = 'network_enable_failed';
  try {
    await sendCommand('Network.enable');
    step = 'page_reload_failed';
    if (!settled) await sendCommand('Page.reload', { ignoreCache: false });
    return await outcome;
  } catch {
    return { unavailable: step };
  } finally {
    settled = true;
    clearTimeout(timer);
    unsubscribeResponse();
    unsubscribeFinished();
    // Keep the operation pending until browser work settles. Its caller can
    // finish at a host deadline while quarantining this tab against late work.
    await Promise.allSettled([...bodyReads]);
    await sendCommand('Network.disable').catch(() => {});
  }
}
