import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  LEGACY_CONVERSATION_TEXT_REASONS,
  TRANSCRIPT_CAPTURE_REASONS,
  TRANSCRIPT_NORMALIZATION_VERSION,
  TRANSCRIPT_PAGE_MAX_TEXT_CHARS,
  TRANSCRIPT_TURN_MAX_TEXT_CHARS,
  normalizeArchiveConversation,
  normalizeLiveCapture,
  parseConversationCapture,
  parseNormalizedTranscript,
  parseTranscriptTurn,
  projectLegacyConversationText,
  projectLegacyConversationWindowText,
  renderTranscript
} from '../transcript-contract.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function transcriptWithTurns(base, turns) {
  return {
    ...base,
    turns,
    characterCount: turns.reduce((total, turn) => total + turn.text.length, 0),
    contentHash: hashCanonical({ normalizationVersion: base.normalizationVersion, turns })
  };
}

function evidence(turns, overrides = {}) {
  return {
    topBoundary: true,
    bottomBoundary: true,
    orderedWindowStitching: true,
    scrollPasses: 4,
    windowCount: 3,
    messageCount: turns.length,
    providerIdCount: turns.filter((turn) => turn.providerMessageId !== null).length,
    byteCount: turns.reduce((total, turn) =>
      total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId || ''), 0),
    ...overrides
  };
}

function completeCapture(rawTurns, overrides = {}) {
  return {
    status: 'complete',
    conversationUrl: 'https://chatgpt.com/c/thread-1',
    capturedAt: '2026-07-30T12:00:00.000Z',
    rawTurns,
    evidence: evidence(rawTurns),
    ...overrides
  };
}

const repeatedTurns = [
  { ordinal: 0, providerMessageId: 'm-1', role: 'user', text: 'Repeat this.' },
  { ordinal: 1, providerMessageId: 'm-2', role: 'assistant', text: 'Same text' },
  { ordinal: 2, providerMessageId: 'm-3', role: 'assistant', text: 'Same text' }
];

test('transcript contract: complete and partial capture variants are closed and exact', () => {
  assert.equal(parseConversationCapture(completeCapture(repeatedTurns)).status, 'complete');
  const partial = parseConversationCapture({
    status: 'partial',
    reason: 'conversation_top_not_reached',
    conversationUrl: null,
    capturedAt: '2026-07-30T12:00:00.000Z',
    rawTurns: [],
    evidence: evidence([], { topBoundary: false, bottomBoundary: false, windowCount: 1 })
  });
  assert.equal(partial.reason, 'conversation_top_not_reached');

  assert.throws(() => parseConversationCapture({ ...completeCapture(repeatedTurns), reason: 'extra' }), /unexpected_fields/);
  assert.throws(() => parseConversationCapture({
    ...completeCapture(repeatedTurns), status: 'partial', reason: 'made-up'
  }), /unknown_capture_reason/);
  assert.throws(() => parseConversationCapture(completeCapture(repeatedTurns, {
    evidence: evidence(repeatedTurns, { topBoundary: false })
  })), /complete_without_boundaries/);
});

test('transcript contract: every accepted turn fits one whole-turn retrieval page', () => {
  const atLimit = [{
    ordinal: 0,
    providerMessageId: 'max-page-turn',
    role: 'assistant',
    text: 'A'.repeat(TRANSCRIPT_TURN_MAX_TEXT_CHARS)
  }];
  const normalized = normalizeLiveCapture(completeCapture(atLimit));
  assert.equal(renderTranscript(normalized).length, TRANSCRIPT_PAGE_MAX_TEXT_CHARS);

  const overLimit = [{ ...atLimit[0], text: `${atLimit[0].text}A` }];
  assert.throws(() => parseConversationCapture(completeCapture(overLimit)), /invalid_text/);

  const expandsDuringNormalization = [{
    ...atLimit[0],
    text: '\u0344'.repeat(Math.floor(TRANSCRIPT_TURN_MAX_TEXT_CHARS / 2) + 1)
  }];
  assert.throws(() => normalizeLiveCapture(completeCapture(expandsDuringNormalization)), /invalid_text/);
});

