import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { startHttpApi } from '../http-api.mjs';
import { createProviderTabOperationLeases } from '../provider-tab-operation-leases.mjs';

const VENDORS = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', status: 'supported' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.ai/', status: 'planned' }
];

async function req({ port, method, pth, body }) {
  const res = await fetch(`http://127.0.0.1:${port}${pth}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function startWithController(t, controller) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-oneshot-http-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const tabs = {
    listTabs: () => [
      { id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' },
      { id: 't1', key: 'bench-kimi', vendorId: 'kimi', vendorName: 'Kimi' }
    ],
    ensureTab: async () => 't1',
    createTab: async () => 't1',
    closeTab: async () => true,
    getControllerById: (id) => (id === 't1' ? controller : null)
  };
  const server = await startHttpApi({
    providerTabOperations: createProviderTabOperationLeases(),
    port: 0,
    token: 'secret',
    tabs,
    vendors: VENDORS,
    defaultTabId: 't0',
    serverId: 'sid-test',
    stateDir,
    // A ChatGPT default project must never steer a Kimi run.
    getSettings: async () => ({
      maxInflightQueries: 2,
      maxQueriesPerMinute: 100,
      minTabGapMs: 0,
      minGlobalGapMs: 0,
      showTabsByDefault: false,
      defaultProjectUrl: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project'
    }),
    getStatus: async ({ tabId }) => ({ ok: true, tabId, url: 'https://www.kimi.ai/', blocked: false, promptVisible: true, kind: null, tabs: tabs.listTabs() })
  });
  t.after(() => server.close());
  return { stateDir, port: server.address().port };
}

function engineController(queryImpl) {
  const calls = { query: [], navigate: [] };
  return {
    calls,
    engine: 'oneshot',
    runExclusive: async (fn) => await fn(),
    navigate: async (url) => { calls.navigate.push(url); },
    ensureReady: async () => ({ promptVisible: true }),
    getUrl: async () => 'https://www.kimi.ai/chat/d4ofake',
    query: async (args) => {
      calls.query.push(args);
      return await queryImpl(args);
    }
  };
}

test('oneshot-http: a Kimi query writes the Markdown answer, plain text, sources and shown settings in the ChatGPT run shape', async (t) => {
  const controller = engineController(async () => ({
    text: 'Answer with [a link](https://example.org/a).\n\n## Sources\n\n2. [News](https://news.example.com/b)',
    meta: {
      oneShot: true,
      completionEvidence: { source: 'assistant-node', observedAt: 1 },
      conversationUrl: 'https://www.kimi.ai/chat/d4ofake',
      freshChatUrl: 'https://www.kimi.ai/',
      plainText: 'Answer with a link.',
      sources: [
        { index: 1, url: 'https://example.org/a', title: 'a link', kinds: ['inline'] },
        { index: 2, url: 'https://news.example.com/b', title: 'News', kinds: ['citation'] }
      ],
      requestedModeIntent: 'k3.1-pro',
      modeApplied: { intent: 'k3.1-pro', shown: { model: 'K3.1 Pro', effort: 'High' } },
      answerSettings: { model: 'K3.1 Pro', mode: 'Thinking effort: High', source: 'composer-model-menu-after-answer', unreadReason: null },
      attachments: [{ name: 'brief.pdf', bytes: 10, sha256: 'a'.repeat(64), matchedBy: 'name' }],
      toolUse: { state: 'shown', steps: [{ tool: 'web_search', kind: 'search', title: 'Found 2 web pages', count: 2, pages: [
        { url: 'https://example.org/a', title: 'A', site: 'example.org' },
        { url: 'https://news.example.com/b', title: 'B', site: 'news.example.com' }
      ] }] },
      promptDelivery: { checked: true, complete: true, missingLineCount: 0 }
    }
  }));
  const { port, stateDir } = await startWithController(t, controller);
  const response = await req({
    port,
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Review the profile.', vendorId: 'kimi', key: 'bench-kimi', modeIntent: 'K3.1-Pro' }
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(controller.calls.query.length, 1);
  assert.equal(controller.calls.query[0].modeIntent, 'k3.1-pro');
  assert.deepEqual(controller.calls.navigate, []);

  const fetched = await req({ port, method: 'POST', pth: '/runs/get', body: { runId: response.data.runId } });
  const run = fetched.data.run;
  assert.equal(run.status, 'success');
  assert.equal(run.vendorId, 'kimi');
  assert.equal(run.modeIntent, 'k3.1-pro');
  assert.equal(run.projectUrl, null);
  assert.equal(run.completionReceipt?.kind, 'assistant-response');
  assert.equal(run.promptDelivery?.complete, true);
  const manifest = run.outputManifest;
  assert.equal(path.basename(manifest.responsePath), 'assistant_response.md');
  assert.equal(path.basename(manifest.responseTextPath), 'assistant_response.txt');
  assert.equal(path.basename(manifest.sourcesPath), 'sources.json');
  assert.equal(manifest.sourceCount, 2);
  assert.deepEqual(manifest.answerSettings, { model: 'K3.1 Pro', mode: 'Thinking effort: High', source: 'composer-model-menu-after-answer', unreadReason: null });
  assert.deepEqual(manifest.files.map((file) => file.role).sort(), ['assistant_response', 'assistant_response_text', 'metadata', 'sources', 'tool_use']);
  assert.deepEqual(manifest.attachments, [{ name: 'brief.pdf', bytes: 10, sha256: 'a'.repeat(64), matchedBy: 'name' }]);
  assert.deepEqual(manifest.toolUseCounts, { state: 'shown', reason: null, stepCount: 1, searchCount: 1, pageCount: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(manifest.toolUsePath, 'utf8')), {
    state: 'shown',
    reason: null,
    steps: [{ tool: 'web_search', kind: 'search', title: 'Found 2 web pages', count: 2, pages: [
      { url: 'https://example.org/a', title: 'A', site: 'example.org' },
      { url: 'https://news.example.com/b', title: 'B', site: 'news.example.com' }
    ] }]
  });
  assert.match(await fs.readFile(manifest.responsePath, 'utf8'), /^Answer with \[a link\]\(https:\/\/example\.org\/a\)\./);
  assert.equal(await fs.readFile(manifest.responseTextPath, 'utf8'), 'Answer with a link.\n');
  const sources = JSON.parse(await fs.readFile(manifest.sourcesPath, 'utf8')).sources;
  assert.deepEqual(sources.map((item) => [item.index, item.url, item.kinds]), [[1, 'https://example.org/a', ['inline']], [2, 'https://news.example.com/b', ['citation']]]);
  const metadata = JSON.parse(await fs.readFile(manifest.metadataPath, 'utf8'));
  assert.equal(metadata.vendorId, 'kimi');
  assert.equal(metadata.modeIntent, 'k3.1-pro');
  assert.equal(metadata.modeUsed, null);
  assert.equal(metadata.answerSettings.model, 'K3.1 Pro');
  assert.equal(metadata.freshChatUrl, 'https://www.kimi.ai/');
  assert.equal(metadata.attachments[0].matchedBy, 'name');
  assert.equal(metadata.completionEvidence.source, 'assistant-node');
  const persistedRun = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', `${run.id}.json`), 'utf8'));
  assert.equal(persistedRun.logicalRequest.modeIntent, 'k3.1-pro');
});

test('oneshot-http: a mode the Kimi page could not confirm ends the run as Mode unavailable with nothing saved', async (t) => {
  const controller = engineController(async () => {
    const error = new Error('mode_intent_unavailable');
    error.data = { vendorId: 'kimi', modeIntent: 'k3.1-pro', reason: 'model_not_selected' };
    throw error;
  });
  const { port } = await startWithController(t, controller);
  const response = await req({
    port,
    method: 'POST',
    pth: '/query',
    body: { prompt: 'Review the profile.', vendorId: 'kimi', key: 'bench-kimi', modeIntent: 'k3.1-pro' }
  });
  assert.equal(response.status, 409);
  assert.equal(response.data.error, 'mode_intent_unavailable');
  const listed = await req({ port, method: 'POST', pth: '/runs/list', body: {} });
  const run = listed.data.runs[0];
  assert.equal(run.status, 'error');
  assert.equal(run.label, 'Mode unavailable');
  assert.match(run.detail, /k3\.1-pro.*model_not_selected.*No prompt was sent/);
  assert.equal(run.outputManifest, null);
  assert.equal(run.completionReceipt, null);
});

test('oneshot-http: a Kimi result without completion evidence is not saved as an answer', async (t) => {
  const controller = engineController(async () => ({ text: 'Looks like an answer', meta: { oneShot: true, plainText: 'x', sources: [] } }));
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.notEqual(response.status, 200);
  const listed = await req({ port, method: 'POST', pth: '/runs/list', body: {} });
  assert.equal(listed.data.runs[0].status, 'error');
  assert.equal(listed.data.runs[0].outputManifest, null);
});

test('oneshot-http: a Kimi query asked to continue a chat or use a project is refused before any page work', async (t) => {
  const controller = engineController(async () => { throw new Error('query must not run'); });
  const { port } = await startWithController(t, controller);
  const response = await req({
    port,
    method: 'POST',
    pth: '/query',
    body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi', chatUrl: 'https://www.kimi.ai/chat/abc', projectUrl: 'https://www.kimi.ai/project/x' }
  });
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'oneshot_location_unsupported');
  assert.deepEqual(response.data.data.fields, ['chatUrl', 'projectUrl']);
  assert.equal(controller.calls.query.length, 0);
});

test('oneshot-http: a Kimi answer whose model the page did not show is labeled mode unverified', async (t) => {
  const controller = engineController(async () => ({
    text: 'Answer',
    meta: {
      oneShot: true,
      completionEvidence: { source: 'assistant-node', observedAt: 1 },
      plainText: 'Answer',
      sources: [],
      answerSettings: { model: null, mode: null, source: null, unreadReason: 'model_menu_missing' },
      modeVerification: 'unverified',
      modeVerificationReason: 'model_menu_missing'
    }
  }));
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const fetched = await req({ port, method: 'POST', pth: '/runs/get', body: { runId: response.data.runId } });
  assert.equal(fetched.data.run.label, 'Response received (mode unverified)');
  assert.equal(fetched.data.run.outputManifest.modeVerificationReason, 'model_menu_missing');
});

test('oneshot-http: an unread tool use is saved as unread with its reason, never as an empty list', async (t) => {
  const controller = engineController(async () => ({
    text: 'Answer',
    meta: { oneShot: true, completionEvidence: { source: 'assistant-node', observedAt: 1 }, plainText: 'Answer', sources: [], toolUse: { state: 'unread', reason: 'tool_flow_did_not_expand', steps: null } }
  }));
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const run = (await req({ port, method: 'POST', pth: '/runs/get', body: { runId: response.data.runId } })).data.run;
  assert.deepEqual(run.outputManifest.toolUseCounts, { state: 'unread', reason: 'tool_flow_did_not_expand', stepCount: null, searchCount: null, pageCount: null });
  assert.deepEqual(JSON.parse(await fs.readFile(run.outputManifest.toolUsePath, 'utf8')), { state: 'unread', reason: 'tool_flow_did_not_expand', steps: null });
});

test('oneshot-http: a model that changed after Send is labeled mode downgraded', async (t) => {
  const controller = engineController(async () => ({
    text: 'Answer',
    meta: {
      oneShot: true,
      completionEvidence: { source: 'assistant-node', observedAt: 1 },
      plainText: 'Answer',
      sources: [],
      modeApplied: { intent: 'k3.1-pro', shown: { model: 'K3.1 Pro', effort: 'High' } },
      answerSettings: { model: 'Instant', mode: 'Thinking effort: High', source: 'composer-model-menu-after-answer', unreadReason: null },
      modeVerification: 'unverified',
      modeVerificationReason: 'mode_changed_after_send',
      degradedFrom: { modeIntent: 'k3.1-pro', shownBeforeSend: 'K3.1 Pro', shownAfterAnswer: 'Instant' }
    }
  }));
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi', modeIntent: 'k3.1-pro' } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const run = (await req({ port, method: 'POST', pth: '/runs/get', body: { runId: response.data.runId } })).data.run;
  assert.equal(run.label, 'Response received (mode unverified; mode downgraded)');
  assert.deepEqual(run.degradedFrom, { modeIntent: 'k3.1-pro', shownBeforeSend: 'K3.1 Pro', shownAfterAnswer: 'Instant' });
});

test('oneshot-http: a failure after Send keeps the chat URL on the run', async (t) => {
  const controller = engineController(async () => {
    const error = new Error('answer_capture_failed');
    error.data = { reason: 'answer_empty', conversationUrl: 'https://www.kimi.ai/chat/held-reply' };
    throw error;
  });
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.equal(response.status, 409);
  const run = (await req({ port, method: 'POST', pth: '/runs/list', body: {} })).data.runs[0];
  assert.equal(run.label, 'Answer not captured');
  assert.equal(run.conversationUrl, 'https://www.kimi.ai/chat/held-reply');
});

test('oneshot-http: /send on a Kimi tab is refused before any run is recorded', async (t) => {
  const controller = engineController(async () => { throw new Error('query must not run'); });
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/send', body: { text: 'follow up', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'oneshot_send_unsupported');
  const listed = await req({ port, method: 'POST', pth: '/runs/list', body: {} });
  assert.equal(listed.data.runs.length, 0);
});

test('oneshot-http: the record keeps the engine\'s repairs and capture notes, and an incomplete capture is labeled', async (t) => {
  const controller = engineController(async () => ({
    text: 'Answer',
    meta: {
      oneShot: true,
      completionEvidence: { source: 'assistant-node', observedAt: 1 },
      plainText: 'Answer',
      sources: [],
      toolUse: { state: 'none' },
      sendDebug: { acknowledgedBy: 'user_turn', typingAttempts: 2, trimmedTrailingChars: 1 },
      draftAttachmentsRemoved: ['old-brief pdf'],
      captureNotes: { citations: 3, opened: 1, stamped: 1, skipped: 0, stopped: 'card_still_open', sourcesComplete: false },
      pageNotices: ['Try Plus for faster answers'],
      attachmentDelivery: { checked: false, reason: 'no_attachments' }
    }
  }));
  const { port } = await startWithController(t, controller);
  const response = await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const run = (await req({ port, method: 'POST', pth: '/runs/get', body: { runId: response.data.runId } })).data.run;
  assert.equal(run.label, 'Response received (sources incomplete)');
  const manifest = run.outputManifest;
  assert.equal(manifest.typingAttempts, 2);
  assert.equal(manifest.trimmedTrailingChars, 1);
  assert.deepEqual(manifest.draftAttachmentsRemoved, ['old-brief pdf']);
  assert.equal(manifest.captureNotes.stopped, 'card_still_open');
  assert.deepEqual(manifest.pageNotices, ['Try Plus for faster answers']);
  assert.deepEqual(manifest.attachmentDelivery, { checked: false, reason: 'no_attachments' });
});

test('oneshot-http: a refusal after Kimi took the prompt says so and keeps its stage; an unconfirmed send says the prompt may have gone', async (t) => {
  let next = null;
  const controller = engineController(async () => { throw next; });
  const { port } = await startWithController(t, controller);
  next = Object.assign(new Error('send_refused'), { data: { notice: 'Too many people are chatting with Kimi', stage: 'after_send', conversationUrl: 'https://www.kimi.ai/' } });
  await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  let run = (await req({ port, method: 'POST', pth: '/runs/list', body: {} })).data.runs[0];
  assert.equal(run.label, 'Send refused');
  assert.equal(run.failureStage, 'after_send');
  assert.match(run.detail, /^The provider took the prompt, then refused it: "Too many people/);

  next = Object.assign(new Error('send_unconfirmed'), { data: { sendDebug: { clicked: true }, conversationUrl: 'https://www.kimi.ai/' } });
  await req({ port, method: 'POST', pth: '/query', body: { prompt: 'p', vendorId: 'kimi', key: 'bench-kimi' } });
  run = (await req({ port, method: 'POST', pth: '/runs/list', body: {} })).data.runs[0];
  assert.equal(run.label, 'Send not confirmed');
  assert.match(run.detail, /may have reached the provider/);
  assert.equal(run.conversationUrl, 'https://www.kimi.ai/');
});
