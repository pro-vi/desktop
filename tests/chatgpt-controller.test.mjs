import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { ChatGPTController } from '../chatgpt-controller.mjs';
import { normalizeLiveCapture } from '../transcript-contract.mjs';

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

test('chatgpt-controller: timed-out exclusive work quarantines already queued operations until settlement', async () => {
  const controller = new ChatGPTController({ page: {}, selectors: {} });
  let enterExclusive;
  let installQuarantine;
  let settleProviderWork;
  const entered = new Promise((resolve) => { enterExclusive = resolve; });
  const install = new Promise((resolve) => { installQuarantine = resolve; });
  const providerWork = new Promise((resolve) => { settleProviderWork = resolve; });

  const first = controller.runExclusive(async () => {
    enterExclusive();
    await install;
    controller.quarantineExclusiveUntil(providerWork);
    return 'timed-out';
  });
  await entered;
  const queued = controller.runExclusive(async () => 'unsafe-overlap');
  installQuarantine();

  assert.equal(await first, 'timed-out');
  await assert.rejects(queued, (error) => error?.code === 'tab_busy');
  await assert.rejects(
    controller.runExclusive(async () => 'unsafe-overlap'),
    (error) => error?.code === 'tab_busy'
  );

  settleProviderWork();
  await providerWork;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.runExclusive(async () => 'released'), 'released');
});

function virtualizedConversationPage(messages, {
  initialStart = 0,
  initialEnd = messages.length,
  initialScrollTop = 100,
  loadDelayMs = null,
  trailingLoadDelayMs = null,
  loadOnMessageScroll = true,
  scrollerMovable = true,
  providerIds = true,
  providerOrdinals = true,
  generationSignal = null
} = {}) {
  let loadedStart = initialStart;
  let visibleEnd = initialEnd;
  let extentEnd = initialEnd;
  let scrollTop = initialScrollTop;
  let now = 0;
  let earlierLoadAt = null;
  let trailingLoadAt = null;
  let generationIndicatorReads = 0;
  let scroller;

  const scheduleEarlierMessages = () => {
    if (loadedStart <= 0 || loadDelayMs === null || earlierLoadAt !== null) return;
    earlierLoadAt = now + loadDelayMs;
  };
  const advanceClock = (ms) => {
    now += ms;
    if (earlierLoadAt !== null && now >= earlierLoadAt) {
      loadedStart -= 1;
      earlierLoadAt = null;
    }
    if (trailingLoadAt !== null && now >= trailingLoadAt) {
      extentEnd = Math.min(messages.length, extentEnd + 1);
      if (!scrollerMovable) visibleEnd = extentEnd;
      trailingLoadAt = null;
    }
  };

  const nodes = messages.map(({ role, text }, index) => ({
    innerText: text,
    textContent: text,
    get isConnected() {
      return index >= loadedStart && index < visibleEnd;
    },
    get parentElement() {
      return scroller;
    },
    getAttribute(name) {
      if (name === 'data-message-author-role') return role;
      if (name === 'data-message-id') return providerIds ? `message-${index}` : null;
      if (name === 'data-testid') return providerOrdinals ? `conversation-turn-${index + 1}` : null;
      return null;
    },
    closest(selector) {
      if (selector === '[data-message-id]') return providerIds ? this : null;
      if (selector === '[data-testid^="conversation-turn-"]') return providerOrdinals ? this : null;
      return null;
    },
    getBoundingClientRect() {
      return { top: (index - loadedStart) * 80 };
    },
    scrollIntoView({ block } = {}) {
      if (block === 'start') {
        if (!loadOnMessageScroll || index !== visibleEnd - 1 || visibleEnd >= messages.length) return;
        if (trailingLoadDelayMs === null) visibleEnd += 1;
        else if (trailingLoadAt === null) trailingLoadAt = now + trailingLoadDelayMs;
        return;
      }
      scrollTop = 0;
      if (!loadOnMessageScroll || index !== loadedStart || loadedStart <= 0) return;
      if (loadDelayMs === null) loadedStart -= 1;
      else scheduleEarlierMessages();
    }
  }));
  const generationNode = {
    textContent: generationSignal === 'thinking' ? 'Thinking' : 'Stop generating',
    getAttribute(name) {
      return name === 'aria-label' ? this.textContent : null;
    },
    getBoundingClientRect() {
      return { top: 0, width: 24, height: 24 };
    }
  };
  const queryNodes = (selector) => {
    if (selector === '[data-message-author-role]') return nodes.slice(loadedStart, visibleEnd);
    if (generationSignal === 'stop' && String(selector).includes('stop-button')) return [generationNode];
    if (String(selector).includes('[role="status"]')) {
      generationIndicatorReads += 1;
      const thinkingActive = generationSignal === 'thinking' ||
        (generationSignal === 'thinking-before' && generationIndicatorReads === 1) ||
        (generationSignal === 'thinking-after' && generationIndicatorReads >= 2);
      if (thinkingActive) return [generationNode];
    }
    return [];
  };

  const documentElement = {
    clientHeight: 100,
    scrollHeight: 100,
    scrollTop: 0,
    parentElement: null,
    contains: () => true,
    querySelectorAll: queryNodes
  };
  scroller = {
    clientHeight: 100,
    get scrollHeight() {
      const height = trailingLoadDelayMs === null ? 300 : Math.max(300, extentEnd * 100);
      if (
        trailingLoadDelayMs !== null && extentEnd < messages.length && trailingLoadAt === null &&
        scrollTop >= height - this.clientHeight - 1
      ) {
        trailingLoadAt = now + trailingLoadDelayMs;
      }
      return height;
    },
    parentElement: documentElement,
    contains: () => true,
    querySelectorAll: queryNodes,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      if (!scrollerMovable) return;
      const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scrollTop = Math.max(0, Math.min(maximum, Number(value) || 0));
      if (scrollTop >= maximum - 1 && visibleEnd < extentEnd) visibleEnd = extentEnd;
      if (scrollTop === 0) scheduleEarlierMessages();
    }
  };
  const body = {
    clientHeight: 100,
    scrollHeight: 100,
    scrollTop: 0,
    parentElement: documentElement,
    contains: () => true,
    querySelectorAll: queryNodes
  };
  const document = {
    documentElement,
    scrollingElement: documentElement,
    body,
    querySelector: (selector) => selector === 'main' ? scroller : null,
    querySelectorAll: queryNodes
  };
  const window = {
    innerHeight: 100,
    scrollY: 0,
    scrollTo(_x, value) {
      this.scrollY = value;
    }
  };

  return {
    async navigate() {},
    async evaluate(js) {
      return await vm.runInNewContext(js, {
        document,
        window,
        getComputedStyle: (node) => ({ overflowY: node === scroller ? 'auto' : 'visible' }),
        performance: { now: () => now },
        setTimeout: (callback, ms) => {
          advanceClock(Number(ms) || 0);
          callback();
        }
      });
    },
    async getUrl() {
      return 'https://chatgpt.com/c/virtualized-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
  };
}

function conversationRouteInspectionPage({
  messageSelector = '[data-message-author-role]',
  turnSelector = '[data-testid^="conversation-turn-"]',
  served = true,
  visible = true,
  turnTestId = 'conversation-turn-12'
} = {}) {
  const queriedSelectors = [];
  const turn = {
    isConnected: true,
    getAttribute(name) {
      return name === 'data-testid' ? turnTestId : null;
    },
    getBoundingClientRect() {
      return visible ? { width: 640, height: 72 } : { width: 0, height: 0 };
    },
    closest() {
      return null;
    }
  };
  const message = {
    isConnected: true,
    getAttribute(name) {
      return name === 'data-message-author-role' ? 'assistant' : null;
    },
    getBoundingClientRect() {
      return visible ? { width: 600, height: 48 } : { width: 0, height: 0 };
    },
    closest(selector) {
      return selector === turnSelector ? turn : null;
    }
  };
  const document = {
    querySelectorAll(selector) {
      queriedSelectors.push(selector);
      return selector === messageSelector && served ? [message] : [];
    }
  };
  return {
    queriedSelectors,
    page: {
      async navigate() {},
      async evaluate(js) {
        return await vm.runInNewContext(js, {
          document,
          getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
        });
      },
      async getUrl() {
        return 'https://chatgpt.com/c/route-inspection-thread';
      },
      async sendKey() {},
      async insertText() {},
      async moveMouse() {},
      async mouseDown() {},
      async mouseUp() {},
      async setFileInputFiles() {}
    }
  };
}

