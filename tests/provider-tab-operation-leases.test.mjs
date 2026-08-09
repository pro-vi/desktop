import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderTabOperationLeases } from '../provider-tab-operation-leases.mjs';

test('provider tab operation leases reject a different owner with content-free evidence', () => {
  const leases = createProviderTabOperationLeases();
  leases.reserve('tab:t0', {
    id: 'query-1',
    kind: 'query',
    tabId: 't0',
    source: 'http',
    phase: 'preparing_context',
    privateTranscript: 'must never enter the lease'
  });

  assert.throws(
    () => leases.reserve('tab:t0', { id: 'sync-1', kind: 'transcript-sync' }),
    (error) => {
      assert.equal(error?.code, 'tab_busy');
      assert.equal(error?.message, 'tab_busy');
      assert.equal(error?.data?.scope, 'tab:t0');
      assert.equal(error?.data?.activeQuery?.id, 'query-1');
      assert.equal(JSON.stringify(error).includes('must never enter'), false);
      return true;
    }
  );
});

test('provider tab operation leases allow only ambient re-entry without transferring cleanup ownership', async () => {
  const leases = createProviderTabOperationLeases();
  assert.equal(leases.reserve('key:thread', { id: 'query-1', kind: 'query' }), true);
  assert.throws(
    () => leases.reserve('key:thread', { id: 'query-1', kind: 'transcript-sync' }),
    (error) => error?.code === 'tab_busy'
  );

  await leases.runWithOwner('query-1', async () => {
    assert.equal(leases.reserve('key:thread', { id: 'query-1', kind: 'transcript-sync' }), false);
    leases.assertAvailable('key:thread', 'query-1');
  });

  assert.equal(leases.current('key:thread')?.kind, 'query');
  assert.equal(leases.release('key:thread', 'sync-1'), false);
  assert.equal(leases.release('key:thread', 'query-1'), true);
  assert.equal(leases.current('key:thread'), null);
});

test('provider tab operation leases carry one owner across async post-query work', async () => {
  const leases = createProviderTabOperationLeases();
  leases.reserve('key:thread', { id: 'query-1', kind: 'query' });

  await leases.runWithOwner('query-1', async () => {
    await Promise.resolve();
    assert.equal(leases.currentOwnerId(), 'query-1');
    assert.equal(leases.reserve('key:thread', {
      id: leases.currentOwnerId(),
      kind: 'transcript-sync'
    }), false);
  });

  assert.equal(leases.currentOwnerId(), null);
  assert.equal(leases.release('key:thread', 'query-1'), true);
});

test('provider tab operation leases release every alias owned by one operation only', () => {
  const leases = createProviderTabOperationLeases();
  leases.reserve('key:thread', { id: 'query-1', kind: 'query' });
  leases.reserve('tab:t0', { id: 'query-1', kind: 'query' });
  leases.reserve('tab:t1', { id: 'query-2', kind: 'query' });

  assert.deepEqual(leases.releaseAll('query-1').sort(), ['key:thread', 'tab:t0']);
  assert.deepEqual(leases.snapshot(), [{
    scope: 'tab:t1',
    operation: { id: 'query-2', kind: 'query', scope: 'tab:t1' }
  }]);
});
