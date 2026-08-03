import test from 'node:test';
import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EXPORT_GRANT_ID_PATTERN,
  createElectronExportImportGrants,
  parseExportGrantId
} from '../export-import-grants.mjs';
import { buildZip } from './fixtures/zip-archive.mjs';

const PROFILE_SCOPE_ID = 'profile-main';
const OTHER_PROFILE_SCOPE_ID = 'profile-other';
const START_TIME = Date.parse('2026-07-30T12:00:00.000Z');

function smallExportZip() {
  return buildZip([
    { name: 'conversations.json', data: Buffer.from('[]'), method: 'store' }
  ]);
}

function hasCode(expectedCode) {
  return (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  };
}

function assertNoPath(value, selectedPath) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(selectedPath), false);
  assert.equal(serialized.includes(path.dirname(selectedPath)), false);
}

async function createFixture(t, {
  fileName = 'selected-export.zip',
  contents = smallExportZip()
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-export-grants-'));
  const selectedPath = path.join(directory, fileName);
  await fs.writeFile(selectedPath, contents, { mode: 0o600 });
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, selectedPath };
}

function queuedDialog(results) {
  const queue = [...results];
  const calls = [];
  return {
    calls,
    async showOpenDialog(...args) {
      calls.push(args);
      if (queue.length === 0) throw new Error('unexpected_dialog_call');
      return queue.shift();
    }
  };
}

function createIds() {
  let next = 0;
  return () => `fixture-${++next}`;
}

test('export import grants: one canonical parser owns the public grant id grammar', () => {
  assert.equal(parseExportGrantId('grant-fixture-1'), 'grant-fixture-1');
  assert.equal(EXPORT_GRANT_ID_PATTERN.test('grant-fixture-1'), true);
  for (const value of ['not-a-grant', 'grant-', 'grant-bad value', `grant-a${'x'.repeat(256)}`]) {
    assert.throws(() => parseExportGrantId(value), hasCode('export_grant_invalid'));
  }
});

test('export import grants: a human picker creates a scope-bound public grant without exposing its path', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  const browserWindow = Object.freeze({ fixture: 'browser-window' });
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());

  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID, browserWindow });

  assert.deepEqual(result, {
    status: 'granted',
    grant: {
      grantId: 'grant-fixture-1',
      displayName: path.basename(selectedPath),
      profileScopeId: PROFILE_SCOPE_ID,
      expiresAt: '2026-07-30T12:10:00.000Z'
    }
  });
  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0][0], browserWindow);
  assert.deepEqual(dialog.calls[0][1], {
    title: 'Import ChatGPT export',
    buttonLabel: 'Grant one-time access',
    properties: ['openFile'],
    filters: [{ name: 'ZIP archives', extensions: ['zip'] }]
  });
  assertNoPath(result, selectedPath);

  const pending = await grants.listPending();
  assert.deepEqual(pending, [result.grant]);
  assertNoPath(pending, selectedPath);

  await assert.rejects(
    grants.consume(result.grant.grantId, OTHER_PROFILE_SCOPE_ID),
    hasCode('export_grant_scope_mismatch')
  );
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_reused')
  );
});

test('export import grants: concurrent consumption permits exactly one use', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  const attempts = await Promise.allSettled([
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID)
  ]);
  const fulfilled = attempts.filter(({ status }) => status === 'fulfilled');
  const rejected = attempts.filter(({ status }) => status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'export_grant_reused');
  assert.deepEqual(fulfilled[0].value, {
    size: smallExportZip().length,
    displayName: path.basename(selectedPath),
    profileScopeId: PROFILE_SCOPE_ID
  });
  assertNoPath(fulfilled[0].value, selectedPath);
  await grants.close(fulfilled[0].value);
});

test('export import grants: expiry is enforced lazily from the injected clock without a timer', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  let now = START_TIME;
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => now,
    monotonicClock: () => 0,
    randomId: createIds(),
    ttlMs: 500
  });
  t.after(() => grants.closeAll());
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  now += 500;
  assert.deepEqual(await grants.listPending(), []);
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_expired')
  );
});

