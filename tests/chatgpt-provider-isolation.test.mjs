import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ChatGPTController } from '../chatgpt-controller.mjs';
import { TabManager } from '../tab-manager.mjs';
import {
  createProviderCompatibilityBridge,
  loadChatGptCompatibilityProfile,
  projectChatGptLegacySelectors
} from '../chatgpt-compatibility.mjs';

const selectors = JSON.parse(await readFile(new URL('../selectors.json', import.meta.url), 'utf8'));
const { vendors } = JSON.parse(await readFile(new URL('../vendors.json', import.meta.url), 'utf8'));
const profile = await loadChatGptCompatibilityProfile();

function makeController(vendor, { selectorOverrides = {}, onObservation } = {}) {
  const mergedSelectors = { ...selectors, ...selectorOverrides };
  const bridge = createProviderCompatibilityBridge({
    vendorId: vendor?.id,
    vendorName: vendor?.name,
    selectors: mergedSelectors,
    selectorOverrides,
    profile,
    onCompatibilityObservation: onObservation
  });
  const controller = new ChatGPTController({
    page: {},
    selectors: mergedSelectors,
    vendorId: vendor?.id,
    vendorName: vendor?.name,
    ...bridge
  });
  return { bridge, controller };
}

test('provider isolation: one tab per declared vendor keeps the controller codomain and scopes the structured profile', async () => {
  assert.equal(vendors.length >= 6, true);
  const bridges = new Map();
  const manager = new TabManager({
    maxTabs: vendors.length,
    browserBackend: {
      async createSession() {
        return {
          page: {},
          presenter: {},
          isClosed: () => false,
          close: async () => {}
        };
      }
    },
    createController: async ({ vendorId, vendorName }) => {
      const result = makeController({ id: vendorId, name: vendorName });
      bridges.set(vendorId, result.bridge);
      return result.controller;
    }
  });

  for (const vendor of vendors) {
    const tabId = await manager.createTab({
      key: `provider-${vendor.id}`,
      url: vendor.url,
      vendorId: vendor.id,
      vendorName: vendor.name
    });
    const controller = manager.getControllerById(tabId);
    const bridge = bridges.get(vendor.id);
    assert.equal(controller instanceof ChatGPTController, true, vendor.id);
    assert.equal(controller.vendorId, vendor.id);
    assert.equal(controller.vendorName, vendor.name);
    assert.equal(bridge.uiContract.kind, vendor.id === 'chatgpt' ? 'chatgpt' : 'legacy');
    assert.equal(bridge.uiContract.vendorId, vendor.id);
    assert.equal(bridge.onCompatibilityObservation, null);
  }
  assert.equal(manager.listTabs().length, vendors.length);
});

test('provider isolation: a sink routed to every vendor can only receive ChatGPT observations', async () => {
  const writes = [];
  for (const vendor of vendors) {
    const { controller } = makeController(vendor, {
      onObservation: async (observation) => writes.push({ vendorId: vendor.id, observation })
    });
    const result = await controller.recordCompatibilityObservation({ kind: 'resolution' });
    assert.equal(result.accepted, vendor.id === 'chatgpt', vendor.id);
  }

  assert.deepEqual(writes, [{ vendorId: 'chatgpt', observation: { kind: 'resolution' } }]);
});

test('provider isolation: unknown and missing vendors stay legacy and cannot write ChatGPT health', async () => {
  let writes = 0;
  for (const vendor of [{ id: 'future-provider', name: 'Future' }, null]) {
    const { bridge, controller } = makeController(vendor, {
      onObservation: async () => { writes += 1; }
    });
    assert.equal(bridge.uiContract.kind, 'legacy');
    assert.equal(bridge.onCompatibilityObservation, null);
    assert.deepEqual(await controller.recordCompatibilityObservation({ kind: 'resolution' }), {
      accepted: false,
      reason: 'not-chatgpt'
    });
  }
  assert.equal(writes, 0);
});

test('provider isolation: flat overrides preserve selector behavior and expose degraded ChatGPT provenance', () => {
  const selectorOverrides = { promptTextarea: '#operator-composer' };
  const chatgpt = vendors.find(({ id }) => id === 'chatgpt');
  const claude = vendors.find(({ id }) => id === 'claude');
  const chatgptBridge = makeController(chatgpt, { selectorOverrides }).bridge;
  const claudeBridge = makeController(claude, { selectorOverrides }).bridge;

  assert.equal(chatgptBridge.uiContract.legacySelectors.promptTextarea, '#operator-composer');
  assert.deepEqual(chatgptBridge.uiContract.operatorOverrides, [
    {
      anchorId: 'prompt-textarea',
      selectorKey: 'promptTextarea',
      selector: '#operator-composer',
      kind: 'legacy',
      source: 'operator-override'
    }
  ]);
  assert.equal(chatgptBridge.uiContract.provenance, 'operator-override');
  assert.equal(chatgptBridge.uiContract.degraded, true);
  assert.equal(claudeBridge.uiContract.selectors.promptTextarea, '#operator-composer');
  assert.equal('operatorOverrides' in claudeBridge.uiContract, false);
});

test('provider isolation: ChatGPT legacy projection is derived from the structured authority', () => {
  assert.deepEqual(projectChatGptLegacySelectors(profile), selectors);
  const changed = structuredClone(profile);
  changed.anchors[0].branches[0].selector = '#profile-owned-composer';
  assert.equal(projectChatGptLegacySelectors(changed).promptTextarea.startsWith('#profile-owned-composer'), true);
});
