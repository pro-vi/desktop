import { normalizeChatGptModelIntent } from './chatgpt-mode-intent.mjs';

export const CHATGPT_MODE_INTENT_META = Object.freeze({
  'extended-pro': Object.freeze({
    label: 'Extended Pro',
    pattern: '\\bextended\\s*pro\\b|\\bpro\\b'
  }),
  thinking: Object.freeze({
    label: 'Thinking',
    pattern: '\\bthinking\\b|\\breasoning\\b'
  }),
  instant: Object.freeze({
    label: 'Instant',
    pattern: '\\binstant\\b|\\bfast\\b'
  })
});

export const CHATGPT_MODE_INTENT_ENTRIES = Object.freeze(
  Object.entries(CHATGPT_MODE_INTENT_META).map(([intent, item]) =>
    Object.freeze({ intent, pattern: item.pattern })
  )
);

export const CHATGPT_ANY_MODE_PATTERN = CHATGPT_MODE_INTENT_ENTRIES.map((item) => item.pattern).join('|');

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

export function normalizeModeIntentToken(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '');
  if (normalized === 'extendedpro' || normalized === 'pro' || normalized === 'extended') return 'extended-pro';
  if (normalized === 'thinking' || normalized === 'reasoning') return 'thinking';
  if (normalized === 'instant' || normalized === 'fast') return 'instant';
  return null;
}

export function modeIntentForLabel(label) {
  const text = normalizeUiText(label);
  if (!text || text.length > 180 || isBlockedUiLabel(text)) return null;
  if (/\bthinking\b|\breasoning\b/.test(text)) return 'thinking';
  if (/\binstant\b|\bfast\b/.test(text)) return 'instant';
  if (/\bextended\s*pro\b/.test(text) || /^pro(?:\b|[\s,.:;()_-])/.test(text)) return 'extended-pro';
  return null;
}

export function modeIntentLabelLooksUsable(label, targetIntent) {
  const text = normalizeUiText(label);
  const target = normalizeModeIntentToken(targetIntent);
  if (!text || !target || text.length > 180 || isBlockedUiLabel(text)) return false;
  if (target === 'extended-pro') return /\bextended\s*pro\b/.test(text) || /^pro(?:\b|[\s,.:;()_-])/.test(text);
  if (target === 'thinking') return /\bthinking\b|\breasoning\b/.test(text);
  if (target === 'instant') return /\binstant\b|\bfast\b/.test(text);
  return false;
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

export function isModeOnlyModelPickerState({ menuText = '', optionHints = [] } = {}) {
  const text = normalizeUiText([
    menuText,
    ...(Array.isArray(optionHints) ? optionHints : [])
  ].join(' '));
  if (!text) return false;
  const hasModeChoices = /\blatest\b/.test(text) && /\binstant\b/.test(text) && /\bthinking\b/.test(text) && /\bpro\b/.test(text);
  const hasGenerationChoices = new RegExp(CHATGPT_ANY_MODEL_PATTERN, 'i').test(text);
  return hasModeChoices && !hasGenerationChoices;
}

export function isModelGenerationPickerState({ menuText = '', optionHints = [] } = {}) {
  const text = normalizeUiText([
    menuText,
    ...(Array.isArray(optionHints) ? optionHints : [])
  ].join(' '));
  if (!text) return false;
  if (new RegExp(CHATGPT_ANY_MODEL_PATTERN, 'i').test(text)) return true;
  return /\bintelligence\b/.test(text) && /\bmodel\b/.test(text) && /\b5\.[345]\b/.test(text);
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

export function isHighConfidenceModeControlDescriptor(descriptor = {}) {
  const text = descriptorText(descriptor);
  return /model-switcher|model selector|model-selector|model_picker|model-picker|mode selector|mode-selector/.test(text);
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
  if (isBlockedUiLabel(text) || /\bprofile\b|accounts-profile|\bshare\b|\brename\b|\bdelete\b/.test(text)) return false;
  return /\bextended\s+pro\b/.test(text);
}

export function scoreModeTriggerCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const intent = candidate.intent || modeIntentForLabel(label);
  const targetIntent = normalizeModeIntentToken(candidate.targetIntent);
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  const y = Number.isFinite(Number(candidate.y)) ? Number(candidate.y) : 0;
  const anyModeMatches =
    !!candidate.anyModeMatches || (label ? new RegExp(CHATGPT_ANY_MODE_PATTERN, 'i').test(label) : false);
  const targetMatches =
    !!candidate.targetMatches || (targetIntent ? modeIntentLabelLooksUsable(label, targetIntent) : false);
  const modeKeyword =
    !!candidate.modeKeyword || /\bmode\b|\bmodel\b|\breason\b|\bthink\b/.test(label);
  const boostsFromComposer = !intent || intent === targetIntent;

  let score = -1;
  if (intent) {
    score = intent === targetIntent ? 180 : candidate.active ? 70 : 40;
  } else if (/model selector|model-switcher-dropdown-button/.test(label)) {
    score = 170;
  } else if (candidate.highConfidence && anyModeMatches) {
    score = targetMatches ? 175 : 145;
  } else if (modeKeyword) {
    score = 120;
  }

  if (score >= 0 && candidate.hasDataTestId) score += 10;
  if (score >= 0 && boostsFromComposer && candidate.inComposer) score += 90;
  if (score >= 0 && boostsFromComposer) score += Math.max(0, Number(candidate.promptProximityBoost) || 0);
  if (score >= 0 && area > 25_000) score -= 80;
  else if (score >= 0 && area > 12_000) score -= 35;
  if (score >= 0 && width > 240) score -= 30;
  if (score >= 0 && height > 72) score -= 20;
  if (score >= 0 && y < 80) score -= 40;
  if (score >= 0 && !candidate.modeRegion && !candidate.highConfidence) score = -1;
  return score;
}

export function scoreModeOptionCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const intent = candidate.intent || modeIntentForLabel(label);
  const targetIntent = normalizeModeIntentToken(candidate.targetIntent);
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  let score = -1;

  if (intent === targetIntent) score = 240;
  if (score >= 0 && candidate.optionInsideMenu) score += 20;
  if (score >= 0 && candidate.ariaChecked) score += 10;
  if (score >= 0 && candidate.active) score -= 5;
  if (score >= 0 && area > 80_000) score -= 120;
  else if (score >= 0 && area > 20_000) score -= 30;
  if (score >= 0 && height > 120) score -= 80;
  if (score >= 0 && width > 600) score -= 60;
  if (score >= 0 && label.length > 180) score -= 120;
  return score;
}

