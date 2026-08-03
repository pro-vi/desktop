import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

import {
  initialImportCursor,
  parseImportCursor,
  parseIsoDateTime,
  parseSha256
} from './conversation-catalog-contract.mjs';
import {
  parseChatGptConversationId,
  parseProfileScopeId
} from './conversation-identity.mjs';
import {
  TRANSCRIPT_TURN_MAX_TEXT_CHARS,
  normalizeTranscriptRawRole,
  parseTranscriptProviderMessageId
} from './transcript-contract.mjs';

const GRANTED_ARCHIVE = new WeakMap();
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAGS = 0x0041;
const SUPPORTED_FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG;
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_MESSAGE_GRAPH_NODES = 100_000;
export const MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS = 100_000;

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 8 * 1024 * 1024 * 1024,
  maxEntries: 100_000,
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 32 * 1024 * 1024 * 1024,
  maxTargetBytes: 4 * 1024 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024 * 1024,
  maxRecordBytes: 64 * 1024 * 1024,
  maxRecords: MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS,
  maxCompressionRatio: 500,
  maxDepth: 4,
  maxJsonDepth: 256,
  readChunkBytes: 64 * 1024
});

function readerError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeReaderError(error, fallback) {
  if (typeof error?.code === 'string' && error.code.startsWith('export_')) return error;
  return readerError(fallback);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimits(value = {}) {
  if (!isRecord(value)) throw readerError('export_reader_limits_invalid');
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key));
  if (unknown.length) throw readerError('export_reader_limits_invalid');
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw readerError('export_reader_limits_invalid');
    if (key === 'maxCompressionRatio' && limit > 100_000) throw readerError('export_reader_limits_invalid');
    if (key === 'maxRecords' && limit > MAX_CHATGPT_EXPORT_CONVERSATION_RECORDS) {
      throw readerError('export_reader_limits_invalid');
    }
  }
  if (
    limits.maxEntryBytes > limits.maxExpandedBytes ||
    limits.maxTargetBytes > limits.maxExpandedBytes ||
    limits.maxRecordBytes > limits.maxEntryBytes ||
    limits.readChunkBytes > limits.maxEntryBytes
  ) {
    throw readerError('export_reader_limits_invalid');
  }
  return Object.freeze(limits);
}

function normalizeStat(stat) {
  if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
    throw readerError('export_archive_unreadable');
  }
  const fields = ['dev', 'ino', 'size'];
  const normalized = {};
  for (const field of fields) {
    try {
      normalized[field] = BigInt(stat[field]);
    } catch {
      throw readerError('export_archive_unreadable');
    }
  }
  for (const field of ['mtimeNs', 'ctimeNs']) {
    if (stat[field] !== undefined) normalized[field] = BigInt(stat[field]);
    else {
      const millis = stat[field === 'mtimeNs' ? 'mtimeMs' : 'ctimeMs'];
      if (!Number.isFinite(Number(millis))) throw readerError('export_archive_unreadable');
      normalized[field] = BigInt(Math.trunc(Number(millis) * 1_000_000));
    }
  }
  if (normalized.size < 0n || normalized.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw readerError('export_unsafe_archive');
  }
  return Object.freeze(normalized);
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function parseDisplayName(value) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 255 ||
    value === '.' || value === '..' || value.includes('/') || value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw readerError('export_archive_name_invalid');
  }
  return value;
}

