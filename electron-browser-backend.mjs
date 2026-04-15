import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';

const { BrowserWindow } = electron;

function trackWindow(windows, win) {
  if (!win) return;
  windows.add(win);
  try {
    win.on('closed', () => {
      windows.delete(win);
    });
  } catch {}
}

class ElectronPageAdapter {
  constructor(win) {
    this.win = win;
  }

  async #withDebugger(fn, { attachErrorMessage = null, attachErrorData = null } = {}) {
    const wc = this.win?.webContents;
    if (!wc?.debugger) {
      if (attachErrorMessage) {
        const err = new Error(attachErrorMessage);
        err.data = attachErrorData || null;
        throw err;
      }
      return null;
    }

    const didAttach = !wc.debugger.isAttached();
    try {
      if (didAttach) wc.debugger.attach('1.3');
    } catch {
      if (attachErrorMessage) {
        const err = new Error(attachErrorMessage);
        err.data = attachErrorData || null;
        throw err;
      }
      return null;
    }

    try {
      return await fn(wc.debugger);
    } finally {
      try {
        if (didAttach && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {}
    }
  }

  async #sendDebuggerCommand(method, params = {}, sessionId = null) {
    return await this.win.webContents.debugger.sendCommand(method, params, sessionId || undefined);
  }

  async #withDeepResearchTarget(fn) {
    return await this.#withDebugger(async () => {
      const current = await this.#sendDebuggerCommand('Target.getTargetInfo').catch(() => null);
      const currentTargetId = String(current?.targetInfo?.targetId || '').trim();
      const targets = await this.#sendDebuggerCommand('Target.getTargets').catch(() => null);
      const matches = (targets?.targetInfos || []).filter((target) =>
        /connector_openai_deep_research\.web-sandbox\.oaiusercontent\.com/i.test(String(target?.url || ''))
      );
      const info = matches.find((target) => String(target?.parentId || '').trim() === currentTargetId)
        || (matches.length === 1 ? matches[0] : null);
      const targetId = String(info?.targetId || '').trim();
      if (!targetId) return null;