test('transcript contract: live and archive origins share one stable normalization and hash', () => {
  const liveA = normalizeLiveCapture(completeCapture(repeatedTurns));
  const liveB = normalizeLiveCapture(completeCapture(repeatedTurns, { capturedAt: '2026-07-30T13:00:00.000Z' }));
  const archive = normalizeArchiveConversation({ status: 'complete', rawTurns: repeatedTurns, originMetadata: 'ignored' });

  assert.equal(liveA.normalizationVersion, TRANSCRIPT_NORMALIZATION_VERSION);
  assert.equal(liveA.contentHash, liveB.contentHash);
  assert.equal(liveA.contentHash, archive.contentHash);
  assert.equal(liveA.turns.length, 3);
  assert.notEqual(liveA.turns[1].turnId, liveA.turns[2].turnId);
  assert.deepEqual(parseNormalizedTranscript(JSON.parse(JSON.stringify(liveA))), liveA);
});

test('transcript contract: order multiplicity and canonical fields participate in the hash', () => {
  const original = normalizeLiveCapture(completeCapture(repeatedTurns));
  const reorderedRaw = repeatedTurns.map((turn, index) => ({ ...repeatedTurns[[0, 2, 1][index]], ordinal: index }));
  const reordered = normalizeLiveCapture(completeCapture(reorderedRaw));
  const changed = normalizeLiveCapture(completeCapture(repeatedTurns.map((turn, index) =>
    index === 2 ? { ...turn, text: 'Different' } : turn
  )));

  assert.notEqual(original.contentHash, reordered.contentHash);
  assert.notEqual(original.contentHash, changed.contentHash);
  const changedProviderIdentity = normalizeLiveCapture(completeCapture(repeatedTurns.map((turn, index) =>
    index === 1 ? { ...turn, providerMessageId: 'different-provider-message' } : turn
  )));
  assert.notEqual(original.contentHash, changedProviderIdentity.contentHash);
  assert.throws(() => normalizeLiveCapture(completeCapture([
    repeatedTurns[0],
    { ...repeatedTurns[1], ordinal: 4 }
  ])), /contradictory_ordinal/);
});

test('transcript contract: missing provider ids retain repeated turns with snapshot-local identities', () => {
  const rawTurns = repeatedTurns.map((turn) => ({ ...turn, providerMessageId: null }));
  const normalized = normalizeLiveCapture(completeCapture(rawTurns));

  assert.equal(normalized.turns.length, 3);
  assert.equal(normalized.turns[1].identity.kind, 'snapshot-local');
  assert.notEqual(normalized.turns[1].turnId, normalized.turns[2].turnId);
  assert.equal(normalized.turns[1].identity.turnContentHash, normalized.turns[2].identity.turnContentHash);
  assert.equal(normalized.contentHash, normalizeLiveCapture(completeCapture(rawTurns)).contentHash);
});

test('transcript contract: text and legacy output are projections of structured turns', () => {
  const capture = completeCapture(repeatedTurns);
  const normalized = normalizeLiveCapture(capture);
  assert.equal(renderTranscript(normalized), 'User\nRepeat this.\n\nAssistant\nSame text\n\nAssistant\nSame text');
  assert.deepEqual(projectLegacyConversationText(capture, { maxChars: 12 }), {
    text: 'User\nRepeat ',
    complete: false,
    truncated: true,
    reason: 'max_chars',
    messageCount: 3,
    scrollPasses: 4
  });
});

test('transcript contract: an isolated structured turn uses the exact normalization authority', () => {
  const normalized = normalizeLiveCapture(completeCapture(repeatedTurns));
  assert.deepEqual(parseTranscriptTurn(normalized.turns[1], 1), normalized.turns[1]);
  assert.throws(
    () => parseTranscriptTurn({ ...normalized.turns[1], rawRole: ' user ' }, 1),
    /normalized_turn_mismatch/
  );
  assert.throws(
    () => parseTranscriptTurn({ ...normalized.turns[1], role: 'user' }, 1),
    /normalized_turn_mismatch/
  );
  assert.throws(
    () => parseTranscriptTurn({ ...normalized.turns[1], text: ` ${normalized.turns[1].text}` }, 1),
    /normalized_turn_mismatch/
  );
});

