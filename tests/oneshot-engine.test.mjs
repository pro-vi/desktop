import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  OneShotController,
  compareStagedPrompt,
  matchAttachments,
  modeVerificationFor,
  normalizeToolUse,
  promptDeliveryFor,
  toolUseCounts
} from '../oneshot-engine.mjs';
import { parseOneShotProfile, ONESHOT_REQUIRED_ANCHORS } from '../oneshot-profile.mjs';
import { createFakePage, el } from './fixtures/oneshot-fake-dom.mjs';

const anchor = (id, selector, source = 'live-page') => ({
  id,
  branches: [{ id: `${id}-main`, kind: 'canonical', source, selector }]
});

const TEST_PROFILE = parseOneShotProfile({
  schemaVersion: 1,
  vendorId: 'testsite',
  contractVersion: 'test',
  capabilities: [{ id: 'composer', anchorIds: ['composer'] }],
  anchors: [
    anchor('composer', '#composer'),
    anchor('send-button', '#send'),
    anchor('send-disabled', '#send.off'),
    anchor('stop-button', '#stop'),
    anchor('file-input', 'input#files'),
    anchor('attachment-item', '.chip'),
    anchor('attachment-pending', '.chip.busy'),
    anchor('attachment-error', '.chip-error'),
    anchor('user-turn', '.turn-user'),
    anchor('assistant-turn', '.turn-assistant'),
    anchor('answer-body', '.answer'),
    anchor('answer-exclude', '.thinking'),
    anchor('answer-skip', '.code-head'),
    anchor('code-language', '.code-lang'),
    anchor('answer-error', '.turn-error'),
    anchor('citation', '.cite'),
    anchor('source-item', '.source-link'),
    anchor('signed-out-marker', '#login'),
    anchor('terms-gate', '#terms'),
    anchor('idle-signal', '.turn-actions'),
    anchor('blocking-notice', '#notice'),
    anchor('source-panel', '#source-panel')
  ]
}, { vendorId: 'testsite', requiredAnchorIds: ONESHOT_REQUIRED_ANCHORS });

const FAST = { pollMs: 1, stableMs: 15, sendAckMs: 200, sendEnableMs: 20, uploadMs: 200, uiCheckMs: 50, promptDeliveryMs: 200, menuMs: 50, controlMs: 100 };

// The answer bodies a test can put on the page, as element trees.
const answerTree = {
  plain: (text) => [text],
  rich: () => [
    el('h2', { text: 'Summary' }),
    el('p', { children: ['See ', el('a', { attrs: { href: 'https://example.org/report' }, matches: ['a[href]'], text: 'the report' }), ' for detail', el('span', { attrs: { 'data-url': 'https://news.example.com/a' }, matches: ['.cite'], text: '1' }), '.'] }),
    el('ul', { children: [el('li', { text: 'first' }), el('li', { children: ['second ', el('strong', { text: 'bold' })] })] }),
    el('div', {
      children: [
        el('header', { matches: ['.code-head'], children: [el('span', { matches: ['.code-lang'], text: 'python' }), el('button', { text: 'Copy' })] }),
        el('div', { children: [el('pre', { children: [el('code', { text: 'print(1)\n' })] })] })
      ]
    })
  ]
};

function siteState(overrides = {}) {
  return {
    signedOut: false,
    termsGate: false,
    composerText: '',
    selectAll: false,
    chips: [],
    injected: [],
    turns: [],
    stop: false,
    timeline: [],
    sendClicks: 0,
    staleTurnsOnOpen: 0,
    onFiles: (state, files) => {
      for (const file of files) state.chips.push({ name: file.name, busy: false, error: false });
    },
    ...overrides
  };
}

