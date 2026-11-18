import { readFileSync } from 'node:fs';

import { ONESHOT_REQUIRED_ANCHORS, parseOneShotProfile } from '../oneshot-profile.mjs';

// Kimi runs one chat app on two sites with separate accounts: www.kimi.com
// (mainland China sign-in) and www.kimi.ai (international sign-in). A tab on
// either keeps its site; anything else opens www.kimi.ai, the kimi url in
// vendors.json.
const KIMI_HOSTS = new Set(['www.kimi.ai', 'kimi.ai', 'www.kimi.com', 'kimi.com']);
const DEFAULT_ORIGIN = 'https://www.kimi.ai';

// Model menu choices read from the signed-in www.kimi.ai composer on
// 2026-11-18. Thinking models also pin the "Thinking effort" submenu to High,
// the strongest setting it offered. Kimi's Deep Research page is not offered:
// its final report has no completion check yet (ADR 0017).
export const KIMI_MODE_INTENTS = Object.freeze({
  instant: Object.freeze({ model: 'Instant', menuKey: 'k28-instant' }),
  'k2.8-preview': Object.freeze({ model: 'K2.8 Preview', menuKey: 'k28-agent-preview', effort: 'High' }),
  k3: Object.freeze({ model: 'K3', inMoreModels: true, effort: 'High' }),
  'k3.1-pro': Object.freeze({ model: 'K3.1 Pro', menuKey: 'k3d1-agent', effort: 'High' })
});

export function kimiFreshChatUrl(currentUrl) {
  let origin = DEFAULT_ORIGIN;
  try {
    const url = new URL(String(currentUrl || ''));
    if (url.protocol === 'https:' && KIMI_HOSTS.has(url.hostname)) origin = url.origin;
  } catch {}
  return `${origin}/`;
}

export function readKimiModelTrigger(a, h) {
  const trigger = h.all(a.trigger).find(h.visible);
  if (!trigger) return { found: false };
  const label = (selectors) => {
    const node = h.all(selectors, trigger)[0];
    return node ? h.textOf(node).trim() || null : null;
  };
  return {
    found: true,
    rect: h.rectOf(trigger),
    model: label(a.triggerModel),
    effort: label(a.triggerEffort),
    expanded: trigger.getAttribute('aria-expanded') === 'true'
  };
}

export function readKimiModelMenu(a, h) {
  const option = (node, labelSelectors) => {
    const labelNode = labelSelectors ? h.all(labelSelectors, node)[0] : null;
    return {
      label: h.textOf(labelNode || node).trim().split('\n')[0].trim(),
      key: node.getAttribute('data-moon-key') || null,
      checked: node.getAttribute('aria-checked') === 'true',
      rect: h.rectOf(node)
    };
  };
  const firstRect = (selectors) => {
    const node = h.all(selectors).find(h.visible);
    return node ? h.rectOf(node) : null;
  };
  return {
    options: h.all(a.option).filter(h.visible).map((node) => option(node, a.optionLabel)),
    moreOptions: h.all(a.moreOption).filter(h.visible).map((node) => option(node, null)),
    effortOptions: h.all(a.effortOption).filter(h.visible).map((node) => option(node, null)),
    more: firstRect(a.more),
    effort: firstRect(a.effortItem)
  };
}