function slidingConversationPage(messages, {
  windowSize = 4,
  rowHeight = 80,
  clientHeight = 240,
  initialStart = 4,
  anchorScroll = true,
  providerIds = true,
  providerIdForMessage = (_message, index) => `sliding-${index}`,
  providerOrdinals = true,
  providerOrdinalForMessage = (_message, index) => index + 1,
  turnOwnerForMessage = null,
  visibleIndicesForTop = null,
  scrollTopForRequest = null,
  textForMessage = (message) => message.text,
  lazyTextForMessage = false,
  rectangleForMessage = null,
  childNodesForMessage = null,
  computedStyleForNode = null,
  turnOwnerNodesForTop = null,
  onAnimationFrame = null,
  scrollTopAfterAnimationFrame = null,
  performanceNow = () => 0
} = {}) {
  let scrollTop = initialStart * rowHeight;
  let visibleStart = initialStart;
  let scroller;
  const visibleIndices = () => typeof visibleIndicesForTop === 'function'
    ? visibleIndicesForTop({ scrollTop, visibleStart, messages }).filter((index) => index >= 0 && index < messages.length)
    : Array.from({ length: Math.min(windowSize, messages.length - visibleStart) }, (_, offset) => visibleStart + offset);
  const visibleNodes = () => visibleIndices()
    .map((index, offset) => {
      const message = messages[index];
      const eagerText = lazyTextForMessage
        ? null
        : textForMessage(message, index, visibleStart);
      const readText = () => lazyTextForMessage
        ? textForMessage(message, index, visibleStart)
        : eagerText;
      return {
        get innerText() {
          return readText();
        },
        get textContent() {
          return readText();
        },
        nodeType: 1,
        tagName: 'ARTICLE',
        get childNodes() {
          return typeof childNodesForMessage === 'function'
            ? childNodesForMessage(message, index, visibleStart)
            : undefined;
        },
        get isConnected() {
          return visibleIndices().includes(index);
        },
        matches(selector) {
          return selector === '[data-message-author-role]';
        },
        querySelectorAll() {
          return [];
        },
        get parentElement() {
          return scroller;
        },
        getAttribute(name) {
          if (name === 'data-message-author-role') return message.role;
          if (name === 'data-message-id') return providerIds
            ? providerIdForMessage(message, index, visibleStart)
            : null;
          if (name === 'data-testid') {
            const ordinal = providerOrdinalForMessage(message, index, visibleStart);
            return providerOrdinals && ordinal !== null && ordinal !== undefined
              ? `conversation-turn-${ordinal}`
              : null;
          }
          return null;
        },
        closest(selector) {
          if (selector === '[data-message-id]') return providerIds ? this : null;
          if (selector === '[data-testid^="conversation-turn-"]') {
            if (!providerOrdinals) return null;
            return typeof turnOwnerForMessage === 'function'
              ? turnOwnerForMessage(message, index, visibleStart, { scrollTop, rowHeight, clientHeight }) || this
              : this;
          }
          return null;
        },
        getBoundingClientRect() {
          if (typeof rectangleForMessage === 'function') {
            return rectangleForMessage({ index, offset, scrollTop, visibleStart, rowHeight, clientHeight });
          }
          return { top: offset * rowHeight };
        },
        scrollIntoView({ block } = {}) {
          if (!anchorScroll) {
            if (index === 0) scrollTop = 0;
            return;
          }
          scroller.scrollTop = block === 'end'
            ? ((index + 1) * rowHeight) - clientHeight
            : index * rowHeight;
        }
      };
    });
  const queryVisibleNodes = (selector) => {
    if (selector === '[data-message-author-role]') return visibleNodes();
    if (
      selector === '[data-testid^="conversation-turn-"]' &&
      typeof turnOwnerNodesForTop === 'function'
    ) {
      const messageNodes = visibleNodes();
      return turnOwnerNodesForTop({
        scrollTop,
        visibleStart,
        messages,
        messageNodes,
        rowHeight,
        clientHeight
      });
    }
    return [];
  };
  const documentElement = {
    clientHeight,
    scrollHeight: messages.length * rowHeight,
    scrollTop: 0,
    parentElement: null,
    contains: () => true,
    querySelectorAll: queryVisibleNodes
  };
  scroller = {
    clientHeight,
    scrollHeight: messages.length * rowHeight,
    parentElement: documentElement,
    contains: () => true,
    querySelectorAll: queryVisibleNodes,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
      const requested = Math.max(0, Math.min(maximum, Number(value) || 0));
      const adjusted = typeof scrollTopForRequest === 'function'
        ? scrollTopForRequest({ requested, previous: scrollTop, maximum })
        : requested;
      scrollTop = Math.max(0, Math.min(maximum, Number(adjusted) || 0));
      visibleStart = Math.min(Math.max(0, messages.length - windowSize), Math.floor(scrollTop / rowHeight));
    }
  };
  const body = {
    clientHeight,
    scrollHeight: messages.length * rowHeight,
    scrollTop: 0,
    parentElement: documentElement,
    contains: () => true,
    querySelectorAll: queryVisibleNodes
  };
  const document = {
    documentElement,
    scrollingElement: documentElement,
    body,
    querySelector: (selector) => selector === 'main' ? scroller : null,
    querySelectorAll: queryVisibleNodes
  };
  const window = {
    innerHeight: clientHeight,
    scrollY: 0,
    scrollTo(_x, value) {
      scroller.scrollTop = value;
      this.scrollY = scroller.scrollTop;
    }
  };
  const getComputedStyleForTest = (node) => ({
    overflowY: node === scroller ? 'auto' : 'visible',
    ...(typeof computedStyleForNode === 'function' ? computedStyleForNode(node) : {})
  });
  window.getComputedStyle = getComputedStyleForTest;
  return {
    async navigate() {},
    async evaluate(js) {
      return await vm.runInNewContext(js, {
        document,
        window,
        getComputedStyle: getComputedStyleForTest,
        performance: { now: performanceNow },
        setTimeout: (callback) => callback(),
        requestAnimationFrame: typeof onAnimationFrame === 'function'
          ? (callback) => {
              onAnimationFrame({ scrollTop });
              if (typeof scrollTopAfterAnimationFrame === 'function') {
                const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const adjusted = scrollTopAfterAnimationFrame({ scrollTop, maximum });
                scrollTop = Math.max(0, Math.min(maximum, Number(adjusted) || 0));
                visibleStart = Math.min(
                  Math.max(0, messages.length - windowSize),
                  Math.floor(scrollTop / rowHeight)
                );
              }
              callback();
            }
          : undefined
      });
    },
    async getUrl() {
      return 'https://chatgpt.com/c/sliding-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {},
    async mouseUp() {},
    async setFileInputFiles() {}
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
      if (js.includes('already_generating')) return { ok: true, requestSubmit: true, host: 'chatgpt.com', promptLen: 7 };
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

test('chatgpt-controller: shared reply materializes a canonical private conversation', async () => {
  let currentUrl = 'https://chatgpt.com/share/shared-source';
  let waitForSendChecks = 0;
  const progress = [];
  const page = {
    async navigate(url) { currentUrl = url; },
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return { ...readyState(), url: currentUrl };
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 200, h: 40 } };
      if (js.includes('form.requestSubmit')) return true;
      if (js.includes('already_generating')) {
        currentUrl = 'https://chatgpt.com/c/materialized-copy';
        return { ok: true, requestSubmit: true, host: 'chatgpt.com', promptLen: 5 };
      }
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: false, sendDisabled: true, promptLen: 0 }
          : { stopVisible: false, sendDisabled: false, promptLen: 5 };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() { return currentUrl; },
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

  const result = await controller.send({
    text: 'reply',
    timeoutMs: 5_000,
    onProgress: (patch) => progress.push(patch)
  });
  assert.deepEqual(result, { ok: true, conversationUrl: 'https://chatgpt.com/c/materialized-copy' });
  assert.equal(progress.some((patch) => patch.phase === 'conversation_materialized'), true);
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

test('chatgpt-controller: send ignores pre-existing global stop controls when the composer can send', async () => {
  const events = [];
  let waitForSendChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes('preExistingStopVisible')) {
        return {
          ok: true,
          rect: { x: 320, y: 320, w: 30, h: 30 },
          host: 'chatgpt.com',
          promptLen: 8,
          stopCount: 1,
          preExistingStopVisible: true,
          button: { label: 'send prompt', testId: 'send-button' },
          candidateCount: 1
        };
      }
      if (js.includes('already_generating')) return { ok: false, error: 'already_generating' };
      if (js.includes('promptLen')) {
        waitForSendChecks += 1;
        return waitForSendChecks >= 2
          ? { stopVisible: true, stopCount: 1, sendDisabled: true, promptLen: 0 }
          : { stopVisible: true, stopCount: 1, sendDisabled: false, promptLen: 8 };
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
    async moveMouse() {
      events.push('moveMouse');
    },
    async mouseDown() {
      events.push('mouseDown');
    },
    async mouseUp() {
      events.push('mouseUp');
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

  const result = await controller.send({ text: 'agentify', timeoutMs: 5_000 });
  assert.deepEqual(result, { ok: true });
  assert.equal(events.includes('mouseDown'), true);
  assert.equal(waitForSendChecks, 2);
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

test('chatgpt-controller: query does not accept composer clearing as assistant progress', async () => {
  let waitForAssistantChecks = 0;
  let typed = false;
  const realNow = Date.now;
  let fakeNow = 1_500_000;
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
          return {
            count: 1,
            lastText: typed ? 'Existing assistant reply agentify' : 'Existing assistant reply',
            pageText: typed ? 'Existing assistant reply agentify' : 'Existing assistant reply'
          };
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
            count: 1,
            usedFallback: false,
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
      async insertText() {
        typed = true;
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

test('chatgpt-controller: query does not block completion on a pre-existing stop control', async () => {
  const progress = [];
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 2_500_000;
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
          return {
            ok: true,
            rect: { x: 320, y: 320, w: 30, h: 30 },
            host: 'chatgpt.com',
            promptLen: 8,
            stopCount: 1,
            preExistingStopVisible: true
          };
        }
        if (js.includes('return { count: nodes.length')) {
          return { count: 1, lastText: 'Previous answer', pageText: 'Previous answer' };
        }
        if (js.includes('promptLen')) {
          return { stopVisible: true, stopCount: 1, sendDisabled: false, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          return {
            stop: true,
            stopCount: 1,
            sendEnabled: false,
            sendFound: false,
            txt: 'Final answer with enough substance to be the response.',
            count: 2,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            imageCandidateCount: 0,
            pageText: 'Previous answer\\nFinal answer with enough substance to be the response.',
            currentUrl: 'https://chatgpt.com/g/g-p-test/c/preexisting-stop'
          };
        }
        if (js.includes('const codes = Array.from')) {
          return { codeBlocks: [] };
        }
        throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
      },
      async getUrl() {
        return 'https://chatgpt.com/g/g-p-test/c/preexisting-stop';
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

    assert.equal(result.text, 'Final answer with enough substance to be the response.');
    assert.equal(waitForAssistantChecks >= 2, true);
    assert.equal(
      progress.some((patch) =>
        patch?.responseDebug?.rawStop === true &&
        patch.responseDebug.stop === false &&
        patch.responseDebug.baselineStopCount === 1
      ),
      true
    );
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: query applies the requested mode intent before sending', async () => {
  const progress = [];
  const pointerEvents = [];
  const events = [];
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
      events.push(x > 300 ? 'mouseDown:send' : 'mouseDown:mode');
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
      if (patch?.phase) events.push(`progress:${patch.phase}`);
    }
  });

  assert.equal(result.text, 'Final answer');
  assert.equal(modeChecks >= 3, true);
  assert.equal(pointerEvents.filter((item) => item.startsWith('down:')).length, 4);
  assert.equal(progress.some((patch) => patch?.phase === 'activating_mode_intent' && patch?.modeIntent === 'extended-pro'), true);
  const provenancePatch = progress.find((patch) => patch?.phase === 'mode_intent_confirmed');
  assert.equal(provenancePatch?.modeIntent, 'extended-pro');
  assert.equal(provenancePatch?.modeIntentProvenance?.confirmed, true);
  assert.equal(provenancePatch?.modeIntentProvenance?.clicked, true);
  assert.equal(provenancePatch?.modeIntentProvenance?.stage, 'before_send');
  assert.equal(provenancePatch?.modeIntentProvenance?.attempts?.length, 2);
  assert.equal(
    events.indexOf('progress:mode_intent_confirmed') > -1 &&
      events.indexOf('progress:mode_intent_confirmed') < events.indexOf('progress:sending_prompt') &&
      events.indexOf('progress:mode_intent_confirmed') < events.indexOf('mouseDown:send'),
    true
  );
});

test('chatgpt-controller: query applies the requested model intent before sending', async () => {
  const progress = [];
  const pointerEvents = [];
  const events = [];
  let modelChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('model_controls_not_found') && js.includes('clicked_model_trigger') && js.includes('clicked_model_option')) {
        modelChecks += 1;
        if (modelChecks === 1) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_model_trigger',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: 'gpt-5.5-pro',
            label: 'Model selector GPT-5.5 Pro',
            rect: { x: 40, y: 32, w: 140, h: 32 },
            signature: '40:32:140:32:Model selector GPT-5.5 Pro',
            menuOpen: false
          };
        }
        if (modelChecks === 2) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_model_option',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: 'gpt-5.5-pro',
            label: 'GPT-5.4 Pro legacy',
            rect: { x: 44, y: 92, w: 180, h: 32 },
            menuOpen: true
          };
        }
        return {
          active: true,
          action: 'none',
          reason: 'model_already_active',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: 'gpt-5.4-pro',
          label: 'GPT-5.4 Pro'
        };
      }
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
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
      return 'https://chatgpt.com/g/g-p-test/c/model-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse(x, y) {
      pointerEvents.push(`move:${x},${y}`);
    },
    async mouseDown(x, y) {
      pointerEvents.push(`down:${x},${y}`);
      events.push(x > 300 ? 'mouseDown:send' : 'mouseDown:model');
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
      chatModeButton: '[data-testid="model-switcher-dropdown-button"], [data-testid="mode-trigger"]',
      chatModeMenu: '[role="menu"]',
      chatModeOption: '[role="menuitem"]',
      chatModeActive: '[aria-pressed="true"]'
    }
  });

  const result = await controller.query({
    prompt: 'agentify',
    timeoutMs: 20_000,
    modeIntent: 'extended-pro',
    modelIntent: 'gpt-5.4-pro',
    onProgress: async (patch) => {
      progress.push(patch);
      if (patch?.phase) events.push(`progress:${patch.phase}`);
    }
  });

  assert.equal(result.text, 'Final answer');
  assert.equal(modelChecks >= 3, true);
  assert.equal(pointerEvents.filter((item) => item.startsWith('down:')).length >= 3, true);
  const provenancePatch = progress.find((patch) => patch?.phase === 'model_intent_confirmed');
  assert.equal(provenancePatch?.modelIntent, 'gpt-5.4-pro');
  assert.equal(provenancePatch?.modelIntentProvenance?.confirmed, true);
  assert.equal(provenancePatch?.modelIntentProvenance?.clicked, true);
  assert.equal(provenancePatch?.modelIntentProvenance?.stage, 'before_prompt');
  assert.equal(
    events.indexOf('progress:model_intent_confirmed') > -1 &&
      events.indexOf('progress:model_intent_confirmed') < events.indexOf('progress:sending_prompt') &&
      events.indexOf('progress:model_intent_confirmed') < events.indexOf('mouseDown:send'),
    true
  );
});

test('chatgpt-controller: model intent ignores pure Extended Pro mode chips', async () => {
  const realNow = Date.now;
  let fakeNow = 6_250_000;
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };

  let modelChecks = 0;
  let pointerClicks = 0;
  let sendAttempted = false;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        sendAttempted = true;
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('model_controls_not_found') && js.includes('clicked_model_trigger') && js.includes('clicked_model_option')) {
        modelChecks += 1;
        return {
          active: false,
          action: 'none',
          reason: 'model_controls_not_found',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: null,
          menuOpen: false,
          optionHints: ['extended pro', 'extended pro, click to remove'],
          composerHints: ['extended pro', 'extended pro, click to remove']
        };
      }
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        return {
          active: true,
          action: 'none',
          reason: 'mode_already_active',
          targetIntent: 'extended-pro',
          activeIntent: 'extended-pro',
          label: 'Extended Pro'
        };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/g/g-p-test/c/project-model-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown() {
      pointerClicks += 1;
    },
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
      chatModeButton: '[data-testid="model-switcher-dropdown-button"], [data-testid="mode-trigger"]',
      chatModeMenu: '[role="menu"]',
      chatModeOption: '[role="menuitem"]',
      chatModeActive: '[aria-pressed="true"]'
    }
  });

  try {
    await assert.rejects(
      controller.query({
        prompt: 'agentify',
        timeoutMs: 20_000,
        modeIntent: 'extended-pro',
        modelIntent: 'gpt-5.4-pro'
      }),
      (error) => {
        assert.equal(error?.message, 'model_intent_activation_failed');
        assert.equal(error?.data?.reason, 'model_controls_not_found');
        assert.deepEqual(error?.data?.attempts || [], []);
        return true;
      }
    );
  } finally {
    Date.now = realNow;
  }

  assert.equal(modelChecks >= 1, true);
  assert.equal(pointerClicks, 0);
  assert.equal(sendAttempted, false);
});

test('chatgpt-controller: model intent can traverse Configure and Legacy models before selecting 5.4', async () => {
  const progress = [];
  const events = [];
  let modelChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('clicked_model_configure') && js.includes('clicked_legacy_models')) {
        modelChecks += 1;
        if (modelChecks === 1) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_model_trigger',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'ChatGPT model-switcher-dropdown-button',
            rect: { x: 56, y: 30, w: 132, h: 36 },
            signature: '56:30:132:36:ChatGPT model-switcher-dropdown-button',
            menuOpen: false
          };
        }
        if (modelChecks === 2) {
          return {
            active: false,
            action: 'pointer_configure',
            reason: 'clicked_model_configure',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'Configure...',
            rect: { x: 60, y: 510, w: 150, h: 40 },
            menuOpen: true,
            menuText: 'Latest Instant For everyday chats Thinking For complex questions Pro Research-grade intelligence Configure...',
            optionHints: ['latest', 'instant', 'thinking', 'pro', 'configure']
          };
        }
        if (modelChecks === 3) {
          return {
            active: false,
            action: 'pointer_legacy_models',
            reason: 'clicked_legacy_models',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'Legacy models',
            rect: { x: 64, y: 380, w: 210, h: 38 },
            menuOpen: true,
            menuText: 'Models Auto Latest Legacy models',
            optionHints: ['legacy models']
          };
        }
        if (modelChecks === 4) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_model_option',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'GPT-5.4 Pro legacy',
            rect: { x: 64, y: 430, w: 220, h: 36 },
            menuOpen: true
          };
        }
        return {
          active: true,
          action: 'none',
          reason: 'model_latched_after_click',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: 'gpt-5.4-pro',
          label: 'GPT-5.4 Pro'
        };
      }
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
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
      return 'https://chatgpt.com/g/g-p-test/c/configure-legacy-thread';
    },
    async sendKey(key) {
      events.push(`key:${key}`);
    },
    async insertText() {},
    async moveMouse() {},
    async mouseDown(x) {
      events.push(x > 300 ? 'mouseDown:send' : 'mouseDown:model');
    },
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
      chatModeButton: '[data-testid="model-switcher-dropdown-button"]',
      chatModeMenu: '[role="menu"], [role="dialog"]',
      chatModeOption: '[role="menuitem"], button'
    }
  });

  const result = await controller.query({
    prompt: 'agentify',
    timeoutMs: 20_000,
    modeIntent: 'extended-pro',
    modelIntent: 'gpt-5.4-pro',
    onProgress: async (patch) => progress.push(patch)
  });

  assert.equal(result.text, 'Final answer');
  assert.equal(modelChecks >= 5, true);
  assert.equal(events.filter((item) => item === 'mouseDown:model').length >= 4, true);
  const provenancePatch = progress.find((patch) => patch?.phase === 'model_intent_confirmed');
  assert.equal(provenancePatch?.modelIntent, 'gpt-5.4-pro');
  assert.equal(provenancePatch?.modelIntentProvenance?.confirmed, true);
  assert.deepEqual(
    provenancePatch?.modelIntentProvenance?.attempts?.map((item) => item.action).slice(1, 3),
    ['pointer_configure', 'pointer_legacy_models']
  );
});