function renderSite(state) {
  const rows = [];
  if (state.signedOut) rows.push(el('button', { attrs: { id: 'login' }, matches: ['#login'], text: 'Log in' }));
  if (state.notice) rows.push(el('div', { matches: ['#notice'], text: state.notice }));
  if (state.termsGate) rows.push(el('div', { attrs: { id: 'terms' }, matches: ['#terms'], text: 'Accept terms' }));
  for (const turn of state.turns) {
    if (turn.role === 'user') {
      rows.push(el('div', { matches: ['.turn-user'], text: turn.text }));
    } else {
      const children = [];
      if (turn.thinking) children.push(el('div', { matches: ['.thinking'], children: [el('div', { matches: ['.answer'], text: turn.thinking })] }));
      children.push(el('div', { matches: ['.answer'], children: turn.body }));
      if (turn.error) children.push(el('div', { matches: ['.turn-error'], text: 'Something went wrong' }));
      if (turn.idle) children.push(el('div', { matches: ['.turn-actions'], text: 'Copy' }));
      rows.push(el('div', { matches: ['.turn-assistant'], children }));
    }
  }
  const hasText = !!state.composerText.trim();
  rows.push(el('div', {
    attrs: { id: 'composer', contenteditable: 'true' },
    matches: ['#composer'],
    text: state.composerText,
    rect: { x: 100, y: 600, w: 400, h: 40 }
  }));
  rows.push(el('div', {
    attrs: { id: 'send' },
    matches: hasText ? ['#send'] : ['#send', '#send.off'],
    rect: { x: 520, y: 600, w: 30, h: 30 },
    onClick: () => state.onSend?.(state)
  }));
  if (state.hiddenStop) rows.push(el('div', { matches: ['#stop-hidden'], hidden: true }));
  if (state.stop) rows.push(el('div', { attrs: { id: 'stop' }, matches: ['#stop'], rect: { x: 560, y: 600, w: 30, h: 30 } }));
  rows.push(...(state.extraRows || []));
  rows.push(el('input', {
    attrs: { type: 'file', id: 'files' },
    matches: ['input#files'],
    hidden: true,
    props: {
      multiple: true,
      set files(list) {
        state.injected.push(...list.map((file) => file.name));
        state.onFiles(state, list);
      }
    }
  }));
  for (const chip of state.chips) {
    const matches = chip.busy ? ['.chip', '.chip.busy'] : ['.chip'];
    rows.push(el('div', {
      matches,
      text: chip.label || chip.name,
      children: chip.error ? [el('span', { matches: ['.chip-error'], text: 'Upload failed' })] : []
    }));
  }
  return rows;
}

// A send pushes the user turn; each later read of the turns plays one step of
// the timeline, the way a streaming answer changes between polls.
function defaultOnSend(state) {
  state.sendClicks += 1;
  state.turns.push({ role: 'user', text: state.composerText });
  state.composerText = '';
  state.stop = true;
}

function makeSite(overrides = {}) {
  const state = siteState({ onSend: defaultOnSend, ...overrides });
  const page = createFakePage({
    state,
    render: renderSite,
    url: 'https://site.example/c/old',
    onNavigate: (url, fake) => {
      fake.state.turns = Array.from({ length: fake.state.staleTurnsOnOpen }, () => ({ role: 'user', text: 'old' }));
    },
    onEvaluate: (js, fake) => {
      if (!js.includes('function readTurns(') || fake.state.sendClicks === 0) return;
      const step = fake.state.timeline.shift();
      if (!step) return;
      const turns = fake.state.turns;
      let assistant = turns.findLast((turn) => turn.role === 'assistant');
      if (!assistant && step.body) {
        assistant = { role: 'assistant', body: [] };
        turns.push(assistant);
      }
      if (assistant && step.body) assistant.body = step.body;
      if (assistant && step.thinking !== undefined) assistant.thinking = step.thinking;
      if (assistant && step.error) assistant.error = true;
      if (assistant && step.idle !== undefined) assistant.idle = step.idle;
      if (step.stop !== undefined) fake.state.stop = step.stop;
    }
  });
  return { state, page };
}

function adapterFor({ modeConfirmed = true, onApplyMode = null, labelBeforeSend = () => 'Model X' } = {}) {
  return {
    vendorId: 'testsite',
    vendorName: 'Test Site',
    profile: TEST_PROFILE,
    modeIntents: { strong: { label: 'Strong' } },
    progressLabels: ['thinking'],
    freshChatUrl: (currentUrl, mode) => `https://site.example/new${mode ? `?mode=${mode.intent}` : ''}`,
    applyMode: async (ctx, mode) => {
      onApplyMode?.(mode);
      return { confirmed: modeConfirmed, shown: { model: 'Model X', mode: 'Strong' }, label: 'Model X' };
    },
    readModeLabel: async () => labelBeforeSend(),
    readAnswerSettings: async () => ({ model: 'Model X', mode: 'Strong', source: 'test-label' })
  };
}

function controllerFor(page, adapter = adapterFor(), extra = {}) {
  return new OneShotController({ page, adapter, stateDir: os.tmpdir(), timings: FAST, ...extra });
}

