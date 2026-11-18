import { readFileSync } from 'node:fs';

import { ONESHOT_REQUIRED_ANCHORS, parseOneShotProfile } from '../oneshot-profile.mjs';

// Gemini's mode picker lists options by purpose, with the model under each.
// Read from the signed-in gemini.google.com/app picker on 2026-11-18:
// "Everyday help" (4 Hydrogen), "Solves complex problems" (4 Hydrogen
// Thinking), "Detailed research" (3.1 Pro). Intents name the purpose, which
// outlives a model rename; the run records the model the page showed.
// Deep research is a tool under "Upload & tools" > "More tools".
export const GEMINI_MODE_INTENTS = Object.freeze({
  fast: Object.freeze({ option: 'Everyday help' }),
  thinking: Object.freeze({ option: 'Solves complex problems' }),
  pro: Object.freeze({ option: 'Detailed research' }),
  'deep-research': Object.freeze({ tool: 'Deep research' })
});

// Citation chips opened per answer to read their sources; a longer answer's
// remaining chips keep their inline text without a link.
const MAX_CITATION_CHIPS = 40;

export function geminiFreshChatUrl(currentUrl) {
  try {
    const url = new URL(String(currentUrl || ''));
    const account = /^\/u\/(\d+)\//.exec(url.pathname);
    if (url.hostname === 'gemini.google.com' && account) return `https://gemini.google.com/u/${account[1]}/app`;
  } catch {}
  return 'https://gemini.google.com/app';
}

export function readGeminiModePicker(a, h) {
  const trigger = h.all(a.trigger).find(h.visible);
  if (!trigger) return { found: false, options: [] };
  const text = (selectors, root) => {
    const node = h.all(selectors, root)[0];
    return node ? h.textOf(node).trim() : '';
  };
  return {
    found: true,
    rect: h.rectOf(trigger),
    model: text(a.triggerLabel, trigger) || null,
    expanded: trigger.getAttribute('aria-expanded') === 'true',
    options: h.all(a.option).filter(h.visible).map((node) => ({
      label: text(a.optionLabel, node),
      sublabel: text(a.optionSublabel, node),
      checked: node.getAttribute('aria-checked') === 'true',
      disabled: node.getAttribute('aria-disabled') === 'true',
      rect: h.rectOf(node)
    }))
  };
}

export function readGeminiTools(a, h) {
  const rectOfFirst = (selectors) => {
    const node = h.all(selectors).find(h.visible);
    return node ? h.rectOf(node) : null;
  };
  return {
    upload: rectOfFirst(a.uploadMenu),
    more: rectOfFirst(a.toolMore),
    tools: h.all(a.toolItem).filter(h.visible).map((node) => ({
      label: h.textOf(node).trim(),
      checked: node.getAttribute('aria-checked') === 'true',
      rect: h.rectOf(node)
    })),
    deepResearchChip: h.all(a.deepResearchChip).some(h.visible),
    fileInputs: h.all(a.fileInput).length
  };
}

export function locateGeminiCitation(a, h) {
  const turns = h.all(a.assistantTurn);
  const turn = turns[turns.length - 1];
  const chips = turn ? h.all(a.citation, turn) : [];
  const chip = chips[a.index];
  if (!chip) return { count: chips.length, found: false };
  const button = h.all(a.citationButton, chip)[0] || chip;
  button.scrollIntoView?.({ block: 'center' });
  return { count: chips.length, found: true, rect: h.rectOf(button) };
}

// Copies the open source card's links onto the chip, where the engine's
// Markdown converter reads them (data-oneshot-sources).
export function stampGeminiCitation(a, h) {
  const links = h.all(a.cardLink).filter(h.visible).map((link) => ({
    url: link.getAttribute('href'),
    title: h.textOf(link).replace(/\s+/g, ' ').trim()
  }));
  if (a.countOnly) return { links: links.length };
  const turns = h.all(a.assistantTurn);
  const chip = turns.length ? h.all(a.citation, turns[turns.length - 1])[a.index] : null;
  if (!chip || !links.length) return { links: links.length, stamped: 0 };
  chip.setAttribute('data-oneshot-sources', JSON.stringify(links));
  return { links: links.length, stamped: links.length };
}