test('chatgpt-controller: model intent can select 5.4 from the Configure model dropdown', async () => {
  const progress = [];
  const pointerEvents = [];
  let modelChecks = 0;

  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('pointer_model_version_dropdown')) {
        modelChecks += 1;
        if (modelChecks === 1) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_model_trigger',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'ChatGPT model-switcher-dropdown-button',
            rect: { x: 56, y: 30, w: 132, h: 36 },
            signature: '56:30:132:36:ChatGPT model-switcher-dropdown-button',
            menuOpen: false
          };
        }
        if (modelChecks === 2) {
          return {
            active: false,
            action: 'pointer_configure',
            reason: 'clicked_model_configure',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'Configure...',
            rect: { x: 60, y: 510, w: 150, h: 40 },
            menuOpen: true,
            menuText: 'Latest Instant For everyday chats Thinking For complex questions Pro Research-grade intelligence Configure...',
            optionHints: ['latest', 'instant', 'thinking', 'pro', 'configure']
          };
        }
        if (modelChecks === 3) {
          return {
            active: false,
            action: 'pointer_model_version_dropdown',
            reason: 'clicked_model_version_dropdown',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'Latest',
            rect: { x: 744, y: 176, w: 112, h: 40 },
            menuOpen: true,
            menuText: 'Intelligence Model Latest Instant 5.3 For everyday chats Thinking 5.5 For complex questions Pro 5.5 Research-grade intelligence',
            optionHints: ['latest', 'instant 5.3', 'thinking 5.5', 'pro 5.5']
          };
        }
        if (modelChecks === 4) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_model_option',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: '5.4',
            rect: { x: 750, y: 340, w: 220, h: 36 },
            menuOpen: true
          };
        }
        return {
          active: true,
          action: 'none',
          reason: 'model_option_latched_after_click',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: 'gpt-5.4-pro',
          label: '5.4'
        };
      }
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
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
      return 'https://chatgpt.com/g/g-p-test/c/configure-dropdown-thread';
    },
    async sendKey() {},
    async insertText() {},
    async moveMouse() {},
    async mouseDown(x, y) {
      pointerEvents.push(`mouseDown:${Math.round(x)}:${Math.round(y)}`);
    },
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
      chatModeButton: '[data-testid="model-switcher-dropdown-button"]',
      chatModeMenu: '[role="menu"], [role="dialog"]',
      chatModeOption: '[role="menuitem"], button'
    }
  });

  const result = await controller.query({
    prompt: 'agentify',
    timeoutMs: 20_000,
    modeIntent: 'extended-pro',
    modelIntent: 'gpt-5.4-pro',
    onProgress: async (patch) => progress.push(patch)
  });

  assert.equal(result.text, 'Final answer');
  assert.equal(modelChecks >= 5, true);
  assert.equal(pointerEvents.length >= 4, true);
  const provenancePatch = progress.find((patch) => patch?.phase === 'model_intent_confirmed');
  assert.equal(provenancePatch?.modelIntent, 'gpt-5.4-pro');
  assert.equal(provenancePatch?.modelIntentProvenance?.confirmed, true);
  assert.deepEqual(
    provenancePatch?.modelIntentProvenance?.attempts?.map((item) => item.action).slice(1, 4),
    ['pointer_configure', 'pointer_model_version_dropdown', 'pointer_option']
  );
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
          label: 'Medium'
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
          pageText: 'Done\nMedium\nChatGPT can make mistakes. Check important info.'
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
  assert.equal(result.meta?.modeUsed, 'thinking');
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

test('chatgpt-controller: query fails closed when actual response footer reports Instant after Extended Pro confirmation', async () => {
  const realNow = Date.now;
  let fakeNow = 7_500_000;
  Date.now = () => {
    fakeNow += 1_000;
    return fakeNow;
  };

  let modeChecks = 0;
  let sendAttempted = false;
  const instantPageText = 'agentify\nInstant\nChatGPT can make mistakes. Check important info.';
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        modeChecks += 1;
        return {
          active: true,
          action: 'none',
          reason: 'mode_already_active',
          targetIntent: 'extended-pro',
          activeIntent: 'extended-pro',
          label: 'Extended Pro'
        };
      }
      if (js.includes("already_generating")) {
        sendAttempted = true;
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
          txt: instantPageText,
          count: 1,
          usedFallback: false,
          hasError: false,
          hasContinue: false,
          hasRegenerate: false,
          isThinking: false,
          pageText: instantPageText,
          currentUrl: 'https://chatgpt.com/c/instant-mode-run'
        };
      }
      if (js.includes('const codes = Array.from')) {
        return { codeBlocks: [] };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/instant-mode-run';
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
        assert.equal(error?.data?.reason, 'mode_intent_downgrade_detected');
        assert.equal(error?.data?.targetIntent, 'extended-pro');
        assert.equal(error?.data?.state?.activeIntent, 'instant');
        return true;
      }
    );
  } finally {
    Date.now = realNow;
  }

  assert.equal(modeChecks >= 1, true);
  assert.equal(sendAttempted, true);
});

test('chatgpt-controller: query fails closed when model intent cannot be confirmed', async () => {
  const realNow = Date.now;
  let fakeNow = 6_500_000;
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };

  let sendAttempted = false;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        sendAttempted = true;
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('model_controls_not_found') && js.includes('clicked_model_trigger') && js.includes('clicked_model_option')) {
        return {
          active: false,
          action: 'none',
          reason: 'model_controls_not_found',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: 'gpt-5.5-pro',
          menuOpen: false,
          composerHints: ['gpt-5.5 pro']
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
      controller.query({ prompt: 'agentify', timeoutMs: 20_000, modelIntent: 'gpt-5.4-pro' }),
      (error) => {
        assert.equal(error?.message, 'model_intent_activation_failed');
        assert.equal(error?.data?.reason, 'model_controls_not_found');
        assert.equal(error?.data?.targetIntent, 'gpt-5.4-pro');
        return true;
      }
    );
    assert.equal(sendAttempted, false);
  } finally {
    Date.now = realNow;
  }
});

test('chatgpt-controller: model intent fails fast when no generation or Configure control is actionable', async () => {
  let modelChecks = 0;
  let modelClicks = 0;
  let sendAttempted = false;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        sendAttempted = true;
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('model_generation_picker_unavailable') && js.includes('isModeOnlyModelPickerState')) {
        modelChecks += 1;
        if (modelChecks === 1) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_model_trigger',
            targetIntent: 'gpt-5.4-pro',
            activeIntent: null,
            label: 'ChatGPT model-switcher-dropdown-button',
            rect: { x: 56, y: 30, w: 132, h: 36 },
            signature: '56:30:132:36:ChatGPT model-switcher-dropdown-button',
            menuOpen: false
          };
        }
        return {
          active: false,
          action: 'unavailable',
          reason: 'model_generation_picker_unavailable',
          targetIntent: 'gpt-5.4-pro',
          activeIntent: null,
          menuOpen: true,
          menuText: 'Latest Instant For everyday chats Thinking For complex questions Pro Research-grade intelligence',
          optionHints: ['latest', 'instant for everyday chats', 'thinking for complex questions', 'pro research-grade intelligence']
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
    async mouseDown() {
      modelClicks += 1;
    },
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
      chatModeButton: '[data-testid="model-switcher-dropdown-button"]',
      chatModeMenu: '[role="menu"]',
      chatModeOption: '[role="menuitem"]'
    }
  });

  await assert.rejects(
    controller.query({ prompt: 'agentify', timeoutMs: 20_000, modelIntent: 'gpt-5.4-pro' }),
    (error) => {
      assert.equal(error?.message, 'model_intent_activation_failed');
      assert.equal(error?.data?.reason, 'model_generation_picker_unavailable');
      assert.equal(error?.data?.targetIntent, 'gpt-5.4-pro');
      assert.match(error?.data?.state?.menuText || '', /Latest Instant/);
      return true;
    }
  );
  assert.equal(modelChecks, 2);
  assert.equal(modelClicks, 1);
  assert.equal(sendAttempted, false);
});

