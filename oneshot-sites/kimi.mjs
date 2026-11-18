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
// the strongest setting it offered. deep-research opens Kimi's Deep Research
// page, whose composer shows its own model.
export const KIMI_MODE_INTENTS = Object.freeze({
  instant: Object.freeze({ model: 'Instant', menuKey: 'k28-instant' }),
  'k2.8-preview': Object.freeze({ model: 'K2.8 Preview', menuKey: 'k28-agent-preview', effort: 'High' }),
  k3: Object.freeze({ model: 'K3', inMoreModels: true, effort: 'High' }),
  'k3.1-pro': Object.freeze({ model: 'K3.1 Pro', menuKey: 'k3d1-agent', effort: 'High' }),
  'deep-research': Object.freeze({ path: '/deep-research' })
});

export function kimiFreshChatUrl(currentUrl, mode = null) {
  let origin = DEFAULT_ORIGIN;
  try {
    const url = new URL(String(currentUrl || ''));
    if (url.protocol === 'https:' && KIMI_HOSTS.has(url.hostname)) origin = url.origin;
  } catch {}
  return `${origin}${mode?.path || '/'}`;
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

async function waitFor(ctx, read, accept) {
  const start = Date.now();
  let value = await read();
  while (!accept(value) && Date.now() - start < ctx.timings.menuMs) {
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
  let trigger = await readTrigger();
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
  if (mode.path) {
    const url = new URL(await ctx.getUrl());
    if (url.pathname !== mode.path) throw selectionError('mode_page_not_open', { shown: { path: url.pathname } });
    const trigger = await readers.readTrigger();
    return { confirmed: true, shown: { page: url.pathname, model: trigger.model || null, effort: trigger.effort || null } };
  }
  let trigger = await selectModel(ctx, readers, mode);
  if (mode.effort) trigger = await selectEffort(ctx, readers, mode);
  return { confirmed: true, shown: { model: trigger.model, effort: trigger.effort } };
}

async function readKimiAnswerSettings(ctx) {
  const trigger = await ctx.evaluate(readKimiModelTrigger, menuSelectors(ctx));
  if (!trigger.found) return { unreadReason: 'model_menu_missing' };
  let page = null;
  try {
    page = new URL(await ctx.getUrl()).pathname === '/deep-research' ? 'Deep Research' : null;
  } catch {}
  const mode = [page, trigger.effort ? `Thinking effort: ${trigger.effort}` : null].filter(Boolean).join('; ') || null;
  // Kimi shows the model on the composer, not on the answer; this is the
  // setting the chat still shows once the answer is complete.
  return { model: trigger.model, mode, source: 'composer-model-menu-after-answer' };
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
  readAnswerSettings: readKimiAnswerSettings
});
