import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OneShotController } from '../oneshot-engine.mjs';
import { ONESHOT_BRANCH_SOURCES, ONESHOT_REQUIRED_ANCHORS } from '../oneshot-profile.mjs';
import { kimiAdapter, kimiFreshChatUrl, KIMI_MODE_INTENTS } from '../oneshot-sites/kimi.mjs';
import { oneShotAdapterFor } from '../oneshot-sites/index.mjs';
import { createFakePage, el, FAST_TIMINGS as FAST } from './fixtures/oneshot-fake-dom.mjs';

const sel = (anchorId) => kimiAdapter.profile.selectorsFor(anchorId)[0];

const MODELS = [
  { label: 'K3.1 Pro', key: 'k3d1-agent' },
  { label: 'K2.8 Preview', key: 'k28-agent-preview' },
  { label: 'Instant', key: 'k28-instant' }
];

// A Kimi composer as read from the signed-in www.kimi.ai page on 2026-11-18,
// with turns shaped like Kimi's public share pages. Every element answers to
// the canonical selector of its profile anchor.
function renderKimi(state, page) {
  const rows = [];
  for (const turn of state.turns) {
    if (turn.role === 'user') {
      rows.push(el('div', {
        matches: [sel('user-turn')],
        children: [
          ...(turn.files || []).map((file) => el('div', { matches: [sel('turn-attachment-item')], text: file })),
          el('div', { text: turn.text })
        ]
      }));
      continue;
    }
    const flow = turn.toolFlow ? [renderToolFlow(state, turn)] : [];
    // A tool flow outside the rollup whose thinking text uses the answer's
    // Markdown class; the answer exclusion must still keep it out.
    const looseFlow = state.flowOutsideRollup
      ? [el('div', { matches: [sel('tool-flow')], children: [el('div', { matches: [sel('answer-body')], text: 'Thinking text in the flow' })] })]
      : [];
    rows.push(el('div', {
      matches: [sel('assistant-turn')],
      children: [
        ...(state.rollup ? [el('div', { matches: [sel('answer-exclude')], children: [el('div', { matches: [sel('answer-body')], text: 'Thinking process' }), ...flow] })] : []),
        ...looseFlow,
        el('div', { children: [el('div', { matches: [sel('answer-body')], children: turn.body })] }),
        ...(state.stop ? [] : [el('div', {
          matches: [sel('idle-signal')],
          children: turn.references ? [el('div', {
            matches: [sel('reference-toggle')],
            rect: { x: 400, y: 520, w: 80, h: 20 },
            onClick: () => { state.panelOpen = true; },
            text: 'Reference'
          })] : []
        })])
      ]
    }));
    if (turn.references && state.panelOpen) {
      rows.push(el('div', {
        matches: [sel('source-panel')],
        children: turn.references.map((ref) => el('a', { matches: [sel('source-item'), 'a[href]'], attrs: { href: ref.url }, text: ref.title }))
      }));
    }
  }
  if (state.notice) rows.push(el('div', { matches: [sel('blocking-notice')], text: state.notice }));
  rows.push(el('div', { matches: [sel('composer')], text: state.composerText, rect: { x: 100, y: 600, w: 400, h: 40 } }));
  const hasText = !!state.composerText.trim();
  rows.push(el('div', {
    matches: hasText ? [sel('send-button')] : [sel('send-button'), sel('send-disabled')],
    rect: { x: 520, y: 600, w: 30, h: 30 },
    onClick: () => {
      if (!hasText) return;
      state.turns.push({ role: 'user', text: state.composerText, files: state.chips.splice(0) });
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
  // A file list elsewhere on the page, with the same card and delete classes.
  if (state.foreignCards.length) {
    rows.push(el('div', {
      children: state.foreignCards.map((card, i) => el('div', {
        matches: [sel('attachment-item')],
        rect: { x: 700, y: 100 + i * 80, w: 200, h: 70 },
        text: card,
        children: [el('div', { matches: [sel('attachment-remove')], rect: { x: 880, y: 105 + i * 80, w: 14, h: 14 }, onClick: () => { state.foreignDeleted += 1; } })]
      }))
    }));
  }
  const area = [];
  state.chips.forEach((chip, i) => {
    const box = { x: 100 + i * 210, y: 400, w: 200, h: 70 };
    const inBox = (point) => !!point && point[0] >= box.x && point[0] <= box.x + box.w && point[1] >= box.y && point[1] <= box.y + box.h;
    area.push(el('div', {
      matches: [sel('attachment-item')],
      rect: box,
      text: chip,
      children: [el('div', {
        matches: [sel('attachment-remove')],
        rect: { x: box.x + 180, y: box.y + 5, w: 14, h: 14 },
        // Kimi's delete control works only once the pointer has rested on the
        // chip, before the click's own move.
        onClick: () => { if (inBox(page.moves[page.moves.length - 2])) state.chips.splice(i, 1); }
      })]
    }));
  });
  if (area.length) rows.push(el('div', { matches: [sel('attachment-area')], children: area }));

  rows.push(el('div', {
    matches: [sel('mode-trigger')],
    attrs: { 'aria-expanded': state.menu ? 'true' : 'false' },
    rect: { x: 100, y: 560, w: 120, h: 30 },
    onClick: () => { state.menu = state.menu ? null : 'main'; },
    children: [
      el('span', { matches: [sel('mode-trigger-model')], text: state.model }),
      // A browser's innerText of an element that is not rendered is its full
      // text, so a hidden label still reads "High" unless visibility is checked.
      el('span', { matches: [sel('mode-trigger-effort')], text: state.effort, hidden: !!state.effortHidden, props: state.effortHidden ? { innerText: state.effort } : {} })
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

// The answer's tool-call flow as read live on 2026-11-18: a summary toggle,
// a thinking step, and a web-search step whose trigger reveals the pages.
function renderToolFlow(state, turn) {
  const steps = turn.toolFlow.map((step, index) => {
    const detailId = `toolcall-detail-${index}`;
    if (step.thinking) {
      return el('div', { matches: [sel('tool-step'), sel('tool-step-thinking')], attrs: { class: 'toolcall-container thinking-container' }, children: [el('span', { matches: [sel('tool-step-title')], text: step.title })] });
    }
    const expanded = !!state.expandedSteps?.[index];
    return el('div', {
      matches: [sel('tool-step')],
      attrs: { class: `toolcall-container default toolcall-${step.tool}` },
      children: [
        el('div', {
          matches: [sel('tool-step-trigger')],
          attrs: { 'aria-controls': detailId, 'aria-expanded': String(expanded) },
          rect: { x: 300, y: 100 + index * 40, w: 200, h: 30 },
          hidden: !state.flowOpen,
          onClick: () => { state.expandedSteps = { ...(state.expandedSteps || {}), [index]: true }; },
          children: [el('span', { matches: [sel('tool-step-title')], text: step.title })]
        }),
        el('div', {
          attrs: { id: detailId },
          children: expanded ? step.pages.map((page) => el('a', {
            matches: [sel('tool-step-link')],
            attrs: { href: page.url },
            children: [el('span', { matches: [sel('tool-step-link-title')], text: page.title }), el('span', { matches: [sel('tool-step-link-site')], text: page.site })]
          })) : []
        })
      ]
    });
  });
  return el('div', {
    matches: [sel('tool-flow')],
    children: [
      el('button', {
        matches: [sel('tool-flow-toggle')],
        attrs: { 'aria-expanded': String(!!state.flowOpen) },
        rect: { x: 300, y: 60, w: 300, h: 30 },
        onClick: () => { state.flowOpen = true; },
        text: 'Summarized two files'
      }),
      ...steps
    ]
  });
}

function makeKimi({ model = 'Instant', effort = 'Standard', locked = [], answer = null, toolFlow = null, references = null, chips = [], foreignCards = [], rollup = true, url = 'https://www.kimi.ai/chat/old' } = {}) {
  const state = {
    model,
    effort,
    menu: null,
    composerText: '',
    selectAll: false,
    turns: [],
    chips: [...chips],
    foreignCards: [...foreignCards],
    foreignDeleted: 0,
    rollup,
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
      if (fake.state.reads === 2) fake.state.turns.push({ role: 'assistant', body: answer || ['Answer'], toolFlow, references });
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
});

test('oneshot-kimi: k3.1-pro selects the model and High effort, confirmed on the trigger, before typing', async () => {
  const { state, page } = makeKimi();
  const result = await kimiController(page).query({ prompt: 'probe', modeIntent: 'k3.1-pro', timeoutMs: 2_000 });
  assert.equal(state.model, 'K3.1 Pro');
  assert.equal(state.effort, 'High');
  assert.deepEqual(result.meta.modeApplied, { intent: 'k3.1-pro', shown: { model: 'K3.1 Pro', effort: 'High', selection: 'K3.1 Pro' }, label: 'K3.1 Pro | High' });
  assert.deepEqual(result.meta.answerSettings, {
    model: 'K3.1 Pro',
    mode: 'Thinking effort: High',
    selection: 'K3.1 Pro',
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
  assert.deepEqual(result.meta.modeApplied.shown, { model: 'K3', effort: 'High', selection: 'K3' });
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

test('oneshot-kimi: deep-research is refused before any page work, since its final report has no completion check', async () => {
  const { page } = makeKimi();
  await assert.rejects(kimiController(page).query({ prompt: 'probe', modeIntent: 'deep-research' }), /mode_intent_unsupported/);
  assert.equal(page.navigations.length, 0);
});

test('oneshot-kimi: the tool-call flow is expanded and read into tool use, skipping thinking steps', async () => {
  const toolFlow = [
    { thinking: true, title: 'Summarized two files and cited France capital' },
    { tool: 'web_search', title: 'Found 2 web pages', pages: [
      { url: 'https://www.britannica.com/place/Paris', title: 'Paris | Definition', site: 'www.britannica.com' },
      { url: 'https://en.wikipedia.org/wiki/Paris', title: 'Paris', site: 'en.wikipedia.org' }
    ] },
    { thinking: true, title: 'Thinking complete' }
  ];
  const { state, page } = makeKimi({ toolFlow });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(state.flowOpen, true);
  assert.deepEqual(result.meta.toolUse, {
    state: 'shown',
    reason: null,
    steps: [{
      tool: 'web_search',
      title: 'Found 2 web pages',
      kind: 'search',
      count: 2,
      pages: [
        { url: 'https://www.britannica.com/place/Paris', title: 'Paris | Definition', site: 'www.britannica.com' },
        { url: 'https://en.wikipedia.org/wiki/Paris', title: 'Paris', site: 'en.wikipedia.org' }
      ]
    }]
  });
  assert.doesNotMatch(JSON.stringify(result.meta.toolUse), /Summarized two files|Thinking complete/);
});

test('oneshot-kimi: an answer with no tool-call flow records tool use as none', async () => {
  const { page } = makeKimi({ rollup: false });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.toolUse, { state: 'none', reason: null, steps: [] });
});

test('oneshot-kimi: the Reference panel is opened and its links become the answer sources', async () => {
  const references = [{ url: 'https://www.britannica.com/place/Paris', title: 'Paris | Britannica' }];
  const { state, page } = makeKimi({ references });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(state.panelOpen, true);
  assert.deepEqual(result.meta.sources, [{ index: 1, url: 'https://www.britannica.com/place/Paris', file: null, title: 'Paris | Britannica', kinds: ['panel'] }]);
  assert.match(result.text, /## Sources\n\n1\. \[Paris \| Britannica\]\(https:\/\/www\.britannica\.com\/place\/Paris\)/);
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

test('oneshot-kimi: an earlier draft\'s files are removed from a fresh chat by resting on each chip, then clicking its delete control', async () => {
  const { state, page } = makeKimi({ chips: ['doc_01_passport PDF 152.7 KB', 'probe-notes DOCX 933 Bytes'] });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(state.chips, []);
  assert.deepEqual(result.meta.attachments, []);
  assert.equal(state.turns[0].text, 'probe');
});

test('oneshot-kimi: a tool step that lists no pages, such as a Python run, is read without waiting for pages', async () => {
  const toolFlow = [
    ...Array.from({ length: 8 }, (_, i) => ({ tool: 'ipython', title: `Ran Python code ${i}`, pages: [] })),
    { tool: 'web_search', title: 'Found 1 web pages', pages: [{ url: 'https://a.example/', title: 'A', site: 'a.example' }] }
  ];
  const { page } = makeKimi({ toolFlow });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.meta.toolUse.state, 'shown');
  assert.deepEqual(result.meta.toolUse.steps.map((step) => step.kind), [...Array(8).fill(null), 'search']);
  // Waiting for pages on each Python step would read the flow many times per step.
  const flowReads = page.evaluations.filter((js) => js.includes('function readKimiToolFlow(')).length;
  assert.ok(flowReads < 40, `read the tool flow ${flowReads} times`);
});

test('oneshot-kimi: a tool rollup with no tool flow, or a flow with no steps, is unread rather than none', async () => {
  const rollupOnly = makeKimi();
  const unrecognized = await kimiController(rollupOnly.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(unrecognized.meta.toolUse, { state: 'unread', reason: 'tool_structure_unrecognized', steps: null });

  const emptyFlow = makeKimi({ toolFlow: [] });
  const missing = await kimiController(emptyFlow.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(missing.meta.toolUse, { state: 'unread', reason: 'tool_steps_missing', steps: null });
});

test('oneshot-kimi: a step that never expands, or a search that lists none of the pages it found, is unread', async () => {
  const stuck = makeKimi({ toolFlow: [{ tool: 'web_search', title: 'Found 2 web pages', pages: [{ url: 'https://a.example/', title: 'A', site: 'a.example' }] }] });
  const evaluate = stuck.page.evaluate;
  stuck.page.evaluate = async (js) => {
    stuck.state.expandedSteps = {};
    return await evaluate(js);
  };
  const unexpanded = await kimiController(stuck.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(unexpanded.meta.toolUse, { state: 'unread', reason: 'tool_steps_not_expanded:1', steps: null });

  const emptySearch = makeKimi({ toolFlow: [{ tool: 'web_search', title: 'Found 7 web pages', pages: [] }] });
  const unreadPages = await kimiController(emptySearch.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(unreadPages.meta.toolUse, { state: 'unread', reason: 'search_pages_unread:1', steps: null });
});

test('oneshot-kimi: a page count is taken only from a search step\'s "web pages" title', async () => {
  const toolFlow = [
    { tool: 'browse', title: 'Opened the 2025 annual report', pages: [] },
    { tool: 'web_search', title: 'Found 3 web pages', pages: [{ url: 'https://a.example/', title: 'A', site: 'a.example' }] }
  ];
  const { page } = makeKimi({ toolFlow });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.toolUse.steps.map((step) => [step.tool, step.count]), [['browse', null], ['web_search', 3]]);
});

test('oneshot-kimi: only the composer\'s attachment area is read or cleared; a file list elsewhere is left alone', async () => {
  const { state, page } = makeKimi({ chips: ['old-draft PDF 1 KB'], foreignCards: ['stored-file PDF 2 KB'] });
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(state.foreignDeleted, 0);
  assert.deepEqual(state.foreignCards, ['stored-file PDF 2 KB']);
  assert.deepEqual(result.meta.draftAttachmentsRemoved, ['old-draft PDF 1 KB']);
});

test('oneshot-kimi: the sent files are read back from the user turn beside prompt delivery', async () => {
  const files = [];
  for (const name of ['probe-brief.pdf', 'probe-notes.docx']) {
    const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-kimi-files-')), name);
    await fs.writeFile(filePath, `synthetic ${name}`);
    files.push(filePath);
  }
  const { page } = makeKimi();
  const result = await kimiController(page).query({ prompt: 'probe', attachments: files, timeoutMs: 2_000 });
  assert.deepEqual(result.meta.attachmentDelivery, { checked: true, complete: true, missing: [], unexpected: [] });
});

test('oneshot-kimi: only Kimi\'s refusal texts end a run; another notice is recorded', async () => {
  const refused = makeKimi();
  const onRead = refused.page.evaluate;
  refused.page.evaluate = async (js) => {
    // Kimi took the prompt, then showed its capacity notice and no answer.
    if (refused.state.sent) {
      refused.state.notice = 'Tips Too many people are chatting with Kimi; a subscription will grant you priority access.';
      refused.state.turns = refused.state.turns.filter((turn) => turn.role === 'user');
    }
    return await onRead(js);
  };
  await assert.rejects(
    kimiController(refused.page).query({ prompt: 'probe', timeoutMs: 2_000 }),
    (error) => error.message === 'send_refused'
  );

  const offer = makeKimi();
  const onOfferRead = offer.page.evaluate;
  offer.page.evaluate = async (js) => {
    if (offer.state.sent) offer.state.notice = 'Try Kimi Plus for longer answers';
    return await onOfferRead(js);
  };
  const result = await kimiController(offer.page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.deepEqual(result.meta.pageNotices, ['Try Kimi Plus for longer answers']);
});

test('oneshot-kimi: thinking text in a tool flow outside the rollup stays out of the answer', async () => {
  const { state, page } = makeKimi({ rollup: false });
  state.flowOutsideRollup = true;
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.text, 'Answer');
});

test('oneshot-kimi: a hidden effort label is not recorded as the effort', async () => {
  const { state, page } = makeKimi({ rollup: false });
  state.effortHidden = true;
  const result = await kimiController(page).query({ prompt: 'probe', timeoutMs: 2_000 });
  assert.equal(result.meta.answerSettings.mode, null);
});
