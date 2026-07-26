import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  parseChatGptCompatibilityStatus,
  serializeChatGptCompatibilityStatus
} from '../chatgpt-compatibility.mjs';
import { createEmptyChatGptCompatibilityState } from '../chatgpt-capability-health.mjs';
import { startHttpApi } from '../http-api.mjs';
import { normalizeDesktopStatus } from '../mcp-lib.mjs';

const hash = 'a'.repeat(64);

function stateWith(status, {
  apparatus = status === 'fail' ? 'drift' : 'ok',
  reasonCode = status === 'fail' ? 'capability-failure' : 'observed-cohort',
  observedAt = 1_700_000_000_000,
  priorMaps = []
} = {}) {
  const state = createEmptyChatGptCompatibilityState({ contractHash: hash, capabilityIds: ['response', 'image'] });
  state.capabilities.response = {
    ...state.capabilities.response,
    status,
    reasonCode: status === 'skip' ? 'not-observed' : status === 'fail' ? 'terminal-failed' : 'postcondition-satisfied',
    failureStreak: status === 'fail' ? 1 : 0,
    degradedStreak: status === 'degraded' ? 1 : 0,
    lastSequence: status === 'skip' ? null : 1,
    lastObservedAt: status === 'skip' ? null : observedAt,
    rolloutSignature: status === 'skip' ? null : 'b'.repeat(64)
  };
  state.coverage = { observed: status === 'skip' ? 0 : 1, total: 2 };
  state.apparatus = { verdict: apparatus, reasonCode };
  state.priorMaps = priorMaps;
  return state;
}

test('compatibility status: cold, healthy, degraded, drift, incomplete, stale, and stale-map remain distinct', () => {
  const now = 1_700_000_100_000;
  const cold = serializeChatGptCompatibilityStatus(stateWith('skip', { apparatus: 'incomplete', reasonCode: 'no-observations' }), { now });
  const healthy = serializeChatGptCompatibilityStatus(stateWith('ok'), { now });
  const degraded = serializeChatGptCompatibilityStatus(stateWith('degraded'), { now });
  const drift = serializeChatGptCompatibilityStatus(stateWith('fail'), { now });
  const incomplete = serializeChatGptCompatibilityStatus(stateWith('ok', { apparatus: 'incomplete', reasonCode: 'store-write-failed' }), { now });
  const stale = serializeChatGptCompatibilityStatus(stateWith('ok', { observedAt: 1_600_000_000_000 }), { now, staleAfterMs: 1_000 });
  const staleMap = serializeChatGptCompatibilityStatus(stateWith('skip', {
    apparatus: 'incomplete', reasonCode: 'new-map-unobserved', priorMaps: [{ contractHash: 'c'.repeat(64) }]
  }), { now });

  assert.deepEqual(
    [cold.verdict, healthy.verdict, degraded.verdict, drift.verdict, incomplete.verdict, stale.verdict, staleMap.verdict],
    ['unobserved', 'observed-healthy', 'observed-degraded', 'drift', 'incomplete', 'stale', 'stale']
  );
  assert.deepEqual([cold.staleness.status, stale.staleness.status, staleMap.staleness.status], ['cold', 'stale', 'stale-map']);
  assert.deepEqual(healthy.coverage, { observed: 1, total: 2 });
});

test('compatibility status sentinel: unknown variants render incompatible and private state fields never project', () => {
  const state = stateWith('ok');
  state.token = 'private-token';
  state.capabilities.response.filename = 'private.md';
  const projected = serializeChatGptCompatibilityStatus(state, { now: 1_700_000_100_000 });
  assert.equal(JSON.stringify(projected).includes('private'), false);
  const incompatible = parseChatGptCompatibilityStatus({ ...projected, verdict: 'probably-fine' });
  assert.deepEqual(
    [incompatible.verdict, incompatible.apparatus.verdict, incompatible.staleness.status],
    ['incompatible', 'incomplete', 'unknown']
  );
});

test('compatibility status: authenticated HTTP, MCP normalization, and IPC state retain one wire summary', async (t) => {
  const compatibility = serializeChatGptCompatibilityStatus(stateWith('degraded'), { now: 1_700_000_100_000 });
  const tabs = {
    listTabs: () => [], ensureTab: async () => 't0', createTab: async () => 't0',
    closeTab: async () => true, getControllerById: () => ({})
  };
  const server = await startHttpApi({
    port: 0, token: 'secret', tabs, defaultTabId: 't0', serverId: 'status-test', stateDir: '/tmp',
    getCompatibilityStatus: () => compatibility,
    getStatus: async () => ({ ok: true, tabs: [] })
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const unauthorized = await fetch(`${base}/status`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${base}/status`, { headers: { authorization: 'Bearer secret' } });
  const httpStatus = await response.json();
  const mcpStatus = normalizeDesktopStatus(httpStatus);
  const ipcState = { ok: true, compatibility };
  assert.deepEqual(httpStatus.compatibility, compatibility);
  assert.deepEqual(mcpStatus.compatibility, compatibility);
  assert.deepEqual(ipcState.compatibility, compatibility);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(Object.hasOwn(health, 'compatibility'), false);
});

test('compatibility status: renderer copy preserves observed-cohort and incompatible semantics', async () => {
  const [source, html] = await Promise.all([
    fs.readFile(new URL('../ui/control-center.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../ui/control-center.html', import.meta.url), 'utf8')
  ]);
  assert.match(source, /Observed cohort healthy/);
  assert.match(source, /Incompatible compatibility status/);
  assert.match(source, /only this installation’s exercised cohort/);
  assert.doesNotMatch(source, /globally latest|latest ChatGPT UI/i);
  assert.match(html, /id="compatibilityVerdict"/);
});