function selectors(ctx) {
  return {
    trigger: ctx.selectorsFor('mode-trigger'),
    triggerLabel: ctx.selectorsFor('mode-trigger-label'),
    option: ctx.selectorsFor('mode-option'),
    optionLabel: ctx.selectorsFor('mode-option-label'),
    optionSublabel: ctx.selectorsFor('mode-option-sublabel'),
    uploadMenu: ctx.selectorsFor('upload-menu-button'),
    toolItem: ctx.selectorsFor('tool-item'),
    toolMore: ctx.selectorsFor('tool-more'),
    deepResearchChip: ctx.selectorsFor('deep-research-chip'),
    fileInput: ctx.selectorsFor('file-input'),
    assistantTurn: ctx.selectorsFor('assistant-turn'),
    citation: ctx.selectorsFor('citation'),
    citationButton: ctx.selectorsFor('citation-button'),
    cardLink: ctx.selectorsFor('source-card-link')
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

async function selectOption(ctx, sel, mode) {
  const read = () => ctx.evaluate(readGeminiModePicker, sel);
  let picker = await read();
  if (!picker.found) throw selectionError('mode_picker_missing');
  if (!picker.expanded) await ctx.click(picker.rect);
  picker = await waitFor(ctx, read, (value) => value.options.length > 0);
  const choice = picker.options.find((item) => item.label === mode.option);
  if (!choice || choice.disabled) {
    await closeMenus(ctx);
    throw selectionError(choice ? 'option_disabled' : 'option_not_found', {
      options: picker.options.map((item) => `${item.label} (${item.sublabel})`),
      shown: { model: picker.model }
    });
  }
  if (!choice.checked) await ctx.click(choice.rect);
  picker = await waitFor(ctx, read, (value) => value.model === choice.sublabel);
  if (picker.expanded) await closeMenus(ctx);
  if (picker.model !== choice.sublabel) {
    throw selectionError('model_not_selected', { shown: { model: picker.model }, expected: choice.sublabel });
  }
  return { model: picker.model, option: choice.label };
}

async function selectTool(ctx, sel, mode) {
  const read = () => ctx.evaluate(readGeminiTools, sel);
  let state = await read();
  if (state.deepResearchChip) return;
  if (!state.upload) throw selectionError('tools_menu_missing');
  await ctx.click(state.upload);
  state = await waitFor(ctx, read, (value) => value.tools.length > 0 || !!value.more);
  let tool = state.tools.find((item) => item.label === mode.tool);
  if (!tool && state.more) {
    await ctx.click(state.more);
    state = await waitFor(ctx, read, (value) => value.tools.some((item) => item.label === mode.tool));
    tool = state.tools.find((item) => item.label === mode.tool);
  }
  if (!tool) {
    await closeMenus(ctx);
    throw selectionError('tool_not_found', { options: state.tools.map((item) => item.label) });
  }
  await ctx.click(tool.rect);
  state = await waitFor(ctx, read, (value) => value.deepResearchChip);
  if (state.tools.length) await closeMenus(ctx);
  if (!state.deepResearchChip) throw selectionError('tool_not_selected', { shown: { tool: null } });
}

async function applyGeminiMode(ctx, mode) {
  const sel = selectors(ctx);
  const shown = {};
  if (mode.option) Object.assign(shown, await selectOption(ctx, sel, mode));
  if (mode.tool) {
    await selectTool(ctx, sel, mode);
    shown.tool = mode.tool;
  }
  return { confirmed: true, shown };
}

// The documents input exists only after "Upload & tools" is opened.
async function revealGeminiFileInput(ctx) {
  const sel = selectors(ctx);
  const read = () => ctx.evaluate(readGeminiTools, sel);
  let state = await read();
  if (state.fileInputs > 0) return null;
  if (!state.upload) return null;
  await ctx.click(state.upload);
  state = await waitFor(ctx, read, (value) => value.fileInputs > 0);
  return { close: async () => await closeMenus(ctx) };
}

async function prepareGeminiCapture(ctx) {
  const sel = selectors(ctx);
  const first = await ctx.evaluate(locateGeminiCitation, { ...sel, index: 0 });
  const count = Math.min(first.count, MAX_CITATION_CHIPS);
  let stamped = 0;
  for (let index = 0; index < count; index += 1) {
    ctx.throwIfStopRequested();
    await ctx.evaluate(locateGeminiCitation, { ...sel, index });
    await ctx.sleep(Math.min(100, ctx.timings.menuMs));
    const chip = await ctx.evaluate(locateGeminiCitation, { ...sel, index });
    if (!chip.found) continue;
    await ctx.click(chip.rect);
    const result = await waitFor(ctx, () => ctx.evaluate(stampGeminiCitation, { ...sel, index }), (value) => value.stamped > 0);
    if (result.stamped > 0) stamped += 1;
    await closeMenus(ctx);
    // The next chip's card must not be read while this one is still open.
    await waitFor(ctx, () => ctx.evaluate(stampGeminiCitation, { ...sel, countOnly: true }), (value) => value.links === 0);
  }
  return { citations: first.count, opened: count, stamped };
}

async function readGeminiAnswerSettings(ctx) {
  const sel = selectors(ctx);
  const picker = await ctx.evaluate(readGeminiModePicker, sel);
  if (!picker.found) return { unreadReason: 'mode_picker_missing' };
  const tools = await ctx.evaluate(readGeminiTools, sel);
  // Gemini shows the model on the composer's picker, not on the answer.
  return {
    model: picker.model,
    mode: tools.deepResearchChip ? 'Deep research' : null,
    source: 'mode-picker-after-answer'
  };
}

const profile = parseOneShotProfile(
  JSON.parse(readFileSync(new URL('./gemini.json', import.meta.url), 'utf8')),
  { vendorId: 'gemini', requiredAnchorIds: ONESHOT_REQUIRED_ANCHORS }
);

export const geminiAdapter = Object.freeze({
  vendorId: 'gemini',
  vendorName: 'Gemini',
  profile,
  modeIntents: GEMINI_MODE_INTENTS,
  // Exact answer-body texts that are progress, not an answer. Neither was
  // seen live yet; both only delay completion if an answer is exactly that.
  progressLabels: Object.freeze(['just a sec', 'thinking']),
  freshChatUrl: geminiFreshChatUrl,
  applyMode: applyGeminiMode,
  revealFileInput: revealGeminiFileInput,
  prepareCapture: prepareGeminiCapture,
  readAnswerSettings: readGeminiAnswerSettings
});
