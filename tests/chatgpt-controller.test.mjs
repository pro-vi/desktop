import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChatGPTController } from '../chatgpt-controller.mjs';

function readyState() {
  return {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    readyState: 'complete',
    blocked: false,
    promptVisible: true,
    kind: null,
    indicators: {
      hasTurnstile: false,
      hasArkose: false,
      hasVerifyButton: false,
      looks403: false,
      loginLike: false,
      rawPromptVisible: true,
      sendVisible: true
    }
  };
}

test('chatgpt-controller: send falls back to requestSubmit on the active composer before Enter', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes("form.requestSubmit")) {
        events.push('requestSubmit');
        return true;
      }
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com' };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 7 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), true);
  assert.equal(events.includes('key:Enter'), false);
});

test('chatgpt-controller: send avoids requestSubmit when no explicit send submitter is available', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes("form.requestSubmit")) {
        events.push('requestSubmit');
        return false;
      }
      if (js.includes('prompt?.focus?.()')) return true;
      if (js.includes('already_generating')) return { ok: true, fallbackEnter: true, requestSubmit: false, host: 'chatgpt.com', promptLen: 8 };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 8 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText(text) {
      events.push(`text:${text}`);
    },
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('requestSubmit'), false);
  assert.equal(events.includes('key:Enter'), true);
});

test('chatgpt-controller: query does not accept unchanged fallback page text from an existing conversation', async () => {
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 1_000_000;
  Date.now = () => {
    fakeNow += 500;
    return fakeNow;
  };

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
        if (js.includes("already_generating")) {
          return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
        }
        if (js.includes('return { count: nodes.length')) {
          return { count: 0, lastText: '', pageText: 'Existing assistant reply' };
        }
        if (js.includes('promptLen')) {
          return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: 'Existing assistant reply',
            count: 0,
            usedFallback: true,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            pageText: 'Existing assistant reply'
          };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/existing';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    await assert.rejects(
      controller.query({ prompt: 'agentify', timeoutMs: 20_000 }),
      /timeout_waiting_for_response/
    );
    assert.equal(waitForAssistantChecks >= 1, true);
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: query emits conversationUrl progress when a new thread URL appears', async () => {
  const progress = [];
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 2_000_000;
  Date.now = () => {
    fakeNow += 500;
    return fakeNow;
  };

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
        if (js.includes("already_generating")) {
          return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
        }
        if (js.includes('return { count: nodes.length')) {
          return { count: 0, lastText: '', pageText: '' };
        }
        if (js.includes('promptLen')) {
          return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          if (waitForAssistantChecks === 1) {
            return {
              stop: true,
              sendEnabled: false,
              sendFound: true,
              txt: 'Thinking',
              count: 1,
              usedFallback: false,
              hasError: false,
              hasContinue: false,
              hasRegenerate: false,
              isThinking: false,
              pageText: 'Thinking',
              currentUrl: 'https://chatgpt.com/g/g-p-test/c/new-thread'
            };
          }
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: 'Final answer',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            pageText: 'Final answer',
            currentUrl: 'https://chatgpt.com/g/g-p-test/c/new-thread'
          };
        }
        if (js.includes('const codes = Array.from')) {
          return { codeBlocks: [] };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/new-thread';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    const result = await controller.query({
      prompt: 'agentify',
      timeoutMs: 20_000,
      onProgress: async (patch) => {
        progress.push(patch);
      }
    });

    assert.equal(result.text, 'Final answer');
    assert.equal(waitForAssistantChecks >= 2, true);
    assert.equal(
      progress.some((patch) => patch?.conversationUrl === 'https://chatgpt.com/g/g-p-test/c/new-thread'),
      true
    );
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: query applies the requested mode intent before sending', async () => {
  const progress = [];
  const pointerEvents = [];
  let modeChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        modeChecks += 1;
        if (modeChecks === 1) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_mode_trigger',
            targetIntent: 'extended-pro',
            activeIntent: 'thinking',
            label: 'Thinking',
            rect: { x: 40, y: 40, w: 100, h: 28 },
            menuOpen: false
          };
        }
        if (modeChecks === 2) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_mode_option',
            targetIntent: 'extended-pro',
            activeIntent: 'thinking',
            label: 'Extended Pro',
            rect: { x: 60, y: 80, w: 120, h: 28 },
            menuOpen: true
          };
        }
        return {
          active: true,
          action: 'none',
          reason: 'mode_already_active',
          targetIntent: 'extended-pro',
          activeIntent: 'extended-pro',
          label: 'Extended Pro'
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('return { count: nodes.length')) {
        return { count: 0, lastText: '', pageText: '' };
      }
      if (js.includes('promptLen')) {
        return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      }
      if (js.includes('fallbackMainText')) {
        return {
          stop: false,
          sendEnabled: true,
          sendFound: true,
          txt: 'Final answer',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          isThinking: false,
          pageText: 'Final answer'
        };
      }
      if (js.includes('const codes = Array.from')) {
        return { codeBlocks: [] };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/g/g-p-test/c/mode-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse(x, y) {
      pointerEvents.push(`move:${x},${y}`);
    },
    async mouseDown(x, y) {
      pointerEvents.push(`down:${x},${y}`);
    },
    async mouseUp(x, y) {
      pointerEvents.push(`up:${x},${y}`);
    },
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      chatModeButton: '[data-testid="mode-trigger"]',
      chatModeMenu: '[role="menu"]',
      chatModeOption: '[role="menuitem"]',
      chatModeActive: '[aria-pressed="true"]'
    }
  });

  const result = await controller.query({
    prompt: 'agentify',
    timeoutMs: 20_000,
    modeIntent: 'extended-pro',
    onProgress: async (patch) => {
      progress.push(patch);
    }
  });

  assert.equal(result.text, 'Final answer');
  assert.equal(modeChecks >= 3, true);
  assert.equal(pointerEvents.filter((item) => item.startsWith('down:')).length, 4);
  assert.equal(progress.some((patch) => patch?.phase === 'activating_mode_intent' && patch?.modeIntent === 'extended-pro'), true);
});