async function tempFiles(names) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-files-'));
  const paths = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, `synthetic ${name}`);
    paths.push(filePath);
  }
  return paths;
}

const stableAnswer = (body, extra = {}) => [
  { stop: true, body: answerTree.plain('') },
  { stop: true, body },
  { stop: false, idle: true, body, ...extra }
];

test('oneshot-engine: a query opens a fresh chat, applies the mode, uploads, types, sends and captures Markdown with sources', async () => {
  const appliedBeforeTyping = [];
  const adapter = adapterFor({ onApplyMode: () => appliedBeforeTyping.push(page.state.composerText) });
  const { state, page } = makeSite({ timeline: stableAnswer(answerTree.rich()) });
  const files = await tempFiles(['brief.pdf', 'cv.docx']);
  const controller = controllerFor(page, adapter);
  const phases = [];
  const result = await controller.query({
    prompt: 'Line one\nLine two',
    attachments: files,
    modeIntent: 'Strong',
    onProgress: (patch) => patch.phase && phases.push(patch.phase)
  });

  assert.deepEqual(page.navigations, ['https://site.example/new?mode=strong']);
  assert.deepEqual(appliedBeforeTyping, ['']);
  assert.deepEqual(state.injected, ['brief.pdf', 'cv.docx']);
  assert.equal(state.sendClicks, 1);
  assert.equal(state.turns[0].text, 'Line one\nLine two');
  assert.deepEqual(phases.slice(0, 7), ['opening_fresh_chat', 'waiting_for_ready', 'applying_mode', 'mode_intent_confirmed', 'uploading_files', 'typing_prompt', 'sending']);

  assert.equal(result.meta.completionEvidence.source, 'assistant-node');
  assert.equal(result.meta.oneShot, true);
  assert.equal(result.meta.requestedModeIntent, 'strong');
  assert.deepEqual(result.meta.modeApplied, { intent: 'strong', shown: { model: 'Model X', mode: 'Strong' }, label: 'Model X' });
  assert.deepEqual(result.meta.answerSettings, { model: 'Model X', mode: 'Strong', source: 'test-label', unreadReason: null });
  assert.equal(result.meta.freshChatUrl, 'https://site.example/new?mode=strong');
  assert.deepEqual(result.meta.attachments.map((item) => [item.name, item.matchedBy]), [['brief.pdf', 'name'], ['cv.docx', 'name']]);
  assert.equal(result.meta.promptDelivery.complete, true);
  assert.equal(result.text, [
    '## Summary',
    '',
    'See [the report](https://example.org/report) for detail [2](https://news.example.com/a).',
    '',
    '- first',
    '- second **bold**',
    '',
    '```python',
    'print(1)',
    '```',
    '',
    '## Sources',
    '',
    '2. [https://news.example.com/a](https://news.example.com/a)'
  ].join('\n'));
  assert.deepEqual(result.meta.sources, [
    { index: 1, url: 'https://example.org/report', title: 'the report', kinds: ['inline'] },
    { index: 2, url: 'https://news.example.com/a', title: '', kinds: ['citation'] }
  ]);
  assert.match(result.meta.plainText, /See the report for detail1\./);
});

test('oneshot-engine: an unknown mode intent fails before the page is touched', async () => {
  const { page } = makeSite();
  const controller = controllerFor(page);
  await assert.rejects(
    controller.query({ prompt: 'probe', timeoutMs: 400, modeIntent: 'turbo' }),
    (error) => error.message === 'mode_intent_unsupported' &&
      error.data.modeIntent === 'turbo' && error.data.supported.includes('strong')
  );
  assert.equal(page.evaluations.length, 0);
  assert.equal(page.navigations.length, 0);
});

test('oneshot-engine: a mode the page does not confirm fails before the composer is touched', async () => {
  const { state, page } = makeSite({ timeline: stableAnswer(answerTree.plain('never')) });
  const controller = controllerFor(page, adapterFor({ modeConfirmed: false }));
  await assert.rejects(
    controller.query({ prompt: 'probe', timeoutMs: 400, modeIntent: 'strong' }),
    (error) => error.message === 'mode_intent_unavailable' && error.data.reason === 'selection_not_confirmed'
  );
  assert.equal(state.composerText, '');
  assert.equal(state.sendClicks, 0);
  assert.equal(page.keys.length, 0);
});

