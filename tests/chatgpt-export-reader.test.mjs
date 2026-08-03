import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  closeGrantedArchive,
  createChatGptExportReader,
  createGrantedArchiveFromFileHandle
} from '../chatgpt-export-reader.mjs';
import { TRANSCRIPT_TURN_MAX_TEXT_CHARS } from '../transcript-contract.mjs';
import { buildZip } from './fixtures/zip-archive.mjs';

const PROFILE_SCOPE_ID = 'profile-main';
const CREATE_TIME = Date.parse('2026-07-30T12:00:00.000Z') / 1000;
const UPDATE_TIME = Date.parse('2026-07-30T12:05:00.000Z') / 1000;
const OBSERVED_AT = '2026-07-30T12:05:00.000Z';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function message(id, role, text) {
  return {
    id,
    author: { role, name: null, metadata: {} },
    create_time: CREATE_TIME,
    update_time: null,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: {},
    recipient: 'all'
  };
}

function conversationRecord({
  conversationId = 'conversation-alpha',
  title = 'Alpha conversation',
  userText = 'First user turn',
  assistantText = 'Chosen assistant turn',
  includeInactiveBranch = true
} = {}) {
  const rootId = `${conversationId}-root`;
  const userId = `${conversationId}-user`;
  const assistantId = `${conversationId}-assistant`;
  const inactiveId = `${conversationId}-inactive`;
  const children = includeInactiveBranch ? [assistantId, inactiveId] : [assistantId];
  const mapping = {
    [rootId]: { id: rootId, message: null, parent: null, children: [userId] },
    [userId]: {
      id: userId,
      message: message(userId, 'user', userText),
      parent: rootId,
      children
    },
    [assistantId]: {
      id: assistantId,
      message: message(assistantId, 'assistant', assistantText),
      parent: userId,
      children: []
    }
  };
  if (includeInactiveBranch) {
    mapping[inactiveId] = {
      id: inactiveId,
      message: message(inactiveId, 'assistant', 'This inactive branch must not be captured'),
      parent: userId,
      children: []
    };
  }
  return {
    id: conversationId,
    conversation_id: conversationId,
    title,
    create_time: CREATE_TIME,
    update_time: UPDATE_TIME,
    current_node: assistantId,
    mapping,
    default_model_slug: 'gpt-5',
    is_archived: false
  };
}

function recordsJson(records) {
  return Buffer.from(`\n[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`);
}

function expectedIdentity(conversationId) {
  return {
    provider: 'chatgpt',
    profileScopeId: PROFILE_SCOPE_ID,
    providerConversationId: conversationId
  };
}

function expectedComplete(record) {
  const userId = `${record.id}-user`;
  const assistantId = `${record.id}-assistant`;
  return {
    status: 'complete',
    identity: expectedIdentity(record.id),
    title: record.title,
    rawRecord: Buffer.from(JSON.stringify(record)),
    rawTurns: [
      {
        ordinal: 0,
        providerMessageId: userId,
        role: 'user',
        text: record.mapping[userId].message.content.parts[0]
      },
      {
        ordinal: 1,
        providerMessageId: assistantId,
        role: 'assistant',
        text: record.mapping[assistantId].message.content.parts[0]
      }
    ],
    activeBranchEvidence: {
      kind: 'active-node-chain',
      activeNodeId: assistantId,
      messageIds: [userId, assistantId]
    },
    observedAt: OBSERVED_AT
  };
}

