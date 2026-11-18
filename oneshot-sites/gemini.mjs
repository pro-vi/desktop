import { readFileSync } from 'node:fs';

import { ONESHOT_REQUIRED_ANCHORS, parseOneShotProfile } from '../oneshot-profile.mjs';

// Gemini's mode picker lists options by purpose, with the model under each.
// Read from the signed-in gemini.google.com/app picker on 2026-11-18:
// "Everyday help" (4 Hydrogen), "Solves complex problems" (4 Hydrogen
// Thinking), "Detailed research" (3.1 Pro). Intents name the purpose, which
// outlives a model rename; the run records the model the page showed.
// The Deep research tool is not offered: its final report has no completion
// check yet (ADR 0017).
export const GEMINI_MODE_INTENTS = Object.freeze({
  fast: Object.freeze({ option: 'Everyday help' }),
  thinking: Object.freeze({ option: 'Solves complex problems' }),
  pro: Object.freeze({ option: 'Detailed research' })
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

export function readGeminiUploadMenu(a, h) {
  const upload = h.first(a.uploadMenu);
  return { upload: upload ? h.rectOf(upload) : null, fileInputs: h.all(a.fileInput).length };
}

// Chips in the answer only: one inside the thinking area, or with no size,
// is skipped rather than clicked.
export function locateGeminiCitation(a, h) {
  const turns = h.all(a.assistantTurn);
  const turn = turns[turns.length - 1];
  const chips = turn ? h.all(a.citation, turn) : [];
  const chip = chips[a.index];
  if (!chip) return { count: chips.length, found: false };
  if (h.insideAny(chip, a.answerExclude, turn)) return { count: chips.length, found: false, skipped: 'excluded' };
  const button = h.all(a.citationButton, chip)[0] || chip;
  button.scrollIntoView?.({ block: 'center' });
  if (!h.visible(button)) return { count: chips.length, found: false, skipped: 'no_size' };
  return { count: chips.length, found: true, rect: h.rectOf(button) };
}

// Copies the open source card's links onto the chip, where the engine's
// Markdown converter reads them (data-oneshot-sources).
export function stampGeminiCitation(a, h) {
  const links = h.all(a.cardLink).filter(h.visible).map((link) => ({
    url: link.getAttribute('href'),
    title: h.textOf(link).replace(/\s+/g, ' ').trim()
  }));
  // A citation of an attached file shows the file's name and no link.
  if (!links.length) {
    for (const node of h.all(a.cardFile).filter(h.visible)) {
      const name = h.textOf(node).replace(/\s+/g, ' ').trim();
      if (name) links.push({ file: name, title: name });
    }
  }
  if (a.countOnly) return { links: links.length };
  const turns = h.all(a.assistantTurn);
  const chip = turns.length ? h.all(a.citation, turns[turns.length - 1])[a.index] : null;
  if (!chip || !links.length) return { links: links.length, stamped: 0 };
  chip.setAttribute('data-oneshot-sources', JSON.stringify(links));
  return { links: links.length, stamped: links.length };
}

// What the answer shows of Gemini's tool use. On 2026-11-18 a Pro answer had
// an empty sources-list and no thinking panel; links in that list are the
// sites Gemini shows it used. A thinking panel is not read (its text is
// reasoning), so its presence makes tool use unread rather than none.
export function readGeminiToolSurfaces(a, h) {
  const turns = h.all(a.assistantTurn);
  const turn = turns[turns.length - 1];
  if (!turn) return { found: false };
  const list = h.all(a.sourcesList, turn)[0] || null;
  return {
    found: true,
    thoughts: h.all(a.thoughtsPanel, turn).length > 0,
    links: list ? Array.from(list.querySelectorAll('a[href]')).map((link) => ({
      url: link.getAttribute('href'),
      title: h.textOf(link).replace(/\s+/g, ' ').trim()
    })) : []
  };
}

function selectors(ctx) {
  return {
    trigger: ctx.selectorsFor('mode-trigger'),
    triggerLabel: ctx.selectorsFor('mode-trigger-label'),
    option: ctx.selectorsFor('mode-option'),
    optionLabel: ctx.selectorsFor('mode-option-label'),
    optionSublabel: ctx.selectorsFor('mode-option-sublabel'),
    uploadMenu: ctx.selectorsFor('upload-menu-button'),
    fileInput: ctx.selectorsFor('file-input'),
    assistantTurn: ctx.selectorsFor('assistant-turn'),
    answerExclude: ctx.selectorsFor('answer-exclude'),
    citation: ctx.selectorsFor('citation'),
    citationButton: ctx.selectorsFor('citation-button'),
    cardLink: ctx.selectorsFor('source-card-link'),
    cardFile: ctx.selectorsFor('source-card-file'),
    sourcesList: ctx.selectorsFor('sources-list'),
    thoughtsPanel: ctx.selectorsFor('thoughts-panel')
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

async function selectOption(ctx, sel, mode) {
  const read = () => ctx.evaluate(readGeminiModePicker, sel);
  let picker = await waitFor(ctx, read, (value) => value.found, ctx.timings.controlMs);
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
  picker = await waitFor(ctx, read, (value) => !value.expanded);
  if (picker.expanded) await closeMenus(ctx);
  // The picker's own label can shorten the model ("3.1 Pro" showed as "Pro"
  // on 2026-11-18), so the selection is confirmed by the option's checked
  // state in the reopened menu.
  const checked = await readCheckedOption(ctx, sel);
  if (checked?.label !== mode.option) {
    throw selectionError('model_not_selected', {
      shown: { option: checked?.label || null, model: checked?.sublabel || null },
      expected: mode.option
    });
  }
  const after = await read();
  return { shown: { model: checked.sublabel, option: checked.label, selection: checked.label }, label: after.model };
}

async function readCheckedOption(ctx, sel) {
  const read = () => ctx.evaluate(readGeminiModePicker, sel);
  let picker = await waitFor(ctx, read, (value) => value.found, ctx.timings.controlMs);
  if (!picker.found) return null;
  if (!picker.expanded) await ctx.click(picker.rect);
  picker = await waitFor(ctx, read, (value) => value.options.length > 0);
  await closeMenus(ctx);
  return picker.options.find((item) => item.checked) || null;
}

async function applyGeminiMode(ctx, mode) {
  const selected = await selectOption(ctx, selectors(ctx), mode);
  return { confirmed: true, ...selected };
}

async function readGeminiModeLabel(ctx) {
  const picker = await ctx.evaluate(readGeminiModePicker, selectors(ctx));
  return picker.found ? picker.model : null;
}

// The documents input exists only after "Upload & tools" is opened.
async function revealGeminiFileInput(ctx) {
  const sel = selectors(ctx);
  const read = () => ctx.evaluate(readGeminiUploadMenu, sel);
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
  const cardLinks = () => ctx.evaluate(stampGeminiCitation, { ...sel, countOnly: true });
  let stamped = 0;
  let skipped = 0;
  for (let index = 0; index < count; index += 1) {
    ctx.throwIfStopRequested();
    await ctx.evaluate(locateGeminiCitation, { ...sel, index });
    await ctx.sleep(Math.min(100, ctx.timings.menuMs));
    const chip = await ctx.evaluate(locateGeminiCitation, { ...sel, index });
    if (!chip.found) {
      skipped += 1;
      continue;
    }
    // A card still open from the previous chip would be read as this one's.
    if ((await cardLinks()).links > 0) return { citations: first.count, opened: index, stamped, skipped, stopped: 'card_still_open' };
    await ctx.click(chip.rect);
    const result = await waitFor(ctx, () => ctx.evaluate(stampGeminiCitation, { ...sel, index }), (value) => value.stamped > 0);
    if (result.stamped > 0) stamped += 1;
    await closeMenus(ctx);
    await waitFor(ctx, cardLinks, (value) => value.links === 0);
  }
  return { citations: first.count, opened: count, stamped, skipped };
}

async function readGeminiToolUse(ctx) {
  const shown = await ctx.evaluate(readGeminiToolSurfaces, selectors(ctx));
  if (!shown.found) return { state: 'unread', reason: 'assistant_turn_missing' };
  if (shown.links.length) {
    return { state: 'shown', steps: [{ tool: 'sources_list', title: 'Sources', count: shown.links.length, pages: shown.links }] };
  }
  if (shown.thoughts) return { state: 'unread', reason: 'thinking_panel_not_read' };
  return { state: 'none' };
}

async function readGeminiAnswerSettings(ctx) {
  // Gemini shows the model on the composer's picker, not on the answer; the
  // checked option in its menu names both the model and its purpose.
  const checked = await readCheckedOption(ctx, selectors(ctx));
  if (!checked) return { unreadReason: 'mode_picker_missing' };
  return { model: checked.sublabel || null, mode: checked.label || null, selection: checked.label || null, source: 'mode-picker-menu-after-answer' };
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
  readModeLabel: readGeminiModeLabel,
  revealFileInput: revealGeminiFileInput,
  prepareCapture: prepareGeminiCapture,
  readToolUse: readGeminiToolUse,
  readAnswerSettings: readGeminiAnswerSettings
});