export async function createGrantedArchiveFromFileHandle({
  fileHandle,
  displayName,
  profileScopeId,
  expectedStat = null
} = {}) {
  if (!fileHandle || typeof fileHandle.read !== 'function' || typeof fileHandle.stat !== 'function') {
    throw readerError('export_archive_handle_required');
  }
  const selectedScope = parseProfileScopeId(profileScopeId);
  let currentStat;
  try {
    currentStat = normalizeStat(await fileHandle.stat({ bigint: true }));
  } catch (error) {
    throw safeReaderError(error, 'export_archive_unreadable');
  }
  if (expectedStat !== null) {
    const expected = normalizeStat(expectedStat);
    const comparableNanoseconds = expectedStat.mtimeNs !== undefined && expectedStat.ctimeNs !== undefined;
    if (
      currentStat.dev !== expected.dev || currentStat.ino !== expected.ino || currentStat.size !== expected.size ||
      (comparableNanoseconds && !sameStat(currentStat, expected))
    ) {
      throw readerError('export_archive_changed');
    }
  }
  const archive = Object.freeze({
    size: Number(currentStat.size),
    displayName: parseDisplayName(displayName),
    profileScopeId: selectedScope
  });
  GRANTED_ARCHIVE.set(archive, {
    fileHandle,
    selectedStat: currentStat,
    closed: false
  });
  return archive;
}

function archiveState(archive) {
  const state = GRANTED_ARCHIVE.get(archive);
  if (!state || state.closed) throw readerError('export_archive_grant_invalid');
  return state;
}

async function verifyStable(archive) {
  const state = archiveState(archive);
  let current;
  try {
    current = normalizeStat(await state.fileHandle.stat({ bigint: true }));
  } catch (error) {
    throw safeReaderError(error, 'export_archive_unreadable');
  }
  if (!sameStat(state.selectedStat, current)) throw readerError('export_archive_changed');
}

async function readRange(archive, offset, length) {
  if (
    !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
    offset + length > archive.size
  ) {
    throw readerError('export_corrupt_archive');
  }
  const state = archiveState(archive);
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  try {
    while (read < length) {
      const result = await state.fileHandle.read(buffer, read, length - read, offset + read);
      if (!result || result.bytesRead < 1) throw readerError('export_corrupt_archive');
      read += result.bytesRead;
    }
  } catch (error) {
    throw safeReaderError(error, 'export_archive_unreadable');
  }
  return buffer;
}

export async function closeGrantedArchive(archive) {
  const state = GRANTED_ARCHIVE.get(archive);
  if (!state || state.closed) return;
  // A failed POSIX close can still release the descriptor. Spend the grant
  // before awaiting it so a retry can never close an unrelated reused handle.
  state.closed = true;
  try {
    await state.fileHandle.close();
  } catch {
    throw readerError('export_archive_close_failed');
  }
}

function decodeZipName(bytes, flags) {
  if (bytes.length < 1 || bytes.length > 1024) throw readerError('export_unsafe_archive');
  if (!(flags & UTF8_FLAG) && bytes.some((byte) => byte > 0x7f)) {
    throw readerError('export_unsupported_layout');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw readerError('export_unsafe_archive');
  }
}

function validateZipName(name, maxDepth) {
  if (
    !name || name.includes('\u0000') || name.includes('\\') || name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw readerError('export_unsafe_archive');
  }
  const parts = name.split('/');
  const fileParts = name.endsWith('/') ? parts.slice(0, -1) : parts;
  if (
    fileParts.length < 1 || fileParts.length > maxDepth ||
    fileParts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw readerError('export_unsafe_archive');
  }
  return name;
}

function findEocd(tail, tailOffset, archiveSize) {
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    const absolute = tailOffset + index;
    if (absolute + 22 + commentLength === archiveSize) return { index, absolute };
  }
  throw readerError('export_not_a_zip');
}

