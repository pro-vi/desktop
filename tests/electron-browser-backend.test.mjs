import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ElectronBrowserBackend } from '../electron-browser-backend.mjs';

class MockBrowserWindow {
  constructor() {
    this.destroyed = false;
    this.closed = false;
    this.minimized = false;
    this.debuggerAttached = false;
    this.listeners = new Map();
    this.webContentsListeners = new Map();
    this.sessionListeners = new Map();
    this.webContents = {
      isDestroyed: () => this.destroyed,
      setUserAgent: () => {},
      insertText: async () => {},
      executeJavaScript: async () => null,
      getURL: () => 'https://chatgpt.com/',
      debugger: {
        isAttached: () => this.debuggerAttached,
        attach: () => {
          this.debuggerAttached = true;
        },
        detach: () => {
          this.debuggerAttached = false;
        },
        sendCommand: async () => ({})
      },
      session: {
        on: (event, handler) => {
          const list = this.sessionListeners.get(event) || [];
          list.push(handler);
          this.sessionListeners.set(event, list);
        },
        removeListener: (event, handler) => {
          const list = this.sessionListeners.get(event) || [];
          this.sessionListeners.set(event, list.filter((item) => item !== handler));
        }
      },
      on: (event, handler) => {
        const list = this.webContentsListeners.get(event) || [];
        list.push(handler);
        this.webContentsListeners.set(event, list);
      },
      setWindowOpenHandler: () => {}
    };
  }

  on(event, handler) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  async loadURL() {
    throw new Error('load_failed');
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }

  close() {
    const closeHandlers = this.listeners.get('close') || [];
    let prevented = false;
    const event = {
      preventDefault() {
        prevented = true;
      }
    };
    for (const handler of closeHandlers) handler(event);
    if (prevented) return;
    this.closed = true;
    this.destroyed = true;
    const closedHandlers = this.listeners.get('closed') || [];
    for (const handler of closedHandlers) handler();
  }

  isMinimized() {
    return this.minimized;
  }

  minimize() {
    this.minimized = true;
  }

  setTitle() {}

  emitWebContents(event, ...args) {
    const handlers = this.webContentsListeners.get(event) || [];
    for (const handler of handlers) handler(...args);
  }

  emitSession(event, ...args) {
    const handlers = this.sessionListeners.get(event) || [];
    for (const handler of handlers) handler(...args);
  }
}

class MockDownloadItem {
  constructor({ filename = 'report.md', mime = 'text/markdown', url = 'https://chatgpt.com/report.md' } = {}) {
    this.filename = filename;
    this.mime = mime;
    this.url = url;
    this.doneHandlers = [];
    this.savePath = null;
  }

  getFilename() {
    return this.filename;
  }

  getMimeType() {
    return this.mime;
  }

  getURL() {
    return this.url;
  }

  setSavePath(filePath) {
    this.savePath = filePath;
  }

  once(event, handler) {
    if (event === 'done') this.doneHandlers.push(handler);
  }

  emitDone(state = 'completed') {
    for (const handler of this.doneHandlers.splice(0)) handler({}, state);
  }
}

test('electron-browser-backend: createSession destroys window if loadURL fails', async () => {
  let createdWindow = null;
  class TestBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: TestBrowserWindow
  });

  await assert.rejects(
    async () => await backend.createSession({ url: 'https://chatgpt.com/' }),
    /load_failed/
  );
  assert.equal(createdWindow?.destroyed, true);
});

test('electron-browser-backend: dispose closes tracked windows', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }

    isMinimized() {
      return false;
    }

    minimize() {}
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  await backend.createSession({ url: 'https://claude.ai/' });
  assert.equal(created.length, 2);

  await backend.dispose();

  assert.equal(created.every((win) => win.closed), true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: session.close closes protected tabs instead of minimizing them', async () => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/', protectedTab: true });
  await session.close();

  assert.equal(createdWindow?.closed, true);
  assert.equal(createdWindow?.destroyed, true);
  assert.equal(createdWindow?.minimized, false);
});

