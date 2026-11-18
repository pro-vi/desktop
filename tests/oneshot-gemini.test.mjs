import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OneShotController } from '../oneshot-engine.mjs';
import { ONESHOT_REQUIRED_ANCHORS } from '../oneshot-profile.mjs';
import { geminiAdapter, geminiFreshChatUrl, GEMINI_MODE_INTENTS } from '../oneshot-sites/gemini.mjs';
import { oneShotAdapterFor } from '../oneshot-sites/index.mjs';
import { createFakePage, el } from './fixtures/oneshot-fake-dom.mjs';

const sel = (anchorId) => geminiAdapter.profile.selectorsFor(anchorId)[0];
const FAST = { pollMs: 1, stableMs: 15, sendAckMs: 200, sendEnableMs: 20, uploadMs: 200, uiCheckMs: 50, promptDeliveryMs: 200, menuMs: 50 };

const OPTIONS = [
  { label: 'Everyday help', sublabel: '4 Hydrogen' },
  { label: 'Solves complex problems', sublabel: '4 Hydrogen Thinking' },
  { label: 'Detailed research', sublabel: '3.1 Pro' }
];

// Sources behind each citation chip, revealed in a hover card when clicked.
const CHIP_SOURCES = [
  [{ href: 'https://www.nih.gov/a#:~:text=risk', text: 'NIH\nInfection risk' }],
  [
    { href: 'https://pmc.ncbi.nlm.nih.gov/b#:~:text=one', text: 'PubMed Central - NIH\nReview' },
    { href: 'https://pmc.ncbi.nlm.nih.gov/c', text: 'PubMed Central - NIH\nTrial' }
  ]
];

// gemini.google.com/app as read on 2026-11-18 (composer, picker, tools) with
// turns shaped like Gemini's public share pages.
function renderGemini(state) {
  const rows = [];
  if (state.signedOut) rows.push(el('gem-button', { matches: [sel('signed-out-marker')], text: 'Sign in' }));
  if (state.terms) rows.push(el('div', { matches: [sel('terms-gate')], text: 'Chat with Gemini' }));
  for (const turn of state.turns) {
    if (turn.role === 'user') {
      rows.push(el('user-query', { matches: [sel('user-turn')], text: turn.text }));
      continue;
    }
    const chips = CHIP_SOURCES.map((_, index) => el('source-inline-chip', {
      matches: [sel('citation')],
      children: [el('button', {
        matches: [sel('citation-button')],
        rect: { x: 300 + index * 80, y: 300, w: 60, h: 20 },
        onClick: () => { state.openCard = index; },
        text: index ? 'PMC +1' : 'NIH'
      })]
    }));
    turn.chips = turn.chips || chips;
    rows.push(el('model-response', {
      matches: [sel('assistant-turn')],
      children: [
        el('model-thoughts', { matches: [sel('answer-exclude')], children: [el('message-content', { children: [el('div', { matches: [sel('answer-body')], text: 'Show thinking' })] })] }),
        el('message-content', {
          children: [el('div', {
            matches: [sel('answer-body')],
            children: [el('p', { children: ['Control blood sugar.', turn.chips[0], ' Treat gum disease.', turn.chips[1]] })]
          })]
        })
      ]
    }));
  }
  if (state.openCard !== null) {
    rows.push(el('div', {
      children: CHIP_SOURCES[state.openCard].map((link) => el('a', { matches: [sel('source-card-link')], attrs: { href: link.href }, text: link.text }))
    }));
  }
  rows.push(el('div', {
    matches: [sel('composer')],
    text: state.composerText,
    rect: { x: 100, y: 600, w: 400, h: 40 },
    onClick: () => { state.menuAtTyping = state.menu; }
  }));
  if (state.composerText.trim()) {
    rows.push(el('button', {
      matches: [sel('send-button')],
      rect: { x: 520, y: 600, w: 30, h: 30 },
      onClick: () => {
        state.turns.push({ role: 'user', text: state.composerText });
        state.composerText = '';
        state.stop = true;
        state.sent += 1;
      }
    }));
  }
  if (state.stop) rows.push(el('button', { matches: [sel('stop-button')], rect: { x: 560, y: 600, w: 30, h: 30 } }));

  rows.push(el('button', {
    matches: [sel('mode-trigger')],
    attrs: { 'aria-expanded': String(state.menu === 'mode') },
    rect: { x: 700, y: 640, w: 120, h: 30 },
    onClick: () => { state.menu = state.menu === 'mode' ? null : 'mode'; },
    children: [el('div', { matches: [sel('mode-trigger-label')], text: state.model })]
  }));
  if (state.menu === 'mode') {
    OPTIONS.forEach((option, i) => rows.push(el('gem-menu-item', {
      matches: [sel('mode-option')],
      attrs: { 'aria-checked': String(state.model === option.sublabel), 'aria-disabled': String(state.locked.includes(option.label)) },
      rect: { x: 700, y: 400 + i * 50, w: 200, h: 44 },
      onClick: () => {
        if (state.locked.includes(option.label)) return;
        state.model = option.sublabel;
        state.menu = null;
      },
      children: [el('span', { matches: [sel('mode-option-label')], text: option.label }), el('div', { matches: [sel('mode-option-sublabel')], text: option.sublabel })]
    })));
  }
  rows.push(el('button', {
    matches: [sel('upload-menu-button')],
    rect: { x: 60, y: 640, w: 30, h: 30 },
    onClick: () => { state.menu = state.menu === 'tools' || state.menu === 'more' ? null : 'tools'; state.inputsCreated = true; }
  }));
  if (state.menu === 'tools' || state.menu === 'more') {
    rows.push(el('button', { matches: [sel('tool-item')], attrs: { 'aria-checked': 'false' }, rect: { x: 60, y: 500, w: 200, h: 30 }, text: 'Canvas' }));
    rows.push(el('button', { matches: [sel('tool-more')], rect: { x: 60, y: 540, w: 200, h: 30 }, onClick: () => { state.menu = 'more'; }, text: 'More tools' }));
  }
  if (state.menu === 'more') {
    rows.push(el('button', {
      matches: [sel('tool-item')],
      attrs: { 'aria-checked': String(state.deepResearch) },
      rect: { x: 280, y: 540, w: 200, h: 30 },
      onClick: () => { state.deepResearch = true; state.menu = null; },
      text: 'Deep research'
    }));
  }
  if (state.deepResearch) rows.push(el('button', { matches: [sel('deep-research-chip')], text: 'Deep research' }));
  if (state.inputsCreated) {
    rows.push(el('input', {
      attrs: { type: 'file' },
      matches: [sel('file-input')],
      hidden: true,
      props: { multiple: true, set files(list) { state.injectedWhileMenu = state.menu; for (const file of list) state.chips.push(file.name); } }
    }));
  }
  for (const chip of state.chips) rows.push(el('uploader-file-preview', { matches: [sel('attachment-item')], text: chip }));
  return rows;
}

