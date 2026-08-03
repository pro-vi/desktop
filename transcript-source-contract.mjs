export const TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH = 200;
export const TRANSCRIPT_SOURCE_KEY_MAX_LENGTH = 128;
export const TRANSCRIPT_SOURCE_TAG_MAX_LENGTH = 64;
export const TRANSCRIPT_SOURCE_TAGS_MAX_COUNT = 20;

function sourceContractError() {
  const error = new Error('transcript_source_invalid');
  error.code = 'transcript_source_invalid';
  return error;
}

function parseTrimmedText(value, maxLength) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maxLength ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw sourceContractError();
  }
  return value;
}

export function parseTranscriptSourceLabel(value) {
  return parseTrimmedText(value, TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH);
}

export function parseTranscriptSourceKey(value) {
  return parseTrimmedText(value, TRANSCRIPT_SOURCE_KEY_MAX_LENGTH);
}

export function parseTranscriptSourceTags(value) {
  if (!Array.isArray(value) || value.length > TRANSCRIPT_SOURCE_TAGS_MAX_COUNT) {
    throw sourceContractError();
  }
  const tags = Array.from(value, (tag) => parseTrimmedText(tag, TRANSCRIPT_SOURCE_TAG_MAX_LENGTH));
  if (new Set(tags).size !== tags.length) throw sourceContractError();
  return Object.freeze(tags);
}