// The answer turn's tool-call flow, as read on www.kimi.ai on 2026-11-18: a
// collapsed list of steps, each a thinking step or a tool step (class
// toolcall-<tool>, e.g. toolcall-web_search) whose trigger reveals the pages
// the tool found. Thinking steps are never read: their text is reasoning.
export function readKimiToolFlow(a, h) {
  const turns = h.all(a.assistantTurn);
  const turn = turns[turns.length - 1];
  if (!turn) return { found: false };
  const flow = h.all(a.toolFlow, turn)[0];
  if (!flow) return { found: true, flow: false, steps: [] };
  const toggle = h.all(a.toolFlowToggle, flow)[0] || null;
  const steps = h.all(a.toolStep, flow)
    .filter((node) => !h.matchesAny(node, a.toolStepThinking))
    .map((node) => {
      const trigger = h.all(a.toolStepTrigger, node)[0] || null;
      const detailId = trigger?.getAttribute('aria-controls');
      const detail = detailId ? document.getElementById(detailId) : null;
      const toolClass = String(node.getAttribute('class') || '').split(/\s+/)
        .find((name) => /^toolcall-[a-z_]+$/.test(name) && !/^toolcall-(container|trigger|title|content)$/.test(name));
      const titleNode = h.all(a.toolStepTitle, node)[0];
      const textIn = (selectors, root) => {
        const found = h.all(selectors, root)[0];
        return found ? h.textOf(found).replace(/\s+/g, ' ').trim() : '';
      };
      return {
        tool: toolClass ? toolClass.slice('toolcall-'.length) : null,
        title: titleNode ? h.textOf(titleNode).replace(/\s+/g, ' ').trim() : '',
        expandable: !!trigger,
        expanded: trigger ? trigger.getAttribute('aria-expanded') === 'true' : false,
        pages: detail ? h.all(a.toolStepLink, detail).map((link) => ({
          url: link.getAttribute('href'),
          title: textIn(a.toolStepLinkTitle, link) || h.textOf(link).replace(/\s+/g, ' ').trim(),
          site: textIn(a.toolStepLinkSite, link)
        })) : []
      };
    });
  return { found: true, flow: true, toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : true, steps };
}

// Scrolls a tool-flow control into view and returns where to click it:
// a.target is "toggle" for the flow summary, or a tool step's index.
export function placeKimiToolControl(a, h) {
  const turns = h.all(a.assistantTurn);
  const flow = turns.length ? h.all(a.toolFlow, turns[turns.length - 1])[0] : null;
  if (!flow) return { found: false };
  const step = a.target === 'toggle' ? null : h.all(a.toolStep, flow).filter((item) => !h.matchesAny(item, a.toolStepThinking))[a.target];
  const node = a.target === 'toggle' ? h.all(a.toolFlowToggle, flow)[0] : step ? h.all(a.toolStepTrigger, step)[0] : null;
  if (!node) return { found: false };
  node.scrollIntoView?.({ block: 'center' });
  return { found: true, visible: h.visible(node), rect: h.rectOf(node) };
}

export function placeKimiReferenceToggle(a, h) {
  const turns = h.all(a.assistantTurn);
  const toggle = turns.length ? h.first(a.referenceToggle, turns[turns.length - 1]) : null;
  if (!toggle) return { found: false, panelOpen: !!h.first(a.sourcePanel) };
  toggle.scrollIntoView?.({ block: 'center' });
  return { found: true, panelOpen: !!h.first(a.sourcePanel), rect: h.rectOf(toggle) };
}

function toolSelectors(ctx) {
  return {
    assistantTurn: ctx.selectorsFor('assistant-turn'),
    toolFlow: ctx.selectorsFor('tool-flow'),
    toolFlowToggle: ctx.selectorsFor('tool-flow-toggle'),
    toolStep: ctx.selectorsFor('tool-step'),
    toolStepThinking: ctx.selectorsFor('tool-step-thinking'),
    toolStepTrigger: ctx.selectorsFor('tool-step-trigger'),
    toolStepTitle: ctx.selectorsFor('tool-step-title'),
    toolStepLink: ctx.selectorsFor('tool-step-link'),
    toolStepLinkTitle: ctx.selectorsFor('tool-step-link-title'),
    toolStepLinkSite: ctx.selectorsFor('tool-step-link-site'),
    referenceToggle: ctx.selectorsFor('reference-toggle'),
    sourcePanel: ctx.selectorsFor('source-panel')
  };
}

function menuSelectors(ctx) {
  return {
    trigger: ctx.selectorsFor('mode-trigger'),
    triggerModel: ctx.selectorsFor('mode-trigger-model'),
    triggerEffort: ctx.selectorsFor('mode-trigger-effort'),
    option: ctx.selectorsFor('mode-option'),
    optionLabel: ctx.selectorsFor('mode-option-label'),
    more: ctx.selectorsFor('mode-more'),
    moreOption: ctx.selectorsFor('mode-more-option'),
    effortItem: ctx.selectorsFor('mode-effort-item'),
    effortOption: ctx.selectorsFor('mode-effort-option')
  };
}

