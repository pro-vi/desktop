import { parseDotBinding, sameDotBinding } from './chatgpt-recipient.mjs';

// Observed on 2026-10-07 with ChatGPT messaging asset
// 166137.5a625a2847.js. Component names are minified and are not selectors.
export function dotPageScript(options = {}) {
  return `(${runDotPageOperation.toString()})(${JSON.stringify(options)})`;
}

function runDotPageOperation(options) {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !node.closest('[inert]');
  };
  const personal = [...document.querySelectorAll('button[data-sidebar-destination="builtin:orbit"]')].filter(visible);
  if (options.action === 'open') {
    if (location.origin !== 'https://chatgpt.com' || personal.length !== 1) return { state: 'unconfirmed' };
    personal[0].click();
    return { state: 'opening' };
  }
  const route = /^\/dots\/([^/]+)$/.exec(location.pathname);
  if (location.origin !== 'https://chatgpt.com' || !route || personal.length !== 1 || personal[0].getAttribute('aria-current') !== 'page') return { state: 'not-dot' };
  const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const propsKey = (node) => Object.keys(node).find((key) => key.startsWith('__reactProps$'));
  const ancestors = (node) => {
    const key = Object.keys(node).find((key) => key.startsWith('__reactFiber$'));
    let fiber = key ? node[key] : null;
    const current = node[propsKey(node)];
    if (fiber?.alternate?.memoizedProps === current && fiber.memoizedProps !== current) fiber = fiber.alternate;
    const seen = new Set();
    const found = [];
    while (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      if (record(fiber.memoizedProps)) found.push(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return found;
  };
  const accountKeys = [...new Set(ancestors(personal[0]).flatMap((props) => typeof props.accountKey === 'string' && props.accountKey ? [props.accountKey] : []))];
  if (accountKeys.length !== 1) return { state: 'unconfirmed' };
  const conversationId = decodeURIComponent(route[1]);
  const contexts = [];
  for (const main of [...document.querySelectorAll('main')].filter(visible)) {
    const path = ancestors(main);
    if (!path.some((props) => props.conversationId === conversationId)) continue;
    const props = path.find((props) => record(props.room) && props.room.id === props.roomId && record(props.services));
    if (props) contexts.push({ main, ...props });
  }
  const distinct = new Map(contexts.map((context) => [context.room.id, context]));
  if (distinct.size !== 1) return { state: 'unconfirmed' };
  const context = [...distinct.values()][0];
  const room = context.room;
  if (typeof room.id !== 'string' || typeof room.aeon_id !== 'string' || !Array.isArray(room.members)) return { state: 'unconfirmed' };
  const peers = room.members.filter((member) => member?.aeon_id === room.aeon_id);
  if (peers.length !== 1 || typeof peers[0].id !== 'string') return { state: 'unconfirmed' };
  const owners = room.members.filter((member) => member?.id !== peers[0].id);
  if (owners.length !== 1 || typeof owners[0].id !== 'string') return { state: 'unconfirmed' };
  const binding = { dotUrl: location.href, conversationId, roomId: room.id, peerAeonId: room.aeon_id, accountKey: accountKeys[0] };
  const same = (a, b) => a && b && ['conversationId', 'roomId', 'peerAeonId', 'accountKey'].every((key) => a[key] === b[key]);
  if (options.binding && !same(binding, options.binding)) return { state: 'binding-mismatch' };
  const services = context.services;
  if (typeof services.conversations?.timeline !== 'function') return { state: 'unconfirmed' };
  const timeline = services.conversations.timeline(room.id);
  const snapshot = timeline?.getSnapshot?.();
  const composerState = services.composer?.state?.getSnapshot?.();
  if (!snapshot || snapshot.loaded !== true || !Array.isArray(snapshot.messages) || !record(snapshot.cursors) || !Object.hasOwn(snapshot.cursors, 'after') || (snapshot.cursors.after !== null && typeof snapshot.cursors.after !== 'string') || !record(composerState) || !Array.isArray(composerState.unconfirmedSends)) return { state: 'unconfirmed' };
  const unconfirmed = composerState.unconfirmedSends.flatMap((entry) => entry?.request?.roomId === room.id && typeof entry.request.requestId === 'string' ? [entry.request.requestId] : []);
  const unconfirmedIds = new Set(unconfirmed);
  const messages = [];
  for (const message of snapshot.messages) {
    if (!record(message) || typeof message.id !== 'string' || message.roomId !== room.id || typeof message.deliveryState !== 'string') return { state: 'unconfirmed' };
    let direction;
    if (message.self === true && message.senderId === owners[0].id) direction = 'outgoing';
    else if (message.self === false && message.senderId === peers[0].id && message.senderAeonId === room.aeon_id) direction = 'incoming';
    else return { state: 'unconfirmed' };
    messages.push({
      id: message.id, direction, requestId: typeof message.requestId === 'string' ? message.requestId : null,
      deliveryState: message.deliveryState, createdAt: typeof message.createdAt === 'string' ? message.createdAt : '',
      hasAttachments: Array.isArray(message.attachments) && message.attachments.length > 0,
      taskCardOnly: message.isTaskCardOnly === true,
      deleted: !!message.deletedAt,
      native: message
    });
  }
  const metadata = messages.map(({ native, ...message }) => message);
  const editors = [...context.main.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
  const nativeDraft = composerState.drafts instanceof Map ? composerState.drafts.get(room.id)?.text : undefined;
  const attachments = typeof services.composer.getAttachmentDraft === 'function' ? services.composer.getAttachmentDraft(room.id) : null;
  const draftChars = editors.length === 1 && typeof nativeDraft === 'string' && editors[0].textContent === nativeDraft ? nativeDraft.length : null;
  const uploadCount = Array.isArray(attachments) ? attachments.length : null;
  const base = { state: 'ready', binding, messages: metadata, unconfirmedRequestIds: unconfirmed, draftChars, uploadCount, historyAfter: typeof snapshot.cursors?.after === 'string' ? snapshot.cursors.after : null };
  if (options.action === 'history') {
    const scrollers = [context.main, ...context.main.querySelectorAll('*')].filter((node) => node.scrollHeight > node.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
    if (scrollers.length !== 1) return { state: 'cursor-unavailable' };
    scrollers[0].scrollTo({ top: 0, behavior: 'instant' });
    return base;
  }
  if (options.action === 'submit') {
    if (!options.binding || !same(binding, options.binding)) return { state: 'binding-mismatch' };
    if (draftChars !== 0 || uploadCount !== 0) return { state: 'draft-conflict' };
    if (snapshot.cursors.after !== null || typeof services.composer.sendPrepared !== 'function' || typeof options.requestId !== 'string' || !options.requestId || typeof options.text !== 'string' || !options.text.trim()) return { state: 'unconfirmed' };
    const accepted = services.composer.sendPrepared(room.id, { requestId: options.requestId, text: options.text, createdAt: new Date().toISOString() });
    return { ...base, submitted: accepted === true };
  }
  if (options.action === 'read') {
    if (snapshot.cursors.after !== null) return { state: 'cursor-unavailable' };
    let start = 0;
    if (options.after !== null && options.after !== undefined) {
      const anchor = messages.findIndex((message) => message.id === options.after && message.deliveryState === '' && !unconfirmedIds.has(message.requestId || message.id));
      if (anchor < 0) return { state: 'cursor-unavailable' };
      start = anchor + 1;
    }
    if (options.after === null && (!Object.hasOwn(snapshot.cursors, 'before') || snapshot.cursors.before !== null)) return { state: 'cursor-unavailable' };
    const remaining = messages.slice(start).filter((message) => message.direction === 'incoming' && !message.deleted);
    if (remaining.some((message) => message.deliveryState !== '' || unconfirmedIds.has(message.requestId || message.id))) return { state: 'unconfirmed' };
    let candidates = remaining;
    if (options.after === undefined) candidates = candidates.slice(-options.limit);
    let chars = 0;
    const received = [];
    for (const message of candidates) {
      if (received.length === options.limit) break;
      const text = typeof message.native.text === 'string' ? message.native.text : null;
      if (text === null && !message.hasAttachments && !message.taskCardOnly) return { state: 'unconfirmed' };
      const requiredChars = text?.length || 0;
      if (chars + requiredChars > options.maxChars) {
        if (!received.length) return { state: 'message-too-large', messageId: message.id, requiredChars };
        break;
      }
      chars += requiredChars;
      received.push({ id: message.id, sender: 'dot', text, createdAt: message.createdAt, hasAttachments: message.hasAttachments, taskCardOnly: message.taskCardOnly });
    }
    return { ...base, received, hasMore: received.length < candidates.length };
  }
  return base;
}

function fail(code = 'dot_binding_unconfirmed') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function parseDotPageObservation(value, { binding = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (value.state === 'not-dot' || value.state === 'unconfirmed') fail();
  if (value.state === 'binding-mismatch') fail('dot_binding_mismatch');
  if (value.state === 'draft-conflict') fail('dot_draft_conflict');
  if (value.state === 'cursor-unavailable') fail('dot_cursor_unavailable');
  if (value.state === 'message-too-large') {
    if (typeof value.messageId !== 'string' || !value.messageId || !Number.isSafeInteger(value.requiredChars) || value.requiredChars < 1) fail();
    const error = new Error('dot_message_too_large');
    error.data = { messageId: value.messageId, requiredChars: value.requiredChars };
    throw error;
  }
  if (value.state !== 'ready') fail();
  const observed = parseDotBinding(value.binding);
  if (binding && !sameDotBinding(observed, binding)) fail('dot_binding_mismatch');
  if (!Array.isArray(value.messages) || !Array.isArray(value.unconfirmedRequestIds) || !value.unconfirmedRequestIds.every((id) => typeof id === 'string' && !!id) || (value.draftChars !== null && (!Number.isSafeInteger(value.draftChars) || value.draftChars < 0)) || (value.uploadCount !== null && (!Number.isSafeInteger(value.uploadCount) || value.uploadCount < 0)) || (value.historyAfter !== null && typeof value.historyAfter !== 'string')) fail();
  const ids = new Set();
  const messages = value.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.id !== 'string' || !message.id || ids.has(message.id) || !['incoming', 'outgoing'].includes(message.direction) || (message.requestId !== null && typeof message.requestId !== 'string') || typeof message.deliveryState !== 'string' || typeof message.createdAt !== 'string' || typeof message.hasAttachments !== 'boolean' || typeof message.taskCardOnly !== 'boolean' || typeof message.deleted !== 'boolean') fail();
    ids.add(message.id);
    return { id: message.id, direction: message.direction, requestId: message.requestId, deliveryState: message.deliveryState, createdAt: message.createdAt, hasAttachments: message.hasAttachments, taskCardOnly: message.taskCardOnly, deleted: message.deleted };
  });
  const result = { binding: observed, messages, unconfirmedRequestIds: value.unconfirmedRequestIds, draftChars: value.draftChars, uploadCount: value.uploadCount, historyAfter: value.historyAfter };
  if (Object.hasOwn(value, 'submitted')) {
    if (typeof value.submitted !== 'boolean') fail();
    result.submitted = value.submitted;
  }
  const unconfirmed = new Set(value.unconfirmedRequestIds);
  if (Object.hasOwn(value, 'received')) {
    if (!Array.isArray(value.received) || typeof value.hasMore !== 'boolean') fail();
    if (value.received.some((message) => !messages.some((native) => native.id === message?.id && native.direction === 'incoming' && native.deliveryState === '' && !native.deleted && !unconfirmed.has(native.requestId || native.id)))) fail();
    result.received = value.received;
    result.hasMore = value.hasMore;
  }
  return result;
}