test('chatgpt-controller: query rejects unrelated Pro-labeled UI as mode confirmation', async () => {
  const realNow = Date.now;
  let fakeNow = 7_000_000;
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };

  let sendAttempted = false;
  const page = {
    async navigate() {},
    async evaluate(js) {
      if (js.includes('const hasTurnstile')) return readyState();
      if (js.includes('missing_prompt_textarea')) return { ok: true, rect: { x: 10, y: 10, w: 240, h: 48 } };
      if (js.includes("already_generating")) {
        sendAttempted = true;
        return { ok: true, rect: { x: 320, y: 320, w: 30, h: 30 }, host: 'chatgpt.com', promptLen: 8 };
      }
      if (js.includes('mode_controls_not_found') && js.includes('clicked_mode_trigger') && js.includes('clicked_mode_option')) {
        return {
          active: true,
          action: 'none',
          reason: 'mode_latched_after_click',
          targetIntent: 'extended-pro',
          activeIntent: 'extended-pro',
          label: 'pro feedback'
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
        assert.equal(error?.data?.reason, 'mode_activation_untrusted');
        return true;
      }
    );
    assert.equal(sendAttempted, false);
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

test('chatgpt-controller: image-generation queries do not treat loader canvases as final images', async () => {
  let waitForAssistantChecks = 0;
  const realNow = Date.now;
  let fakeNow = 5_000_000;
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
          return { stopVisible: false, stopCount: 0, sendDisabled: true, promptLen: 0 };
        }
        if (js.includes('fallbackMainText')) {
          waitForAssistantChecks += 1;
          if (waitForAssistantChecks <= 5) {
            return {
              stop: false,
              sendEnabled: true,
              sendFound: true,
              txt: 'Generating a more detailed image — hang tight.\\n\\nThinking',
              count: 1,
              usedFallback: false,
              hasError: false,
              hasContinue: false,
              hasRegenerate: false,
              isThinking: false,
              imageCandidateCount: 1,
              pageText: 'Generating a more detailed image — hang tight.\\n\\nThinking',
              currentUrl: 'https://chatgpt.com/g/g-p-test/c/image-thread'
            };
          }
          return {
            stop: false,
            sendEnabled: true,
            sendFound: true,
            txt: 'Stopped thinking\\nEdit',
            count: 1,
            usedFallback: false,
            hasError: false,
            hasContinue: false,
            hasRegenerate: false,
            isThinking: false,
            imageCandidateCount: 1,
            pageText: 'Stopped thinking\\nEdit',
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
    assert.equal(result.text, 'Stopped thinking\\nEdit');
    assert.equal(waitForAssistantChecks >= 6, true);
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
  const pointerEvents = [];
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
        if (js.includes('upload_menu_item_visible')) return { action: 'upload_menu_item_ready', reason: 'upload_menu_item_visible', label: 'add files' };
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
      async moveMouse(x, y) {
        pointerEvents.push(`move:${x},${y}`);
      },
      async mouseDown(x, y) {
        pointerEvents.push(`down:${x},${y}`);
      },
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
    assert.equal(progress.some((patch) => patch?.attachmentDebug?.stage === 'open_picker' && patch?.attachmentDebug?.source === 'upload_menu_item_ready'), true);
    assert.equal(progress.some((patch) => patch?.attachmentDebug?.stage === 'inject_files'), true);
    assert.equal(progress.some((patch) => patch?.attachmentDebug?.stage === 'wait_upload' && patch?.attachmentDebug?.pendingText === 'Upload 0%'), true);
    assert.equal(pointerEvents.some((event) => event.startsWith('down:')), false);
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('chatgpt-controller: query fails fast on direct Add files controls that can open native picker', async () => {
  const realNow = Date.now;
  let fakeNow = 5_000_000;
  Date.now = () => {
    fakeNow += 5_000;
    return fakeNow;
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-attach-direct-add-'));
  const attachment = path.join(dir, 'PROGRESS.md');
  await fs.writeFile(attachment, '# progress\n', 'utf8');
  let clicked = false;
  let fallbackCalled = false;

  try {
    const page = {
      async navigate() {},
      async evaluate(js) {
        if (js.includes('const hasTurnstile')) return readyState();
        if (js.includes('const fileData =')) return { ok: false, error: 'no_file_input' };
        if (js.includes('upload_menu_item_visible')) {
          return {
            action: 'none',
            reason: 'upload_file_input_not_available',
            label: 'add files',
            menuOpen: false
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
      async mouseDown() {
        clicked = true;
      },
      async mouseUp() {},
      async setFileInputFiles() {
        fallbackCalled = true;
        throw new Error('missing_file_input');
      }
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
      /attachment_input_unavailable/
    );
    assert.equal(clicked, false);
    assert.equal(fallbackCalled, false);
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
      if (js.includes('upload_menu_item_visible')) return { action: 'upload_menu_item_ready', reason: 'upload_menu_item_visible', label: 'add files' };
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
        if (js.includes('upload_menu_item_visible')) return { action: 'upload_menu_item_ready', reason: 'upload_menu_item_visible', label: 'add files' };
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
        if (js.includes('upload_menu_item_visible')) return { action: 'upload_menu_item_ready', reason: 'upload_menu_item_visible', label: 'add files' };
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

test('chatgpt-controller: image downloads deduplicate normalized source URLs and retain alt metadata', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-image-dedupe-'));
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

  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  controller.getLastAssistantImages = async () => ([
    {
      src: 'https://CHATGPT.com:443/backend-api/estuary/content?id=file_123#thumbnail',
      alt: '',
      dataUrl
    },
    {
      src: 'https://chatgpt.com/backend-api/estuary/content?id=file_123',
      alt: 'Generated landscape',
      dataUrl
    }
  ]);

  const saved = await controller.downloadLastAssistantImages({ maxImages: 6, outDir });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'https://chatgpt.com/backend-api/estuary/content?id=file_123');
  assert.equal(saved[0].alt, 'Generated landscape');
  assert.equal((await fs.readdir(outDir)).length, 1);
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

test('chatgpt-controller: readConversationText returns the complete virtualized transcript', async () => {
  const evaluations = [];
  const page = {
    async navigate() {},
    async evaluate(js) {
      evaluations.push(js);
      const rawTurns = [
        { ordinal: 0, providerMessageId: 'm-1', role: 'user', text: 'First turn' },
        { ordinal: 1, providerMessageId: 'm-2', role: 'assistant', text: 'First reply' },
        { ordinal: 2, providerMessageId: 'm-3', role: 'user', text: 'Final turn' }
      ];
      return {
        status: 'complete',
        rawTurns,
        evidence: {
          topBoundary: true,
          bottomBoundary: true,
          orderedWindowStitching: true,
          messageCount: 3,
          providerIdCount: 3,
          byteCount: rawTurns.reduce((total, turn) =>
            total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0),
          windowCount: 3,
          scrollPasses: 4
        }
      };
    },
    async getUrl() {
      return 'https://chatgpt.com/c/virtualized-thread';
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

  const result = await controller.readConversationText({ maxChars: 500 });
  assert.deepEqual(result, {
    text: 'User\nFirst turn\n\nAssistant\nFirst reply\n\nUser\nFinal turn',
    complete: true,
    truncated: false,
    reason: null,
    messageCount: 3,
    scrollPasses: 4
  });
  assert.equal(evaluations.length, 1);
  assert.match(evaluations[0], /data-message-author-role/);
  assert.match(evaluations[0], /scrollTop/);
  assert.match(evaluations[0], /const cap = 6096/);
});

test('chatgpt-controller: legacy transcript projection reads DOM windows while library capture stays canonical-only', async (t) => {
  const routes = [
    ['share', 'https://chatgpt.com/share/shared-thread'],
    ['custom GPT', 'https://chatgpt.com/g/g-custom-assistant']
  ];
  for (const [name, route] of routes) {
    await t.test(name, async () => {
      let evaluations = 0;
      let routeReads = 0;
      const rawTurns = [
        { ordinal: 0, providerMessageId: 'legacy-1', role: 'user', text: 'Visible prompt' },
        { ordinal: 1, providerMessageId: 'legacy-2', role: 'assistant', text: 'Visible reply' }
      ];
      const page = {
        async evaluate(js) {
          evaluations += 1;
          assert.match(js, /data-message-author-role/);
          return {
            status: 'complete',
            rawTurns,
            evidence: {
              topBoundary: true,
              bottomBoundary: true,
              orderedWindowStitching: true,
              messageCount: rawTurns.length,
              providerIdCount: rawTurns.length,
              byteCount: rawTurns.reduce((total, turn) =>
                total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0),
              windowCount: 1,
              scrollPasses: 0
            }
          };
        },
        async getUrl() {
          routeReads += 1;
          return route;
        }
      };
      const controller = new ChatGPTController({ page, selectors: {} });

      const result = await controller.readConversationText({ maxChars: 500 });

      assert.deepEqual(result, {
        text: 'User\nVisible prompt\n\nAssistant\nVisible reply',
        complete: true,
        truncated: false,
        reason: null,
        messageCount: 2,
        scrollPasses: 0
      });
      assert.equal(evaluations, 1);
      assert.equal(routeReads, 0);

      const libraryCapture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

      assert.equal(libraryCapture.status, 'partial');
      assert.equal(libraryCapture.reason, 'compatibility_drift');
      assert.equal(libraryCapture.conversationUrl, null);
      assert.equal(evaluations, 1);
      assert.equal(routeReads, 2);
    });
  }
});

test('chatgpt-controller: forced chat entry navigation reloads an already-exact route', async () => {
  const navigations = [];
  let documentEpoch = 100;
  let replacementReads = 0;
  const page = {
    async navigate(url) {
      navigations.push(url);
    },
    async evaluate(js) {
      if (js.includes('timeOrigin')) {
        replacementReads += 1;
        if (navigations.length && replacementReads >= 3) documentEpoch = 200;
        return documentEpoch;
      }
      if (js.includes('const hasTurnstile')) {
        assert.equal(documentEpoch, 200);
        return { ...readyState(), url: 'https://chatgpt.com/c/route-inspection-thread' };
      }
      throw new Error(`unexpected_eval:${js.slice(0, 80)}`);
    },
    async getUrl() {
      return 'https://chatgpt.com/c/route-inspection-thread';
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
      sendButton: 'button[data-testid="send-button"]'
    }
  });

  await controller.prepareChatEntry({
    chatUrl: 'https://chatgpt.com/c/route-inspection-thread',
    timeoutMs: 5_000,
    forceNavigation: true
  });

  assert.deepEqual(navigations, ['https://chatgpt.com/c/route-inspection-thread']);
  assert.ok(replacementReads >= 3);
});

test('chatgpt-controller: ordinary chat entry keeps a full readiness window after navigation', async () => {
  const readinessTimeouts = [];
  const page = {
    async navigate() {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    async getUrl() {
      return 'https://chatgpt.com/';
    }
  };
  const controller = new ChatGPTController({ page, selectors: {} });
  controller.ensureReady = async ({ timeoutMs }) => {
    readinessTimeouts.push(timeoutMs);
  };

  await controller.prepareChatEntry({
    chatUrl: 'https://chatgpt.com/c/readiness-budget-thread',
    timeoutMs: 25
  });

  assert.deepEqual(readinessTimeouts, [25]);
});

test('chatgpt-controller: served route inspection requires a visible mapped message and positive turn ordinal', async () => {
  const messageSelector = '[data-route-message="mapped"]';
  const turnSelector = '[data-route-turn="mapped"]';
  const fixture = conversationRouteInspectionPage({ messageSelector, turnSelector });
  const controller = new ChatGPTController({
    page: fixture.page,
    selectors: {},
    uiContract: {
      kind: 'chatgpt',
      profile: {
        exemptions: [
          { dependency: 'transcript-message', selector: messageSelector },
          { dependency: 'transcript-turn-ordinal', selector: turnSelector }
        ]
      }
    }
  });

  const result = await controller.inspectConversationRoute();

  assert.deepEqual(result, { status: 'served', visibleTurnCount: 1 });
  assert.deepEqual(fixture.queriedSelectors, [messageSelector]);
  assert.deepEqual(Object.keys(result).sort(), ['status', 'visibleTurnCount']);
});

test('chatgpt-controller: a generic-ready route without mapped served-turn evidence is unavailable', async () => {
  const fixture = conversationRouteInspectionPage({ served: false });
  const controller = new ChatGPTController({ page: fixture.page, selectors: {} });

  assert.deepEqual(await controller.inspectConversationRoute(), {
    status: 'unavailable',
    reason: 'not-found'
  });
});

test('chatgpt-controller: hidden and malformed provider turns cannot serve route verification', async (t) => {
  for (const [name, options] of [
    ['hidden', { visible: false }],
    ['zero ordinal', { turnTestId: 'conversation-turn-0' }],
    ['malformed ordinal', { turnTestId: 'conversation-turn-private' }]
  ]) {
    await t.test(name, async () => {
      const fixture = conversationRouteInspectionPage(options);
      const controller = new ChatGPTController({ page: fixture.page, selectors: {} });
      assert.deepEqual(await controller.inspectConversationRoute(), {
        status: 'unavailable',
        reason: 'not-found'
      });
    });
  }
});

test('chatgpt-controller: production route inspection fails closed without either map-owned dependency', async (t) => {
  for (const omittedDependency of ['transcript-message', 'transcript-turn-ordinal']) {
    await t.test(omittedDependency, async () => {
      let evaluations = 0;
      const fixture = conversationRouteInspectionPage();
      const page = {
        ...fixture.page,
        async evaluate(js) {
          evaluations += 1;
          return await fixture.page.evaluate(js);
        }
      };
      const exemptions = [
        { dependency: 'transcript-message', selector: '[data-route-message]' },
        { dependency: 'transcript-turn-ordinal', selector: '[data-route-turn]' }
      ].filter(({ dependency }) => dependency !== omittedDependency);
      const controller = new ChatGPTController({
        page,
        selectors: {},
        uiContract: { kind: 'chatgpt', profile: { exemptions } }
      });

      assert.deepEqual(await controller.inspectConversationRoute(), {
        status: 'failed',
        reason: 'compatibility-drift'
      });
      assert.equal(evaluations, 0);
    });
  }
});

test('chatgpt-controller: captureConversation stitches a long virtualized thread with repeated text by provider id', async () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index === 20 || index === 22 ? 'Repeated identical turn' : `Turn ${index}`
  }));
  const page = virtualizedConversationPage(messages, { initialStart: 20 });
  const controller = new ChatGPTController({ page, selectors: {} });

  const captures = [];
  for (let index = 0; index < 3; index += 1) {
    captures.push(await controller.captureConversation({ maxCaptureBytes: 100_000 }));
  }
  const hashes = captures.map((capture) => normalizeLiveCapture(capture).contentHash);

  assert.deepEqual(captures.map(({ status }) => status), ['complete', 'complete', 'complete']);
  assert.equal(captures[0].rawTurns.length, 120);
  assert.deepEqual(Object.keys(captures[0].rawTurns[0]).sort(),
    ['ordinal', 'providerMessageId', 'role', 'text']);
  assert.equal(Object.hasOwn(captures[0].rawTurns[0], 'providerTurnIndex'), false);
  assert.equal(captures[0].rawTurns[20].text, captures[0].rawTurns[22].text);
  assert.notEqual(captures[0].rawTurns[20].providerMessageId, captures[0].rawTurns[22].providerMessageId);
  assert.equal(new Set(hashes).size, 1);
});

test('chatgpt-controller: captureConversation top-anchors a tall virtualized thread before its bounded walk', async () => {
  const messages = Array.from({ length: 128 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Tall virtualized turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 4_344,
    clientHeight: 900,
    initialStart: messages.length - 1
  });
  const geometry = await page.evaluate(`(() => {
    const scroller = document.querySelector('main');
    const initialScrollTop = scroller.scrollTop;
    scroller.scrollTop = 0;
    const first = document.querySelectorAll('[data-message-author-role]')[0];
    const firstTestId = first?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || '';
    const match = /^conversation-turn-(\\d+)$/.exec(firstTestId);
    const firstProviderTurnIndex = match ? Number(match[1]) : null;
    scroller.scrollTop = initialScrollTop;
    return {
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      initialScrollTop,
      firstProviderTurnIndex
    };
  })()`);
  assert.equal(geometry.scrollHeight, 556_032);
  assert.equal(geometry.clientHeight, 900);
  assert.equal(geometry.initialScrollTop, 551_688);
  assert.equal(geometry.firstProviderTurnIndex, 1);

  const controller = new ChatGPTController({ page, selectors: {} });
  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.rawTurns.length, messages.length);
});

test('chatgpt-controller: captureConversation can traverse more than 1200 bounded tall-turn windows', async () => {
  const messages = Array.from({ length: 720 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Single-window tall turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight: 800,
    clientHeight: 600,
    initialStart: messages.length - 1
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 250_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.equal(capture.rawTurns.length, messages.length);
  assert.ok(capture.evidence.scrollPasses > 1_200);
  assert.ok(capture.evidence.scrollPasses <= 1_610);
});

test('chatgpt-controller: downward capture uses the retained provider-turn frontier across tall owner chrome', async () => {
  const rowHeight = 50_000;
  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Tall provider owner turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight,
    clientHeight: 900,
    initialStart: messages.length - 1,
    rectangleForMessage: ({ index, scrollTop }) => {
      const top = (index * rowHeight) - scrollTop;
      return { top, bottom: top + 100, width: 640, height: 100 };
    },
    turnOwnerForMessage: (_message, index, _visibleStart, { scrollTop }) => ({
      getAttribute(name) {
        return name === 'data-testid' ? `conversation-turn-${index + 1}` : null;
      },
      getBoundingClientRect() {
        const top = (index * rowHeight) - scrollTop;
        return { top, bottom: top + rowHeight, width: 640, height: rowHeight };
      }
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 250_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.equal(capture.rawTurns.length, messages.length);
  assert.ok(capture.evidence.scrollPasses < 40, `unexpected scroll passes: ${capture.evidence.scrollPasses}`);
});

test('chatgpt-controller: downward capture scans an overshot provider ordinal before publication', async () => {
  const rowHeight = 1_000;
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Overshoot recovery turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight,
    clientHeight: 600,
    initialStart: messages.length - 1,
    rectangleForMessage: ({ index, scrollTop }) => {
      const top = (index * rowHeight) - scrollTop;
      return { top, bottom: top + 100, width: 640, height: 100 };
    },
    turnOwnerForMessage: (_message, index, _visibleStart, { scrollTop }) => ({
      getAttribute(name) {
        return name === 'data-testid' ? `conversation-turn-${index + 1}` : null;
      },
      getBoundingClientRect() {
        const top = (index * rowHeight) - scrollTop;
        const height = index === 1 ? rowHeight * 2 : rowHeight;
        return { top, bottom: top + height, width: 640, height };
      }
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(capture.status, 'complete');
});

test('chatgpt-controller: overshoot recovery anchors an offscreen retained frontier node', async () => {
  const rowHeight = 1_000;
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Retained frontier recovery turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight,
    clientHeight: 600,
    initialStart: messages.length - 1,
    visibleIndicesForTop: ({ scrollTop }) => {
      const start = Math.min(messages.length - 1, Math.floor(scrollTop / rowHeight));
      return start >= 3 ? [1, start] : [start];
    },
    rectangleForMessage: ({ index, scrollTop }) => {
      const top = (index * rowHeight) - scrollTop;
      return { top, bottom: top + 100, width: 640, height: 100 };
    },
    turnOwnerForMessage: (_message, index, _visibleStart, { scrollTop }) => ({
      getAttribute(name) {
        return name === 'data-testid' ? `conversation-turn-${index + 1}` : null;
      },
      getBoundingClientRect() {
        const top = (index * rowHeight) - scrollTop;
        const height = index === 0 ? rowHeight * 3 : rowHeight;
        return { top, bottom: top + height, width: 640, height };
      }
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
});

test('chatgpt-controller: captureConversation advances a contiguous frontier past a retained sparse final turn', async () => {
  const rowHeight = 1_376;
  const messages = Array.from({ length: 407 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Sparse-tail turn ${index}`
  }));
  const finalIndex = messages.length - 1;
  let observedWindows = 0;
  let windowsWithoutFinal = 0;
  let lastObservedScrollTop = null;
  let previousLocalStart = null;
  let previousLocalFrontier = null;
  let advancingSeams = 0;
  let seamsWithoutVisibleFrontier = 0;
  const page = slidingConversationPage(messages, {
    windowSize: 8,
    rowHeight,
    clientHeight: 900,
    initialStart: finalIndex,
    visibleIndicesForTop: ({ scrollTop }) => {
      const localStart = Math.min(finalIndex, Math.floor(scrollTop / rowHeight));
      const cluster = Array.from(
        { length: Math.min(8, messages.length - localStart) },
        (_, offset) => localStart + offset
      );
      const indices = [...new Set([...cluster, finalIndex])].sort((left, right) => left - right);
      observedWindows += 1;
      if (!indices.includes(finalIndex)) windowsWithoutFinal += 1;
      if (scrollTop !== lastObservedScrollTop) {
        if (previousLocalStart !== null && localStart > previousLocalStart) {
          advancingSeams += 1;
          const frontierTop = (previousLocalFrontier * rowHeight) - scrollTop;
          const frontierVisible = cluster.includes(previousLocalFrontier) &&
            frontierTop < 900 && frontierTop + 120 > 0;
          if (!frontierVisible) seamsWithoutVisibleFrontier += 1;
        }
        lastObservedScrollTop = scrollTop;
        previousLocalStart = localStart;
        previousLocalFrontier = cluster[cluster.length - 1];
      }
      return indices;
    },
    textForMessage: (message, index, visibleStart) => index === finalIndex && visibleStart < 100
      ? `Hydrating sparse-tail turn ${Math.floor(visibleStart / 20)}`
      : message.text,
    rectangleForMessage: ({ index, scrollTop }) => {
      const top = (index * rowHeight) - scrollTop;
      return { top, bottom: top + 120, width: 640, height: 120 };
    }
  });
  assert.equal(messages.length * rowHeight, 560_032);

  const controller = new ChatGPTController({ page, selectors: {} });
  const capture = await controller.captureConversation({ maxCaptureBytes: 250_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.deepEqual(capture.rawTurns, messages.map((message, index) => ({
    ordinal: index,
    providerMessageId: `sliding-${index}`,
    ...message
  })));
  assert.ok(observedWindows > 50);
  assert.equal(windowsWithoutFinal, 0);
  assert.ok(advancingSeams > 50);
  assert.equal(seamsWithoutVisibleFrontier, 0);
  assert.ok(capture.evidence.scrollPasses <= 70, `unexpected scroll passes: ${capture.evidence.scrollPasses}`);
});

test('chatgpt-controller: captureConversation requires generation inactive before and after stable capture', async () => {
  for (const generationSignal of ['stop', 'thinking-before', 'thinking-after']) {
    const page = virtualizedConversationPage([
      { role: 'user', text: 'Stable prompt' },
      { role: 'assistant', text: 'Stable response text during a slow generation pause' }
    ], { generationSignal });
    const controller = new ChatGPTController({
      page,
      selectors: { stopButton: 'button[data-testid="stop-button"]' },
      uiContract: {
        kind: 'chatgpt',
        profile: {
          exemptions: [
            { dependency: 'transcript-message-id', selector: '[data-message-id]' },
            { dependency: 'transcript-message', selector: '[data-message-author-role]' },
            { dependency: 'transcript-turn-ordinal', selector: '[data-testid^="conversation-turn-"]' },
            { dependency: 'transcript-generation-indicator', selector: '[role="status"], [aria-live]' }
          ]
        }
      }
    });

    const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

    assert.equal(capture.status, 'partial', generationSignal);
    assert.equal(capture.reason, 'conversation_generation_active', generationSignal);
    assert.equal(capture.rawTurns.length, 2, generationSignal);
    assert.equal(capture.evidence.topBoundary, true, generationSignal);
    assert.equal(capture.evidence.bottomBoundary, true, generationSignal);
  }
});

test('chatgpt-controller: captureConversation stitches overlapping remounted sliding windows', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index === 4 || index === 6 ? 'Repeated visible text' : `Sliding turn ${index}`
  }));
  const controller = new ChatGPTController({ page: slidingConversationPage(messages), selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(capture.evidence.orderedWindowStitching, true);
  assert.ok(capture.evidence.windowCount > 4);
});

test('chatgpt-controller: captureConversation reacquires a provider-id bridge across disjoint remounted windows', async () => {
  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index === 8 || index === 10 ? 'Repeated bridge text' : `Disjoint turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 3,
    rowHeight: 200,
    clientHeight: 600,
    initialStart: 10
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const captures = [];
  for (let index = 0; index < 3; index += 1) {
    captures.push(await controller.captureConversation({ maxCaptureBytes: 100_000 }));
  }

  assert.deepEqual(captures.map(({ status }) => status), ['complete', 'complete', 'complete']);
  assert.deepEqual(captures[0].rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(captures[0].evidence.orderedWindowStitching, true);
  assert.equal(new Set(captures.map((capture) => normalizeLiveCapture(capture).contentHash)).size, 1);
});

test('chatgpt-controller: captureConversation refuses disjoint provider-id windows when no bridge can be acquired', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Unbridgeable turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight: 800,
    clientHeight: 600,
    initialStart: 6,
    anchorScroll: false,
    providerOrdinals: false
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
  assert.equal(capture.evidence.orderedWindowStitching, false);
  assert.equal(capture.evidence.providerIdCount, 1);
});

test('chatgpt-controller: captureConversation accepts an ordered provider-id subset without inventing a seam', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Ordered subset turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 2, 3, 4];
      if (scrollTop < 200) return [4, 6, 7];
      if (scrollTop < 400) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(capture.evidence.orderedWindowStitching, true);
});

test('chatgpt-controller: captureConversation accepts a provider ordinal gap only after an overlapping served-range scan', async () => {
  const animationFramesByTop = new Map();
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Ordinal gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: ({ scrollTop }) => {
      animationFramesByTop.set(scrollTop, (animationFramesByTop.get(scrollTop) || 0) + 1);
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.equal(capture.rawTurns.some(({ text }) => text === 'Ordinal gap turn 2'), false);
  assert.equal(capture.evidence.orderedWindowStitching, true);
  assert.equal(animationFramesByTop.get(100), 2, 'a stable gap pixel receives a second-frame absence check');
});

test('chatgpt-controller: captureConversation proves one bounded consecutive leading ordinal gap in one scan', async () => {
  const animationFramesByTop = new Map();
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Leading gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    providerOrdinalForMessage: (_message, index) => index + 3,
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: ({ scrollTop }) => {
      animationFramesByTop.set(scrollTop, (animationFramesByTop.get(scrollTop) || 0) + 1);
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(animationFramesByTop.get(50), 2, 'both missing leading ordinals share one exact two-frame scan');
});

test('chatgpt-controller: captureConversation rejects an unproved leading ordinal gap', async () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Unproved leading gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    providerOrdinalForMessage: (_message, index) => index + 3,
    rectangleForMessage: () => ({
      top: -1_000,
      bottom: -920,
      width: 640,
      height: 80
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
});

test('chatgpt-controller: captureConversation does not prove a leading gap batch when one candidate mounts narrowly', async () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({
    role: index <= 1 || index % 2 === 1 ? 'user' : 'assistant',
    text: `Leading narrow candidate ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 5,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    providerOrdinalForMessage: (_message, index) => index + 2,
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [1, 2, 3, 4];
      if (scrollTop >= 31 && scrollTop <= 33) return [0, 1, 2, 3, 4];
      if (scrollTop < 320) return [1, 2, 3, 4, 5];
      return [2, 3, 4, 5, 6];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
  assert.equal(capture.rawTurns.some(({ providerMessageId }) => providerMessageId === 'sliding-0'), true);
});

test('chatgpt-controller: captureConversation preserves consecutive messages owned by one provider turn', async () => {
  const sharedTurnOwner = {
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-2' : null;
    }
  };
  const messages = [
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'First exact message in the shared turn' },
    { role: 'assistant', text: 'Second exact message in the shared turn' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Final reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => index <= 1 ? index + 1 : index,
    turnOwnerForMessage: (_message, index) => index === 1 || index === 2 ? sharedTurnOwner : null
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.deepEqual(capture.rawTurns, messages.map((message, index) => ({
    ordinal: index,
    providerMessageId: `sliding-${index}`,
    ...message
  })));
});

test('chatgpt-controller: empty mapped messages remain partial without reporting compatibility drift', async (t) => {
  for (const emptyIndex of [1, 2]) {
    await t.test(emptyIndex === 1 ? 'leading compound part' : 'trailing compound part', async () => {
      const sharedTurnOwner = {
        getAttribute(name) {
          return name === 'data-testid' ? 'conversation-turn-2' : null;
        }
      };
      const messages = [
        { role: 'user', text: 'Opening prompt' },
        { role: 'assistant', text: 'First exact message in the shared turn' },
        { role: 'assistant', text: 'Second exact message in the shared turn' },
        { role: 'user', text: 'Follow-up prompt' },
        { role: 'assistant', text: 'Final reply' }
      ];
      const page = slidingConversationPage(messages, {
        windowSize: messages.length,
        rowHeight: 80,
        clientHeight: 240,
        initialStart: 0,
        providerOrdinalForMessage: (_message, index) => index <= 1 ? index + 1 : index,
        turnOwnerForMessage: (_message, index) => index === 1 || index === 2 ? sharedTurnOwner : null,
        childNodesForMessage: (_message, index) => index === emptyIndex
          ? [{
              nodeType: 1,
              tagName: 'IMG',
              childNodes: [],
              hidden: false,
              getAttribute(name) {
                return name === 'alt' ? 'Changing image metadata is not transcript text' : null;
              }
            }]
          : undefined
      });
      const controller = new ChatGPTController({ page, selectors: {} });

      const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

      assert.equal(capture.status, 'partial');
      assert.equal(capture.reason, 'conversation_message_text_unavailable');
      assert.equal(capture.evidence.orderedWindowStitching, true);
      assert.equal(capture.rawTurns.some(({ text }) => text.length === 0), false);
    });
  }
});

test('chatgpt-controller: an all-image mapped window reports unavailable text instead of missing messages', async () => {
  const page = slidingConversationPage([
    { role: 'user', text: 'Layout fallback must not become transcript evidence' }
  ], {
    windowSize: 1,
    initialStart: 0,
    childNodesForMessage: () => [{
      nodeType: 1,
      tagName: 'IMG',
      childNodes: [],
      hidden: false,
      getAttribute(name) {
        return name === 'alt' ? 'Changing image metadata is not transcript text' : null;
      }
    }]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'conversation_message_text_unavailable');
  assert.deepEqual(capture.rawTurns, []);
});

test('chatgpt-controller: image-only input without provider positions remains compatibility drift', async () => {
  const page = slidingConversationPage([
    { role: 'user', text: 'Layout fallback must not become transcript evidence' }
  ], {
    windowSize: 1,
    initialStart: 0,
    providerOrdinals: false,
    childNodesForMessage: () => [{
      nodeType: 1,
      tagName: 'IMG',
      childNodes: [],
      hidden: false,
      getAttribute() { return null; }
    }]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.evidence.orderedWindowStitching, false);
});

test('chatgpt-controller: empty mapped messages cannot hide duplicate or reordered provider structure', async (t) => {
  const cases = [
    ['duplicate provider id', (_message, index) => index === 1 || index === 2 ? 'duplicate-id' : `message-${index}`, (_message, index) => index + 1],
    ['duplicate provider position', (_message, index) => `message-${index}`, (_message, index) => index === 2 ? 2 : index + 1],
    ['duplicate provider id and position', (_message, index) => index === 1 || index === 2 ? 'duplicate-id' : `message-${index}`, (_message, index) => index === 2 ? 2 : index + 1],
    ['reordered provider position', (_message, index) => `message-${index}`, (_message, index) => index === 1 ? 3 : index === 2 ? 2 : index + 1]
  ];
  for (const [name, providerIdForMessage, providerOrdinalForMessage] of cases) {
    await t.test(name, async () => {
      const page = slidingConversationPage([
        { role: 'user', text: 'Opening prompt' },
        { role: 'assistant', text: 'Image-only turn' },
        { role: 'user', text: 'Follow-up prompt' },
        { role: 'assistant', text: 'Final reply' }
      ], {
        windowSize: 4,
        initialStart: 0,
        providerIdForMessage,
        providerOrdinalForMessage,
        childNodesForMessage: (_message, index) => index === 1
          ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
          : undefined
      });
      const controller = new ChatGPTController({ page, selectors: {} });

      const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

      assert.equal(capture.status, 'partial');
      assert.equal(capture.reason, 'compatibility_drift');
    });
  }
});

test('chatgpt-controller: an empty mapped position cannot hydrate under a different provider id', async () => {
  let emptyTurnObservations = 0;
  const page = slidingConversationPage([
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Hydrated visual reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Final reply' }
  ], {
    windowSize: 4,
    initialStart: 0,
    providerIdForMessage: (_message, index) => {
      if (index !== 1) return `message-${index}`;
      emptyTurnObservations += 1;
      return emptyTurnObservations === 1 ? 'image-before-hydration' : 'image-after-hydration';
    },
    childNodesForMessage: (message, index) => index !== 1
      ? undefined
      : emptyTurnObservations === 0
        ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
        : [{ nodeType: 3, nodeValue: message.text }]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.ok(emptyTurnObservations > 1);
  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: empty mapped fingerprints clear only after exact identified hydration', async (t) => {
  await t.test('exact hydration completes', async () => {
    let imageObservations = 0;
    const messages = [
      { role: 'user', text: 'Opening prompt' },
      { role: 'assistant', text: 'Hydrated visual reply' },
      { role: 'user', text: 'Follow-up prompt' },
      { role: 'assistant', text: 'Final reply' }
    ];
    const page = slidingConversationPage(messages, {
      windowSize: 4,
      initialStart: 0,
      providerIdForMessage: (_message, index) => {
        if (index === 1) imageObservations += 1;
        return `message-${index}`;
      },
      childNodesForMessage: (message, index) => index !== 1
        ? undefined
        : imageObservations === 0
          ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
          : [{ nodeType: 3, nodeValue: message.text }]
    });
    const controller = new ChatGPTController({ page, selectors: {} });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    assert.equal(capture.status, 'complete');
    assert.deepEqual(capture.rawTurns.map(({ text }) => text), messages.map(({ text }) => text));
  });

  await t.test('exact hydration completes after the empty position locks', async () => {
    let imageObservations = 0;
    const messages = [
      { role: 'user', text: 'Opening prompt' },
      { role: 'assistant', text: 'Late hydrated visual reply' },
      { role: 'user', text: 'Follow-up prompt' },
      { role: 'assistant', text: 'Final reply' }
    ];
    const page = slidingConversationPage(messages, {
      windowSize: 4,
      initialStart: 0,
      providerIdForMessage: (_message, index) => {
        if (index === 1) imageObservations += 1;
        return `message-${index}`;
      },
      childNodesForMessage: (message, index) => index !== 1
        ? undefined
        : imageObservations <= 10
          ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
          : [{ nodeType: 3, nodeValue: message.text }]
    });
    const controller = new ChatGPTController({ page, selectors: {} });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    assert.ok(imageObservations > 10);
    assert.equal(capture.status, 'complete');
    assert.deepEqual(capture.rawTurns.map(({ text }) => text), messages.map(({ text }) => text));
  });

  await t.test('changed provider position remains drift', async () => {
    let imageObservations = 0;
    const page = slidingConversationPage([
      { role: 'user', text: 'Opening prompt' },
      { role: 'assistant', text: 'Hydrated visual reply' },
      { role: 'user', text: 'Follow-up prompt' },
      { role: 'assistant', text: 'Final reply' }
    ], {
      windowSize: 4,
      initialStart: 0,
      providerIdForMessage: (_message, index) => {
        if (index === 1) imageObservations += 1;
        return `message-${index}`;
      },
      providerOrdinalForMessage: (_message, index) => index === 1
        ? imageObservations === 0 ? 2 : 3
        : index === 0 ? 1 : index + 2,
      childNodesForMessage: (message, index) => index !== 1
        ? undefined
        : imageObservations === 0
          ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
          : [{ nodeType: 3, nodeValue: message.text }]
    });
    const controller = new ChatGPTController({ page, selectors: {} });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    assert.equal(capture.status, 'partial');
    assert.equal(capture.reason, 'compatibility_drift');
  });

  await t.test('identified unmount stays sticky partial', async () => {
    let imageObservations = 0;
    const page = slidingConversationPage([
      { role: 'user', text: 'Opening prompt' },
      { role: 'assistant', text: 'Image-only reply' },
      { role: 'user', text: 'Follow-up prompt' },
      { role: 'assistant', text: 'Final reply' }
    ], {
      windowSize: 4,
      initialStart: 0,
      providerIdForMessage: (_message, index) => {
        if (index === 1) imageObservations += 1;
        return `message-${index}`;
      },
      visibleIndicesForTop: () => imageObservations === 0 ? [0, 1, 2, 3] : [0, 2, 3],
      childNodesForMessage: (_message, index) => index === 1
        ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
        : undefined
    });
    const controller = new ChatGPTController({ page, selectors: {} });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    assert.equal(capture.status, 'partial');
    assert.equal(capture.reason, 'conversation_message_text_unavailable');
    assert.equal(capture.rawTurns.some(({ providerMessageId }) => providerMessageId === 'message-1'), false);
  });
});

test('chatgpt-controller: a newly reached compound part settles before its provider position locks', async () => {
  const messages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Settled compound-window turn ${index}`
  }));
  const sharedTurnOwner = {
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-11' : null;
    }
  };
  let compoundPartReads = 0;
  const page = slidingConversationPage(messages, {
    windowSize: 6,
    rowHeight: 200,
    clientHeight: 600,
    initialStart: messages.length - 1,
    providerOrdinalForMessage: (_message, index) => index <= 10 ? index + 1 : index,
    turnOwnerForMessage: (_message, index) => index === 10 || index === 11 ? sharedTurnOwner : null,
    visibleIndicesForTop: ({ scrollTop }) => {
      const start = Math.min(messages.length - 1, Math.floor(scrollTop / 200));
      const cluster = Array.from(
        { length: Math.min(6, messages.length - start) },
        (_, offset) => start + offset
      );
      return cluster.includes(10) || cluster.includes(11)
        ? [...new Set([...cluster, 10, 11])].sort((left, right) => left - right)
        : cluster;
    },
    textForMessage: (message, index) => {
      if (index !== 11) return message.text;
      compoundPartReads += 1;
      return compoundPartReads <= 3 ? `Hydrating compound part ${compoundPartReads}` : message.text;
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.rawTurns[11].text, messages[11].text);
  assert.ok(compoundPartReads > 3);
});

test('chatgpt-controller: malformed provider turn ordinal variants fail closed', async (t) => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Ordinal contract turn ${index}`
  }));
  let changedReads = 0;
  const cases = [
    ['malformed', (_message, index) => index === 2 ? 'bad' : index + 1],
    ['zero', (_message, index) => index === 2 ? 0 : index + 1],
    ['duplicate', (_message, index) => index === 2 ? 2 : index + 1],
    ['reordered', (_message, index) => index === 2 ? 4 : index === 3 ? 3 : index + 1],
    ['partially-missing', (_message, index) => index === 2 ? null : index + 1],
    ['changed', (_message, index) => index === 3 && changedReads++ > 1 ? 5 : index + 1]
  ];

  for (const [name, providerOrdinalForMessage] of cases) {
    await t.test(name, async () => {
      const page = slidingConversationPage(messages, {
        initialStart: 4,
        providerOrdinalForMessage
      });
      const controller = new ChatGPTController({ page, selectors: {} });

      const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

      assert.equal(capture.status, 'partial');
      assert.equal(capture.reason, 'compatibility_drift');
      assert.equal(capture.evidence.orderedWindowStitching, false);
    });
  }
});

test('chatgpt-controller: captureConversation rejects a message owned by a hidden provider turn', async () => {
  const hiddenOwner = {
    isConnected: true,
    hidden: false,
    getAttribute(name) {
      if (name === 'data-testid') return 'conversation-turn-3';
      if (name === 'aria-hidden') return 'true';
      return null;
    },
    hasAttribute() {
      return false;
    },
    closest(selector) {
      return selector === '[aria-hidden="true"], [inert]' ? this : null;
    },
    getBoundingClientRect() {
      return { top: 80, bottom: 160, width: 640, height: 80 };
    }
  };
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Hidden owner turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    initialStart: 0,
    turnOwnerForMessage: (_message, index) => index === 2 ? hiddenOwner : null
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.rawTurns.length, 0);
});

test('chatgpt-controller: captureConversation rejects a provider turn without a rendered client rectangle', async () => {
  const cssHiddenOwner = {
    isConnected: true,
    hidden: false,
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-3' : null;
    },
    hasAttribute() {
      return false;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [];
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 0, width: 0, height: 0 };
    }
  };
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `CSS hidden owner turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    initialStart: 0,
    turnOwnerForMessage: (_message, index) => index === 2 ? cssHiddenOwner : null
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.rawTurns.length, 0);
});

test('chatgpt-controller: captureConversation rejects a transparent provider turn', async () => {
  const transparentOwner = {
    isConnected: true,
    hidden: false,
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-3' : null;
    },
    hasAttribute() {
      return false;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [{ top: 80, bottom: 160, width: 640, height: 80 }];
    },
    getBoundingClientRect() {
      return { top: 80, bottom: 160, width: 640, height: 80 };
    }
  };
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Transparent owner turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    initialStart: 0,
    turnOwnerForMessage: (_message, index) => index === 2 ? transparentOwner : null,
    computedStyleForNode: (node) => node === transparentOwner ? { opacity: '0' } : {}
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.rawTurns.length, 0);
});

test('chatgpt-controller: a reordered discovery-only initial window does not poison later exact capture', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Initial order turn ${index}`
  }));
  let ordinalReads = 0;
  const page = slidingConversationPage(messages, {
    initialStart: 4,
    providerOrdinalForMessage: (_message, index) => {
      ordinalReads += 1;
      if (ordinalReads <= 4 && index === 5) return 7;
      if (ordinalReads <= 4 && index === 6) return 6;
      return index + 1;
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(capture.evidence.orderedWindowStitching, true);
});

test('chatgpt-controller: captureConversation rejects a reordered provider-id subset', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Reordered subset turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => scrollTop < 200 ? [6, 4, 7] : [4, 5, 6, 7]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.evidence.orderedWindowStitching, false);
});

test('chatgpt-controller: captureConversation settles one top-boundary text hydration before publication', async () => {
  const partialText = 'Hydrating first turn';
  const finalText = 'Stable first turn';
  let firstTurnReads = 0;
  const messages = [
    { role: 'user', text: finalText },
    { role: 'assistant', text: 'Stable reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: 2,
    rowHeight: 300,
    clientHeight: 240,
    initialStart: 0,
    textForMessage: (message, index) => {
      if (index !== 0) return message.text;
      firstTurnReads += 1;
      return firstTurnReads <= 8 ? partialText : finalText;
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns[0], {
    ordinal: 0,
    providerMessageId: 'sliding-0',
    role: 'user',
    text: finalText
  });
  assert.ok(firstTurnReads > 8);
});

test('chatgpt-controller: captureConversation rejects a provider id whose content changes across a seam', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Stable ${index}`
  }));
  const page = slidingConversationPage(messages, {
    textForMessage: (message, index, visibleStart) => index === 3 && visibleStart >= 3 ? 'Changed mid-capture' : message.text
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: captureConversation refuses to bind turns across a route identity change', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'Prompt' },
    { role: 'assistant', text: 'Reply' }
  ]);
  let reads = 0;
  page.getUrl = async () => reads++ === 0
    ? 'https://chatgpt.com/c/before-thread'
    : 'https://chatgpt.com/c/after-thread';
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.conversationUrl, null);
});

test('chatgpt-controller: captureConversation refuses an observed A-to-B-to-A route transition', async () => {
  const routeA = 'https://chatgpt.com/c/route-a';
  const routeB = 'https://chatgpt.com/c/route-b';
  const page = virtualizedConversationPage([
    { role: 'user', text: 'Prompt' },
    { role: 'assistant', text: 'Reply' }
  ]);
  const evaluatedSources = [];
  const evaluate = page.evaluate.bind(page);
  let observeRoute = null;
  page.getUrl = async () => routeA;
  page.beginNavigationGuard = async (matchesUrl) => {
    let stable = matchesUrl(routeA);
    observeRoute = (url) => {
      if (!matchesUrl(url)) stable = false;
    };
    return {
      isStable: () => stable,
      dispose() {}
    };
  };
  page.evaluate = async (js) => {
    evaluatedSources.push(js);
    if (js.includes('const cap =')) {
      observeRoute?.(routeB);
      observeRoute?.(routeA);
    }
    return await evaluate(js);
  };
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
  assert.equal(capture.conversationUrl, null);
  assert.equal(evaluatedSources.some((source) => source.includes('route-a')), false);
  assert.equal(evaluatedSources.some((source) => source.includes('route-b')), false);
});

test('chatgpt-controller: captureConversation preserves repeated id-less turns observed in one ordered window', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'Prompt' },
    { role: 'assistant', text: 'Repeated' },
    { role: 'assistant', text: 'Repeated' }
  ], { providerIds: false });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.rawTurns.length, 3);
  assert.equal(capture.rawTurns[1].text, capture.rawTurns[2].text);
  assert.equal(capture.rawTurns[1].providerMessageId, null);
});

test('chatgpt-controller: provider turn ordinals preserve repeated id-less exchanges across remounted windows', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: index >= 8 ? `Repeated exchange ${index % 2}` : `Distinct ${index}`
  }));
  const page = slidingConversationPage(messages, {
    initialStart: 6,
    providerIds: false
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.rawTurns.length, messages.length);
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    Array(messages.length).fill(null));
  assert.deepEqual(capture.rawTurns.slice(8).map(({ text }) => text),
    ['Repeated exchange 0', 'Repeated exchange 1', 'Repeated exchange 0', 'Repeated exchange 1']);
});

test('chatgpt-controller: captureConversation fails closed when repeated id-less turns make a seam ambiguous', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'Same' },
    { role: 'user', text: 'Same' },
    { role: 'user', text: 'Same' }
  ], { initialStart: 1, loadDelayMs: 400, providerIds: false, providerOrdinals: false });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
  assert.equal(capture.evidence.orderedWindowStitching, false);
});

