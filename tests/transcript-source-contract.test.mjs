import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSCRIPT_SOURCE_KEY_MAX_LENGTH,
  TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH,
  TRANSCRIPT_SOURCE_TAG_MAX_LENGTH,
  TRANSCRIPT_SOURCE_TAGS_MAX_COUNT,
  parseTranscriptSourceKey,
  parseTranscriptSourceLabel,
  parseTranscriptSourceTags
} from '../transcript-source-contract.mjs';

test('transcript source contract: labels and keys are exact trimmed control-free strings', () => {
  assert.equal(parseTranscriptSourceLabel('Local label'), 'Local label');
  assert.equal(parseTranscriptSourceKey('thread-key'), 'thread-key');
  assert.equal(parseTranscriptSourceLabel('x'.repeat(TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH)).length, 200);
  assert.equal(parseTranscriptSourceKey('x'.repeat(TRANSCRIPT_SOURCE_KEY_MAX_LENGTH)).length, 128);
  for (const value of ['', ' padded', 'padded ', 'line\nbreak', 'x\u007f']) {
    assert.throws(() => parseTranscriptSourceLabel(value), /transcript_source_invalid/);
    assert.throws(() => parseTranscriptSourceKey(value), /transcript_source_invalid/);
  }
});

test('transcript source contract: tags are bounded, exact, and unique', () => {
  assert.deepEqual(parseTranscriptSourceTags(['one', 'two']), ['one', 'two']);
  assert.equal(parseTranscriptSourceTags(['x'.repeat(TRANSCRIPT_SOURCE_TAG_MAX_LENGTH)])[0].length, 64);
  assert.equal(parseTranscriptSourceTags(Array.from(
    { length: TRANSCRIPT_SOURCE_TAGS_MAX_COUNT }, (_, index) => `tag-${index}`
  )).length, 20);
  for (const tags of [['duplicate', 'duplicate'], [' padded'], ['line\nbreak'], [''], Array(21).fill('tag')]) {
    assert.throws(() => parseTranscriptSourceTags(tags), /transcript_source_invalid/);
  }
});
