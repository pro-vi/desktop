import {
  conversationUrlForLocation,
  locationFromConversationUrl
} from './chatgpt-location.mjs';

export const PROFILE_SCOPE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
export const CHATGPT_CONVERSATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,255})$/;
export const LIBRARY_LOCAL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,255})$/;
const IDENTITY_KEYS = Object.freeze(['provider', 'profileScopeId', 'providerConversationId']);

function identityError(code, field, reason) {
  const error = new Error(code);
  error.code = code;
  error.data = { field, reason };
  return error;
}

function assertExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw identityError('invalid_conversation_identity', 'identity', 'unexpected_fields');
  }
}

export function parseProfileScopeId(value) {
  if (typeof value !== 'string' || !PROFILE_SCOPE_ID_PATTERN.test(value)) {
    throw identityError('invalid_profile_scope_id', 'profileScopeId', 'invalid_format');
  }
  return value;
}

export function parseChatGptConversationId(value) {
  if (typeof value !== 'string' || !CHATGPT_CONVERSATION_ID_PATTERN.test(value)) {
    throw identityError('invalid_provider_conversation_id', 'providerConversationId', 'invalid_format');
  }
  return value;
}

export function providerConversationIdFromOwnedLocation(location) {
  const conversationUrl = conversationUrlForLocation(location);
  if (!conversationUrl) {
    throw identityError('owned_conversation_required', 'location', 'canonical_conversation_required');
  }
  const canonicalLocation = locationFromConversationUrl(conversationUrl);
  const canonicalUrl = conversationUrlForLocation(canonicalLocation);
  const segments = new URL(canonicalUrl).pathname.split('/').filter(Boolean);
  const id = segments.at(-1);
  return parseChatGptConversationId(id);
}

export function identityFromOwnedLocation(profileScopeId, location) {
  return Object.freeze({
    provider: 'chatgpt',
    profileScopeId: parseProfileScopeId(profileScopeId),
    providerConversationId: providerConversationIdFromOwnedLocation(location)
  });
}

export function parseConversationIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw identityError('invalid_conversation_identity', 'identity', 'expected_object');
  }
  assertExactKeys(value, IDENTITY_KEYS);
  if (value.provider !== 'chatgpt') {
    throw identityError('invalid_conversation_identity', 'provider', 'unsupported_provider');
  }
  return Object.freeze({
    provider: 'chatgpt',
    profileScopeId: parseProfileScopeId(value.profileScopeId),
    providerConversationId: parseChatGptConversationId(value.providerConversationId)
  });
}

export function formatConversationIdentity(value) {
  const identity = parseConversationIdentity(value);
  return `chatgpt/${identity.profileScopeId}/${identity.providerConversationId}`;
}

export function sameConversationIdentity(left, right) {
  return formatConversationIdentity(left) === formatConversationIdentity(right);
}