test('chatgpt-controller: captureConversation enforces the byte boundary before publication', async () => {
  const page = virtualizedConversationPage([{ role: 'user', text: '😀'.repeat(100) }]);
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 32 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'max_capture_bytes');
  assert.equal(capture.rawTurns.length, 0);
  assert.equal(capture.evidence.byteCount, 0);
});

test('chatgpt-controller: review regression does not prove a narrowly served provider ordinal absent', async () => {
  const sampledTops = [];
  const animationFramesByTop = new Map();
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Narrow ordinal turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => {
      sampledTops.push(scrollTop);
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop >= 31 && scrollTop <= 33) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: ({ scrollTop }) => {
      animationFramesByTop.set(scrollTop, (animationFramesByTop.get(scrollTop) || 0) + 1);
    }
  });
  const servedOrdinals = await page.evaluate(`(() => {
    const scroller = document.querySelector('main');
    const initialScrollTop = scroller.scrollTop;
    scroller.scrollTop = 32;
    const ordinals = Array.from(document.querySelectorAll('[data-message-author-role]'))
      .map((node) => node.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid'));
    scroller.scrollTop = initialScrollTop;
    return ordinals;
  })()`);
  assert.ok(servedOrdinals.includes('conversation-turn-3'));
  sampledTops.length = 0;

  const controller = new ChatGPTController({ page, selectors: {} });
  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(sampledTops.some((top) => top >= 31 && top <= 33), true);
  assert.ok(
    (animationFramesByTop.get(31) || 0) >= 4,
    'a provider turn first mounted at a narrow gap pixel still receives stability observations'
  );
});

