import { parseDotBinding, parseDotSubmission, sameDotBinding } from './chatgpt-recipient.mjs';

export const COMPLETION_EVIDENCE_SOURCES = Object.freeze([
  'assistant-node', 'image-output', 'deep-research-report', 'structured-recovery', 'dot-message'
]);

export function completionEvidenceFor(source) {
  if (!COMPLETION_EVIDENCE_SOURCES.includes(source) || source === 'dot-message') return null;
  return { source, observedAt: Date.now() };
}

function requiredId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('dot_reply_unconfirmed');
  return value.trim();
}

export function parseCompletionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!COMPLETION_EVIDENCE_SOURCES.includes(value.source)) return null;
  if (value.source !== 'dot-message') return { source: value.source, observedAt: value.observedAt };
  try {
    const expected = ['source', 'observedAt', 'dotBinding', 'userMessageId', 'providerMessageId', 'authorDotId', 'replyToUserMessageId', 'completed'];
    if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) return null;
    if (!Number.isFinite(value.observedAt) || value.observedAt <= 0 || value.completed !== true) return null;
    const dotBinding = parseDotBinding(value.dotBinding);
    const userMessageId = requiredId(value.userMessageId);
    const providerMessageId = requiredId(value.providerMessageId);
    const authorDotId = requiredId(value.authorDotId);
    const replyToUserMessageId = requiredId(value.replyToUserMessageId);
    if (authorDotId !== dotBinding.dotId || replyToUserMessageId !== userMessageId) return null;
    return {
      source: 'dot-message', observedAt: value.observedAt, dotBinding,
      userMessageId, providerMessageId, authorDotId, replyToUserMessageId, completed: true
    };
  } catch {
    return null;
  }
}

export function isQualifiedCompletionEvidence(value) {
  return parseCompletionEvidence(value) !== null;
}

export function assertDotReplyEvidence(value, { dotBinding, dotSubmission }) {
  const evidence = parseCompletionEvidence(value);
  const submitted = parseDotSubmission(dotSubmission);
  if (
    evidence?.source !== 'dot-message' || submitted.state !== 'submitted' ||
    evidence.userMessageId !== submitted.userMessageId ||
    !sameDotBinding(evidence.dotBinding, dotBinding)
  ) {
    const error = new Error('dot_reply_unconfirmed');
    error.code = 'dot_reply_unconfirmed';
    throw error;
  }
  return evidence;
}