function makeGemini({ model = '4 Hydrogen', locked = [], url = 'https://gemini.google.com/app' } = {}) {
  const state = {
    model, locked, url,
    menu: null, openCard: null, deepResearch: false, inputsCreated: false,
    signedOut: false, terms: false,
    composerText: '', selectAll: false, turns: [], chips: [], stop: false, sent: 0, reads: 0
  };
  const page = createFakePage({
    state,
    render: renderGemini,
    url,
    onNavigate: (next, fake) => { fake.state.turns = []; fake.state.deepResearch = false; },
    onEvaluate: (js, fake) => {
      if (!js.includes('function readTurns(') || !fake.state.sent) return;
      fake.state.reads += 1;
      if (fake.state.reads === 2) fake.state.turns.push({ role: 'assistant' });
      if (fake.state.reads === 3) fake.state.stop = false;
    }
  });
  const sendKey = page.sendKey;
  page.sendKey = async (key, options) => {
    if (key === 'Escape') state.openCard = null;
    await sendKey(key, options);
  };
  return { state, page };
}

const geminiController = (page) => new OneShotController({ page, adapter: geminiAdapter, stateDir: os.tmpdir(), timings: FAST });

test('oneshot-gemini: the profile loads with every required anchor and both one-shot sites are registered', () => {
  assert.equal(oneShotAdapterFor('gemini'), geminiAdapter);
  for (const anchorId of ONESHOT_REQUIRED_ANCHORS) assert.ok(geminiAdapter.profile.selectorsFor(anchorId).length > 0, anchorId);
  assert.equal(sel('composer'), 'div.ql-editor[contenteditable="true"][role="textbox"]');
  assert.equal(sel('send-button'), 'button[aria-label="Send message"]');
});

