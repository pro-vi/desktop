import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChatGPTController } from '../chatgpt-controller.mjs';
import {
  createProviderCompatibilityBridge,
  loadChatGptCompatibilityProfile
} from '../chatgpt-compatibility.mjs';
import { createCompatibilityStore } from '../compatibility-store.mjs';

const profile = await loadChatGptCompatibilityProfile();
const selectors = JSON.parse(await readFile(new URL('../selectors.json', import.meta.url), 'utf8'));
const controllerSource = await readFile(new URL('../chatgpt-controller.mjs', import.meta.url), 'utf8');
const readmeSource = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const compatibilityAdrSource = await readFile(
  new URL('../docs/adr/0004-use-passive-chatgpt-compatibility-observation.md', import.meta.url),
  'utf8'
);

function resolvedRaw(anchorId = 'prompt-textarea') {
  const anchor = profile.anchors.find(({ id }) => id === anchorId);
  const branch = anchor.branches[0];
  return {
    type: 'chatgpt-anchor-resolution', schemaVersion: 1, ok: true,
    anchorId, branchId: branch.id, branchKind: branch.kind, branchSource: branch.source,
    selectorHash: 'b'.repeat(64), rolloutSignature: 'c'.repeat(64), matchCount: 1,
    descriptor: { tagName: 'textarea', role: '', ariaLabel: '', dataTestId: '', visible: true, enabled: true },
    postcondition: { status: 'ok', reasonCode: 'postcondition-satisfied' }
  };
}

function makeController({ instrumented = true, raw = resolvedRaw(), observations = [] } = {}) {
  const providerTrace = [];
  const page = {
    evaluate: async () => raw,
    navigate: async (...args) => providerTrace.push(['navigate', ...args]),
    insertText: async (...args) => providerTrace.push(['insertText', ...args]),
    sendKey: async (...args) => providerTrace.push(['sendKey', ...args]),
    mouseDown: async (...args) => providerTrace.push(['mouseDown', ...args]),
    mouseUp: async (...args) => providerTrace.push(['mouseUp', ...args]),
    moveMouse: async (...args) => providerTrace.push(['moveMouse', ...args])
  };
  const bridge = createProviderCompatibilityBridge({
    vendorId: 'chatgpt', vendorName: 'ChatGPT', selectors, profile,
    onCompatibilityObservation: instrumented ? async (row) => { observations.push(row); return { accepted: true }; } : null
  });
  return {
    controller: new ChatGPTController({ page, selectors, vendorId: 'chatgpt', vendorName: 'ChatGPT', ...bridge }),
    page,
    providerTrace,
    observations
  };
}

test('compatibility policy: every production capability is routed through the shared controller boundary', () => {
  for (const capabilityId of profile.capabilities.map(({ id }) => id)) {
    assert.match(controllerSource, new RegExp(`runCompatibilityCapability\\(\\s*['"]${capabilityId}['"]`), capabilityId);
  }
});

test('compatibility policy: each capability attempt emits one parsed outcome and preserves values', async () => {
  for (const capability of profile.capabilities) {
    const anchorId = capability.anchorIds[0];
    const observations = [];
    const { controller } = makeController({ raw: resolvedRaw(anchorId), observations });
    const expected = { capabilityId: capability.id, unchanged: true };
    const actual = await controller.runCompatibilityCapability(capability.id, async () => expected, {
      anchorId,
      postcondition: () => true
    });
    assert.equal(actual, expected);
    assert.equal(observations.filter(({ kind }) => kind === 'capability').length, 1, capability.id);
    assert.equal(observations.filter(({ kind }) => kind === 'resolution').length, 1, capability.id);
    assert.equal(new Set(observations.map(({ attemptId }) => attemptId)).size, 1, capability.id);
  }
});