test('export import grants: monotonic expiry fails closed when the wall clock rolls backward', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  let now = START_TIME;
  let monotonicNow = 1_000;
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => now,
    monotonicClock: () => monotonicNow,
    randomId: createIds(),
    ttlMs: 500
  });
  t.after(() => grants.closeAll());
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  now -= 60_000;
  monotonicNow += 500;
  assert.deepEqual(await grants.listPending(), []);
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_expired')
  );
});

test('export import grants: a monotonic integrity failure permanently poisons authorization', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  let monotonicNow = 1_000;
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    monotonicClock: () => monotonicNow,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  monotonicNow = Number.NaN;
  await assert.rejects(grants.listPending(), hasCode('export_grant_clock_invalid'));
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_clock_invalid')
  );

  monotonicNow = 999;
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_clock_invalid')
  );

  monotonicNow = 1_001;
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_clock_invalid')
  );
  await assert.rejects(
    grants.request({ profileScopeId: PROFILE_SCOPE_ID }),
    hasCode('export_grant_clock_invalid')
  );
  assert.equal(dialog.calls.length, 1);
  assert.equal(await grants.revoke(result.grant.grantId), true);
});

test('export import grants: deadline overflow cannot strand a live unreturned grant', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  const openedHandles = [];
  const fsOperations = {
    async open(...args) {
      const handle = await fs.open(...args);
      openedHandles.push(handle);
      return handle;
    }
  };
  let now = 8_640_000_000_000_000;
  const grants = createElectronExportImportGrants({
    dialog,
    fsOperations,
    clock: () => now,
    monotonicClock: () => 1_000,
    randomId: createIds(),
    ttlMs: 1
  });
  t.after(() => grants.closeAll());

  await assert.rejects(
    grants.request({ profileScopeId: PROFILE_SCOPE_ID }),
    hasCode('export_grant_clock_invalid')
  );
  assert.equal(openedHandles.length, 1);
  await assert.rejects(openedHandles[0].stat());

  now = START_TIME;
  assert.deepEqual(await grants.listPending(), []);
  await assert.rejects(
    grants.consume('grant-fixture-1', PROFILE_SCOPE_ID),
    hasCode('export_grant_not_found')
  );
});

test('export import grants: cancelling the picker creates no pending grant', async (t) => {
  const dialog = queuedDialog([{ canceled: true, filePaths: [] }]);
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());

  assert.deepEqual(
    await grants.request({ profileScopeId: PROFILE_SCOPE_ID }),
    { status: 'cancelled' }
  );
  assert.deepEqual(await grants.listPending(), []);
});

test('export import grants: a non-ZIP picker result is rejected before file access', async (t) => {
  const { selectedPath } = await createFixture(t, { fileName: 'selected-export.json' });
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  let openCalls = 0;
  const fsOperations = {
    async open(...args) {
      openCalls += 1;
      return fs.open(...args);
    }
  };
  const grants = createElectronExportImportGrants({
    dialog,
    fsOperations,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());

  await assert.rejects(
    grants.request({ profileScopeId: PROFILE_SCOPE_ID }),
    hasCode('export_grant_selection_invalid')
  );
  assert.equal(openCalls, 0);
  assert.deepEqual(await grants.listPending(), []);
});

test('export import grants: a selected symlink is rejected where no-follow file opens are supported', async (t) => {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') {
    t.skip('O_NOFOLLOW is unavailable on this platform');
    return;
  }
  const { directory, selectedPath: targetPath } = await createFixture(t);
  const selectedPath = path.join(directory, 'linked-export.zip');
  try {
    await fs.symlink(targetPath, selectedPath);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip('symlink creation is unavailable on this filesystem');
      return;
    }
    throw error;
  }
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());

  await assert.rejects(
    grants.request({ profileScopeId: PROFILE_SCOPE_ID }),
    hasCode('export_grant_symlink')
  );
  assert.deepEqual(await grants.listPending(), []);
});