test('oneshot-engine: an adapter error while selecting a mode is reported as mode_intent_unavailable', async () => {
  const { state, page } = makeSite();
  const adapter = adapterFor();
  adapter.applyMode = async () => {
    const error = new Error('mode_intent_unavailable');
    error.data = { reason: 'option_not_found', options: ['Fast'] };
    throw error;
  };
  await assert.rejects(
    controllerFor(page, adapter).query({ prompt: 'probe', timeoutMs: 400, modeIntent: 'strong' }),
    (error) => error.message === 'mode_intent_unavailable' && error.data.reason === 'option_not_found' &&
      error.data.options[0] === 'Fast'
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: a composer that does not hold the prompt fails with prompt_staging_failed and never sends', async () => {
  const { state, page } = makeSite({ dropText: (text) => (text === 'second line' ? '' : text) });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'first line\nsecond line\nthird line', timeoutMs: 400 }),
    (error) => error.message === 'prompt_staging_failed' &&
      error.data.firstDifference.line === 2 &&
      error.data.firstDifference.expected.startsWith('second line')
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: an upload error shown by the page fails before the prompt is typed', async () => {
  const files = await tempFiles(['brief.pdf']);
  const { state, page } = makeSite({
    onFiles: (site, list) => {
      for (const file of list) site.chips.push({ name: file.name, error: true });
    }
  });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400, attachments: files }),
    (error) => error.message === 'attachment_upload_failed' && error.data.reason === 'provider_error'
  );
  assert.equal(state.composerText, '');
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: an attachment the page never shows fails as attachment_not_shown before send', async () => {
  const files = await tempFiles(['brief.pdf']);
  const { state, page } = makeSite({ onFiles: () => {} });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400, attachments: files }),
    (error) => error.message === 'attachment_not_shown' && error.data.expected[0] === 'brief.pdf'
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: an upload still pending at the deadline fails as attachment_upload_stalled', async () => {
  const files = await tempFiles(['brief.pdf']);
  const { state, page } = makeSite({
    onFiles: (site, list) => {
      for (const file of list) site.chips.push({ name: file.name, busy: true });
    }
  });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400, attachments: files }),
    (error) => error.message === 'attachment_upload_stalled' && /brief\.pdf/.test(error.data.pendingText)
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: a chat that opens with turns already in it is not used', async () => {
  const { state, page } = makeSite({ staleTurnsOnOpen: 1 });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400 }),
    (error) => error.message === 'fresh_chat_unavailable' && error.data.userTurns === 1
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: a stable answer with the stop control still showing does not complete', async () => {
  const { page } = makeSite({ timeline: [{ stop: true, idle: true, body: answerTree.plain('Looks done') }] });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 120 }),
    (error) => error.message === 'timeout_waiting_for_response' && error.data.stopVisible === true
  );
});

test('oneshot-engine: a progress-only label and thinking text outside the answer do not complete', async () => {
  const { page } = makeSite({
    timeline: [{ stop: false, idle: true, body: answerTree.plain('Thinking…'), thinking: 'Reasoning about the request at length' }]
  });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 120 }),
    (error) => error.message === 'timeout_waiting_for_response' && error.data.answerChars > 0
  );
});

test('oneshot-engine: a provider error in the finished turn is not an answer', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Partial text'), { error: true }) });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400 }),
    (error) => error.message === 'provider_response_error'
  );
});

test('oneshot-engine: a signed-out page puts the tab in needs-attention until the sign-in marker is gone', async () => {
  const blocked = [];
  let unblocked = 0;
  const { state, page } = makeSite({ signedOut: true, timeline: stableAnswer(answerTree.plain('Hello')) });
  let reads = 0;
  const originalEvaluate = page.evaluate;
  page.evaluate = async (js) => {
    if (js.includes('function readPageState(') && ++reads === 3) state.signedOut = false;
    return await originalEvaluate(js);
  };
  const controller = controllerFor(page, adapterFor(), {
    onBlocked: async (st) => blocked.push(st.kind),
    onUnblocked: async () => { unblocked += 1; }
  });
  const result = await controller.query({ prompt: 'probe', timeoutMs: 400 });
  assert.deepEqual(blocked, ['login']);
  assert.equal(unblocked, 1);
  assert.equal(result.text, 'Hello');
});

