import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  closeGrantedArchive,
  createGrantedArchiveFromFileHandle
} from './chatgpt-export-reader.mjs';
import { parseProfileScopeId } from './conversation-identity.mjs';

const MAX_SPENT_GRANTS = 1_000;
const MAX_CLOCK_MS = 8_640_000_000_000_000;
export const EXPORT_GRANT_ID_PATTERN = /^grant-[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,255})$/;

function grantError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function parseExportGrantId(value) {
  if (typeof value !== 'string' || !EXPORT_GRANT_ID_PATTERN.test(value)) {
    throw grantError('export_grant_invalid');
  }
  return value;
}

function numericNow(clock) {
  let value;
  try {
    value = Number(clock());
  } catch {
    throw grantError('export_grant_clock_invalid');
  }
  if (!Number.isFinite(value) || value < 0 || value > MAX_CLOCK_MS) {
    throw grantError('export_grant_clock_invalid');
  }
  return Math.floor(value);
}

function deadlineAfter(nowMs, ttlMs) {
  const deadline = nowMs + ttlMs;
  if (!Number.isSafeInteger(deadline) || deadline > MAX_CLOCK_MS) {
    throw grantError('export_grant_clock_invalid');
  }
  return deadline;
}

function sameStableFile(left, right) {
  if (
    !left || !right ||
    typeof left.isFile !== 'function' || typeof right.isFile !== 'function' ||
    !left.isFile() || !right.isFile()
  ) {
    return false;
  }
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    try {
      if (BigInt(left[field]) !== BigInt(right[field])) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function publicGrant(grant) {
  return Object.freeze({
    grantId: grant.id,
    displayName: grant.displayName,
    profileScopeId: grant.profileScopeId,
    expiresAt: new Date(grant.expiresAtMs).toISOString()
  });
}

export function createElectronExportImportGrants({
  dialog,
  fsOperations = fs,
  clock = () => Date.now(),
  monotonicClock = () => performance.now(),
  randomId = crypto.randomUUID,
  ttlMs = 10 * 60_000
} = {}) {
  if (!dialog || typeof dialog.showOpenDialog !== 'function') throw grantError('export_grant_dialog_required');
  if (!fsOperations || typeof fsOperations.open !== 'function') throw grantError('export_grant_filesystem_required');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60_000) {
    throw grantError('export_grant_ttl_invalid');
  }
  const pending = new Map();
  const spent = new Map();
  let lastMonotonicNowMs = null;
  let monotonicClockFailed = false;

  function readTimes() {
    if (monotonicClockFailed) throw grantError('export_grant_clock_invalid');
    const nowMs = numericNow(clock);
    let monotonicNowMs;
    try {
      monotonicNowMs = numericNow(monotonicClock);
      if (lastMonotonicNowMs !== null && monotonicNowMs < lastMonotonicNowMs) throw new Error();
    } catch {
      monotonicClockFailed = true;
      throw grantError('export_grant_clock_invalid');
    }
    lastMonotonicNowMs = monotonicNowMs;
    return { nowMs, monotonicNowMs };
  }

  function rememberSpent(id, status) {
    spent.set(id, { status });
    while (spent.size > MAX_SPENT_GRANTS) spent.delete(spent.keys().next().value);
  }

  async function closeHandle(grant) {
    try {
      await grant.fileHandle.close();
    } catch {}
  }

  async function expireStale(nowMs, monotonicNowMs) {
    const stale = [];
    for (const [id, grant] of pending) {
      if (
        grant.expiresAtMs > nowMs &&
        grant.expiresAtMonotonicMs > monotonicNowMs
      ) continue;
      pending.delete(id);
      rememberSpent(id, 'expired');
      stale.push(closeHandle(grant));
    }
    await Promise.all(stale);
  }

  async function request({ profileScopeId, browserWindow = null } = {}) {
    const scope = parseProfileScopeId(profileScopeId);
    if (monotonicClockFailed) throw grantError('export_grant_clock_invalid');
    const options = {
      title: 'Import ChatGPT export',
      buttonLabel: 'Grant one-time access',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archives', extensions: ['zip'] }]
    };
    let result;
    try {
      result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
    } catch {
      throw grantError('export_grant_picker_failed');
    }
    if (result?.canceled) return Object.freeze({ status: 'cancelled' });
    if (!Array.isArray(result?.filePaths) || result.filePaths.length !== 1) {
      throw grantError('export_grant_selection_invalid');
    }
    const selectedPath = result.filePaths[0];
    if (typeof selectedPath !== 'string' || path.extname(selectedPath).toLowerCase() !== '.zip') {
      throw grantError('export_grant_selection_invalid');
    }
    const flags = fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
      (typeof fsConstants.O_CLOEXEC === 'number' ? fsConstants.O_CLOEXEC : 0);
    let fileHandle;
    let stat;
    let selectedStat = null;
    try {
      if (typeof fsOperations.lstat === 'function') {
        selectedStat = await fsOperations.lstat(selectedPath, { bigint: true });
        if (selectedStat.isSymbolicLink()) throw grantError('export_grant_symlink');
        if (!selectedStat.isFile()) throw grantError('export_grant_unreadable');
      }
      fileHandle = await fsOperations.open(selectedPath, flags);
      stat = await fileHandle.stat({ bigint: true });
      if (!stat.isFile()) throw grantError('export_grant_unreadable');
      if (selectedStat && !sameStableFile(selectedStat, stat)) throw grantError('export_grant_moved');
    } catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => {});
      if (error?.code === 'ELOOP') throw grantError('export_grant_symlink');
      if (typeof error?.code === 'string' && error.code.startsWith('export_grant_')) throw error;
      throw grantError('export_grant_unreadable');
    }
    let grant;
    let publicResult;
    try {
      const times = readTimes();
      const expiresAtMs = deadlineAfter(times.nowMs, ttlMs);
      const expiresAtMonotonicMs = deadlineAfter(times.monotonicNowMs, ttlMs);
      await expireStale(times.nowMs, times.monotonicNowMs);
      const id = parseExportGrantId(`grant-${randomId()}`);
      if (pending.has(id) || spent.has(id)) throw grantError('export_grant_id_collision');
      grant = {
        id,
        fileHandle,
        expectedStat: stat,
        selectedPath,
        displayName: path.basename(selectedPath),
        profileScopeId: scope,
        expiresAtMs,
        expiresAtMonotonicMs
      };
      publicResult = Object.freeze({ status: 'granted', grant: publicGrant(grant) });
    } catch (error) {
      await fileHandle.close().catch(() => {});
      throw error;
    }
    pending.set(grant.id, grant);
    return publicResult;
  }

  async function consume(grantIdValue, profileScopeIdValue) {
    const id = parseExportGrantId(grantIdValue);
    const scope = parseProfileScopeId(profileScopeIdValue);
    const { nowMs, monotonicNowMs } = readTimes();
    const grant = pending.get(id);
    if (!grant) {
      const prior = spent.get(id);
      if (prior?.status === 'expired') throw grantError('export_grant_expired');
      if (prior) throw grantError('export_grant_reused');
      throw grantError('export_grant_not_found');
    }
    pending.delete(id);
    rememberSpent(id, 'consumed');
    if (
      grant.expiresAtMs <= nowMs ||
      grant.expiresAtMonotonicMs <= monotonicNowMs
    ) {
      spent.set(id, { status: 'expired' });
      await closeHandle(grant);
      throw grantError('export_grant_expired');
    }
    if (grant.profileScopeId !== scope) {
      await closeHandle(grant);
      throw grantError('export_grant_scope_mismatch');
    }
    try {
      if (typeof fsOperations.lstat === 'function') {
        let selectedStat;
        try {
          selectedStat = await fsOperations.lstat(grant.selectedPath, { bigint: true });
        } catch {
          throw grantError('export_grant_moved');
        }
        if (
          selectedStat.isSymbolicLink() ||
          !sameStableFile(selectedStat, grant.expectedStat)
        ) {
          throw grantError('export_grant_moved');
        }
      }
      return await createGrantedArchiveFromFileHandle({
        fileHandle: grant.fileHandle,
        displayName: grant.displayName,
        profileScopeId: grant.profileScopeId,
        expectedStat: grant.expectedStat
      });
    } catch (error) {
      await closeHandle(grant);
      if (error?.code === 'export_grant_moved') throw error;
      if (error?.code === 'export_archive_changed') throw grantError('export_grant_moved');
      throw grantError('export_grant_unreadable');
    }
  }

  async function close(archive) {
    await closeGrantedArchive(archive);
  }

  async function revoke(grantIdValue) {
    const id = parseExportGrantId(grantIdValue);
    const grant = pending.get(id);
    if (!grant) return false;
    pending.delete(id);
    rememberSpent(id, 'revoked');
    await closeHandle(grant);
    return true;
  }

  async function closeAll() {
    const grants = [...pending.values()];
    pending.clear();
    for (const grant of grants) rememberSpent(grant.id, 'revoked');
    await Promise.all(grants.map(closeHandle));
  }

  async function listPending() {
    const { nowMs, monotonicNowMs } = readTimes();
    await expireStale(nowMs, monotonicNowMs);
    return [...pending.values()]
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs || left.id.localeCompare(right.id))
      .map(publicGrant);
  }

  return Object.freeze({ request, consume, close, revoke, closeAll, listPending });
}
