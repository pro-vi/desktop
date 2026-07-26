import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

import { loadChatGptCompatibilityProfile } from '../chatgpt-compatibility.mjs';
import {
  compileChatGptAnchorEvaluator,
  parseChatGptAnchorEvaluation
} from '../chatgpt-compatibility-resolver.mjs';

const fixtureRoot = new URL('./fixtures/chatgpt-compatibility/', import.meta.url);
const profile = await loadChatGptCompatibilityProfile();

async function readFixture(name) {
  const fixture = JSON.parse(await readFile(new URL(`${name}.json`, fixtureRoot), 'utf8'));
  return fixture.resolverFixture || fixture;
}

function fixtureDocument(fixture) {
  const nodes = fixture.nodes.map((item) => {
    const attributes = item.attributes || {};
    return {
      tagName: item.tagName.toUpperCase(),
      disabled: item.enabled === false,
      isContentEditable: item.contentEditable === true,
      getAttribute: (name) => attributes[name] ?? null,
      hasAttribute: (name) => Object.hasOwn(attributes, name),
      getBoundingClientRect: () => ({ width: item.visible === false ? 0 : 120, height: item.visible === false ? 0 : 32 }),
      ownerDocument: { defaultView: { getComputedStyle: () => ({ display: item.visible === false ? 'none' : 'block', visibility: 'visible' }) } },
      selectors: item.selectors
    };
  });
  return {
    querySelectorAll(selector) {
      return nodes.filter((node) => node.selectors.includes(selector));
    }
  };
}

for (const name of ['current', 'legacy', 'ambiguous', 'hidden', 'wrong-node', 'absent']) {
  test(`resolver fixture: executes ${name} through the generated evaluator`, async () => {
    const fixture = await readFixture(name);
    const source = compileChatGptAnchorEvaluator({ profile, anchorId: fixture.anchorId });
    const raw = vm.runInNewContext(source, { document: fixtureDocument(fixture) });
    const result = parseChatGptAnchorEvaluation(raw);
    assert.equal(result.kind, 'resolution');
    assert.equal(result.status, fixture.expected.status);
    assert.equal(result.branchKind, fixture.expected.branchKind);
    assert.equal(result.postcondition.status, fixture.expected.postconditionStatus);
    if (fixture.expected.reasonCode) assert.equal(result.postcondition.reasonCode, fixture.expected.reasonCode);
    if (fixture.expected.matchCount) assert.equal(result.matchCount, fixture.expected.matchCount);
  });
}

test('resolver fixture sentinel: deleting the canonical node selects legacy and is visibly degraded', async () => {
  const fixture = await readFixture('ambiguous');
  fixture.nodes = fixture.nodes.filter((node) => !node.selectors.includes('#prompt-textarea'));
  const raw = vm.runInNewContext(
    compileChatGptAnchorEvaluator({ profile, anchorId: fixture.anchorId }),
    { document: fixtureDocument(fixture) }
  );
  const result = parseChatGptAnchorEvaluation(raw);
  assert.equal(result.branchKind, 'legacy');
  assert.equal(result.healthStatus, 'degraded');
});
