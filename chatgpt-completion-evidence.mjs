export const COMPLETION_EVIDENCE_SOURCES = Object.freeze([
  'assistant-node', 'image-output', 'deep-research-report', 'structured-recovery'
]);

export function completionEvidenceFor(source) {
  if (!COMPLETION_EVIDENCE_SOURCES.includes(source)) return null;
  return { source, observedAt: Date.now() };
}

export function parseCompletionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!COMPLETION_EVIDENCE_SOURCES.includes(value.source)) return null;
  return { source: value.source, observedAt: value.observedAt };
}

export function isQualifiedCompletionEvidence(value) {
  return parseCompletionEvidence(value) !== null;
}