test('chatgpt-controller: query does not click mode controls when the requested intent is already active', async () => {
  let modeChecks = 0;
  const pointerEvents = [];

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        modeChecks += 1;
        return {
          active: true,
          action: 'none',
          reason: 'mode_already_active',
          targetIntent: 'thinking',
          activeIntent: 'thinking',
          label: 'Thinking'
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('return { count: nodes.length')) {
        return { count: 0, lastText: '', pageText: '' };
      }
      if (js.includes('promptLen')) {
        return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      }
      if (js.includes('fallbackMainText')) {
        return {
          stop: false,
          sendEnabled: true,
          sendFound: true,
          txt: 'Done',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          isThinking: false,
          pageText: 'Done'
        };
      }
      if (js.includes('const codes = Array.from')) {
        return { codeBlocks: [] };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/g/g-p-test/c/mode-already-active';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse(x, y) {
      pointerEvents.push(`move:${x},${y}`);
    },
    async mouseDown(x, y) {
      pointerEvents.push(`down:${x},${y}`);
    },
    async mouseUp(x, y) {
      pointerEvents.push(`up:${x},${y}`);
    },
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const result = await controller.query({
    prompt: 'agentify',
    timeoutMs: 20_000,
    modeIntent: 'thinking'
  });

  assert.equal(result.text, 'Done');
  assert.equal(modeChecks, 1);
  assert.equal(pointerEvents.filter((item) => item.startsWith('down:')).length, 2);
});