async function grantedArchive(t, zipBytes, {
  profileScopeId = PROFILE_SCOPE_ID,
  displayName = 'OpenAI-export.zip',
  onRead = null
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chatgpt-export-reader-'));
  const archivePath = path.join(directory, 'selected.zip');
  await fs.writeFile(archivePath, zipBytes, { mode: 0o600 });
  const realFileHandle = await fs.open(archivePath, 'r');
  const fileHandle = onRead
    ? {
        stat: async (...args) => await realFileHandle.stat(...args),
        read: async (...args) => {
          const result = await realFileHandle.read(...args);
          onRead(result.bytesRead, args[3]);
          return result;
        },
        close: async () => await realFileHandle.close()
      }
    : realFileHandle;
  const expectedStat = await fileHandle.stat();
  let archive;
  try {
    archive = createGrantedArchiveFromFileHandle({
      fileHandle,
      displayName,
      profileScopeId,
      expectedStat
    });
  } catch (error) {
    await fileHandle.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await closeGrantedArchive(archive).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return archive;
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function errorHasCode(pattern, forbidden = []) {
  return (error) => {
    assert.equal(typeof error?.code, 'string');
    assert.match(error.code, pattern);
    const exposed = `${error.message}\n${JSON.stringify(error.data ?? null)}`;
    for (const value of forbidden) assert.equal(exposed.includes(value), false);
    return true;
  };
}

test('chatgpt export reader: an indeterminate close failure is symbolic and never retried', async (t) => {
  const privateMarker = 'private close failure marker';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-chatgpt-export-close-'));
  const archivePath = path.join(directory, 'selected.zip');
  await fs.writeFile(archivePath, buildZip([
    { name: 'conversations.json', data: recordsJson([conversationRecord()]) }
  ]), { mode: 0o600 });
  const realFileHandle = await fs.open(archivePath, 'r');
  t.after(async () => {
    await realFileHandle.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  let closeCalls = 0;
  const fileHandle = {
    stat: async (...args) => await realFileHandle.stat(...args),
    read: async (...args) => await realFileHandle.read(...args),
    async close() {
      closeCalls += 1;
      await realFileHandle.close();
      throw Object.assign(new Error(privateMarker), { code: 'EIO' });
    }
  };
  const archive = await createGrantedArchiveFromFileHandle({
    fileHandle,
    displayName: 'selected.zip',
    profileScopeId: PROFILE_SCOPE_ID,
    expectedStat: await fileHandle.stat()
  });

  await assert.rejects(
    () => closeGrantedArchive(archive),
    (error) => {
      assert.equal(error?.code, 'export_archive_close_failed');
      assert.equal(error?.message, 'export_archive_close_failed');
      assert.equal(`${error?.message}\n${JSON.stringify(error?.data ?? null)}`.includes(privateMarker), false);
      return true;
    }
  );
  assert.equal(closeCalls, 1);

  await closeGrantedArchive(archive);
  assert.equal(closeCalls, 1);
});

test('chatgpt export reader: inspects a real single-file ZIP and decodes only the exact active branch', async (t) => {
  const record = conversationRecord();
  const accountId = 'user-private-stable-id';
  const zipBytes = buildZip([
    { name: 'conversations.json', data: recordsJson([record]), method: 'store' },
    {
      name: 'user.json',
      data: JSON.stringify({
        id: accountId,
        email: 'private-account@example.test',
        phone_number: null,
        birth_year: 1980,
        chatgpt_plus_user: true
      }),
      method: 'store'
    }
  ]);
  const archive = await grantedArchive(t, zipBytes);
  const reader = createChatGptExportReader({ limits: { readChunkBytes: 17 } });

  const manifest = await reader.inspect(archive);
  assert.equal(manifest.archiveHash, sha256(zipBytes));
  assert.equal(manifest.layout, 'single-conversations-json');
  assert.match(manifest.accountHint, /^chatgpt-user-id:sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(accountId), false);
  assert.equal(JSON.stringify(manifest).includes('private-account@example.test'), false);

  const decoded = await collect(reader.streamConversations(archive, PROFILE_SCOPE_ID));
  assert.deepEqual(decoded, [expectedComplete(record)]);
  assert.equal(decoded[0].rawRecord.includes(Buffer.from('inactive branch must not be captured')), true);
  assert.equal(decoded[0].rawTurns.some(({ text }) => text.includes('inactive branch')), false);
});

test('chatgpt export reader: extended-year timestamps fall through to canonical deterministic evidence', async (t) => {
  const fallsBackToCreate = conversationRecord({ conversationId: 'conversation-extended-update' });
  fallsBackToCreate.update_time = 300_000_000_000;
  const fallsBackToEpoch = conversationRecord({ conversationId: 'conversation-extended-both' });
  fallsBackToEpoch.update_time = 300_000_000_000;
  fallsBackToEpoch.create_time = 300_000_000_000;
  const canonicalFuture = conversationRecord({ conversationId: 'conversation-canonical-future' });
  canonicalFuture.update_time = Date.parse('9999-01-01T00:00:00.000Z') / 1000;
  const archive = await grantedArchive(t, buildZip([{
    name: 'conversations.json',
    data: recordsJson([fallsBackToCreate, fallsBackToEpoch, canonicalFuture]),
    method: 'deflate'
  }]));

  const decoded = await collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID));

  assert.deepEqual(decoded.map(({ observedAt }) => observedAt), [
    '2026-07-30T12:00:00.000Z',
    '1970-01-01T00:00:00.000Z',
    '9999-01-01T00:00:00.000Z'
  ]);
});

test('chatgpt export reader: streams zero-based deflated shards in numeric order and resumes by global cursor', async (t) => {
  const first = conversationRecord({ conversationId: 'conversation-000' });
  const second = conversationRecord({ conversationId: 'conversation-001' });
  const third = conversationRecord({ conversationId: 'conversation-002' });
  const zipBytes = buildZip([
    { name: 'conversations-001.json', data: recordsJson([third]), method: 'deflate' },
    { name: 'conversations-000.json', data: recordsJson([first, second]), method: 'deflate' }
  ]);
  const archive = await grantedArchive(t, zipBytes);
  const reader = createChatGptExportReader();

  assert.deepEqual(await reader.inspect(archive), {
    archiveHash: sha256(zipBytes),
    layout: 'numbered-conversations-json',
    accountHint: null
  });
  assert.deepEqual(
    await collect(reader.streamConversations(archive, PROFILE_SCOPE_ID)),
    [expectedComplete(first), expectedComplete(second), expectedComplete(third)]
  );
  assert.deepEqual(
    await collect(reader.streamConversations(
      archive,
      PROFILE_SCOPE_ID,
      { schemaVersion: 1, recordIndex: 1 }
    )),
    [expectedComplete(second), expectedComplete(third)]
  );
});

test('chatgpt export reader: each completed stream traverses selected entry bytes exactly once', async (t) => {
  let bytesRead = 0;
  const conversations = recordsJson([
    conversationRecord({ assistantText: 'A'.repeat(4096) })
  ]);
  const archive = await grantedArchive(t, buildZip([{
    name: 'conversations.json',
    data: conversations,
    method: 'store'
  }]), { onRead: (count) => { bytesRead += count; } });
  const reader = createChatGptExportReader({ limits: { readChunkBytes: 17 } });
  await reader.inspect(archive);

  const beforeFirst = bytesRead;
  await collect(reader.streamConversations(archive, PROFILE_SCOPE_ID));
  const firstPassBytes = bytesRead - beforeFirst;
  const beforeReplay = bytesRead;
  await collect(reader.streamConversations(archive, PROFILE_SCOPE_ID));
  const replayBytes = bytesRead - beforeReplay;

  assert.equal(firstPassBytes, conversations.length);
  assert.equal(replayBytes, conversations.length);
});

test('chatgpt export reader: bounded account hints are parsed in one entry traversal', async (t) => {
  const userName = 'user.json';
  const userBytes = Buffer.from(JSON.stringify({
    id: 'stable-private-account-id',
    email: 'private-account@example.test'
  }));
  const conversations = recordsJson([
    conversationRecord({ assistantText: 'A'.repeat(128 * 1024) })
  ]);
  const userDataOffset = 30 + Buffer.byteLength(userName);
  const userDataEnd = userDataOffset + userBytes.length;
  let userBytesRead = 0;
  const archive = await grantedArchive(t, buildZip([
    { name: userName, data: userBytes, method: 'store' },
    { name: 'conversations.json', data: conversations, method: 'store' }
  ]), {
    onRead(count, position) {
      const readStart = position;
      const readEnd = position + count;
      userBytesRead += Math.max(0, Math.min(readEnd, userDataEnd) - Math.max(readStart, userDataOffset));
    }
  });

  const manifest = await createChatGptExportReader({
    limits: { readChunkBytes: 64 * 1024 }
  }).inspect(archive);

  assert.match(manifest.accountHint, /^chatgpt-user-id:sha256:[a-f0-9]{64}$/);
  assert.equal(userBytesRead, userBytes.length * 2, 'archive hash plus one account-hint traversal');
});

test('chatgpt export reader: inspection caches never cross reader safety limits', async (t) => {
  const archive = await grantedArchive(t, buildZip([{
    name: 'conversations.json',
    data: recordsJson([conversationRecord()]),
    method: 'store'
  }]));
  await createChatGptExportReader().inspect(archive);

  await assert.rejects(
    createChatGptExportReader({ limits: { maxArchiveBytes: 1 } }).inspect(archive),
    errorHasCode(/unsafe/)
  );
});

test('chatgpt export reader: scope binding and cursor parsing fail closed', async (t) => {
  const record = conversationRecord();
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([record]) }
  ]));
  const reader = createChatGptExportReader();
  await reader.inspect(archive);

  await assert.rejects(
    collect(reader.streamConversations(archive, 'different-profile')),
    errorHasCode(/scope/)
  );
  await assert.rejects(
    collect(reader.streamConversations(
      archive,
      PROFILE_SCOPE_ID,
      { schemaVersion: 1, recordIndex: 0, entryName: 'conversations.json' }
    )),
    (error) => {
      assert.equal(typeof error?.code, 'string');
      assert.ok(
        /cursor/.test(error.code) ||
        (error.code === 'invalid_catalog_contract' && error.data?.field === 'cursor')
      );
      return true;
    }
  );
});

