import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('chatgpt-mode-intent: normalizes persisted key metadata', () => {
  assert.deepEqual(
    normalizePersistedChatGptKeyMeta({
      projectUrl: ' https://chatgpt.com/g/g-p-test/project ',
      conversationUrl: ' https://chatgpt.com/g/g-p-test/c/thread ',
      modeIntent: ' Pro '
    }),
    {
      projectUrl: 'https://chatgpt.com/g/g-p-test/project',
      conversationUrl: 'https://chatgpt.com/g/g-p-test/c/thread',
      modeIntent: 'extended-pro'
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
      modeIntent: 'extended-pro'
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
    persistKeyLocation: true
  });
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
    persistKeyLocation: false
  });
});