test('chatgpt-controller: query fails closed when mode intent cannot be confirmed', async () => {
  const realNow = Date.now;
  let fakeNow = 6_000_000;
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        return {
          active: false,
          action: 'none',
          reason: 'mode_controls_not_found',
          targetIntent: 'extended-pro',
          activeIntent: 'thinking',
          menuOpen: false,
          composerHints: ['thinking']
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  try {
    await assert.rejects(
      controller.query({ prompt: 'agentify', timeoutMs: 20_000, modeIntent: 'extended-pro' }),
      (error) => {
        assert.equal(error?.message, 'mode_intent_activation_failed');
        assert.equal(error?.data?.reason, 'mode_controls_not_found');
        assert.equal(error?.data?.targetIntent, 'extended-pro');
        return true;
      }
    );
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: query treats creating-image placeholders as still generating until the final response arrives', async () => {
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 3_000_000;
  Date.now = () => {
    fakeNow += 500;
    return fakeNow;
  };

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
        if (js.includes("already_generating")) {
          return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
        }
        if (js.includes('return { count: nodes.length')) {
          return { count: 0, lastText: '', pageText: '' };
        }
        if (js.includes('promptLen')) {
          return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          if (waitForAssistantChecks <= 3) {
            return {
              stop: false,
              sendEnabled: true,
              sendFound: true,
              txt: 'Creating image\\n\\nThinking',
              count: 1,
              usedFallback: false,
              hasError: false,
              hasContinue: false,
              hasRegenerate: false,
              isThinking: false,
              pageText: 'Creating image\\n\\nThinking',
              currentUrl: 'https://chatgpt.com/g/g-p-test/c/image-thread'
            };
          }
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: 'Final image ready',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            pageText: 'Final image ready',
            currentUrl: 'https://chatgpt.com/g/g-p-test/c/image-thread'
          };
        }
        if (js.includes('const codes = Array.from')) {
          return { codeBlocks: [] };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/image-thread';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    const result = await controller.query({ prompt: 'make image', timeoutMs: 20_000 });
    assert.equal(result.text, 'Final image ready');
    assert.equal(waitForAssistantChecks >= 4, true);
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: image-generation queries keep waiting while fallback text is still thinking without image output', async () => {
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 4_000_000;
  Date.now = () => {
    fakeNow += 500;
    return fakeNow;
  };

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
        if (js.includes("already_generating")) {
          return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
        }
        if (js.includes('return { count: nodes.length')) {
          return { count: 0, lastText: '', pageText: '' };
        }
        if (js.includes('promptLen')) {
          return { stopVisible: false, sendDisabled: true, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          if (waitForAssistantChecks <= 3) {
            return {
              stop: false,
              sendEnabled: true,
              sendFound: true,
              txt: 'Generate the icon\\n\\nSketching it out\\n\\nThinking',
              count: 1,
              usedFallback: false,
              hasError: false,
              hasContinue: false,
              hasRegenerate: false,
              isThinking: false,
              imageCandidateCount: 0,
              pageText: 'Generate the icon\\n\\nSketching it out\\n\\nThinking',
              currentUrl: 'https://chatgpt.com/g/g-p-test/c/image-thread'
            };
          }
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: 'Final image ready',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            imageCandidateCount: 1,
            pageText: 'Final image ready',
            currentUrl: 'https://chatgpt.com/g/g-p-test/c/image-thread'
          };
        }
        if (js.includes('const codes = Array.from')) {
          return { codeBlocks: [] };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/image-thread';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    const result = await controller.query({ prompt: 'make image', timeoutMs: 20_000, imageGeneration: true });
    assert.equal(result.text, 'Final image ready');
    assert.equal(waitForAssistantChecks >= 4, true);
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: send fails when the prompt never stages in the active composer', async () => {
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 0 };
      }
      if (js.includes('promptLen')) {
        return { stopVisible: false, sendDisabled: true, promptLen: 0 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  await assert.rejects(
    controller.send({ text: 'agentify', timeoutMs: 5_000 }),
    /missing_staged_prompt/
  );
});

test('chatgpt-controller: query fails when attachment upload stays pending', async () => {
  const realNow = Date.now;
  let fakeNow = 2_000_000;
  const progress = [];
  Date.now = () => {
    fakeNow += 1_000;
    return fakeNow;
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attach-pending-'));
  const attachment = path.join(dir, 'PROGRESS.md');
  await fs.writeFile(attachment, '# progress\n', 'utf8');

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('const fileData =')) return { ok: true, count: 1 };
        if (js.includes('clicked_upload_menu_item')) return { action: 'click_item', reason: 'clicked_upload_menu_item', label: 'add files' };
        if (js.includes('const dialogBtn = Array.from')) {
          return {
            dismissed: false,
            done: false,
            pending: true,
            pendingText: 'Upload 0%',
            dialogText: '',
            chipCount: 1,
            attachmentControlCount: 0
          };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/existing';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    await assert.rejects(
      controller.query({
        prompt: 'agentify',
        attachments: [attachment],
        timeoutMs: 20_000,
        onProgress: async (patch) => {
          progress.push(patch);
        }
      }),
      /attachment_upload_stalled/
    );
    assert.equal(progress.some((patch) => patch?.attachmentDebug?.stage === 'inject_files'), true);
    assert.equal(progress.some((patch) => patch?.attachmentDebug?.stage === 'wait_upload' && patch?.attachmentDebug?.pendingText === 'Upload 0%'), true);
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: query fails when attachment dialog blocks upload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attach-dialog-'));
  const attachment = path.join(dir, 'PROGRESS.md');
  await fs.writeFile(attachment, '# progress\n', 'utf8');
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('const fileData =')) return { ok: true, count: 1 };
      if (js.includes('clicked_upload_menu_item')) return { action: 'click_item', reason: 'clicked_upload_menu_item', label: 'add files' };
      if (js.includes("const closeBtn = document.querySelector")) return true;
        if (js.includes('const dialogBtn = Array.from')) {
          return {
            dismissed: true,
            done: false,
            pending: false,
            pendingText: '',
            dialogText: "You've already uploaded this file.",
            chipCount: 1,
            attachmentControlCount: 1
          };
        }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/g/g-p-test/c/existing';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  await assert.rejects(
    controller.query({ prompt: 'agentify', attachments: [attachment], timeoutMs: 20_000 }),
    /attachment_upload_failed/
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('chatgpt-controller: query does not treat generic attachment chrome as a successful upload', async () => {
  const realNow = Date.now;
  let fakeNow = 3_000_000;
  Date.now = () => {
    fakeNow += 1_000;
    return fakeNow;
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attach-false-positive-'));
  const attachment = path.join(dir, 'PROGRESS.md');
  await fs.writeFile(attachment, '# progress\n', 'utf8');

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('const fileData =')) return { ok: true, count: 1 };
        if (js.includes('clicked_upload_menu_item')) return { action: 'click_item', reason: 'clicked_upload_menu_item', label: 'add files' };
        if (js.includes('const dialogBtn = Array.from')) {
          return {
            dismissed: false,
            done: false,
            pending: false,
            pendingText: '',
            dialogText: '',
            chipCount: 1,
            attachmentControlCount: 0,
            matchedNames: []
          };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/existing';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    await assert.rejects(
      controller.query({ prompt: 'agentify', attachments: [attachment], timeoutMs: 20_000 }),
      /attachment_upload_stalled/
    );
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: query proceeds when uploaded chip is present without visible filename text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attach-chip-success-'));
  const attachment = path.join(dir, 'PROGRESS.md');
  await fs.writeFile(attachment, '# progress\n', 'utf8');
  const events = [];
  let waitForSendChecks = 0;
  const realNow = Date.now;
  let fakeNow = 4_000_000;
  Date.now = () => {
    fakeNow += 500;
    return fakeNow;
  };

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('clicked_upload_menu_item')) return { action: 'click_item', reason: 'clicked_upload_menu_item', label: 'add files' };
        if (js.includes('const fileData =')) return { ok: true, count: 1 };
        if (js.includes('const dialogBtn = Array.from')) {
          return {
            dismissed: false,
            done: true,
            pending: false,
            pendingText: '',
            dialogText: '',
            chipCount: 1,
            attachmentControlCount: 1,
            matchedNames: []
          };
        }
        if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
        if (js.includes('return { count: nodes.length')) {
          return { count: 0, lastText: '', pageText: '' };
        }
        if (js.includes("already_generating")) {
          return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
        }
        if (js.includes('promptLen')) {
          waitForSendChecks += 1;
          return waitForSendChecks >= 2
            ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
            : { stopVisible: false, sendDisabled: false, promptLen: 8 };
        }
        if (js.includes('fallbackMainText')) {
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: '',
            count: 0,
            usedFallback: true,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            pageText: ''
          };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/existing';
      },
      async sendKey(key) {
        events.push(`key:${key}`);
      },
      async insertText(text) {
        events.push(`text:${text}`);
      },
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    };

    const controller = new ChatGPTController({
      page,
      selectors: {
        promptTextarea: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        stopButton: 'button[data-testid="stop-button"]',
        assistantMessage: '[data-message-author-role="assistant"]'
      }
    });

    await assert.rejects(
      controller.query({ prompt: 'agentify', attachments: [attachment], timeoutMs: 3_000 }),
      /timeout_waiting_for_response/
    );
    assert.equal(events.filter((event) => event.startsWith('text:')).map((event) => event.slice(5)).join(''), 'agentify');
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: research surfaces activation failure and progress metadata', async () => {
  const realNow = Date.now;
  let fakeNow = 5_000_000;
  const progress = [];
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('research_controls_not_found') && js.includes('clicked_deep_research_option')) {
        return { action: 'none', reason: 'research_controls_not_found', menuOpen: false };
      }
      if (js.includes('research_activation_pending')) return { active: false, action: 'none', reason: 'research_activation_pending', menuOpen: false };
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchModeButton: '[data-testid="research-button"]',
      researchModeMenu: '[role="menu"]',
      researchModeOption: '[role="menuitem"]',
      researchModeActive: '[aria-pressed="true"]'
    }
  });

  try {
    await assert.rejects(
      controller.research({
        prompt: 'formalize this problem',
        timeoutMs: 5,
        outDir: os.tmpdir(),
        onProgress: async (patch) => {
          progress.push(patch);
        }
      }),
      (error) => {
        assert.equal(error?.message, 'research_mode_activation_failed');
        assert.equal(error?.data?.reason, 'research_controls_not_found');
        return true;
      }
    );

    assert.equal(progress.some((item) => item?.phase === 'activating_research_mode'), true);
    assert.equal(
      progress.some((item) => item?.researchMeta?.activation?.error === 'research_controls_not_found'),
      true
    );
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: research runs under the controller mutex', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-research-mutex-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const realNow = Date.now;
  let fakeNow = 8_100_000;
  let clockMode = 'default';
  Date.now = () => {
    fakeNow += clockMode === 'wait' ? 31_000 : clockMode === 'export' ? 500 : 100;
    return fakeNow;
  };

  let sendChecks = 0;
  let waitChecks = 0;
  let exportChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('clicked_deep_research_option')) {
        return { action: 'click_item', reason: 'clicked_deep_research_option', label: 'deep research' };
      }
      if (js.includes('research_activation_pending')) {
        return {
          active: true,
          action: 'none',
          reason: 'latched_after_click',
          menuOpen: false,
          composerHints: ['deep research'],
          promptHints: []
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes('return { count: nodes.length')) {
        return { count: 0, lastText: '', pageText: '' };
      }
      if (js.includes("already_generating")) {
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('promptLen')) {
        sendChecks += 1;
        return sendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 8 };
      }
      if (js.includes('fallbackMainText')) {
        clockMode = 'wait';
        waitChecks += 1;
        if (waitChecks === 1) {
          return {
            stop: true,
            sendEnabled: false,
            sendFound: true,
            txt: '',
            count: 0,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: true,
            pageText: ''
          };
        }
        return {
          stop: false,
          sendEnabled: true,
          sendFound: true,
          txt: 'You said: Investigate this. ChatGPT said: Deep research Apps Sites ChatGPT can make mistakes. Check important info.',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          isThinking: false,
          pageText: 'placeholder'
        };
      }
      if (js.includes('return { codeBlocks: codes }')) {
        clockMode = 'default';
        return { codeBlocks: [] };
      }
      if (js.includes('clicked_markdown_option') && js.includes('clicked_export_trigger')) {
        clockMode = 'export';
        exportChecks += 1;
        return exportChecks === 1
          ? {
              ready: false,
              action: 'pointer_export',
              reason: 'clicked_export_trigger',
              label: 'download report',
              menuOpen: false,
              rect: { x: 500, y: 80, w: 24, h: 24 }
            }
          : {
              ready: false,
              action: 'pointer_markdown',
              reason: 'clicked_markdown_option',
              label: 'export to markdown',
              menuOpen: true,
              rect: { x: 560, y: 140, w: 180, h: 36 }
            };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-export';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {},
    async waitForDownload({ outDir: targetDir }) {
      const exportedPath = path.join(targetDir, 'report.md');
      await fs.writeFile(exportedPath, '# report\n\nreal markdown\n', 'utf8');
      return {
        path: exportedPath,
        name: 'report.md',
        mime: 'text/markdown',
        source: 'download://report'
      };
    }
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchModeButton: '[data-testid="research-button"]',
      researchModeMenu: '[role="menu"]',
      researchModeOption: '[role="menuitem"]',
      researchModeActive: '[aria-pressed="true"]',
      researchExportButton: '[data-testid="download-button"]',
      researchExportMenu: '[role="menu"]',
      researchExportMarkdownOption: '[role="menuitem"]'
    }
  });

  controller.downloadLastAssistantFiles = async () => [];

  const realMutex = controller.mutex;
  let mutexCalls = 0;
  controller.mutex = {
    run: async (fn) => {
      mutexCalls += 1;
      return await realMutex.run(fn);
    }
  };

  try {
    const result = await controller.research({
      prompt: 'Investigate this.',
      timeoutMs: 10_000,
      outDir
    });

    assert.equal(mutexCalls, 1);
    assert.equal(path.basename(result.research.exportedMarkdownPath), 'report.md');
  } finally {
    controller.mutex = realMutex;
    Date.now = realNow;
  }
});

