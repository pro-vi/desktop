import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ChromeCdpBrowserBackend, ChromeCdpConnection } from '../chrome-cdp-backend.mjs';

class MockWebSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.#emit('open', {}));
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

class DelayedMockWebSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler, opts = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: !!opts?.once });
    this.listeners.set(type, list);
  }

  send(_payload) {}

  close() {
    queueMicrotask(() => this.#emit('close', {}));
  }

  open() {
    queueMicrotask(() => this.#emit('open', {}));
  }

  #emit(type, event) {
    const list = [...(this.listeners.get(type) || [])];
    for (const item of list) {
      try {
        item.handler(event);
      } catch {}
    }
    const keep = (this.listeners.get(type) || []).filter((item) => !item.once);
    if (keep.length) this.listeners.set(type, keep);
    else this.listeners.delete(type);
  }
}

async function createDownloadTestPage() {
  const calls = [];
  const listeners = new Map();
  const client = {
    connected: true,
    ws: {},
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-download' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-download' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      return {};
    },
    on(method, handler) {
      const handlers = listeners.get(method) || [];
      handlers.push(handler);
      listeners.set(method, handlers);
      return () => {
        listeners.set(method, (listeners.get(method) || []).filter((candidate) => candidate !== handler));
      };
    }
  };
  const emit = (method, params) => {
    for (const handler of listeners.get(method) || []) handler(params);
  };
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-download-test' });
  backend.started = true;
  backend.client = client;
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  return { page: session.page, calls, listeners, emit };
}

test('chrome-cdp-backend: pending commands reject when websocket closes', async () => {
  const ws = new MockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  await conn.connect();
  const pending = conn.send('Runtime.evaluate', { expression: '1+1' });
  ws.close();

  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: connect rejects if websocket closes before open', async () => {
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ({
      addEventListener(type, handler) {
        if (type === 'close') queueMicrotask(() => handler({}));
      },
      close() {}
    })
  });

  await assert.rejects(async () => await conn.connect(), /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: async connect error clears stale websocket before retry', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) {
        return {
          addEventListener(type, handler) {
            if (type === 'error') queueMicrotask(() => handler(new Error('ws_async_failed')));
          },
          close() {}
        };
      }
      return new MockWebSocket();
    }
  });

  await assert.rejects(async () => await conn.connect(), /ws_async_failed/);
  assert.equal(conn.ws, null);
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: concurrent connect calls share one websocket', async () => {
  let created = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      created += 1;
      return new MockWebSocket();
    }
  });

  await Promise.all([conn.connect(), conn.connect(), conn.connect()]);
  assert.equal(created, 1);
});

test('chrome-cdp-backend: synchronous websocket constructor failure does not poison future retries', async () => {
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) throw new Error('ws_ctor_failed');
      return new MockWebSocket();
    }
  });

  await (async () => {
    try {
      await conn.connect();
      assert.fail('expected first connect to fail');
    } catch (error) {
      assert.match(String(error?.message || error), /ws_ctor_failed/);
    }
  })();
  await conn.connect();
  assert.equal(calls, 2);
});

test('chrome-cdp-backend: close cancels an in-flight connect before open', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
});

test('chrome-cdp-backend: late open after cancel does not resurrect connection state', async () => {
  const ws = new DelayedMockWebSocket();
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => ws
  });

  const pending = conn.connect();
  await conn.close();
  ws.open();
  await assert.rejects(async () => await pending, /chrome_cdp_disconnected/);
  assert.equal(conn.connected, false);
  assert.equal(conn.ws, null);
});

test('chrome-cdp-backend: beginDownloadCapture waits for CDP setup before declaring readiness', async (t) => {
  const { page, calls, listeners, emit } = await createDownloadTestPage();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-capture-'));
  t.after(async () => await fs.rm(outDir, { recursive: true, force: true }));

  const capture = page.beginDownloadCapture({ outDir, timeoutMs: 2_000, maxBytes: 1_024 });

  assert.equal(await capture.ready, true);
  assert.equal(calls.some(({ method }) => method === 'Browser.setDownloadBehavior'), true);
  assert.equal(listeners.get('Browser.downloadWillBegin')?.length, 1);
  assert.equal(listeners.get('Browser.downloadProgress')?.length, 1);
  emit('Browser.downloadWillBegin', {
    guid: 'download-1',
    suggestedFilename: 'report.md',
    url: 'https://chatgpt.com/signed'
  });
  await fs.writeFile(path.join(outDir, 'report.md'), '# report\n', 'utf8');
  emit('Browser.downloadProgress', { guid: 'download-1', state: 'completed', receivedBytes: 9 });
  const outcome = await capture.outcome;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.name, 'report.md');
});

