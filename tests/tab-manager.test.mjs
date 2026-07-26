import test from 'node:test';
import assert from 'node:assert/strict';

import { TabManager } from '../tab-manager.mjs';

function stubBrowserBackend() {
  return {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {}
      };
    }
  };
}

test('tab-manager: setMaxTabs raises the live creation cap', async () => {
  const manager = new TabManager({
    browserBackend: stubBrowserBackend(),
    maxTabs: 1,
    createController: async () => ({})
  });

  await manager.createTab({ key: 'one' });
  await assert.rejects(async () => await manager.createTab({ key: 'two' }), /max_tabs_reached/);

  assert.equal(manager.setMaxTabs(2), 2);
  await manager.createTab({ key: 'two' });
  assert.equal(manager.listTabs().length, 2);
});

test('tab-manager: ensureTab rejects vendor mismatch using URL fallback when stored vendorId is missing', async () => {
  const sessions = new Map();
  const browserBackend = {
    async createSession({ tabId, url }) {
      const session = {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          sessions.delete(tabId);
        }
      };
      sessions.set(tabId, { url, session });
      return session;
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => ({})
  });

  const tabId = await manager.createTab({ key: 'projA', url: 'https://chatgpt.com/' });
  assert.ok(tabId);

  await assert.rejects(
    async () =>
      await manager.ensureTab({
        key: 'projA',
        vendorId: 'claude',
        vendorName: 'Claude',
        url: 'https://claude.ai/'
      }),
    /key_vendor_mismatch/
  );
});

test('tab-manager: createTab closes session if controller creation fails', async () => {
  let closeCalls = 0;
  const browserBackend = {
    async createSession() {
      return {
        page: {},
        presenter: {},
        isClosed: () => false,
        close: async () => {
          closeCalls += 1;
        }
      };
    }
  };

  const manager = new TabManager({
    browserBackend,
    createController: async () => {
      throw new Error('controller_init_failed');
    }
  });

  await assert.rejects(async () => await manager.createTab({ key: 'projB', url: 'https://chatgpt.com/' }), /controller_init_failed/);
  assert.equal(closeCalls, 1);
  assert.deepEqual(manager.listTabs(), []);
});

test('tab-manager: controller factory receives vendor identity byte-for-byte and preserves codomain', async () => {
  const calls = [];
  const controller = { kind: 'controller-codomain' };
  const manager = new TabManager({
    browserBackend: stubBrowserBackend(),
    createController: async (input) => {
      calls.push(input);
      return controller;
    }
  });

  const tabId = await manager.createTab({
    key: 'vendor-aware',
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT Preview'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].vendorId, 'chatgpt');
  assert.equal(calls[0].vendorName, 'ChatGPT Preview');
  assert.equal(manager.getControllerById(tabId), controller);
});