test('chatgpt-controller: export-mode downloads ignore cited markdown links without download hints', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-export-filter-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const controller = new ChatGPTController({
    page: {},
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    },
    stateDir: outDir
  });

  controller.getLastAssistantDownloads = async () => ([
    {
      href: 'https://example.com/README.md',
      name: 'README.md',
      label: 'README.md',
      title: 'README.md',
      testId: null,
      downloadAttr: false
    },
    {
      href: 'blob:report',
      name: 'report.md',
      label: 'Export markdown',
      title: 'Export markdown',
      testId: 'export-markdown',
      downloadAttr: true,
      mime: 'text/markdown',
      dataUrl: 'data:text/markdown;base64,IyByZXBvcnQK'
    }
  ]);

  const saved = await controller.downloadLastAssistantFiles({ maxFiles: 6, outDir, linkMode: 'export' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'report.md');
  assert.equal(saved[0].source, 'blob:report');
});

test('chatgpt-controller: generic file download escalates to research export when no links are present', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-export-generic-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  let exportChecks = 0;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const nodes = Array.from(document.querySelectorAll') && js.includes('a[href], a[download]')) {
        return [];
      }
      if (js.includes('hasResearchSummary') && js.includes('hasExportButton')) {
        return { hasResearchSummary: true, hasExportButton: true };
      }
      if (js.includes('clicked_markdown_option') && js.includes('clicked_export_trigger')) {
        exportChecks += 1;
        return exportChecks === 1
          ? {
              ready: false,
              action: 'pointer_export',
              reason: 'clicked_export_trigger',
              label: 'export',
              menuOpen: false,
              rect: { x: 520, y: 90, w: 24, h: 24 }
            }
          : {
              ready: false,
              action: 'pointer_markdown',
              reason: 'clicked_markdown_option',
              label: 'export to markdown',
              menuOpen: true,
              rect: { x: 560, y: 140, w: 180, h: 36 }
            };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-export-generic';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {},
    async waitForDownload({ outDir: targetDir }) {
      const exportedPath = path.join(targetDir, 'report.md');
      await fs.writeFile(exportedPath, '# report\n\nexported via generic download\n', 'utf8');
      return {
        path: exportedPath,
        name: 'report.md',
        mime: 'text/markdown',
        source: 'download://report'
      };
    }
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchExportButton: '[data-testid="download-button"]',
      researchExportMenu: '[role="menu"]',
      researchExportMarkdownOption: '[role="menuitem"]'
    }
  });

  const saved = await controller.downloadLastAssistantFiles({ maxFiles: 3, outDir });
  assert.deepEqual(saved.map((item) => path.basename(item.path)), ['report.md']);
  assert.equal(saved[0].mime, 'text/markdown');
});

