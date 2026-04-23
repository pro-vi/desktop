export const CHATGPT_MODE_INTENTS = ['extended-pro', 'thinking', 'instant'];
export const DEFAULT_CHAT_MODE_INTENT = 'extended-pro';
export const DEFAULT_IMAGE_MODE_INTENT = 'thinking';
export const DEFAULT_IMAGE_KEY = 'image-default';

function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeChatGptModeIntent(value, { fallback = DEFAULT_CHAT_MODE_INTENT } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '');
  if (normalized === 'extendedpro' || normalized === 'pro' || normalized === 'extended') return 'extended-pro';
  if (normalized === 'thinking' || normalized === 'reasoning') return 'thinking';
  if (normalized === 'instant' || normalized === 'fast') return 'instant';
  return fallback == null ? null : normalizeChatGptModeIntent(fallback, { fallback: null });
}

export function normalizePersistedChatGptKeyMeta(input) {
  if (typeof input === 'string') {
    return { projectUrl: trimOrNull(input), conversationUrl: null, modeIntent: null };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { projectUrl: null, conversationUrl: null, modeIntent: null };
  }
  return {
    projectUrl: trimOrNull(input.projectUrl),
    conversationUrl: trimOrNull(input.conversationUrl),
    modeIntent: normalizeChatGptModeIntent(input.modeIntent, { fallback: null })
  };
}

export function resolveChatGptChatProfile({
  key = null,
  tabId = null,
  projectUrl = null,
  modeIntent = null,
  settings = {},
  savedMeta = null
} = {}) {
  const normalizedSavedMeta = normalizePersistedChatGptKeyMeta(savedMeta);
  return {
    profile: 'chat',
    imageGeneration: false,
    requestedKey: trimOrNull(key),
    requestedTabId: trimOrNull(tabId),
    projectUrl: trimOrNull(projectUrl) || normalizedSavedMeta.projectUrl || trimOrNull(settings.defaultProjectUrl),
    conversationUrl: normalizedSavedMeta.conversationUrl,
    modeIntent: normalizeChatGptModeIntent(modeIntent, {
      fallback: normalizedSavedMeta.modeIntent || settings.defaultChatModeIntent || DEFAULT_CHAT_MODE_INTENT
    }),
    persistKeyLocation: true
  };
}

export function resolveChatGptImageProfile({
  key = null,
  tabId = null,
  projectUrl = null,
  modeIntent = null,
  settings = {}
} = {}) {
  const requestedTabId = trimOrNull(tabId);
  const requestedKey = trimOrNull(key) || (!requestedTabId ? trimOrNull(settings.defaultImageKey) || DEFAULT_IMAGE_KEY : null);
  return {
    profile: 'image',
    imageGeneration: true,
    requestedKey,
    requestedTabId,
    projectUrl: trimOrNull(projectUrl) || trimOrNull(settings.defaultImageProjectUrl),
    conversationUrl: null,
    modeIntent: normalizeChatGptModeIntent(modeIntent, {
      fallback: settings.defaultImageModeIntent || DEFAULT_IMAGE_MODE_INTENT
    }),
    persistKeyLocation: false
  };
}

export function resolveChatGptQueryProfile({
  imageGeneration = false,
  key = null,
  tabId = null,
  projectUrl = null,
  modeIntent = null,
  settings = {},
  savedMeta = null
} = {}) {
  return imageGeneration
    ? resolveChatGptImageProfile({ key, tabId, projectUrl, modeIntent, settings })
    : resolveChatGptChatProfile({ key, tabId, projectUrl, modeIntent, settings, savedMeta });
}