test('electron-browser-backend: dispose closes tracked auth popup child windows too', async () => {
  const created = [];
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      created.push(this);
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  await backend.createSession({ url: 'https://chatgpt.com/' });
  const parent = created[0];
  const child = new OkBrowserWindow();
  parent.emitWebContents('did-create-window', child);

  await backend.dispose();

  assert.equal(parent.closed, true);
  assert.equal(child.closed, true);
  assert.equal(backend.windows.size, 0);
});

test('electron-browser-backend: insertText uses native webContents.insertText when available', async () => {
  let inserted = '';
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      this.webContents.insertText = async (value) => {
        inserted += value;
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  await session.page.insertText('hello');

  assert.equal(inserted, 'hello');
});

test('electron-browser-backend: waitForDownload resolves completed will-download items', async (t) => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-electron-download-'));
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const pending = session.page.waitForDownload({ outDir, timeoutMs: 2_000 });
  const item = new MockDownloadItem();
  createdWindow.emitSession('will-download', {}, item, createdWindow.webContents);
  await new Promise((resolve) => setTimeout(resolve, 0));
  item.emitDone('completed');

  const file = await pending;
  assert.ok(file);
  assert.equal(path.basename(file.path), 'report.md');
  assert.equal(item.savePath, file.path);
});

test('electron-browser-backend: waitForDownload reserves a suffixed filename when the target already exists', async (t) => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-electron-download-collision-'));
  const existingPath = path.join(outDir, 'report.md');
  await fs.writeFile(existingPath, '# existing\n', 'utf8');
  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(existingPath, oldTime, oldTime);
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const pending = session.page.waitForDownload({ outDir, timeoutMs: 2_000 });
  const item = new MockDownloadItem();
  createdWindow.emitSession('will-download', {}, item, createdWindow.webContents);
  await new Promise((resolve) => setTimeout(resolve, 0));
  item.emitDone('completed');

  const file = await pending;
  assert.ok(file);
  assert.equal(path.basename(file.path), 'report-1.md');
  assert.equal(item.savePath, file.path);
});

test('electron-browser-backend: waitForDownload falls back to the newest matching file when Electron ignores the reserved suffix', async (t) => {
  let createdWindow = null;
  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-electron-download-recover-'));
  const existingPath = path.join(outDir, 'report.md');
  await fs.writeFile(existingPath, '# existing\n', 'utf8');
  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(existingPath, oldTime, oldTime);
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
  });

  const pending = session.page.waitForDownload({ outDir, timeoutMs: 2_000 });
  const item = new MockDownloadItem();
  createdWindow.emitSession('will-download', {}, item, createdWindow.webContents);
  await fs.writeFile(existingPath, '# refreshed\n', 'utf8');
  item.emitDone('completed');

  const file = await pending;
  assert.ok(file);
  assert.equal(path.basename(file.path), 'report.md');
  assert.equal(item.savePath, path.join(outDir, 'report-1.md'));
});

