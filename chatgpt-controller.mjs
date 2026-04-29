import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeChatGptModeIntent, normalizeChatGptModelIntent } from './chatgpt-mode-intent.mjs';
import {
  CHATGPT_ANY_MODE_PATTERN,
  CHATGPT_ANY_MODEL_PATTERN,
  CHATGPT_MODE_INTENT_META,
  CHATGPT_MODE_PICKER_PRIMITIVES_JS,
  CHATGPT_MODEL_INTENT_META,
  CHATGPT_MODEL_PICKER_PRIMITIVES_JS,
  modeIntentLabelLooksUsable,
  modelIntentLabelLooksUsable,
  shouldTrackPendingModeTrigger,
  shouldTrackPendingModelTrigger
} from './chatgpt-ui-primitives.mjs';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || 0);
  return Math.floor(min + Math.random() * (max - min + 1));
}

function clipText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function looksLikeResearchShellText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  return (
    /chatgpt said:\s*deep research(?:\s+apps)?(?:\s+sites)?(?:\s+chatgpt can make mistakes\. check important info\.)?/.test(text) ||
    text === 'deep research' ||
    text === 'deep research apps' ||
    text === 'deep research apps sites' ||
    /^deep research(?:\s+apps)?(?:\s+sites)?(?:\s+chatgpt can make mistakes\. check important info\.)?$/.test(text)
  );
}

const IMAGE_PLACEHOLDER_RE = /(^|(?:\\n)|\n)\s*(creating|generating)\s+images?(?:\s*(?:\\n|\n|$))/i;
const IMAGE_THINKING_LINE_RE = /(^|(?:\\n)|\n)\s*thinking(?:\s*(?:\\n|\n|$))/i;
function extractConversationUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return /\/c\/[^/]+\/?$/.test(parsed.pathname) ? parsed.toString() : null;
  } catch {
    return /\/c\/[^/?#]+/.test(text) ? text : null;
  }
}

function buildResearchMeta({ activated = false, error = null, tabId = null, conversationUrl = null, debug = null } = {}) {
  return {
    activation: {
      requested: true,
      activated: !!activated,
      error: error ? String(error) : null,
      tabId: tabId || null,
      conversationUrl: conversationUrl || null,
      debug: debug && typeof debug === 'object' ? safeClone(debug) : null
    }
  };
}

function modeIntentClickAttempt(snap = {}) {
  return {
    action: String(snap?.action || 'none'),
    reason: clipText(snap?.reason || '', 160) || null,
    label: clipText(snap?.label || '', 160) || null,
    activeIntent: snap?.activeIntent ? String(snap.activeIntent) : null,
    menuOpen: typeof snap?.menuOpen === 'boolean' ? snap.menuOpen : null,
    at: new Date().toISOString()
  };
}

function buildModeIntentProvenance({ activation, modeIntent, stage = 'before_send' } = {}) {
  if (!activation?.targetIntent && !modeIntent) return null;
  return {
    requestedIntent: normalizeChatGptModeIntent(modeIntent || activation?.targetIntent, { fallback: null }),
    targetIntent: activation?.targetIntent ? String(activation.targetIntent) : null,
    activeIntent: activation?.activeIntent ? String(activation.activeIntent) : null,
    confirmed: !!activation?.active,
    reason: clipText(activation?.reason || '', 160) || null,
    label: clipText(activation?.label || '', 160) || null,
    clicked: Array.isArray(activation?.attempts) && activation.attempts.length > 0,
    attempts: Array.isArray(activation?.attempts) ? activation.attempts.map((item) => ({ ...item })) : [],
    stage,
    confirmedAt: new Date().toISOString()
  };
}

function modelIntentClickAttempt(snap = {}) {
  return {
    action: String(snap?.action || 'none'),
    reason: clipText(snap?.reason || '', 160) || null,
    label: clipText(snap?.label || '', 160) || null,
    activeIntent: snap?.activeIntent ? String(snap.activeIntent) : null,
    menuOpen: typeof snap?.menuOpen === 'boolean' ? snap.menuOpen : null,
    at: new Date().toISOString()
  };
}

function buildModelIntentProvenance({ activation, modelIntent, stage = 'before_prompt' } = {}) {
  if (!activation?.targetIntent && !modelIntent) return null;
  return {
    requestedIntent: normalizeChatGptModelIntent(modelIntent || activation?.targetIntent, { fallback: null }),
    targetIntent: activation?.targetIntent ? String(activation.targetIntent) : null,
    activeIntent: activation?.activeIntent ? String(activation.activeIntent) : null,
    confirmed: !!activation?.active,
    reason: clipText(activation?.reason || '', 160) || null,
    label: clipText(activation?.label || '', 160) || null,
    clicked: Array.isArray(activation?.attempts) && activation.attempts.length > 0,
    attempts: Array.isArray(activation?.attempts) ? activation.attempts.map((item) => ({ ...item })) : [],
    stage,
    confirmedAt: new Date().toISOString()
  };
}

function modeIntentActivationLooksTrusted(snap = {}) {
  if (!snap?.active) return true;
  return modeIntentLabelLooksUsable(snap.label, snap.targetIntent);
}

function modelIntentActivationLooksTrusted(snap = {}) {
  if (!snap?.active) return true;
  return modelIntentLabelLooksUsable(snap.label, snap.targetIntent);
}