function parseCentralDirectory(bytes, count, limits) {
  const entries = [];
  const names = new Set();
  let offset = 0;
  let totalExpanded = 0;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw readerError('export_corrupt_archive');
    }
    const madeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw readerError('export_corrupt_archive');
    if (
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff || diskStart !== 0
    ) {
      throw readerError('export_unsupported_layout');
    }
    if ((flags & ENCRYPTED_FLAGS) !== 0 || (flags & ~SUPPORTED_FLAGS) !== 0) {
      throw readerError('export_unsafe_archive');
    }
    if (method !== 0 && method !== 8) throw readerError('export_unsupported_layout');
    if (method === 0 && compressedSize !== uncompressedSize) throw readerError('export_corrupt_archive');
    if (uncompressedSize > limits.maxEntryBytes) throw readerError('export_unsafe_archive');
    const ratio = uncompressedSize === 0 ? 0 : uncompressedSize / Math.max(1, compressedSize);
    if (ratio > limits.maxCompressionRatio) throw readerError('export_unsafe_archive');
    totalExpanded += uncompressedSize;
    if (!Number.isSafeInteger(totalExpanded) || totalExpanded > limits.maxExpandedBytes) {
      throw readerError('export_unsafe_archive');
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = validateZipName(decodeZipName(nameBytes, flags), limits.maxDepth);
    if (names.has(name)) throw readerError('export_unsafe_archive');
    names.add(name);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const madeBySystem = madeBy >>> 8;
    if (madeBySystem === 3 && (unixMode & 0o170000) === 0o120000) {
      throw readerError('export_unsafe_archive');
    }
    entries.push({
      ordinal,
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: null,
      extentEnd: null
    });
    offset = end;
  }
  if (offset !== bytes.length) throw readerError('export_unsupported_layout');
  return entries;
}

