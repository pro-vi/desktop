import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CHATGPT_CHAT_RECIPIENT = Object.freeze({ kind: 'chat' });
export const DOT_SUBMISSION_STATES = Object.freeze(['not-submitted', 'unknown', 'submitted']);
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
  dot_delivery_unconfirmed: 409,
  dot_submission_transition_invalid: 409,
  dot_operation_unsupported: 409,
  invalid_dot_cursor: 400,
  invalid_dot_batch: 409,
  dot_cursor_unavailable: 409,
  dot_message_too_large: 409,
  dot_draft_conflict: 409,
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
    fields(input, ['kind'], ['dotUrl'], 'invalid_recipient');
    return Object.freeze({ kind: 'dot', dotUrl: input.dotUrl == null ? null : parseDotUrl(input.dotUrl) });
  }
  throw invalid('invalid_recipient');
}

export function derivedDotKey(dotUrl) {
  if (dotUrl == null) return 'personal-dot';
  return `dot-${createHash('sha256').update(parseDotUrl(dotUrl)).digest('hex').slice(0, 16)}`;
}

export function parseDotBinding(value) {
  const input = record(value, 'invalid_dot_binding');
  fields(input, ['dotUrl', 'conversationId', 'roomId', 'peerAeonId', 'accountKey'], [], 'invalid_dot_binding');
  const dotUrl = parseDotUrl(input.dotUrl);
  const conversationId = text(input.conversationId, 'invalid_dot_binding');
  if (new URL(dotUrl).pathname !== `/dots/${encodeURIComponent(conversationId)}`) throw invalid('invalid_dot_binding');
  return Object.freeze({
    dotUrl,
    conversationId,
    roomId: text(input.roomId, 'invalid_dot_binding'),
    peerAeonId: text(input.peerAeonId, 'invalid_dot_binding'),
    accountKey: text(input.accountKey, 'invalid_dot_binding')
  });
}

export function sameDotBinding(left, right) {
  const a = parseDotBinding(left);
  const b = parseDotBinding(right);
  return a.conversationId === b.conversationId && a.roomId === b.roomId && a.peerAeonId === b.peerAeonId && a.accountKey === b.accountKey;
}

export function dotConversationScope(binding) {
  const parsed = parseDotBinding(binding);
  const identity = JSON.stringify([parsed.accountKey, parsed.conversationId, parsed.roomId, parsed.peerAeonId]);
  return `dot:${createHash('sha256').update(identity).digest('hex')}`;
}

export function parseDotSubmission(value) {
  const input = record(value, 'invalid_dot_submission');
  fields(input, ['state', 'userMessageId', 'requestId'], [], 'invalid_dot_submission');
  if (!DOT_SUBMISSION_STATES.includes(input.state)) throw invalid('invalid_dot_submission');
  if (input.state === 'submitted') {
    return Object.freeze({ state: 'submitted', userMessageId: text(input.userMessageId, 'invalid_dot_submission'), requestId: text(input.requestId, 'invalid_dot_submission') });
  }
  if (input.userMessageId !== null) throw invalid('invalid_dot_submission');
  if (input.state === 'not-submitted' && input.requestId !== null) throw invalid('invalid_dot_submission');
  return Object.freeze({ state: input.state, userMessageId: null, requestId: input.requestId === null ? null : text(input.requestId, 'invalid_dot_submission') });
}

export function initialDotSubmission() {
  return Object.freeze({ state: 'not-submitted', userMessageId: null, requestId: null });
}

