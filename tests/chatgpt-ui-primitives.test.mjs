import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHATGPT_MODEL_PICKER_PRIMITIVES_JS,
  isHighConfidenceModelControlDescriptor,
  isProjectModelModeControlDescriptor,
  isProjectOptionsControlDescriptor,
  modelIntentForLabel,
  modelIntentLabelLooksUsable,
  scoreModelOptionCandidate,
  scoreModelTriggerCandidate,
  shouldTrackPendingModelTrigger
} from '../chatgpt-ui-primitives.mjs';

test('chatgpt-ui-primitives: maps usable model labels and rejects attachment chrome', () => {
  assert.equal(modelIntentForLabel('GPT-5.5 Pro'), 'gpt-5.5-pro');
  assert.equal(modelIntentForLabel('GPT-5.4 Pro legacy'), 'gpt-5.4-pro');
  assert.equal(modelIntentForLabel('Legacy Pro'), 'gpt-5.4-pro');
  assert.equal(modelIntentForLabel('uploaded GPT-5.4 Pro attached file'), null);
  assert.equal(modelIntentLabelLooksUsable('uploaded GPT-5.4 Pro attached file', 'gpt-5.4-pro'), false);
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

test('chatgpt-ui-primitives: ranks project Extended Pro above generic header picker', () => {
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
  const projectExtended = scoreModelTriggerCandidate({
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

  assert.equal(exactTarget > projectExtended, true);
  assert.equal(projectExtended > genericHeader, true);
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

test('chatgpt-ui-primitives: exposes browser evaluator source for the controller', () => {
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /modelPickerPrimitives/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /scoreModelTriggerCandidate/);
  assert.match(CHATGPT_MODEL_PICKER_PRIMITIVES_JS, /isProjectModelModeControlDescriptor/);
});