test('oneshot-gemini: a fresh chat keeps the signed-in account path', () => {
  assert.equal(geminiFreshChatUrl('https://gemini.google.com/u/1/app/abc123'), 'https://gemini.google.com/u/1/app');
  assert.equal(geminiFreshChatUrl('https://gemini.google.com/app/abc123'), 'https://gemini.google.com/app');
  assert.equal(geminiFreshChatUrl('https://www.kimi.ai/'), 'https://gemini.google.com/app');
});

test('oneshot-gemini: pro selects the Detailed research option and records the model the picker shows', async () => {
  const { state, page } = makeGemini();
  const result = await geminiController(page).query({ prompt: 'probe', modeIntent: 'pro', timeoutMs: 2_000 });
  assert.equal(state.model, '3.1 Pro');
  assert.deepEqual(result.meta.modeApplied, { intent: 'pro', shown: { model: '3.1 Pro', option: 'Detailed research' } });
  assert.deepEqual(result.meta.answerSettings, { model: '3.1 Pro', mode: null, source: 'mode-picker-after-answer', unreadReason: null });
});

test('oneshot-gemini: a disabled option fails closed before the composer is touched', async () => {
  const { state, page } = makeGemini({ locked: ['Detailed research'] });
  await assert.rejects(
    geminiController(page).query({ prompt: 'probe', modeIntent: 'pro', timeoutMs: 2_000 }),
    (error) => error.message === 'mode_intent_unavailable' && error.data.reason === 'option_disabled' &&
      error.data.options.includes('Detailed research (3.1 Pro)')
  );
  assert.equal(state.composerText, '');
  assert.equal(state.sent, 0);
});

test('oneshot-gemini: deep-research turns on the tool under More tools and is confirmed by its chip', async () => {
  const { state, page } = makeGemini();
  const result = await geminiController(page).query({ prompt: 'probe', modeIntent: 'deep-research', timeoutMs: 2_000 });
  assert.equal(state.deepResearch, true);
  assert.deepEqual(result.meta.modeApplied.shown, { tool: 'Deep research' });
  assert.equal(result.meta.answerSettings.mode, 'Deep research');
});

test('oneshot-gemini: files go into the documents input that Upload & tools creates, and the menu is closed after', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-gemini-files-'));
  const file = path.join(dir, 'brief.pdf');
  await fs.writeFile(file, 'synthetic pdf');
  const { state, page } = makeGemini();
  const result = await geminiController(page).query({ prompt: 'probe', attachments: [file], timeoutMs: 2_000 });
  assert.equal(state.injectedWhileMenu, 'tools');
  assert.equal(state.menuAtTyping, null);
  assert.deepEqual(result.meta.attachments.map((item) => [item.name, item.matchedBy]), [['brief.pdf', 'name']]);
  assert.equal(state.turns[0].text, 'probe');
});

test('oneshot-gemini: citation chips are opened one at a time and their card links become the answer sources', async () => {
  const { page } = makeGemini();
  const result = await geminiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.text, [
    'Control blood sugar. [1](https://www.nih.gov/a) Treat gum disease. [2](https://pmc.ncbi.nlm.nih.gov/b) [3](https://pmc.ncbi.nlm.nih.gov/c)',
    '',
    '## Sources',
    '',
    '1. [NIH Infection risk](https://www.nih.gov/a)',
    '2. [PubMed Central - NIH Review](https://pmc.ncbi.nlm.nih.gov/b)',
    '3. [PubMed Central - NIH Trial](https://pmc.ncbi.nlm.nih.gov/c)'
  ].join('\n'));
  assert.doesNotMatch(result.meta.plainText, /Show thinking/);
});

test('oneshot-gemini: a terms gate blocks the run as needing the page made ready', async () => {
  const { state, page } = makeGemini();
  state.terms = true;
  const blocked = [];
  const controller = new OneShotController({ page, adapter: geminiAdapter, timings: FAST, onBlocked: async (st) => blocked.push(st.kind) });
  await assert.rejects(controller.query({ prompt: 'probe', timeoutMs: 60 }), (error) => error.message === 'timeout_waiting_for_prompt' && error.data.kind === 'ui');
  assert.deepEqual(blocked, ['ui']);
  assert.equal(state.sent, 0);
});

test('oneshot-gemini: intents name purposes, not ChatGPT modes', async () => {
  assert.deepEqual(Object.keys(GEMINI_MODE_INTENTS), ['fast', 'thinking', 'pro', 'deep-research']);
  const { page } = makeGemini();
  await assert.rejects(geminiController(page).query({ prompt: 'probe', modeIntent: 'extended-pro' }), /mode_intent_unsupported/);
});