export function parseDotKeyMeta(value) {
  const input = record(value, 'saved_dot_binding_invalid');
  try {
    fields(input, ['recipient', 'dotBinding'], [], 'saved_dot_binding_invalid');
    const recipient = parseChatGptRecipient(input.recipient);
    if (recipient.kind !== 'dot') throw invalid('saved_dot_binding_invalid');
    const dotBinding = parseDotBinding(input.dotBinding);
    if (recipient.dotUrl !== null && recipient.dotUrl !== dotBinding.dotUrl) throw invalid('saved_dot_binding_invalid');
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
  const dotCursor = value.dotCursor == null ? null : text(value.dotCursor, 'invalid_dot_cursor');
  if (dotCursor) {
    const cursor = parseDotCursor(dotCursor);
    if (!dotBinding || !sameDotBinding(cursor.binding, dotBinding)) throw invalid('invalid_dot_run');
  }
  return { recipient, dotBinding, dotSubmission, dotCursor };
}

export function encodeDotCursor(binding, messageId = null) {
  const parsed = parseDotBinding(binding);
  const anchor = messageId === null ? null : text(messageId, 'invalid_dot_cursor');
  return Buffer.from(JSON.stringify({ binding: parsed, messageId: anchor }), 'utf8').toString('base64url');
}

export function parseDotCursor(value) {
  const input = text(value, 'invalid_dot_cursor');
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw invalid('invalid_dot_cursor');
  try {
    const bytes = Buffer.from(input, 'base64url');
    if (bytes.toString('base64url') !== input) throw invalid('invalid_dot_cursor');
    const decoded = record(JSON.parse(bytes.toString('utf8')), 'invalid_dot_cursor');
    fields(decoded, ['binding', 'messageId'], [], 'invalid_dot_cursor');
    return { binding: parseDotBinding(decoded.binding), messageId: decoded.messageId === null ? null : text(decoded.messageId, 'invalid_dot_cursor') };
  } catch {
    throw invalid('invalid_dot_cursor');
  }
}

const hasText = (value) => !!value.trim();
const nonempty = z.string().refine(hasText);
const dotTarget = {
  dotUrl: nonempty.refine((value) => { try { parseDotUrl(value); return true; } catch { return false; } }).optional(),
  key: nonempty.optional()
};
const readBounds = {
  maxChars: z.number().int().positive().max(1_000_000).optional(),
  limit: z.number().int().positive().max(32).optional()
};
const cursorInput = nonempty.refine((value) => { try { parseDotCursor(value); return true; } catch { return false; } });

export const DOT_TALK_SCHEMA = z.object({ ...dotTarget, text: z.string().max(200_000).refine(hasText), timeoutMs: z.number().finite().positive().optional() }).strict();
export const DOT_READ_SCHEMA = z.object({ ...dotTarget, ...readBounds, after: cursorInput.optional() }).strict();
export const DOT_WAIT_SCHEMA = z.object({ ...dotTarget, ...readBounds, after: cursorInput, timeoutMs: z.number().finite().nonnegative().optional() }).strict();
export const DOT_OPERATION_SCHEMAS = Object.freeze({ talk: DOT_TALK_SCHEMA, read: DOT_READ_SCHEMA, wait: DOT_WAIT_SCHEMA });

export function parseDotOperationRequest(value, operation, { allowSource = false } = {}) {
  const schema = DOT_OPERATION_SCHEMAS[operation];
  if (!schema) throw invalid('dot_operation_unsupported');
  const effective = allowSource ? schema.extend({ source: nonempty.optional() }) : schema;
  const result = effective.safeParse(value);
  if (!result.success) throw invalid('invalid_dot_request');
  return { ...result.data, ...(result.data.dotUrl ? { dotUrl: parseDotUrl(result.data.dotUrl) } : {}), ...(result.data.key ? { key: result.data.key.trim() } : {}) };
}

export function parseDotMessageBatch(value) {
  const input = record(value, 'invalid_dot_batch');
  fields(input, ['binding', 'messages', 'cursor', 'hasMore'], ['timedOut'], 'invalid_dot_batch');
  const binding = parseDotBinding(input.binding);
  const cursor = parseDotCursor(input.cursor);
  if (!sameDotBinding(binding, cursor.binding) || typeof input.hasMore !== 'boolean' || !Array.isArray(input.messages)) throw invalid('invalid_dot_batch');
  if (Object.hasOwn(input, 'timedOut') && typeof input.timedOut !== 'boolean') throw invalid('invalid_dot_batch');
  const ids = new Set();
  const messages = input.messages.map((value) => {
    const message = record(value, 'invalid_dot_batch');
    fields(message, ['id', 'sender', 'text', 'createdAt', 'hasAttachments', 'taskCardOnly'], [], 'invalid_dot_batch');
    const id = text(message.id, 'invalid_dot_batch');
    if (ids.has(id) || message.sender !== 'dot' || (message.text !== null && typeof message.text !== 'string') || typeof message.createdAt !== 'string' || typeof message.hasAttachments !== 'boolean' || typeof message.taskCardOnly !== 'boolean') throw invalid('invalid_dot_batch');
    ids.add(id);
    return { ...message, id };
  });
  if ((messages.length && cursor.messageId !== messages.at(-1).id) || (input.timedOut === true && (messages.length || input.hasMore))) throw invalid('invalid_dot_batch');
  return { binding, messages, cursor: input.cursor, hasMore: input.hasMore, ...(Object.hasOwn(input, 'timedOut') ? { timedOut: input.timedOut } : {}) };
}

export function parseDotDelivery(value) {
  const input = record(value, 'invalid_dot_run');
  const runId = text(input.runId, 'invalid_dot_run');
  const dot = parseDotRunFields(input);
  if (dot.dotSubmission.state !== 'submitted' || !dot.dotCursor) throw invalid('dot_delivery_unconfirmed');
  return { runId, ...dot };
}
