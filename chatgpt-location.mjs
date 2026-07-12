import crypto from 'node:crypto';

const CHATGPT_HOST = 'chatgpt.com';

function parseUrl(value, { field = 'chatUrl' } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    const error = new Error('invalid_chatgpt_url');
    error.data = { field, reason: 'malformed_url' };
    throw error;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== CHATGPT_HOST || parsed.username || parsed.password) {
    const error = new Error('invalid_chatgpt_url');
    error.data = { field, reason: 'unsupported_origin' };
    throw error;
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed;
}

function projectUrlForConversation(parsed) {
  const match = parsed.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/[^/]+$/);
  return match ? `https://${CHATGPT_HOST}/g/${match[1]}/project` : null;
}

export function parseChatGptEntryTarget(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;
  if (/^\/share\/[^/]+$/.test(parsed.pathname)) {
    return { kind: 'shared-snapshot', chatUrl: parsed.toString() };
  }
  if (/^\/c\/[^/]+$/.test(parsed.pathname) || /^\/g\/g-p-[^/]+\/c\/[^/]+$/.test(parsed.pathname)) {
    return { kind: 'canonical-conversation', chatUrl: parsed.toString() };
  }
  const error = new Error('invalid_chatgpt_url');
  error.data = { field: 'chatUrl', reason: 'unsupported_path', pathname: parsed.pathname };
  throw error;
}

export function parseChatGptProjectUrl(value, { field = 'projectUrl' } = {}) {
  const parsed = parseUrl(value, { field });
  if (!parsed) return null;
  if (!/^\/g\/g-p-[^/]+\/project$/.test(parsed.pathname)) {
    const error = new Error('invalid_chatgpt_url');
    error.data = { field, reason: 'unsupported_project_path', pathname: parsed.pathname };
    throw error;
  }
  return parsed.toString();
}

export function locationFromConversationUrl(value, { sourceUrl = null } = {}) {
  const target = parseChatGptEntryTarget(value);
  if (!target || target.kind !== 'canonical-conversation') {
    const error = new Error('invalid_chatgpt_url');
    error.data = { field: 'conversationUrl', reason: 'canonical_conversation_required' };
    throw error;
  }
  const parsed = new URL(target.chatUrl);
  const projectUrl = projectUrlForConversation(parsed);
  return projectUrl
    ? { kind: 'project-conversation', projectUrl, conversationUrl: target.chatUrl, ...(sourceUrl ? { sourceUrl } : {}) }
    : { kind: 'standalone-conversation', conversationUrl: target.chatUrl, ...(sourceUrl ? { sourceUrl } : {}) };
}

export function locationFromProjectUrl(value) {
  const projectUrl = parseChatGptProjectUrl(value);
  return projectUrl ? { kind: 'project-home', projectUrl } : { kind: 'home' };
}

export function decodeChatGptLocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'home' };
  const kind = String(input.kind || '').trim();
  try {
    if (kind === 'home') return { kind: 'home' };
    if (kind === 'project-home') return locationFromProjectUrl(input.projectUrl);
    if (kind === 'standalone-conversation' || kind === 'project-conversation') {
      return locationFromConversationUrl(input.conversationUrl, {
        sourceUrl: typeof input.sourceUrl === 'string' && input.sourceUrl.trim() ? parseChatGptEntryTarget(input.sourceUrl)?.chatUrl : null
      });
    }
  } catch {}
  return { kind: 'home' };
}

export function decodePersistedChatGptLocation(input) {
  if (typeof input === 'string') {
    try { return locationFromProjectUrl(input); } catch { return { kind: 'home' }; }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'home' };
  if (input.location) return decodeChatGptLocation(input.location);
  // Legacy nullable-pair repair: the specific conversation is authoritative.
  if (typeof input.conversationUrl === 'string' && input.conversationUrl.trim()) {
    try { return locationFromConversationUrl(input.conversationUrl); } catch {}
  }
  if (typeof input.projectUrl === 'string' && input.projectUrl.trim()) {
    try { return locationFromProjectUrl(input.projectUrl); } catch {}
  }
  return { kind: 'home' };
}

export function projectUrlForLocation(location) {
  return location?.kind === 'project-home' || location?.kind === 'project-conversation'
    ? location.projectUrl
    : null;
}

export function conversationUrlForLocation(location) {
  return location?.kind === 'standalone-conversation' || location?.kind === 'project-conversation'
    ? location.conversationUrl
    : null;
}

export function resolveChatGptLocation({ chatUrl = null, projectUrl = null, savedMeta = null, defaultProjectUrl = null } = {}) {
  if (chatUrl && projectUrl) {
    const error = new Error('chatgpt_location_conflict');
    error.data = { fields: ['chatUrl', 'projectUrl'] };
    throw error;
  }
  if (chatUrl) {
    const entryTarget = parseChatGptEntryTarget(chatUrl);
    if (entryTarget.kind === 'canonical-conversation') {
      return { location: locationFromConversationUrl(entryTarget.chatUrl), entryTarget, source: 'explicit-chat' };
    }
    return { location: { kind: 'home' }, entryTarget, source: 'explicit-chat' };
  }
  if (projectUrl) {
    return { location: locationFromProjectUrl(projectUrl), entryTarget: null, source: 'explicit-project' };
  }
  const saved = decodePersistedChatGptLocation(savedMeta);
  if (saved.kind !== 'home') return { location: saved, entryTarget: null, source: 'saved-key' };
  if (defaultProjectUrl) {
    return { location: locationFromProjectUrl(defaultProjectUrl), entryTarget: null, source: 'default-project' };
  }
  return { location: { kind: 'home' }, entryTarget: null, source: 'home' };
}

export function derivedChatKey(chatUrl) {
  const target = parseChatGptEntryTarget(chatUrl);
  return `chat-${crypto.createHash('sha256').update(target.chatUrl).digest('hex').slice(0, 16)}`;
}