test('chatgpt-controller: research export opens the report view before clicking export', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-research-open-report-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  let exportChecks = 0;
  let clicks = 0;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('open_research_report') && js.includes('clicked_markdown_option') && js.includes('clicked_export_trigger')) {
        exportChecks += 1;
        if (exportChecks === 1) {
          return {
            ready: false,
            action: 'pointer_open_report',
            reason: 'open_research_report',
            label: 'deep research',
            menuOpen: false,
            rect: { x: 420, y: 220, w: 240, h: 40 }
          };
        }
        if (exportChecks === 2) {
          return {
            ready: false,
            action: 'pointer_export',
            reason: 'clicked_export_trigger',
            label: 'export',
            menuOpen: false,
            rect: { x: 700, y: 80, w: 28, h: 28 }
          };
        }
        return {
          ready: false,
          action: 'pointer_markdown',
          reason: 'clicked_markdown_option',
          label: 'export to markdown',
          menuOpen: true,
          rect: { x: 760, y: 132, w: 180, h: 36 }
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-report';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {
      clicks += 1;
    },
    async mouseUp() {},
    async setFileInputFiles() {},
    async waitForDownload({ outDir: targetDir }) {
      const exportedPath = path.join(targetDir, 'report.md');
      await fs.writeFile(exportedPath, '# report\n', 'utf8');
      return {
        path: exportedPath,
        name: 'report.md',
        mime: 'text/markdown',
        source: 'download://report'
      };
    }
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchExportButton: '[data-testid="download-button"]',
      researchExportMenu: '[role="menu"]',
      researchExportMarkdownOption: '[role="menuitem"]'
    }
  });

  const exported = await controller.exportResearchReport({ maxFiles: 3, outDir, timeoutMs: 15_000 });
  assert.equal(clicks >= 3, true);
  assert.equal(exported.files.length, 1);
  assert.equal(path.basename(exported.exportedMarkdownPath), 'report.md');
});

