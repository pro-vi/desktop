import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderSlotLeases } from '../provider-slot-leases.mjs';

test('provider-slot-leases: acquires up to capacity and exposes snapshot', async () => {
  let clock = 1000;
  const leases = createProviderSlotLeases({ maxSlots: 2, now: () => clock });

  const a = await leases.acquire({ runId: 'run-a', tabId: 'tab-a', vendorId: 'chatgpt', kind: 'query', source: 'mcp' });
  clock += 1;
  const b = await leases.acquire({ runId: 'run-b', tabId: 'tab-b', vendorId: 'chatgpt', kind: 'research', source: 'mcp' });

  assert.equal(a.runId, 'run-a');
  assert.equal(b.runId, 'run-b');
  assert.equal(leases.snapshot().activeCount, 2);
  assert.deepEqual(leases.snapshot().activeLeases.map((item) => item.runId), ['run-a', 'run-b']);
});

test('provider-slot-leases: fail-fast admission does not enqueue or release another lease', async () => {
  const leases = createProviderSlotLeases({ maxSlots: 1 });
  await leases.acquire({ runId: 'run-a', tabId: 'tab-a' });

  await assert.rejects(
    leases.acquire({ runId: 'run-b', tabId: 'tab-b' }),
    (error) => error?.message === 'provider_slot_unavailable' && error?.data?.reason === 'provider_slot'
  );
  assert.equal(leases.snapshot().activeCount, 1);
  assert.equal(leases.snapshot().queuedCount, 0);

  const released = leases.release('run-b');
  assert.equal(released.released, false);
  assert.deepEqual(leases.snapshot().activeLeases.map((item) => item.runId), ['run-a']);
});

test('provider-slot-leases: queued entries start FIFO when a slot releases', async () => {
  const leases = createProviderSlotLeases({ maxSlots: 1 });
  await leases.acquire({ runId: 'run-a', tabId: 'tab-a' });
  const bPromise = leases.acquire({ runId: 'run-b', tabId: 'tab-b', mode: 'queue' });
  const cPromise = leases.acquire({ runId: 'run-c', tabId: 'tab-c', mode: 'queue' });

  assert.deepEqual(leases.snapshot().queued.map((item) => `${item.runId}:${item.position}`), ['run-b:1', 'run-c:2']);

  const releasedA = leases.release('run-a');
  assert.equal(releasedA.released, true);
  assert.deepEqual(releasedA.started.map((item) => item.runId), ['run-b']);
  assert.equal((await bPromise).runId, 'run-b');
  assert.deepEqual(leases.snapshot().activeLeases.map((item) => item.runId), ['run-b']);
  assert.deepEqual(leases.snapshot().queued.map((item) => `${item.runId}:${item.position}`), ['run-c:1']);

  const releasedB = leases.release('run-b');
  assert.deepEqual(releasedB.started.map((item) => item.runId), ['run-c']);
  assert.equal((await cPromise).runId, 'run-c');
});

test('provider-slot-leases: queued cancellation rejects only the cancelled waiter', async () => {
  const leases = createProviderSlotLeases({ maxSlots: 1 });
  await leases.acquire({ runId: 'run-a' });
  const bPromise = leases.acquire({ runId: 'run-b', mode: 'queue' });
  const cPromise = leases.acquire({ runId: 'run-c', mode: 'queue' });

  const cancelled = leases.cancelQueued('run-b', { reason: 'user_stop' });
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(
    bPromise,
    (error) => error?.message === 'provider_slot_cancelled' && error?.data?.reason === 'user_stop'
  );

  leases.release('run-a');
  assert.equal((await cPromise).runId, 'run-c');
});

test('provider-slot-leases: withLease releases on thrown error', async () => {
  const leases = createProviderSlotLeases({ maxSlots: 1 });

  await assert.rejects(
    leases.withLease({ runId: 'run-a' }, async () => {
      throw new Error('boom');
    }),
    /boom/
  );

  assert.equal(leases.snapshot().activeCount, 0);
  const b = await leases.acquire({ runId: 'run-b' });
  assert.equal(b.runId, 'run-b');
});

test('provider-slot-leases: stale leases are reaped and queued work starts', async () => {
  let clock = 1000;
  const leases = createProviderSlotLeases({ maxSlots: 1, now: () => clock });
  await leases.acquire({ runId: 'run-a' });
  const bPromise = leases.acquire({ runId: 'run-b', mode: 'queue' });

  clock += 10_001;
  const stale = leases.reapStale({ olderThanMs: 10_000 });

  assert.deepEqual(stale.map((item) => item.runId), ['run-a']);
  assert.equal((await bPromise).runId, 'run-b');
  assert.deepEqual(leases.snapshot().activeLeases.map((item) => item.runId), ['run-b']);
});