test('electron-browser-backend: setFileInputFiles uses one debugger session and detaches after dispatching change events', async () => {
  let createdWindow = null;
  const calls = [];

  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
      this.webContents.debugger = {
        isAttached: () => this.debuggerAttached,
        attach: (version) => {
          calls.push({ method: 'debugger.attach', version });
          this.debuggerAttached = true;
        },
        detach: () => {
          calls.push({ method: 'debugger.detach' });
          this.debuggerAttached = false;
        },
        sendCommand: async (method, params = {}, sessionId) => {
          calls.push({ method, params, sessionId });
          if (method === 'DOM.getDocument') return { root: { nodeId: 11 } };
          if (method === 'DOM.querySelectorAll') return { nodeIds: [21] };
          if (method === 'DOM.setFileInputFiles') return {};
          if (method === 'DOM.resolveNode') return { object: { objectId: 'node-21' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: null } };
          throw new Error(`unexpected_command:${method}`);
        }
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  await session.page.setFileInputFiles(['/tmp/report.md']);

  assert.equal(createdWindow?.debuggerAttached, false);
  assert.equal(calls.some((item) => item.method === 'DOM.setFileInputFiles' && item.params?.nodeId === 21), true);
  assert.equal(calls.some((item) => item.method === 'Runtime.callFunctionOn' && item.params?.objectId === 'node-21'), true);
  assert.equal(calls.filter((item) => item.method === 'debugger.attach').length, 1);
  assert.equal(calls.filter((item) => item.method === 'debugger.detach').length, 1);
});

test('electron-browser-backend: evaluateDeepResearch prefers the child target for the active window', async () => {
  let createdWindow = null;
  const calls = [];

  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
      this.webContents.debugger = {
        isAttached: () => this.debuggerAttached,
        attach: (version) => {
          calls.push({ method: 'debugger.attach', version });
          this.debuggerAttached = true;
        },
        detach: () => {
          calls.push({ method: 'debugger.detach' });
          this.debuggerAttached = false;
        },
        sendCommand: async (method, params = {}, sessionId) => {
          calls.push({ method, params, sessionId });
          if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-root' } };
          if (method === 'Target.getTargets') {
            return {
              targetInfos: [
                {
                  targetId: 'deep-other',
                  parentId: 'other-root',
                  url: 'https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/?app=chatgpt'
                },
                {
                  targetId: 'deep-here',
                  parentId: 'target-root',
                  url: 'https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/?app=chatgpt'
                }
              ]
            };
          }
          if (method === 'Target.attachToTarget') return { sessionId: 'deep-session' };
          if (method === 'Page.enable') return {};
          if (method === 'Runtime.enable') return {};
          if (method === 'Runtime.evaluate') {
            assert.equal(sessionId, 'deep-session');
            assert.equal(params.expression, '(() => "nested report")()');
            return { result: { value: 'nested report' } };
          }
          if (method === 'Target.detachFromTarget') return {};
          throw new Error(`unexpected_command:${method}`);
        }
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const result = await session.page.evaluateDeepResearch('(() => "nested report")()');

  assert.equal(result, 'nested report');
  assert.equal(createdWindow?.debuggerAttached, false);
  assert.equal(calls.some((item) => item.method === 'Target.attachToTarget' && item.params?.targetId === 'deep-here'), true);
  assert.equal(calls.some((item) => item.method === 'Target.detachFromTarget' && item.params?.sessionId === 'deep-session'), true);
});

test('electron-browser-backend: evaluateDeepResearch falls back to the only matching target when parentId is absent', async () => {
  let createdWindow = null;
  const calls = [];

  class OkBrowserWindow extends MockBrowserWindow {
    constructor(...args) {
      super(...args);
      createdWindow = this;
      this.webContents.debugger = {
        isAttached: () => this.debuggerAttached,
        attach: () => {
          calls.push({ method: 'debugger.attach' });
          this.debuggerAttached = true;
        },
        detach: () => {
          calls.push({ method: 'debugger.detach' });
          this.debuggerAttached = false;
        },
        sendCommand: async (method, params = {}, sessionId) => {
          calls.push({ method, params, sessionId });
          if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-root' } };
          if (method === 'Target.getTargets') {
            return {
              targetInfos: [
                {
                  targetId: 'deep-only',
                  parentId: null,
                  url: 'https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/?app=chatgpt'
                }
              ]
            };
          }
          if (method === 'Target.attachToTarget') return { sessionId: 'deep-session' };
          if (method === 'Page.enable') return {};
          if (method === 'Runtime.enable') return {};
          if (method === 'Runtime.evaluate') {
            assert.equal(sessionId, 'deep-session');
            return { result: { value: { ok: true } } };
          }
          if (method === 'Target.detachFromTarget') return {};
          throw new Error(`unexpected_command:${method}`);
        }
      };
    }

    async loadURL() {
      return true;
    }
  }

  const backend = new ElectronBrowserBackend({
    BrowserWindowClass: OkBrowserWindow
  });

  const session = await backend.createSession({ url: 'https://chatgpt.com/' });
  const result = await session.page.evaluateDeepResearch('({ ok: true })');

  assert.deepEqual(result, { ok: true });
  assert.equal(createdWindow?.debuggerAttached, false);
  assert.equal(calls.some((item) => item.method === 'Target.attachToTarget' && item.params?.targetId === 'deep-only'), true);
});