async function resolveLocalEntries(archive, entries, centralOffset) {
  for (const entry of entries) {
    if (entry.localHeaderOffset + 30 > centralOffset) throw readerError('export_corrupt_archive');
    const header = await readRange(archive, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw readerError('export_corrupt_archive');
    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    const crc32 = header.readUInt32LE(14);
    const compressedSize = header.readUInt32LE(18);
    const uncompressedSize = header.readUInt32LE(22);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    if (flags !== entry.flags || method !== entry.method || nameLength !== entry.nameBytes.length) {
      throw readerError('export_corrupt_archive');
    }
    const variable = await readRange(archive, entry.localHeaderOffset + 30, nameLength + extraLength);
    if (!variable.subarray(0, nameLength).equals(entry.nameBytes)) throw readerError('export_corrupt_archive');
    if (!(flags & DATA_DESCRIPTOR_FLAG) && (
      crc32 !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize
    )) {
      throw readerError('export_corrupt_archive');
    }
    if ((flags & DATA_DESCRIPTOR_FLAG) && (
      (crc32 !== 0 && crc32 !== entry.crc32) ||
      (compressedSize !== 0 && compressedSize !== entry.compressedSize) ||
      (uncompressedSize !== 0 && uncompressedSize !== entry.uncompressedSize)
    )) {
      throw readerError('export_corrupt_archive');
    }
    entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    let extentEnd = entry.dataOffset + entry.compressedSize;
    if (flags & DATA_DESCRIPTOR_FLAG) {
      if (extentEnd + 12 > centralOffset) throw readerError('export_corrupt_archive');
      const descriptor = await readRange(archive, extentEnd, Math.min(16, centralOffset - extentEnd));
      let descriptorOffset = 0;
      if (descriptor.length >= 16 && descriptor.readUInt32LE(0) === DATA_DESCRIPTOR_SIGNATURE) descriptorOffset = 4;
      if (descriptor.length < descriptorOffset + 12) throw readerError('export_corrupt_archive');
      if (
        descriptor.readUInt32LE(descriptorOffset) !== entry.crc32 ||
        descriptor.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize ||
        descriptor.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize
      ) {
        throw readerError('export_corrupt_archive');
      }
      extentEnd += descriptorOffset + 12;
    }
    if (extentEnd > centralOffset) throw readerError('export_corrupt_archive');
    entry.extentEnd = extentEnd;
  }
  const byOffset = entries.slice().sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  for (let index = 1; index < byOffset.length; index += 1) {
    if (byOffset[index].localHeaderOffset < byOffset[index - 1].extentEnd) {
      throw readerError('export_unsafe_archive');
    }
  }
}

function selectConversationEntries(entries, limits) {
  const candidates = [];
  const singlePattern = /^(|personal\/conversations\/)conversations\.json$/;
  const numberedPattern = /^(|personal\/conversations\/)conversations-(\d{3,})\.json$/;
  for (const entry of entries) {
    let match = entry.name.match(singlePattern);
    if (match) {
      candidates.push({ entry, root: match[1], kind: 'single', number: null });
      continue;
    }
    match = entry.name.match(numberedPattern);
    if (match) candidates.push({ entry, root: match[1], kind: 'numbered', number: Number(match[2]) });
  }
  if (!candidates.length) throw readerError('export_unsupported_layout');
  const roots = new Set(candidates.map(({ root }) => root));
  const kinds = new Set(candidates.map(({ kind }) => kind));
  if (roots.size !== 1 || kinds.size !== 1) throw readerError('export_unsupported_layout');
  let selected;
  let layout;
  if (candidates[0].kind === 'single') {
    if (candidates.length !== 1) throw readerError('export_unsupported_layout');
    selected = [candidates[0].entry];
    layout = 'single-conversations-json';
  } else {
    selected = candidates.slice().sort((left, right) => left.number - right.number);
    if (selected.some((candidate, index) => candidate.number !== index)) {
      throw readerError('export_unsupported_layout');
    }
    selected = selected.map(({ entry }) => entry);
    layout = 'numbered-conversations-json';
  }
  const targetBytes = selected.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (!Number.isSafeInteger(targetBytes) || targetBytes > limits.maxTargetBytes) {
    throw readerError('export_unsafe_archive');
  }
  return { selected, layout };
}

async function hashArchive(archive, chunkBytes) {
  const hash = crypto.createHash('sha256');
  for (let offset = 0; offset < archive.size; offset += chunkBytes) {
    hash.update(await readRange(archive, offset, Math.min(chunkBytes, archive.size - offset)));
  }
  return parseSha256(hash.digest('hex'), 'archiveHash');
}

async function inspectZip(archive, limits) {
  if (archive.size < 22) throw readerError('export_not_a_zip');
  if (archive.size > limits.maxArchiveBytes) throw readerError('export_unsafe_archive');
  await verifyStable(archive);
  const archiveHash = await hashArchive(archive, limits.readChunkBytes);
  await verifyStable(archive);
  const tailLength = Math.min(archive.size, 22 + MAX_ZIP_COMMENT_BYTES);
  const tailOffset = archive.size - tailLength;
  const tail = await readRange(archive, tailOffset, tailLength);
  const eocd = findEocd(tail, tailOffset, archive.size);
  const diskNumber = tail.readUInt16LE(eocd.index + 4);
  const centralDisk = tail.readUInt16LE(eocd.index + 6);
  const diskEntries = tail.readUInt16LE(eocd.index + 8);
  const totalEntries = tail.readUInt16LE(eocd.index + 10);
  const centralSize = tail.readUInt32LE(eocd.index + 12);
  const centralOffset = tail.readUInt32LE(eocd.index + 16);
  if (
    diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries ||
    totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
  ) {
    throw readerError('export_unsupported_layout');
  }
  if (
    totalEntries < 1 || totalEntries > limits.maxEntries ||
    centralSize < 46 || centralSize > limits.maxCentralDirectoryBytes ||
    centralOffset + centralSize !== eocd.absolute
  ) {
    throw readerError(totalEntries > limits.maxEntries || centralSize > limits.maxCentralDirectoryBytes
      ? 'export_unsafe_archive'
      : 'export_corrupt_archive');
  }
  const centralBytes = await readRange(archive, centralOffset, centralSize);
  const entries = parseCentralDirectory(centralBytes, totalEntries, limits);
  await resolveLocalEntries(archive, entries, centralOffset);
  const { selected, layout } = selectConversationEntries(entries, limits);
  await verifyStable(archive);
  return { archiveHash, layout, accountHint: null, entries, selected };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function* compressedEntryChunks(archive, entry, chunkBytes) {
  let remaining = entry.compressedSize;
  let offset = entry.dataOffset;
  while (remaining > 0) {
    const length = Math.min(remaining, chunkBytes);
    yield await readRange(archive, offset, length);
    offset += length;
    remaining -= length;
  }
}

async function* uncompressedEntryChunks(archive, entry, limits) {
  await verifyStable(archive);
  const source = Readable.from(compressedEntryChunks(archive, entry, limits.readChunkBytes));
  const output = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
  let size = 0;
  let crc = 0xffffffff;
  try {
    for await (const value of output) {
      const bytes = Buffer.from(value);
      size += bytes.length;
      if (size > entry.uncompressedSize || size > limits.maxEntryBytes) {
        throw readerError('export_unsafe_archive');
      }
      crc = updateCrc32(crc, bytes);
      yield bytes;
    }
  } catch (error) {
    source.destroy();
    output.destroy();
    throw safeReaderError(error, 'export_corrupt_archive');
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  if (size !== entry.uncompressedSize || crc !== entry.crc32) {
    throw readerError('export_corrupt_archive');
  }
  await verifyStable(archive);
}

function isJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function assertNoDuplicateJsonObjectMembers(text) {
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      stack.push({ kind: 'object', keys: new Set() });
      continue;
    }
    if (character === '[') {
      stack.push({ kind: 'array' });
      continue;
    }
    if (character === '}' || character === ']') {
      stack.pop();
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    let escaped = false;
    for (index += 1; index < text.length; index += 1) {
      const stringCharacter = text[index];
      if (escaped) {
        escaped = false;
      } else if (stringCharacter === '\\') {
        escaped = true;
      } else if (stringCharacter === '"') {
        break;
      }
    }
    let next = index + 1;
    while (next < text.length && /[\u0020\u0009\u000a\u000d]/.test(text[next])) next += 1;
    if (text[next] !== ':') continue;
    const object = stack.at(-1);
    if (object?.kind !== 'object') continue;
    let key;
    try {
      key = JSON.parse(text.slice(start, index + 1));
    } catch {
      throw readerError('export_corrupt_json');
    }
    if (object.keys.has(key)) throw readerError('export_corrupt_json');
    object.keys.add(key);
  }
}

async function* streamJsonArrayRecords(chunks, limits) {
  let state = 'before-array';
  let canEndArray = true;
  let inRecord = false;
  let inString = false;
  let escaped = false;
  let recordBytes = 0;
  let recordStart = null;
  let parts = [];
  let stack = [];

  for await (const rawChunk of chunks) {
    const chunk = Buffer.from(rawChunk);
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];
      if (inRecord) {
        recordBytes += 1;
        if (recordBytes > limits.maxRecordBytes) throw readerError('export_unsafe_archive');
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === 0x5c) escaped = true;
          else if (byte === 0x22) inString = false;
        } else if (byte === 0x22) {
          inString = true;
        } else if (byte === 0x7b || byte === 0x5b) {
          stack.push(byte);
          if (stack.length > limits.maxJsonDepth) throw readerError('export_unsafe_archive');
        } else if (byte === 0x7d || byte === 0x5d) {
          const expected = byte === 0x7d ? 0x7b : 0x5b;
          if (stack.pop() !== expected) throw readerError('export_corrupt_json');
          if (stack.length === 0) {
            parts.push(chunk.subarray(recordStart, index + 1));
            const rawRecord = Buffer.concat(parts, recordBytes);
            let value;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(rawRecord);
              assertNoDuplicateJsonObjectMembers(text);
              value = JSON.parse(text);
            } catch {
              throw readerError('export_corrupt_json');
            }
            if (!isRecord(value)) throw readerError('export_corrupt_json');
            yield { rawRecord, value };
            inRecord = false;
            recordStart = null;
            parts = [];
            recordBytes = 0;
            state = 'comma-or-end';
          }
        }
        continue;
      }

      if (state === 'before-array') {
        if (isJsonWhitespace(byte)) continue;
        if (byte !== 0x5b) throw readerError('export_corrupt_json');
        state = 'value-or-end';
        canEndArray = true;
        continue;
      }
      if (state === 'value-or-end') {
        if (isJsonWhitespace(byte)) continue;
        if (byte === 0x5d && canEndArray) {
          state = 'after-array';
          continue;
        }
        if (byte !== 0x7b) throw readerError('export_corrupt_json');
        inRecord = true;
        inString = false;
        escaped = false;
        recordBytes = 1;
        recordStart = index;
        parts = [];
        stack = [0x7b];
        continue;
      }
      if (state === 'comma-or-end') {
        if (isJsonWhitespace(byte)) continue;
        if (byte === 0x2c) {
          state = 'value-or-end';
          canEndArray = false;
          continue;
        }
        if (byte === 0x5d) {
          state = 'after-array';
          continue;
        }
        throw readerError('export_corrupt_json');
      }
      if (state === 'after-array') {
        if (!isJsonWhitespace(byte)) throw readerError('export_corrupt_json');
      }
    }
    if (inRecord && recordStart !== null) {
      parts.push(chunk.subarray(recordStart));
      recordStart = 0;
    }
  }
  if (inRecord || inString || state !== 'after-array') throw readerError('export_corrupt_json');
}

function safeTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (!title || title.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)) return null;
  return title;
}

function observedAtFor(record) {
  for (const field of ['update_time', 'create_time']) {
    const seconds = record[field];
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) continue;
    const millis = seconds * 1000;
    if (!Number.isFinite(millis) || millis > 8_640_000_000_000_000) continue;
    try {
      return parseIsoDateTime(new Date(millis).toISOString());
    } catch {}
  }
  return '1970-01-01T00:00:00.000Z';
}

function identityForRecord(record, profileScopeId) {
  const hasId = Object.hasOwn(record, 'id');
  const hasConversationId = Object.hasOwn(record, 'conversation_id');
  if (!hasId && !hasConversationId) return null;
  if (
    (hasId && typeof record.id !== 'string') ||
    (hasConversationId && typeof record.conversation_id !== 'string') ||
    (hasId && hasConversationId && record.id !== record.conversation_id)
  ) {
    throw readerError('export_malformed_identity');
  }
  const value = hasId ? record.id : record.conversation_id;
  let providerConversationId;
  try {
    providerConversationId = parseChatGptConversationId(value);
  } catch {
    throw readerError('export_malformed_identity');
  }
  return Object.freeze({ provider: 'chatgpt', profileScopeId, providerConversationId });
}

function graphNodes(record) {
  if (!isRecord(record.mapping) || Object.keys(record.mapping).length > MAX_MESSAGE_GRAPH_NODES) {
    throw readerError('message-graph-invalid');
  }
  const nodes = new Map();
  for (const [key, value] of Object.entries(record.mapping)) {
    if (!isRecord(value) || value.id !== key || (value.parent !== null && typeof value.parent !== 'string')) {
      throw readerError('message-graph-invalid');
    }
    if (!Array.isArray(value.children) || value.children.some((child) => typeof child !== 'string')) {
      throw readerError('message-graph-invalid');
    }
    if (new Set(value.children).size !== value.children.length) throw readerError('message-graph-invalid');
    nodes.set(key, value);
  }
  for (const [id, node] of nodes) {
    if (node.parent !== null && !nodes.has(node.parent)) throw readerError('message-graph-invalid');
    for (const childId of node.children) {
      const child = nodes.get(childId);
      if (!child || child.parent !== id) throw readerError('message-graph-invalid');
    }
  }
  const roots = Array.from(nodes, ([id, node]) => node.parent === null ? id : null).filter(Boolean);
  if (roots.length !== 1) throw readerError('message-graph-invalid');
  const colors = new Map();
  const stack = [{ id: roots[0], leaving: false }];
  while (stack.length) {
    const frame = stack.pop();
    const color = colors.get(frame.id) || 'unvisited';
    if (frame.leaving) {
      colors.set(frame.id, 'visited');
      continue;
    }
    if (color === 'visiting') throw readerError('message-graph-invalid');
    if (color === 'visited') continue;
    colors.set(frame.id, 'visiting');
    stack.push({ id: frame.id, leaving: true });
    const children = nodes.get(frame.id).children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childId = children[index];
      if (colors.get(childId) === 'visiting') throw readerError('message-graph-invalid');
      stack.push({ id: childId, leaving: false });
    }
  }
  if (colors.size !== nodes.size) throw readerError('message-graph-invalid');
  return nodes;
}