test('compatibility policy: passive instrumentation preserves provider-visible action traces', async () => {
  const baseline = makeController({ instrumented: false });
  const instrumented = makeController({ instrumented: true });
  const operation = (page) => async () => {
    await page.insertText('hello');
    await page.sendKey('Enter');
    await page.moveMouse(10, 20);
    await page.mouseDown(10, 20);
    await page.mouseUp(10, 20);
    return { ok: true };
  };
  const before = await baseline.controller.runCompatibilityCapability('submit', operation(baseline.page), { anchorId: 'send-button' });
  const after = await instrumented.controller.runCompatibilityCapability('submit', operation(instrumented.page), { anchorId: 'send-button' });
  assert.deepEqual(after, before);
  assert.deepEqual(instrumented.providerTrace, baseline.providerTrace);
});

test('compatibility policy: operation errors retain identity and incomplete apparatus cannot become green', async () => {
  const observations = [];
  const { controller } = makeController({ raw: null, observations });
  const expected = new Error('operation-contract-error');
  await assert.rejects(
    async () => await controller.runCompatibilityCapability('submit', async () => { throw expected; }, { anchorId: 'send-button' }),
    (actual) => actual === expected
  );
  assert.deepEqual(observations.map(({ kind }) => kind), ['capability', 'apparatus']);
  assert.equal(observations[0].status, 'fail');
  assert.equal(observations[1].verdict, 'incomplete');
});

test('compatibility policy: captureConversation fails closed on unresolved transcript apparatus', async () => {
  const observations = [];
  let evaluationCount = 0;
  const page = {
    async evaluate() {
      evaluationCount += 1;
      if (evaluationCount === 1) return null;
      return {
        status: 'partial',
        reason: 'conversation_generation_active',
        rawTurns: [],
        evidence: {
          topBoundary: false,
          bottomBoundary: false,
          orderedWindowStitching: false,
          scrollPasses: 0,
          windowCount: 1,
          messageCount: 0,
          providerIdCount: 0,
          byteCount: 0
        }
      };
    },
    async getUrl() {
      return 'https://chatgpt.com/c/compatibility-unresolved';
    }
  };
  const bridge = createProviderCompatibilityBridge({
    vendorId: 'chatgpt', vendorName: 'ChatGPT', selectors, profile,
    onCompatibilityObservation: async (row) => { observations.push(row); return { accepted: true }; }
  });
  const controller = new ChatGPTController({
    page,
    selectors,
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    ...bridge
  });

  const actual = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(actual.status, 'partial');
  assert.equal(actual.reason, 'compatibility_drift');
  assert.equal(evaluationCount, 2);
  assert.equal(observations.find(({ kind }) => kind === 'capability').status, 'fail');
  assert.equal(observations.find(({ kind }) => kind === 'apparatus').verdict, 'incomplete');
});

test('compatibility policy: legitimate partial transcript capture stays partial without marking compatibility drift', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-policy-partial-transcript-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const store = createCompatibilityStore(stateDir, {
    contractHash: profile.contractHash,
    capabilityIds: profile.capabilities.map(({ id }) => id)
  });
  await store.load();
  const rawTurns = [
    { ordinal: 0, providerMessageId: 'message-user', role: 'user', text: 'Prompt' },
    { ordinal: 1, providerMessageId: 'message-assistant', role: 'assistant', text: 'Reply in progress' }
  ];
  const partialCapture = {
    status: 'partial',
    reason: 'conversation_generation_active',
    rawTurns,
    evidence: {
      topBoundary: true,
      bottomBoundary: true,
      orderedWindowStitching: true,
      scrollPasses: 2,
      windowCount: 1,
      messageCount: rawTurns.length,
      providerIdCount: rawTurns.length,
      byteCount: rawTurns.reduce((total, turn) =>
        total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0)
    }
  };
  let evaluationCount = 0;
  const page = {
    async evaluate() {
      evaluationCount += 1;
      return evaluationCount === 1 ? resolvedRaw('assistant-message') : partialCapture;
    },
    async getUrl() {
      return 'https://chatgpt.com/c/compatibility-partial';
    }
  };
  const bridge = createProviderCompatibilityBridge({
    vendorId: 'chatgpt', vendorName: 'ChatGPT', selectors, profile,
    onCompatibilityObservation: async (row) => await store.record(row)
  });
  const controller = new ChatGPTController({
    page,
    selectors,
    vendorId: 'chatgpt',
    vendorName: 'ChatGPT',
    ...bridge
  });

  const capture = await controller.captureConversation({ maxCaptureBytes: 100_000 });

  assert.equal(capture.status, 'partial');
  assert.equal(capture.reason, 'conversation_generation_active');
  assert.equal(evaluationCount, 2);
  const state = store.getSnapshot();
  assert.equal(state.capabilities.transcript.status, 'ok');
  assert.equal(state.capabilities.transcript.reasonCode, 'postcondition-satisfied');
  assert.equal(state.apparatus.verdict, 'ok');
});

