import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHATGPT_MODE_PICKER_PRIMITIVES_JS,
  CHATGPT_MODEL_PICKER_PRIMITIVES_JS,
  isHighConfidenceModelControlDescriptor,
  isHighConfidenceModeControlDescriptor,
  isModelGenerationPickerState,
  isModeOnlyModelPickerState,
  isProjectModelModeControlDescriptor,
  isProjectOptionsControlDescriptor,
  modeIntentForLabel,
  modeIntentLabelLooksUsable,
  modelIntentForLabel,
  modelIntentLabelLooksUsable,
  scoreModeOptionCandidate,
  scoreModeTriggerCandidate,
  scoreModelConfigureCandidate,
  scoreModelLegacyModelsCandidate,
  scoreModelOptionCandidate,
  scoreModelTriggerCandidate,
  scoreModelVersionDropdownCandidate,
  shouldTrackPendingModeTrigger,
  shouldTrackPendingModelTrigger
} from '../chatgpt-ui-primitives.mjs';

test('chatgpt-ui-primitives: maps usable model labels and rejects attachment chrome', () => {
  assert.equal(modelIntentForLabel('GPT-5.5 Pro'), 'gpt-5.5-pro');
  assert.equal(modelIntentForLabel('GPT-5.4 Pro legacy'), 'gpt-5.4-pro');
  assert.equal(modelIntentForLabel('Legacy Pro'), 'gpt-5.4-pro');
  assert.equal(modelIntentForLabel('uploaded GPT-5.4 Pro attached file'), null);
  assert.equal(modelIntentLabelLooksUsable('uploaded GPT-5.4 Pro attached file', 'gpt-5.4-pro'), false);
});

test('chatgpt-ui-primitives: detects current mode-only model switcher menus', () => {
  assert.equal(
    isModeOnlyModelPickerState({
      menuText: 'Latest Instant For everyday chats Thinking For complex questions Pro Research-grade intelligence Configure...',
      optionHints: ['instant', 'thinking', 'pro']
    }),
    true
  );
  assert.equal(
    isModeOnlyModelPickerState({
      menuText: 'Latest Instant Thinking Pro GPT-5.4 Pro GPT-5.5 Pro',
      optionHints: ['gpt-5.4 pro']
    }),
    false
  );
});

test('chatgpt-ui-primitives: detects generation picker menus without the target legacy model', () => {
  assert.equal(
    isModelGenerationPickerState({
      menuText: 'Intelligence Model Latest Instant 5.3 For everyday chats Thinking 5.5 For complex questions Pro 5.5 Research-grade intelligence',
      optionHints: ['instant 5.3', 'thinking 5.5', 'pro 5.5']
    }),
    true
  );
  assert.equal(
    isModelGenerationPickerState({
      menuText: 'Latest Instant For everyday chats Thinking For complex questions Pro Research-grade intelligence Configure...',
      optionHints: ['instant', 'thinking', 'pro']
    }),
    false
  );
});

test('chatgpt-ui-primitives: identifies project model/mode control without matching profile options', () => {
  assert.equal(
    isProjectModelModeControlDescriptor({ label: 'Extended Pro', isButtonLike: true }),
    true
  );
  assert.equal(
    isProjectModelModeControlDescriptor({ label: 'Extended Pro', aria: 'Accounts profile menu', isButtonLike: true }),
    false
  );
  assert.equal(
    isProjectModelModeControlDescriptor({ label: 'Rename project Extended Pro', isButtonLike: true }),
    false
  );
  assert.equal(
    isProjectModelModeControlDescriptor({ label: 'Extended Pro, click to remove', isButtonLike: true }),
    false
  );
});

test('chatgpt-ui-primitives: classifies high-confidence model and project option controls', () => {
  assert.equal(
    isHighConfidenceModelControlDescriptor({
      label: 'ChatGPT',
      dataTestId: 'model-switcher-dropdown-button',
      isButtonLike: true
    }),
    true
  );
  assert.equal(
    isHighConfidenceModelControlDescriptor({ label: 'GPT-5.4 Pro', isButtonLike: true }),
    true
  );
  assert.equal(
    isProjectOptionsControlDescriptor({ label: 'Open project options', isButtonLike: true }),
    true
  );
});

