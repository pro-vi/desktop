import { normalizeChatGptModelIntent } from './chatgpt-mode-intent.mjs';

export const CHATGPT_MODEL_INTENT_META = Object.freeze({
  'gpt-5.5-pro': Object.freeze({
    label: 'GPT-5.5 Pro',
    pattern: '\\bgpt\\s*[- ]?5\\.5\\b|\\b5\\.5\\s*(?:pro)?\\b'
  }),
  'gpt-5.4-pro': Object.freeze({
    label: 'GPT-5.4 Pro',
    pattern: '\\bgpt\\s*[- ]?5\\.4\\b|\\b5\\.4\\s*(?:pro)?\\b|\\blegacy\\s+pro\\b'
  })
});

export const CHATGPT_MODEL_INTENT_ENTRIES = Object.freeze(
  Object.entries(CHATGPT_MODEL_INTENT_META).map(([intent, item]) =>
    Object.freeze({ intent, pattern: item.pattern })
  )
);

export const CHATGPT_ANY_MODEL_PATTERN = CHATGPT_MODEL_INTENT_ENTRIES.map((item) => item.pattern).join('|');

export function normalizeUiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isBlockedUiLabel(label) {
  const text = normalizeUiText(label);
  return /\bfeedback\b|click to remove|remove attached|remove file|\battachment\b|\buploaded\b/.test(text);
}

export function modelIntentPatternMatchesLabel(label, intent) {
  const text = normalizeUiText(label);
  const meta = CHATGPT_MODEL_INTENT_META[String(intent || '').trim().toLowerCase()];
  if (!text || !meta || text.length > 180 || isBlockedUiLabel(text)) return false;
  return new RegExp(meta.pattern, 'i').test(text);
}

export function modelIntentForLabel(label, modelEntries = CHATGPT_MODEL_INTENT_ENTRIES) {
  const text = normalizeUiText(label);
  if (!text || text.length > 180 || isBlockedUiLabel(text)) return null;
  for (const item of modelEntries || []) {
    const re = item?.re || new RegExp(item?.pattern || '$.^', 'i');
    if (re.test(text)) return item.intent;
  }
  return null;
}

export function modelIntentLabelLooksUsable(label, targetIntent) {
  const target = normalizeChatGptModelIntent(targetIntent, { fallback: null });
  return modelIntentPatternMatchesLabel(label, target);
}

export function modelPickerControlText(descriptor = {}) {
  return normalizeUiText(
    [
      descriptor.label || '',
      descriptor.dataTestId || '',
      descriptor.aria || '',
      descriptor.title || ''
    ].join(' ')
  );
}

export function descriptorText(descriptor = {}) {
  return normalizeUiText(descriptor.text || modelPickerControlText(descriptor));
}

export function isHighConfidenceModelControlDescriptor(descriptor = {}) {
  const text = descriptorText(descriptor);
  const isButtonLike = !!descriptor.isButtonLike;
  return (
    /model-switcher|model selector|model-selector|model_picker|model-picker|model switch|switch model|choose model|current model/.test(text) ||
    (isButtonLike && /\bgpt\s*[- ]?5\.[45]\b/.test(text))
  );
}

export function isProjectOptionsControlDescriptor(descriptor = {}) {
  const text = descriptorText(descriptor);
  return !!descriptor.isButtonLike && /\bopen\s+project\s+options\b|\bproject\s+options\b/.test(text);
}

export function isProjectModelModeControlDescriptor(descriptor = {}) {
  const text = descriptorText(descriptor);
  if (!descriptor.isButtonLike) return false;
  if (/\bprofile\b|accounts-profile|\bshare\b|\brename\b|\bdelete\b/.test(text)) return false;
  return /\bextended\s+pro\b/.test(text);
}