test('compatibility policy: production observations parse and persist exactly once through the real store', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-policy-store-'));
  const store = createCompatibilityStore(stateDir, {
    contractHash: profile.contractHash,
    capabilityIds: profile.capabilities.map(({ id }) => id)
  });
  await store.load();
  const page = { evaluate: async () => resolvedRaw('send-button') };
  const bridge = createProviderCompatibilityBridge({
    vendorId: 'chatgpt', vendorName: 'ChatGPT', selectors, profile,
    onCompatibilityObservation: async (row) => await store.record(row)
  });
  const controller = new ChatGPTController({ page, selectors, vendorId: 'chatgpt', vendorName: 'ChatGPT', ...bridge });
  const result = await controller.runCompatibilityCapability('submit', async () => ({ acknowledged: true }), {
    anchorId: 'send-button',
    postcondition: (value) => value.acknowledged
  });
  assert.deepEqual(result, { acknowledged: true });
  const state = store.getSnapshot();
  assert.equal(state.revision, 2);
  assert.deepEqual(state.recentObservations.map(({ kind }) => kind), ['resolution', 'capability']);
  assert.equal(state.capabilities.submit.status, 'ok');
});

function staticSelectorDependencies(source) {
  const matches = source.matchAll(/(?:querySelectorAll|querySelector|matches|closest)\(\s*(['"])(.*?)\1/g);
  return [...new Set([...matches].map((match) => match[2].replace(/\\"/g, '"')))].sort();
}

function unownedSelectors(source) {
  const owned = new Set(profile.anchors.flatMap(({ branches }) => branches.map(({ selector }) => selector)));
  const exempt = new Set(profile.exemptions.map(({ selector }) => selector).filter(Boolean));
  return staticSelectorDependencies(source).filter((selector) => !owned.has(selector) && !exempt.has(selector));
}

test('compatibility policy sentinel: every static controller DOM dependency is map-owned or explicitly exempt', () => {
  assert.deepEqual(unownedSelectors(controllerSource), []);
  assert.deepEqual(unownedSelectors(`${controllerSource}\ndocument.querySelector('#unregistered-sentinel')`), ['#unregistered-sentinel']);
});

function unsafeCompatibilityClaims(source) {
  const claim = /(?:guarantees?|certifies?|ensures?).{0,40}(?:globally latest|ban[- ]safe|ban immunity|account safety|immunity from suspension)/i;
  const latest = /(?:is|stays|remains).{0,20}(?:the )?globally latest (?:ChatGPT )?(?:UI|map)/i;
  return String(source).split(/\n/).filter((line) =>
    (claim.test(line) || latest.test(line)) &&
    !/(?:does not|do not|cannot|never|not a claim|no guarantee)/i.test(line)
  );
}

test('compatibility policy sentinel: operator contract rejects globally-latest and account-safety claims', () => {
  const docs = `${readmeSource}\n${compatibilityAdrSource}`;
  assert.deepEqual(unsafeCompatibilityClaims(docs), []);
  assert.deepEqual(
    unsafeCompatibilityClaims(`${docs}\nAgentify guarantees account safety and a globally latest ChatGPT UI.`),
    ['Agentify guarantees account safety and a globally latest ChatGPT UI.']
  );
  assert.match(readmeSource, /observed cohort/);
  assert.match(readmeSource, /Active canary/);
  assert.match(readmeSource, /Restart both Agentify Desktop and the MCP server/i);
  assert.match(readmeSource, /automatically or programmatically extracting data or output/i);
});