test('chatgpt export reader: closed decode variants preserve raw evidence without inventing snapshots', async (t) => {
  const missingIdentity = conversationRecord({ conversationId: 'conversation-missing-id' });
  delete missingIdentity.id;
  delete missingIdentity.conversation_id;

  const ambiguous = conversationRecord({ conversationId: 'conversation-ambiguous' });
  ambiguous.current_node = null;

  const invalidGraph = conversationRecord({ conversationId: 'conversation-invalid-graph' });
  invalidGraph.mapping[invalidGraph.current_node].parent = 'missing-parent-node';

  const unsupported = conversationRecord({ conversationId: 'conversation-unsupported' });
  unsupported.mapping[unsupported.current_node].message.content = {
    content_type: 'multimodal_text',
    parts: [
      { content_type: 'image_asset_pointer', asset_pointer: 'file-service://private-asset' },
      'Visible text beside an unsupported asset'
    ]
  };

  const records = [missingIdentity, ambiguous, invalidGraph, unsupported];
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson(records), method: 'deflate' }
  ]));
  const decoded = await collect(
    createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID)
  );

  assert.deepEqual(decoded, [
    {
      status: 'catalog-only',
      identity: null,
      title: missingIdentity.title,
      reason: 'provider-id-missing',
      rawRecord: Buffer.from(JSON.stringify(missingIdentity)),
      observedAt: OBSERVED_AT
    },
    {
      status: 'catalog-only',
      identity: expectedIdentity(ambiguous.id),
      title: ambiguous.title,
      reason: 'active-branch-ambiguous',
      rawRecord: Buffer.from(JSON.stringify(ambiguous)),
      observedAt: OBSERVED_AT
    },
    {
      status: 'catalog-only',
      identity: expectedIdentity(invalidGraph.id),
      title: invalidGraph.title,
      reason: 'message-graph-invalid',
      rawRecord: Buffer.from(JSON.stringify(invalidGraph)),
      observedAt: OBSERVED_AT
    },
    {
      status: 'catalog-only',
      identity: expectedIdentity(unsupported.id),
      title: unsupported.title,
      reason: 'unsupported-content',
      rawRecord: Buffer.from(JSON.stringify(unsupported)),
      observedAt: OBSERVED_AT
    }
  ]);
  assert.equal(Object.hasOwn(decoded[3], 'rawTurns'), false);
});