test('chatgpt-controller: review regression waits for a second-frame narrow provider turn mount', async () => {
  const animationFramesByTop = new Map();
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Delayed narrow ordinal turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (
        scrollTop >= 31 &&
        scrollTop <= 33 &&
        (animationFramesByTop.get(scrollTop) || 0) >= 2
      ) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: ({ scrollTop }) => {
      animationFramesByTop.set(scrollTop, (animationFramesByTop.get(scrollTop) || 0) + 1);
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.ok((animationFramesByTop.get(31) || 0) >= 4);
});

test('chatgpt-controller: review regression samples the exact inclusive upper gap-scan edge', async () => {
  const sampledTops = [];
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Upper-edge ordinal turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => {
      sampledTops.push(scrollTop);
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop === 159) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(sampledTops.includes(159), true);
});

test('chatgpt-controller: review regression retries an anchored gap pixel without skipping its served turn', async () => {
  let requestedGapPixel = 0;
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Anchored gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    scrollTopForRequest: ({ requested }) => {
      if (requested !== 32) return requested;
      requestedGapPixel += 1;
      return requestedGapPixel === 1 ? 33 : 32;
    },
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop === 32) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(capture.status, 'complete');
  assert.ok(requestedGapPixel >= 2);
});

test('chatgpt-controller: review regression lets a bounded gap pixel outlast six scroll-anchor nudges', async () => {
  let framesAtGapPixel = 0;
  let nudgeCount = 0;
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Repeatedly anchored gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    scrollTopForRequest: ({ requested }) => {
      if (requested === 32) framesAtGapPixel = 0;
      return requested;
    },
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop === 32) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: () => {},
    scrollTopAfterAnimationFrame: ({ scrollTop }) => {
      if (scrollTop !== 32) return scrollTop;
      framesAtGapPixel += 1;
      if (framesAtGapPixel >= 2 && nudgeCount < 8) {
        nudgeCount += 1;
        return 33;
      }
      return scrollTop;
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.equal(nudgeCount, 8);
});

