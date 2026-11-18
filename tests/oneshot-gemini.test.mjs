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
const FAST = { pollMs: 1, stableMs: 15, sendAckMs: 200, sendEnableMs: 20, uploadMs: 200, uiCheckMs: 50, promptDeliveryMs: 200, menuMs: 50, controlMs: 100 };

const OPTIONS = [
  { label: 'Everyday help', sublabel: '4 Hydrogen' },
  { label: 'Solves complex problems', sublabel: '4 Hydrogen Thinking' },
  { label: 'Detailed research', sublabel: '3.1 Pro' }
];

// Sources behind each citation chip, revealed in a hover card when clicked.
// A chip citing attached files opens a card of file names with no links.
const FILE_CARD = ['sow_profile_current_short.docx', 'doc_06_share_purchase_agreement.pdf'];

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
        hidden: state.zeroSizeChip === index,
        onClick: () => { state.openCard = index; state.cardClicks.push(index); },
        text: index ? 'PMC +1' : 'NIH'
      })]
    }));
    turn.chips = turn.chips || chips;
    rows.push(el('model-response', {
      matches: [sel('assistant-turn')],
      children: [
        ...(state.thoughts ? [el('model-thoughts', { matches: [sel('answer-exclude')], children: [el('message-content', { children: [el('div', { matches: [sel('answer-body')], text: 'Show thinking' })] })] })] : []),
        el('message-content', {
          children: [el('div', {
            matches: [sel('answer-body')],
            children: [el('p', { children: ['Control blood sugar.', turn.chips[0], ' Treat gum disease.', turn.chips[1]] })]
          })]
        }),
        el('sources-list', { matches: [sel('sources-list')], children: (state.listedSources || []).map((site) => el('a', { matches: ['a[href]'], attrs: { href: site.url }, text: site.title })) }),
        ...(state.stop ? [] : [el('message-actions', { matches: [sel('idle-signal')], text: 'Copy' })])
      ]
    }));
  }
  if (state.openCard !== null) {
    rows.push(el('div', {
      children: state.fileCards
        ? FILE_CARD.map((name) => el('div', { matches: [sel('source-card-file')], text: name }))
        : CHIP_SOURCES[state.openCard].map((link) => el('a', { matches: [sel('source-card-link')], attrs: { href: link.href }, text: link.text }))
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

  if (!state.pickerHidden) rows.push(el('button', {
    matches: [sel('mode-trigger')],
    attrs: { 'aria-expanded': String(state.menu === 'mode') },
    rect: { x: 700, y: 640, w: 120, h: 30 },
    onClick: () => { state.menu = state.menu === 'mode' ? null : 'mode'; },
    // The live picker shortened "3.1 Pro" to "Pro" once selected (2026-11-18).
    children: [el('div', { matches: [sel('mode-trigger-label')], text: state.model === '3.1 Pro' ? 'Pro' : state.model })]
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
    onClick: () => { state.menu = state.menu === 'tools' ? null : 'tools'; state.inputsCreated = true; }
  }));
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
    menu: null, openCard: null, inputsCreated: false, cardClicks: [], zeroSizeChip: null, stickyCard: false,
    signedOut: false, terms: false,
    composerText: '', selectAll: false, turns: [], chips: [], stop: false, sent: 0, reads: 0
  };
  const page = createFakePage({
    state,
    render: renderGemini,
    url,
    onNavigate: (next, fake) => { fake.state.turns = []; },
    onEvaluate: (js, fake) => {
      if (!js.includes('function readTurns(') || !fake.state.sent) return;
      fake.state.reads += 1;
      if (fake.state.reads === 2) fake.state.turns.push({ role: 'assistant' });
      if (fake.state.reads === 3) fake.state.stop = false;
    }
  });
  const sendKey = page.sendKey;
  page.sendKey = async (key, options) => {
    if (key === 'Escape' && !state.stickyCard) state.openCard = null;
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
  assert.deepEqual(result.meta.modeApplied, { intent: 'pro', shown: { model: '3.1 Pro', option: 'Detailed research', selection: 'Detailed research' }, label: 'Pro' });
  assert.deepEqual(result.meta.answerSettings, { model: '3.1 Pro', mode: 'Detailed research', selection: 'Detailed research', source: 'mode-picker-menu-after-answer', unreadReason: null });
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

test('oneshot-gemini: deep-research is refused before any page work, since its final report has no completion check', async () => {
  const { page } = makeGemini();
  await assert.rejects(geminiController(page).query({ prompt: 'probe', modeIntent: 'deep-research' }), /mode_intent_unsupported/);
  assert.equal(page.navigations.length, 0);
});

test('oneshot-gemini: a citation chip with no size is skipped, not clicked', async () => {
  const { state, page } = makeGemini();
  state.zeroSizeChip = 0;
  const result = await geminiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(state.cardClicks, [1]);
  assert.deepEqual(result.meta.sources.map((item) => item.url), ['https://pmc.ncbi.nlm.nih.gov/b', 'https://pmc.ncbi.nlm.nih.gov/c']);
});

test('oneshot-gemini: a source card that does not close stops the chip loop instead of mislabeling the next chip', async () => {
  const { state, page } = makeGemini();
  state.stickyCard = true;
  const result = await geminiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(state.cardClicks, [0]);
  assert.equal(result.meta.captureNotes.stopped, 'card_still_open');
  assert.deepEqual(result.meta.sources.map((item) => item.url), ['https://www.nih.gov/a']);
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
  const { state, page } = makeGemini();
  state.thoughts = true;
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
  assert.deepEqual(Object.keys(GEMINI_MODE_INTENTS), ['fast', 'thinking', 'pro']);
  const { page } = makeGemini();
  await assert.rejects(geminiController(page).query({ prompt: 'probe', modeIntent: 'extended-pro' }), /mode_intent_unsupported/);
});

test('oneshot-gemini: tool use is the sources list when it has links, unread behind a thinking panel, and none otherwise', async () => {
  const listed = makeGemini();
  listed.state.listedSources = [{ url: 'https://www.nih.gov/a', title: 'NIH' }, { url: 'https://example.org/b', title: 'Example' }];
  const shown = await geminiController(listed.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(shown.meta.toolUse, { state: 'shown', reason: null, steps: [{ tool: 'sources_list', title: 'Sources', query: null, count: 2, pages: [
    { url: 'https://www.nih.gov/a', title: 'NIH', site: null },
    { url: 'https://example.org/b', title: 'Example', site: null }
  ] }] });

  const thinking = makeGemini();
  thinking.state.thoughts = true;
  const unread = await geminiController(thinking.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(unread.meta.toolUse, { state: 'unread', reason: 'thinking_panel_not_read', steps: null });

  const plain = await geminiController(makeGemini().page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(plain.meta.toolUse, { state: 'none', reason: null, steps: [] });
});

test('oneshot-gemini: a mode picker drawn after the composer is waited for, not reported missing', async () => {
  const { state, page } = makeGemini();
  let reads = 0;
  const evaluate = page.evaluate;
  page.evaluate = async (js) => {
    if (js.includes('function readGeminiModePicker(')) reads += 1;
    state.pickerHidden = reads < 3;
    return await evaluate(js);
  };
  const result = await geminiController(page).query({ prompt: 'probe', modeIntent: 'pro', timeoutMs: 2_000 });
  assert.equal(result.meta.modeApplied.shown.model, '3.1 Pro');
});

test('oneshot-gemini: a citation of attached files is kept as file sources without links', async () => {
  const { state, page } = makeGemini();
  state.fileCards = true;
  const result = await geminiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.sources.map((item) => [item.index, item.url, item.file]), [
    [1, null, 'sow_profile_current_short.docx'],
    [2, null, 'doc_06_share_purchase_agreement.pdf']
  ]);
  assert.match(result.text, /Control blood sugar\. \[1\] \[2\] Treat gum disease\. \[1\] \[2\]/);
  assert.match(result.text, /## Sources\n\n1\. sow_profile_current_short\.docx \(attached file\)\n2\. doc_06_share_purchase_agreement\.pdf \(attached file\)/);
});
