#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ChatGPTController } from '../chatgpt-controller.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.dirname(path.dirname(scriptPath));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function nativeFixture() {
  const { app, session } = await import('electron');
  const profile = process.argv[2];
  const output = process.argv[3];
  assert.ok(profile && output, 'owned fixture paths required');
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { ElectronBrowserBackend } = await import('../electron-browser-backend.mjs');
  const selectors = JSON.parse(await fs.readFile(path.join(repoRoot, 'selectors.json')));
  const cases = [];
  try {
    for (const type of ['submit', 'button']) {
      const partition = `native-submit-${crypto.randomUUID()}`;
      const browserSession = session.fromPartition(partition);
      let interceptedRequests = 0;
      const html = `<!doctype html><style>main {padding:30px} #prompt-textarea {width:600px;height:80px;border:1px solid} button {padding:12px}</style><main><form><div id="prompt-textarea" role="textbox" aria-label="Ask anything" contenteditable="true"></div><button type="button" title="review-run2.txt" id="file">review-run2.txt</button><button type="${type}" data-testid="send-button" aria-label="Send prompt">Send</button></form></main><script>
        window.fixture = { fileClicks:0, nativeSubmissions:0, sendClicks:0 };
        const form=document.querySelector('form'), send=document.querySelector('[data-testid=send-button]');
        const sent=()=>{document.querySelector('#prompt-textarea').textContent='';send.disabled=true;const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';form.append(stop)};
        document.querySelector('#file').onclick=()=>fixture.fileClicks++;
        form.onsubmit=e=>{e.preventDefault();fixture.nativeSubmissions++;sent()};
        if(${JSON.stringify(type)}==='button')send.onclick=()=>{fixture.sendClicks++;sent()};
      </script>`;
      await browserSession.protocol.handle('https', () => {
        interceptedRequests++;
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      });
      await browserSession.protocol.handle('http', () => new Response('', { status: 403 }));
      const backend = new ElectronBrowserBackend({ windowDefaults: { width: 900, height: 700, show: false, webPreferences: { partition } } });
      let ownedWindow;
      const result = { type, result: 'driver-gap' };
      try {
        ownedWindow = await backend.createSession({ url: 'https://chatgpt.com/', show: false, vendorId: 'chatgpt' });
        const evaluate = ownedWindow.page.evaluate.bind(ownedWindow.page);
        ownedWindow.page.evaluate = (script, options) => evaluate(script, { ...options, captureExceptions: true });
        const controller = new ChatGPTController({ page: ownedWindow.page, selectors, vendorId: 'chatgpt', stateDir: profile });
        const sent = await controller.send({ text: 'Native form fixture.', timeoutMs: 5000 });
        assert.equal(sent.ok, true);
        result.observed = await evaluate('window.fixture');
        assert.equal(result.observed.fileClicks, 0);
        assert.equal(result.observed.nativeSubmissions, type === 'submit' ? 1 : 0);
        assert.equal(result.observed.sendClicks, type === 'button' ? 1 : 0);
        assert.ok(interceptedRequests > 0);
        result.result = 'verified';
        result.interceptedRequests = interceptedRequests;
        result.window = ownedWindow.page.win.getBounds();
        const screenshotPath = path.join(output, `${type}.png`);
        await fs.writeFile(screenshotPath, (await ownedWindow.page.win.webContents.capturePage()).toPNG());
        result.screenshot = screenshotPath;
      } catch (error) {
        result.result = 'product-fail';
        result.error = { name: error.name, renderer: error.data?.rendererError || null };
      } finally {
        await ownedWindow?.close();
        await browserSession.protocol.unhandle('https');
        await browserSession.protocol.unhandle('http');
      }
      cases.push(result);
    }
    process.stdout.write(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, pid: process.pid, cases }) + '\n');
  } finally { app.quit(); }
}

if (process.versions.electron) {
  nativeFixture().catch(error => { process.stderr.write(`${error.name}: fixture_setup_failed\n`); process.exit(1); });
} else {
  const run = promisify(execFile);
  const electron = (await import('electron')).default;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-native-submit-'));
  const artifacts = path.join(repoRoot, '.inbox/.work');
  await fs.mkdir(artifacts, { recursive: true });
  const output = await fs.mkdtemp(path.join(artifacts, 'native-submit-'));
  const source = { controllerSha256: digest(await fs.readFile(path.join(repoRoot, 'chatgpt-controller.mjs'))), scriptSha256: digest(await fs.readFile(scriptPath)) };
  let native;
  try {
    const { stdout } = await run(electron, [scriptPath, profile, output], { cwd: repoRoot, timeout: 120000, maxBuffer: 1024 * 1024 });
    native = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(digest(await fs.readFile(path.join(repoRoot, 'chatgpt-controller.mjs'))), source.controllerSha256, 'controller changed during fixture execution');
  } finally { await fs.rm(profile, { recursive: true }); }
  assert.equal(await fs.stat(profile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
  const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
  const verified = native?.cases.length === 2 && native.cases.every(item => item.result === 'verified');
  const receipt = { command: 'node scripts/e2e-native-submit.mjs', result: verified ? 'verified' : 'product-fail', scope: 'Native controller Send contract fixture; every HTTP(S) request intercepted; no provider request or shared-app restart.', source: { ...source, gitSha: sha.trim(), dirty: !!dirty.trim() }, runtime: { binarySha256: digest(await fs.readFile(electron)), ...native }, cleanup: { ownedProfileRemoved: true, ownedProcessExited: true } };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await fs.writeFile(path.join(artifacts, 'native-submit-latest.json'), JSON.stringify({ receipt: path.join(output, 'receipt.json') }) + '\n');
  process.stdout.write(JSON.stringify({ result: receipt.result, cases: native?.cases.length, receipt: path.join(output, 'receipt.json') }) + '\n');
  process.exitCode = verified ? 0 : 1;
}
