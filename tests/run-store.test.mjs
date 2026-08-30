import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createRunStore, parseResponseDebug, parseResponseRecovery } from '../run-store.mjs';

function completionReceipt(kind = 'assistant-response') {
  return {
    version: 1,
    kind,
    responsePath: '/tmp/response.md',
    artifactIds: ['response'],
    responseSha256: 'a'.repeat(64),
    capturedAt: Date.now()
  };
}

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

  const slotPatched = await store.patch('run-1', {
    providerSlot: { status: 'leased', leaseId: 'lease-1', runId: 'run-1', acquiredAt: 123 }
  });
  assert.equal(slotPatched.providerSlot.status, 'leased');
  assert.equal(slotPatched.providerSlot.leaseId, 'lease-1');

  const patched = await store.patch('run-1', { status: 'blocked', blocked: true, blockedKind: 'login' });
  assert.equal(patched.status, 'blocked');
  assert.equal(patched.blocked, true);
  assert.equal(patched.blockedKind, 'login');

  const finalized = await store.finalize('run-1', { status: 'success', detail: 'Done.', conversationUrl: 'https://chatgpt.com/c/abc', completionReceipt: completionReceipt() });
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

test('run-store: load preserves proofless legacy success as explicit unverified history', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-legacy-unverified-'));
  const dir = path.join(stateDir, 'runs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'legacy-query.json'), JSON.stringify({
    id: 'legacy-query',
    kind: 'query',
    status: 'success',
    phase: 'completed',
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2
  }));
  await fs.writeFile(path.join(dir, 'wrong-research.json'), JSON.stringify({
    id: 'wrong-research',
    kind: 'research',
    status: 'success',
    phase: 'completed',
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    completionReceipt: completionReceipt('assistant-response')
  }));
  await fs.writeFile(path.join(dir, 'verified-query.json'), JSON.stringify({
    id: 'verified-query',
    kind: 'query',
    status: 'success',
    phase: 'completed',
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    completionReceipt: completionReceipt('assistant-response')
  }));
  await fs.writeFile(path.join(dir, 'case-research.json'), JSON.stringify({
    id: 'case-research',
    kind: 'Research',
    status: 'SUCCESS',
    phase: 'completed',
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2
  }));

  const store = createRunStore(stateDir);
  await store.load();
  const legacyQuery = store.get('legacy-query');
  const wrongResearch = store.get('wrong-research');
  assert.equal(legacyQuery.status, 'unverified');
  assert.equal(legacyQuery.phase, 'unverified');
  assert.equal(legacyQuery.completionReceipt, null);
  assert.deepEqual(legacyQuery.completionVerification, {
    status: 'legacy-unverified',
    legacyStatus: 'success',
    reason: 'missing_completion_receipt'
  });
  assert.equal(wrongResearch.status, 'unverified');
  assert.equal(wrongResearch.completionReceipt, null);
  assert.equal(wrongResearch.completionVerification.reason, 'completion_receipt_kind_mismatch');
  assert.equal(store.get('verified-query').status, 'success');
  assert.equal(store.get('verified-query').completionVerification, null);
  assert.equal(store.get('case-research').kind, 'research');
  assert.equal(store.get('case-research').status, 'unverified');
  assert.equal(store.get('case-research').completionVerification.reason, 'missing_completion_receipt');
  assert.equal(store.list({ includeArchived: true }).length, 4);

  const archived = await store.archive('legacy-query');
  assert.equal(archived.status, 'unverified');
  assert.equal(typeof archived.archivedAt, 'number');
  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  assert.equal(reloaded.get('legacy-query').status, 'unverified');
});

test('run-store: case-variant output kinds cannot bypass modern receipt enforcement', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-case-kind-'));
  const store = createRunStore(stateDir);
  await store.load();
  await assert.rejects(() => store.create({
    id: 'modern-upper-query',
    kind: 'QUERY',
    status: 'success'
  }), /missing_completion_receipt/);
});

test('run-store: response diagnostics persist as an exact content-free summary', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-response-debug-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-response-debug',
    kind: 'query',
    status: 'running',
    responseDebug: {
      version: 1,
      softDeadlineMs: 1_000,
      reconcileGraceMs: 500,
      hardDeadlineMs: 1_500,
      elapsedMs: 1_200,
      count: 0,
      stop: true,
      sendFound: false,
      pageTextChanged: false,
      textPreview: 'PRIVATE RESPONSE TEXT',
      currentUrl: 'https://chatgpt.com/c/private'
    }
  });
  await store.finalize('run-response-debug', { status: 'error', detail: 'hard deadline' });

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const summary = reloaded.getSummary('run-response-debug');
  assert.equal(summary.responseDebug.version, 1);
  assert.equal(summary.responseDebug.hardDeadlineMs, 1_500);
  assert.equal(summary.responseDebug.stop, true);
  assert.equal('textPreview' in summary.responseDebug, false);
  assert.equal('currentUrl' in summary.responseDebug, false);
  assert.equal(JSON.stringify(summary).includes('PRIVATE RESPONSE TEXT'), false);
});