test('chatgpt-ui-primitives: ranks explicit model controls and rejects pure mode chips', () => {
  const exactTarget = scoreModelTriggerCandidate({
    label: 'GPT-5.4 Pro',
    intent: 'gpt-5.4-pro',
    targetIntent: 'gpt-5.4-pro',
    highConfidence: true,
    modelRegion: true,
    area: 4_000,
    width: 140,
    height: 32
  });
  const pureModeChip = scoreModelTriggerCandidate({
    label: 'Extended Pro',
    targetIntent: 'gpt-5.4-pro',
    projectModelMode: true,
    modelRegion: true,
    area: 5_440,
    width: 160,
    height: 34
  });
  const genericHeader = scoreModelTriggerCandidate({
    label: 'ChatGPT model-switcher-dropdown-button',
    targetIntent: 'gpt-5.4-pro',
    highConfidence: true,
    modelRegion: true,
    hasDataTestId: true,
    area: 4_000,
    width: 130,
    height: 32
  });

  assert.equal(exactTarget > genericHeader, true);
  assert.equal(pureModeChip, -1);
  assert.equal(
    scoreModelTriggerCandidate({
      label: 'Extended Pro, click to remove',
      targetIntent: 'gpt-5.4-pro',
      projectModelMode: true,
      modelRegion: true,
      area: 5_440,
      width: 160,
      height: 34
    }),
    -1
  );
});

test('chatgpt-ui-primitives: does not score off-region project mode or stale-open project option triggers', () => {
  assert.equal(
    scoreModelTriggerCandidate({
      label: 'Extended Pro',
      targetIntent: 'gpt-5.4-pro',
      projectModelMode: true,
      modelRegion: false,
      area: 5_440,
      width: 160,
      height: 34
    }),
    -1
  );
  assert.equal(
    scoreModelTriggerCandidate({
      label: 'Open project options',
      targetIntent: 'gpt-5.4-pro',
      projectOptions: true,
      modelRegion: true,
      menuOpen: true,
      area: 1_024,
      width: 32,
      height: 32
    }),
    -1
  );
});