test('oneshot-engine: a page that stays signed out times out waiting for the prompt with kind login', async () => {
  const { state, page } = makeSite({ signedOut: true });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 60 }),
    (error) => error.message === 'timeout_waiting_for_prompt' && error.data.kind === 'login'
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: model intents and image generation are refused, since sites take modeIntent only', async () => {
  const { page } = makeSite();
  const controller = controllerFor(page);
  await assert.rejects(controller.query({ prompt: 'p', modelIntent: 'gpt-5.5-pro' }), /model_intent_unsupported/);
  await assert.rejects(controller.query({ prompt: 'p', imageGeneration: true }), /image_generation_unsupported/);
  assert.equal(page.evaluations.length, 0);
});

test('oneshot-engine: unreadable answer settings are recorded with a reason, never filled from the request', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Hello')) });
  const adapter = adapterFor();
  adapter.readAnswerSettings = async () => ({ unreadReason: 'model_menu_missing' });
  const result = await controllerFor(page, adapter).query({ prompt: 'probe', timeoutMs: 400, modeIntent: 'strong' });
  assert.deepEqual(result.meta.answerSettings, { model: null, mode: null, source: null, unreadReason: 'model_menu_missing' });
});

test('oneshot-engine: a stop request aborts the run and clicks the visible stop control', async () => {
  const { page } = makeSite({ timeline: [{ stop: true, body: answerTree.plain('streaming') }] });
  const controller = controllerFor(page);
  const run = controller.query({ prompt: 'probe', timeoutMs: 5_000 });
  while (page.state.sendClicks === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const stopped = await controller.requestStop();
  assert.equal(stopped.requested, true);
  await assert.rejects(run, (error) => error.message === 'query_aborted');
});

test('oneshot-engine: compareStagedPrompt folds whitespace for rich text and names the differing line', () => {
  assert.equal(compareStagedPrompt('a\nb', 'a\n\nb'), null);
  assert.equal(compareStagedPrompt('a\nb', 'a\n\nb', { usesValue: true })?.firstDifference.line, 2);
  const diff = compareStagedPrompt('alpha\nbeta\ngamma', 'alpha\ngamma');
  assert.equal(diff.firstDifference.line, 2);
  assert.equal(diff.firstDifference.expected.startsWith('beta'), true);
});

test('oneshot-engine: matchAttachments matches full names, then stem and extension, then a unique stem, never by count', () => {
  const expected = [{ name: 'brief.pdf' }, { name: 'a-very-long-client-profile.docx' }];
  const byName = matchAttachments(expected, { items: [{ text: 'brief.pdf 12KB' }, { text: 'a-very-long-client-profile.docx' }] });
  assert.equal(byName.done, true);
  // Kimi and Gemini show the stem with the extension apart ("probe-brief PDF").
  const shown = matchAttachments([{ name: 'probe-brief.pdf' }, { name: 'probe-notes.docx' }], { items: [{ text: 'probe-brief PDF 622 Bytes' }, { text: 'DOCX probe-notes' }] });
  assert.deepEqual(shown.report.map((item) => item.matchedBy), ['stem-and-extension', 'stem-and-extension']);
  // A chip that names neither file is not counted as either.
  const shortened = matchAttachments(expected, { items: [{ text: 'brief.pdf' }, { text: 'a-very-lon….docx' }] });
  assert.deepEqual(shortened.report.map((item) => item.matchedBy), ['name', null]);
  assert.equal(shortened.done, false);
  // Two files with one stem: the docx chip cannot stand for the missing pdf.
  const sameStem = matchAttachments([{ name: 'case-brief.pdf' }, { name: 'case-brief.docx' }], { items: [{ text: 'case-brief DOCX' }] });
  assert.deepEqual(sameStem.report.map((item) => item.matchedBy), [null, 'stem-and-extension']);
  assert.equal(sameStem.done, false);
  // A chip showing only a shared stem names neither file for certain.
  const bareStem = matchAttachments([{ name: 'case-brief.pdf' }, { name: 'case-brief.docx' }], { items: [{ text: 'case-brief' }] });
  assert.deepEqual(bareStem.report.map((item) => item.matchedBy), [null, null]);
  const pending = matchAttachments(expected, { items: [{ text: 'brief.pdf', pending: true }, { text: 'a-very-long-client-profile.docx' }] });
  assert.equal(pending.done, false);
});

test('oneshot-engine: promptDeliveryFor reports lines missing from the recorded user turn', () => {
  assert.deepEqual(promptDeliveryFor('a', null), { checked: false });
  const report = promptDeliveryFor('First line\nSecond line\nThird', 'First line Third');
  assert.equal(report.complete, false);
  assert.equal(report.firstMissingLineNumber, 2);
  assert.deepEqual(report.missingLines, ['Second line']);
});

test('oneshot-engine: sources an adapter stamps on a citation chip become numbered links, without text fragments', async () => {
  const chip = el('span', { matches: ['.cite'], children: [el('button', { text: 'PMC +2' })] });
  const { page } = makeSite({ timeline: stableAnswer([el('p', { children: ['Risk rises with HbA1c.', chip] })]) });
  const adapter = adapterFor();
  const order = [];
  adapter.prepareCapture = async () => {
    order.push('prepare');
    chip.setAttribute('data-oneshot-sources', JSON.stringify([
      { url: 'https://pmc.example.gov/a#:~:text=first%20passage', title: 'Review A' },
      { url: 'https://pmc.example.gov/a#:~:text=second%20passage', title: 'Review A again' },
      { url: 'https://journal.example.org/b', title: 'Study B' }
    ]));
  };
  const result = await controllerFor(page, adapter).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(order, ['prepare']);
  assert.equal(result.text, [
    'Risk rises with HbA1c. [1](https://pmc.example.gov/a) [1](https://pmc.example.gov/a) [2](https://journal.example.org/b)',
    '',
    '## Sources',
    '',
    '1. [Review A](https://pmc.example.gov/a)',
    '2. [Study B](https://journal.example.org/b)'
  ].join('\n'));
  assert.deepEqual(result.meta.sources.map((item) => item.url), ['https://pmc.example.gov/a', 'https://journal.example.org/b']);
});

test('oneshot-engine: a file input revealed by a menu is closed again after the files are injected', async () => {
  const files = await tempFiles(['brief.pdf']);
  const { state, page } = makeSite({ timeline: stableAnswer(answerTree.plain('Done')) });
  const order = [];
  const adapter = adapterFor();
  adapter.revealFileInput = async () => {
    order.push('reveal');
    return { close: async () => order.push(`close after ${state.injected.length} injected`) };
  };
  await controllerFor(page, adapter).query({ prompt: 'probe', attachments: files, timeoutMs: 2_000 });
  assert.deepEqual(order, ['reveal', 'close after 1 injected']);
});

test('oneshot-engine: modeIntent none leaves the page selection alone, as it does for ChatGPT', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Hello')) });
  let applied = 0;
  const result = await controllerFor(page, adapterFor({ onApplyMode: () => { applied += 1; } })).query({ prompt: 'probe', modeIntent: 'none', timeoutMs: 2_000 });
  assert.equal(applied, 0);
  assert.equal(result.meta.requestedModeIntent, null);
});

