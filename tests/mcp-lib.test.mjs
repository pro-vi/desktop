import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { ensureToken, writeState } from '../state.mjs';
import { ensureDesktopRunning, normalizeDesktopStatus, requestJson } from '../mcp-lib.mjs';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function tempDir() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-test-'));
  return base;
}

function makeFetch({ getServerId, acceptToken = 't' }) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, serverId: getServerId() };
        }
      };
    }
    if (u.endsWith('/status')) {
      const hdr = String(opts?.headers?.authorization || '');
      const okAuth = hdr === `Bearer ${acceptToken}`;
      return {
        ok: okAuth,
        status: okAuth ? 200 : 401,
        async json() {
          return okAuth ? { ok: true, url: 'https://chatgpt.com/', tabs: [] } : { error: 'unauthorized' };
        }
      };
    }
    throw new Error(`unexpected_url:${url}`);
  };
}

test('mcp-lib: requestJson throws with status and body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: 'forbidden', message: 'nope' };
    }
  });

  await assert.rejects(
    () => requestJson({ baseUrl: 'http://x', token: 't', method: 'GET', path: '/status', fetchImpl }),
    (err) => {
      assert.equal(err.message, 'nope');
      assert.equal(err.data.status, 403);
      assert.equal(err.data.body.error, 'forbidden');
      return true;
    }
  );
});

test('mcp-lib: status normalization fails unknown compatibility variants closed', () => {
  const normalized = normalizeDesktopStatus({ ok: true, compatibility: { schemaVersion: 999, verdict: 'ok' } });
  assert.equal(normalized.compatibility.verdict, 'incompatible');
  assert.equal(normalized.compatibility.apparatus.verdict, 'incomplete');
});

test('mcp-lib: ensureDesktopRunning uses existing connection when serverId matches', async () => {
  const dir = await tempDir();
  await ensureToken(dir);
  await writeState({ ok: true, port: 12345, serverId: 'sid-a' }, dir);

  const token = 't';
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');

  const conn = await ensureDesktopRunning({
    stateDir: dir,
    fetchImpl: makeFetch({ getServerId: () => 'sid-a', acceptToken: token }),
    spawnImpl: () => {
      throw new Error('should_not_spawn');
    },
    timeoutMs: 1000
  });
  assert.equal(conn.serverId, 'sid-a');
});

test('mcp-lib: ensureDesktopRunning spawns if serverId mismatches and then recovers', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');
  await writeState({ ok: true, port: 12345, serverId: 'sid-old' }, dir);

  let fetchServerId = 'sid-wrong';
  const fetchImpl = makeFetch({ getServerId: () => fetchServerId, acceptToken: token });

  let spawned = 0;
  const spawnImpl = (_cmd, _args, opts) => {
    spawned += 1;
    assert.equal(opts?.env?.AGENTIFY_DESKTOP_SHOW_TABS, 'true');
    assert.equal(opts?.detached, true);
    // Simulate that the spawned app writes a new state with matching serverId.
    fetchServerId = 'sid-new';
    void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
    return { unref() {} };
  };

  const conn = await ensureDesktopRunning({ stateDir: dir, fetchImpl, spawnImpl, timeoutMs: 3000, showTabs: true });
  assert.ok(spawned >= 1);
  assert.equal(conn.serverId, 'sid-new');
});