test('export import grants: a regular file swapped between picker check and open is rejected', async (t) => {
  const { directory, selectedPath } = await createFixture(t);
  const replacementPath = path.join(directory, 'replacement-export.zip');
  const originalPath = path.join(directory, 'original-selected-export.zip');
  await fs.writeFile(replacementPath, buildZip([
    { name: 'conversations.json', data: Buffer.from('[{}]'), method: 'store' }
  ]), { mode: 0o600 });
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  let swapped = false;
  let closeCalls = 0;
  const fsOperations = {
    async lstat(...args) {
      return await fs.lstat(...args);
    },
    async open(filePath, flags) {
      if (!swapped) {
        swapped = true;
        await fs.rename(selectedPath, originalPath);
        await fs.rename(replacementPath, selectedPath);
      }
      const handle = await fs.open(filePath, flags);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              closeCalls += 1;
              return await target.close();
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };
  const grants = createElectronExportImportGrants({
    dialog,
    fsOperations,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());

  let failure;
  try {
    await grants.request({ profileScopeId: PROFILE_SCOPE_ID });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'export_grant_moved');
  assertNoPath(failure, selectedPath);
  assert.equal(swapped, true);
  assert.equal(closeCalls, 1);
  assert.deepEqual(await grants.listPending(), []);
});

test('export import grants: changing the selected file before consumption invalidates the grant', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([{ canceled: false, filePaths: [selectedPath] }]);
  const grants = createElectronExportImportGrants({
    dialog,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());
  const result = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  await fs.appendFile(selectedPath, Buffer.from([0]));

  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_moved')
  );
  await assert.rejects(
    grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
    hasCode('export_grant_reused')
  );
});

test('export import grants: closeAll revokes every pending grant and closes its real file handle', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([
    { canceled: false, filePaths: [selectedPath] },
    { canceled: false, filePaths: [selectedPath] }
  ]);
  const openedHandles = [];
  const fsOperations = {
    async open(...args) {
      const handle = await fs.open(...args);
      openedHandles.push(handle);
      return handle;
    }
  };
  const grants = createElectronExportImportGrants({
    dialog,
    fsOperations,
    clock: () => START_TIME,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());
  const first = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });
  const second = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  assert.equal((await grants.listPending()).length, 2);
  await grants.closeAll();
  assert.deepEqual(await grants.listPending(), []);
  for (const handle of openedHandles) await assert.rejects(handle.stat());
  for (const result of [first, second]) {
    await assert.rejects(
      grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
      hasCode('export_grant_reused')
    );
  }
  await grants.closeAll();
});

test('export import grants: revoke and closeAll release handles even when the wall clock fails', async (t) => {
  const { selectedPath } = await createFixture(t);
  const dialog = queuedDialog([
    { canceled: false, filePaths: [selectedPath] },
    { canceled: false, filePaths: [selectedPath] }
  ]);
  const openedHandles = [];
  const fsOperations = {
    async open(...args) {
      const handle = await fs.open(...args);
      openedHandles.push(handle);
      return handle;
    }
  };
  let now = START_TIME;
  const grants = createElectronExportImportGrants({
    dialog,
    fsOperations,
    clock: () => now,
    randomId: createIds()
  });
  t.after(() => grants.closeAll());
  const first = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });
  const second = await grants.request({ profileScopeId: PROFILE_SCOPE_ID });

  now = Number.NaN;
  assert.equal(await grants.revoke(first.grant.grantId), true);
  await grants.closeAll();
  for (const handle of openedHandles) await assert.rejects(handle.stat());

  now = START_TIME;
  for (const result of [first, second]) {
    await assert.rejects(
      grants.consume(result.grant.grantId, PROFILE_SCOPE_ID),
      hasCode('export_grant_reused')
    );
  }
});