test('chrome-cdp-backend: beginDownloadCapture cancels oversized files and removes partial output', async (t) => {
  const { page, calls, emit } = await createDownloadTestPage();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-capture-limit-'));
  t.after(async () => await fs.rm(outDir, { recursive: true, force: true }));

  const capture = page.beginDownloadCapture({ outDir, timeoutMs: 2_000, maxBytes: 8 });
  assert.equal(await capture.ready, true);
  emit('Browser.downloadWillBegin', {
    guid: 'download-2',
    suggestedFilename: 'large.bin',
    url: 'https://chatgpt.com/signed'
  });
  const partialPath = path.join(outDir, 'large.bin.crdownload');
  await fs.writeFile(partialPath, 'too many bytes', 'utf8');
  emit('Browser.downloadProgress', { guid: 'download-2', state: 'inProgress', receivedBytes: 9 });

  assert.deepEqual(await capture.outcome, { status: 'size_limit_exceeded', maxBytes: 8 });
  assert.equal(calls.some(({ method, params }) =>
    method === 'Browser.cancelDownload' && params.guid === 'download-2'), true);
  await assert.rejects(fs.access(partialPath));
});

test('chrome-cdp-backend: stale socket close does not tear down a newer healthy connection', async () => {
  const first = new DelayedMockWebSocket();
  let second = null;
  let calls = 0;
  const conn = new ChromeCdpConnection('ws://example.test/devtools/browser/1', {
    wsFactory: () => {
      calls += 1;
      if (calls === 1) return first;
      second = new MockWebSocket();
      return second;
    }
  });

  const pendingFirst = conn.connect();
  await conn.close();
  await assert.rejects(async () => await pendingFirst, /chrome_cdp_disconnected/);

  await conn.connect();
  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);

  first.close();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(conn.connected, true);
  assert.equal(conn.ws, second);
});

test('chrome-cdp-backend: createSession closes target if initialization fails', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.enable') throw new Error('page_enable_failed');
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    }
  };

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /page_enable_failed/
  );

  assert.equal(calls.some((item) => item.method === 'Target.closeTarget' && item.params?.targetId === 'target-1'), true);
});

test('chrome-cdp-backend: terminateEvaluation stops the owned renderer session', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });

  assert.equal(await session.page.terminateEvaluation(), true);
  assert.equal(calls.some((item) =>
    item.method === 'Runtime.terminateExecution' && item.sessionId === 'session-1'), true);
});

test('chrome-cdp-backend: mouse input carries the pressed-button bitmask through mouseDown', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  calls.length = 0;

  await session.page.moveMouse(10, 20);
  await session.page.mouseDown(10, 20, { button: 'left', clickCount: 1 });
  await session.page.mouseUp(10, 20, { button: 'left', clickCount: 1 });

  assert.deepEqual(calls, [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0 },
      sessionId: 'session-1'
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
      sessionId: 'session-1'
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 },
      sessionId: 'session-1'
    }
  ]);
});

test('chrome-cdp-backend: evaluateDeepResearch attaches to the observed hyphenated child target', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-root' };
      if (method === 'Target.attachToTarget' && params.targetId === 'target-root') return { sessionId: 'session-root' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'DOM.getDocument' && sessionId === 'session-root') return { root: { nodeId: 11 } };
      if (method === 'DOM.querySelectorAll' && sessionId === 'session-root') return { nodeIds: [21] };
      if (method === 'DOM.describeNode' && sessionId === 'session-root') return { node: { frameId: 'deep-target' } };
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            {
              targetId: 'deep-other',
              parentId: null,
              url: 'https://connector-openai-deep-research.web-sandbox.oaiusercontent.com/?app=chatgpt'
            },
            {
              targetId: 'deep-target',
              parentId: null,
              url: 'https://connector-openai-deep-research.web-sandbox.oaiusercontent.com/?app=chatgpt'
            }
          ]
        };
      }
      if (method === 'Target.attachToTarget' && params.targetId === 'deep-target') return { sessionId: 'deep-session' };
      if (method === 'Runtime.evaluate' && sessionId === 'deep-session') {
        assert.equal(params.expression, '(() => "nested report")()');
        return { result: { value: 'nested report' } };
      }
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });

  const result = await session.page.evaluateDeepResearch('(() => "nested report")()');

  assert.equal(result, 'nested report');
  assert.equal(calls.some((item) =>
    item.method === 'Target.attachToTarget' && item.params?.targetId === 'deep-target'), true);
  assert.equal(calls.some((item) =>
    item.method === 'Target.detachFromTarget' && item.params?.sessionId === 'deep-session'), true);
});