function decodeActiveBranch(record) {
  if (typeof record.current_node !== 'string' || !record.current_node) {
    return { status: 'catalog-only', reason: 'active-branch-ambiguous' };
  }
  let nodes;
  try {
    nodes = graphNodes(record);
  } catch {
    return { status: 'catalog-only', reason: 'message-graph-invalid' };
  }
  if (!nodes.has(record.current_node)) {
    return { status: 'catalog-only', reason: 'message-graph-invalid' };
  }
  const chain = [];
  const visited = new Set();
  let currentId = record.current_node;
  while (currentId !== null) {
    if (visited.has(currentId) || chain.length >= MAX_MESSAGE_GRAPH_NODES) {
      return { status: 'catalog-only', reason: 'message-graph-invalid' };
    }
    visited.add(currentId);
    const node = nodes.get(currentId);
    if (!node) return { status: 'catalog-only', reason: 'message-graph-invalid' };
    chain.push(node);
    currentId = node.parent;
  }
  chain.reverse();
  const rawTurns = [];
  const messageIds = [];
  for (const node of chain) {
    if (node.message === null) continue;
    const message = node.message;
    if (
      !isRecord(message) || message.id !== node.id || !isRecord(message.author) ||
      !isRecord(message.content) || message.content.content_type !== 'text' ||
      !Array.isArray(message.content.parts) || message.content.parts.length < 1 ||
      message.content.parts.some((part) => typeof part !== 'string')
    ) {
      return { status: 'catalog-only', reason: 'unsupported-content' };
    }
    try {
      normalizeTranscriptRawRole(message.author.role);
    } catch {
      return { status: 'catalog-only', reason: 'unsupported-content' };
    }
    let providerMessageId;
    try {
      providerMessageId = parseTranscriptProviderMessageId(message.id);
    } catch {
      return { status: 'catalog-only', reason: 'message-graph-invalid' };
    }
    const text = message.content.parts.join('\n');
    if (text.length > TRANSCRIPT_TURN_MAX_TEXT_CHARS || text.includes('\u0000')) {
      return { status: 'catalog-only', reason: 'unsupported-content' };
    }
    const normalizedText = text.replace(/\r\n?/g, '\n').normalize('NFC').trim();
    if (!normalizedText || normalizedText.length > TRANSCRIPT_TURN_MAX_TEXT_CHARS) {
      return { status: 'catalog-only', reason: 'unsupported-content' };
    }
    const ordinal = rawTurns.length;
    rawTurns.push(Object.freeze({ ordinal, providerMessageId, role: message.author.role, text }));
    messageIds.push(providerMessageId);
  }
  if (!rawTurns.length || messageIds.at(-1) !== record.current_node) {
    return { status: 'catalog-only', reason: 'unsupported-content' };
  }
  return {
    status: 'complete',
    rawTurns: Object.freeze(rawTurns),
    activeBranchEvidence: Object.freeze({
      kind: 'active-node-chain',
      activeNodeId: messageIds.at(-1),
      messageIds: Object.freeze(messageIds)
    })
  };
}

