import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { OneShotController } from '../oneshot-engine.mjs';
import { ONESHOT_BRANCH_SOURCES, ONESHOT_REQUIRED_ANCHORS } from '../oneshot-profile.mjs';
import { kimiAdapter, kimiFreshChatUrl, KIMI_MODE_INTENTS } from '../oneshot-sites/kimi.mjs';
import { oneShotAdapterFor } from '../oneshot-sites/index.mjs';
import { createFakePage, el } from './fixtures/oneshot-fake-dom.mjs';

const sel = (anchorId) => kimiAdapter.profile.selectorsFor(anchorId)[0];
const FAST = { pollMs: 1, stableMs: 15, sendAckMs: 200, sendEnableMs: 20, uploadMs: 200, uiCheckMs: 50, promptDeliveryMs: 200, menuMs: 50 };

const MODELS = [
  { label: 'K3.1 Pro', key: 'k3d1-agent' },
  { label: 'K2.8 Preview', key: 'k28-agent-preview' },
  { label: 'Instant', key: 'k28-instant' }
];

// A Kimi composer as read from the signed-in www.kimi.ai page on 2026-11-18,
// with turns shaped like Kimi's public share pages. Every element answers to
// the canonical selector of its profile anchor.
function renderKimi(state) {
  const rows = [];
  for (const turn of state.turns) {
    if (turn.role === 'user') {
      rows.push(el('div', { matches: [sel('user-turn')], children: [el('div', { text: turn.text })] }));
      continue;
    }
    rows.push(el('div', {
      matches: [sel('assistant-turn')],
      children: [
        el('div', { matches: [sel('answer-exclude')], children: [el('div', { matches: [sel('answer-body')], text: 'Thinking process' })] }),
        el('div', { children: [el('div', { matches: [sel('answer-body')], children: turn.body })] })
      ]
    }));
  }
  rows.push(el('div', { matches: [sel('composer')], text: state.composerText, rect: { x: 100, y: 600, w: 400, h: 40 } }));
  const hasText = !!state.composerText.trim();
  rows.push(el('div', {
    matches: hasText ? [sel('send-button')] : [sel('send-button'), sel('send-disabled')],
    rect: { x: 520, y: 600, w: 30, h: 30 },
    onClick: () => {
      if (!hasText) return;
      state.turns.push({ role: 'user', text: state.composerText });
      state.composerText = '';
      state.stop = true;
      state.sent += 1;
    }
  }));
  if (state.stop) rows.push(el('div', { matches: [sel('stop-button')], rect: { x: 560, y: 600, w: 30, h: 30 } }));
  rows.push(el('input', {
    attrs: { type: 'file' },
    matches: [sel('file-input')],
    hidden: true,
    props: { multiple: true, set files(list) { for (const file of list) state.chips.push(file.name); } }
  }));
  for (const chip of state.chips) rows.push(el('div', { matches: [sel('attachment-item')], text: chip }));

  rows.push(el('div', {
    matches: [sel('mode-trigger')],
    attrs: { 'aria-expanded': state.menu ? 'true' : 'false' },
    rect: { x: 100, y: 560, w: 120, h: 30 },
    onClick: () => { state.menu = state.menu ? null : 'main'; },
    children: [
      el('span', { matches: [sel('mode-trigger-model')], text: state.model }),
      el('span', { matches: [sel('mode-trigger-effort')], text: state.effort })
    ]
  }));
  if (state.menu) {
    MODELS.forEach((model, i) => rows.push(el('button', {
      matches: [sel('mode-option')],
      attrs: { 'data-moon-key': model.key, 'aria-checked': String(state.model === model.label) },
      rect: { x: 100, y: 200 + i * 40, w: 200, h: 36 },
      onClick: () => state.choose(model.label),
      children: [el('span', { matches: [sel('mode-option-label')], text: model.label }), el('span', { text: 'description' })]
    })));
    rows.push(el('button', { matches: [sel('mode-more')], rect: { x: 100, y: 330, w: 200, h: 30 }, onClick: () => { state.menu = 'more'; }, text: 'More models' }));
    rows.push(el('button', { matches: [sel('mode-effort-item')], rect: { x: 100, y: 370, w: 200, h: 30 }, onClick: () => { state.menu = 'effort'; }, text: `Thinking effort\n${state.effort}` }));
    if (state.menu === 'more') {
      rows.push(el('button', { matches: [sel('mode-more-option')], rect: { x: 320, y: 330, w: 120, h: 30 }, onClick: () => state.choose('K3'), text: 'K3' }));
    }
    if (state.menu === 'effort') {
      ['Standard', 'High'].forEach((label, i) => rows.push(el('button', {
        matches: [sel('mode-effort-option')],
        rect: { x: 320, y: 370 + i * 40, w: 120, h: 30 },
        onClick: () => { state.effort = label; state.menu = null; },
        text: label
      })));
    }
  }
  return rows;
}

