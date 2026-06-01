function normalizeString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

function cloneLease(lease) {
  return lease ? { ...lease } : null;
}

function makeAdmissionError({ reason = 'provider_slot', retryAfterMs = 250, activeLeases = [], queued = [] } = {}) {
  const err = new Error('provider_slot_unavailable');
  err.data = { reason, retryAfterMs, activeLeases, queued };
  return err;
}

function makeCancelledError({ runId, reason = 'cancelled' } = {}) {
  const err = new Error('provider_slot_cancelled');
  err.data = { runId: normalizeString(runId), reason };
  return err;
}

export function createProviderSlotLeases({ maxSlots = 2, now = () => Date.now(), onChange = null } = {}) {
  const active = new Map();
  const queue = [];
  let capacity = positiveInt(maxSlots, 2);
  let sequence = 0;

  const emitChange = () => {
    try {
      onChange?.(snapshot());
    } catch {}
  };

  const queueIndex = (runId) => queue.findIndex((item) => item.runId === runId);

  const activeList = () => Array.from(active.values())
    .map(cloneLease)
    .sort((a, b) => (a.acquiredAt || 0) - (b.acquiredAt || 0));

  const queuedList = () => queue
    .map((item, index) => ({
      runId: item.runId,
      tabId: item.tabId,
      key: item.key,
      vendorId: item.vendorId,
      kind: item.kind,
      source: item.source,
      queuedAt: item.queuedAt,
      position: index + 1
    }));

  const createLease = (request) => {
    const timestamp = now();
    return {
      leaseId: `${timestamp}-${++sequence}`,
      runId: request.runId,
      tabId: request.tabId || null,
      key: request.key || null,
      vendorId: request.vendorId || null,
      kind: request.kind || 'query',
      source: request.source || 'http',
      acquiredAt: timestamp,
      heartbeatAt: timestamp
    };
  };

  const startRequest = (request) => {
    const existing = active.get(request.runId);
    if (existing) return cloneLease(existing);
    const lease = createLease(request);
    active.set(request.runId, lease);
    return cloneLease(lease);
  };

  const drain = () => {
    const started = [];
    while (active.size < capacity && queue.length > 0) {
      const request = queue.shift();
      if (!request || request.cancelled) continue;
      const lease = startRequest(request);
      started.push(lease);
      request.resolve(lease);
    }
    if (started.length) emitChange();
    return started;
  };

  const snapshot = () => ({
    max: capacity,
    activeCount: active.size,
    queuedCount: queue.length,
    activeLeases: activeList(),
    queued: queuedList()
  });

  const setMaxSlots = (nextMaxSlots) => {
    const previous = capacity;
    capacity = positiveInt(nextMaxSlots, capacity || 2);
    const started = drain();
    if (capacity !== previous && !started.length) emitChange();
    return { max: capacity, started };
  };

  const acquire = async ({
    runId,
    tabId = null,
    key = null,
    vendorId = null,
    kind = 'query',
    source = 'http',
    mode = 'fail-fast'
  } = {}) => {
    const normalizedRunId = normalizeString(runId);
    if (!normalizedRunId) throw new Error('missing_run_id');
    const request = {
      runId: normalizedRunId,
      tabId: normalizeString(tabId),
      key: normalizeString(key),
      vendorId: normalizeString(vendorId),
      kind: normalizeString(kind) || 'query',
      source: normalizeString(source) || 'http'
    };
    const existing = active.get(request.runId);
    if (existing) return cloneLease(existing);
    const queuedIndex = queueIndex(request.runId);
    if (queuedIndex !== -1) {
      const err = makeAdmissionError({
        reason: 'provider_slot_duplicate',
        activeLeases: activeList(),
        queued: queuedList()
      });
      err.data.position = queuedIndex + 1;
      throw err;
    }
    if (active.size < capacity) {
      const lease = startRequest(request);
      emitChange();
      return lease;
    }
    if (mode !== 'queue') {
      throw makeAdmissionError({
        activeLeases: activeList(),
        queued: queuedList()
      });
    }
    return await new Promise((resolve, reject) => {
      const entry = {
        ...request,
        queuedAt: now(),
        cancelled: false,
        resolve,
        reject
      };
      queue.push(entry);
      emitChange();
    });
  };

  const release = (runId) => {
    const id = normalizeString(runId);
    if (!id || !active.has(id)) return { released: false, started: [] };
    const lease = active.get(id);
    active.delete(id);
    const started = drain();
    emitChange();
    return { released: true, lease: cloneLease(lease), started };
  };

  const cancelQueued = (runId, { reason = 'cancelled' } = {}) => {
    const id = normalizeString(runId);
    const index = queueIndex(id);
    if (index === -1) return { cancelled: false };
    const [entry] = queue.splice(index, 1);
    entry.cancelled = true;
    entry.reject(makeCancelledError({ runId: id, reason }));
    emitChange();
    return { cancelled: true, entry: {
      runId: entry.runId,
      tabId: entry.tabId,
      key: entry.key,
      vendorId: entry.vendorId,
      kind: entry.kind,
      source: entry.source,
      queuedAt: entry.queuedAt
    } };
  };

  const heartbeat = (runId) => {
    const id = normalizeString(runId);
    const lease = id ? active.get(id) : null;
    if (!lease) return null;
    lease.heartbeatAt = now();
    emitChange();
    return cloneLease(lease);
  };

  const reapStale = ({ olderThanMs } = {}) => {
    const threshold = Math.max(0, Number(olderThanMs) || 0);
    if (!threshold) return [];
    const timestamp = now();
    const stale = [];
    for (const lease of active.values()) {
      if (timestamp - Number(lease.heartbeatAt || lease.acquiredAt || timestamp) > threshold) {
        stale.push(cloneLease(lease));
      }
    }
    for (const lease of stale) active.delete(lease.runId);
    if (stale.length) {
      drain();
      emitChange();
    }
    return stale;
  };

  const withLease = async (request, fn) => {
    const lease = await acquire(request);
    try {
      return await fn(lease);
    } finally {
      release(lease.runId);
    }
  };

  return {
    acquire,
    release,
    cancelQueued,
    heartbeat,
    reapStale,
    setMaxSlots,
    snapshot,
    withLease
  };
}