function decodeArchiveConversation({ rawRecord, value }, profileScopeId) {
  const observedAt = observedAtFor(value);
  const title = safeTitle(value.title);
  const identity = identityForRecord(value, profileScopeId);
  if (identity === null) {
    return Object.freeze({
      status: 'catalog-only',
      identity: null,
      title,
      reason: 'provider-id-missing',
      rawRecord,
      observedAt
    });
  }
  const branch = decodeActiveBranch(value);
  if (branch.status !== 'complete') {
    return Object.freeze({
      status: 'catalog-only',
      identity,
      title,
      reason: branch.reason,
      rawRecord,
      observedAt
    });
  }
  return Object.freeze({
    status: 'complete',
    identity,
    title,
    rawRecord,
    rawTurns: branch.rawTurns,
    activeBranchEvidence: branch.activeBranchEvidence,
    observedAt
  });
}

async function accountHintFor(archive, inspection, limits) {
  const userEntries = inspection.entries.filter(({ name }) => name === 'user.json');
  if (userEntries.length !== 1 || userEntries[0].uncompressedSize > 1024 * 1024) return null;
  const entry = userEntries[0];
  const chunks = [];
  let total = 0;
  for await (const chunk of uncompressedEntryChunks(archive, entry, limits)) {
    total += chunk.length;
    if (total > 1024 * 1024) return null;
    chunks.push(chunk);
  }
  let user;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    assertNoDuplicateJsonObjectMembers(text);
    user = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(user) || typeof user.id !== 'string' || user.id.length < 1 || user.id.length > 512) return null;
  const digest = crypto.createHash('sha256').update('chatgpt-user-id:v1\0').update(user.id).digest('hex');
  return `chatgpt-user-id:sha256:${digest}`;
}