test('transcript contract: a null raw role is canonical only for unknown turns and remains hash-bearing', () => {
  const stringRole = normalizeLiveCapture(completeCapture([{
    ordinal: 0,
    providerMessageId: 'provider-unknown-role',
    role: 'provider-special-role',
    text: 'Unknown provider role'
  }]));
  assert.equal(stringRole.turns[0].role, 'unknown');
  assert.equal(stringRole.turns[0].rawRole, 'provider-special-role');

  const nullableTurn = { ...stringRole.turns[0], rawRole: null };
  const nullable = transcriptWithTurns(stringRole, [nullableTurn]);
  const parsed = parseNormalizedTranscript(nullable);
  assert.equal(parsed.turns[0].role, 'unknown');
  assert.equal(parsed.turns[0].rawRole, null);
  assert.deepEqual(parseTranscriptTurn(nullableTurn, 0), parsed.turns[0]);
  assert.notEqual(parsed.contentHash, stringRole.contentHash);
  assert.throws(
    () => parseTranscriptTurn({ ...nullableTurn, role: 'assistant' }, 0),
    /normalized_turn_mismatch/
  );
  assert.throws(
    () => parseNormalizedTranscript({ ...nullable, contentHash: stringRole.contentHash }),
    /content_hash_mismatch/
  );

  const localBase = normalizeLiveCapture(completeCapture([{
    ordinal: 0,
    providerMessageId: null,
    role: 'provider-special-role',
    text: 'Unknown local role'
  }]));
  const localTurnHash = hashCanonical({ role: 'unknown', rawRole: null, text: localBase.turns[0].text });
  const localTurn = {
    ...localBase.turns[0],
    turnId: `snapshot-local:0:${localTurnHash}`,
    identity: { kind: 'snapshot-local', ordinal: 0, turnContentHash: localTurnHash },
    rawRole: null
  };
  const localNullable = transcriptWithTurns(localBase, [localTurn]);
  assert.deepEqual(parseNormalizedTranscript(localNullable), localNullable);
  assert.throws(
    () => parseTranscriptTurn({
      ...localTurn,
      turnId: localBase.turns[0].turnId,
      identity: localBase.turns[0].identity
    }, 0),
    /normalized_turn_mismatch/
  );
});

test('transcript contract: malformed boundary values and hashes fail closed', () => {
  const capture = completeCapture(repeatedTurns);
  assert.throws(() => parseConversationCapture({ ...capture, conversationUrl: 'https://example.com/c/thread-1' }), /invalid_conversation_url/);
  assert.throws(() => parseConversationCapture({ ...capture, rawTurns: [{ ...repeatedTurns[0], text: 'bad\u0000text' }] }), /invalid_text/);
  assert.throws(() => parseConversationCapture({ ...capture, rawTurns: [{ ...repeatedTurns[0], role: '   ' }] }), /invalid_role/);
  assert.throws(() => normalizeArchiveConversation({
    status: 'complete',
    rawTurns: [{ ...repeatedTurns[0], role: 'İ'.repeat(64) }]
  }), /invalid_role/);
  const expandingRole = normalizeArchiveConversation({
    status: 'complete',
    rawTurns: [{ ...repeatedTurns[0], role: 'İ'.repeat(32) }]
  });
  assert.equal(expandingRole.turns[0].rawRole.length, 64);
  assert.deepEqual(parseNormalizedTranscript(JSON.parse(JSON.stringify(expandingRole))), expandingRole);
  const normalized = normalizeLiveCapture(capture);
  assert.throws(() => parseNormalizedTranscript({ ...normalized, contentHash: '0'.repeat(64) }), /content_hash_mismatch/);
  assert.throws(() => parseNormalizedTranscript({ ...normalized, normalizationVersion: 999 }), /unsupported_normalization_version/);
  assert.throws(() => renderTranscript({ turns: [{ ordinal: 0, role: 'future-role', text: 'nope' }] }), /invalid_render_turn/);
  const maximumProviderIdTurn = {
    ordinal: 0,
    providerMessageId: `a${'x'.repeat(511)}`,
    role: 'user',
    text: 'Boundary'
  };
  assert.equal(parseConversationCapture(completeCapture([maximumProviderIdTurn])).rawTurns[0].providerMessageId.length, 512);
  const oversizedProviderIdTurn = {
    ...maximumProviderIdTurn,
    providerMessageId: `${maximumProviderIdTurn.providerMessageId}x`
  };
  assert.throws(
    () => parseConversationCapture(completeCapture([oversizedProviderIdTurn])),
    /invalid_provider_message_id/
  );
});