test('chatgpt-controller: review regression fails closed when a gap pixel never settles', async () => {
  let requestedGapPixel = 0;
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Unsettled gap turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    scrollTopForRequest: ({ requested }) => {
      if (requested !== 32) return requested;
      requestedGapPixel += 1;
      return 33;
    },
    visibleIndicesForTop: ({ scrollTop }) => {
      if (scrollTop <= 1) return [0, 1, 3, 4];
      if (scrollTop === 32) return [1, 2, 3, 4];
      if (scrollTop < 320) return [3, 4, 5, 6];
      return [4, 5, 6, 7];
    },
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
  assert.ok(requestedGapPixel >= 2 && requestedGapPixel <= 8);
});

test('chatgpt-controller: review regression keeps gap-proof samples outside the navigation pass budget', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Bounded gap proof turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 5,
    rowHeight: 1_000,
    clientHeight: 4_000,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => scrollTop < 4_000
      ? [0, 1, 3, 4]
      : [3, 4, 5, 6, 7],
    rectangleForMessage: () => ({
      top: 0,
      bottom: 5_000,
      width: 640,
      height: 5_000
    })
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.rawTurns.some(({ providerMessageId }) => providerMessageId === 'sliding-2'), false);
  assert.ok(capture.evidence.scrollPasses > 4_000);
});

test('chatgpt-controller: six long-thread gap proofs stay inside a 60 Hz capture deadline', async () => {
  const skippedBeforeIndices = new Set([30, 65, 100, 135, 170, 205]);
  const providerOrdinals = [];
  let providerOrdinal = 0;
  const messages = Array.from({ length: 240 }, (_, index) => {
    providerOrdinal += skippedBeforeIndices.has(index) ? 2 : 1;
    providerOrdinals.push(providerOrdinal);
    return {
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `Long sparse turn ${index}`
    };
  });
  let virtualNow = 0;
  const page = slidingConversationPage(messages, {
    windowSize: 16,
    rowHeight: 100,
    clientHeight: 1_311,
    initialStart: 224,
    providerOrdinalForMessage: (_message, index) => providerOrdinals[index],
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    onAnimationFrame: () => {
      virtualNow += 1_000 / 60;
    },
    performanceNow: () => virtualNow
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 1_000_000 });

  assert.deepEqual(
    { status: capture.status, reason: capture.reason || null },
    { status: 'complete', reason: null }
  );
  assert.equal(capture.rawTurns.length, messages.length);
  assert.ok(
    capture.evidence.scrollPasses > 6_000 && capture.evidence.scrollPasses < 10_000,
    `unexpected exact gap-scan count ${capture.evidence.scrollPasses}`
  );
  assert.ok(
    virtualNow > 200_000 && virtualNow < 300_000,
    `virtual capture fell outside its 60 Hz proof window at ${virtualNow}ms`
  );
});

test('chatgpt-controller: review regression rejects an offscreen retained node as provider-gap endpoint evidence', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Retained endpoint turn ${index}`
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 5,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 5,
    visibleIndicesForTop: ({ scrollTop }) => scrollTop < 320
      ? [0, 1, 3, 4]
      : [3, 4, 5, 6, 7],
    rectangleForMessage: ({ index, offset, rowHeight }) => {
      if (index === 1) return { top: -1_000, bottom: -920, width: 640, height: 80 };
      if (index === 3) return { top: 100, bottom: 180, width: 640, height: 80 };
      return {
        top: offset * rowHeight,
        bottom: (offset + 1) * rowHeight,
        width: 640,
        height: rowHeight
      };
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'ambiguous_message_overlap');
});

test('chatgpt-controller: review regression settles every new provider position through a fourth-read newline change', async () => {
  const observationReads = Array(10).fill(0);
  const finalTexts = Array.from({ length: observationReads.length }, (_, index) =>
    `Settled virtual turn ${index}\nwith interior newline`);
  const messages = finalTexts.map((text, index) => ({
    get role() {
      observationReads[index] += 1;
      return index % 2 === 0 ? 'user' : 'assistant';
    },
    text
  }));
  const page = slidingConversationPage(messages, {
    windowSize: 1,
    rowHeight: 800,
    clientHeight: 600,
    initialStart: messages.length - 1,
    textForMessage: (message, index) => observationReads[index] < 3
      ? `Settled virtual turn ${index} with interior newline`
      : message.text,
    rectangleForMessage: ({ index, scrollTop }) => {
      const top = (index * 800) - scrollTop;
      return { top, bottom: top + 120, width: 640, height: 120 };
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.ok(
    capture.status === 'partial' ||
      (
        capture.rawTurns.every((turn, index) => turn.text === finalTexts[index]) &&
        observationReads.every((count) => count >= 7)
      ),
    'a complete capture must include the fourth-read change and observe that value four identical times'
  );
});

test('chatgpt-controller: review regression never discards the terminal provider-stability observation', async () => {
  let casesThatServedFinalText = 0;
  for (let changeAfterReads = 0; changeAfterReads <= 10; changeAfterReads += 1) {
    const observationReads = Array(5).fill(0);
    const finalTexts = Array.from({ length: observationReads.length }, (_, index) =>
      `Terminal observation ${index}\nwith final newline`);
    const staleText = 'Terminal observation 2 with final newline';
    let servedFinalText = false;
    const messages = finalTexts.map((text, index) => ({
      get role() {
        observationReads[index] += 1;
        return index % 2 === 0 ? 'user' : 'assistant';
      },
      text
    }));
    const page = slidingConversationPage(messages, {
      windowSize: 1,
      rowHeight: 800,
      clientHeight: 600,
      initialStart: messages.length - 1,
      lazyTextForMessage: true,
      textForMessage: (message, index) => {
        if (index !== 2 || observationReads[index] < changeAfterReads) return index === 2 ? staleText : message.text;
        servedFinalText = true;
        return message.text;
      },
      rectangleForMessage: ({ index, scrollTop }) => {
        const top = (index * 800) - scrollTop;
        return { top, bottom: top + 120, width: 640, height: 120 };
      }
    });
    const controller = new ChatGPTController({ page, selectors: {} });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    if (!servedFinalText) continue;
    casesThatServedFinalText += 1;
    assert.ok(
      capture.status === 'partial' || capture.rawTurns[2]?.text === finalTexts[2],
      `a complete capture discarded an observed provider change at threshold ${changeAfterReads}`
    );
  }
  assert.ok(casesThatServedFinalText > 0);
});

test('chatgpt-controller: review regression derives stable text from semantic DOM instead of volatile layout text', async () => {
  let layoutReads = 0;
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Layout-only fallback ${index}`
  }));
  const textNode = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, childNodes, attributes = {}) => ({
    nodeType: 1,
    tagName,
    childNodes,
    hidden: false,
    getAttribute(name) {
      return attributes[name] || null;
    }
  });
  const expected = messages.map((_, index) => `Stable line ${index}\nStable detail ${index}`);
  const page = slidingConversationPage(messages, {
    initialStart: messages.length - 1,
    textForMessage: (_message, index) => {
      layoutReads += 1;
      return layoutReads % 2 === 0
        ? `Stable line ${index}Stable detail ${index}`
        : `Stable line ${index}\nStable detail ${index}`;
    },
    childNodesForMessage: (_message, index) => [
      element('DIV', [
        element('P', [textNode(`Stable line ${index}`)]),
        element('P', [textNode(`Stable detail ${index}`)]),
        element('BUTTON', [textNode('Volatile control')]),
        element('SPAN', [textNode('Hidden duplicate')], { 'aria-hidden': 'true' })
      ])
    ]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const captures = [];
  for (let index = 0; index < 3; index += 1) {
    captures.push(await controller.captureConversation({ maxCaptureBytes: 100_000 }));
  }

  assert.deepEqual(captures.map(({ status }) => status), ['complete', 'complete', 'complete']);
  assert.deepEqual(captures[0].rawTurns.map(({ text }) => text), expected);
  assert.equal(new Set(captures.map((capture) => normalizeLiveCapture(capture).contentHash)).size, 1);
  assert.ok(layoutReads > 6);
});