test('chatgpt export reader: the shared raw and normalized turn-text bound is exact', async (t) => {
  const atLimit = conversationRecord({
    conversationId: 'conversation-turn-text-at-limit',
    assistantText: 'A'.repeat(TRANSCRIPT_TURN_MAX_TEXT_CHARS)
  });
  const oversized = conversationRecord({
    conversationId: 'conversation-turn-text-oversized',
    assistantText: 'B'.repeat(TRANSCRIPT_TURN_MAX_TEXT_CHARS + 1)
  });
  const normalizationOversized = conversationRecord({
    conversationId: 'conversation-normalized-turn-text-oversized',
    assistantText: '\u0344'.repeat(Math.floor(TRANSCRIPT_TURN_MAX_TEXT_CHARS / 2) + 1)
  });
  const archive = await grantedArchive(t, buildZip([{
    name: 'conversations.json',
    data: recordsJson([atLimit, oversized, normalizationOversized]),
    method: 'store'
  }]));

  const decoded = await collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID));
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].status, 'complete');
  assert.equal(decoded[0].rawTurns.at(-1).text.length, TRANSCRIPT_TURN_MAX_TEXT_CHARS);
  assert.deepEqual({
    status: decoded[1].status,
    identity: decoded[1].identity,
    title: decoded[1].title,
    reason: decoded[1].reason,
    observedAt: decoded[1].observedAt
  }, {
    status: 'catalog-only',
    identity: expectedIdentity(oversized.id),
    title: oversized.title,
    reason: 'unsupported-content',
    observedAt: OBSERVED_AT
  });
  assert.equal(Object.hasOwn(decoded[1], 'rawTurns'), false);
  assert.deepEqual(decoded[1].rawRecord, Buffer.from(JSON.stringify(oversized)));
  assert.equal(decoded[2].status, 'catalog-only');
  assert.equal(decoded[2].reason, 'unsupported-content');
  assert.deepEqual(decoded[2].identity, expectedIdentity(normalizationOversized.id));
  assert.equal(Object.hasOwn(decoded[2], 'rawTurns'), false);
});