test('oneshot-engine: an answer that pauses with no stop control does not complete until the turn shows its idle signal', async () => {
  const { page } = makeSite({
    timeline: [
      { stop: true, body: answerTree.plain('Part one.') },
      // A search pause: the stop control is gone but the answer is not done.
      ...Array.from({ length: 30 }, () => ({ stop: false, idle: false, body: answerTree.plain('Part one.') })),
      { stop: false, idle: true, body: answerTree.plain('Part one. Part two.') }
    ]
  });
  const result = await controllerFor(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.text, 'Part one. Part two.');
});

test('oneshot-engine: a stop branch that matches only a hidden node falls through to a visible one', async () => {
  const profile = parseOneShotProfile({
    schemaVersion: 1,
    vendorId: 'testsite',
    contractVersion: 'test',
    capabilities: [],
    anchors: [...TEST_PROFILE.anchors.values()].map((item) => (item.id === 'stop-button'
      ? { id: 'stop-button', branches: [
        { id: 'stop-hidden', kind: 'canonical', source: 'guess', selector: '#stop-hidden' },
        { id: 'stop-shown', kind: 'legacy', source: 'guess', selector: '#stop' }
      ] }
      : { id: item.id, branches: item.branches.map((branch) => ({ ...branch })) }))
  }, { vendorId: 'testsite', requiredAnchorIds: ONESHOT_REQUIRED_ANCHORS });
  const { page } = makeSite({ timeline: [{ stop: true, idle: true, body: answerTree.plain('Looks done') }] });
  const render = page.render;
  const adapter = { ...adapterFor(), profile };
  const originalEvaluate = page.evaluate;
  page.evaluate = async (js) => {
    page.state.hiddenStop = true;
    return await originalEvaluate(js);
  };
  void render;
  await assert.rejects(
    controllerFor(page, adapter).query({ prompt: 'probe', timeoutMs: 150 }),
    (error) => error.message === 'timeout_waiting_for_response' && error.data.stopVisible === true
  );
});