test('chatgpt-controller: review regression excludes lazy image alt metadata from transcript text', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Stable visual turn ${index}`
  }));
  const textNode = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, childNodes, attributes = {}) => ({
    nodeType: 1,
    tagName,
    childNodes,
    hidden: false,
    getAttribute(name) {
      return attributes[name] || null;
    }
  });
  const page = slidingConversationPage(messages, {
    childNodesForMessage: (message, index, visibleStart) => [
      element('P', [textNode(message.text)]),
      ...(index === 3
        ? [element('IMG', [], {
            alt: visibleStart >= 3 ? 'Late virtualized image metadata' : 'Early image metadata'
          })]
        : [])
    ]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ text }) => text), messages.map(({ text }) => text));
});

test('chatgpt-controller: review regression excludes CSS-hidden transcript descendants', async () => {
  const textNode = (value) => ({ nodeType: 3, nodeValue: value });
  const element = (tagName, childNodes, { cssHidden = false } = {}) => ({
    nodeType: 1,
    tagName,
    childNodes,
    cssHidden,
    hidden: false,
    getAttribute() { return null; }
  });
  const page = slidingConversationPage([
    { role: 'user', text: 'Layout fallback prompt' },
    { role: 'assistant', text: 'Layout fallback reply' }
  ], {
    windowSize: 2,
    initialStart: 0,
    childNodesForMessage: (_message, index) => index === 0
      ? [
          element('DIV', [
            element('P', [textNode('Visible prompt')]),
            element('SPAN', [textNode('CSS hidden duplicate')], { cssHidden: true })
          ])
        ]
      : [element('P', [textNode('Visible reply')])],
    computedStyleForNode: (node) => node?.cssHidden
      ? { display: 'none', visibility: 'visible' }
      : { display: 'block', visibility: 'visible' }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ text }) => text), ['Visible prompt', 'Visible reply']);
});

test('chatgpt-controller: an id-less empty compound part stays partial after it transiently unmounts', async () => {
  let trailingPartObservations = 0;
  const sharedTurnOwner = {
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-2' : null;
    }
  };
  const messages = [
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: '' },
    {
      get role() {
        trailingPartObservations += 1;
        return 'assistant';
      },
      text: 'Only populated part of the shared turn'
    },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Final reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerIds: false,
    providerOrdinalForMessage: (_message, index) => index <= 1 ? index + 1 : index,
    turnOwnerForMessage: (_message, index) => index === 1 || index === 2 ? sharedTurnOwner : null,
    visibleIndicesForTop: () => trailingPartObservations === 0
      ? [0, 1, 2, 3, 4]
      : [0, 2, 3, 4]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.ok(trailingPartObservations > 1, 'the populated part must be observed before and after the leading part unmounts');
  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'conversation_message_text_unavailable');
  assert.equal(capture.evidence.orderedWindowStitching, true);
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId, role, text }) => ({ providerMessageId, role, text })), [
    { providerMessageId: null, role: 'user', text: 'Opening prompt' },
    { providerMessageId: null, role: 'assistant', text: 'Only populated part of the shared turn' },
    { providerMessageId: null, role: 'user', text: 'Follow-up prompt' },
    { providerMessageId: null, role: 'assistant', text: 'Final reply' }
  ]);
});

test('chatgpt-controller: review regression reconciles a provider-identified leading compound part before lock', async () => {
  let windowReads = 0;
  const sharedTurnOwner = {
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-2' : null;
    }
  };
  const messages = [
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Leading compound part' },
    { role: 'assistant', text: 'Trailing compound part' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Final reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => index <= 1 ? index + 1 : index,
    turnOwnerForMessage: (_message, index) => index === 1 || index === 2 ? sharedTurnOwner : null,
    visibleIndicesForTop: () => {
      windowReads += 1;
      return windowReads <= 2 ? [0, 2, 3, 4] : [0, 1, 2, 3, 4];
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
});

test('chatgpt-controller: review regression fails closed on a stable empty interior turn wrapper', async () => {
  const shell = {
    isConnected: true,
    matches() { return false; },
    querySelectorAll() { return []; },
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-3' : null;
    },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 80, bottom: 160, width: 640, height: 80 };
    }
  };
  const providerOrdinals = [1, 2, 4, 5];
  const page = slidingConversationPage([
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Opening reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Follow-up reply' }
  ], {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => providerOrdinals[index],
    childNodesForMessage: (_message, index) => index === 1
      ? [{ nodeType: 1, tagName: 'IMG', childNodes: [], hidden: false, getAttribute() { return null; } }]
      : undefined,
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    turnOwnerNodesForTop: () => [shell]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: review regression proves stable map-owned historical turn chrome is not a message', async () => {
  let shellObservations = 0;
  let shellChromeReads = 0;
  let shellStructureReads = 0;
  const shellText = { nodeType: 3, nodeValue: 'Historical provider status' };
  const safeChromeChild = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [],
    matches() { return false; },
    getAttribute(name) {
      return name === 'role' ? 'group' : null;
    }
  };
  const historicalImage = {
    nodeType: 1,
    tagName: 'IMG',
    childNodes: [],
    matches() { return false; },
    getAttribute() { return null; }
  };
  const shell = {
    nodeType: 1,
    tagName: 'SECTION',
    childNodes: [shellText],
    get textContent() {
      shellChromeReads += 1;
      return `Changing historical control ${shellChromeReads}`;
    },
    isConnected: true,
    hidden: false,
    matches(selector) {
      return selector.includes('[role="status"]');
    },
    querySelectorAll(selector) {
      if (selector === '*') {
        shellStructureReads += 1;
        return shellStructureReads % 2 === 0 ? [safeChromeChild] : [];
      }
      if (selector.includes('img') && shellStructureReads >= 4) return [historicalImage];
      return [];
    },
    getAttribute(name) {
      if (name === 'data-testid') return 'conversation-turn-3';
      if (name === 'role') return 'status';
      if (name === 'class') return 'provider-utility-class '.repeat(40);
      if (name === 'aria-label') return `historical-provider-control-${shellChromeReads}`;
      return null;
    },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 80, bottom: 160, width: 640, height: 80 };
    }
  };
  const providerOrdinals = [1, 2, 4, 5];
  const messages = [
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Opening reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Follow-up reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => providerOrdinals[index],
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    turnOwnerNodesForTop: () => {
      shellObservations += 1;
      return [shell];
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete', `${capture.reason}:${shellObservations}`);
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.ok(shellObservations >= 4);
  assert.ok(shellChromeReads >= 4);
  assert.ok(shellStructureReads >= 4);
});

test('chatgpt-controller: review regression does not classify semantic content as historical turn chrome', async () => {
  const textNode = { nodeType: 3, nodeValue: 'Unmapped semantic content' };
  const paragraph = {
    nodeType: 1,
    tagName: 'P',
    childNodes: [textNode],
    matches() { return false; },
    getAttribute() { return null; }
  };
  const shell = {
    nodeType: 1,
    tagName: 'SECTION',
    childNodes: [paragraph],
    isConnected: true,
    hidden: false,
    matches(selector) {
      return selector.includes('[role="status"]');
    },
    querySelectorAll(selector) {
      if (selector === '*') return [paragraph];
      if (selector.includes('p')) return [paragraph];
      return [];
    },
    getAttribute(name) {
      if (name === 'data-testid') return 'conversation-turn-3';
      if (name === 'role') return 'status';
      return null;
    },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 80, bottom: 160, width: 640, height: 80 };
    }
  };
  const providerOrdinals = [1, 2, 4, 5];
  const page = slidingConversationPage([
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Opening reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Follow-up reply' }
  ], {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => providerOrdinals[index],
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    turnOwnerNodesForTop: () => [shell]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: review regression audits an empty wrapper beyond the final mapped turn', async () => {
  const shell = {
    isConnected: true,
    matches() { return false; },
    querySelectorAll() { return []; },
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-5' : null;
    },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 160, bottom: 240, width: 640, height: 80 };
    }
  };
  const page = slidingConversationPage([
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Opening reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Follow-up reply' }
  ], {
    windowSize: 4,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    turnOwnerNodesForTop: () => [shell]
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: review regression accepts a turn wrapper only after its mapped message hydrates stably', async () => {
  let ownerObservations = 0;
  const shell = {
    isConnected: true,
    matches() { return false; },
    querySelectorAll() { return []; },
    getAttribute(name) {
      return name === 'data-testid' ? 'conversation-turn-5' : null;
    },
    closest() { return null; },
    getBoundingClientRect() {
      return { top: 160, bottom: 240, width: 640, height: 80 };
    }
  };
  const messages = [
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Opening reply' },
    { role: 'user', text: 'Follow-up prompt' },
    { role: 'assistant', text: 'Follow-up reply' },
    { role: 'assistant', text: 'Hydrated final reply' }
  ];
  const page = slidingConversationPage(messages, {
    windowSize: messages.length,
    rowHeight: 80,
    clientHeight: 240,
    initialStart: 0,
    visibleIndicesForTop: () => ownerObservations < 3 ? [0, 1, 2, 3] : [0, 1, 2, 3, 4],
    rectangleForMessage: ({ offset, rowHeight }) => ({
      top: offset * rowHeight,
      bottom: (offset + 1) * rowHeight,
      width: 640,
      height: rowHeight
    }),
    turnOwnerNodesForTop: ({ messageNodes }) => {
      ownerObservations += 1;
      return ownerObservations <= 3 ? [shell] : [messageNodes.at(-1)];
    }
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'complete', `${capture.reason}:${ownerObservations}:${capture.rawTurns.length}`);
  assert.deepEqual(capture.rawTurns.map(({ providerMessageId }) => providerMessageId),
    messages.map((_, index) => `sliding-${index}`));
  assert.ok(ownerObservations >= 7);
});

test('chatgpt-controller: review regression bounds absurd provider ordinals without synchronous gap walking', async () => {
  const page = slidingConversationPage([
    { role: 'user', text: 'Opening prompt' },
    { role: 'assistant', text: 'Impossible provider position' }
  ], {
    initialStart: 0,
    providerOrdinalForMessage: (_message, index) => index === 0 ? 1 : Number.MAX_SAFE_INTEGER
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'compatibility_drift');
});

test('chatgpt-controller: review regression host deadline terminates a hung renderer capture', async () => {
  let terminateCalls = 0;
  const page = {
    async evaluate() {
      return await new Promise(() => {});
    },
    async terminateEvaluation() {
      terminateCalls += 1;
      return true;
    },
    async getUrl() {
      return 'https://chatgpt.com/c/hung-capture';
    }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {},
    captureHostTimeoutMs: 5
  });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'conversation_capture_timeout');
  assert.equal(terminateCalls, 1);
});

test('chatgpt-controller: unconfirmed capture termination quarantines later exclusive work', async () => {
  let settleEvaluation;
  const evaluation = new Promise((resolve) => { settleEvaluation = resolve; });
  const page = {
    async evaluate() {
      return await evaluation;
    },
    async terminateEvaluation() {
      return false;
    },
    async getUrl() {
      return 'https://chatgpt.com/c/unconfirmed-capture-termination';
    }
  };
  const controller = new ChatGPTController({
    page,
    selectors: {},
    captureHostTimeoutMs: 5
  });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });
  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'conversation_capture_timeout');
  await assert.rejects(
    controller.runExclusive(async () => 'unsafe-overlap'),
    (error) => error?.code === 'tab_busy'
  );

  settleEvaluation({
    status: 'partial',
    reason: 'conversation_messages_not_found',
    rawTurns: [],
    evidence: {
      topBoundary: false,
      bottomBoundary: false,
      orderedWindowStitching: false,
      scrollPasses: 0,
      windowCount: 1,
      messageCount: 0,
      providerIdCount: 0,
      byteCount: 0
    }
  });
  await evaluation;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await controller.runExclusive(async () => 'released'), 'released');
});

test('chatgpt-controller: review regression host deadline covers route reads and rejects before slow termination', async (t) => {
  await t.test('hung route read', async () => {
    let terminateCalls = 0;
    const page = {
      async evaluate() {
        throw new Error('evaluation_must_not_start');
      },
      async terminateEvaluation() {
        terminateCalls += 1;
        return true;
      },
      async getUrl() {
        return await new Promise(() => {});
      }
    };
    const controller = new ChatGPTController({
      page,
      selectors: {},
      captureHostTimeoutMs: 5
    });

    const capture = await Promise.race([
      controller.captureConversation({ maxCaptureBytes: 100_000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test_capture_deadline_missed')), 100))
    ]);

    assert.equal(capture.status, 'partial');
    assert.equal(capture.reason, 'conversation_capture_timeout');
    assert.equal(capture.conversationUrl, null);
    assert.deepEqual(capture.rawTurns, []);
    assert.equal(terminateCalls, 1);
  });

  await t.test('renderer returns after the deadline while termination is still pending', async () => {
    let terminateCalls = 0;
    const page = {
      async evaluate() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: 'partial',
          reason: 'conversation_messages_not_found',
          rawTurns: [],
          evidence: {
            topBoundary: false,
            bottomBoundary: false,
            orderedWindowStitching: false,
            scrollPasses: 0,
            windowCount: 1,
            messageCount: 0,
            providerIdCount: 0,
            byteCount: 0
          }
        };
      },
      async terminateEvaluation() {
        terminateCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return true;
      },
      async getUrl() {
        return 'https://chatgpt.com/c/late-renderer-result';
      }
    };
    const controller = new ChatGPTController({
      page,
      selectors: {},
      captureHostTimeoutMs: 5
    });

    const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

    assert.equal(capture.status, 'partial');
    assert.equal(capture.reason, 'conversation_capture_timeout');
    assert.equal(capture.conversationUrl, null);
    assert.deepEqual(capture.rawTurns, []);
    assert.equal(terminateCalls, 1);
  });
});

test('chatgpt-controller: review regression maps malformed DOM turns to partial compatibility drift', async (t) => {
  const cases = [
    ['role longer than 64 characters', { role: 'r'.repeat(65), text: 'Bounded text' }, 100_000],
    ['NUL text', { role: 'user', text: 'Before\u0000after' }, 100_000],
    ['single turn above the text contract but below the byte cap', {
      role: 'user',
      text: 'x'.repeat(1_000_000)
    }, 1_100_000]
  ];

  for (const [name, message, maxCaptureBytes] of cases) {
    await t.test(name, async () => {
      const page = virtualizedConversationPage([message]);
      const controller = new ChatGPTController({ page, selectors: {} });
      let capture;

      await assert.doesNotReject(async () => {
        capture = await controller.captureConversation({ maxCaptureBytes });
      });
      assert.equal(capture.status, 'partial');
      assert.equal(capture.reason, 'compatibility_drift');
    });
  }
});

test('chatgpt-controller: readConversationText top-anchors before scanning a virtualized transcript', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'First turn' },
    { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Final turn' }
  ], { initialStart: 1 });
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 500 });

  assert.equal(result.text, 'User\nFirst turn\n\nAssistant\nFirst reply\n\nUser\nFinal turn');
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.reason, null);
  assert.equal(result.messageCount, 3);
  assert.ok(result.scrollPasses > 2);
});

test('chatgpt-controller: readConversationText waits for delayed leading turns with a user-role surviving head', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'First turn' },
    { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Second turn' },
    { role: 'assistant', text: 'Second reply' }
  ], { initialStart: 2, loadDelayMs: 400 });
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 500 });

  assert.equal(result.text, 'User\nFirst turn\n\nAssistant\nFirst reply\n\nUser\nSecond turn\n\nAssistant\nSecond reply');
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.reason, null);
  assert.equal(result.messageCount, 4);
});

test('chatgpt-controller: readConversationText recognizes a scroller already at its bottom boundary', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'First turn' },
    { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Second turn' },
    { role: 'assistant', text: 'Second reply' }
  ], {
    initialStart: 2,
    initialScrollTop: 200,
    loadDelayMs: 400,
    loadOnMessageScroll: false
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 500 });

  assert.equal(result.text, 'User\nFirst turn\n\nAssistant\nFirst reply\n\nUser\nSecond turn\n\nAssistant\nSecond reply');
  assert.equal(result.complete, true);
  assert.equal(result.messageCount, 4);
});

test('chatgpt-controller: captureConversation rechecks a bottom that grows while settling', async () => {
  const messages = [
    { role: 'user', text: 'First turn' },
    { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Delayed final turn' },
    { role: 'assistant', text: 'Delayed final reply' }
  ];
  const page = virtualizedConversationPage(messages, {
    initialEnd: 3,
    trailingLoadDelayMs: 100
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'complete');
  assert.deepEqual(capture.rawTurns.map(({ text }) => text), messages.map(({ text }) => text));
  assert.equal(capture.evidence.bottomBoundary, true);
});

test('chatgpt-controller: readConversationText waits for delayed leading turns without a movable scroller', async () => {
  const page = virtualizedConversationPage([
    { role: 'user', text: 'First turn' },
    { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Second turn' },
    { role: 'assistant', text: 'Second reply' }
  ], { initialStart: 2, loadDelayMs: 400, scrollerMovable: false });
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 500 });

  assert.equal(result.text, 'User\nFirst turn\n\nAssistant\nFirst reply\n\nUser\nSecond turn\n\nAssistant\nSecond reply');
  assert.equal(result.complete, true);
  assert.equal(result.messageCount, 4);
});

test('chatgpt-controller: no-scroller capture proves and stitches the trailing boundary separately', async () => {
  const messages = [
    { role: 'user', text: 'Initially visible prompt' },
    { role: 'assistant', text: 'Initially visible reply' },
    { role: 'user', text: 'Initially hidden prompt' },
    { role: 'assistant', text: 'Initially hidden reply' }
  ];
  const page = virtualizedConversationPage(messages, {
    initialEnd: 2,
    initialScrollTop: 0,
    scrollerMovable: false
  });
  const controller = new ChatGPTController({ page, selectors: {} });

  const capture = await controller.captureConversation({ maxCaptureBytes: 10_000 });

  assert.equal(capture.status, 'complete');
  assert.equal(capture.evidence.topBoundary, true);
  assert.equal(capture.evidence.bottomBoundary, true);
  assert.deepEqual(capture.rawTurns.map(({ text }) => text), messages.map(({ text }) => text));
});

test('chatgpt-controller: readConversationText reports a missing leading user turn', async () => {
  const page = virtualizedConversationPage([
    { role: 'assistant', text: 'Reply without its prompt' },
    { role: 'user', text: 'Later turn' }
  ]);
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 500 });

  assert.equal(result.text, 'Assistant\nReply without its prompt\n\nUser\nLater turn');
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'leading_turn_missing');
  assert.equal(result.messageCount, 2);
  assert.ok(result.scrollPasses > 1);
});

test('chatgpt-controller: readConversationText preserves max_chars over the leading-role safety net', async () => {
  const page = virtualizedConversationPage([
    { role: 'assistant', text: 'Reply without its prompt' }
  ]);
  const controller = new ChatGPTController({ page, selectors: {} });

  const result = await controller.readConversationText({ maxChars: 10 });

  assert.equal(result.text, 'Assistant\n');
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, 'max_chars');
  assert.equal(result.messageCount, 1);
});

test('chatgpt-controller: legacy projection preserves the pre-V0 top-capture timeout reason', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Top timeout turn ${index}`
  }));
  const makePage = () => {
    let clockReads = 0;
    return slidingConversationPage(messages, {
      initialStart: 4,
      performanceNow: () => clockReads++ === 0 ? 0 : 15_000
    });
  };

  const legacy = await new ChatGPTController({ page: makePage(), selectors: {} })
    .readConversationText({ maxChars: 5_000 });
  const structured = await new ChatGPTController({ page: makePage(), selectors: {} })
    .captureConversation({ maxCaptureBytes: 25_000 });

  assert.equal(legacy.reason, 'conversation_top_capture_timeout');
  assert.equal(legacy.complete, false);
  assert.equal(structured.status, 'partial');
  assert.equal(structured.reason, 'conversation_capture_timeout');
  assert.equal(Object.hasOwn(structured, 'legacyDiagnosticReason'), false);
});

test('chatgpt-controller: legacy projection preserves the pre-V0 top-scroll stall reason', async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Top stall turn ${index}`
  }));
  const makePage = () => {
    let scrollWrites = 0;
    return slidingConversationPage(messages, {
      initialStart: 4,
      scrollTopForRequest: ({ requested, previous }) => {
        scrollWrites += 1;
        return scrollWrites <= 2 ? requested : previous;
      }
    });
  };

  const legacy = await new ChatGPTController({ page: makePage(), selectors: {} })
    .readConversationText({ maxChars: 5_000 });
  const structured = await new ChatGPTController({ page: makePage(), selectors: {} })
    .captureConversation({ maxCaptureBytes: 25_000 });

  assert.equal(legacy.reason, 'conversation_top_scroll_stalled');
  assert.equal(legacy.complete, false);
  assert.equal(structured.status, 'partial');
  assert.equal(structured.reason, 'conversation_scroll_stalled');
  assert.equal(Object.hasOwn(structured, 'legacyDiagnosticReason'), false);
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
