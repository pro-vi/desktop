import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './fs-utils.mjs';

function safeClone(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function runsDir(stateDir) {
  return path.join(stateDir, 'runs');
}

function runPath(stateDir, runId) {
  return path.join(runsDir(stateDir), `${runId}.json`);
}

async function defaultWriteFile(filePath, data) {
  await atomicWriteFile(filePath, data, { mode: 0o600 });
}

function normalizeString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeTime(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? safeClone(value) : null;
}

function normalizeRun(input = {}) {
  const now = Date.now();
  const startedAt = normalizeTime(input.startedAt) || now;
  const updatedAt = normalizeTime(input.updatedAt) || startedAt;
  const finishedAt = normalizeTime(input.finishedAt);
  const archivedAt = normalizeTime(input.archivedAt);
  return {
    id: normalizeString(input.id),
    kind: normalizeString(input.kind) || 'query',
    source: normalizeString(input.source) || 'http',
    status: normalizeString(input.status) || 'queued',
    phase: normalizeString(input.phase),
    label: normalizeString(input.label),
    detail: normalizeString(input.detail),
    tabId: normalizeString(input.tabId),
    key: normalizeString(input.key),
    vendorId: normalizeString(input.vendorId),
    vendorName: normalizeString(input.vendorName),
    projectUrl: normalizeString(input.projectUrl),
    conversationUrl: normalizeString(input.conversationUrl),
    modeIntent: normalizeString(input.modeIntent),
    promptPreview: normalizeString(input.promptPreview),
    blocked: !!input.blocked,
    blockedKind: normalizeString(input.blockedKind),
    blockedTitle: normalizeString(input.blockedTitle),
    stopRequested: !!input.stopRequested,
    stopRequestedAt: normalizeTime(input.stopRequestedAt),
    startedAt,
    updatedAt,
    finishedAt,
    durationMs: normalizeTime(input.durationMs) || (finishedAt ? Math.max(0, finishedAt - startedAt) : null),
    retryOf: normalizeString(input.retryOf),
    archivedAt,
    logicalRequest: normalizeObject(input.logicalRequest),
    materializedReplay: normalizeObject(input.materializedReplay),
    packedContextSummary: normalizeObject(input.packedContextSummary),
    packedContextBudget: normalizeObject(input.packedContextBudget),
    modeIntentProvenance: normalizeObject(input.modeIntentProvenance),
    researchMeta: normalizeObject(input.researchMeta)
  };
}

function assertRunId(runId) {
  const id = normalizeString(runId);
  if (!id) throw new Error('missing_run_id');
  return id;
}

function toSummary(run) {
  const record = normalizeRun(run);
  delete record.logicalRequest;
  delete record.materializedReplay;
  delete record.researchMeta;
  return record;
}

function mergeResearchMeta(current, patchData) {
  const currentMeta = normalizeObject(current?.researchMeta);
  const nextMeta = normalizeObject(patchData?.researchMeta);
  if (!nextMeta) return currentMeta;
  return {
    ...(currentMeta || {}),
    ...nextMeta,
    activation: {
      ...((currentMeta && currentMeta.activation) || {}),
      ...((nextMeta && nextMeta.activation) || {})
    },
    outputManifest: {
      ...((currentMeta && currentMeta.outputManifest) || {}),
      ...((nextMeta && nextMeta.outputManifest) || {})
    }
  };
}

export function createRunStore(stateDir, { writeFile = defaultWriteFile } = {}) {
  const records = new Map();
  const writeQueues = new Map();

  function enqueueRunOp(runId, fn) {
    const id = assertRunId(runId);
    const previous = writeQueues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    const settled = next.finally(() => {
      if (writeQueues.get(id) === settled) writeQueues.delete(id);
    });
    writeQueues.set(id, settled);
    return settled;
  }

  async function writeRecord(record) {
    const next = normalizeRun(record);
    if (!next.id) throw new Error('missing_run_id');
    records.set(next.id, next);
    await writeFile(runPath(stateDir, next.id), `${JSON.stringify(next, null, 2)}\n`);
    return safeClone(next);
  }

  async function load() {
    records.clear();
    let names = [];
    try {
      names = await fs.readdir(runsDir(stateDir));
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(runsDir(stateDir), name), 'utf8'));
        const record = normalizeRun(raw);
        if (!record.id) continue;
        records.set(record.id, record);
      } catch {}
    }
  }

  async function create(record) {
    const next = normalizeRun(record);
    if (!next.id) throw new Error('missing_run_id');
    return await enqueueRunOp(next.id, async () => {
      if (records.has(next.id)) return safeClone(records.get(next.id));
      return await writeRecord(next);
    });
  }

  async function patch(runId, patchData = {}) {
    const id = assertRunId(runId);
    return await enqueueRunOp(id, async () => {
      const current = records.get(id);
      if (!current) throw new Error('run_not_found');
      if (current.finishedAt && !('archivedAt' in patchData)) return safeClone(current);
      const next = normalizeRun({
        ...current,
        ...(patchData || {}),
        researchMeta: mergeResearchMeta(current, patchData),
        id,
        startedAt: current.startedAt,
        updatedAt: Date.now()
      });
      return await writeRecord(next);
    });
  }

  async function finalize(runId, patchData = {}) {
    const id = assertRunId(runId);
    return await enqueueRunOp(id, async () => {
      const current = records.get(id);
      if (!current) throw new Error('run_not_found');
      if (current.finishedAt) return safeClone(current);
      const finishedAt = Date.now();
      const next = normalizeRun({
        ...current,
        ...(patchData || {}),
        researchMeta: mergeResearchMeta(current, patchData),
        id,
        finishedAt,
        updatedAt: finishedAt,
        durationMs: Math.max(0, finishedAt - current.startedAt)
      });
      return await writeRecord(next);
    });
  }

  async function archive(runId) {
    const id = assertRunId(runId);
    return await patch(id, { archivedAt: Date.now() });
  }

  function get(runId) {
    const id = assertRunId(runId);
    const current = records.get(id);
    return current ? safeClone(current) : null;
  }

  function list({ includeArchived = false, limit = 100 } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    return Array.from(records.values())
      .filter((item) => includeArchived || !item.archivedAt)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, cap)
      .map((item) => toSummary(item));
  }

  return {
    load,
    create,
    patch,
    finalize,
    archive,
    get,
    list
  };
}
