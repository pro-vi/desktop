import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeChatGptModelIntent,
  normalizeChatGptModeIntent,
  normalizePersistedChatGptKeyMeta,
  resolveChatGptChatProfile,
  resolveChatGptImageProfile
} from '../chatgpt-mode-intent.mjs';

test('chatgpt-mode-intent: normalizes supported aliases', () => {
  assert.equal(normalizeChatGptModeIntent('pro'), 'extended-pro');
  assert.equal(normalizeChatGptModeIntent('extended_pro'), 'extended-pro');
  assert.equal(normalizeChatGptModeIntent('reasoning'), 'thinking');
  assert.equal(normalizeChatGptModeIntent('fast'), 'instant');
  assert.equal(normalizeChatGptModeIntent('unknown', { fallback: 'thinking' }), 'thinking');
  assert.equal(normalizeChatGptModeIntent('unknown', { fallback: null }), null);
});

test('chatgpt-mode-intent: normalizes supported model aliases', () => {
  assert.equal(normalizeChatGptModelIntent('gpt 5.5 pro'), 'gpt-5.5-pro');
  assert.equal(normalizeChatGptModelIntent('5.5'), 'gpt-5.5-pro');
  assert.equal(normalizeChatGptModelIntent('gpt_5_4_pro'), 'gpt-5.4-pro');
  assert.equal(normalizeChatGptModelIntent('legacy pro'), 'gpt-5.4-pro');
  assert.equal(normalizeChatGptModelIntent('unknown', { fallback: 'gpt-5.5-pro' }), 'gpt-5.5-pro');
  assert.equal(normalizeChatGptModelIntent('unknown', { fallback: null }), null);
});

test('chatgpt-mode-intent: normalizes persisted key metadata', () => {
  assert.deepEqual(
    normalizePersistedChatGptKeyMeta({
      projectUrl: ' https://chatgpt.com/g/g-p-test/project ',
      conversationUrl: ' https://chatgpt.com/g/g-p-test/c/thread ',
      modeIntent: ' Pro ',
      modelIntent: ' legacy pro '
    }),
    {
      projectUrl: 'https://chatgpt.com/g/g-p-test/project',
      conversationUrl: 'https://chatgpt.com/g/g-p-test/c/thread',
      modeIntent: 'extended-pro',
      modelIntent: 'gpt-5.4-pro'
    }
  );
});

test('chatgpt-mode-intent: chat profile prefers saved key metadata, then defaults', () => {
  const profile = resolveChatGptChatProfile({
    key: 'main',
    settings: { defaultProjectUrl: 'https://chatgpt.com/g/g-p-default/project', defaultChatModeIntent: 'thinking' },
    savedMeta: {
      projectUrl: 'https://chatgpt.com/g/g-p-saved/project',
      conversationUrl: 'https://chatgpt.com/g/g-p-saved/c/thread',
      modeIntent: 'extended-pro',
      modelIntent: 'gpt-5.4-pro'
    }
  });

  assert.deepEqual(profile, {
    profile: 'chat',
    imageGeneration: false,
    requestedKey: 'main',
    requestedTabId: null,
    projectUrl: 'https://chatgpt.com/g/g-p-saved/project',
    conversationUrl: 'https://chatgpt.com/g/g-p-saved/c/thread',
    modeIntent: 'extended-pro',
    modelIntent: 'gpt-5.4-pro',
    modelIntentConfirmation: 'ui',
    persistKeyLocation: true
  });
});

test('chatgpt-mode-intent: chat profile can route model intent through configured projects', () => {
  const profile = resolveChatGptChatProfile({
    key: 'main',
    modelIntent: 'gpt-5.4-pro',
    settings: {
      defaultGpt54ProProjectUrl: 'https://chatgpt.com/g/g-p-54/project'
    }
  });

  assert.equal(profile.projectUrl, 'https://chatgpt.com/g/g-p-54/project');
  assert.equal(profile.modelIntent, 'gpt-5.4-pro');
  assert.equal(profile.modelIntentConfirmation, 'project-url');
});

test('chatgpt-mode-intent: default project keeps model lanes inside the Agentify project', () => {
  const profile = resolveChatGptChatProfile({
    key: 'main',
    modelIntent: 'gpt-5.4-pro',
    settings: {
      defaultProjectUrl: 'https://chatgpt.com/g/g-p-agentify/project',
      defaultGpt54ProProjectUrl: 'https://chatgpt.com/g/g-p-54/project'
    }
  });

  assert.equal(profile.projectUrl, 'https://chatgpt.com/g/g-p-agentify/project');
  assert.equal(profile.modelIntent, 'gpt-5.4-pro');
  assert.equal(profile.modelIntentConfirmation, 'ui');
});

test('chatgpt-mode-intent: image profile injects the dedicated image key and thinking default', () => {
  const profile = resolveChatGptImageProfile({
    settings: {
      defaultImageProjectUrl: 'https://chatgpt.com/g/g-p-image/project',
      defaultImageModeIntent: 'thinking',
      defaultImageKey: 'image-lab'
    }
  });

  assert.deepEqual(profile, {
    profile: 'image',
    imageGeneration: true,
    requestedKey: 'image-lab',
    requestedTabId: null,
    projectUrl: 'https://chatgpt.com/g/g-p-image/project',
    conversationUrl: null,
    modeIntent: 'thinking',
    modelIntent: null,
    modelIntentConfirmation: 'ui',
    persistKeyLocation: false
  });
});
