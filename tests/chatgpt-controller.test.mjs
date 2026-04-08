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
        if (js.includes("const attach = candidates.find")) return true;
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
      if (js.includes("const attach = candidates.find")) return true;
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
        if (js.includes("const attach = candidates.find")) return true;
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
        if (js.includes("const attach = candidates.find")) return true;
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