export function scoreModelTriggerCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  if (!label || isBlockedUiLabel(label)) return -1;
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
    !candidate.projectOptions
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

export function scoreModelConfigureCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  if (!label || isBlockedUiLabel(label) || !/\bconfigure\b/.test(label)) return -1;
  if (/\blatest\b/.test(label) && /\binstant\b/.test(label) && /\bthinking\b/.test(label) && /\bpro\b/.test(label)) return -1;
  if (!candidate.optionInsideMenu && !candidate.highConfidenceConfigure) return -1;
  if (candidate.highConfidenceConfigure) {
    const exactConfigure = /^configure(?:\.{3}|…)?$/.test(label);
    return (exactConfigure ? 320 : 240) + (candidate.isButtonLike ? 20 : 0) + (candidate.optionInsideMenu ? 20 : 0);
  }

  let score = 180;
  if (candidate.isButtonLike) score += 20;
  if (area > 80_000) score -= 120;
  else if (area > 30_000) score -= 30;
  if (height > 140) score -= 80;
  if (width > 720) score -= 60;
  if (label.length > 180) score -= 120;
  return score >= 0 ? score : -1;
}

export function scoreModelLegacyModelsCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  const ariaExpanded = String(candidate.ariaExpanded || '').trim().toLowerCase();
  if (!label || isBlockedUiLabel(label)) return -1;
  if (!/\blegacy\b.*\bmodels?\b|\bmodels?\b.*\blegacy\b/.test(label)) return -1;
  if (!candidate.optionInsideMenu || !candidate.isButtonLike) return -1;
  if (candidate.active || ariaExpanded === 'true') return -1;

  let score = 210;
  if (area > 80_000) score -= 120;
  else if (area > 30_000) score -= 30;
  if (height > 140) score -= 80;
  if (width > 720) score -= 60;
  if (label.length > 180) score -= 120;
  return score >= 0 ? score : -1;
}

