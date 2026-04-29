import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createRunStore } from '../run-store.mjs';

test('run-store: create, patch, finalize, and archive lifecycle', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-'));
  const store = createRunStore(stateDir);
  await store.load();

  const created = await store.create({
    id: 'run-1',
    kind: 'query',
    source: 'mcp',
    status: 'running',
    phase: 'preparing_context',
    promptPreview: 'summarize repo',
    startedAt: Date.now(),
    logicalRequest: { prompt: 'Summarize this repo.' },
    materializedReplay: { prompt: 'Summarize this repo.', attachments: [] }
  });
  assert.equal(created.id, 'run-1');
  assert.equal(created.status, 'running');

  const patched = await store.patch('run-1', { status: 'blocked', blocked: true, blockedKind: 'login' });
  assert.equal(patched.status, 'blocked');
  assert.equal(patched.blocked, true);
  assert.equal(patched.blockedKind, 'login');

  const finalized = await store.finalize('run-1', { status: 'success', detail: 'Done.', conversationUrl: 'https://chatgpt.com/c/abc' });
  assert.equal(finalized.status, 'success');
  assert.equal(typeof finalized.finishedAt, 'number');
  assert.equal(finalized.conversationUrl, 'https://chatgpt.com/c/abc');

  const archived = await store.archive('run-1');
  assert.equal(typeof archived.archivedAt, 'number');

  const listed = store.list({ includeArchived: true });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'run-1');
  assert.equal('logicalRequest' in listed[0], false);
  assert.equal('materializedReplay' in listed[0], false);
});

test('run-store: load hydrates index from per-run files', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-load-'));
  const storeA = createRunStore(stateDir);
  await storeA.load();
  await storeA.create({
    id: 'run-2',
    kind: 'query',
    source: 'http',
    status: 'error',
    detail: 'timeout_waiting_for_response',
    promptPreview: 'long prompt',
    startedAt: Date.now()
  });

  const storeB = createRunStore(stateDir);
  await storeB.load();
  const got = storeB.get('run-2');
  assert.equal(got?.id, 'run-2');
  assert.equal(got?.status, 'error');
});

test('run-store: finalize is exact-once for terminal state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-finalize-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-3',
    kind: 'query',
    source: 'ui',
    status: 'running',
    startedAt: Date.now()
  });

  const first = await store.finalize('run-3', { status: 'stopped', detail: 'user_stop' });
  const second = await store.finalize('run-3', { status: 'success', detail: 'should_not_replace' });

  assert.equal(first.status, 'stopped');
  assert.equal(second.status, 'stopped');
  assert.equal(second.detail, 'user_stop');
  assert.equal(second.finishedAt, first.finishedAt);
});

test('run-store: terminal success cannot retain an in-flight phase', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-terminal-phase-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-terminal-phase',
    kind: 'query',
    source: 'mcp',
    status: 'running',
    phase: 'waiting_for_response',
    startedAt: Date.now()
  });

  const finalized = await store.finalize('run-terminal-phase', {
    status: 'success',
    detail: 'done'
  });

  assert.equal(finalized.status, 'success');
  assert.equal(finalized.phase, 'completed');

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', 'run-terminal-phase.json'), 'utf8'));
  assert.equal(persisted.status, 'success');
  assert.equal(persisted.phase, 'completed');
});

test('run-store: queued writes keep finalized runs terminal on disk', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-queue-'));
  let writeCount = 0;
  const store = createRunStore(stateDir, {
    writeFile: async (filePath, data) => {
      writeCount += 1;
      if (writeCount === 2) await new Promise((resolve) => setTimeout(resolve, 25));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, 'utf8');
    }
  });
  await store.load();
  await store.create({
    id: 'run-4',
    kind: 'query',
    source: 'http',
    status: 'running',
    startedAt: Date.now()
  });

  await Promise.all([
    store.patch('run-4', { phase: 'waiting_for_response', status: 'running' }),
    store.finalize('run-4', { status: 'success', detail: 'done' })
  ]);

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', 'run-4.json'), 'utf8'));
  assert.equal(persisted.status, 'success');
  assert.equal(persisted.detail, 'done');
  assert.equal(typeof persisted.finishedAt, 'number');
});

test('run-store: researchMeta persists, merges on patch, and stays out of list summaries', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-research-'));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const store = createRunStore(stateDir);
  await store.load();

  await store.create({
    id: 'run-research-1',
    kind: 'research',
    source: 'mcp',
    status: 'success',
    phase: 'exporting_output',
    startedAt: Date.now(),
    promptPreview: 'deep research',
    researchMeta: {
      activation: {
        requested: true,
        activated: true,
        error: null,
        tabId: 't-research',
        conversationUrl: 'https://chatgpt.com/c/research-1'
      },
      outputManifest: {
        dir: '/tmp/research-output',
        responsePath: '/tmp/research-output/response.md',
        exportedMarkdownPath: '/tmp/research-output/export.md',
        files: [{ id: 'artifact-1', path: '/tmp/research-output/response.md', name: 'response.md' }]
      }
    }
  });

  const full = store.get('run-research-1');
  assert.equal(full?.researchMeta?.activation?.activated, true);
  assert.equal(full?.researchMeta?.outputManifest?.responsePath, '/tmp/research-output/response.md');

  await store.patch('run-research-1', {
    researchMeta: {
      outputManifest: {
        responsePath: '/tmp/research-output/final-response.md'
      }
    }
  });

  const patched = store.get('run-research-1');
  assert.equal(patched?.researchMeta?.activation?.activated, true);
  assert.equal(patched?.researchMeta?.outputManifest?.responsePath, '/tmp/research-output/final-response.md');
  assert.equal(patched?.researchMeta?.outputManifest?.exportedMarkdownPath, '/tmp/research-output/export.md');

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const fromDisk = reloaded.get('run-research-1');
  assert.equal(fromDisk?.researchMeta?.activation?.activated, true);
  assert.equal(fromDisk?.researchMeta?.outputManifest?.responsePath, '/tmp/research-output/final-response.md');

  const listed = store.list({ includeArchived: true });
  assert.equal(listed.length, 1);
  assert.equal('researchMeta' in listed[0], false);
});
