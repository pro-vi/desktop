import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCompatibilityStore } from '../compatibility-store.mjs';

const hash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);
const capabilityIds = ['submit', 'response'];
let serial = 0;

function event(status = 'ok', overrides = {}) {
  serial += 1;
  return {
    schemaVersion: 1, observationId: `obs-${serial}`, attemptId: `attempt-${serial}`,
    observedAt: 1_700_000_000_000 + serial, contractHash: hash, vendorId: 'chatgpt', backend: 'electron',
    capabilityId: 'submit', kind: 'capability', postconditionId: 'submit-acknowledged', status,
    reasonCode: status === 'skip' ? 'not-applicable' : 'postcondition-satisfied', rolloutSignature: 'c'.repeat(64), ...overrides
  };
}

async function tempDir(name) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `agentify-compat-${name}-`));
}

test('compatibility store: missing load is cold and valid restart round-trips', async () => {
  const stateDir = await tempDir('load');
  const store = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds });
  const cold = await store.load();
  assert.deepEqual([cold.revision, cold.apparatus.verdict, cold.apparatus.reasonCode], [0, 'incomplete', 'no-observations']);
  const recorded = await store.record(event('ok'));
  assert.equal(recorded.accepted, true);
  const persistedPath = path.join(stateDir, 'compatibility', 'chatgpt', 'state.json');
  assert.equal((await fs.stat(persistedPath)).mode & 0o777, 0o600);
  const restarted = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds });
  assert.deepEqual(await restarted.load(), store.getSnapshot());
});

test('compatibility store: writes mode 0600 before publish and serializes tabs', async () => {
  const stateDir = await tempDir('serial');
  const publications = [];
  const writes = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const store = createCompatibilityStore(stateDir, {
    contractHash: hash, capabilityIds,
    writeFile: async (filePath, data, options) => {
      writes.push({ filePath, data: JSON.parse(data), options });
      if (writes.length === 1) await firstGate;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, { encoding: 'utf8', mode: options.mode });
    }
  });
  store.subscribe((state) => publications.push(state.revision));
  const first = store.record(event('fail'));
  const second = store.record(event('fail'));
  for (let i = 0; i < 20 && writes.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(publications, []);
  assert.equal(writes.length, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(publications, [1, 2]);
  assert.deepEqual(writes.map(({ options }) => options.mode), [0o600, 0o600]);
  assert.equal(store.getSnapshot().capabilities.submit.failureStreak, 2);
});

test('compatibility store sentinel: duplicate fail does not increment or publish twice', async () => {
  const stateDir = await tempDir('dedupe');
  const store = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds });
  let publications = 0;
  store.subscribe(() => { publications += 1; });
  const observation = event('fail');
  const first = await store.record(observation);
  const duplicate = await store.record(observation);
  assert.equal(first.state.capabilities.submit.failureStreak, 1);
  assert.deepEqual([duplicate.accepted, duplicate.duplicate, duplicate.state.revision], [true, true, 1]);
  assert.equal(publications, 1);
});

test('compatibility store sentinel: write failure never publishes green and queued successor retries durable state', async () => {
  const stateDir = await tempDir('failure');
  let calls = 0;
  const publications = [];
  const store = createCompatibilityStore(stateDir, {
    contractHash: hash, capabilityIds,
    writeFile: async (filePath, data, options) => {
      calls += 1;
      if (calls === 1) throw new Error('disk-full-sensitive-path');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, { encoding: 'utf8', mode: options.mode });
    }
  });
  store.subscribe((state) => publications.push(state.revision));
  const failed = await store.record(event('ok'));
  assert.deepEqual([failed.accepted, store.getSnapshot().revision, store.getSnapshot().apparatus.verdict], [false, 0, 'incomplete']);
  assert.deepEqual(publications, []);
  const recovered = await store.record(event('fail'));
  assert.deepEqual([recovered.accepted, recovered.state.revision, recovered.state.capabilities.submit.failureStreak], [true, 1, 1]);
  assert.deepEqual(publications, [1]);
});

test('compatibility store: corrupt/unknown state quarantines once', async () => {
  const stateDir = await tempDir('corrupt');
  const dir = path.join(stateDir, 'compatibility', 'chatgpt');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), '{"schemaVersion":999}', 'utf8');
  const store = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds, now: () => 12345 });
  const [a, b] = await Promise.all([store.load(), store.load()]);
  assert.equal(a.apparatus.reasonCode, 'corrupt-state');
  assert.deepEqual(b, a);
  const names = await fs.readdir(dir);
  assert.deepEqual(names, ['state.json.corrupt-12345']);
});

test('compatibility store privacy sentinel: nested unknown persisted fields quarantine instead of loading', async () => {
  const stateDir = await tempDir('nested-corrupt');
  const seed = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds });
  await seed.record(event('ok'));
  const filePath = path.join(stateDir, 'compatibility', 'chatgpt', 'state.json');
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  raw.priorMaps.push({ token: 'secret', url: 'https://private.example', filename: 'private.md' });
  await fs.writeFile(filePath, JSON.stringify(raw), 'utf8');
  const store = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds, now: () => 67890 });
  const loaded = await store.load();
  assert.equal(loaded.apparatus.reasonCode, 'corrupt-state');
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['state.json.corrupt-67890']);
});

test('compatibility store: current map transition rejects stale events and bounds prior state', async () => {
  const stateDir = await tempDir('map');
  const oldStore = createCompatibilityStore(stateDir, { contractHash: hash, capabilityIds, priorMapLimit: 1 });
  await oldStore.record(event('ok'));
  const store = createCompatibilityStore(stateDir, { contractHash: nextHash, capabilityIds, priorMapLimit: 1 });
  await store.load();
  const stale = await store.record(event('fail'));
  assert.deepEqual([stale.accepted, stale.reason], [false, 'invalid-observation']);
  const current = await store.record(event('ok', { contractHash: nextHash }));
  assert.equal(current.accepted, true);
  assert.equal(current.state.contractHash, nextHash);
  assert.equal(current.state.priorMaps.length, 1);
  assert.equal(current.state.capabilities.submit.status, 'ok');
});