test('oneshot-engine: an assistant turn that appeared before Send is not taken as the answer', async () => {
  const { state, page } = makeSite({
    // The page adds an assistant turn once the files are in, before the prompt.
    onFiles: (site, list) => {
      for (const file of list) site.chips.push({ name: file.name });
      site.turns.push({ role: 'assistant', body: answerTree.plain('Files received.'), idle: true });
    },
    // The send shows no stop control, so only turn identity can hold the run.
    onSend: (site) => {
      site.sendClicks += 1;
      site.turns.push({ role: 'user', text: site.composerText });
      site.composerText = '';
    }
  });
  const files = await tempFiles(['brief.pdf']);
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', attachments: files, timeoutMs: 150 }),
    (error) => error.message === 'timeout_waiting_for_response'
  );
  assert.equal(state.sendClicks, 1);
});

test('oneshot-engine: a refusal notice after Send ends the run as send_refused', async () => {
  const { page } = makeSite({
    onSend: (site) => {
      site.sendClicks += 1;
      site.notice = 'Too many people are chatting right now.';
    }
  });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400 }),
    (error) => error.message === 'send_refused' && /Too many people/.test(error.data.notice)
  );
});

test('oneshot-engine: an emptied composer alone is not taken as a sent prompt', async () => {
  const { page } = makeSite({
    onSend: (site) => {
      site.sendClicks += 1;
      site.composerText = '';
    }
  });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 400 }),
    (error) => error.message === 'send_not_triggered'
  );
});

test('oneshot-engine: a page that sends on Shift+Return fails as prompt_sent_early', async () => {
  const { state, page } = makeSite();
  const sendKey = page.sendKey;
  page.sendKey = async (key, options) => {
    if (key === 'Return' && options?.modifiers?.includes('shift')) {
      state.turns.push({ role: 'user', text: state.composerText });
      state.composerText = '';
      return;
    }
    await sendKey(key, options);
  };
  await assert.rejects(
    controllerFor(page).query({ prompt: 'line one\nline two', timeoutMs: 400 }),
    (error) => error.message === 'prompt_sent_early'
  );
  assert.equal(state.sendClicks, 0);
});

test('oneshot-engine: attachments and mode are read again just before Send', async () => {
  const files = await tempFiles(['brief.pdf']);
  const cleared = makeSite();
  const insertText = cleared.page.insertText;
  cleared.page.insertText = async (text) => {
    cleared.state.chips = [];
    await insertText(text);
  };
  await assert.rejects(
    controllerFor(cleared.page).query({ prompt: 'probe', attachments: files, timeoutMs: 400 }),
    (error) => error.message === 'attachment_not_shown' && error.data.stage === 'before_send' && error.data.missing[0] === 'brief.pdf'
  );
  assert.equal(cleared.state.sendClicks, 0);

  const reset = makeSite();
  await assert.rejects(
    controllerFor(reset.page, adapterFor({ labelBeforeSend: () => 'Fast model' })).query({ prompt: 'probe', modeIntent: 'strong', timeoutMs: 400 }),
    (error) => error.message === 'mode_intent_unavailable' && error.data.reason === 'mode_changed_before_send'
  );
  assert.equal(reset.state.sendClicks, 0);
});

test('oneshot-engine: a model that changed between Send and the answer is recorded as downgraded', () => {
  const mode = { intent: 'strong' };
  const modeApplied = { intent: 'strong', shown: { model: 'Pro' } };
  assert.deepEqual(modeVerificationFor({ mode, modeApplied, answerSettings: { model: 'Pro' } }), {});
  assert.deepEqual(modeVerificationFor({ mode, modeApplied, answerSettings: { model: 'Fast' } }), {
    modeVerification: 'unverified',
    modeVerificationReason: 'mode_changed_after_send',
    degradedFrom: { modeIntent: 'strong', shownBeforeSend: 'Pro', shownAfterAnswer: 'Fast' }
  });
  assert.deepEqual(modeVerificationFor({ mode, modeApplied, answerSettings: { unreadReason: 'menu_missing' } }), {
    modeVerification: 'unverified',
    modeVerificationReason: 'menu_missing'
  });
});