test('chrome-cdp-backend: failed evaluation termination never closes the shared target', async () => {
  const calls = [];
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Runtime.terminateExecution') throw new Error('termination_failed');
      return {};
    }
  };
  const session = await backend.createSession({ url: 'https://chatgpt.com/' });

  assert.equal(await session.page.terminateEvaluation(), false);
  assert.equal(calls.some((item) => item.method === 'Target.closeTarget'), false);
  assert.equal(session.page.isClosed(), false);
});

test('chrome-cdp-backend: navigation guard remembers a same-document route mismatch after returning', async () => {
  const routeA = 'https://chatgpt.com/c/route-a';
  const routeB = 'https://chatgpt.com/c/route-b';
  const listeners = new Map();
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    on(method, handler) {
      const values = listeners.get(method) || [];
      values.push(handler);
      listeners.set(method, values);
      return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== handler));
    },
    send: async (method) => {
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-1', url: routeA } } };
      }
      return {};
    }
  };
  const session = await backend.createSession({ url: routeA });

  const guard = await session.page.beginNavigationGuard((url) => url === routeA);
  for (const handler of listeners.get('Page.navigatedWithinDocument') || []) {
    handler({ frameId: 'frame-1', url: routeB }, 'session-1');
    handler({ frameId: 'frame-1', url: routeA }, 'session-1');
  }

  assert.equal(guard.isStable(), false);
  await guard.dispose();
  assert.equal(listeners.get('Page.navigatedWithinDocument')?.length || 0, 0);
});

test('chrome-cdp-backend: session close is best-effort when closeTarget fails', async () => {
  let closedCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: true,
    ws: {},
    send: async (method, params = {}, sessionId) => {
      void params;
      void sessionId;
      if (method === 'Target.createTarget') return { targetId: 'target-1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      if (method === 'Target.closeTarget') throw new Error('chrome_cdp_disconnected');
      return {};
    }
  };

  const session = await backend.createSession({
    url: 'https://chatgpt.com/',
    onClosed: () => {
      closedCalls += 1;
    }
  });

  await session.close();
  assert.equal(session.isClosed(), true);
  assert.equal(closedCalls, 1);
});

test('chrome-cdp-backend: start cleans up spawned chrome process when CDP connect fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chrome-start-fail-'));
  const scriptPath = path.join(tmpDir, 'fake-chrome.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\nsleep 30\n', { encoding: 'utf8', mode: 0o755 });

  const backend = new ChromeCdpBrowserBackend({
    stateDir: tmpDir,
    executablePath: scriptPath,
    debugPort: 45999
  });

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45999/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {
      queueMicrotask(() => {
        this._error?.(new Error('ws_connect_failed'));
      });
    }
    addEventListener(type, handler) {
      if (type === 'error') this._error = handler;
    }
    close() {}
  };

  try {
    await assert.rejects(async () => await backend.start(), /ws_connect_failed/);
    assert.equal(backend.client, null);
    assert.equal(backend.started, false);
    assert.equal(backend.chromeProcess, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('chrome-cdp-backend: dispose resets started state and clears stale tab closers', async () => {
  let clientClosed = 0;
  let processKilled = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    close: async () => {
      clientClosed += 1;
    }
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {
      processKilled += 1;
    }
  };
  backend.tabClosers.set('tab-1', () => {});
  backend.boundTargetDestroyed = () => {};

  await backend.dispose();

  assert.equal(clientClosed, 1);
  assert.equal(processKilled, 1);
  assert.equal(backend.started, false);
  assert.equal(backend.tabClosers.size, 0);
  assert.equal(backend.client, null);
  assert.equal(backend.chromeProcess, null);
  assert.equal(backend.boundTargetDestroyed, null);
});

test('chrome-cdp-backend: start does not reuse a disconnected client as healthy state', async () => {
  let connectCalls = 0;
  const backend = new ChromeCdpBrowserBackend({ stateDir: '/tmp/agentify-test-state' });
  backend.started = true;
  backend.client = {
    connected: false,
    ws: null,
    close: async () => {}
  };
  backend.chromeProcess = {
    killed: false,
    kill: () => {}
  };
  backend.boundTargetDestroyed = () => {};

  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) throw new Error('port_not_in_use');
    return {
      ok: true,
      async json() {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:45998/devtools/browser/test' };
      }
    };
  };
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener(type, handler) {
      if (type === 'open') {
        connectCalls += 1;
        queueMicrotask(() => handler({}));
      }
    }
    close() {}
  };

  try {
    await backend.start();
    assert.equal(connectCalls, 1);
    assert.equal(backend.started, true);
    assert.equal(backend.client?.connected, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
    await backend.dispose();
  }
});