test('mcp-lib: ensureDesktopRunning resolves bundled electron relative to desktop package, not cwd', async () => {
  const dir = await tempDir();
  const token = 't';
  await ensureToken(dir);
  await fs.writeFile(path.join(dir, 'token.txt'), `${token}\n`, 'utf8');

  const originalCwd = process.cwd();
  const fakeCwd = await tempDir();
  let spawnedCmd = null;
  let spawnedArgs = null;
  let running = false;
  try {
    process.chdir(fakeCwd);
    const fetchImpl = makeFetch({ getServerId: () => (running ? 'sid-new' : 'sid-missing'), acceptToken: token });
    const spawnImpl = (cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      assert.equal(opts?.detached, true);
      running = true;
      void writeState({ ok: true, port: 12345, serverId: 'sid-new' }, dir);
      return { unref() {} };
    };

    const conn = await ensureDesktopRunning({ stateDir: dir, fetchImpl, spawnImpl, timeoutMs: 3000 });
    assert.equal(conn.serverId, 'sid-new');
    // The binary and entry must resolve from the package's own directory,
    // regardless of cwd or what the checkout folder happens to be named.
    assert.equal(path.isAbsolute(spawnedCmd), true);
    assert.equal(spawnedCmd, path.join(repoDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron'));
    assert.equal(spawnedArgs?.[0], path.join(repoDir, 'main.mjs'));
    assert.equal(spawnedCmd.startsWith(fakeCwd), false);
  } finally {
    process.chdir(originalCwd);
  }
});

test('mcp-lib: relaunch retries after a lock-denied launcher exits normally', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let launcher;
  t.after(async () => {
    if (launcher?.exitCode === null) {
      launcher.kill();
      await once(launcher, 'exit');
    }
  });
  await fs.writeFile(path.join(dir, 'token.txt'), 't\n');
  await writeState({ port: 12345, serverId: 'sid-old' }, dir);
  let running = false;
  let spawned = 0;
  const healthyFetch = makeFetch({ getServerId: () => 'sid-new' });
  const conn = await ensureDesktopRunning({
    stateDir: dir,
    timeoutMs: 3000,
    fetchImpl: (...args) => {
      if (!running) throw new Error('connection_refused');
      return healthyFetch(...args);
    },
    spawnImpl: () => {
      spawned += 1;
      if (spawned === 1) {
        launcher = spawn(process.execPath, ['-e', 'process.exit(0)']);
        return launcher;
      }
      assert.equal(launcher.exitCode, 0);
      running = true;
      void writeState({ port: 12345, serverId: 'sid-new' }, dir);
      return { unref() {} };
    }
  });
  assert.equal(spawned, 2);
  assert.equal(conn.serverId, 'sid-new');
});

test('mcp-lib: an unresponsive live launcher times out without spawning a competitor', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'token.txt'), 't\n');
  await writeState({ port: 12345, serverId: 'sid-old' }, dir);
  let spawned = 0;
  let launcher;
  t.after(async () => {
    if (launcher?.exitCode === null) {
      launcher.kill();
      await once(launcher, 'exit');
    }
  });
  await assert.rejects(() => ensureDesktopRunning({
    stateDir: dir,
    timeoutMs: 700,
    fetchImpl: async () => { throw new Error('connection_refused'); },
    spawnImpl: () => {
      spawned += 1;
      launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      return launcher;
    }
  }), { message: 'desktop_start_timeout' });
  assert.equal(spawned, 1);
});

test('mcp-lib: a failed launcher is not repeatedly respawned', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let spawned = 0;
  await assert.rejects(() => ensureDesktopRunning({
    stateDir: dir,
    timeoutMs: 700,
    fetchImpl: async () => { throw new Error('connection_refused'); },
    spawnImpl: () => {
      spawned += 1;
      return { exitCode: 1, unref() {} };
    }
  }), { message: 'desktop_start_timeout' });
  assert.equal(spawned, 1);
});

test('mcp-lib: a stale PID belonging to another process does not block startup', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'token.txt'), 't\n');
  await writeState({ port: 12345, serverId: 'sid-live', pid: process.pid }, dir);
  let spawned = 0;
  let running = false;
  const healthyFetch = makeFetch({ getServerId: () => 'sid-new' });
  const conn = await ensureDesktopRunning({
    stateDir: dir,
    timeoutMs: 1000,
    fetchImpl: (...args) => {
      if (!running) throw new Error('connection_refused');
      return healthyFetch(...args);
    },
    spawnImpl: () => {
      spawned += 1;
      running = true;
      void writeState({ port: 12345, serverId: 'sid-new' }, dir);
      return { unref() {} };
    }
  });
  assert.equal(spawned, 1);
  assert.equal(conn.serverId, 'sid-new');
});

test('mcp-lib: connection validation shares the startup deadline', async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'token.txt'), 't\n');
  await writeState({ port: 12345, serverId: 'sid-live', pid: process.pid }, dir);
  let aborted = false;
  await assert.rejects(() => ensureDesktopRunning({
    stateDir: dir,
    timeoutMs: 80,
    fetchImpl: async (_url, { signal } = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: false, json: async () => ({}) }), 2000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    spawnImpl: () => { throw new Error('must_not_spawn'); }
  }), { message: 'desktop_start_timeout' });
  assert.equal(aborted, true);
});