function makeKimi({ model = 'Instant', effort = 'Standard', locked = [], answer = null, url = 'https://www.kimi.ai/chat/old' } = {}) {
  const state = {
    model,
    effort,
    menu: null,
    composerText: '',
    selectAll: false,
    turns: [],
    chips: [],
    stop: false,
    sent: 0,
    reads: 0,
    // A model the account cannot use stays unselected when clicked.
    choose(label) {
      if (!locked.includes(label)) state.model = label;
      state.menu = null;
    }
  };
  const page = createFakePage({
    state,
    render: renderKimi,
    url,
    onNavigate: (next, fake) => { fake.state.turns = []; },
    onEvaluate: (js, fake) => {
      if (!js.includes('function readTurns(') || !fake.state.sent) return;
      fake.state.reads += 1;
      if (fake.state.reads === 2) fake.state.turns.push({ role: 'assistant', body: answer || ['Answer'] });
      if (fake.state.reads === 3) fake.state.stop = false;
    }
  });
  return { state, page };
}

const kimiController = (page) => new OneShotController({ page, adapter: kimiAdapter, stateDir: os.tmpdir(), timings: FAST });

test('oneshot-kimi: the profile loads, names a source for every branch, and is registered for the kimi vendor', () => {
  assert.equal(oneShotAdapterFor('kimi'), kimiAdapter);
  assert.equal(oneShotAdapterFor('KIMI'), kimiAdapter);
  assert.equal(oneShotAdapterFor('chatgpt'), null);
  for (const anchorId of ONESHOT_REQUIRED_ANCHORS) assert.ok(kimiAdapter.profile.selectorsFor(anchorId).length > 0, anchorId);
  for (const anchor of kimiAdapter.profile.anchors.values()) {
    for (const branch of anchor.branches) assert.ok(ONESHOT_BRANCH_SOURCES.includes(branch.source), branch.id);
  }
  assert.equal(sel('composer'), 'div.chat-input-editor[contenteditable="true"]');
  assert.equal(sel('mode-trigger'), '[data-testid="model-select-trigger"]');
});

test('oneshot-kimi: a fresh chat stays on the Kimi site the tab is on', () => {
  assert.equal(kimiFreshChatUrl('https://www.kimi.com/chat/abc'), 'https://www.kimi.com/');
  assert.equal(kimiFreshChatUrl('https://www.kimi.ai/chat/abc'), 'https://www.kimi.ai/');
  assert.equal(kimiFreshChatUrl('https://chatgpt.com/'), 'https://www.kimi.ai/');
  assert.equal(kimiFreshChatUrl('not a url'), 'https://www.kimi.ai/');
  assert.equal(kimiFreshChatUrl('https://www.kimi.ai/', { path: '/deep-research' }), 'https://www.kimi.ai/deep-research');
});

