import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChatGPTController } from '../chatgpt-controller.mjs';
import {
  createProviderCompatibilityBridge,
  loadChatGptCompatibilityProfile
} from '../chatgpt-compatibility.mjs';
import { createCompatibilityStore } from '../compatibility-store.mjs';
import { startHttpApi } from '../http-api.mjs';
import { createProviderTabOperationLeases } from '../provider-tab-operation-leases.mjs';

const profile = await loadChatGptCompatibilityProfile();
const selectors = JSON.parse(await fs.readFile(new URL('../selectors.json', import.meta.url), 'utf8'));
const capabilityModes = Object.fromEntries(profile.capabilities.map(({ id, terminalMode }) => [id, terminalMode]));

function resolvedRaw(anchorId) {
  const anchor = profile.anchors.find(({ id }) => id === anchorId);
  const branch = anchor.branches[0];
  return {
    type: 'chatgpt-anchor-resolution', schemaVersion: 1, ok: true,
    anchorId, branchId: branch.id, branchKind: branch.kind, branchSource: branch.source,
    selectorHash: 'b'.repeat(64), rolloutSignature: 'c'.repeat(64), matchCount: 1,
    descriptor: { tagName: 'div', role: '', ariaLabel: '', dataTestId: '', visible: true, enabled: true },
    postcondition: { status: 'ok', reasonCode: 'postcondition-satisfied' }
  };
}

async function harness(anchorId) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-terminal-'));
  const store = createCompatibilityStore(stateDir, {
    contractHash: profile.contractHash,
    capabilityIds: profile.capabilities.map(({ id }) => id),
    capabilityModes
  });
  await store.load();
  const bridge = createProviderCompatibilityBridge({
    vendorId: 'chatgpt', vendorName: 'ChatGPT', selectors, profile,
    onCompatibilityObservation: async (row) => await store.record(row)
  });
  const controller = new ChatGPTController({
    page: { evaluate: async () => resolvedRaw(anchorId) },
    selectors,
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    ...bridge
  });
  return { controller, store, stateDir };
}

test('terminal integration: receipt-backed mechanism success stays non-durable until its matching receipt', async () => {
  const { controller, store } = await harness('assistant-message');
  await controller.runCompatibilityCapability('response', async () => ({ text: 'DOM response' }), {
    anchorId: 'assistant-message', postcondition: (result) => !!result.text
  });

  const pending = store.getSnapshot();
  assert.deepEqual(
    [pending.capabilities.response.status, pending.capabilities.response.reasonCode, pending.apparatus.verdict],
    ['skip', 'terminal-pending', 'incomplete']
  );
  const attemptId = pending.recentObservations.find((row) => row.kind === 'capability').attemptId;
  assert.deepEqual(
    await controller.finalizeCompatibilityTerminal('response', {
      attemptId: 'stale-attempt', mode: 'receipt-backed', status: 'satisfied'
    }),
    { accepted: false, reason: 'stale-terminal' }
  );

  const accepted = await controller.finalizeCompatibilityTerminal('response', {
    attemptId, mode: 'receipt-backed', status: 'satisfied'
  });
  assert.equal(accepted.accepted, true);
  assert.equal(store.getSnapshot().capabilities.response.status, 'ok');
  assert.deepEqual(
    await controller.finalizeCompatibilityTerminal('response', {
      attemptId, mode: 'receipt-backed', status: 'satisfied'
    }),
    { accepted: false, reason: 'stale-terminal' }
  );
});

test('terminal integration sentinel: failed receipt after DOM success becomes failure, never healthy completion', async () => {
  const { controller, store } = await harness('assistant-message');
  await controller.runCompatibilityCapability('response', async () => ({ text: 'DOM response' }), {
    anchorId: 'assistant-message', postcondition: () => true
  });
  await controller.finalizeCompatibilityTerminal('response', {
    mode: 'receipt-backed', status: 'failed'
  });
  const state = store.getSnapshot();
  assert.equal(state.capabilities.response.status, 'fail');
  assert.equal(state.capabilities.response.reasonCode, 'terminal-failed');
  assert.equal(state.apparatus.verdict, 'drift');
});

test('terminal integration sentinel: image DOM discovery is pending until saved artifacts exist', async () => {
  const { controller, store } = await harness('assistant-message');
  await controller.runCompatibilityCapability('image', async () => [{ src: 'blob:image' }], {
    anchorId: 'assistant-message', postcondition: (items) => items.length === 1
  });
  assert.equal(store.getSnapshot().capabilities.image.status, 'skip');
  await controller.finalizeCompatibilityTerminal('image', {
    mode: 'artifact-backed', status: 'satisfied', artifactCount: 1
  });
  assert.equal(store.getSnapshot().capabilities.image.status, 'ok');
  const terminal = store.getSnapshot().recentObservations.at(-1);
  assert.deepEqual(
    { kind: terminal.kind, mode: terminal.mode, status: terminal.status, artifactCount: terminal.artifactCount },
    { kind: 'terminal', mode: 'artifact-backed', status: 'satisfied', artifactCount: 1 }
  );
});

test('terminal integration: authoritative dispatch records its terminal evidence in the same attempt', async () => {
  const { controller, store, stateDir } = await harness('send-button');
  await controller.runCompatibilityCapability('submit', async () => ({ acknowledged: true }), {
    anchorId: 'send-button', postcondition: (result) => result.acknowledged, authoritativeTerminal: true
  });
  const rows = store.getSnapshot().recentObservations;
  assert.deepEqual(rows.map(({ kind }) => kind), ['resolution', 'capability', 'terminal']);
  assert.equal(new Set(rows.map(({ attemptId }) => attemptId)).size, 1);
  assert.equal(rows.at(-1).mode, 'dispatch');
  assert.equal(store.getSnapshot().capabilities.submit.status, 'ok');

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'compatibility', 'chatgpt', 'state.json'), 'utf8'));
  assert.equal(JSON.stringify(persisted).includes('runId'), false);
});

test('terminal integration sentinel: artifact registration failure after DOM discovery emits failed authority', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-terminal-http-'));
  const outside = path.join(stateDir, 'outside.png');
  await fs.writeFile(outside, 'not-a-real-image');
  const terminalCalls = [];
  const controller = {
    runExclusive: async (operation) => await operation(),
    downloadLastAssistantImages: async () => [{ path: outside, mime: 'image/png' }],
    finalizeCompatibilityTerminal: async (...args) => {
      terminalCalls.push(args);
      return { accepted: true };
    }
  };
  const tabs = {
    listTabs: () => [{ id: 't0', key: 'default', vendorId: 'chatgpt', vendorName: 'ChatGPT' }],
    ensureTab: async () => 't0',
    createTab: async () => 't0',
    closeTab: async () => true,
    getControllerById: () => controller
  };
  const server = await startHttpApi({
    providerTabOperations: createProviderTabOperationLeases(),
    port: 0,
    token: 'secret',
    tabs,
    defaultTabId: 't0',
    serverId: 'terminal-test',
    stateDir,
    getSettings: async () => ({ showTabsByDefault: false })
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/artifacts/save`, {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'images', tabId: 't0' })
  });
  assert.equal(response.status, 500);
  assert.deepEqual(terminalCalls, [[
    'image', { mode: 'artifact-backed', status: 'failed' }
  ]]);
});