export function scoreModelTriggerCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const intent = candidate.intent || modelIntentForLabel(label);
  const targetIntent = String(candidate.targetIntent || '').trim().toLowerCase();
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  const anyModelMatches =
    !!candidate.anyModelMatches || (label ? new RegExp(CHATGPT_ANY_MODEL_PATTERN, 'i').test(label) : false);
  const targetMatches =
    !!candidate.targetMatches || (targetIntent ? modelIntentPatternMatchesLabel(label, targetIntent) : false);
  const modelKeyword =
    !!candidate.modelKeyword || /\bmodel\b|\bgpt\b|\b5\.[45]\b/.test(label);

  let score = -1;
  if (intent === targetIntent && candidate.highConfidence) {
    score = 220;
  } else if (candidate.projectModelMode && candidate.modelRegion) {
    score = 205;
  } else if (candidate.highConfidence) {
    score = 180;
  } else if (intent === targetIntent && candidate.modelRegion) {
    score = 170;
  } else if (anyModelMatches && candidate.modelRegion) {
    score = targetMatches ? 165 : 120;
  } else if (modelKeyword && candidate.modelRegion) {
    score = 115;
  } else if (candidate.projectOptions && !candidate.menuOpen) {
    score = 90;
  }

  if (score >= 0 && candidate.hasDataTestId) score += 10;
  if (score >= 0 && candidate.inComposer) score += 25;
  if (score >= 0 && area > 40_000) score -= 80;
  else if (score >= 0 && area > 18_000) score -= 35;
  if (score >= 0 && width > 320) score -= 30;
  if (score >= 0 && height > 90) score -= 25;
  if (
    score >= 0 &&
    !candidate.modelRegion &&
    !candidate.highConfidence &&
    !candidate.projectOptions &&
    !candidate.projectModelMode
  ) {
    score = -1;
  }
  return score;
}

export function scoreModelOptionCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const intent = candidate.intent || modelIntentForLabel(label);
  const targetIntent = String(candidate.targetIntent || '').trim().toLowerCase();
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  let score = -1;

  if (intent === targetIntent) score = 260;
  if (score >= 0 && candidate.optionInsideMenu) score += 20;
  if (score >= 0 && candidate.ariaChecked) score += 10;
  if (score >= 0 && candidate.active) score -= 5;
  if (score >= 0 && area > 100_000) score -= 120;
  else if (score >= 0 && area > 30_000) score -= 30;
  if (score >= 0 && height > 140) score -= 80;
  if (score >= 0 && width > 720) score -= 60;
  if (score >= 0 && label.length > 180) score -= 120;
  return score;
}

export function shouldTrackPendingModelTrigger(snap = {}) {
  return snap?.action === 'pointer_trigger' && !!snap.signature && !snap.menuOpen;
}

export const CHATGPT_MODEL_PICKER_PRIMITIVES_JS = String.raw`
  const modelPickerPrimitives = (() => {
    const CHATGPT_MODEL_INTENT_META = ${JSON.stringify(CHATGPT_MODEL_INTENT_META)};
    const CHATGPT_MODEL_INTENT_ENTRIES = ${JSON.stringify(CHATGPT_MODEL_INTENT_ENTRIES)};
    const CHATGPT_ANY_MODEL_PATTERN = ${JSON.stringify(CHATGPT_ANY_MODEL_PATTERN)};
    ${normalizeUiText.toString()}
    ${isBlockedUiLabel.toString()}
    ${modelIntentPatternMatchesLabel.toString()}
    ${modelIntentForLabel.toString()}
    ${modelPickerControlText.toString()}
    ${descriptorText.toString()}
    ${isHighConfidenceModelControlDescriptor.toString()}
    ${isProjectOptionsControlDescriptor.toString()}
    ${isProjectModelModeControlDescriptor.toString()}
    ${scoreModelTriggerCandidate.toString()}
    ${scoreModelOptionCandidate.toString()}
    return {
      modelIntentForLabel,
      modelPickerControlText,
      isHighConfidenceModelControlDescriptor,
      isProjectOptionsControlDescriptor,
      isProjectModelModeControlDescriptor,
      scoreModelTriggerCandidate,
      scoreModelOptionCandidate
    };
  })();
`;
