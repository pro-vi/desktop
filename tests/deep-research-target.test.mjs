import test from 'node:test';
import assert from 'node:assert/strict';

import { selectDeepResearchTargetForPage } from '../deep-research-target.mjs';

const appFrame = (targetId) => ({
  targetId,
  type: 'iframe',
  url: 'https://mcp-app-1b1c4a6075e80f132f3b488ed880ecf565027628c84314b6.web-sandbox.oaiusercontent.com/?app=skybridge&locale=en'
});

test('deep research target: an app-sandbox frame bound from a Deep research iframe is selected', () => {
  const selected = selectDeepResearchTargetForPage([appFrame('FRAME-A')], { frameTargetIds: new Set(['FRAME-A']) });
  assert.equal(selected?.targetId, 'FRAME-A');
});

test('deep research target: an unbound app-sandbox frame is never taken for the report', () => {
  // The generic sandbox host serves every app, so a lone frame on it may be
  // another app's.
  assert.equal(selectDeepResearchTargetForPage([appFrame('OTHER-APP')], { frameTargetIds: new Set() }), null);
});

test('deep research target: the last bound frame is the newest report', () => {
  const selected = selectDeepResearchTargetForPage(
    [appFrame('OLD-REPORT'), appFrame('NEW-REPORT')],
    { frameTargetIds: new Set(['OLD-REPORT', 'NEW-REPORT']) }
  );
  assert.equal(selected?.targetId, 'NEW-REPORT');
});

test('deep research target: the earlier connector host still resolves without a binding', () => {
  const selected = selectDeepResearchTargetForPage([
    { targetId: 'LEGACY', type: 'iframe', url: 'https://connector-openai-deep-research.web-sandbox.oaiusercontent.com/x' }
  ]);
  assert.equal(selected?.targetId, 'LEGACY');
});