test('run-store: response diagnostics never coerce malformed boundary values', () => {
  assert.equal(parseResponseDebug({ version: '1', elapsedMs: 10 }), null);
  const parsed = parseResponseDebug({
    version: 1,
    elapsedMs: '10',
    count: null,
    stopCount: false,
    hardDeadlineMs: 20,
    stop: true
  });
  assert.equal(parsed.elapsedMs, null);
  assert.equal(parsed.count, null);
  assert.equal(parsed.stopCount, null);
  assert.equal(parsed.hardDeadlineMs, 20);
  assert.equal(parsed.stop, true);
});

test('run-store: response recovery accepts only content-free closed evidence', () => {
  assert.deepEqual(parseResponseRecovery({
    status: 'partial',
    reason: 'conversation_generation_active',
    assistantCount: 2,
    advanced: false,
    text: 'PRIVATE RESPONSE TEXT'
  }), {
    status: 'partial',
    reason: 'conversation_generation_active',
    assistantCount: 2,
    advanced: false
  });
  assert.equal(parseResponseRecovery({ status: 'future', reason: 'unknown' }), null);
  assert.equal(parseResponseRecovery({ status: 'error', reason: 'private response text' }), null);
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
  const second = await store.finalize('run-3', { status: 'success', detail: 'should_not_replace', completionReceipt: completionReceipt() });

  assert.equal(first.status, 'stopped');
  assert.equal(second.status, 'stopped');
  assert.equal(second.detail, 'user_stop');
  assert.equal(second.finishedAt, first.finishedAt);
});

test('run-store: archive metadata cannot reopen or rewrite a terminal run', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-archive-terminal-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({ id: 'run-archive-terminal', kind: 'query', status: 'running' });
  const terminal = await store.finalize('run-archive-terminal', {
    status: 'success',
    detail: 'original',
    completionReceipt: completionReceipt()
  });
  const attemptedRewrite = await store.patch('run-archive-terminal', {
    archivedAt: Date.now(),
    status: 'error',
    detail: 'rewritten',
    completionReceipt: null
  });

  assert.equal(attemptedRewrite.status, 'success');
  assert.equal(attemptedRewrite.detail, 'original');
  assert.deepEqual(attemptedRewrite.completionReceipt, terminal.completionReceipt);
  assert.equal(attemptedRewrite.archivedAt, null);

  const archived = await store.archive('run-archive-terminal');
  assert.equal(archived.status, 'success');
  assert.equal(archived.detail, 'original');
  assert.deepEqual(archived.completionReceipt, terminal.completionReceipt);
  assert.equal(typeof archived.archivedAt, 'number');
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
    detail: 'done',
    completionReceipt: completionReceipt()
  });

  assert.equal(finalized.status, 'success');
  assert.equal(finalized.phase, 'completed');

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', 'run-terminal-phase.json'), 'utf8'));
  assert.equal(persisted.status, 'success');
  assert.equal(persisted.phase, 'completed');
});

test('run-store: stale in-flight runs can be finalized after restart', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-stale-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-stale',
    kind: 'query',
    source: 'mcp',
    status: 'running',
    phase: 'waiting_for_response',
    startedAt: Date.now()
  });

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const finalized = await reloaded.finalizeStaleRunning({
    status: 'stopped',
    detail: 'Interrupted by restart.'
  });

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].status, 'stopped');
  assert.equal(finalized[0].phase, 'stopped');
  assert.equal(finalized[0].detail, 'Interrupted by restart.');
  assert.equal(typeof finalized[0].finishedAt, 'number');
  assert.equal(finalized[0].stopRequested, true);
  assert.equal(typeof finalized[0].stopRequestedAt, 'number');
});

test('run-store: interrupted restart does not invent a stop request timestamp', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-interrupted-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-interrupted',
    kind: 'query',
    source: 'mcp',
    status: 'running',
    phase: 'waiting_for_response',
    startedAt: Date.now()
  });

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const [interrupted] = await reloaded.finalizeStaleRunning({
    status: 'interrupted',
    detail: 'Interrupted by Agentify Desktop restart.'
  });

  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.stopRequested, false);
  assert.equal(interrupted.stopRequestedAt, null);
});