test('oneshot-engine: intents resolve as own properties only', async () => {
  const { page } = makeSite();
  for (const intent of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(controllerFor(page).query({ prompt: 'probe', modeIntent: intent, timeoutMs: 400 }), /mode_intent_unsupported/);
  }
  assert.equal(page.navigations.length, 0);
});

test('oneshot-engine: a failure while preparing sources keeps the finished answer', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Hello')) });
  const adapter = adapterFor();
  adapter.prepareCapture = async () => { throw new Error('click_target_missing'); };
  const result = await controllerFor(page, adapter).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.text, 'Hello');
  assert.deepEqual(result.meta.captureNotes, { failed: true, reason: 'click_target_missing' });
});

test('oneshot-engine: a failure after Send records the chat that holds the reply', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Partial text'), { error: true }) });
  await assert.rejects(
    controllerFor(page).query({ prompt: 'probe', timeoutMs: 2_000 }),
    (error) => error.message === 'provider_response_error' && error.data.conversationUrl === 'https://site.example/new'
  );
});

test('oneshot-engine: panel sources come from the answer turn and the named panel only', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Hello')) });
  const render = page.evaluate;
  page.evaluate = async (js) => {
    page.state.extraRows = [
      el('div', { matches: ['#source-panel'], children: [el('a', { matches: ['.source-link', 'a[href]'], attrs: { href: 'https://panel.example/cited' }, text: 'Cited page' })] }),
      el('div', { children: [el('a', { matches: ['.source-link', 'a[href]'], attrs: { href: 'https://elsewhere.example/settings' }, text: 'Preferences' })] })
    ];
    return await render(js);
  };
  const result = await controllerFor(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.sources.map((item) => item.url), ['https://panel.example/cited']);
});

test('oneshot-engine: tool use keeps three states apart and never writes an empty list for unread', () => {
  assert.deepEqual(normalizeToolUse({ state: 'none' }), { state: 'none', reason: null, steps: [] });
  assert.deepEqual(normalizeToolUse({ state: 'unread', reason: 'expander_missing' }), { state: 'unread', reason: 'expander_missing', steps: null });
  assert.deepEqual(normalizeToolUse(undefined), { state: 'unread', reason: 'tool_use_unread', steps: null });
  assert.deepEqual(normalizeToolUse({ state: 'shown', steps: [] }), { state: 'unread', reason: 'tool_use_shown_without_steps', steps: null });
  const shown = normalizeToolUse({ state: 'shown', steps: [{ tool: 'web_search', title: ' Found 2 web pages ', count: 2, pages: [{ url: 'https://a.example/', title: 'A' }, { url: '' }] }] });
  assert.deepEqual(shown, { state: 'shown', reason: null, steps: [{ tool: 'web_search', title: 'Found 2 web pages', query: null, count: 2, pages: [{ url: 'https://a.example/', title: 'A', site: null }] }] });
  assert.deepEqual(toolUseCounts(shown), { state: 'shown', reason: null, stepCount: 1, searchCount: 1, pageCount: 1 });
  assert.deepEqual(toolUseCounts(normalizeToolUse({ state: 'unread', reason: 'x' })), { state: 'unread', reason: 'x', stepCount: null, searchCount: null, pageCount: null });
});

test('oneshot-engine: an adapter without a tool-use reader records tool use as unread with that reason', async () => {
  const { page } = makeSite({ timeline: stableAnswer(answerTree.plain('Hello')) });
  const result = await controllerFor(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.toolUse, { state: 'unread', reason: 'adapter_has_no_tool_use_reader', steps: null });
});

test('oneshot-engine: a chip whose child nodes match the chip selector counts as one chip', async () => {
  const { runInDocument, createDocument } = await import('./fixtures/oneshot-fake-dom.mjs');
  const { pageScript, readAttachments } = await import('../oneshot-page-scripts.mjs');
  const chip = el('div', {
    matches: ['[class*="file-card"]'],
    children: [
      el('span', { matches: ['[class*="file-card"]'], text: 'a.pdf' }),
      el('span', { matches: ['[class*="file-card"]'], text: 'PDF 12 KB' })
    ]
  });
  const document = createDocument({ body: [chip] });
  const shown = await runInDocument(pageScript(readAttachments, { attachmentItem: ['[class*="file-card"]'], attachmentPending: [], attachmentError: [] }), document);
  assert.equal(shown.items.length, 1);
  assert.equal(shown.items[0].text, 'a.pdfPDF 12 KB');
});