test('chatgpt export reader: exactly 100,000 active-branch turns do not trip the graph guard', { timeout: 60_000 }, async (t) => {
  const turnCount = 100_000;
  const mapping = {};
  let parent = null;
  for (let index = 0; index < turnCount; index += 1) {
    const id = `m${index}`;
    mapping[id] = {
      id,
      message: {
        id,
        author: { role: index % 2 === 0 ? 'user' : 'assistant' },
        content: { content_type: 'text', parts: ['x'] }
      },
      parent,
      children: []
    };
    if (parent !== null) mapping[parent].children.push(id);
    parent = id;
  }
  const record = {
    id: 'conversation-turn-count-at-limit',
    conversation_id: 'conversation-turn-count-at-limit',
    title: 'Turn count at limit',
    update_time: UPDATE_TIME,
    current_node: parent,
    mapping
  };
  const archive = await grantedArchive(t, buildZip([{
    name: 'conversations.json',
    data: recordsJson([record]),
    method: 'store'
  }]));

  const [decoded] = await collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID));
  assert.equal(decoded.status, 'complete');
  assert.equal(decoded.rawTurns.length, turnCount);
  assert.equal(decoded.rawTurns.at(-1).ordinal, turnCount - 1);
  assert.equal(decoded.activeBranchEvidence.messageIds.length, turnCount);
});

test('chatgpt export reader: a disconnected cycle cannot advance a complete snapshot', async (t) => {
  const record = conversationRecord({ conversationId: 'conversation-disconnected-cycle' });
  record.mapping['detached-cycle'] = {
    id: 'detached-cycle',
    message: null,
    parent: 'detached-cycle',
    children: ['detached-cycle']
  };
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([record]), method: 'deflate' }
  ]));

  const decoded = await collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].status, 'catalog-only');
  assert.equal(decoded[0].reason, 'message-graph-invalid');
  assert.equal(Object.hasOwn(decoded[0], 'rawTurns'), false);
});

test('chatgpt export reader: roles that cannot round-trip stay catalog-only', async (t) => {
  const whitespace = conversationRecord({ conversationId: 'conversation-whitespace-role' });
  whitespace.mapping[`${whitespace.id}-assistant`].message.author.role = '   ';
  const expanding = conversationRecord({ conversationId: 'conversation-expanding-role' });
  expanding.mapping[`${expanding.id}-assistant`].message.author.role = 'İ'.repeat(64);
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([whitespace, expanding]), method: 'deflate' }
  ]));

  const decoded = await collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID));
  assert.equal(decoded.length, 2);
  for (const result of decoded) {
    assert.equal(result.status, 'catalog-only');
    assert.equal(result.reason, 'unsupported-content');
    assert.equal(Object.hasOwn(result, 'rawTurns'), false);
  }
});

test('chatgpt export reader: a zip-slip name anywhere in the real archive is unsafe', async (t) => {
  const privateMarker = 'private zip-slip marker';
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([conversationRecord()]) },
    { name: '../escaped.txt', data: privateMarker }
  ]));

  await assert.rejects(
    createChatGptExportReader().inspect(archive),
    errorHasCode(/unsafe/, [privateMarker, '../escaped.txt'])
  );
});