      const attach = await this.#sendDebuggerCommand('Target.attachToTarget', { targetId, flatten: true }).catch(() => null);
      const childSessionId = String(attach?.sessionId || '').trim();
      if (!childSessionId) return null;
      try {
        await this.#sendDebuggerCommand('Page.enable', {}, childSessionId).catch(() => {});
        await this.#sendDebuggerCommand('Runtime.enable', {}, childSessionId).catch(() => {});
        return await fn(childSessionId, info);
      } finally {
        await this.#sendDebuggerCommand('Target.detachFromTarget', { sessionId: childSessionId }).catch(() => {});
      }
    });
  }

  isClosed() {
    return this.win?.isDestroyed?.() || this.win?.webContents?.isDestroyed?.();
  }

  async navigate(url) {
    await this.win.loadURL(url);
  }

  async evaluate(js) {
    return await this.win.webContents.executeJavaScript(js, true);
  }

  async evaluateDeepResearch(js) {
    return await this.#withDeepResearchTarget(async (childSessionId) => {
      const result = await this.#sendDebuggerCommand(
        'Runtime.evaluate',
        {
          expression: String(js || ''),
          awaitPromise: true,
          returnByValue: true
        },
        childSessionId
      );
      return result?.result?.value;
    });
  }

  async getUrl() {
    return this.win.webContents.getURL();
  }

  async sendKey(key, { modifiers = [] } = {}) {
    const wc = this.win.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    const hasCommandModifier = Array.isArray(modifiers) && modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    if (typeof key === 'string' && key.length === 1 && !hasCommandModifier) {
      wc.sendInputEvent({ type: 'char', keyCode: key, modifiers });
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  async insertText(text) {
    const value = String(text || '');
    if (!value) return;
    if (typeof this.win?.webContents?.insertText === 'function') {
      await this.win.webContents.insertText(value);
      return;
    }
    this.win.webContents.sendInputEvent({ type: 'char', keyCode: value });
  }

  async moveMouse(x, y) {
    this.win.webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  }

  async mouseDown(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
  }

  async mouseUp(x, y, { button = 'left', clickCount = 1 } = {}) {
    this.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  }

  async setFileInputFiles(files) {
    return await this.#withDebugger(async () => {
      let lastNodeIds = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const { root } = await this.#sendDebuggerCommand('DOM.getDocument', { depth: 12, pierce: true });
        const q = await this.#sendDebuggerCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
        const nodeIds = Array.isArray(q?.nodeIds) ? q.nodeIds : [];
        lastNodeIds = nodeIds;
        if (!nodeIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }

        let lastErr = null;
        for (const nodeId of [...nodeIds].reverse()) {
          try {
            await this.#sendDebuggerCommand('DOM.setFileInputFiles', { nodeId, files });
            // Dispatch change event to trigger React's synthetic event handlers.
            // CDP setFileInputFiles may not always fire the event that React listens for.
            try {
              const { object } = await this.#sendDebuggerCommand('DOM.resolveNode', { nodeId });
              if (object?.objectId) {
                await this.#sendDebuggerCommand('Runtime.callFunctionOn', {
                  objectId: object.objectId,
                  functionDeclaration: `function() {
                    const ev = new Event('change', { bubbles: true });
                    this.dispatchEvent(ev);
                    const inputEv = new Event('input', { bubbles: true });
                    this.dispatchEvent(inputEv);
                  }`,
                  returnByValue: true
                });
              }
            } catch {}
            lastErr = null;
            break;
          } catch (error) {
            lastErr = error;
          }
        }
        if (!lastErr) return;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }

      const err = new Error('missing_file_input');
      err.data = { selector: 'input[type=file]', found: lastNodeIds.length };
      throw err;
    }, {
      attachErrorMessage: 'file_upload_unavailable',
      attachErrorData: { reason: 'debugger_attach_failed' }
    });
  }

  async waitForDownload({ timeoutMs = 15_000, outDir } = {}) {
    const wc = this.win?.webContents;
    const session = wc?.session;
    const targetDir = String(outDir || '').trim();
    if (!session || !targetDir) return null;

    return await new Promise((resolve) => {
      const waitStartedAt = Date.now();
      let settled = false;
      let timer = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          session.removeListener?.('will-download', onDownload);
        } catch {}
        resolve(value || null);
      };

      const onDownload = (event, item, sourceWebContents) => {
        if (!item) return;
        if (sourceWebContents && wc && sourceWebContents !== wc) return;

        const rawName = String(item.getFilename?.() || '').trim() || `download-${Date.now()}`;
        const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '-');
        const parsed = path.parse(safeName);
        const downloadStartedAt = Date.now();
        let finalName = safeName;
        let filePath = path.join(targetDir, finalName);
        const reserve = () => {
          try {
            fsSync.mkdirSync(targetDir, { recursive: true });
          } catch {}
          if (!fsSync.existsSync(filePath)) return;
          for (let suffix = 1; suffix < 1000; suffix++) {
            finalName = `${parsed.name}-${suffix}${parsed.ext}`;
            filePath = path.join(targetDir, finalName);
            if (!fsSync.existsSync(filePath)) return;
          }
        };
        const findCompletedPath = () => {
          if (fsSync.existsSync(filePath)) return filePath;
          const candidates = [];
          try {
            const rows = fsSync.readdirSync(targetDir, { withFileTypes: true });
            for (const row of rows) {
              if (!row?.isFile?.()) continue;
              const candidatePath = path.join(targetDir, row.name);
              const candidateParsed = path.parse(row.name);
              if (candidateParsed.ext !== parsed.ext) continue;
              if (candidateParsed.name !== parsed.name && !candidateParsed.name.startsWith(`${parsed.name}-`)) continue;
              const stat = fsSync.statSync(candidatePath);
              if (!stat.isFile()) continue;
              if (Number(stat.mtimeMs || 0) < Math.min(downloadStartedAt, waitStartedAt) - 2_000) continue;
              candidates.push({ path: candidatePath, mtimeMs: Number(stat.mtimeMs || 0) });
            }
          } catch {}
          candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return candidates[0]?.path || null;
        };

        const done = (_event, state) => {
          if (String(state || '') !== 'completed') {
            finish(null);
            return;
          }
          void (async () => {
            const deadline = Date.now() + 500;
            let completedPath = findCompletedPath();
            while (!completedPath && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 80));
              completedPath = findCompletedPath();
            }
            const finalPath = completedPath || filePath;
            finish({
              path: finalPath,
              name: path.basename(finalPath),
              mime: typeof item.getMimeType === 'function' ? item.getMimeType() || null : null,
              source: typeof item.getURL === 'function' ? item.getURL() || null : null
            });
          })();
        };

        try {
          reserve();
          item.setSavePath?.(filePath);
          item.once?.('done', done);
        } catch {
          finish(null);
        }
      };

      try {
        session.on('will-download', onDownload);
      } catch {
        finish(null);
        return;
      }
      timer = setTimeout(() => finish(null), Math.max(1, Number(timeoutMs) || 0));
    });
  }
}

