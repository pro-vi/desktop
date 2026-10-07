import { createHash } from 'node:crypto';

export const CHATGPT_CHAT_RECIPIENT = Object.freeze({ kind: 'chat' });
export const DOT_SUBMISSION_STATES = Object.freeze(['not-submitted', 'unknown', 'submitted']);
export const DOT_QUERY_FIELDS = Object.freeze([
  'recipient', 'prompt', 'key', 'tabId', 'timeoutMs', 'fireAndForget', 'source'
]);
export const DOT_HTTP_ERROR_STATUS = Object.freeze({
  invalid_dot_url: 400,
  invalid_recipient: 400,
  invalid_dot_request: 400,
  invalid_dot_binding: 409,
  invalid_dot_submission: 409,
  invalid_dot_run: 409,
  recipient_conflict: 409,
  saved_dot_binding_invalid: 409,
  dot_binding_mismatch: 409,
  dot_binding_unconfirmed: 409,
  dot_reply_unconfirmed: 409,
  dot_delivery_unconfirmed: 409,
  dot_submission_transition_invalid: 409,
  dot_operation_unsupported: 409,
  run_status_unconfirmed: 503
});

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(code);
  return value;
}

function fields(value, required, optional, code) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw invalid(code);
  if (required.some((key) => !Object.hasOwn(value, key))) throw invalid(code);
}

function text(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(code);
  return value.trim();
}

// A navigation locator is not evidence that the page belongs to Dot. Preserve
// route state until the provider observation establishes its meaning.
export function parseDotUrl(value) {
  const input = text(value, 'invalid_dot_url');
  let url;
  try {
    url = new URL(input);
  } catch {
    throw invalid('invalid_dot_url');
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' ||
    url.port || url.username || url.password
  ) throw invalid('invalid_dot_url');
  return url.toString();
}

export function parseChatGptRecipient(value) {
  if (value === undefined) return CHATGPT_CHAT_RECIPIENT;
  const input = record(value, 'invalid_recipient');
  if (input.kind === 'chat') {
    fields(input, ['kind'], [], 'invalid_recipient');
    return CHATGPT_CHAT_RECIPIENT;
  }
  if (input.kind === 'dot') {
    fields(input, ['kind', 'dotUrl'], [], 'invalid_recipient');
    return Object.freeze({ kind: 'dot', dotUrl: parseDotUrl(input.dotUrl) });
  }
  throw invalid('invalid_recipient');
}

export function derivedDotKey(dotUrl) {
  return `dot-${createHash('sha256').update(parseDotUrl(dotUrl)).digest('hex').slice(0, 16)}`;
}

export function parseDotQueryRequest(value) {
  const input = record(value, 'invalid_dot_request');
  fields(input, ['recipient', 'prompt'], DOT_QUERY_FIELDS, 'invalid_dot_request');
  const recipient = parseChatGptRecipient(input.recipient);
  if (recipient.kind !== 'dot') throw invalid('invalid_dot_request');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw invalid('missing_prompt');
  if (input.prompt.length > 200_000) throw invalid('prompt_too_large');
  const output = { recipient, prompt: input.prompt };
  for (const key of ['key', 'tabId', 'source']) {
    if (Object.hasOwn(input, key)) output[key] = text(input[key], 'invalid_dot_request');
  }
  if (Object.hasOwn(input, 'timeoutMs')) {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw invalid('invalid_dot_request');
    output.timeoutMs = input.timeoutMs;
  }
  if (Object.hasOwn(input, 'fireAndForget')) {
    if (typeof input.fireAndForget !== 'boolean') throw invalid('invalid_dot_request');
    output.fireAndForget = input.fireAndForget;
  }
  return output;
}

export function parseDotBinding(value) {
  const input = record(value, 'invalid_dot_binding');
  fields(input, ['dotId', 'dotUrl', 'conversationId', 'conversationUrl'], ['accountId'], 'invalid_dot_binding');
  if (input.accountId !== undefined && input.accountId !== null && typeof input.accountId !== 'string') {
    throw invalid('invalid_dot_binding');
  }
  return Object.freeze({
    dotId: text(input.dotId, 'invalid_dot_binding'),
    dotUrl: parseDotUrl(input.dotUrl),
    conversationId: text(input.conversationId, 'invalid_dot_binding'),
    conversationUrl: parseDotUrl(input.conversationUrl),
    accountId: input.accountId == null ? null : text(input.accountId, 'invalid_dot_binding')
  });
}

export function sameDotBinding(left, right) {
  const a = parseDotBinding(left);
  const b = parseDotBinding(right);
  return a.dotId === b.dotId && a.conversationId === b.conversationId && a.accountId === b.accountId;
}

export function dotConversationScope(binding) {
  const parsed = parseDotBinding(binding);
  const identity = JSON.stringify([parsed.accountId, parsed.dotId, parsed.conversationId]);
  return `dot:${createHash('sha256').update(identity).digest('hex')}`;
}

export function parseDotSubmission(value) {
  const input = record(value, 'invalid_dot_submission');
  fields(input, ['state', 'userMessageId'], [], 'invalid_dot_submission');
  if (!DOT_SUBMISSION_STATES.includes(input.state)) throw invalid('invalid_dot_submission');
  if (input.state === 'submitted') {
    return Object.freeze({ state: 'submitted', userMessageId: text(input.userMessageId, 'invalid_dot_submission') });
  }
  if (input.userMessageId !== null) throw invalid('invalid_dot_submission');
  return Object.freeze({ state: input.state, userMessageId: null });
}

export function initialDotSubmission() {
  return Object.freeze({ state: 'not-submitted', userMessageId: null });
}

export function parseDotKeyMeta(value) {
  const input = record(value, 'saved_dot_binding_invalid');
  try {
    fields(input, ['recipient', 'dotBinding'], [], 'saved_dot_binding_invalid');
    const recipient = parseChatGptRecipient(input.recipient);
    if (recipient.kind !== 'dot') throw invalid('saved_dot_binding_invalid');
    const dotBinding = parseDotBinding(input.dotBinding);
    if (recipient.dotUrl !== dotBinding.dotUrl) throw invalid('saved_dot_binding_invalid');
    return { recipient, dotBinding };
  } catch {
    throw invalid('saved_dot_binding_invalid');
  }
}

export function parseDotRunFields(value) {
  record(value, 'invalid_dot_run');
  const recipient = parseChatGptRecipient(value.recipient);
  if (recipient.kind !== 'dot') throw invalid('invalid_dot_run');
  const dotBinding = value.dotBinding == null ? null : parseDotBinding(value.dotBinding);
  const dotSubmission = parseDotSubmission(value.dotSubmission);
  if (dotSubmission.state !== 'not-submitted' && dotBinding === null) throw invalid('invalid_dot_run');
  return { recipient, dotBinding, dotSubmission };
}