test('chatgpt-controller: research export can click nested deep research controls', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-research-nested-export-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  let nestedChecks = 0;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('clicked_markdown_option') && js.includes('clicked_export_trigger')) {
        return {
          ready: false,
          action: 'none',
          reason: 'export_controls_not_found',
          menuOpen: false
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async evaluateDeepResearch(js) {
      if (js.includes("reason: 'clicked_markdown_option'")) {
        nestedChecks += 1;
        if (nestedChecks === 1) {
          return {
            ready: false,
            action: 'dom_export_click',
            reason: 'clicked_export_trigger',
            label: 'Export'
          };
        }
        return {
          ready: false,
          action: 'dom_markdown_click',
          reason: 'clicked_markdown_option',
          label: 'Export to Markdown'
        };
      }
      throw new Error(`unexpected_deep_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-report';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {},
    async waitForDownload({ outDir: targetDir }) {
      const exportedPath = path.join(targetDir, 'nested-report.md');
      await fs.writeFile(exportedPath, '# nested report\n', 'utf8');
      return {
        path: exportedPath,
        name: 'nested-report.md',
        mime: 'text/markdown',
        source: 'download://nested-report'
      };
    }
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchExportButton: '[data-testid="download-button"]',
      researchExportMenu: '[role="menu"]',
      researchExportMarkdownOption: '[role="menuitem"]'
    }
  });

  const exported = await controller.exportResearchReport({ maxFiles: 3, outDir, timeoutMs: 15_000 });
  assert.equal(nestedChecks >= 2, true);
  assert.equal(exported.files.length, 1);
  assert.equal(path.basename(exported.exportedMarkdownPath), 'nested-report.md');
});

test('chatgpt-controller: readPageText falls back to nested deep research content', async () => {
  const page = {
    async navigate() {},
    async evaluate() {
      return 'You said:\nUse Deep Research.\nChatGPT said:\nDeep research\nApps\nSites\nChatGPT can make mistakes. Check important info.';
    },
    async evaluateDeepResearch() {
      return 'Research completed in 4m\nPrimary source on RAG benchmarks: RAGBench and TRACe';
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-report';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]'
    }
  });

  const text = await controller.readPageText({ maxChars: 500 });
  assert.match(text, /RAGBench and TRACe/);
});

test('chatgpt-controller: research export uses native download hook for markdown report', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-research-export-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const realNow = Date.now;
  let fakeNow = 8_000_000;
  let clockMode = 'default';
  Date.now = () => {
    fakeNow += clockMode === 'wait' ? 31_000 : clockMode === 'export' ? 500 : 100;
    return fakeNow;
  };

  let sendChecks = 0;
  let waitChecks = 0;
  let exportChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('clicked_deep_research_option')) {
        return { action: 'click_item', reason: 'clicked_deep_research_option', label: 'deep research' };
      }
      if (js.includes('research_activation_pending')) {
        return {
          active: true,
          action: 'none',
          reason: 'latched_after_click',
          menuOpen: false,
          composerHints: ['deep research'],
          promptHints: []
        };
      }
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes('return { count: nodes.length')) {
        return { count: 0, lastText: '', pageText: '' };
      }
      if (js.includes("already_generating")) {
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('promptLen')) {
        sendChecks += 1;
        return sendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 8 };
      }
      if (js.includes('fallbackMainText')) {
        clockMode = 'wait';
        waitChecks += 1;
        if (waitChecks === 1) {
          return {
            stop: true,
            sendEnabled: false,
            sendFound: true,
            txt: '',
            count: 0,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: true,
            pageText: ''
          };
        }
        return {
          stop: false,
          sendEnabled: true,
          sendFound: true,
          txt: 'You said: Investigate this. ChatGPT said: Deep research Apps Sites ChatGPT can make mistakes. Check important info.',
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          isThinking: false,
          pageText: 'placeholder'
        };
      }
      if (js.includes('return { codeBlocks: codes }')) {
        clockMode = 'default';
        return { codeBlocks: [] };
      }
      if (js.includes('clicked_markdown_option') && js.includes('clicked_export_trigger')) {
        clockMode = 'export';
        exportChecks += 1;
        return exportChecks === 1
          ? {
              ready: false,
              action: 'pointer_export',
              reason: 'clicked_export_trigger',
              label: 'download report',
              menuOpen: false,
              rect: { x: 500, y: 80, w: 24, h: 24 }
            }
          : {
              ready: false,
              action: 'pointer_markdown',
              reason: 'clicked_markdown_option',
              label: 'export to markdown',
              menuOpen: true,
              rect: { x: 560, y: 140, w: 180, h: 36 }
            };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/research-export';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {},
    async waitForDownload({ outDir: targetDir }) {
      const exportedPath = path.join(targetDir, 'report.md');
      await fs.writeFile(exportedPath, '# report\n\nreal markdown\n', 'utf8');
      return {
        path: exportedPath,
        name: 'report.md',
        mime: 'text/markdown',
        source: 'download://report'
      };
    }
  };

  const controller = new ChatGPTController({
    page,
    selectors: {
      promptTextarea: '#prompt-textarea',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      researchModeButton: '[data-testid="research-button"]',
      researchModeMenu: '[role="menu"]',
      researchModeOption: '[role="menuitem"]',
      researchModeActive: '[aria-pressed="true"]',
      researchExportButton: '[data-testid="download-button"]',
      researchExportMenu: '[role="menu"]',
      researchExportMarkdownOption: '[role="menuitem"]'
    }
  });

  controller.downloadLastAssistantFiles = async () => [];

  try {
    const result = await controller.research({
      prompt: 'Investigate this.',
      timeoutMs: 10_000,
      outDir
    });

    assert.equal(path.basename(result.research.exportedMarkdownPath), 'report.md');
    assert.deepEqual(result.research.files.map((item) => path.basename(item.path)), ['report.md']);
    assert.equal(result.researchMeta.activation.activated, true);
  } finally {
    Date.now = realNow;
  }
});