test('oneshot-kimi: k3.1-pro selects the model and High effort, confirmed on the trigger, before typing', async () => {
  const { state, page } = makeKimi();
  const result = await kimiController(page).query({ prompt: 'probe', modeIntent: 'k3.1-pro', timeoutMs: 2_000 });
  assert.equal(state.model, 'K3.1 Pro');
  assert.equal(state.effort, 'High');
  assert.deepEqual(result.meta.modeApplied, { intent: 'k3.1-pro', shown: { model: 'K3.1 Pro', effort: 'High' } });
  assert.deepEqual(result.meta.answerSettings, {
    model: 'K3.1 Pro',
    mode: 'Thinking effort: High',
    source: 'composer-model-menu-after-answer',
    unreadReason: null
  });
  assert.equal(result.text, 'Answer');
  assert.equal(state.turns[0].text, 'probe');
});

test('oneshot-kimi: k3 is found under More models', async () => {
  const { state, page } = makeKimi({ effort: 'High' });
  const result = await kimiController(page).query({ prompt: 'probe', modeIntent: 'k3', timeoutMs: 2_000 });
  assert.equal(state.model, 'K3');
  assert.deepEqual(result.meta.modeApplied.shown, { model: 'K3', effort: 'High' });
});

test('oneshot-kimi: a model the account cannot select fails closed and nothing is typed or sent', async () => {
  const { state, page } = makeKimi({ locked: ['K3.1 Pro'] });
  await assert.rejects(
    kimiController(page).query({ prompt: 'probe', modeIntent: 'k3.1-pro', timeoutMs: 2_000 }),
    (error) => error.message === 'mode_intent_unavailable' && error.data.reason === 'model_not_selected' &&
      error.data.shown.model === 'Instant'
  );
  assert.equal(state.composerText, '');
  assert.equal(state.sent, 0);
});

test('oneshot-kimi: an already selected model and effort need no clicks', async () => {
  const { page } = makeKimi({ model: 'K3.1 Pro', effort: 'High' });
  await kimiController(page).query({ prompt: 'probe', modeIntent: 'k3.1-pro', timeoutMs: 2_000 });
  const menuClicks = page.clicks.filter(([, y]) => y < 590);
  assert.deepEqual(menuClicks, []);
});

test('oneshot-kimi: an intent Kimi does not offer is refused with the supported list', async () => {
  const { page } = makeKimi();
  await assert.rejects(
    kimiController(page).query({ prompt: 'probe', modeIntent: 'extended-pro' }),
    (error) => error.message === 'mode_intent_unsupported' &&
      JSON.stringify(error.data.supported) === JSON.stringify(Object.keys(KIMI_MODE_INTENTS))
  );
  assert.equal(page.navigations.length, 0);
});

test('oneshot-kimi: deep-research opens the Deep Research page and records it as the mode', async () => {
  const { page } = makeKimi({ model: 'K3', effort: 'High' });
  const result = await kimiController(page).query({ prompt: 'probe', modeIntent: 'deep-research', timeoutMs: 2_000 });
  assert.deepEqual(page.navigations, ['https://www.kimi.ai/deep-research']);
  assert.deepEqual(result.meta.modeApplied.shown, { page: '/deep-research', model: 'K3', effort: 'High' });
  assert.equal(result.meta.answerSettings.mode, 'Deep Research; Thinking effort: High');
});

test('oneshot-kimi: the answer is read from the Markdown outside the thinking rollup, without code-block chrome', async () => {
  const answer = [
    el('p', { text: 'Here are the results:' }),
    el('div', {
      children: [
        el('header', { matches: [sel('answer-skip')], children: [el('span', { matches: [sel('code-language')], text: 'plain' }), el('span', { text: 'Copy' })] }),
        el('div', { children: [el('pre', { text: 'line one\nline two' })] })
      ]
    })
  ];
  const { page } = makeKimi({ answer });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.text, 'Here are the results:\n\n```plain\nline one\nline two\n```');
  assert.doesNotMatch(result.meta.plainText, /Thinking process/);
  assert.equal(result.meta.requestedModeIntent, null);
  assert.equal(result.meta.modeApplied, null);
});
