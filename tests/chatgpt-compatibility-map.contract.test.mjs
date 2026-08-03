import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CHATGPT_COMPATIBILITY_SCHEMA_VERSION,
  CHATGPT_SEMANTIC_PRIMITIVE_IDS,
  createChatGptCompatibilityProfile,
  parseChatGptCompatibilityMap
} from '../chatgpt-compatibility.mjs';

const mapPath = new URL('../chatgpt-compatibility.json', import.meta.url);
const legacySelectorsPath = new URL('../selectors.json', import.meta.url);
const fixturePath = new URL('./fixtures/chatgpt-compatibility/current.json', import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('chatgpt compatibility map: parses one frozen authority with stable hash and census', async () => {
  const raw = await readJson(mapPath);
  const fixture = await readJson(fixturePath);
  const profile = createChatGptCompatibilityProfile(raw);

  assert.equal(profile.schemaVersion, CHATGPT_COMPATIBILITY_SCHEMA_VERSION);
  assert.match(profile.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(profile.contractHash, createChatGptCompatibilityProfile(clone(raw)).contractHash);
  assert.deepEqual(
    profile.capabilities.map(({ id, anchorIds, preconditionId, postconditionId, terminalMode }) => ({
      id,
      anchorIds,
      preconditionId,
      postconditionId,
      terminalMode
    })),
    fixture.capabilities
  );
  assert.deepEqual(profile.anchors.map(({ id }) => id), fixture.anchorIds);
  assert.deepEqual(profile.exemptions.map(({ id }) => id), fixture.exemptionIds);
  assert.equal(profile.capabilities.length, 10);
  assert.equal(profile.anchors.length > 0, true);
  assert.equal(profile.anchors.every((anchor) => anchor.branches.length > 0), true);
  assert.equal(profile.anchors.every((anchor) => anchor.capture.descriptorFields.length > 0), true);
  assertDeepFrozen(profile);
});

test('chatgpt compatibility map: hash changes for semantic map mutation', async () => {
  const raw = await readJson(mapPath);
  const before = createChatGptCompatibilityProfile(raw).contractHash;
  const changed = clone(raw);
  changed.anchors[0].branches[0].selector += '[data-contract-mutation]';
  assert.notEqual(createChatGptCompatibilityProfile(changed).contractHash, before);
});

test('chatgpt compatibility map: owns an exact ordered projection of every legacy selector key', async () => {
  const profile = createChatGptCompatibilityProfile(await readJson(mapPath));
  const legacySelectors = await readJson(legacySelectorsPath);
  const projected = Object.fromEntries(
    profile.anchors.map((anchor) => [
      anchor.legacySelectorKey,
      anchor.branches.map(({ selector }) => selector).join(', ')
    ])
  );

  assert.deepEqual(projected, legacySelectors);
  assert.equal(profile.anchors.every(({ branches }) => branches[0].kind === 'canonical'), true);
  assert.equal(
    profile.anchors.every(({ branches }) => branches.slice(1).every(({ kind }) => kind === 'legacy')),
    true
  );
});

test('chatgpt compatibility map: rejects unknown versions and variants', async () => {
  const raw = await readJson(mapPath);
  for (const mutate of [
    (map) => { map.schemaVersion = 999; },
    (map) => { map.anchors[0].branches[0].kind = 'experimental'; },
    (map) => { map.anchors[0].branches[0].source = 'generated'; },
    (map) => { map.capabilities[0].terminalMode = 'dom-success'; }
  ]) {
    const changed = clone(raw);
    mutate(changed);
    assert.throws(() => parseChatGptCompatibilityMap(changed), /invalid_chatgpt_compatibility_map/);
  }
});

test('chatgpt compatibility map: rejects duplicate ids and legacy-before-canonical ordering', async () => {
  const raw = await readJson(mapPath);
  for (const mutate of [
    (map) => { map.capabilities[1].id = map.capabilities[0].id; },
    (map) => { map.anchors[1].id = map.anchors[0].id; },
    (map) => { map.anchors[0].branches[1].id = map.anchors[0].branches[0].id; },
    (map) => { map.anchors[0].branches[0].kind = 'legacy'; }
  ]) {
    const changed = clone(raw);
    mutate(changed);
    assert.throws(() => parseChatGptCompatibilityMap(changed), /invalid_chatgpt_compatibility_map/);
  }
});

test('chatgpt compatibility map: rejects comma-priority branches and unregistered primitives', async () => {
  const raw = await readJson(mapPath);
  for (const mutate of [
    (map) => { map.anchors[0].branches[0].selector += ', textarea'; },
    (map) => { map.anchors[0].primitiveId = 'unregistered-anchor'; },
    (map) => { map.capabilities[0].preconditionId = 'unregistered-precondition'; },
    (map) => { map.capabilities[0].postconditionId = 'unregistered-postcondition'; }
  ]) {
    const changed = clone(raw);
    mutate(changed);
    assert.throws(() => parseChatGptCompatibilityMap(changed), /invalid_chatgpt_compatibility_map/);
  }

  assert.equal(Object.isFrozen(CHATGPT_SEMANTIC_PRIMITIVE_IDS), true);
});

test('chatgpt compatibility map: rejects missing capability dependencies or undeclared anchors', async () => {
  const raw = await readJson(mapPath);
  for (const mutate of [
    (map) => { map.capabilities[0].anchorIds = []; },
    (map) => { map.capabilities[0].anchorIds[0] = 'missing-anchor'; },
    (map) => { map.capabilities[0].anchorIds.push(map.capabilities[0].anchorIds[0]); }
  ]) {
    const changed = clone(raw);
    mutate(changed);
    assert.throws(() => parseChatGptCompatibilityMap(changed), /invalid_chatgpt_compatibility_map/);
  }
});

test('chatgpt compatibility map: explicit exemptions are bounded and validated', async () => {
  const raw = await readJson(mapPath);
  assert.equal(raw.exemptions.length > 0, true);
  for (const exemption of raw.exemptions) {
    assert.equal(raw.capabilities.some(({ id }) => id === exemption.capabilityId), true);
    assert.match(exemption.reason, /provider-visible|browser-native|non-DOM/);
  }

  const changed = clone(raw);
  changed.exemptions[0].capabilityId = 'missing-capability';
  assert.throws(() => parseChatGptCompatibilityMap(changed), /invalid_chatgpt_compatibility_map/);
});

test('chatgpt compatibility map: transcript capture dependencies are exact and map-owned', async () => {
  const profile = createChatGptCompatibilityProfile(await readJson(mapPath));
  assert.deepEqual(
    profile.exemptions
      .filter(({ capabilityId }) => capabilityId === 'transcript')
      .map(({ dependency, selector }) => ({ dependency, selector })),
    [
      { dependency: 'transcript-message-id', selector: '[data-message-id]' },
      { dependency: 'transcript-message', selector: '[data-message-author-role]' },
      {
        dependency: 'transcript-generation-indicator',
        selector: '[class*="think"], [data-testid*="think"], [aria-label*="think"], [class*="research"], [data-testid*="research"], [aria-label*="research"], [class*="search"], [data-testid*="search"], [aria-label*="search"], [class*="source"], [data-testid*="source"], [aria-label*="source"], [class*="clarif"], [data-testid*="clarif"], [aria-label*="clarif"], .sr-only, [role="status"], [aria-live]'
      },
      { dependency: 'transcript-turn-ordinal', selector: '[data-testid^="conversation-turn-"]' }
    ]
  );
});
