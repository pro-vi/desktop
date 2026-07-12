import {
  conversationUrlForLocation,
  decodePersistedChatGptLocation,
  projectUrlForLocation,
  resolveChatGptLocation
} from './chatgpt-location.mjs';

export const CHATGPT_MODE_INTENTS = ['extended-pro', 'thinking', 'instant'];
export const CHATGPT_MODEL_INTENTS = ['gpt-5.5-pro', 'gpt-5.4-pro'];
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

export function normalizeChatGptModelIntent(value, { fallback = null } = {}) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '');
  if (['gpt55pro', 'gpt55', '55pro', '55', 'gpt5dot5pro', 'gpt5dot5'].includes(normalized)) return 'gpt-5.5-pro';
  if (['gpt54pro', 'gpt54', '54pro', '54', 'gpt5dot4pro', 'gpt5dot4', 'legacypro', 'legacy'].includes(normalized)) return 'gpt-5.4-pro';
  return fallback == null ? null : normalizeChatGptModelIntent(fallback, { fallback: null });
}

export function normalizePersistedChatGptKeyMeta(input) {
  const objectInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const location = decodePersistedChatGptLocation(input);
  return {
    location,
    projectUrl: projectUrlForLocation(location),
    conversationUrl: conversationUrlForLocation(location),
    modeIntent: normalizeChatGptModeIntent(objectInput.modeIntent, { fallback: null })
  };
}

export function resolveChatGptChatProfile({
  key = null,
  tabId = null,
  chatUrl = null,
  projectUrl = null,
  modeIntent = null,
  modelIntent = null,
  settings = {},
  savedMeta = null
} = {}) {
  const normalizedSavedMeta = normalizePersistedChatGptKeyMeta(savedMeta);
  const normalizedModelIntent = normalizeChatGptModelIntent(modelIntent, { fallback: null });
  const resolved = resolveChatGptLocation({
    chatUrl: trimOrNull(chatUrl),
    projectUrl: trimOrNull(projectUrl),
    savedMeta: normalizedSavedMeta,
    defaultProjectUrl: trimOrNull(settings.defaultProjectUrl)
  });
  return {
    profile: 'chat',
    imageGeneration: false,
    requestedKey: trimOrNull(key),
    requestedTabId: trimOrNull(tabId),
    location: resolved.location,
    entryTarget: resolved.entryTarget,
    locationSource: resolved.source,
    projectUrl: projectUrlForLocation(resolved.location),
    conversationUrl: conversationUrlForLocation(resolved.location),
    modeIntent: normalizeChatGptModeIntent(modeIntent, {
      fallback: normalizedSavedMeta.modeIntent || settings.defaultChatModeIntent || DEFAULT_CHAT_MODE_INTENT
    }),
    modelIntent: normalizedModelIntent,
    modelIntentConfirmation: 'ui',
    persistKeyLocation: true
  };
}

export function resolveChatGptImageProfile({
  key = null,
  tabId = null,
  projectUrl = null,
  modeIntent = null,
  modelIntent = null,
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
    modelIntent: normalizeChatGptModelIntent(modelIntent, { fallback: null }),
    modelIntentConfirmation: 'ui',
    persistKeyLocation: false
  };
}

export function resolveChatGptQueryProfile({
  imageGeneration = false,
  key = null,
  tabId = null,
  chatUrl = null,
  projectUrl = null,
  modeIntent = null,
  modelIntent = null,
  settings = {},
  savedMeta = null
} = {}) {
  return imageGeneration
    ? resolveChatGptImageProfile({ key, tabId, projectUrl, modeIntent, modelIntent, settings })
    : resolveChatGptChatProfile({ key, tabId, chatUrl, projectUrl, modeIntent, modelIntent, settings, savedMeta });
}