test('chatgpt export reader: CRC corruption is detected while streaming real entry bytes', async (t) => {
  const privateMarker = 'private CRC transcript marker';
  const record = conversationRecord({ assistantText: privateMarker });
  const archive = await grantedArchive(t, buildZip([
    {
      name: 'conversations.json',
      data: recordsJson([record]),
      method: 'deflate',
      crc32: 0
    }
  ]));
  const reader = createChatGptExportReader();
  await reader.inspect(archive);

  await assert.rejects(
    collect(reader.streamConversations(archive, PROFILE_SCOPE_ID)),
    errorHasCode(/corrupt|crc/, [privateMarker])
  );
});

test('chatgpt export reader: compression-ratio limits reject a real deflate bomb before decode', async (t) => {
  const privateMarker = 'private repeated bomb marker';
  const record = conversationRecord({ assistantText: `${privateMarker} ${'A'.repeat(64 * 1024)}` });
  const zipBytes = buildZip([
    { name: 'conversations.json', data: recordsJson([record]), method: 'deflate' }
  ]);
  const archive = await grantedArchive(t, zipBytes);

  await assert.rejects(
    createChatGptExportReader({ limits: { maxCompressionRatio: 2 } }).inspect(archive),
    errorHasCode(/unsafe|ratio/, [privateMarker])
  );
});

test('chatgpt export reader: corrupt JSON stays distinct and never leaks archive contents', async (t) => {
  const privateMarker = 'private malformed JSON marker';
  const archive = await grantedArchive(t, buildZip([
    {
      name: 'conversations.json',
      data: `[{"title":"${privateMarker}","mapping": ]`,
      method: 'deflate'
    }
  ]));
  const reader = createChatGptExportReader();
  await reader.inspect(archive);

  await assert.rejects(
    collect(reader.streamConversations(archive, PROFILE_SCOPE_ID)),
    errorHasCode(/json/, [privateMarker])
  );
});

test('chatgpt export reader: duplicate object members cannot hide a malformed identity', async (t) => {
  const privateMarker = 'private duplicate-key marker';
  const record = conversationRecord({
    conversationId: 'duplicate-key-thread',
    title: privateMarker
  });
  const { id: _id, ...withoutId } = record;
  const rawRecord = `{"id":"../malformed-id","\\u0069d":"${record.id}",${JSON.stringify(withoutId).slice(1)}`;
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: `[${rawRecord}]`, method: 'deflate' }
  ]));

  await assert.rejects(
    collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID)),
    errorHasCode(/corrupt_json/, [privateMarker, '../malformed-id'])
  );
});

test('chatgpt export reader: duplicate optional account-hint members yield no comparable hint', async (t) => {
  const record = conversationRecord({ conversationId: 'duplicate-user-key-thread' });
  const privateMarker = 'private duplicate user id';
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([record]) },
    { name: 'user.json', data: `{"id":"${privateMarker}","\\u0069d":"other-user"}` }
  ]));

  const manifest = await createChatGptExportReader().inspect(archive);
  assert.equal(manifest.accountHint, null);
  assert.equal(JSON.stringify(manifest).includes(privateMarker), false);
});

test('chatgpt export reader: a present malformed provider identity is rejected rather than treated as missing', async (t) => {
  const privateMarker = 'private malformed identity marker';
  const record = conversationRecord({ title: privateMarker });
  record.id = '../not-a-provider-id';
  record.conversation_id = '../not-a-provider-id';
  const archive = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([record]), method: 'deflate' }
  ]));

  await assert.rejects(
    collect(createChatGptExportReader().streamConversations(archive, PROFILE_SCOPE_ID)),
    errorHasCode(/identity/, [privateMarker, '../not-a-provider-id'])
  );
});

test('chatgpt export reader: numbered layout must be zero-based contiguous and cannot mix with single layout', async (t) => {
  const record = conversationRecord();
  const gapped = await grantedArchive(t, buildZip([
    { name: 'conversations-001.json', data: recordsJson([record]) }
  ]), { displayName: 'gapped.zip' });
  await assert.rejects(
    createChatGptExportReader().inspect(gapped),
    errorHasCode(/unsupported|layout/)
  );

  const mixed = await grantedArchive(t, buildZip([
    { name: 'conversations.json', data: recordsJson([record]) },
    { name: 'conversations-000.json', data: recordsJson([record]) }
  ]), { displayName: 'mixed.zip' });
  await assert.rejects(
    createChatGptExportReader().inspect(mixed),
    errorHasCode(/unsupported|layout/)
  );
});