export function scoreModelVersionDropdownCandidate(candidate = {}) {
  const label = normalizeUiText(candidate.label);
  const area = Math.max(0, Number(candidate.area) || 0);
  const width = Math.max(0, Number(candidate.width) || 0);
  const height = Math.max(0, Number(candidate.height) || 0);
  const ariaExpanded = String(candidate.ariaExpanded || '').trim().toLowerCase();
  const exactVersionLabel = /^(?:latest|5\.[245]|o3)$/.test(label);
  if (!label || isBlockedUiLabel(label)) return -1;
  if (!candidate.optionInsideMenu) return -1;
  if (!candidate.isButtonLike && !exactVersionLabel) return -1;
  if (candidate.active || ariaExpanded === 'true') return -1;
  if (/\binstant\b|\bthinking\b|\bpro\b|\bconfigure\b/.test(label)) return -1;
  if (exactVersionLabel) {
    return 300 - (area > 30_000 ? 40 : 0) - (height > 100 ? 40 : 0);
  }
  if (/\blatest\b/.test(label) && !/\b5\.[245]\b|\bo3\b/.test(label)) {
    return 260 - (area > 30_000 ? 40 : 0) - (height > 100 ? 40 : 0);
  }
  if (/^model\s+latest\b/.test(label)) {
    return 220 - (area > 30_000 ? 40 : 0) - (height > 100 ? 40 : 0);
  }
  if (/^5\.[245]\b|\bo3\b/.test(label)) {
    return 200 - (area > 30_000 ? 40 : 0) - (height > 100 ? 40 : 0);
  }
  if (width > 720 || label.length > 180) return -1;
  return -1;
}

export function shouldTrackPendingModelTrigger(snap = {}) {
  return snap?.action === 'pointer_trigger' && !!snap.signature && !snap.menuOpen;
}

export function shouldTrackPendingModeTrigger(snap = {}) {
  return snap?.action === 'pointer_trigger' && !!snap.signature;
}

export const CHATGPT_MODE_PICKER_PRIMITIVES_JS = String.raw`
  const modePickerPrimitives = (() => {
    const CHATGPT_MODE_INTENT_META = ${JSON.stringify(CHATGPT_MODE_INTENT_META)};
    const CHATGPT_MODE_INTENT_ENTRIES = ${JSON.stringify(CHATGPT_MODE_INTENT_ENTRIES)};
    const CHATGPT_ANY_MODE_PATTERN = ${JSON.stringify(CHATGPT_ANY_MODE_PATTERN)};
    ${normalizeUiText.toString()}
    ${isBlockedUiLabel.toString()}
    ${normalizeModeIntentToken.toString()}
    ${modeIntentForLabel.toString()}
    ${modeIntentLabelLooksUsable.toString()}
    ${modelPickerControlText.toString()}
    ${descriptorText.toString()}
    ${isHighConfidenceModeControlDescriptor.toString()}
    ${scoreModeTriggerCandidate.toString()}
    ${scoreModeOptionCandidate.toString()}
    return {
      modeIntentForLabel,
      modePickerControlText: modelPickerControlText,
      isHighConfidenceModeControlDescriptor,
      scoreModeTriggerCandidate,
      scoreModeOptionCandidate
    };
  })();
`;

export const CHATGPT_MODEL_PICKER_PRIMITIVES_JS = String.raw`
  const modelPickerPrimitives = (() => {
    const CHATGPT_MODEL_INTENT_META = ${JSON.stringify(CHATGPT_MODEL_INTENT_META)};
    const CHATGPT_MODEL_INTENT_ENTRIES = ${JSON.stringify(CHATGPT_MODEL_INTENT_ENTRIES)};
    const CHATGPT_ANY_MODEL_PATTERN = ${JSON.stringify(CHATGPT_ANY_MODEL_PATTERN)};
    ${normalizeUiText.toString()}
    ${isBlockedUiLabel.toString()}
    ${modelIntentPatternMatchesLabel.toString()}
    ${modelIntentForLabel.toString()}
    ${isModeOnlyModelPickerState.toString()}
    ${isModelGenerationPickerState.toString()}
    ${modelPickerControlText.toString()}
    ${descriptorText.toString()}
    ${isHighConfidenceModelControlDescriptor.toString()}
    ${isProjectOptionsControlDescriptor.toString()}
    ${isProjectModelModeControlDescriptor.toString()}
    ${scoreModelTriggerCandidate.toString()}
    ${scoreModelOptionCandidate.toString()}
    ${scoreModelConfigureCandidate.toString()}
    ${scoreModelLegacyModelsCandidate.toString()}
    ${scoreModelVersionDropdownCandidate.toString()}
    return {
      modelIntentForLabel,
      isModeOnlyModelPickerState,
      isModelGenerationPickerState,
      modelPickerControlText,
      isHighConfidenceModelControlDescriptor,
      isProjectOptionsControlDescriptor,
      isProjectModelModeControlDescriptor,
      scoreModelTriggerCandidate,
      scoreModelOptionCandidate,
      scoreModelConfigureCandidate,
      scoreModelLegacyModelsCandidate,
      scoreModelVersionDropdownCandidate
    };
  })();
`;