function selectionError(reason, data = {}) {
  const error = new Error('mode_intent_unavailable');
  error.data = { reason, ...data };
  return error;
}

async function waitFor(ctx, read, accept, timeoutMs = ctx.timings.menuMs) {
  const start = Date.now();
  let value = await read();
  while (!accept(value) && Date.now() - start < timeoutMs) {
    ctx.throwIfStopRequested();
    await ctx.sleep(Math.min(250, ctx.timings.pollMs));
    value = await read();
  }
  return value;
}

async function closeMenus(ctx) {
  await ctx.pressKey('Escape');
  await ctx.sleep(Math.min(150, ctx.timings.menuMs));
}

async function selectModel(ctx, { readTrigger, readMenu }, mode) {
  let trigger = await waitFor(ctx, readTrigger, (value) => value.found, ctx.timings.controlMs);
  if (!trigger.found) throw selectionError('model_menu_missing');
  if (trigger.model === mode.model) return trigger;
  await ctx.click(trigger.rect);
  let menu = await waitFor(ctx, readMenu, (value) => value.options.length > 0);
  let choice = menu.options.find((item) => (mode.menuKey && item.key === mode.menuKey) || item.label === mode.model);
  if (!choice && mode.inMoreModels && menu.more) {
    await ctx.click(menu.more);
    menu = await waitFor(ctx, readMenu, (value) => value.moreOptions.length > 0);
    choice = menu.moreOptions.find((item) => item.label === mode.model);
  }
  if (!choice) {
    await closeMenus(ctx);
    throw selectionError('option_not_found', {
      options: [...menu.options, ...menu.moreOptions].map((item) => item.label),
      shown: { model: trigger.model, effort: trigger.effort }
    });
  }
  await ctx.click(choice.rect);
  trigger = await waitFor(ctx, readTrigger, (value) => value.model === mode.model);
  await closeMenus(ctx);
  if (trigger.model !== mode.model) {
    // A model the account cannot use leaves the old one selected (or opens an
    // upgrade offer); either way the requested model is not set.
    throw selectionError('model_not_selected', { shown: { model: trigger.model, effort: trigger.effort } });
  }
  return trigger;
}

async function selectEffort(ctx, { readTrigger, readMenu }, mode) {
  let trigger = await readTrigger();
  if (trigger.effort === mode.effort) return trigger;
  await ctx.click(trigger.rect);
  let menu = await waitFor(ctx, readMenu, (value) => !!value.effort);
  if (!menu.effort) {
    await closeMenus(ctx);
    throw selectionError('effort_menu_missing', { shown: { model: trigger.model, effort: trigger.effort } });
  }
  await ctx.click(menu.effort);
  menu = await waitFor(ctx, readMenu, (value) => value.effortOptions.length > 0);
  const choice = menu.effortOptions.find((item) => item.label === mode.effort);
  if (!choice) {
    await closeMenus(ctx);
    throw selectionError('effort_option_not_found', {
      options: menu.effortOptions.map((item) => item.label),
      shown: { model: trigger.model, effort: trigger.effort }
    });
  }
  await ctx.click(choice.rect);
  trigger = await waitFor(ctx, readTrigger, (value) => value.effort === mode.effort);
  await closeMenus(ctx);
  if (trigger.effort !== mode.effort) {
    throw selectionError('effort_not_selected', { shown: { model: trigger.model, effort: trigger.effort } });
  }
  return trigger;
}

async function applyKimiMode(ctx, mode) {
  const sel = menuSelectors(ctx);
  const readers = {
    readTrigger: () => ctx.evaluate(readKimiModelTrigger, sel),
    readMenu: () => ctx.evaluate(readKimiModelMenu, sel)
  };
  let trigger = await selectModel(ctx, readers, mode);
  if (mode.effort) trigger = await selectEffort(ctx, readers, mode);
  return { confirmed: true, shown: { model: trigger.model, effort: trigger.effort }, label: kimiModeLabel(trigger) };
}

function kimiModeLabel(trigger) {
  return trigger?.found === false ? null : `${trigger?.model || ''} | ${trigger?.effort || ''}`;
}