export function createChatGptExportReader({ limits: limitsValue = {} } = {}) {
  const limits = normalizeLimits(limitsValue);
  const inspectionCache = new WeakMap();

  async function inspectionFor(archive) {
    archiveState(archive);
    const cached = inspectionCache.get(archive);
    if (cached) return cached;
    let inspection;
    try {
      inspection = await inspectZip(archive, limits);
      inspection.accountHint = await accountHintFor(archive, inspection, limits);
      await verifyStable(archive);
    } catch (error) {
      throw safeReaderError(error, 'export_corrupt_archive');
    }
    inspectionCache.set(archive, inspection);
    return inspection;
  }

  async function inspect(archive) {
    const inspection = await inspectionFor(archive);
    return Object.freeze({
      archiveHash: inspection.archiveHash,
      layout: inspection.layout,
      accountHint: inspection.accountHint
    });
  }

  async function* streamConversations(archive, profileScopeId, cursorValue = initialImportCursor()) {
    archiveState(archive);
    const scope = parseProfileScopeId(profileScopeId);
    if (scope !== archive.profileScopeId) throw readerError('export_scope_mismatch');
    let cursor;
    try {
      cursor = parseImportCursor(cursorValue);
    } catch {
      throw readerError('export_cursor_invalid');
    }
    const inspection = await inspectionFor(archive);
    let recordIndex = 0;
    for (const entry of inspection.selected) {
      // The chunk iterator certifies stable size and CRC when it completes.
      // Consumers without a completed stable preflight must exhaust this stream
      // before publication; pre-inflating here would add I/O without stronger evidence.
      const chunks = uncompressedEntryChunks(archive, entry, limits);
      for await (const framed of streamJsonArrayRecords(chunks, limits)) {
        if (recordIndex >= limits.maxRecords) throw readerError('export_unsafe_archive');
        if (recordIndex >= cursor.recordIndex) {
          yield decodeArchiveConversation(framed, scope);
        }
        recordIndex += 1;
      }
    }
    if (cursor.recordIndex > recordIndex) throw readerError('export_cursor_invalid');
  }

  return Object.freeze({ inspect, streamConversations, limits });
}