class ElectronPresenter {
  constructor(win) {
    this.win = win;
  }

  isClosed() {
    return this.win?.isDestroyed?.();
  }

  isMinimized() {
    return !!this.win?.isMinimized?.();
  }

  restore() {
    if (!this.isClosed()) this.win.restore();
  }

  show() {
    if (!this.isClosed()) this.win.show();
  }

  focus() {
    if (!this.isClosed()) this.win.focus();
  }

  minimize() {
    if (!this.isClosed()) this.win.minimize();
  }

  isVisible() {
    return !!this.win?.isVisible?.();
  }

  close() {
    if (!this.isClosed()) this.win.close();
  }
}

export class ElectronBrowserBackend {
  constructor({ windowDefaults, userAgent, popupPolicy, onChanged, BrowserWindowClass = BrowserWindow } = {}) {
    this.windowDefaults = windowDefaults || { width: 1100, height: 800, show: false, title: 'Agentify Desktop' };
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : null;
    this.popupPolicy = typeof popupPolicy === 'function' ? popupPolicy : (() => false);
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.BrowserWindowClass = BrowserWindowClass;
    this.quitting = false;
    this.windows = new Set();
  }

  async start() {
    return {
      kind: 'electron',
      managedProfile: true
    };
  }

  setQuitting(v = true) {
    this.quitting = !!v;
  }

  async createSession({
    url,
    show = false,
    protectedTab = false,
    vendorId = null,
    vendorName = null,
    onClosed
  } = {}) {
    let forceClose = false;
    const win = new this.BrowserWindowClass({
      ...this.windowDefaults,
      show: !!show,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...(this.windowDefaults.webPreferences || {})
      }
    });
    trackWindow(this.windows, win);
    if (this.userAgent) {
      try {
        win.webContents.setUserAgent(this.userAgent);
      } catch {}
    }
    win.webContents.on('did-create-window', (childWin) => {
      if (!childWin || childWin.isDestroyed?.()) return;
      trackWindow(this.windows, childWin);
      if (this.userAgent) {
        try {
          childWin.webContents.setUserAgent(this.userAgent);
        } catch {}
      }
    });
    win.webContents.setWindowOpenHandler((details) => {
      let openerUrl = '';
      try {
        openerUrl =
          String(details?.referrer?.url || '').trim() ||
          String(win.webContents.getURL?.() || '').trim() ||
          String(url || '').trim();
      } catch {
        openerUrl = String(url || '').trim();
      }
      const allow = !!this.popupPolicy({
        url: details?.url || '',
        frameName: details?.frameName || '',
        disposition: details?.disposition || '',
        openerUrl,
        vendorId: vendorId || 'chatgpt'
      });
      if (!allow) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          show: true,
          title: 'Agentify Desktop — Sign in',
          autoHideMenuBar: true,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            ...(this.windowDefaults.webPreferences || {})
          }
        }
      };
    });
    const fixedTitle = `Agentify Desktop${vendorName ? ` — ${vendorName}` : ''}`;
    try {
      win.setTitle(fixedTitle);
      win.on('page-title-updated', (event) => {
        try {
          event.preventDefault();
          win.setTitle(fixedTitle);
        } catch {}
      });
    } catch {}

    win.on('closed', () => {
      onClosed?.();
      this.onChanged?.();
    });
    win.on('close', (event) => {
      if (this.quitting) return;
      if (forceClose) return;
      if (!protectedTab) return;
      try {
        event.preventDefault();
        if (win.isMinimized()) return;
        win.minimize();
      } catch {}
    });

    try {
      await win.loadURL(url);
    } catch (error) {
      try {
        if (!win.isDestroyed?.()) win.destroy?.();
      } catch {}
      throw error;
    }
    this.onChanged?.();
    return {
      page: new ElectronPageAdapter(win),
      presenter: new ElectronPresenter(win),
      close: async () => {
        try {
          this.windows.delete(win);
          forceClose = true;
          win.close();
        } catch {}
      },
      isClosed: () => win.isDestroyed?.() || win.webContents?.isDestroyed?.()
    };
  }

  async dispose() {
    this.quitting = true;
    const wins = Array.from(this.windows);
    this.windows.clear();
    for (const win of wins) {
      try {
        if (!win?.isDestroyed?.()) {
          if (typeof win.close === 'function') win.close();
          else if (typeof win.destroy === 'function') win.destroy();
        }
      } catch {}
    }
  }
}