async function readKimiModeLabel(ctx) {
  return kimiModeLabel(await ctx.evaluate(readKimiModelTrigger, menuSelectors(ctx)));
}

// Opens the answer's Reference panel, whose links are the answer's cited
// sources; the engine reads them as panel sources.
async function prepareKimiCapture(ctx) {
  const sel = toolSelectors(ctx);
  const place = await ctx.evaluate(placeKimiReferenceToggle, sel);
  if (!place.found) return { references: 'none_shown' };
  if (place.panelOpen) return { references: 'open' };
  await ctx.sleep(Math.min(200, ctx.timings.menuMs));
  const again = await ctx.evaluate(placeKimiReferenceToggle, sel);
  await ctx.click(again.rect);
  const opened = await waitFor(ctx, () => ctx.evaluate(placeKimiReferenceToggle, sel), (value) => value.panelOpen);
  return { references: opened.panelOpen ? 'open' : 'did_not_open' };
}

async function readKimiToolUse(ctx) {
  const sel = toolSelectors(ctx);
  const read = () => ctx.evaluate(readKimiToolFlow, sel);
  let flow = await read();
  if (!flow.found) return { state: 'unread', reason: 'assistant_turn_missing' };
  if (!flow.flow) return { state: 'none' };
  if (!flow.toggleExpanded) {
    const toggle = await ctx.evaluate(placeKimiToolControl, { ...sel, target: 'toggle' });
    if (!toggle.found) return { state: 'unread', reason: 'tool_flow_toggle_missing' };
    await ctx.click(toggle.rect);
    flow = await waitFor(ctx, read, (value) => value.toggleExpanded);
    if (!flow.toggleExpanded) return { state: 'unread', reason: 'tool_flow_did_not_expand' };
  }
  if (!flow.steps.length) return { state: 'none' };
  for (let index = 0; index < flow.steps.length; index += 1) {
    ctx.throwIfStopRequested();
    const step = flow.steps[index];
    if (!step.expandable || step.expanded) continue;
    const place = await ctx.evaluate(placeKimiToolControl, { ...sel, target: index });
    if (!place.found) continue;
    await ctx.click(place.rect);
    flow = await waitFor(ctx, read, (value) => value.steps[index]?.expanded && value.steps[index].pages.length > 0);
  }
  flow = await read();
  const unexpanded = flow.steps.filter((step) => step.expandable && !step.expanded).length;
  if (unexpanded) return { state: 'unread', reason: `tool_steps_not_expanded:${unexpanded}` };
  return {
    state: 'shown',
    steps: flow.steps.map((step) => {
      const count = /(\d+)/.exec(step.title);
      return { tool: step.tool, title: step.title, query: null, count: count ? Number(count[1]) : null, pages: step.pages };
    })
  };
}

async function readKimiAnswerSettings(ctx) {
  const trigger = await ctx.evaluate(readKimiModelTrigger, menuSelectors(ctx));
  if (!trigger.found) return { unreadReason: 'model_menu_missing' };
  // Kimi shows the model on the composer, not on the answer; this is the
  // setting the chat still shows once the answer is complete.
  return {
    model: trigger.model,
    mode: trigger.effort ? `Thinking effort: ${trigger.effort}` : null,
    source: 'composer-model-menu-after-answer'
  };
}

const profile = parseOneShotProfile(
  JSON.parse(readFileSync(new URL('./kimi.json', import.meta.url), 'utf8')),
  { vendorId: 'kimi', requiredAnchorIds: ONESHOT_REQUIRED_ANCHORS }
);

export const kimiAdapter = Object.freeze({
  vendorId: 'kimi',
  vendorName: 'Kimi',
  profile,
  modeIntents: KIMI_MODE_INTENTS,
  // Exact labels a Kimi answer body can show before any answer text; none
  // were observed live yet, so this starts empty and grows from captures.
  progressLabels: Object.freeze([]),
  freshChatUrl: kimiFreshChatUrl,
  applyMode: applyKimiMode,
  readModeLabel: readKimiModeLabel,
  prepareCapture: prepareKimiCapture,
  readToolUse: readKimiToolUse,
  readAnswerSettings: readKimiAnswerSettings
});