test('run-store: interrupted restart preserves prior stop request evidence', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-interrupted-stop-'));
  const store = createRunStore(stateDir);
  await store.load();
  await store.create({
    id: 'run-interrupted-stop',
    kind: 'query',
    source: 'mcp',
    status: 'running',
    phase: 'reconciling_response',
    stopRequested: true,
    stopRequestedAt: 123,
    startedAt: 100
  });

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const [interrupted] = await reloaded.finalizeStaleRunning({
    status: 'interrupted',
    detail: 'Interrupted by Agentify Desktop restart.'
  });

  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.stopRequested, true);
  assert.equal(interrupted.stopRequestedAt, 123);
});

test('run-store: interrupted restart preserves every partial stop evidence shape verbatim', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-interrupted-stop-shapes-'));
  const store = createRunStore(stateDir);
  await store.load();
  const cases = [
    { id: 'false-null', stopRequested: false, stopRequestedAt: null },
    { id: 'true-null', stopRequested: true, stopRequestedAt: null },
    { id: 'false-time', stopRequested: false, stopRequestedAt: 123 },
    { id: 'true-time', stopRequested: true, stopRequestedAt: 456 }
  ];
  for (const item of cases) {
    await store.create({
      id: item.id,
      kind: 'query',
      status: 'running',
      stopRequested: item.stopRequested,
      stopRequestedAt: item.stopRequestedAt,
      startedAt: 100
    });
  }

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const interrupted = await reloaded.finalizeStaleRunning({ status: 'interrupted' });
  const byId = new Map(interrupted.map((run) => [run.id, run]));
  for (const item of cases) {
    assert.equal(byId.get(item.id).stopRequested, item.stopRequested, item.id);
    assert.equal(byId.get(item.id).stopRequestedAt, item.stopRequestedAt, item.id);
  }
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
    store.finalize('run-4', { status: 'success', detail: 'done', completionReceipt: completionReceipt() })
  ]);

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', 'run-4.json'), 'utf8'));
  assert.equal(persisted.status, 'success');
  assert.equal(persisted.detail, 'done');
  assert.equal(typeof persisted.finishedAt, 'number');
});

test('run-store: revisions publish only after durable writes and support multiple listeners', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-revisions-'));
  const store = createRunStore(stateDir);
  await store.load();
  const seenA = [];
  const seenB = [];
  const unsubscribeA = store.subscribe((run) => seenA.push(run.revision));
  const unsubscribeB = store.subscribe((run) => seenB.push(run.revision));
  const created = await store.create({ id: 'run-revision', kind: 'query', status: 'running' });
  const patched = await store.patch('run-revision', { phase: 'waiting_for_response' });
  unsubscribeA();
  await store.finalize('run-revision', { status: 'interrupted' });
  unsubscribeB();

  assert.deepEqual([created.revision, patched.revision], [1, 2]);
  assert.deepEqual(seenA, [1, 2]);
  assert.deepEqual(seenB, [1, 2, 3]);
  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'runs', 'run-revision.json'), 'utf8'));
  assert.equal(persisted.revision, 3);
});

test('run-store: failed persistence publishes no transition and leaves memory unchanged', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-run-store-write-failure-'));
  let fail = false;
  const store = createRunStore(stateDir, {
    writeFile: async (filePath, data) => {
      if (fail) throw new Error('disk_full');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, 'utf8');
    }
  });
  await store.load();
  await store.create({ id: 'run-write-failure', kind: 'query', status: 'running' });
  const seen = [];
  store.subscribe((run) => seen.push(run.revision));
  fail = true;
  await assert.rejects(() => store.patch('run-write-failure', { phase: 'waiting_for_response' }), /disk_full/);
  assert.equal(store.get('run-write-failure').revision, 1);
  assert.equal(store.get('run-write-failure').phase, null);
  assert.deepEqual(seen, []);
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
    status: 'running',
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

  await store.finalize('run-research-1', { status: 'success', completionReceipt: completionReceipt('research-report') });

  const reloaded = createRunStore(stateDir);
  await reloaded.load();
  const fromDisk = reloaded.get('run-research-1');
  assert.equal(fromDisk?.researchMeta?.activation?.activated, true);
  assert.equal(fromDisk?.researchMeta?.outputManifest?.responsePath, '/tmp/research-output/final-response.md');

  const listed = store.list({ includeArchived: true });
  assert.equal(listed.length, 1);
  assert.equal('researchMeta' in listed[0], false);

  const summary = store.getSummary('run-research-1', { includeResearchMeta: true });
  assert.equal('logicalRequest' in summary, false);
  assert.equal('materializedReplay' in summary, false);
  assert.equal(summary.researchMeta.activation.activated, true);
  assert.equal(summary.researchMeta.activation.debug, undefined);
  assert.equal(summary.researchMeta.outputManifest.responsePath, '/tmp/research-output/final-response.md');
});