test('transcript contract: evidence byte counts are recomputed with exact UTF-8 semantics', () => {
  const rawTurns = [{ ordinal: 0, providerMessageId: 'emoji-1', role: 'user', text: '😀' }];
  const capture = completeCapture(rawTurns);
  assert.equal(parseConversationCapture(capture).evidence.byteCount, 15);
  assert.throws(() => parseConversationCapture({
    ...capture,
    evidence: { ...capture.evidence, byteCount: capture.evidence.byteCount - 1 }
  }), /evidence_count_mismatch/);
});

test('transcript contract: legacy projection exhaustively closes structured reasons into the pre-V0 vocabulary', () => {
  const expected = new Map([
    ['conversation_messages_not_found', 'conversation_messages_not_found'],
    ['conversation_top_not_reached', 'conversation_top_not_reached'],
    ['conversation_leading_turn_missing', 'leading_turn_missing'],
    ['conversation_scroll_stalled', 'conversation_scroll_stalled'],
    ['conversation_capture_timeout', 'conversation_capture_timeout'],
    ['conversation_generation_active', 'conversation_capture_invalid'],
    ['conversation_capture_limit_reached', 'conversation_scroll_limit_reached'],
    ['max_capture_bytes', 'max_chars'],
    ['conversation_message_text_unavailable', 'conversation_capture_invalid'],
    ['ambiguous_message_overlap', 'conversation_capture_invalid'],
    ['compatibility_drift', 'conversation_capture_invalid']
  ]);
  assert.deepEqual([...expected.keys()], [...TRANSCRIPT_CAPTURE_REASONS]);
  for (const [reason, projectedReason] of expected) {
    const captureWindow = {
      status: 'partial',
      reason,
      rawTurns: [{ ordinal: 0, providerMessageId: 'm-1', role: 'user', text: 'Visible' }],
      evidence: evidence([{ ordinal: 0, providerMessageId: 'm-1', role: 'user', text: 'Visible' }], {
        topBoundary: false,
        bottomBoundary: false,
        orderedWindowStitching: ![
          'conversation_message_text_unavailable',
          'ambiguous_message_overlap',
          'compatibility_drift'
        ].includes(reason)
      })
    };
    const capture = {
      ...captureWindow,
      conversationUrl: 'https://chatgpt.com/c/thread-1',
      capturedAt: '2026-07-30T12:00:00.000Z'
    };
    for (const projection of [
      projectLegacyConversationText(capture),
      projectLegacyConversationWindowText(captureWindow)
    ]) {
      assert.equal(projection.reason, projectedReason, reason);
      assert.equal(LEGACY_CONVERSATION_TEXT_REASONS.includes(projection.reason), true, reason);
    }
  }

  const timeoutTurns = [{ ordinal: 0, providerMessageId: 'm-2', role: 'user', text: 'Visible' }];
  const timeoutWindow = {
    status: 'partial',
    reason: 'conversation_capture_timeout',
    rawTurns: timeoutTurns,
    evidence: evidence(timeoutTurns, {
      topBoundary: false,
      bottomBoundary: false,
      orderedWindowStitching: true
    })
  };
  assert.equal(projectLegacyConversationWindowText(timeoutWindow, {
    legacyDiagnosticReason: 'conversation_top_capture_timeout'
  }).reason, 'conversation_top_capture_timeout');
  assert.throws(
    () => projectLegacyConversationWindowText(timeoutWindow, {
      legacyDiagnosticReason: 'conversation_scroller_not_found'
    }),
    /invalid_legacy_diagnostic_reason/
  );
});