test('chatgpt-ui-primitives: scores target model options and pending trigger tracking', () => {
  assert.equal(
    scoreModelOptionCandidate({
      label: 'GPT-5.4 Pro legacy',
      targetIntent: 'gpt-5.4-pro',
      optionInsideMenu: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    280
  );
  assert.equal(
    scoreModelOptionCandidate({
      label: 'GPT-5.5 Pro',
      targetIntent: 'gpt-5.4-pro',
      optionInsideMenu: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    -1
  );
  assert.equal(
    shouldTrackPendingModelTrigger({ action: 'pointer_trigger', signature: 'x', menuOpen: false }),
    true
  );
  assert.equal(
    shouldTrackPendingModelTrigger({ action: 'pointer_trigger', signature: 'x', menuOpen: true }),
    false
  );
});

test('chatgpt-ui-primitives: scores Configure and Legacy model controls in picker menus', () => {
  assert.equal(
    scoreModelConfigureCandidate({
      label: 'Configure...',
      optionInsideMenu: true,
      isButtonLike: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    200
  );
  assert.equal(
    scoreModelConfigureCandidate({
      label: 'Configure...',
      optionInsideMenu: false,
      isButtonLike: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    -1
  );
  assert.equal(
    scoreModelConfigureCandidate({
      label: 'model-configure-modal Configure...',
      optionInsideMenu: false,
      highConfidenceConfigure: true,
      isButtonLike: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    260
  );
  assert.equal(
    scoreModelConfigureCandidate({
      label: 'Configure...',
      optionInsideMenu: true,
      highConfidenceConfigure: true,
      isButtonLike: false,
      area: 7_200,
      width: 200,
      height: 36
    }),
    340
  );
  assert.equal(
    scoreModelConfigureCandidate({
      label: 'Latest Instant Thinking Pro Configure...',
      optionInsideMenu: true,
      isButtonLike: false,
      area: 70_000,
      width: 400,
      height: 180
    }),
    -1
  );
  assert.equal(
    scoreModelLegacyModelsCandidate({
      label: 'Legacy models',
      optionInsideMenu: true,
      isButtonLike: true,
      ariaExpanded: 'false',
      area: 7_200,
      width: 200,
      height: 36
    }),
    210
  );
  assert.equal(
    scoreModelLegacyModelsCandidate({
      label: 'Legacy models',
      optionInsideMenu: true,
      isButtonLike: true,
      ariaExpanded: 'true',
      area: 7_200,
      width: 200,
      height: 36
    }),
    -1
  );
});

test('chatgpt-ui-primitives: scores nested model version dropdown controls', () => {
  assert.equal(
    scoreModelVersionDropdownCandidate({
      label: 'Latest',
      optionInsideMenu: true,
      isButtonLike: true,
      ariaExpanded: 'false',
      area: 6_000,
      width: 120,
      height: 36
    }),
    300
  );
  assert.equal(
    scoreModelVersionDropdownCandidate({
      label: 'Model Latest',
      optionInsideMenu: true,
      isButtonLike: true,
      ariaExpanded: 'false',
      area: 34_000,
      width: 360,
      height: 80
    }),
    220
  );
  assert.equal(
    scoreModelVersionDropdownCandidate({
      label: 'Latest',
      optionInsideMenu: true,
      isButtonLike: true,
      ariaExpanded: 'true',
      area: 6_000,
      width: 120,
      height: 36
    }),
    -1
  );
  assert.equal(
    scoreModelVersionDropdownCandidate({
      label: 'Latest Instant 5.3 Thinking 5.5 Pro 5.5 Configure...',
      optionInsideMenu: true,
      isButtonLike: false,
      ariaExpanded: 'false',
      area: 250_000,
      width: 800,
      height: 300
    }),
    -1
  );
});

test('chatgpt-ui-primitives: exposes browser evaluator source for the controller', () => {
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /modelPickerPrimitives/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /scoreModelTriggerCandidate/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /scoreModelConfigureCandidate/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /scoreModelLegacyModelsCandidate/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /scoreModelVersionDropdownCandidate/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /isModeOnlyModelPickerState/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /isModelGenerationPickerState/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /isProjectModelModeControlDescriptor/);
});

test('chatgpt-ui-primitives: maps usable mode labels and rejects attachment chrome', () => {
  assert.equal(modeIntentForLabel('Extended Pro'), 'extended-pro');
  assert.equal(modeIntentForLabel('Pro'), 'extended-pro');
  assert.equal(modeIntentForLabel('Thinking'), 'thinking');
  assert.equal(modeIntentForLabel('Reasoning'), 'thinking');
  assert.equal(modeIntentForLabel('Fast'), 'instant');
  assert.equal(modeIntentForLabel('uploaded Thinking attached file'), null);
  assert.equal(modeIntentLabelLooksUsable('uploaded Thinking attached file', 'thinking'), false);
});

test('chatgpt-ui-primitives: classifies high-confidence mode controls', () => {
  assert.equal(
    isHighConfidenceModeControlDescriptor({
      label: 'ChatGPT',
      dataTestId: 'model-switcher-dropdown-button'
    }),
    true
  );
  assert.equal(
    isHighConfidenceModeControlDescriptor({
      label: 'Choose mode',
      aria: 'Mode selector'
    }),
    true
  );
  assert.equal(isHighConfidenceModeControlDescriptor({ label: 'Reason about this' }), false);
});

test('chatgpt-ui-primitives: scores mode triggers with composer and prompt boosts', () => {
  const targetInComposer = scoreModeTriggerCandidate({
    label: 'Extended Pro',
    intent: 'extended-pro',
    targetIntent: 'extended-pro',
    modeRegion: true,
    inComposer: true,
    promptProximityBoost: 160,
    area: 4_000,
    width: 140,
    height: 32,
    y: 880
  });
  const genericHeader = scoreModeTriggerCandidate({
    label: 'ChatGPT model-switcher-dropdown-button',
    targetIntent: 'extended-pro',
    highConfidence: true,
    modeRegion: true,
    hasDataTestId: true,
    area: 4_000,
    width: 140,
    height: 32,
    y: 40
  });
  const activeNonTarget = scoreModeTriggerCandidate({
    label: 'Thinking',
    intent: 'thinking',
    targetIntent: 'extended-pro',
    active: true,
    modeRegion: true,
    area: 4_000,
    width: 140,
    height: 32,
    y: 880
  });

  assert.equal(targetInComposer > genericHeader, true);
  assert.equal(genericHeader > activeNonTarget, true);
});

test('chatgpt-ui-primitives: rejects off-region mode triggers and scores mode options', () => {
  assert.equal(
    scoreModeTriggerCandidate({
      label: 'Thinking',
      intent: 'thinking',
      targetIntent: 'thinking',
      modeRegion: false,
      highConfidence: false,
      area: 4_000,
      width: 140,
      height: 32,
      y: 880
    }),
    -1
  );
  assert.equal(
    scoreModeOptionCandidate({
      label: 'Extended Pro',
      targetIntent: 'extended-pro',
      optionInsideMenu: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    260
  );
  assert.equal(
    scoreModeOptionCandidate({
      label: 'Thinking',
      targetIntent: 'extended-pro',
      optionInsideMenu: true,
      area: 7_200,
      width: 200,
      height: 36
    }),
    -1
  );
});

test('chatgpt-ui-primitives: exposes mode browser evaluator source and pending trigger behavior', () => {
  assert.equal(
    shouldTrackPendingModeTrigger({ action: 'pointer_trigger', signature: 'x', menuOpen: true }),
    true
  );
  assert.equal(shouldTrackPendingModeTrigger({ action: 'pointer_option', signature: 'x' }), false);
  assert.match(CHATGPT_MODE_PICKER_PRIMITIVES_JS, /modePickerPrimitives/);
  assert.match(CHATGPT_MODE_PICKER_PRIMITIVES_JS, /scoreModeTriggerCandidate/);
  assert.match(CHATGPT_MODE_PICKER_PRIMITIVES_JS, /isHighConfidenceModeControlDescriptor/);
});