function safeClone(value) {
  return globalThis.structuredClone
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function blockedTitle(kind) {
  if (kind === 'login') return 'Needs sign-in';
  if (kind === 'captcha') return 'Needs CAPTCHA';
  if (kind === 'blocked') return 'Access blocked';
  if (kind === 'ui') return 'Needs page ready';
  return 'Needs attention';
}

const HOST_DOM_COLLECTION_HELPERS_JS = String.raw`
  const visible = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    const style = window.getComputedStyle(n);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const uniq = (nodes) => {
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const queryAll = (sel) => {
    if (!sel) return [];
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch {
      return [];
    }
  };
`;

const NESTED_DOM_COLLECTION_HELPERS_JS = String.raw`
  const visible = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    const style = d.defaultView?.getComputedStyle?.(n);
    return r.width > 0 && r.height > 0 && style && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const uniq = (nodes) => {
    const out = [];
    const seen = new Set();
    for (const n of nodes) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const queryAll = (sel) => {
    if (!sel) return [];
    try {
      return Array.from(d.querySelectorAll(sel));
    } catch {
      return [];
    }
  };
`;

class Mutex {
  #p = Promise.resolve();
  async run(fn) {
    const start = this.#p;
    let release;
    this.#p = new Promise((r) => (release = r));
    await start;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatGPTController {
  constructor({ page, selectors, onBlocked, onUnblocked, stateDir }) {
    this.page = page;
    this.selectors = selectors;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.mutex = new Mutex();
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
    this.currentRun = null;
  }

  async runExclusive(fn) {
    return await this.mutex.run(fn);
  }

  async navigate(url) {
    await this.page.navigate(url);
  }

  async #eval(js) {
    return await this.page.evaluate(js);
  }

  async #evalDeepResearch(js) {
    if (typeof this.page?.evaluateDeepResearch !== 'function') return null;
    return await this.page.evaluateDeepResearch(js);
  }

  async #readDeepResearchText({ maxChars = 200_000 } = {}) {
    const text = await this.#evalDeepResearch(`(() => {
      const cap = ${maxChars};
      const clean = (s) => String(s || '').replace(/\\u0000/g, '').replace(/\\s+\\n/g, '\\n').trim();
      const rootFrame = document.querySelector('#root');
      const d = rootFrame?.contentDocument;
      if (!d) return '';
      const root = d.body || d.documentElement;
      let txt = clean(root?.innerText) || clean(d.body?.innerText) || clean(d.documentElement?.innerText);
      if (!txt) txt = clean(root?.textContent) || clean(d.body?.textContent) || clean(d.documentElement?.textContent);
      return txt.slice(0, cap);
    })()`);
    return String(text || '');
  }

  async #emitProgress(patch) {
    if (!this.currentRun?.onProgress || !patch || typeof patch !== 'object') return;
    try {
      await this.currentRun.onProgress({ ...patch });
    } catch {}
  }

  async getUrl() {
    return await this.page.getUrl();
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    let text = await this.#eval(`(() => {
      const cap = ${maxChars};
      const clean = (s) => String(s || '').replace(/\\u0000/g, '').replace(/\\s+\\n/g, '\\n').trim();
      const root = document.querySelector('main') || document.body || document.documentElement;

      let txt = clean(root?.innerText) || clean(document.body?.innerText) || clean(document.documentElement?.innerText);
      if (!txt) txt = clean(root?.textContent) || clean(document.body?.textContent) || clean(document.documentElement?.textContent);

      // Last fallback for heavily client-rendered/shell pages where innerText may be empty pre-hydration.
      if (!txt) {
        const hints = Array.from(document.querySelectorAll('button, a, input, textarea, [role=\"button\"], [aria-label], [placeholder]'))
          .slice(0, 400)
          .map((n) => [n.getAttribute('aria-label'), n.getAttribute('placeholder'), n.textContent].filter(Boolean).join(' ').trim())
          .filter(Boolean);
        txt = clean(hints.join('\\n'));
      }

      return txt.slice(0, cap);
    })()`);
    text = String(text || '');
    if (!text || looksLikeResearchShellText(text)) {
      const deepText = await this.#readDeepResearchText({ maxChars }).catch(() => '');
      if (deepText) return deepText;
    }
    return text;
  }

  async #openComposerAction({ intent, timeoutMs = 10_000 } = {}) {
    const normalizedIntent = String(intent || '').trim().toLowerCase();
    if (!normalizedIntent) return null;

    const buttonSel = JSON.stringify(this.selectors.composerMenuButton || '');
    const menuSel = JSON.stringify(this.selectors.composerMenu || this.selectors.researchModeMenu || '');
    const itemSel = JSON.stringify(this.selectors.composerMenuItem || '');
    const promptSel = JSON.stringify(this.selectors.promptTextarea || '');
    const legacyResearchButtonSel = JSON.stringify(this.selectors.researchModeButton || '');
    const legacyResearchOptionSel = JSON.stringify(this.selectors.researchModeOption || '');
    const start = Date.now();
    let last = null;
    let lastClickAt = 0;

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const allowClick = lastClickAt === 0 || (Date.now() - lastClickAt) >= 1500;
      const snap = await this.#eval(`(() => {
        const intent = ${JSON.stringify(normalizedIntent)};
        const allowClick = ${allowClick ? 'true' : 'false'};
        ${HOST_DOM_COLLECTION_HELPERS_JS}
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const scorePrompt = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const labelOf = (n) =>
          [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('title') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.id || '',
            n?.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const promptFallback = Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'));
        const promptPool = [];
        const seenPrompt = new Set();
        for (const n of [...promptCandidates, ...promptFallback]) {
          if (!n || seenPrompt.has(n)) continue;
          seenPrompt.add(n);
          promptPool.push(n);
        }
        let prompt = null;
        let bestPrompt = -Infinity;
        for (const n of promptPool) {
          if (!editable(n)) continue;
          const s = scorePrompt(n);
          if (s > bestPrompt) {
            bestPrompt = s;
            prompt = n;
          }
        }
        const composerRoot =
          prompt?.closest('form') ||
          prompt?.closest('[data-testid*="composer" i], [data-testid*="prompt" i], [data-testid*="chat-input" i], [aria-label*="message" i], [aria-label*="prompt" i]') ||
          prompt?.closest('main') ||
          document.body;
        if (intent === 'upload_files') {
          const localInputs = Array.from((composerRoot || document).querySelectorAll('input[type="file"]'));
          const globalInputs = Array.from(document.querySelectorAll('input[type="file"]'));
          const inputs = localInputs.length ? localInputs : globalInputs;
          if (inputs.length) {
            return {
              action: 'file_input_ready',
              reason: 'file_input_available',
              inputSource: localInputs.length ? 'composer' : 'global',
              inputCount: inputs.length,
              menuOpen: false
            };
          }
        }
        const menuRoots = uniq([
          ...queryAll(${menuSel}),
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal]'))
        ]).filter(visible);
        const scoreUpload = (label) => {
          if (!label) return -1;
          if (/add files/.test(label)) return 130;
          if (/add photos and files/.test(label)) return 120;
          if (/add photos/.test(label)) return 110;
          if (/attach|upload|paperclip/.test(label)) return 70;
          return -1;
        };
        const scoreResearch = (label, generic = false) => {
          if (!label) return -1;
          if (/share|copy|download|export|pdf|markdown/.test(label)) return -1;
          if (/deep research/.test(label)) return 130;
          if (generic && /research|tools/.test(label)) return 70;
          return -1;
        };
        const intentScore = (label, generic = false) =>
          intent === 'upload_files' ? scoreUpload(label) : scoreResearch(label, generic);
        const itemPool = uniq([
          ...queryAll(${itemSel}),
          ...queryAll(${legacyResearchOptionSel}),
          ...menuRoots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], [role="tab"]')))
        ]);
        const rankedItem = itemPool
          .map((n) => ({ node: n, label: labelOf(n), score: intentScore(labelOf(n), false) }))
          .filter((item) => visible(item.node) && item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (!allowClick) {
          return {
            action: 'cooldown',
            reason: 'waiting_after_click',
            label: rankedItem?.label || null,
            menuOpen: menuRoots.length > 0
          };
        }
        if (rankedItem && intent === 'upload_files' && menuRoots.length > 0) {
          return {
            action: 'upload_menu_item_ready',
            reason: 'upload_menu_item_visible',
            label: rankedItem.label || null,
            menuOpen: true
          };
        }
        if (rankedItem && (menuRoots.length > 0 || intent === 'deep_research')) {
          const r = rankedItem.node.getBoundingClientRect();
          return {
            action: 'pointer_item',
            reason: intent === 'upload_files' ? 'clicked_upload_menu_item' : 'clicked_deep_research_option',
            label: rankedItem.label || null,
            menuOpen: menuRoots.length > 0,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height }
          };
        }

        const composerButtons = Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"]'));
        const globalButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"]'));
        const menuButtonPool = uniq([
          ...queryAll(${buttonSel}),
          ...composerButtons,
          ...globalButtons
        ]);
        const explicitMenuButtons = new Set(queryAll(${buttonSel}));
        const rankedMenuButton = menuButtonPool
          .map((n) => {
            const label = labelOf(n);
            let score = -1;
            if (visible(n) && n.matches('button, [role="button"], [role="tab"]')) {
              if (explicitMenuButtons.has(n)) score = 140;
              else if (n.id === 'composer-plus-btn') score = 135;
              else if (String(n.getAttribute('data-testid') || '').trim().toLowerCase() === 'composer-plus-btn') score = 135;
              else if (/add files and more|files and more/.test(label)) score = 130;
              else if (intent !== 'upload_files' && /add files|add photos/.test(label) && !/deep research|create image/.test(label)) score = 110;
            }
            return { node: n, label, score };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (rankedMenuButton) {
          const r = rankedMenuButton.node.getBoundingClientRect();
          return {
            action: 'pointer_button',
            reason: 'clicked_composer_menu_button',
            label: rankedMenuButton.label || null,
            menuOpen: menuRoots.length > 0,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height }
          };
        }

        if (intent === 'upload_files') {
          const legacyAttach = uniq([...composerButtons, ...globalButtons])
            .map((n) => ({ node: n, label: labelOf(n), score: scoreUpload(labelOf(n)) }))
            .filter((item) => visible(item.node) && item.score >= 0)
            .sort((a, b) => b.score - a.score)[0] || null;
          if (legacyAttach) {
            return {
              action: 'none',
              reason: 'upload_file_input_not_available',
              label: legacyAttach.label || null,
              menuOpen: false
            };
          }
          return { action: 'none', reason: 'upload_controls_not_found', menuOpen: false };
        }

        const legacyResearch = uniq([
          ...queryAll(${legacyResearchButtonSel}),
          ...globalButtons
        ])
          .map((n) => ({ node: n, label: labelOf(n), score: scoreResearch(labelOf(n), true) }))
          .filter((item) => visible(item.node) && item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (legacyResearch) {
          const r = legacyResearch.node.getBoundingClientRect();
          return {
            action: 'pointer_legacy_button',
            reason: 'clicked_research_trigger',
            label: legacyResearch.label || null,
            menuOpen: false,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height }
          };
        }

        return { action: 'none', reason: 'research_controls_not_found', menuOpen: false };
      })()`);
      last = snap;
      if (snap?.action === 'click_item') return snap;
      if (snap?.action === 'pointer_item' && snap?.rect?.w > 0 && snap?.rect?.h > 0) {
        const cx = Math.round(snap.rect.x + Math.max(6, Math.min(snap.rect.w - 6, snap.rect.w / 2)));
        const cy = Math.round(snap.rect.y + Math.max(6, Math.min(snap.rect.h - 6, snap.rect.h / 2)));
        await this.#clickAt(cx, cy);
        return { ...snap, action: 'click_item' };
      }
      if ((snap?.action === 'pointer_button' || snap?.action === 'pointer_legacy_button') && snap?.rect?.w > 0 && snap?.rect?.h > 0) {
        const cx = Math.round(snap.rect.x + Math.max(6, Math.min(snap.rect.w - 6, snap.rect.w / 2)));
        const cy = Math.round(snap.rect.y + Math.max(6, Math.min(snap.rect.h - 6, snap.rect.h / 2)));
        await this.#clickAt(cx, cy);
        lastClickAt = Date.now();
        await sleep(450);
        continue;
      }
      if (snap?.action === 'click_button' || snap?.action === 'click_legacy_button') {
        lastClickAt = Date.now();
        await sleep(450);
        continue;
      }
      if (snap?.action === 'cooldown') {
        await sleep(250);
        continue;
      }
      await sleep(250);
    }

    return last;
  }

  async #applyModelIntent({ modelIntent, timeoutMs = 20_000 } = {}) {
    const normalizedIntent = normalizeChatGptModelIntent(modelIntent, { fallback: null });
    if (!normalizedIntent) return { active: true, reason: 'model_intent_not_requested', targetIntent: null };

    const meta = CHATGPT_MODEL_INTENT_META[normalizedIntent];
    if (!meta) return { active: true, reason: 'model_intent_unsupported', targetIntent: normalizedIntent };

    await this.#focusPrompt({ clickPrompt: false });
    await this.#emitProgress({ phase: 'activating_model_intent', modelIntent: normalizedIntent });
    // Project option menus can remain open from previous scans; close them so
    // the composer model/mode picker can receive the next click.
    await this.page?.sendKey?.('Escape').catch(() => {});
    await sleep(100);

    const buttonSel = JSON.stringify(this.selectors.chatModeButton || '');
    const menuSel = JSON.stringify(this.selectors.chatModeMenu || this.selectors.composerMenu || '');
    const optionSel = JSON.stringify(this.selectors.chatModeOption || '');
    const activeSel = JSON.stringify(this.selectors.chatModeActive || '');
    const promptSel = JSON.stringify(this.selectors.promptTextarea || '');
    const targetIntentSource = JSON.stringify(normalizedIntent);
    const targetPatternSource = JSON.stringify(meta.pattern);
    const anyModelPatternSource = JSON.stringify(CHATGPT_ANY_MODEL_PATTERN);
    const start = Date.now();
    let last = null;
    let lastClickAt = 0;
    const blockedTriggerSignatures = new Set();
    let pendingTriggerSignature = null;
    let configureClickCount = 0;
    let legacyModelsClickCount = 0;
    let modelVersionDropdownClickCount = 0;
    const attempts = [];

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const targetIntent = ${targetIntentSource};
        const targetRe = new RegExp(${targetPatternSource}, 'i');
        const anyModelRe = new RegExp(${anyModelPatternSource}, 'i');
        const clickedRecently = ${Math.max(0, lastClickAt)} > 0 && (Date.now() - ${Math.max(0, lastClickAt)}) < 2_500;
        const blockedTriggerSignatures = new Set(${JSON.stringify([...blockedTriggerSignatures])});
        const configureClickCount = ${Math.max(0, configureClickCount)};
        const legacyModelsClickCount = ${Math.max(0, legacyModelsClickCount)};
        const modelVersionDropdownClickCount = ${Math.max(0, modelVersionDropdownClickCount)};
        ${HOST_DOM_COLLECTION_HELPERS_JS}
        ${CHATGPT_MODEL_PICKER_PRIMITIVES_JS}
        const labelOf = (n) =>
          [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('title') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const intentForLabel = (label) => modelPickerPrimitives.modelIntentForLabel(label);
        const isActive = (n) => {
          const ariaPressed = String(n?.getAttribute?.('aria-pressed') || '').trim().toLowerCase();
          const ariaChecked = String(n?.getAttribute?.('aria-checked') || '').trim().toLowerCase();
          const ariaSelected = String(n?.getAttribute?.('aria-selected') || '').trim().toLowerCase();
          const ariaCurrent = String(n?.getAttribute?.('aria-current') || '').trim().toLowerCase();
          const dataState = String(n?.getAttribute?.('data-state') || '').trim().toLowerCase();
          const classes = String(n?.className || '').trim().toLowerCase();
          return (
            ariaPressed === 'true' ||
            ariaChecked === 'true' ||
            ariaSelected === 'true' ||
            (ariaCurrent && ariaCurrent !== 'false') ||
            dataState === 'active' ||
            dataState === 'on' ||
            /\\bactive\\b|\\bselected\\b|\\bcurrent\\b/.test(classes)
          );
        };
        const rectOf = (n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const signatureOf = (rect, label) =>
          [
            Math.round(rect?.x || 0),
            Math.round(rect?.y || 0),
            Math.round(rect?.w || 0),
            Math.round(rect?.h || 0),
            String(label || '')
          ].join(':');
        const menuRoots = uniq([
          ...queryAll(${menuSel}),
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal], [role="dialog"], [role="alertdialog"]'))
        ]).filter(visible);
        const insideMenu = (node) => menuRoots.some((root) => root === node || root.contains(node));
        const promptCandidates = uniq([
          ...queryAll(${promptSel}),
          ...Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'))
        ]).filter(visible);
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const scorePrompt = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        let prompt = null;
        let bestPromptScore = -Infinity;
        for (const n of promptCandidates) {
          if (!editable(n)) continue;
          const s = scorePrompt(n);
          if (s > bestPromptScore) {
            bestPromptScore = s;
            prompt = n;
          }
        }
        const composerRoot =
          prompt?.closest('form') ||
          prompt?.closest('[data-testid*="composer" i], [data-testid*="prompt" i], [data-testid*="chat-input" i], [aria-label*="message" i], [aria-label*="prompt" i]') ||
          prompt?.closest('main') ||
          document.body;
        const promptRect = prompt ? rectOf(prompt) : null;
        const composerRootIsBroad =
          !composerRoot ||
          composerRoot === document.body ||
          String(composerRoot.tagName || '').toLowerCase() === 'main';
        const isNearPrompt = (rect) => {
          if (!promptRect || !rect) return false;
          const cx = rect.x + rect.w / 2;
          const cy = rect.y + rect.h / 2;
          const pcx = promptRect.x + promptRect.w / 2;
          const pcy = promptRect.y + promptRect.h / 2;
          return Math.abs(cx - pcx) <= 640 && Math.abs(cy - pcy) <= 280;
        };
        const modelControlDescriptor = (node, label) => ({
          label,
          dataTestId: String(node?.getAttribute?.('data-testid') || '').toLowerCase(),
          aria: String(node?.getAttribute?.('aria-label') || '').toLowerCase(),
          title: String(node?.getAttribute?.('title') || '').toLowerCase(),
          isButtonLike: !!node?.matches?.('button, [role="button"], [role="tab"], [aria-haspopup], summary')
        });
        const isHighConfidenceModelControl = (node, label) =>
          modelPickerPrimitives.isHighConfidenceModelControlDescriptor(modelControlDescriptor(node, label));
        const isProjectOptionsControl = (node, label) =>
          modelPickerPrimitives.isProjectOptionsControlDescriptor(modelControlDescriptor(node, label));
        const inModelControlRegion = (node, label, rect = null) => {
          const r = rect || rectOf(node);
          return (
            isHighConfidenceModelControl(node, label) ||
            isProjectOptionsControl(node, label) ||
            (!composerRootIsBroad && composerRoot.contains(node)) ||
            isNearPrompt(r)
          );
        };
        const explicitActiveNodes = uniq([
          ...queryAll(${activeSel}),
          ...Array.from(document.querySelectorAll('[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"], [aria-current]:not([aria-current="false"]), [data-state="active"], [data-state="on"]'))
        ]).filter(visible);
        const triggerPool = uniq([
          ...queryAll(${buttonSel}),
          ...Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], summary, [tabindex="0"]')),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], summary, [tabindex="0"]'))
        ]).filter((n) => visible(n) && !insideMenu(n));
        const activeModel = uniq([...explicitActiveNodes, ...triggerPool])
          .map((n) => ({ node: n, label: labelOf(n), intent: intentForLabel(labelOf(n)), rect: rectOf(n), active: isActive(n) }))
          .find((item) =>
            item.intent === targetIntent &&
            inModelControlRegion(item.node, item.label, item.rect) &&
            (item.active || isHighConfidenceModelControl(item.node, item.label))
          ) || null;
        if (activeModel) {
          return {
            active: true,
            action: 'none',
            reason: 'model_already_active',
            targetIntent,
            activeIntent: activeModel.intent,
            label: activeModel.label || null
          };
        }
        const optionPool = uniq([
          ...queryAll(${optionSel}),
          ...menuRoots.flatMap((root) => Array.from(root.querySelectorAll('*'))),
          ...Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="radio"], [aria-checked], [data-state]'))
        ]).filter((n) => visible(n) && !menuRoots.includes(n));
        const menuText = menuRoots
          .map((root) => String(root?.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 240);
        const optionHints = optionPool
          .map((n) => labelOf(n))
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 30);

        const triggerCandidates = triggerPool
          .map((node) => {
            const label = labelOf(node);
            const intent = intentForLabel(label);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const highConfidence = isHighConfidenceModelControl(node, label);
            const projectOptions = isProjectOptionsControl(node, label);
            const modelRegion = inModelControlRegion(node, label, rect);
            const score = modelPickerPrimitives.scoreModelTriggerCandidate({
              label,
              intent,
              targetIntent,
              highConfidence,
              projectOptions,
              modelRegion,
              anyModelMatches: anyModelRe.test(label),
              targetMatches: targetRe.test(label),
              modelKeyword: /\\bmodel\\b|\\bgpt\\b|\\b5\\.[45]\\b/.test(label),
              menuOpen: menuRoots.length > 0,
              hasDataTestId: !!String(node?.getAttribute?.('data-testid') || '').trim(),
              inComposer: !!(composerRoot && composerRoot.contains(node)),
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, intent, score, active: isActive(node), rect, signature: signatureOf(rect, label), modelRegion, highConfidence, projectOptions };
          })
          .filter((item) => !blockedTriggerSignatures.has(item.signature))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score);
        const activeTrigger = triggerCandidates.find((item) => item.intent === targetIntent && (item.active || item.highConfidence)) || null;
        if (activeTrigger) {
          return {
            active: true,
            action: 'none',
            reason: clickedRecently ? 'model_latched_after_click' : 'model_already_active',
            targetIntent,
            activeIntent: activeTrigger.intent,
            label: activeTrigger.label || null
          };
        }

        const optionCandidates = optionPool
          .map((node) => {
            const label = labelOf(node);
            const intent = intentForLabel(label);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const optionInsideMenu = menuRoots.some((root) => root === node || root.contains(node));
            const ariaChecked = String(node?.getAttribute?.('aria-checked') || '').trim().toLowerCase() === 'true';
            const active = isActive(node);
            const score = modelPickerPrimitives.scoreModelOptionCandidate({
              label,
              intent,
              targetIntent,
              optionInsideMenu,
              ariaChecked,
              active,
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, intent, score, rect, optionInsideMenu, active, ariaChecked };
          })
          .filter((item) => item.score >= 0 && item.optionInsideMenu)
          .sort((a, b) => b.score - a.score);
        const targetOption = optionCandidates[0] || null;
        if (targetOption && (targetOption.active || targetOption.ariaChecked)) {
          return {
            active: true,
            action: 'none',
            reason: clickedRecently ? 'model_option_latched_after_click' : 'model_option_already_active',
            targetIntent,
            activeIntent: targetOption.intent,
            label: targetOption.label || null
          };
        }
        if (targetOption && menuRoots.length) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_model_option',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: targetOption.label || null,
            rect: targetOption.rect,
            menuOpen: true,
            menuText,
            optionHints
          };
        }

        const modeOnlyPickerOpen = menuRoots.length && modelPickerPrimitives.isModeOnlyModelPickerState({ menuText, optionHints });
        if (clickedRecently && (configureClickCount > 0 || legacyModelsClickCount > 0 || modelVersionDropdownClickCount > 0)) {
          return {
            active: false,
            action: 'none',
            reason: 'waiting_after_model_picker_branch',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            menuOpen: menuRoots.length > 0,
            menuText,
            optionHints
          };
        }
        const configureItems = optionPool
          .map((node) => {
            const label = labelOf(node);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const optionInsideMenu = menuRoots.some((root) => root === node || root.contains(node));
            const isButtonLike = !!node?.matches?.('button, a, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="radio"], [aria-haspopup], [aria-expanded], summary, label');
            const highConfidenceConfigure = /model-configure-modal/.test(label) || /^configure(?:\\.{3}|…)?$/.test(label);
            const score = modelPickerPrimitives.scoreModelConfigureCandidate({
              label,
              optionInsideMenu,
              isButtonLike,
              highConfidenceConfigure,
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, score, rect, optionInsideMenu, highConfidenceConfigure };
          });
        const configureCandidates = configureItems
          .filter((item) => item.score >= 0 && (item.optionInsideMenu || item.highConfidenceConfigure))
          .sort((a, b) => b.score - a.score);
        const configureOption = configureCandidates[0] || null;
        if (modeOnlyPickerOpen && configureClickCount < 3 && configureOption) {
          return {
            active: false,
            action: 'pointer_configure',
            reason: 'clicked_model_configure',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: configureOption.label || null,
            rect: configureOption.rect,
            menuOpen: true,
            menuText,
            optionHints
          };
        }

        const legacyCandidates = optionPool
          .map((node) => {
            const label = labelOf(node);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const optionInsideMenu = menuRoots.some((root) => root === node || root.contains(node));
            const isButtonLike = !!node?.matches?.('button, a, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="radio"], [aria-haspopup], [aria-expanded], summary, label');
            const ariaExpanded = String(node?.getAttribute?.('aria-expanded') || '').trim().toLowerCase();
            const score = modelPickerPrimitives.scoreModelLegacyModelsCandidate({
              label,
              optionInsideMenu,
              isButtonLike,
              ariaExpanded,
              active: isActive(node),
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, score, rect, optionInsideMenu };
          })
          .filter((item) => item.score >= 0 && item.optionInsideMenu)
          .sort((a, b) => b.score - a.score);
        const legacyOption = legacyCandidates[0] || null;
        if (menuRoots.length && legacyModelsClickCount < 3 && legacyOption) {
          return {
            active: false,
            action: 'pointer_legacy_models',
            reason: 'clicked_legacy_models',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: legacyOption.label || null,
            rect: legacyOption.rect,
            menuOpen: true,
            menuText,
            optionHints
          };
        }
        const modelGenerationPickerOpen = menuRoots.length && modelPickerPrimitives.isModelGenerationPickerState({ menuText, optionHints });
        const versionDropdownItems = optionPool
          .map((node) => {
            const label = labelOf(node);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const optionInsideMenu = menuRoots.some((root) => root === node || root.contains(node));
            const isButtonLike = !!node?.matches?.('button, a, [role="button"], [role="link"], [role="combobox"], [aria-haspopup], [aria-expanded], [tabindex="0"], summary, label');
            const ariaExpanded = String(node?.getAttribute?.('aria-expanded') || '').trim().toLowerCase();
            const active = isActive(node);
            const score = modelPickerPrimitives.scoreModelVersionDropdownCandidate({
              label,
              optionInsideMenu,
              isButtonLike,
              ariaExpanded,
              active,
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, score, rect, optionInsideMenu, isButtonLike, ariaExpanded, active };
          });
        const versionDropdownCandidates = versionDropdownItems
          .filter((item) => item.score >= 0 && item.optionInsideMenu)
          .sort((a, b) => b.score - a.score);
        const versionDropdown = versionDropdownCandidates[0] || null;
        if (modelGenerationPickerOpen && modelVersionDropdownClickCount < 3 && versionDropdown) {
          return {
            active: false,
            action: 'pointer_model_version_dropdown',
            reason: 'clicked_model_version_dropdown',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: versionDropdown.label || null,
            rect: versionDropdown.rect,
            menuOpen: true,
            menuText,
            optionHints
          };
        }
        if ((configureClickCount > 0 || legacyModelsClickCount > 0 || modelVersionDropdownClickCount > 0) && modelGenerationPickerOpen) {
          const versionDropdownHints = versionDropdownItems
            .filter((item) => /latest|model|5\.[245]|o3/.test(item.label))
            .map((item) => [
              item.score,
              item.optionInsideMenu ? 'in' : 'out',
              item.isButtonLike ? 'btn' : 'plain',
              item.active ? 'active' : 'idle',
              item.ariaExpanded || 'closed',
              String(Math.round(item.rect?.w || 0)) + 'x' + String(Math.round(item.rect?.h || 0)),
              item.label
            ].join(':'))
            .slice(0, 8);
          return {
            active: false,
            action: 'unavailable',
            reason: 'target_model_not_listed',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            menuOpen: true,
            menuText,
            optionHints,
            versionDropdownHints
          };
        }
        if (modeOnlyPickerOpen) {
          const configureHints = configureItems
            .filter((item) => /configure/.test(item.label))
            .map((item) => [
              item.score,
              item.optionInsideMenu ? 'in' : 'out',
              item.highConfidenceConfigure ? 'hi' : 'lo',
              String(Math.round(item.rect?.w || 0)) + 'x' + String(Math.round(item.rect?.h || 0)),
              item.label
            ].join(':'))
            .slice(0, 8);
          return {
            active: false,
            action: 'unavailable',
            reason: 'model_generation_picker_unavailable',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            menuOpen: true,
            menuText,
            optionHints,
            configureHints
          };
        }

        const trigger = triggerCandidates[0] || null;
        if (trigger) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_model_trigger',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: trigger.label || null,
            rect: trigger.rect,
            signature: trigger.signature,
            menuOpen: menuRoots.length > 0,
            menuText,
            optionHints
          };
        }

        const composerHints = triggerPool
          .map((n) => labelOf(n))
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 12);
        return {
          active: false,
          action: 'none',
          reason: 'model_controls_not_found',
          targetIntent,
          activeIntent: activeTrigger?.intent || null,
          menuOpen: menuRoots.length > 0,
          menuText,
          optionHints,
          composerHints
        };
      })()`);
      last = snap;
      if (pendingTriggerSignature && snap?.action === 'pointer_trigger' && !snap?.menuOpen && snap?.signature === pendingTriggerSignature) {
        blockedTriggerSignatures.add(pendingTriggerSignature);
        pendingTriggerSignature = null;
        await sleep(200);
        continue;
      }
      if (pendingTriggerSignature && (snap?.menuOpen || snap?.signature !== pendingTriggerSignature || snap?.action !== 'pointer_trigger')) {
        pendingTriggerSignature = null;
      }
      if (snap?.active) {
        const activation = { ...snap, clicked: attempts.length > 0, attempts: attempts.map((item) => ({ ...item })) };
        if (modelIntentActivationLooksTrusted(activation)) {
          // The Configure/Intelligence surface can remain open after model selection.
          // Close any nested picker/modal before prompt staging begins.
          await this.page?.sendKey?.('Escape').catch(() => {});
          await sleep(120);
          await this.page?.sendKey?.('Escape').catch(() => {});
          await sleep(120);
          return activation;
        }
        last = {
          ...activation,
          active: false,
          reason: 'model_activation_untrusted',
          untrustedReason: activation.reason || null
        };
        await sleep(250);
        continue;
      }
      if (snap?.action === 'unavailable') {
        last = snap;
        break;
      }
      if (
        (
          snap?.action === 'pointer_trigger' ||
          snap?.action === 'pointer_option' ||
          snap?.action === 'pointer_configure' ||
          snap?.action === 'pointer_legacy_models' ||
          snap?.action === 'pointer_model_version_dropdown'
        ) &&
        snap?.rect?.w > 0 &&
        snap?.rect?.h > 0
      ) {
        attempts.push(modelIntentClickAttempt(snap));
        const cx = Math.round(snap.rect.x + Math.max(6, Math.min(snap.rect.w - 6, snap.rect.w / 2)));
        const cy = Math.round(snap.rect.y + Math.max(6, Math.min(snap.rect.h - 6, snap.rect.h / 2)));
        await this.#clickAt(cx, cy);
        if (snap.action === 'pointer_configure') configureClickCount += 1;
        if (snap.action === 'pointer_legacy_models') legacyModelsClickCount += 1;
        if (snap.action === 'pointer_model_version_dropdown') modelVersionDropdownClickCount += 1;
        if (shouldTrackPendingModelTrigger(snap)) pendingTriggerSignature = snap.signature;
        lastClickAt = Date.now();
        await sleep(450);
        continue;
      }
      await sleep(250);
    }

    const err = new Error('model_intent_activation_failed');
    err.data = {
      reason: clipText(last?.reason || 'model_activation_timeout', 160) || 'model_activation_timeout',
      targetIntent: normalizedIntent,
      attempts: attempts.map((item) => ({ ...item })),
      state: last || null
    };
    throw err;
  }

  async #applyModeIntent({ modeIntent, timeoutMs = 20_000 } = {}) {
    const normalizedIntent = normalizeChatGptModeIntent(modeIntent, { fallback: null });
    if (!normalizedIntent) return { active: true, reason: 'mode_intent_not_requested', targetIntent: null };

    const meta = CHATGPT_MODE_INTENT_META[normalizedIntent];
    if (!meta) return { active: true, reason: 'mode_intent_unsupported', targetIntent: normalizedIntent };

    await this.#focusPrompt({ clickPrompt: false });
    await this.#emitProgress({ phase: 'activating_mode_intent', modeIntent: normalizedIntent });

    const buttonSel = JSON.stringify(this.selectors.chatModeButton || '');
    const menuSel = JSON.stringify(this.selectors.chatModeMenu || this.selectors.composerMenu || '');
    const optionSel = JSON.stringify(this.selectors.chatModeOption || '');
    const activeSel = JSON.stringify(this.selectors.chatModeActive || '');
    const promptSel = JSON.stringify(this.selectors.promptTextarea || '');
    const targetIntentSource = JSON.stringify(normalizedIntent);
    const targetPatternSource = JSON.stringify(meta.pattern);
    const anyModePatternSource = JSON.stringify(CHATGPT_ANY_MODE_PATTERN);
    const start = Date.now();
    let last = null;
    let lastClickAt = 0;
    const blockedTriggerSignatures = new Set();
    let pendingTriggerSignature = null;
    const attempts = [];

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const targetIntent = ${targetIntentSource};
        const targetRe = new RegExp(${targetPatternSource}, 'i');
        const anyModeRe = new RegExp(${anyModePatternSource}, 'i');
        const clickedRecently = ${Math.max(0, lastClickAt)} > 0 && (Date.now() - ${Math.max(0, lastClickAt)}) < 2_500;
        const blockedTriggerSignatures = new Set(${JSON.stringify([...blockedTriggerSignatures])});
        ${HOST_DOM_COLLECTION_HELPERS_JS}
        ${CHATGPT_MODE_PICKER_PRIMITIVES_JS}
        const labelOf = (n) =>
          [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('title') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const intentForLabel = (label) => modePickerPrimitives.modeIntentForLabel(label);
        const isActive = (n) => {
          const ariaPressed = String(n?.getAttribute?.('aria-pressed') || '').trim().toLowerCase();
          const ariaChecked = String(n?.getAttribute?.('aria-checked') || '').trim().toLowerCase();
          const ariaSelected = String(n?.getAttribute?.('aria-selected') || '').trim().toLowerCase();
          const ariaCurrent = String(n?.getAttribute?.('aria-current') || '').trim().toLowerCase();
          const dataState = String(n?.getAttribute?.('data-state') || '').trim().toLowerCase();
          const classes = String(n?.className || '').trim().toLowerCase();
          return (
            ariaPressed === 'true' ||
            ariaChecked === 'true' ||
            ariaSelected === 'true' ||
            (ariaCurrent && ariaCurrent !== 'false') ||
            dataState === 'active' ||
            dataState === 'on' ||
            /\\bactive\\b|\\bselected\\b|\\bcurrent\\b/.test(classes)
          );
        };
        const rectOf = (n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const signatureOf = (rect, label) =>
          [
            Math.round(rect?.x || 0),
            Math.round(rect?.y || 0),
            Math.round(rect?.w || 0),
            Math.round(rect?.h || 0),
            String(label || '')
          ].join(':');
        const menuRoots = uniq([
          ...queryAll(${menuSel}),
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal], [role="dialog"], [role="alertdialog"]'))
        ]).filter(visible);
        const insideMenu = (node) => menuRoots.some((root) => root === node || root.contains(node));
        const promptCandidates = uniq([
          ...queryAll(${promptSel}),
          ...Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'))
        ]).filter(visible);
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const scorePrompt = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        let prompt = null;
        let bestPromptScore = -Infinity;
        for (const n of promptCandidates) {
          if (!editable(n)) continue;
          const s = scorePrompt(n);
          if (s > bestPromptScore) {
            bestPromptScore = s;
            prompt = n;
          }
        }
        const composerRoot =
          prompt?.closest('form') ||
          prompt?.closest('[data-testid*="composer" i], [data-testid*="prompt" i], [data-testid*="chat-input" i], [aria-label*="message" i], [aria-label*="prompt" i]') ||
          prompt?.closest('main') ||
          document.body;
        const promptRect = prompt ? rectOf(prompt) : null;
        const composerRootIsBroad =
          !composerRoot ||
          composerRoot === document.body ||
          String(composerRoot.tagName || '').toLowerCase() === 'main';
        const isNearPrompt = (rect) => {
          if (!promptRect || !rect) return false;
          const cx = rect.x + rect.w / 2;
          const cy = rect.y + rect.h / 2;
          const pcx = promptRect.x + promptRect.w / 2;
          const pcy = promptRect.y + promptRect.h / 2;
          return Math.abs(cx - pcx) <= 640 && Math.abs(cy - pcy) <= 280;
        };
        const modeControlDescriptor = (node, label) => ({
          label,
          dataTestId: String(node?.getAttribute?.('data-testid') || '').toLowerCase(),
          aria: String(node?.getAttribute?.('aria-label') || '').toLowerCase(),
          title: String(node?.getAttribute?.('title') || '').toLowerCase()
        });
        const isHighConfidenceModeControl = (node, label) =>
          modePickerPrimitives.isHighConfidenceModeControlDescriptor(modeControlDescriptor(node, label));
        const inModeControlRegion = (node, label, rect = null) => {
          const r = rect || rectOf(node);
          return (
            isHighConfidenceModeControl(node, label) ||
            (!composerRootIsBroad && composerRoot.contains(node)) ||
            isNearPrompt(r)
          );
        };
        const explicitActiveNodes = uniq(queryAll(${activeSel})).filter(visible);
        const explicitActive = explicitActiveNodes
          .map((n) => ({ node: n, label: labelOf(n), intent: intentForLabel(labelOf(n)), rect: rectOf(n) }))
          .find((item) => item.intent === targetIntent && inModeControlRegion(item.node, item.label, item.rect)) || null;
        if (explicitActive) {
          return {
            active: true,
            action: 'none',
            reason: 'mode_already_active',
            targetIntent,
            activeIntent: explicitActive.intent,
            label: explicitActive.label || null
          };
        }
        const triggerPool = uniq([
          ...queryAll(${buttonSel}),
          ...Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], summary, [tabindex="0"]')),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], summary, [tabindex="0"]'))
        ]).filter((n) => visible(n) && !insideMenu(n));
        const optionPool = uniq([
          ...queryAll(${optionSel}),
          ...menuRoots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="radio"], [aria-checked], [data-state], label, li, div, span'))),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="switch"], [role="radio"], [aria-checked], [data-state]'))
        ]).filter((n) => visible(n) && !menuRoots.includes(n));
        const menuText = menuRoots
          .map((root) => String(root?.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 240);
        const optionHints = optionPool
          .map((n) => labelOf(n))
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 12);

        const triggerCandidates = triggerPool
          .map((node) => {
            const label = labelOf(node);
            const intent = intentForLabel(label);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const highConfidence = isHighConfidenceModeControl(node, label);
            const modeRegion = inModeControlRegion(node, label, rect);
            let promptProximityBoost = 0;
            if (promptRect) {
              const cx = rect.x + rect.w / 2;
              const cy = rect.y + rect.h / 2;
              const dx = Math.abs(cx - (promptRect.x + promptRect.w / 2));
              const dy = Math.abs(cy - (promptRect.y + promptRect.h / 2));
              promptProximityBoost = Math.max(0, 180 - dx / 8 - dy / 5);
            }
            const score = modePickerPrimitives.scoreModeTriggerCandidate({
              label,
              intent,
              targetIntent,
              active: isActive(node),
              highConfidence,
              modeRegion,
              anyModeMatches: anyModeRe.test(label),
              targetMatches: targetRe.test(label),
              modeKeyword: /\\bmode\\b|\\bmodel\\b|\\breason\\b|\\bthink\\b/.test(label),
              hasDataTestId: !!String(node?.getAttribute?.('data-testid') || '').trim(),
              inComposer: !!(composerRoot && composerRoot.contains(node)),
              promptProximityBoost,
              area,
              width: rect.w,
              height: rect.h,
              y: rect.y
            });
            return { node, label, intent, score, active: isActive(node), rect, signature: signatureOf(rect, label), modeRegion, highConfidence };
          })
          .filter((item) => !blockedTriggerSignatures.has(item.signature))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score);
        const activeTrigger = triggerCandidates.find((item) => item.active && item.intent) || null;
        if (activeTrigger?.intent === targetIntent) {
          return {
            active: true,
            action: 'none',
            reason: 'mode_already_active',
            targetIntent,
            activeIntent: activeTrigger.intent,
            label: activeTrigger.label || null
          };
        }
        if (clickedRecently) {
          const targetTrigger = triggerCandidates.find((item) => item.intent === targetIntent) || null;
          if (targetTrigger) {
            return {
              active: true,
              action: 'none',
              reason: 'mode_latched_after_click',
              targetIntent,
              activeIntent: targetTrigger.intent,
              label: targetTrigger.label || null
            };
          }
        }

        const optionCandidates = optionPool
          .map((node) => {
            const label = labelOf(node);
            const intent = intentForLabel(label);
            const rect = rectOf(node);
            const area = Math.max(0, rect.w) * Math.max(0, rect.h);
            const optionInsideMenu = menuRoots.some((root) => root === node || root.contains(node));
            const score = modePickerPrimitives.scoreModeOptionCandidate({
              label,
              intent,
              targetIntent,
              optionInsideMenu,
              ariaChecked: String(node?.getAttribute?.('aria-checked') || '').trim().toLowerCase() === 'true',
              active: isActive(node),
              area,
              width: rect.w,
              height: rect.h
            });
            return { node, label, intent, score, rect, optionInsideMenu };
          })
          .filter((item) => item.score >= 0 && item.optionInsideMenu)
          .sort((a, b) => b.score - a.score);
        const targetOption = optionCandidates[0] || null;
        if (targetOption && menuRoots.length) {
          return {
            active: false,
            action: 'pointer_option',
            reason: 'clicked_mode_option',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: targetOption.label || null,
            rect: targetOption.rect,
            menuOpen: true,
            menuText,
            optionHints
          };
        }

        const trigger = triggerCandidates[0] || null;
        if (trigger) {
          return {
            active: false,
            action: 'pointer_trigger',
            reason: 'clicked_mode_trigger',
            targetIntent,
            activeIntent: activeTrigger?.intent || null,
            label: trigger.label || null,
            rect: trigger.rect,
            signature: trigger.signature,
            menuOpen: menuRoots.length > 0,
            menuText,
            optionHints
          };
        }

        const composerHints = triggerPool
          .map((n) => labelOf(n))
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 12);
        return {
          active: false,
          action: 'none',
          reason: 'mode_controls_not_found',
          targetIntent,
          activeIntent: activeTrigger?.intent || null,
          menuOpen: menuRoots.length > 0,
          menuText,
          optionHints,
          composerHints
        };
      })()`);
      last = snap;
      if (pendingTriggerSignature && snap?.action === 'pointer_trigger' && !snap?.menuOpen && snap?.signature === pendingTriggerSignature) {
        blockedTriggerSignatures.add(pendingTriggerSignature);
        pendingTriggerSignature = null;
        await sleep(200);
        continue;
      }
      if (pendingTriggerSignature && (snap?.menuOpen || snap?.signature !== pendingTriggerSignature || snap?.action !== 'pointer_trigger')) {
        pendingTriggerSignature = null;
      }
      if (snap?.active) {
        const activation = { ...snap, clicked: attempts.length > 0, attempts: attempts.map((item) => ({ ...item })) };
        if (modeIntentActivationLooksTrusted(activation)) return activation;
        last = {
          ...activation,
          active: false,
          reason: 'mode_activation_untrusted',
          untrustedReason: activation.reason || null
        };
        await sleep(250);
        continue;
      }
      if ((snap?.action === 'pointer_trigger' || snap?.action === 'pointer_option') && snap?.rect?.w > 0 && snap?.rect?.h > 0) {
        attempts.push(modeIntentClickAttempt(snap));
        const cx = Math.round(snap.rect.x + Math.max(6, Math.min(snap.rect.w - 6, snap.rect.w / 2)));
        const cy = Math.round(snap.rect.y + Math.max(6, Math.min(snap.rect.h - 6, snap.rect.h / 2)));
        await this.#clickAt(cx, cy);
        if (shouldTrackPendingModeTrigger(snap)) pendingTriggerSignature = snap.signature;
        lastClickAt = Date.now();
        await sleep(450);
        continue;
      }
      await sleep(250);
    }

    const err = new Error('mode_intent_activation_failed');
    err.data = {
      reason: clipText(last?.reason || 'mode_activation_timeout', 160) || 'mode_activation_timeout',
      targetIntent: normalizedIntent,
      attempts: attempts.map((item) => ({ ...item })),
      state: last || null
    };
    throw err;
  }

  async detectChallenge() {
    const result = await this.#eval(`(() => {
      const url = location.href || '';
      const title = document.title || '';
      const readyState = document.readyState || '';
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .map(f => String(f.getAttribute('src') || ''))
        .filter(Boolean);
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };

      const hasTurnstile = iframeSrcs.some(s => /turnstile/i.test(s)) || !!document.querySelector('iframe[src*=\"turnstile\" i]');
      const hasArkose = iframeSrcs.some(s => /arkoselabs|arkose/i.test(s)) || !!document.querySelector('iframe[src*=\"arkose\" i], iframe[src*=\"arkoselabs\" i]');
      const hasVerifyButton = Array.from(document.querySelectorAll('button, a'))
        .some(b => /verify you are human|human verification|i am human/i.test((b.textContent || '').trim()));

      const looks403 = /\\b403\\b|access denied|forbidden|unusual traffic|verify/i.test(bodyText) && !/prompt/i.test(bodyText);
      const loginLike = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]')
        || /log in|sign in|continue with/i.test(bodyText);

      const rawPromptVisible = (() => {
        const pickPrompt = (nodes) => {
          const editable = (n) => {
            if (!n) return false;
            if (!visible(n)) return false;
            if (n.matches('textarea')) return !n.disabled && !n.readOnly;
            if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
            return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
          };
          const score = (n) => {
            const r = n.getBoundingClientRect();
            const label = [
              n.getAttribute('aria-label') || '',
              n.getAttribute('placeholder') || '',
              n.getAttribute('name') || '',
              n.getAttribute('id') || '',
              n.getAttribute('data-testid') || ''
            ].join(' ').toLowerCase();
            let s = 0;
            if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
            if (n.matches('textarea')) s += 50;
            if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
            if (n.getAttribute('role') === 'textbox') s += 25;
            if (r.width >= 260 && r.height >= 26) s += 20;
            s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
            s += Math.max(0, r.y / 8);
            return s;
          };
          let best = null;
          let bestScore = -Infinity;
          for (const n of nodes) {
            if (!editable(n)) continue;
            const s = score(n);
            if (s > bestScore) {
              bestScore = s;
              best = n;
            }
          }
          return best;
        };

        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        return !!pickPrompt(uniq);
      })();

      const sendVisible = (() => {
        const labelOf = (n) =>
          [
            n.getAttribute('aria-label') || '',
            n.getAttribute('title') || '',
            n.getAttribute('data-testid') || '',
            n.textContent || ''
          ]
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        return Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.sendButton)})).some((n) => {
          if (!visible(n)) return false;
          const label = labelOf(n);
          if (/stop|cancel|retry|signin|sign in|log in|login|continue with|google|microsoft|apple/.test(label)) return false;
          return /send|submit|run|go|ask|reply/.test(label) || n.matches('[data-testid=\"send-button\"], [aria-label=\"Send prompt\"], [aria-label=\"Send\"]');
        });
      })();
      const promptVisible = rawPromptVisible && (!loginLike || sendVisible);

      const blocked = hasTurnstile || hasArkose || hasVerifyButton || looks403 || (loginLike && !promptVisible);
      const kind = (hasTurnstile || hasArkose || hasVerifyButton) ? 'captcha' : (loginLike ? 'login' : (looks403 ? 'blocked' : null));
      return {
        url, title, readyState,
        blocked,
        promptVisible,
        kind,
        indicators: { hasTurnstile, hasArkose, hasVerifyButton, looks403, loginLike, rawPromptVisible, sendVisible }
      };
    })()`);

    return result;
  }

  async waitForPromptVisible({ timeoutMs = 10 * 60_000, pollMs = 500 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const st = await this.detectChallenge().catch(() => null);
      if (st?.blocked) await this.#enterBlockedState(st);
      if (st?.promptVisible) return st;

      const elapsed = Date.now() - start;
      if (!this.blocked && elapsed > 5000 && st?.readyState === 'complete') {
        await this.#enterBlockedState({ ...(st || {}), blocked: true, kind: 'ui' });
      }
      await sleep(pollMs);
    }
    const last = await this.detectChallenge().catch(() => null);
    const err = new Error('timeout_waiting_for_prompt');
    err.data = last;
    throw err;
  }

  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_ready', blocked: false, blockedKind: null, blockedTitle: null });
    const st = await this.detectChallenge().catch(() => null);
    if (st?.blocked) {
      await this.#enterBlockedState(st);
    }
    const ready = await this.waitForPromptVisible({ timeoutMs });
    await this.#exitBlockedStateIfNeeded();
    return ready;
  }

  async #enterBlockedState(st) {
    if (!this.blocked) {
      this.blocked = true;
      this.blockedKind = st?.kind || null;
      await this.#emitProgress({
        phase: 'awaiting_user',
        blocked: true,
        blockedKind: this.blockedKind || 'blocked',
        blockedTitle: blockedTitle(this.blockedKind)
      });
      await this.onBlocked?.(st);
    }
  }

  async #exitBlockedStateIfNeeded() {
    if (this.blocked) {
      this.blocked = false;
      this.blockedKind = null;
      await this.#emitProgress({ blocked: false, blockedKind: null, blockedTitle: null });
      await this.onUnblocked?.();
    }
  }

  async #sendKey(key, { modifiers = [] } = {}) {
    await this.page.sendKey(key, { modifiers });
  }

  #throwIfStopRequested() {
    if (!this.currentRun?.requested) return;
    const err = new Error('query_aborted');
    err.data = {
      reason: this.currentRun.reason || 'user_stop',
      requestedAt: this.currentRun.requestedAt || null
    };
    throw err;
  }

  async #clickVisibleStop() {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    return await this.#eval(`(() => {
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const stop = Array.from(document.querySelectorAll(${stopSel})).find(visible);
      if (!stop) return false;
      try {
        stop.click();
        return true;
      } catch {
        return false;
      }
    })()`);
  }

  async requestStop({ reason = 'user_stop' } = {}) {
    if (this.currentRun) {
      this.currentRun.requested = true;
      this.currentRun.requestedAt = Date.now();
      this.currentRun.reason = reason || 'user_stop';
    }
    const clicked = await this.#clickVisibleStop().catch(() => false);
    return { ok: true, requested: !!this.currentRun || !!clicked, clicked };
  }

  async #typeHuman(text) {
    const str = String(text);
    // For large prompts (>500 chars), bulk-insert lines to avoid spending
    // minutes typing character-by-character. Split on newlines and use
    // Shift+Enter between lines to prevent triggering send.
    if (str.length > 500) {
      const lines = str.split('\n');
      for (let i = 0; i < lines.length; i++) {
        this.#throwIfStopRequested();
        if (lines[i].length > 0) {
          await this.page.insertText(lines[i]);
        }
        if (i < lines.length - 1) {
          await this.#sendKey('Return', { modifiers: ['shift'] });
        }
        // Brief pause every 50 lines to let the UI catch up
        if (i > 0 && i % 50 === 0) await sleep(jitter(30, 80));
      }
      return;
    }
    for (const ch of str) {
      this.#throwIfStopRequested();
      if (ch === '\n') {
        await this.#sendKey('Return', { modifiers: ['shift'] });
      } else {
        await this.page.insertText(ch);
      }
      await sleep(jitter(12, 45));
    }
  }

  async #moveMouseTo(x, y) {
    const from = { ...this.mouse };
    const steps = Math.max(6, Math.min(22, Math.floor(Math.hypot(x - from.x, y - from.y) / 35)));
    for (let i = 1; i <= steps; i++) {
      this.#throwIfStopRequested();
      const t = i / steps;
      const nx = Math.round(from.x + (x - from.x) * t + jitter(-2, 2));
      const ny = Math.round(from.y + (y - from.y) * t + jitter(-2, 2));
      await this.page.moveMouse(nx, ny);
      await sleep(jitter(6, 18));
      this.mouse = { x: nx, y: ny };
    }
  }

  async #clickAt(x, y) {
    await this.#moveMouseTo(x, y);
    await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    await sleep(jitter(20, 60));
    await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
  }

  async #focusPrompt({ phase = null, clickPrompt = true } = {}) {
    if (phase) await this.#emitProgress({ phase });
    const sel = JSON.stringify(this.selectors.promptTextarea);
    const ok = await this.#eval(`(() => {
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8); // lower on page is more likely the composer
        return s;
      };
      const base = Array.from(document.querySelectorAll(${sel}));
      const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
      const candidates = [];
      const seen = new Set();
      for (const n of [...base, ...fallback]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
      let el = null;
      let best = -Infinity;
      for (const n of candidates) {
        if (!editable(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          el = n;
        }
      }
      if (!el) return { ok:false, error:'missing_prompt_textarea' };
      el.focus();
      const r = el.getBoundingClientRect();
      return { ok:true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`);
    if (!ok?.ok) {
      const err = new Error(ok?.error || 'type_failed');
      err.data = ok;
      throw err;
    }

    if (clickPrompt && ok?.rect?.w > 0 && ok?.rect?.h > 0) {
      const cx = Math.round(ok.rect.x + Math.min(ok.rect.w - 6, 18));
      const cy = Math.round(ok.rect.y + Math.min(ok.rect.h - 6, 18));
      await this.#clickAt(cx, cy);
    }

    return ok;
  }

  async #typePrompt(prompt, { clickPrompt = true } = {}) {
    await this.#focusPrompt({ phase: 'typing_prompt', clickPrompt });

    const isMac = process.platform === 'darwin';
    await sleep(jitter(25, 80));
    await this.#sendKey('A', { modifiers: [isMac ? 'meta' : 'control'] });
    await sleep(jitter(15, 50));
    await this.#sendKey('Backspace');
    await sleep(jitter(25, 80));
    await this.#typeHuman(prompt);
  }

  async #waitForSendSignal({ timeoutMs = 1800, pollMs = 120, initialPromptLen = 0 } = {}) {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stopVisible = Array.from(document.querySelectorAll(${stopSel})).some(visible);
        const send = Array.from(document.querySelectorAll(${sendSel})).find(visible);
        const sendDisabled = !!send && !!send.disabled;

        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const score = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const promptCandidates = Array.from(document.querySelectorAll(${promptSel}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let prompt = null;
        let best = -Infinity;
        for (const n of uniq) {
          if (!editable(n)) continue;
          const s = score(n);
          if (s > best) {
            best = s;
            prompt = n;
          }
        }
        let promptLen = -1;
        if (prompt?.matches('textarea, input')) {
          promptLen = String(prompt.value || '').trim().length;
        } else if (prompt && (prompt.isContentEditable || prompt.getAttribute('contenteditable') === 'true' || prompt.getAttribute('role') === 'textbox')) {
          promptLen = String(prompt.innerText || prompt.textContent || '').trim().length;
        }
        return { stopVisible, sendDisabled, promptLen };
      })()`);

      const promptChanged = Number.isFinite(initialPromptLen) && initialPromptLen > 0 && snap?.promptLen >= 0 && snap.promptLen < initialPromptLen;
      if (snap?.stopVisible || snap?.sendDisabled || promptChanged) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async #clickSend() {
    await this.#emitProgress({ phase: 'sending_prompt' });
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    let lastSendDebug = null;
    const res = await this.#eval(`(() => {
      const stop = Array.from(document.querySelectorAll(${stopSel})).find((n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
      if (stop) return { ok:false, error:'already_generating' };
      const host = location.hostname || '';
      const visible = (n) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const labelOf = (n) =>
        [
          n.getAttribute('aria-label') || '',
          n.getAttribute('title') || '',
          n.getAttribute('data-testid') || '',
          n.textContent || ''
        ]
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim()
          .toLowerCase();
      const describeControl = (n) => {
        if (!n) return null;
        return {
          label: labelOf(n) || null,
          testId: n.getAttribute('data-testid') || null,
          ariaLabel: n.getAttribute('aria-label') || null,
          type: n.getAttribute('type') || null
        };
      };
      const looksVoiceLike = (n) => {
        const label = labelOf(n);
        return (
          /voice|microphone|mic|audio|dictat|transcrib|record|speak|listen|read aloud/.test(label) ||
          n.matches('[data-testid*=\"voice\" i], [data-testid*=\"mic\" i], [data-testid*=\"audio\" i], [aria-label*=\"voice\" i], [aria-label*=\"microphone\" i], [aria-label*=\"audio\" i]')
        );
      };
      const looksPositiveSend = (n) => {
        const label = labelOf(n);
        return n.matches(${sendSel}) || /send|submit|run|go|ask|reply/.test(label);
      };
      const promptScore = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8);
        return s;
      };
      const pickPrompt = () => {
        const base = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const candidates = [];
        const seen = new Set();
        for (const n of [...base, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          candidates.push(n);
        }
        let best = null;
        let bestScore = -Infinity;
        for (const n of candidates) {
          if (!editable(n)) continue;
          const s = promptScore(n);
          if (s > bestScore) {
            bestScore = s;
            best = n;
          }
        }
        return best;
      };
      const prompt = pickPrompt();
      const promptLen = prompt
        ? prompt.matches('textarea, input')
          ? String(prompt.value || '').trim().length
          : String(prompt.innerText || prompt.textContent || '').trim().length
        : 0;
      const composerRoot =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
        prompt?.closest('main') ||
        null;
      const promptRect = prompt ? prompt.getBoundingClientRect() : null;
      if (!prompt || promptLen <= 0) return { ok:false, error:'missing_staged_prompt', host };
      const form = prompt?.closest('form') || null;
      const submitter = form
        ? Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n) && !looksVoiceLike(n))
        : null;
      const score = (n) => {
        const r = n.getBoundingClientRect();
        const label = labelOf(n);
        let s = 0;
        if (looksVoiceLike(n)) s -= 400;
        if (n.matches(${sendSel})) s += 120;
        if (/send|submit|run|go|ask|reply/.test(label)) s += 90;
        if (/stop|cancel|retry|signin|sign in|log in|google/.test(label)) s -= 140;
        if (n.getAttribute('type') === 'submit') s += 35;
        if (composerRoot && composerRoot.contains(n)) s += 160;
        if (r.width >= 16 && r.height >= 16) s += 10;
        s += Math.max(0, r.y / 10);
        s += Math.max(0, r.x / 20);
        if (promptRect) {
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const dx = Math.abs(cx - (promptRect.x + promptRect.width));
          const dy = Math.abs(cy - (promptRect.y + promptRect.height / 2));
          s += Math.max(0, 140 - dx / 6 - dy / 4);
        }
        return s;
      };
      const pool = [];
      const seen = new Set();
      const localPool = composerRoot ? [...composerRoot.querySelectorAll(${sendSel}), ...composerRoot.querySelectorAll('button, [role=\"button\"]')] : [];
      for (const n of [...localPool, ...document.querySelectorAll(${sendSel}), ...document.querySelectorAll('button, [role=\"button\"]')]) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        pool.push(n);
      }
      let btn = null;
      let best = -Infinity;
      for (const n of pool) {
        if (!visible(n) || disabled(n)) continue;
        if (looksVoiceLike(n)) continue;
        if (!looksPositiveSend(n)) continue;
        const s = score(n);
        if (s > best) {
          best = s;
          btn = n;
        }
      }
      if (!btn) return { ok:true, fallbackEnter:true, requestSubmit: !!submitter, host, promptLen };
      const r = btn.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        requestSubmit: !!submitter,
        host,
        promptLen,
        button: describeControl(btn),
        submitter: describeControl(submitter),
        composerHasForm: !!form,
        candidateCount: pool.length
      };
    })()`);
    if (!res?.ok) {
      const err = new Error(res?.error || 'send_failed');
      err.data = res;
      throw err;
    }
    if (Number.isFinite(res?.promptLen) && res.promptLen <= 0) {
      const err = new Error('missing_staged_prompt');
      err.data = res;
      throw err;
    }
    lastSendDebug = {
      stage: 'choose_action',
      host: String(res?.host || '') || null,
      promptLen: Number.isFinite(res?.promptLen) ? res.promptLen : null,
      fallbackEnter: !!res?.fallbackEnter,
      requestSubmit: !!res?.requestSubmit,
      candidateCount: Number.isFinite(res?.candidateCount) ? res.candidateCount : null,
      composerHasForm: !!res?.composerHasForm,
      button: res?.button || null,
      submitter: res?.submitter || null
    };
    await this.#emitProgress({ sendDebug: lastSendDebug });

    let sent = false;
    if (res?.requestSubmit) {
      this.#throwIfStopRequested();
      const submitted = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const score = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let prompt = null;
        let best = -Infinity;
        for (const n of uniq) {
          if (!editable(n)) continue;
          const s = score(n);
          if (s > best) {
            best = s;
            prompt = n;
          }
        }
        const form = prompt?.closest?.('form') || null;
        if (!form || typeof form.requestSubmit !== 'function') return false;
        const submitBtn = Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n));
        if (!submitBtn) return false;
        form.requestSubmit(submitBtn);
        return true;
      })()`);
      lastSendDebug = {
        ...lastSendDebug,
        stage: 'request_submit',
        submitted: !!submitted
      };
      await this.#emitProgress({ sendDebug: lastSendDebug });
      sent = await this.#waitForSendSignal({ timeoutMs: 1800, pollMs: 120, initialPromptLen: res?.promptLen || 0 });
      lastSendDebug = {
        ...lastSendDebug,
        stage: 'request_submit_result',
        acknowledged: !!sent
      };
      await this.#emitProgress({ sendDebug: lastSendDebug });
    }

    if (res?.rect?.w > 0 && res?.rect?.h > 0) {
      this.#throwIfStopRequested();
      const cx = Math.round(res.rect.x + res.rect.w / 2);
      const cy = Math.round(res.rect.y + res.rect.h / 2);
      if (!sent) {
        lastSendDebug = {
          ...lastSendDebug,
          stage: 'click_button',
          click: { x: cx, y: cy },
          button: res?.button || lastSendDebug?.button || null
        };
        await this.#emitProgress({ sendDebug: lastSendDebug });
        await this.#clickAt(cx, cy);
        sent = await this.#waitForSendSignal({ timeoutMs: 2200, pollMs: 120, initialPromptLen: res?.promptLen || 0 });
        lastSendDebug = {
          ...lastSendDebug,
          stage: 'click_result',
          acknowledged: !!sent
        };
        await this.#emitProgress({ sendDebug: lastSendDebug });
      }
    }

    if (!sent && !res?.fallbackEnter) {
      this.#throwIfStopRequested();
      const submitAttempt = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const disabled = (n) => !!n.disabled || String(n.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const score = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let prompt = null;
        let best = -Infinity;
        for (const n of uniq) {
          if (!editable(n)) continue;
          const s = score(n);
          if (s > best) {
            best = s;
            prompt = n;
          }
        }
        prompt = prompt || document.activeElement;
        const form = prompt?.closest?.('form') || null;
        if (form && typeof form.requestSubmit === 'function') {
          const submitBtn = Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n));
          if (submitBtn) {
            form.requestSubmit(submitBtn);
            return true;
          }
        }
        const submitBtn = form
          ? Array.from(form.querySelectorAll(${sendSel})).find((n) => visible(n) && !disabled(n))
          : document.querySelector(${sendSel});
        if (submitBtn) {
          submitBtn.click();
          return true;
        }
        return false;
      })()`);
      lastSendDebug = {
        ...lastSendDebug,
        stage: 'secondary_submit',
        submitted: !!submitAttempt
      };
      await this.#emitProgress({ sendDebug: lastSendDebug });
      sent = await this.#waitForSendSignal({ timeoutMs: 1400, pollMs: 120, initialPromptLen: res?.promptLen || 0 });
      lastSendDebug = {
        ...lastSendDebug,
        stage: 'secondary_submit_result',
        acknowledged: !!sent
      };
      await this.#emitProgress({ sendDebug: lastSendDebug });
    }

    if (!sent) {
      const host = String(res?.host || '');
      const isMac = process.platform === 'darwin';
      const combos = [];
      if (host.includes('aistudio.google.com')) {
        combos.push(['Enter', ['alt']]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else if (host.includes('grok.com')) {
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', []]);
      } else {
        combos.push(['Enter', []]);
        combos.push(['Enter', [isMac ? 'meta' : 'control']]);
        combos.push(['Enter', ['alt']]);
      }

      await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const score = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const fallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const uniq = [];
        const seen = new Set();
        for (const n of [...promptCandidates, ...fallback]) {
          if (!n || seen.has(n)) continue;
          seen.add(n);
          uniq.push(n);
        }
        let prompt = null;
        let best = -Infinity;
        for (const n of uniq) {
          if (!editable(n)) continue;
          const s = score(n);
          if (s > best) {
            best = s;
            prompt = n;
          }
        }
        prompt?.focus?.();
        return !!prompt;
      })()`);
      for (const [key, modifiers] of combos) {
        this.#throwIfStopRequested();
        lastSendDebug = {
          ...lastSendDebug,
          stage: 'keypress',
          key,
          modifiers
        };
        await this.#emitProgress({ sendDebug: lastSendDebug });
        await sleep(jitter(25, 90));
        await this.#sendKey(key, { modifiers });
        sent = await this.#waitForSendSignal({ timeoutMs: 1500, pollMs: 120, initialPromptLen: res?.promptLen || 0 });
        lastSendDebug = {
          ...lastSendDebug,
          stage: 'keypress_result',
          key,
          modifiers,
          acknowledged: !!sent
        };
        await this.#emitProgress({ sendDebug: lastSendDebug });
        if (sent) break;
      }
    }

    if (!sent) {
      const err = new Error('send_not_triggered');
      err.data = { host: res?.host || null, sendDebug: lastSendDebug || null };
      throw err;
    }
  }

  async #attachFiles(files) {
    if (!files?.length) return;
    await this.#emitProgress({ phase: 'uploading_files' });
    const absFiles = files.map((p) => path.resolve(p));
    const expectedNames = absFiles.map((file) => path.basename(file));
    for (const f of absFiles) await fs.access(f);
    await this.#emitProgress({
      attachmentDebug: {
        stage: 'prepare',
        count: absFiles.length,
        files: expectedNames
      }
    });

    // Read files into base64 for Blob-based injection.
    const fileData = await Promise.all(absFiles.map(async (f) => {
      const buf = await fs.readFile(f);
      const name = path.basename(f);
      const ext = path.extname(f).toLowerCase();
      const mimeMap = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      return { name, mime, data: buf.toString('base64') };
    }));

    const attachOpen = await this.#openComposerAction({ intent: 'upload_files', timeoutMs: 10_000 });
    await this.#emitProgress({
      attachmentDebug: {
        stage: 'open_picker',
        source: attachOpen?.action || 'unknown',
        buttonLabel: clipText(attachOpen?.label || ''),
        reason: clipText(attachOpen?.reason || '', 120) || null
      }
    });
    await sleep(300);

    // Inject files as Blobs via DataTransfer — this creates real File objects that
    // React's synthetic event system accepts, unlike CDP setFileInputFiles which
    // creates filesystem-backed Files that ChatGPT's handlers reject.
    const injected = await this.#eval(`(async () => {
      const fileData = ${JSON.stringify(fileData)};
      const dt = new DataTransfer();
      for (const { name, mime, data } of fileData) {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        dt.items.add(new File([bytes], name, { type: mime, lastModified: Date.now() }));
      }
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editable = (n) => {
        if (!n) return false;
        if (!visible(n)) return false;
        if (n.matches('textarea')) return !n.disabled && !n.readOnly;
        if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
        return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
      };
      const scorePrompt = (n) => {
        const r = n.getBoundingClientRect();
        const label = [
          n.getAttribute('aria-label') || '',
          n.getAttribute('placeholder') || '',
          n.getAttribute('name') || '',
          n.getAttribute('id') || '',
          n.getAttribute('data-testid') || ''
        ].join(' ').toLowerCase();
        let s = 0;
        if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
        if (n.matches('textarea')) s += 50;
        if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
        if (n.getAttribute('role') === 'textbox') s += 25;
        if (r.width >= 260 && r.height >= 26) s += 20;
        s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
        s += Math.max(0, r.y / 8);
        return s;
      };
      const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
      const promptFallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
      const promptPool = [];
      const seenPrompt = new Set();
      for (const n of [...promptCandidates, ...promptFallback]) {
        if (!n || seenPrompt.has(n)) continue;
        seenPrompt.add(n);
        promptPool.push(n);
      }
      let prompt = null;
      let bestPrompt = -Infinity;
      for (const n of promptPool) {
        if (!editable(n)) continue;
        const s = scorePrompt(n);
        if (s > bestPrompt) {
          bestPrompt = s;
          prompt = n;
        }
      }
      const composerRoot =
        prompt?.closest('form') ||
        prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
        prompt?.closest('main') ||
        document.body;
      const localInputs = Array.from((composerRoot || document).querySelectorAll('input[type="file"]'));
      const inputs = localInputs.length ? localInputs : Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs[inputs.length - 1];
      if (!input) return { ok: false, error: 'no_file_input' };
      // Use Object.defineProperty to set files (direct assignment blocked on some browsers)
      try {
        const nativeFilesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
        if (nativeFilesSetter) {
          nativeFilesSetter.call(input, dt.files);
        } else {
          input.files = dt.files;
        }
      } catch {
        input.files = dt.files;
      }
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      return {
        ok: true,
        count: dt.files.length,
        inputSource: localInputs.length ? 'composer' : 'global',
        localInputCount: localInputs.length,
        totalInputCount: inputs.length
      };
    })()`);
    await this.#emitProgress({
      attachmentDebug: {
        stage: 'inject_files',
        ok: !!injected?.ok,
        inputSource: injected?.inputSource || (injected?.ok ? 'unknown' : 'none'),
        localInputCount: Number.isFinite(injected?.localInputCount) ? injected.localInputCount : null,
        totalInputCount: Number.isFinite(injected?.totalInputCount) ? injected.totalInputCount : null,
        injectedCount: Number.isFinite(injected?.count) ? injected.count : null,
        fallbackToCdp: !injected?.ok
      }
    });

    // Fallback to CDP setFileInputFiles if Blob injection didn't find an input
    if (!injected?.ok) {
      await this.page.setFileInputFiles(absFiles);
      await this.#emitProgress({
        attachmentDebug: {
          stage: 'inject_files',
          ok: true,
          inputSource: 'cdp_fallback',
          localInputCount: null,
          totalInputCount: null,
          injectedCount: absFiles.length,
          fallbackToCdp: true
        }
      });
    }

    // Wait for file upload to complete or detect/dismiss error dialogs.
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const expectedNamesJson = JSON.stringify(expectedNames);
    const deadline = Date.now() + 30_000;
    let lastStatus = null;
    let lastUploadSig = null;
    while (Date.now() < deadline) {
      this.#throwIfStopRequested();
      await sleep(500);
      const status = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const editable = (n) => {
          if (!n) return false;
          if (!visible(n)) return false;
          if (n.matches('textarea')) return !n.disabled && !n.readOnly;
          if (n.matches('input')) return !n.disabled && !n.readOnly && !/password|search|email|url|number|tel/i.test(String(n.type || 'text'));
          return !!n.isContentEditable || n.getAttribute('contenteditable') === 'true' || n.getAttribute('role') === 'textbox';
        };
        const scorePrompt = (n) => {
          const r = n.getBoundingClientRect();
          const label = [
            n.getAttribute('aria-label') || '',
            n.getAttribute('placeholder') || '',
            n.getAttribute('name') || '',
            n.getAttribute('id') || '',
            n.getAttribute('data-testid') || ''
          ].join(' ').toLowerCase();
          let s = 0;
          if (/prompt|message|ask|chat|query|input/.test(label)) s += 80;
          if (n.matches('textarea')) s += 50;
          if (n.isContentEditable || n.getAttribute('contenteditable') === 'true') s += 35;
          if (n.getAttribute('role') === 'textbox') s += 25;
          if (r.width >= 260 && r.height >= 26) s += 20;
          s += Math.min(180, Math.max(0, (r.width * r.height) / 2500));
          s += Math.max(0, r.y / 8);
          return s;
        };
        const promptCandidates = Array.from(document.querySelectorAll(${JSON.stringify(this.selectors.promptTextarea)}));
        const promptFallback = Array.from(document.querySelectorAll('main textarea, main [role=\"textbox\"], main [contenteditable=\"true\"], textarea, [role=\"textbox\"], [contenteditable=\"true\"]'));
        const promptPool = [];
        const seenPrompt = new Set();
        for (const n of [...promptCandidates, ...promptFallback]) {
          if (!n || seenPrompt.has(n)) continue;
          seenPrompt.add(n);
          promptPool.push(n);
        }
        let prompt = null;
        let bestPrompt = -Infinity;
        for (const n of promptPool) {
          if (!editable(n)) continue;
          const s = scorePrompt(n);
          if (s > bestPrompt) {
            bestPrompt = s;
            prompt = n;
          }
        }
        const composerRoot =
          prompt?.closest('form') ||
          prompt?.closest('[data-testid*=\"composer\" i], [data-testid*=\"prompt\" i], [data-testid*=\"chat-input\" i], [aria-label*=\"message\" i], [aria-label*=\"prompt\" i]') ||
          prompt?.closest('main') ||
          document.body;

        // Dismiss "already uploaded" or other error dialogs.
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [data-testid*="modal"]');
        const dialogText = (dialog?.innerText || '').trim();
        const dialogBtn = Array.from((dialog || document).querySelectorAll('button, [role="button"]')).find(b => {
          const txt = (b.textContent || '').trim().toLowerCase();
          return txt === 'ok' || txt === 'dismiss' || txt === 'got it';
        });
        if (dialog && dialogBtn) {
          dialogBtn.click();
          return { dismissed: true, dialogText, pending: false, pendingText: '', chipCount: 0, done: false };
        }

        const root = composerRoot || document;
        const send = Array.from(root.querySelectorAll(${sendSel})).find(visible) || Array.from(document.querySelectorAll(${sendSel})).find(visible);
        const sendReady = send ? !send.disabled : false;
        const expectedNames = ${expectedNamesJson};
        const attachmentNodes = Array.from(root.querySelectorAll('[data-testid*="attachment" i], [data-testid*="file" i], [data-testid*="upload" i], [role="progressbar"], progress'));
        const attachmentControlNodes = Array.from(root.querySelectorAll(
          '[aria-label*="remove" i], [aria-label*="delete" i], [data-testid*="attachment" i] button, [data-testid*="file" i] button'
        )).filter(visible);
        const liveNodes = Array.from(root.querySelectorAll('[role="status"], [aria-live], [data-testid*="upload" i], [aria-label*="upload" i], [class*="upload" i], [class*="progress" i]'));
        const attachmentText = attachmentNodes
          .map((n) => (n?.innerText || n?.textContent || '').trim())
          .filter(Boolean)
          .join(' ');
        const pendingText = [...attachmentNodes, ...liveNodes]
          .map((n) => (n?.innerText || n?.textContent || '').trim())
          .filter(Boolean)
          .join(' ');
        const pending = /upload|processing|analyz|pending|scanning|\b\d{1,3}%\b/i.test(pendingText);
        const errorText = /already uploaded|upload failed|failed to upload|couldn't upload|unsupported|too large|too many files/i.test(pendingText) ? pendingText : '';
        const chipCount = attachmentNodes.length;
        const attachmentControlCount = attachmentControlNodes.length;
        const matchedNames = expectedNames.filter((name) => attachmentText.includes(name));
        const done = !pending && (
          matchedNames.length >= expectedNames.length ||
          attachmentControlCount >= expectedNames.length
        );
        return { dismissed: false, done, pending, pendingText, dialogText, chipCount, attachmentControlCount, errorText, matchedNames };
      })()`);
      lastStatus = status;
      const uploadSig = JSON.stringify({
        dismissed: !!status?.dismissed,
        done: !!status?.done,
        pending: !!status?.pending,
        pendingText: clipText(status?.pendingText || '', 160),
        dialogText: clipText(status?.dialogText || '', 160),
        chipCount: Number.isFinite(status?.chipCount) ? status.chipCount : null,
        attachmentControlCount: Number.isFinite(status?.attachmentControlCount) ? status.attachmentControlCount : null,
        errorText: clipText(status?.errorText || '', 160),
        matchedNames: Array.isArray(status?.matchedNames) ? status.matchedNames : []
      });
      if (uploadSig !== lastUploadSig) {
        lastUploadSig = uploadSig;
        await this.#emitProgress({
          attachmentDebug: {
            stage: 'wait_upload',
            dismissed: !!status?.dismissed,
            done: !!status?.done,
            pending: !!status?.pending,
            pendingText: clipText(status?.pendingText || '', 160) || null,
            dialogText: clipText(status?.dialogText || '', 160) || null,
            chipCount: Number.isFinite(status?.chipCount) ? status.chipCount : null,
            attachmentControlCount: Number.isFinite(status?.attachmentControlCount) ? status.attachmentControlCount : null,
            errorText: clipText(status?.errorText || '', 160) || null,
            matchedNames: Array.isArray(status?.matchedNames) ? status.matchedNames : []
          }
        });
      }
      if (status?.dismissed) {
        await this.#eval(`(() => {
          const closeBtn = document.querySelector('[aria-label*="Remove" i], [aria-label*="Delete" i], [data-testid*="attachment"] [role="button"], [data-testid*="file"] button');
          if (closeBtn) closeBtn.click();
        })()`);
        await sleep(300);
        const err = new Error('attachment_upload_failed');
        err.data = { reason: 'dialog', detail: clipText(status?.dialogText || '', 160) || null };
        throw err;
      }
      if (status?.errorText) {
        const err = new Error('attachment_upload_failed');
        err.data = { reason: 'upload_error', detail: clipText(status.errorText, 160) };
        throw err;
      }
      if (status?.done) {
        await this.#emitProgress({
          attachmentDebug: {
            stage: 'upload_done',
            pending: false,
            chipCount: Number.isFinite(status?.chipCount) ? status.chipCount : null,
            attachmentControlCount: Number.isFinite(status?.attachmentControlCount) ? status.attachmentControlCount : null,
            pendingText: clipText(status?.pendingText || '', 160) || null,
            matchedNames: Array.isArray(status?.matchedNames) ? status.matchedNames : []
          }
        });
        return;
      }
    }
    const err = new Error('attachment_upload_stalled');
    err.data = {
      pending: !!lastStatus?.pending,
      pendingText: clipText(lastStatus?.pendingText || '', 160) || null,
      chipCount: Number.isFinite(lastStatus?.chipCount) ? lastStatus.chipCount : null,
      attachmentControlCount: Number.isFinite(lastStatus?.attachmentControlCount) ? lastStatus.attachmentControlCount : null,
      matchedNames: Array.isArray(lastStatus?.matchedNames) ? lastStatus.matchedNames : []
    };
    throw err;
  }

  async #waitForAssistantStable({
    timeoutMs = 5 * 60_000,
    stableMs = 1500,
    pollMs = 400,
    preSendCount = 0,
    preSendText = '',
    preSendPageText = '',
    minimumTimeoutMs = 0,
    minimumStableMs = 0,
    extraThinkingPattern = '',
    imageGeneration = false
  } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_response', blocked: false, blockedKind: null, blockedTitle: null });
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const extraThinkingSource = JSON.stringify(String(extraThinkingPattern || '').trim());
    const imageGenerationSource = imageGeneration ? 'true' : 'false';
    const effectiveTimeoutMs = Math.max(
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 0,
      Number.isFinite(Number(minimumTimeoutMs)) && Number(minimumTimeoutMs) > 0 ? Math.floor(Number(minimumTimeoutMs)) : 0,
      1
    );
    const start = Date.now();
    let last = '';
    let lastChange = Date.now();
    let newResponseSeen = false;
    let stopGoneAt = null;
    let continueClicks = 0;
    let generationObserved = false;
    let emittedConversationUrl = null;

    while (Date.now() - start < effectiveTimeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const extraThinkingRe = ${extraThinkingSource} ? new RegExp(${extraThinkingSource}, 'i') : null;
        const stop = !!document.querySelector(${stopSel});
        const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const sendEnabled = send ? !send.disabled : false;
        const sendFound = !!send;
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const fallbackMainText = ((document.querySelector('main') || document.body)?.innerText || '').trim();
        const txt = (lastNode?.innerText || fallbackMainText).trim();
        const imageRoot = lastNode || document.querySelector('main') || document.body;
        const currentUrl = window.location.href || '';
        const hasContinue = Array.from(document.querySelectorAll('button, a')).some(b => /continue generating/i.test((b.textContent||'').trim()));
        const hasRegenerate = Array.from(document.querySelectorAll('button, a')).some(b => /regenerate/i.test((b.textContent||'').trim()));
        const hasError = /something went wrong|try again|error/i.test(txt) && txt.length < 500;
        const isImagePlaceholder = ${IMAGE_PLACEHOLDER_RE}.test(txt);
        const imageVisuals = imageRoot
          ? Array.from(imageRoot.querySelectorAll('img, canvas')).filter((el) => {
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (style.visibility === 'hidden' || style.display === 'none') return false;
              return r.width >= 96 && r.height >= 96;
            })
          : [];
        const imageCandidateCount = imageVisuals.length;
        const hasThinkingLine = ${IMAGE_THINKING_LINE_RE}.test(txt);
        // Detect thinking state from UI chrome (banners, status elements), NOT from the
        // assistant response text — responses that mention "reasoning" or "thinking" must
        // not trigger this. Scan elements outside the assistant message nodes.
        const thinkingBanner = Array.from(document.querySelectorAll(
          '[class*="think"], [data-testid*="think"], [aria-label*="think"], [class*="research"], [data-testid*="research"], [aria-label*="research"], [class*="search"], [data-testid*="search"], [aria-label*="search"], [class*="source"], [data-testid*="source"], [aria-label*="source"], [class*="clarif"], [data-testid*="clarif"], [aria-label*="clarif"], .sr-only, [role="status"], [aria-live]'
        )).some(el => {
          if (lastNode && lastNode.contains(el)) return false;
          const text = (el.textContent || '').trim();
          if (!text) return false;
          if (/\bthinking\b|\bpro thinking\b|\bextended pro\b|\breasoning\b/i.test(text)) return true;
          if (extraThinkingRe && extraThinkingRe.test(text)) return true;
          return false;
        });
        const isThinking = thinkingBanner || isImagePlaceholder || (${imageGenerationSource} && imageCandidateCount === 0 && hasThinkingLine);
        return {
          stop,
          sendEnabled,
          sendFound,
          txt,
          count: nodes.length,
          usedFallback: !lastNode,
          hasError,
          hasContinue,
          hasRegenerate,
          isThinking,
          imageCandidateCount,
          pageText: fallbackMainText,
          currentUrl
        };
      })()`);

      const txt = String(snap?.txt || '');
      const pageText = String(snap?.pageText || '');
      const hasImageOutput = Number(snap?.imageCandidateCount || 0) > 0;
      const imagePlaceholder = IMAGE_PLACEHOLDER_RE.test(txt);
      const hasThinkingLine = IMAGE_THINKING_LINE_RE.test(txt);
      const thinking = !!snap?.isThinking || imagePlaceholder || (imageGeneration && !hasImageOutput && hasThinkingLine);
      const conversationUrl = extractConversationUrl(snap?.currentUrl || '');
      if (conversationUrl && conversationUrl !== emittedConversationUrl) {
        emittedConversationUrl = conversationUrl;
        await this.#emitProgress({ conversationUrl });
      }
      const assistantAdvanced = (snap?.count || 0) > preSendCount || ((snap?.count || 0) > 0 && txt !== preSendText);
      const pageChanged = pageText !== preSendPageText;
      if (txt !== last) {
        last = txt;
        lastChange = Date.now();
      }

      // Detect whether we've seen a NEW response (not pre-existing page content).
      // A new response is indicated by: more assistant nodes than before send,
      // or different text than the pre-send last message, or a stop button appearing.
      if (snap?.stop || thinking) generationObserved = true;

      if (!newResponseSeen) {
        if (assistantAdvanced || snap?.stop || thinking || (preSendCount === 0 && pageChanged)) {
          newResponseSeen = true;
          lastChange = Date.now(); // Reset stability timer for the new response
        }
      }

      // Treat as "generating" when: stop button visible and send not enabled,
      // thinking indicator detected, or stop button visible while send button missing.
      // A missing send button alone is NOT treated as generating — the selector may
      // simply not match the current UI. Only block completion when there's active
      // evidence of generation (stop button or thinking state).
      const generating = (!!snap?.stop && !snap?.sendEnabled) || thinking || (!!snap?.stop && !snap?.sendFound);
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(
        stableMs,
        Number.isFinite(Number(minimumStableMs)) && Number(minimumStableMs) > 0 ? Math.floor(Number(minimumStableMs)) : 0,
        txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs
      );
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      if (!snap?.stop && snap?.hasContinue && continueClicks < 3) {
        continueClicks += 1;
        await this.#eval(`(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => /continue generating/i.test((b.textContent||'').trim()));
          if (btn) btn.click();
        })()`);
        await sleep(250);
        continue;
      }

      const readyByNodes = (snap?.count || 0) > 0;
      const fallbackWaited = !!snap?.usedFallback && (Date.now() - start >= 2500);
      const fallbackStableLongEnough = txt.length > 0 && (Date.now() - lastChange >= Math.max(dynamicStableMs, 5000));
      const sendReady = snap?.sendEnabled || (!snap?.sendFound && !snap?.stop && !thinking);
      const fallbackReady = fallbackWaited && pageChanged && (generationObserved || snap?.hasError);
      const contentReady = readyByNodes || fallbackReady || hasImageOutput || snap?.hasError;
      const responseReady = snap?.hasError || (imageGeneration ? (hasImageOutput || (txt.length > 0 && !thinking)) : txt.length > 0);
      const done = newResponseSeen && (
        (!generating && stopGoneLongEnough && sendReady && stable && responseReady && contentReady) ||
        (!generating && !thinking && fallbackStableLongEnough && contentReady));
      if (done) {
        const extra = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const codes = Array.from(lastNode?.querySelectorAll('pre code') || []).map(c => {
            const cls = String(c.className || '');
            const lang = (cls.match(/language-([a-z0-9_-]+)/i) || [])[1] || null;
            return { language: lang, text: (c.innerText || '').trim() };
          }).filter(c => c.text);
          return { codeBlocks: codes };
        })()`);
        return { text: txt, codeBlocks: extra?.codeBlocks || [], meta: { count: snap?.count || 0, hasError: !!snap?.hasError } };
      }

      await sleep(pollMs);
    }

    const conversationUrl = await this.getUrl().catch(() => null);
    const err = new Error('timeout_waiting_for_response');
    err.data = { last, conversationUrl };
    throw err;
  }

  async query({
    prompt,
    attachments = [],
    timeoutMs = 10 * 60_000,
    onProgress = null,
    imageGeneration = false,
    modeIntent = null,
    modelIntent = null
  } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    const run = { kind: 'query', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    try {
      await this.ensureReady({ timeoutMs });
      const modeIntentActivation = await this.#applyModeIntent({ modeIntent, timeoutMs: Math.min(timeoutMs, 20_000) });
      const modeIntentProvenance = buildModeIntentProvenance({ activation: modeIntentActivation, modeIntent, stage: 'before_send' });
      if (modeIntentProvenance) {
        await this.#emitProgress({
          phase: 'mode_intent_confirmed',
          modeIntent: modeIntentProvenance.requestedIntent,
          modeIntentProvenance
        });
      }
      const modelIntentActivation = await this.#applyModelIntent({ modelIntent, timeoutMs: Math.min(timeoutMs, 20_000) });
      const modelIntentProvenance = buildModelIntentProvenance({ activation: modelIntentActivation, modelIntent, stage: 'before_prompt' });
      if (modelIntentProvenance) {
        await this.#emitProgress({
          phase: 'model_intent_confirmed',
          modelIntent: modelIntentProvenance.requestedIntent,
          modelIntentProvenance
        });
      }
      await this.#attachFiles(attachments);
      await this.#typePrompt(prompt);
      // Snapshot existing assistant messages before sending, so #waitForAssistantStable
      // can distinguish pre-existing responses from the new one.
      const assistantSel = JSON.stringify(this.selectors.assistantMessage);
      const preSend = await this.#eval(`(() => {
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const pageText = ((document.querySelector('main') || document.body)?.innerText || '').trim();
        return { count: nodes.length, lastText: (lastNode?.innerText || '').trim(), pageText };
      })()`);
      await this.#clickSend();
      return await this.#waitForAssistantStable({
        timeoutMs,
        preSendCount: preSend?.count || 0,
        preSendText: preSend?.lastText || '',
        preSendPageText: preSend?.pageText || '',
        imageGeneration
      });
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async #activateResearchMode({ timeoutMs = 20_000 } = {}) {
    await this.#emitProgress({ phase: 'activating_research_mode' });
    const menuSel = JSON.stringify(this.selectors.researchModeMenu || '');
    const activeSel = JSON.stringify(this.selectors.researchModeActive || '');
    const promptSel = JSON.stringify(this.selectors.promptTextarea || '');
    const start = Date.now();
    const trigger = await this.#openComposerAction({ intent: 'deep_research', timeoutMs: Math.min(timeoutMs, 10_000) });
    const clickedAt = trigger && ['click_item', 'click_button', 'click_legacy_button'].includes(trigger.action)
      ? Date.now()
      : 0;
    let last = null;
    let lastAction = trigger?.action || 'none';

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const clickedAt = ${Math.max(0, clickedAt)};
        ${HOST_DOM_COLLECTION_HELPERS_JS}
        const labelOf = (n) =>
          [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('title') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const explicitActiveNodes = uniq(queryAll(${activeSel})).filter(visible);
        if (explicitActiveNodes.length) {
          return { active: true, action: 'none', reason: 'active_selector_visible', label: labelOf(explicitActiveNodes[0]) || null };
        }
        const activeNodes = uniq(Array.from(document.querySelectorAll('[aria-pressed="true"], [aria-checked="true"], [data-state="active"], [data-state="on"], [aria-selected="true"]')))
          .filter((n) => visible(n) && /deep research|research/i.test(labelOf(n)));
        if (activeNodes.length) {
          return { active: true, action: 'none', reason: 'generic_active_research_state', label: labelOf(activeNodes[0]) || 'research' };
        }

        const menuRoots = uniq([
          ...queryAll(${menuSel}),
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal]'))
        ]).filter(visible);
        const composerNodes = uniq([
          ...queryAll(${promptSel}),
          ...Array.from(document.querySelectorAll('main textarea, main [role="textbox"], main [contenteditable="true"], textarea, [role="textbox"], [contenteditable="true"]'))
        ]).filter(visible);
        const composerRoot =
          composerNodes[0]?.closest('form') ||
          composerNodes[0]?.closest('[data-testid*="composer" i], [data-testid*="prompt" i], [data-testid*="chat-input" i], [aria-label*="message" i], [aria-label*="prompt" i]') ||
          composerNodes[0]?.closest('main') ||
          document.body;
        const insideMenu = (node) => menuRoots.some((root) => root === node || root.contains(node));
        const composerHintNodes = uniq(Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], [aria-label], [title], [data-testid]')))
          .filter((n) => visible(n) && !insideMenu(n));
        const composerHints = composerHintNodes
          .map((n) => labelOf(n))
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 12);
        const promptHints = composerNodes
          .map((n) => [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('placeholder') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.getAttribute?.('title') || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 4);
        const composerText = String(composerRoot?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        const menuText = menuRoots
          .map((root) => String(root?.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 240);
        const dialog = uniq(Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="modal"], [data-radix-dialog-content]'))).find(visible) || null;
        const dialogText = String(dialog?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        if (clickedAt > 0 && composerHints.some((label) => /deep research/.test(label))) {
          return {
            active: true,
            action: 'none',
            reason: 'composer_hint_research_state',
            label: composerHints.find((label) => /deep research/.test(label)) || null,
            menuOpen: menuRoots.length > 0,
            menuText,
            dialogText,
            composerText,
            composerHints,
            promptHints
          };
        }
        if (clickedAt > 0 && promptHints.some((label) => /deep research|research/.test(label))) {
          return {
            active: true,
            action: 'none',
            reason: 'prompt_hint_research_state',
            label: promptHints.find((label) => /deep research|research/.test(label)) || null,
            menuOpen: menuRoots.length > 0,
            menuText,
            dialogText,
            composerText,
            composerHints,
            promptHints
          };
        }
        if (clickedAt > 0 && !menuRoots.length && composerNodes.length) {
          return {
            active: true,
            action: 'none',
            reason: 'latched_after_click',
            label: null,
            menuOpen: false,
            menuText,
            dialogText,
            composerText,
            composerHints,
            promptHints
          };
        }
        return {
          active: false,
          action: 'none',
          reason: 'research_activation_pending',
          menuOpen: menuRoots.length > 0,
          menuText,
          dialogText,
          composerText,
          composerHints,
          promptHints
        };
      })()`);
      last = snap;
      if (snap?.active) return snap;
      await sleep(250);
    }

    const err = new Error('research_mode_activation_failed');
    err.data = {
      reason: clipText(
        trigger?.reason === 'research_controls_not_found'
          ? trigger.reason
          : last?.reason || last?.label || trigger?.reason || 'research_activation_timeout',
        160
      ) || 'research_activation_timeout',
      state: last || null,
      trigger: trigger || null,
      lastAction
    };
    throw err;
  }

  #ensureResearchDownloadPromise({ downloadPromise = null, timeoutMs = 15_000, outDir } = {}) {
    if (downloadPromise || typeof this.page?.waitForDownload !== 'function') return downloadPromise || null;
    return this.page.waitForDownload({
      timeoutMs: Math.max(3_000, Math.min(20_000, timeoutMs)),
      outDir
    }).catch(() => null);
  }

  async #awaitImmediateResearchDownload(downloadPromise, { waitMs = 1_000 } = {}) {
    if (!downloadPromise) return null;
    return await Promise.race([
      downloadPromise,
      sleep(Math.max(1, Number(waitMs) || 0)).then(() => null)
    ]);
  }

  async #exportResearchMarkdown({ outDir, timeoutMs = 15_000, maxFiles = 6 } = {}) {
    await this.#emitProgress({ phase: 'exporting_output' });
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const buttonSel = JSON.stringify(this.selectors.researchExportButton || '');
    const menuSel = JSON.stringify(this.selectors.researchExportMenu || '');
    const optionSel = JSON.stringify(this.selectors.researchExportMarkdownOption || '');
    const start = Date.now();
    let last = null;
    let downloadPromise = null;
    let downloadedFile = null;
    let reportOpenedAt = 0;

    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const reportOpenedAt = ${Math.max(0, reportOpenedAt)};
        ${HOST_DOM_COLLECTION_HELPERS_JS}
        const labelOf = (n) =>
          [
            n?.getAttribute?.('aria-label') || '',
            n?.getAttribute?.('title') || '',
            n?.getAttribute?.('data-testid') || '',
            n?.getAttribute?.('download') || '',
            n?.textContent || ''
          ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
        const assistantNodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastAssistant = assistantNodes[assistantNodes.length - 1];
        const markdownLink = Array.from(lastAssistant?.querySelectorAll('a[href], a[download]') || []).find((n) => {
          const label = labelOf(n);
          const href = String(n.getAttribute('href') || n.href || '').toLowerCase();
          const download = String(n.getAttribute('download') || '').trim();
          const testId = String(n.getAttribute('data-testid') || '').trim().toLowerCase();
          const exportHint = !!download || /export|download|attachment|report/.test(label) || /export|download|attachment|report/.test(testId);
          return exportHint && /markdown|\\.md(?:$|[?#])/i.test(label + ' ' + href + ' ' + download + ' ' + testId);
        });
        if (markdownLink) {
          return { ready: true, action: 'none', reason: 'markdown_link_present', label: labelOf(markdownLink) || 'markdown' };
        }

        const rectOf = (n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };

        const menuRoots = uniq([
          ...queryAll(${menuSel}),
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal]'))
        ]).filter(visible);
        if (reportOpenedAt > 0 && Date.now() - reportOpenedAt < 1_500) {
          return {
            ready: false,
            action: 'none',
            reason: 'waiting_for_report_open',
            menuOpen: menuRoots.length > 0
          };
        }

        const assistantButtons = Array.from(lastAssistant?.querySelectorAll('button, [role="button"], a[href], a[download]') || []);
        const optionPool = uniq([
          ...queryAll(${optionSel}),
          ...menuRoots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a[href], a[download]'))),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a[href], a[download]'))
        ]);
        const markdownOption = optionPool
          .map((n) => {
            const label = labelOf(n);
            let score = -1;
            if (visible(n) && /markdown|\\.md/.test(label) && !/copy|word|pdf/.test(label)) {
              score = /export to markdown/.test(label) ? 150 : /markdown/.test(label) ? 120 : 90;
              if (menuRoots.some((root) => root === n || root.contains(n))) score += 20;
            }
            return { node: n, label, score };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (markdownOption) {
          return {
            ready: false,
            action: 'pointer_markdown',
            reason: 'clicked_markdown_option',
            label: markdownOption.label || null,
            menuOpen: menuRoots.length > 0,
            rect: rectOf(markdownOption.node)
          };
        }

        const buttonPool = uniq([
          ...queryAll(${buttonSel}),
          ...assistantButtons,
          ...Array.from(document.querySelectorAll('button, [role="button"], a[href], a[download]'))
        ]);
        const exportButton = buttonPool
          .map((n) => {
            const label = labelOf(n);
            let score = -1;
            if (visible(n) && /export|download/.test(label) && !/copy|pdf|word|markdown/.test(label)) {
              score = /export/.test(label) ? 140 : /download/.test(label) ? 120 : 90;
              if (String(n.getAttribute('aria-label') || '').trim().toLowerCase() === 'export') score += 60;
              if (String(n.getAttribute('aria-haspopup') || '').trim().toLowerCase() === 'menu') score += 40;
              if (n.hasAttribute('aria-expanded')) score += 20;
              if (lastAssistant && (lastAssistant === n || lastAssistant.contains(n))) score += 30;
            }
            return { node: n, label, score };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (exportButton) {
          return {
            ready: false,
            action: 'pointer_export',
            reason: 'clicked_export_trigger',
            label: exportButton.label || null,
            menuOpen: menuRoots.length > 0,
            rect: rectOf(exportButton.node)
          };
        }

        const composerRoots = Array.from(document.querySelectorAll('form'));
        const outsideComposer = (n) => !composerRoots.some((root) => root === n || root.contains(n));
        const reportPool = uniq([
          ...Array.from(document.querySelectorAll('[role="button"], button, [tabindex]')),
          ...assistantButtons
        ]);
        const reportLauncher = reportPool
          .map((n) => {
            const label = labelOf(n);
            let score = -1;
            if (visible(n) && outsideComposer(n)) {
              if (/research completed in/.test(label)) score = 220;
              else if (/\\bdeep research\\b/.test(label)) score = 160;
              else if (/citations|searches/.test(label) && /research/.test(label)) score = 120;
              if (score >= 0) {
                if (String(n.getAttribute('role') || '').trim().toLowerCase() === 'button') score += 20;
                if (String(n.tagName || '').trim().toLowerCase() === 'button') score += 10;
              }
            }
            return { node: n, label, score };
          })
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score)[0] || null;
        if (reportLauncher) {
          return {
            ready: false,
            action: 'pointer_open_report',
            reason: 'open_research_report',
            label: reportLauncher.label || null,
            menuOpen: menuRoots.length > 0,
            rect: rectOf(reportLauncher.node)
          };
        }

        return { ready: false, action: 'none', reason: 'export_controls_not_found', menuOpen: menuRoots.length > 0 };
      })()`);
      last = snap;
      if (snap?.ready) break;
      if ((snap?.action === 'pointer_markdown' || snap?.action === 'pointer_export' || snap?.action === 'pointer_open_report') && snap?.rect?.w > 0 && snap?.rect?.h > 0) {
        const cx = Math.round(snap.rect.x + Math.max(6, Math.min(snap.rect.w - 6, snap.rect.w / 2)));
        const cy = Math.round(snap.rect.y + Math.max(6, Math.min(snap.rect.h - 6, snap.rect.h / 2)));
        if (snap.action === 'pointer_markdown' && !downloadPromise && typeof this.page?.waitForDownload === 'function') {
          downloadPromise = this.#ensureResearchDownloadPromise({ downloadPromise, timeoutMs, outDir });
        }
        await this.#clickAt(cx, cy);
        if (snap.action === 'pointer_markdown') {
          const immediate = await this.#awaitImmediateResearchDownload(downloadPromise);
          downloadedFile = immediate || downloadedFile;
          if (immediate?.path) break;
        } else if (snap.action === 'pointer_open_report') {
          reportOpenedAt = Date.now();
          await sleep(900);
        } else {
          await sleep(500);
        }
        continue;
      }

      if (snap?.action === 'none') {
        const nested = await this.#evalDeepResearch(`(() => {
          const buttonSel = ${buttonSel};
          const menuSel = ${menuSel};
          const optionSel = ${optionSel};
          const d = document.querySelector('#root')?.contentDocument;
          if (!d) return { ready: false, action: 'none', reason: 'nested_doc_missing' };
          ${NESTED_DOM_COLLECTION_HELPERS_JS}
          const labelOf = (n) =>
            [
              n?.getAttribute?.('aria-label') || '',
              n?.getAttribute?.('title') || '',
              n?.getAttribute?.('data-testid') || '',
              n?.getAttribute?.('download') || '',
              n?.textContent || ''
            ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
          const clickNode = (n) => {
            try {
              n?.click?.();
              return true;
            } catch {
              return false;
            }
          };

          const menuRoots = uniq([
            ...queryAll(menuSel),
            ...Array.from(d.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal]'))
          ]).filter(visible);

          const optionPool = uniq([
            ...queryAll(optionSel),
            ...menuRoots.flatMap((root) => Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a[href], a[download]'))),
            ...Array.from(d.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a[href], a[download]'))
          ]);
          const markdownOption = optionPool
            .map((n) => {
              const label = labelOf(n);
              let score = -1;
              if (visible(n) && /markdown|\\.md/.test(label) && !/copy|word|pdf/.test(label)) {
                score = /export to markdown/.test(label) ? 150 : /markdown/.test(label) ? 120 : 90;
                if (menuRoots.some((root) => root === n || root.contains(n))) score += 20;
              }
              return { node: n, label, score };
            })
            .filter((item) => item.score >= 0)
            .sort((a, b) => b.score - a.score)[0] || null;
          if (markdownOption) {
            clickNode(markdownOption.node);
            return {
              ready: false,
              action: 'dom_markdown_click',
              reason: 'clicked_markdown_option',
              label: markdownOption.label || null
            };
          }

          const buttonPool = uniq([
            ...queryAll(buttonSel),
            ...Array.from(d.querySelectorAll('button, [role="button"], a[href], a[download]'))
          ]);
          const exportButton = buttonPool
            .map((n) => {
              const label = labelOf(n);
              let score = -1;
              if (visible(n) && /export|download/.test(label) && !/copy|pdf|word|markdown/.test(label)) {
                score = /export/.test(label) ? 140 : /download/.test(label) ? 120 : 90;
                if (String(n.getAttribute('aria-label') || '').trim().toLowerCase() === 'export') score += 60;
                if (String(n.getAttribute('aria-haspopup') || '').trim().toLowerCase() === 'menu') score += 40;
                if (n.hasAttribute('aria-expanded')) score += 20;
              }
              return { node: n, label, score };
            })
            .filter((item) => item.score >= 0)
            .sort((a, b) => b.score - a.score)[0] || null;
          if (exportButton) {
            clickNode(exportButton.node);
            return {
              ready: false,
              action: 'dom_export_click',
              reason: 'clicked_export_trigger',
              label: exportButton.label || null
            };
          }

          return {
            ready: false,
            action: 'none',
            reason: 'nested_export_controls_not_found',
            text: String(d.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
          };
        })()`).catch(() => null);
        if (nested?.action === 'dom_markdown_click') {
          last = nested;
          downloadPromise = this.#ensureResearchDownloadPromise({ downloadPromise, timeoutMs, outDir });
          const immediate = await this.#awaitImmediateResearchDownload(downloadPromise);
          downloadedFile = immediate || downloadedFile;
          if (immediate?.path) break;
          await sleep(500);
          continue;
        }
        if (nested?.action === 'dom_export_click') {
          last = nested;
          await sleep(500);
          continue;
        }
        if (nested) last = nested;
      }
      await sleep(300);
    }

    if (!downloadedFile?.path && downloadPromise) {
      try {
        downloadedFile = await Promise.race([
          downloadPromise,
          sleep(Math.max(250, timeoutMs - Math.max(0, Date.now() - start))).then(() => null)
        ]);
      } catch {
        downloadedFile = null;
      }
    }

    const domItems = await this.getLastAssistantDownloads({ maxFiles }).catch(() => []);
    const domFiles = await this.#saveDownloadItems({ items: domItems, outDir, linkMode: 'export' }).catch(() => []);
    const files = [];
    const seenPaths = new Set();
    for (const item of [downloadedFile, ...(Array.isArray(domFiles) ? domFiles : [])]) {
      const filePath = String(item?.path || '').trim();
      if (!filePath || seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);
      files.push(item);
    }
    const markdownFile = files.find((item) => /\.md$/i.test(String(item?.name || item?.path || '')) || /markdown/i.test(String(item?.mime || ''))) || null;
    return {
      state: last || null,
      files,
      exportedMarkdownPath: markdownFile?.path || null
    };
  }

  async research({ prompt, attachments = [], timeoutMs = 45 * 60_000, outDir = path.join(this.stateDir, 'downloads'), onProgress = null } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    const requestedTimeoutMs = Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.max(Math.floor(requestedTimeoutMs), 60 * 60_000)
      : 60 * 60_000;
    return await this.mutex.run(async () => {
      const run = { kind: 'research', requested: false, requestedAt: null, reason: null, onProgress };
      this.currentRun = run;
      let researchMeta = buildResearchMeta();
      try {
        await this.ensureReady({ timeoutMs: effectiveTimeoutMs });
        await this.#activateResearchMode({ timeoutMs: 30_000 });
        researchMeta = buildResearchMeta({
          activated: true,
          conversationUrl: await this.getUrl().catch(() => null)
        });
        await this.#emitProgress({ phase: 'activating_research_mode', researchMeta });
        await this.#attachFiles(attachments);
        await this.#typePrompt(prompt);
        const assistantSel = JSON.stringify(this.selectors.assistantMessage);
        const preSend = await this.#eval(`(() => {
          const nodes = Array.from(document.querySelectorAll(${assistantSel}));
          const lastNode = nodes[nodes.length - 1];
          const pageText = ((document.querySelector('main') || document.body)?.innerText || '').trim();
          return { count: nodes.length, lastText: (lastNode?.innerText || '').trim(), pageText };
        })()`);
        await this.#clickSend();
        const result = await this.#waitForAssistantStable({
          timeoutMs: effectiveTimeoutMs,
          preSendCount: preSend?.count || 0,
          preSendText: preSend?.lastText || '',
          preSendPageText: preSend?.pageText || '',
          minimumTimeoutMs: 60 * 60_000,
          minimumStableMs: 60_000,
          extraThinkingPattern: '\\bresearching\\b|\\bsearching(?: the web)?\\b|\\breading sources?\\b|\\bclarifying\\b|\\bgathering\\b'
        });
        const exported = await this.#exportResearchMarkdown({
          outDir,
          timeoutMs: 30_000,
          maxFiles: 8
        }).catch((error) => ({
          state: { reason: String(error?.message || 'export_failed') },
          files: [],
          exportedMarkdownPath: null
        }));
        return {
          ...result,
          research: {
            files: exported?.files || [],
            exportedMarkdownPath: exported?.exportedMarkdownPath || null,
            exportState: exported?.state || null
          },
          researchMeta
        };
      } catch (error) {
        if (String(error?.message || '') === 'research_mode_activation_failed') {
          researchMeta = buildResearchMeta({
            activated: false,
            error: error?.data?.reason ? String(error.data.reason) : 'research_mode_activation_failed',
            conversationUrl: await this.getUrl().catch(() => null),
            debug: {
              trigger: error?.data?.trigger || null,
              state: error?.data?.state || null,
              lastAction: error?.data?.lastAction || null
            }
          });
          await this.#emitProgress({ phase: 'activating_research_mode', researchMeta });
        }
        throw error;
      } finally {
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async send({ text, timeoutMs = 3 * 60_000, stopAfterSend = false, onProgress = null } = {}) {
    const prompt = String(text || '');
    if (!prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');

    return await this.mutex.run(async () => {
      const run = { kind: 'send', requested: false, requestedAt: null, reason: null, onProgress };
      this.currentRun = run;
      try {
        await this.ensureReady({ timeoutMs });
        await this.#typePrompt(prompt);
        await this.#clickSend();

        if (stopAfterSend) {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            this.#throwIfStopRequested();
            const clicked = await this.#clickVisibleStop();
            if (clicked) break;
            await sleep(120);
          }
        }

        return { ok: true };
      } finally {
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async getLastAssistantImages({ maxImages = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      const main = document.querySelector('main') || document.body;
      const visibleVisuals = (root) => {
        if (!root) return [];
        return Array.from(root.querySelectorAll('img, canvas'))
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ el, rect }) => {
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            return rect.width >= 96 && rect.height >= 96;
          })
          .sort((a, b) => (b.rect.y - a.rect.y) || ((b.rect.width * b.rect.height) - (a.rect.width * a.rect.height)))
          .map(({ el }) => el);
      };
      let visuals = visibleVisuals(last);
      if (!visuals.length && main && main !== last) visuals = visibleVisuals(main);
      if (!visuals.length) return [];
      const imgs = visuals.filter((el) => el.tagName === 'IMG');
      const canvases = visuals.filter((el) => el.tagName === 'CANVAS');
      const results = [];
      for (const img of imgs.slice(0, ${maxImages})) {
        const src = img.currentSrc || img.src || '';
        const alt = img.alt || '';
        if (!src) continue;
        if (src.startsWith('blob:') || src.startsWith('https://') || src.startsWith('http://')) {
          try {
            const r = await fetch(src);
            const b = await r.blob();
            if (b.size > 15 * 1024 * 1024) { results.push({ src, alt }); continue; }
            const dataUrl = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onerror = () => reject(new Error('file_reader_error'));
              fr.onload = () => resolve(String(fr.result || ''));
              fr.readAsDataURL(b);
            });
            results.push({ src, alt, dataUrl });
            continue;
          } catch {}
        }
        results.push({ src, alt });
      }

      for (let i = 0; i < canvases.length && results.length < ${maxImages}; i++) {
        const c = canvases[i];
        try {
          const dataUrl = c.toDataURL('image/png');
          if (dataUrl && dataUrl.startsWith('data:image/')) {
            results.push({ src: 'canvas:' + (i + 1), alt: 'canvas', dataUrl });
          }
        } catch {}
      }

      // Background-image urls (rare but possible)
      if (results.length < ${maxImages}) {
        const bgRoot = last || main;
        const bgEls = Array.from(bgRoot?.querySelectorAll('*') || []).filter(el => {
          const s = getComputedStyle(el);
          if (!s || !s.backgroundImage || !s.backgroundImage.includes('url(')) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 96 && r.height >= 96;
        }).slice(0, 50);
        for (const el of bgEls) {
          if (results.length >= ${maxImages}) break;
          const s = getComputedStyle(el).backgroundImage || '';
          const m = s.match(/url\\([\"']?([^\"')]+)[\"']?\\)/i);
          const src = m?.[1] || '';
          if (src && (src.startsWith('http://') || src.startsWith('https://'))) results.push({ src, alt: 'background-image' });
        }
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async downloadLastAssistantImages({ maxImages = 6, outDir = path.join(this.stateDir, 'downloads') } = {}) {
    const imgs = await this.getLastAssistantImages({ maxImages });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      let dataUrl = img.dataUrl || null;
      let mime = null;
      let buf = null;

      if (dataUrl && /^data:/i.test(dataUrl)) {
        const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && img.src && /^https?:\/\//i.test(img.src)) {
        const r = await fetch(img.src);
        if (!r.ok) continue;
        mime = r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const ext =
        mime?.includes('png') ? 'png' : mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' : mime?.includes('webp') ? 'webp' : 'bin';
      const name = `chatgpt-${Date.now()}-${String(i + 1).padStart(2, '0')}.${ext}`;
      const file = path.join(outDir, name);
      await fs.writeFile(file, buf);
      saved.push({ path: file, alt: img.alt || '', mime: mime || null, source: img.src || null });
    }

    return saved;
  }

  async getLastAssistantDownloads({ maxFiles = 6 } = {}) {
    const assistantSel = JSON.stringify(this.selectors.assistantMessage);
    const out = await this.#eval(`(async () => {
      const nodes = Array.from(document.querySelectorAll(${assistantSel}));
      const last = nodes[nodes.length - 1];
      if (!last) return [];
      const anchors = Array.from(last.querySelectorAll('a[href], a[download]'));
      const results = [];
      const seen = new Set();
      for (const a of anchors) {
        if (results.length >= ${maxFiles}) break;
        const href = String(a.href || a.getAttribute('href') || '').trim();
        const download = String(a.getAttribute('download') || '').trim();
        const text = String(a.textContent || '').trim();
        const title = String(a.getAttribute('title') || '').trim();
        const rawName = download || text || title || '';
        if (!href || seen.has(href)) continue;
        if (
          !/^blob:|^data:|^https?:/i.test(href) &&
          !/(download|export|attachment|file|csv|json|zip|pdf|doc|sheet|image)/i.test(rawName)
        ) {
          continue;
        }
        seen.add(href);
        const item = {
          href,
          name: rawName || null,
          label: text || null,
          title: title || null,
          testId: String(a.getAttribute('data-testid') || '').trim() || null,
          downloadAttr: !!download
        };
        if (/^blob:|^data:/i.test(href)) {
          try {
            const r = await fetch(href);
            const b = await r.blob();
            if (b.size <= 25 * 1024 * 1024) {
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onerror = () => reject(new Error('file_reader_error'));
                fr.onload = () => resolve(String(fr.result || ''));
                fr.readAsDataURL(b);
              });
              item.dataUrl = dataUrl;
            }
            item.mime = b.type || null;
            item.size = b.size || null;
          } catch {}
        }
        results.push(item);
      }
      return results;
    })()`);
    return Array.isArray(out) ? out : [];
  }

  async #saveDownloadItems({ items, outDir, linkMode = 'generic' } = {}) {
    const filtered = (Array.isArray(items) ? items : []).filter((item) => {
      if (String(linkMode || 'generic') !== 'export') return true;
      const hintText = [
        item?.name || '',
        item?.label || '',
        item?.title || '',
        item?.testId || ''
      ].join(' ').toLowerCase();
      if (item?.downloadAttr) return true;
      if (/^blob:|^data:/i.test(String(item?.href || ''))) return true;
      return /export|download|attachment|report/.test(hintText);
    });
    await fs.mkdir(outDir, { recursive: true });
    const saved = [];

    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      let mime = item.mime || null;
      let buf = null;

      if (item.dataUrl && /^data:/i.test(item.dataUrl)) {
        const m = String(item.dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
        if (m) {
          mime = mime || m[1];
          buf = Buffer.from(m[2], 'base64');
        }
      }

      if (!buf && item.href && /^https?:\/\//i.test(item.href)) {
        const r = await fetch(item.href);
        if (!r.ok) continue;
        mime = mime || r.headers.get('content-type') || 'application/octet-stream';
        buf = Buffer.from(await r.arrayBuffer());
      }

      if (!buf) continue;

      const nameHint = String(item.name || '').trim();
      const urlName = (() => {
        try {
          const u = new URL(String(item.href || ''));
          return path.basename(u.pathname || '');
        } catch {
          return '';
        }
      })();
      const extFromMime =
        mime?.includes('json') ? 'json' :
        mime?.includes('csv') ? 'csv' :
        mime?.includes('pdf') ? 'pdf' :
        mime?.includes('zip') ? 'zip' :
        mime?.includes('markdown') ? 'md' :
        mime?.includes('plain') ? 'txt' :
        mime?.includes('png') ? 'png' :
        mime?.includes('jpeg') || mime?.includes('jpg') ? 'jpg' :
        mime?.includes('webp') ? 'webp' :
        'bin';
      const baseName = (nameHint || urlName || `chatgpt-file-${Date.now()}-${String(i + 1).padStart(2, '0')}`).replace(/[\\/:*?"<>|]+/g, '-');
      const nameWithExt = path.extname(baseName) ? baseName : `${baseName}.${extFromMime}`;
      const parsed = path.parse(nameWithExt);
      let finalName = nameWithExt;
      for (let suffix = 1; suffix < 1000; suffix++) {
        try {
          await fs.access(path.join(outDir, finalName));
          finalName = `${parsed.name}-${suffix}${parsed.ext}`;
        } catch {
          break;
        }
      }
      const file = path.join(outDir, finalName);
      await fs.writeFile(file, buf);
      saved.push({ path: file, name: finalName, mime: mime || null, source: item.href || null });
    }

    return saved;
  }

  async #looksLikeResearchReport() {
    const snap = await this.#eval(`(() => {
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (n) =>
        [
          n?.getAttribute?.('aria-label') || '',
          n?.getAttribute?.('title') || '',
          n?.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      const mainText = String((document.querySelector('main') || document.body)?.innerText || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
      const hasResearchSummary = /research completed in/.test(mainText);
      const hasExportButton = Array.from(document.querySelectorAll('button, [role="button"]')).some((n) => {
        if (!visible(n)) return false;
        return /\\bexport\\b/.test(labelOf(n));
      });
      return { hasResearchSummary, hasExportButton };
    })()`).catch(() => null);
    if (snap?.hasResearchSummary && snap?.hasExportButton) return true;
    const nested = await this.#evalDeepResearch(`(() => {
      const d = document.querySelector('#root')?.contentDocument;
      if (!d) return { hasResearchSummary: false, hasExportButton: false };
      const visible = (n) => {
        if (!n) return false;
        const r = n.getBoundingClientRect();
        const style = d.defaultView?.getComputedStyle?.(n);
        return r.width > 0 && r.height > 0 && style && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelOf = (n) =>
        [
          n?.getAttribute?.('aria-label') || '',
          n?.getAttribute?.('title') || '',
          n?.textContent || ''
        ].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
      const mainText = String(d.body?.innerText || d.documentElement?.innerText || '')
        .replace(/\\s+/g, ' ')
        .trim()
        .toLowerCase();
      const hasResearchSummary = /research completed in/.test(mainText);
      const hasExportButton = Array.from(d.querySelectorAll('button, [role="button"]')).some((n) => {
        if (!visible(n)) return false;
        return /\\bexport\\b/.test(labelOf(n));
      });
      return { hasResearchSummary, hasExportButton };
    })()`).catch(() => null);
    return !!(nested?.hasResearchSummary && nested?.hasExportButton);
  }

  async exportResearchReport({ maxFiles = 6, outDir = path.join(this.stateDir, 'downloads'), timeoutMs = 15_000 } = {}) {
    return await this.#exportResearchMarkdown({ outDir, timeoutMs, maxFiles });
  }

  async downloadLastAssistantFiles({ maxFiles = 6, outDir = path.join(this.stateDir, 'downloads'), linkMode = 'generic' } = {}) {
    const items = await this.getLastAssistantDownloads({ maxFiles });
    const saved = await this.#saveDownloadItems({ items, outDir, linkMode });
    if (saved.length > 0) return saved;

    if (await this.#looksLikeResearchReport()) {
      const exported = await this.exportResearchReport({
        outDir,
        timeoutMs: 15_000,
        maxFiles
      }).catch(() => null);
      if (Array.isArray(exported?.files) && exported.files.length > 0) return exported.files;
    }

    return saved;
  }
}
