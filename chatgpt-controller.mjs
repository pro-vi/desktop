import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CHATGPT_MODEL_INTENTS, normalizeChatGptModeIntent, normalizeChatGptModelIntent } from './chatgpt-mode-intent.mjs';
import { locationFromConversationUrl, parseChatGptEntryTarget } from './chatgpt-location.mjs';
import { providerConversationIdFromOwnedLocation } from './conversation-identity.mjs';
import { evaluateChatGptAnchor } from './chatgpt-compatibility-resolver.mjs';
import {
  TRANSCRIPT_TURN_MAX_TEXT_CHARS,
  parseConversationCapture,
  projectLegacyConversationWindowText
} from './transcript-contract.mjs';
import {
  createConversationArtifactDescriptor,
  emptyPartialConversationArtifactInventory,
  parseConversationArtifactInventory
} from './conversation-artifact-contract.mjs';
import {
  CHATGPT_ANY_MODE_PATTERN,
  CHATGPT_ANY_MODEL_PATTERN,
  CHATGPT_MODE_INTENT_META,
  CHATGPT_MODE_PICKER_PRIMITIVES_JS,
  CHATGPT_MODEL_INTENT_META,
  CHATGPT_MODEL_PICKER_PRIMITIVES_JS,
  modeIntentForLabel,
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

function extractChatGptTranscriptMessageText(node) {
  if (!node || typeof node !== 'object') return '';
  const childNodes = node.childNodes;
  if (!childNodes || typeof childNodes.length !== 'number') {
    const innerText = typeof node.innerText === 'string' ? node.innerText : '';
    const textContent = typeof node.textContent === 'string' ? node.textContent : '';
    return innerText || textContent;
  }
  const blockTags = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
    'TFOOT', 'THEAD', 'TR', 'UL'
  ]);
  const skippedTags = new Set(['BUTTON', 'CANVAS', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'SVG', 'TEMPLATE']);
  const chunks = [];
  const append = (value) => {
    const text = String(value || '').replace(/\r\n?/g, '\n');
    if (text) chunks.push(text);
  };
  const boundary = () => {
    const last = chunks[chunks.length - 1] || '';
    if (!last.endsWith('\n')) chunks.push('\n');
  };
  const walk = (current, preserveWhitespace = false) => {
    if (!current) return;
    if (current.nodeType === 3) {
      const value = String(current.nodeValue || '');
      append(preserveWhitespace ? value : value.replace(/[\t\n\f\r ]+/g, ' '));
      return;
    }
    if (current.nodeType !== 1 && current !== node) return;
    const tagName = String(current.tagName || '').toUpperCase();
    if (
      skippedTags.has(tagName) ||
      current.hidden === true ||
      current.getAttribute?.('aria-hidden') === 'true'
    ) return;
    try {
      const style = typeof getComputedStyle === 'function' ? getComputedStyle(current) : null;
      if (
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.visibility === 'collapse' ||
        style?.contentVisibility === 'hidden'
      ) return;
    } catch {}
    if (tagName === 'BR') {
      boundary();
      return;
    }
    if (tagName === 'IMG') {
      // Image alt attributes are not rendered transcript text and may change as
      // virtualized image grids hydrate. Image retrieval has its own controller path.
      return;
    }
    const isBlock = blockTags.has(tagName);
    if (isBlock) boundary();
    const preserve = preserveWhitespace || tagName === 'PRE';
    for (const child of Array.from(current.childNodes || [])) walk(child, preserve);
    if (tagName === 'TD' || tagName === 'TH') append('\t');
    if (isBlock) boundary();
  };
  walk(node);
  return chunks.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

const IMAGE_PLACEHOLDER_RE = /(^|(?:\\n)|\n)\s*(?:(?:creating|generating)\s+images?|(?:creating|generating)\b[^\n]{0,120}\bimages?)\b/i;
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

function inferModeIntentFromFooterText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const footerIndex = Math.max(
    lower.lastIndexOf('chatgpt can make mistakes'),
    lower.lastIndexOf('check important info')
  );
  const start = footerIndex >= 0 ? Math.max(0, footerIndex - 320) : Math.max(0, text.length - 480);
  const end = footerIndex >= 0 ? Math.min(text.length, footerIndex + 220) : text.length;
  const scope = text.slice(start, end);
  const candidates = [];
  const modeLabelPattern = /\b(?:extended\s*pro|pro\s*extended|thinking|reasoning|medium|instant|fast)\b|\bpro\b(?!\s+standard\b)/gi;
  for (const match of scope.matchAll(modeLabelPattern)) {
    const label = match[0] || '';
    const intent = modeIntentForLabel(label);
    if (!intent) continue;
    candidates.push({
      intent,
      label,
      index: Number.isFinite(match.index) ? match.index : 0
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.index - a.index);
  const best = candidates[0];
  return {
    intent: best.intent,
    label: best.label,
    source: footerIndex >= 0 ? 'page_footer' : 'page_tail'
  };
}

function inferActualModeIntent({ text = '', pageText = '' } = {}) {
  return inferModeIntentFromFooterText(pageText) || inferModeIntentFromFooterText(text);
}

function buildModeIntentDowngradeError({ requestedIntent, modeUsed, actualMode } = {}) {
  const err = new Error('mode_intent_activation_failed');
  err.data = {
    reason: 'mode_intent_downgrade_detected',
    targetIntent: requestedIntent || null,
    state: {
      activeIntent: modeUsed || null,
      actualMode: actualMode || null
    }
  };
  return err;
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
  constructor({
    page,
    selectors,
    onBlocked,
    onUnblocked,
    stateDir,
    vendorId = null,
    vendorName = null,
    uiContract = null,
    onCompatibilityObservation = null,
    compatibilityBackend = 'electron',
    captureHostTimeoutMs = 330_000
  }) {
    this.page = page;
    this.selectors = selectors;
    this.vendorId = vendorId;
    this.vendorName = vendorName;
    this.uiContract = uiContract;
    this.onCompatibilityObservation =
      typeof onCompatibilityObservation === 'function' ? onCompatibilityObservation : null;
    this.compatibilityBackend = compatibilityBackend === 'chrome-cdp' ? 'chrome-cdp' : 'electron';
    const parsedCaptureHostTimeoutMs = Math.floor(Number(captureHostTimeoutMs));
    this.captureHostTimeoutMs = Number.isSafeInteger(parsedCaptureHostTimeoutMs) &&
      parsedCaptureHostTimeoutMs >= 1 && parsedCaptureHostTimeoutMs <= 10 * 60_000
      ? parsedCaptureHostTimeoutMs
      : 330_000;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.stateDir = stateDir;
    this.mutex = new Mutex();
    this.exclusiveQuarantine = null;
    this.blocked = false;
    this.blockedKind = null;
    this.serverId = null;
    this.mouse = { x: 30, y: 30 };
    this.currentRun = null;
    this.compatibilityTerminalAttempts = new Map();
  }

  async recordCompatibilityObservation(observation) {
    if (
      this.vendorId !== 'chatgpt' ||
      this.uiContract?.kind !== 'chatgpt' ||
      !this.onCompatibilityObservation
    ) {
      return { accepted: false, reason: 'not-chatgpt' };
    }
    try {
      const result = await this.onCompatibilityObservation(observation);
      return { accepted: result?.accepted !== false, result: result || null };
    } catch {
      return { accepted: false, reason: 'observation-sink-failed' };
    }
  }

  async finalizeCompatibilityTerminal(capabilityId, {
    attemptId = null,
    mode = null,
    status = 'satisfied',
    artifactCount = 0
  } = {}) {
    const pending = this.compatibilityTerminalAttempts.get(capabilityId);
    if (!pending || (attemptId && pending.attemptId !== attemptId) || (mode && pending.mode !== mode)) {
      return { accepted: false, reason: 'stale-terminal' };
    }
    const result = await this.recordCompatibilityObservation({
      schemaVersion: 1,
      observationId: crypto.randomUUID(),
      attemptId: pending.attemptId,
      observedAt: Date.now(),
      contractHash: this.uiContract.profile.contractHash,
      vendorId: 'chatgpt',
      backend: this.compatibilityBackend,
      capabilityId,
      kind: 'terminal',
      mode: pending.mode,
      status,
      artifactCount
    });
    if (result.accepted) this.compatibilityTerminalAttempts.delete(capabilityId);
    return result;
  }

  async runCompatibilityCapability(capabilityId, operation, {
    anchorId = null,
    postcondition = () => true,
    authoritativeTerminal = false,
    mapResult = null
  } = {}) {
    if (typeof operation !== 'function') throw new Error('compatibility_operation_required');
    const contract = this.uiContract;
    if (
      this.vendorId !== 'chatgpt' ||
      contract?.kind !== 'chatgpt' ||
      !this.onCompatibilityObservation
    ) {
      return await operation();
    }
    const capability = contract.profile.capabilities.find(({ id }) => id === capabilityId);
    if (!capability) throw new Error(`unknown_chatgpt_capability:${capabilityId}`);
    const selectedAnchorId = anchorId || capability.anchorIds[0];
    const attemptId = crypto.randomUUID();
    const common = () => ({
      schemaVersion: 1,
      observationId: crypto.randomUUID(),
      attemptId,
      observedAt: Date.now(),
      contractHash: contract.profile.contractHash,
      vendorId: 'chatgpt',
      backend: this.compatibilityBackend
    });
    const resolution = await evaluateChatGptAnchor({
      page: this.page,
      uiContract: contract,
      anchorId: selectedAnchorId
    });
    const emitResolution = async () => {
      if (resolution.kind === 'apparatus') {
        return await this.recordCompatibilityObservation({
          ...common(),
          kind: 'apparatus',
          stage: resolution.stage,
          verdict: 'incomplete',
          reasonCode: resolution.reasonCode
        });
      }
      if (resolution.status === 'resolved') {
        return await this.recordCompatibilityObservation({
          ...common(),
          capabilityId,
          kind: 'resolution',
          anchorId: resolution.anchorId,
          branchId: resolution.branchId,
          branchKind: resolution.branchKind,
          branchSource: resolution.branchSource,
          selectorHash: resolution.selectorHash,
          rolloutSignature: resolution.rolloutSignature
        });
      }
      return null;
    };
    const emitCapability = async (status, reasonCode) =>
      await this.recordCompatibilityObservation({
        ...common(),
        capabilityId,
        kind: 'capability',
        postconditionId: capability.postconditionId,
        status,
        reasonCode,
        rolloutSignature: resolution.rolloutSignature || contract.profile.contractHash
      });
    const emitTerminal = async (status) =>
      await this.recordCompatibilityObservation({
        ...common(),
        capabilityId,
        kind: 'terminal',
        mode: capability.terminalMode,
        status,
        artifactCount: 0
      });

    try {
      const operationResult = await operation();
      const result = typeof mapResult === 'function'
        ? await mapResult(operationResult, resolution)
        : operationResult;
      const behaviorPassed = !!(await postcondition(result));
      const resolutionStatus = resolution.kind === 'resolution' ? resolution.healthStatus : null;
      const status = !behaviorPassed || resolutionStatus === 'fail'
        ? 'fail'
        : resolutionStatus === 'degraded' ? 'degraded' : 'ok';
      const reasonCode = !behaviorPassed
        ? 'postcondition-failed'
        : resolutionStatus === 'fail' ? 'anchor-postcondition-failed'
          : resolutionStatus === 'degraded' ? 'legacy-branch' : 'postcondition-satisfied';
      if (resolution.kind !== 'apparatus') await emitResolution();
      await emitCapability(status, reasonCode);
      if (resolution.kind === 'apparatus') await emitResolution();
      if (authoritativeTerminal) await emitTerminal(behaviorPassed ? 'satisfied' : 'failed');
      if (capability.terminalMode === 'receipt-backed' || capability.terminalMode === 'artifact-backed') {
        this.compatibilityTerminalAttempts.set(capabilityId, { attemptId, mode: capability.terminalMode });
      }
      return result;
    } catch (error) {
      if (resolution.kind !== 'apparatus') await emitResolution();
      await emitCapability('fail', 'operation-failed');
      if (resolution.kind === 'apparatus') await emitResolution();
      if (authoritativeTerminal) await emitTerminal('failed');
      if (capability.terminalMode === 'receipt-backed' || capability.terminalMode === 'artifact-backed') {
        this.compatibilityTerminalAttempts.set(capabilityId, { attemptId, mode: capability.terminalMode });
      }
      throw error;
    }
  }

  async runExclusive(fn) {
    return await this.mutex.run(async () => {
      if (this.exclusiveQuarantine !== null) {
        const error = new Error('tab_busy');
        error.code = 'tab_busy';
        throw error;
      }
      return await fn();
    });
  }

  quarantineExclusiveUntil(operation) {
    const settling = Promise.resolve(operation).then(
      () => undefined,
      () => undefined
    );
    const prior = this.exclusiveQuarantine;
    const quarantine = prior === null
      ? settling
      : Promise.all([prior, settling]).then(() => undefined);
    this.exclusiveQuarantine = quarantine;
    void quarantine.finally(() => {
      if (this.exclusiveQuarantine === quarantine) this.exclusiveQuarantine = null;
    });
  }

  async navigate(url) {
    await this.page.navigate(url);
  }

  async prepareChatEntry({ chatUrl, timeoutMs = 30_000, forceNavigation = false } = {}) {
    const target = parseChatGptEntryTarget(chatUrl);
    const currentUrl = await this.getUrl().catch(() => '');
    const effectiveTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 30_000));
    const deadline = Date.now() + effectiveTimeoutMs;
    const mustNavigate = forceNavigation || currentUrl !== target.chatUrl;
    let priorDocumentEpoch = null;
    if (forceNavigation) {
      priorDocumentEpoch = await this.#readDocumentEpoch().catch(() => null);
      if (priorDocumentEpoch === null) {
        const error = new Error('navigation_document_epoch_unavailable');
        error.code = 'compatibility_drift';
        throw error;
      }
    }
    if (mustNavigate) await this.navigate(target.chatUrl);
    if (forceNavigation) {
      await this.#waitForDocumentReplacement(priorDocumentEpoch, deadline);
      await this.ensureReady({ timeoutMs: Math.max(1, deadline - Date.now()) });
    } else {
      // Ordinary query and sync navigation historically received a full readiness
      // window after navigation completed. Route verification opts into the
      // combined navigation/replacement deadline above.
      await this.ensureReady({ timeoutMs: effectiveTimeoutMs });
    }
    return target;
  }

  async #readDocumentEpoch() {
    const value = await this.#eval(`(() => {
      const value = Number(globalThis.performance?.timeOrigin);
      return Number.isFinite(value) && value > 0 ? value : null;
    })()`);
    const epoch = Number(value);
    return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
  }

  async #waitForDocumentReplacement(priorEpoch, deadline) {
    while (Date.now() < deadline) {
      const currentEpoch = await this.#readDocumentEpoch().catch(() => null);
      if (currentEpoch !== null && currentEpoch !== priorEpoch) return;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    const error = new Error('navigation_document_not_replaced');
    error.code = 'navigation_document_not_replaced';
    throw error;
  }

  async #eval(js) {
    return await this.page.evaluate(js);
  }

  async #evalCapture(js) {
    return await this.page.evaluate(js);
  }

  async #settleCaptureTermination() {
    if (typeof this.page?.terminateEvaluation !== 'function') return;
    let terminationTimeoutId = null;
    try {
      await Promise.race([
        Promise.resolve().then(async () => await this.page.terminateEvaluation()).catch(() => false),
        new Promise((resolve) => {
          terminationTimeoutId = setTimeout(resolve, 5_000);
        })
      ]);
    } finally {
      if (terminationTimeoutId !== null) clearTimeout(terminationTimeoutId);
    }
  }

  async #runCaptureWithHostDeadline(operation) {
    let timeoutId = null;
    let expired = false;
    let termination = Promise.resolve();
    const running = Promise.resolve().then(operation);
    const deadline = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        expired = true;
        this.quarantineExclusiveUntil(running);
        termination = this.#settleCaptureTermination();
        const error = new Error('conversation_capture_timeout');
        error.code = 'conversation_capture_timeout';
        reject(error);
      }, this.captureHostTimeoutMs);
    });
    try {
      const value = await Promise.race([running, deadline]);
      if (expired) {
        const error = new Error('conversation_capture_timeout');
        error.code = 'conversation_capture_timeout';
        throw error;
      }
      return value;
    } catch (error) {
      if (!expired) throw error;
      running.catch(() => {});
      await termination.catch(() => {});
      const timeout = new Error('conversation_capture_timeout');
      timeout.code = 'conversation_capture_timeout';
      throw timeout;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
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

  #transcriptDependencySelector(dependency, fallback = null) {
    const mappedSelector = this.uiContract?.profile?.exemptions
      ?.find((entry) => entry?.dependency === dependency)?.selector;
    if (typeof mappedSelector === 'string' && mappedSelector.trim()) return mappedSelector;
    return this.uiContract?.kind === 'chatgpt' ? null : fallback;
  }

  async inspectConversationRoute() {
    const messageSelector = this.#transcriptDependencySelector(
      'transcript-message',
      '[data-message-author-role]'
    );
    const turnOrdinalSelector = this.#transcriptDependencySelector(
      'transcript-turn-ordinal',
      '[data-testid^="conversation-turn-"]'
    );
    if (!messageSelector || !turnOrdinalSelector) {
      return { status: 'failed', reason: 'compatibility-drift' };
    }

    const inspectOnce = async () => await this.#eval(`(() => {
      const messageSelector = ${JSON.stringify(messageSelector)};
      const turnOrdinalSelector = ${JSON.stringify(turnOrdinalSelector)};
      const isVisible = (node) => {
        if (!node || node.isConnected === false) return false;
        try {
          if (node.closest?.('[aria-hidden="true"], [inert]')) return false;
          const style = getComputedStyle(node);
          if (style?.display === 'none' || style?.visibility === 'hidden' || style?.opacity === '0') return false;
          const rect = node.getBoundingClientRect?.();
          return !!rect && Number(rect.width) > 0 && Number(rect.height) > 0;
        } catch {
          return false;
        }
      };
      const visibleOrdinals = new Set();
      const messages = Array.from(document.querySelectorAll(messageSelector)).slice(0, 2000);
      for (const message of messages) {
        if (!isVisible(message)) continue;
        if (!String(message.getAttribute?.('data-message-author-role') || '').trim()) continue;
        const turn = message.closest?.(turnOrdinalSelector);
        if (!isVisible(turn)) continue;
        const match = /^conversation-turn-([1-9]\\d*)$/.exec(
          String(turn.getAttribute?.('data-testid') || '')
        );
        if (!match) continue;
        const ordinal = Number(match[1]);
        if (!Number.isSafeInteger(ordinal) || ordinal <= 0) continue;
        visibleOrdinals.add(ordinal);
      }
      return visibleOrdinals.size;
    })()`);

    const deadline = Date.now() + 1_500;
    while (true) {
      const visibleTurnCount = await inspectOnce();
      if (!Number.isSafeInteger(visibleTurnCount) || visibleTurnCount < 0) {
        return { status: 'failed', reason: 'compatibility-drift' };
      }
      if (visibleTurnCount > 0) return { status: 'served', visibleTurnCount };
      if (Date.now() >= deadline) return { status: 'unavailable', reason: 'not-found' };
      await sleep(Math.min(150, Math.max(1, deadline - Date.now())));
    }
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

  async captureConversation({ maxCaptureBytes = 4 * 1024 * 1024 } = {}) {
    const cap = Math.max(1, Math.min(16 * 1024 * 1024, Math.floor(Number(maxCaptureBytes) || 4 * 1024 * 1024)));
    const operation = async () => await this.runCompatibilityCapability('transcript', async () => {
      const readOwnedTarget = async () => {
        try {
          const target = parseChatGptEntryTarget(await this.getUrl());
          if (target?.kind !== 'canonical-conversation') return null;
          const providerConversationId = providerConversationIdFromOwnedLocation(
            locationFromConversationUrl(target.chatUrl)
          );
          return { conversationUrl: target.chatUrl, providerConversationId };
        } catch {
          return null;
        }
      };
      const before = await readOwnedTarget();
      let routeGuard = null;
      let routeGuardStable = true;
      if (before && typeof this.page?.beginNavigationGuard === 'function') {
        const matchesOwnedTarget = (value) => {
          try {
            const target = parseChatGptEntryTarget(value);
            if (target?.kind !== 'canonical-conversation') return false;
            return providerConversationIdFromOwnedLocation(
              locationFromConversationUrl(target.chatUrl)
            ) === before.providerConversationId;
          } catch {
            return false;
          }
        };
        try {
          routeGuard = await this.page.beginNavigationGuard(matchesOwnedTarget);
          if (!routeGuard || typeof routeGuard.isStable !== 'function') routeGuardStable = false;
        } catch {
          routeGuardStable = false;
        }
      }
      let captured;
      let after = null;
      try {
        captured = before
          ? (await this.#captureConversationBundle({
              maxCaptureBytes: cap,
              providerConversationId: before.providerConversationId
            })).captureWindow
          : {
              status: 'partial',
              reason: 'compatibility_drift',
              rawTurns: [],
              evidence: {
                topBoundary: false,
                bottomBoundary: false,
                orderedWindowStitching: false,
                scrollPasses: 0,
                windowCount: 1,
                messageCount: 0,
                providerIdCount: 0,
                byteCount: 0
              }
            };
        after = await readOwnedTarget();
        if (routeGuard) {
          try {
            routeGuardStable = routeGuardStable && !!(await routeGuard.isStable());
          } catch {
            routeGuardStable = false;
          }
        }
      } finally {
        try {
          await routeGuard?.dispose?.();
        } catch {
          routeGuardStable = false;
        }
      }
      const routeStable = !!before && !!after && routeGuardStable &&
        before.providerConversationId === after.providerConversationId;
      const conversationUrl = routeStable ? after.conversationUrl : null;
      try {
        if (routeStable) providerConversationIdFromOwnedLocation(locationFromConversationUrl(conversationUrl));
      } catch {
        return parseConversationCapture({
          ...captured,
          status: 'partial',
          reason: 'compatibility_drift',
          conversationUrl: null,
          capturedAt: new Date().toISOString()
        });
      }
      const capturedAt = new Date().toISOString();
      const value = captured.status === 'complete' && !routeStable
        ? { ...captured, status: 'partial', reason: 'compatibility_drift', conversationUrl: null, capturedAt }
        : { ...captured, conversationUrl, capturedAt };
      return parseConversationCapture(value);
    }, {
      anchorId: 'assistant-message',
      postcondition: (value) => value?.status === 'complete' ||
        (value?.status === 'partial' && value.reason !== 'compatibility_drift'),
      mapResult: (value, resolution) => {
        if (resolution?.kind === 'resolution' && resolution.healthStatus !== 'fail') return value;
        return value?.status === 'partial' && value.reason === 'compatibility_drift'
          ? value
          : { ...value, status: 'partial', reason: 'compatibility_drift' };
      }
    });
    try {
      return await this.#runCaptureWithHostDeadline(operation);
    } catch (error) {
      if (error?.code !== 'conversation_capture_timeout') throw error;
      return parseConversationCapture({
        status: 'partial',
        reason: 'conversation_capture_timeout',
        conversationUrl: null,
        capturedAt: new Date().toISOString(),
        rawTurns: [],
        evidence: {
          topBoundary: false,
          bottomBoundary: false,
          orderedWindowStitching: false,
          scrollPasses: 0,
          windowCount: 1,
          messageCount: 0,
          providerIdCount: 0,
          byteCount: 0
        }
      });
    }
  }

  async #captureConversationBundle({
    maxCaptureBytes,
    includeLegacyDiagnostic = false,
    providerConversationId = null
  }) {
    const messageSelector = this.#transcriptDependencySelector(
      'transcript-message',
      '[data-message-author-role]'
    );
    const ownerSelector = this.#transcriptDependencySelector(
      'transcript-message-id',
      '[data-message-id]'
    );
    const turnOrdinalSelector = this.#transcriptDependencySelector(
      'transcript-turn-ordinal',
      '[data-testid^="conversation-turn-"]'
    );
    const stopSelector = this.selectors?.stopButton ||
      (this.uiContract?.kind === 'chatgpt' ? null : 'button[data-testid="stop-button"]');
    const generationIndicatorSelector = this.#transcriptDependencySelector(
      'transcript-generation-indicator',
      '[role="status"], [aria-live]'
    );
    const artifactDownloadSelector = this.#transcriptDependencySelector(
      'conversation-artifact-download-button',
      'button[aria-label="Download file"]'
    );
    const artifactNamedButtonSelector = this.#transcriptDependencySelector(
      'conversation-artifact-named-button',
      'button[aria-label]'
    );
    const partialCaptureWindow = (reason = 'compatibility_drift') => ({
        status: 'partial',
        reason,
        rawTurns: [],
        evidence: {
          topBoundary: false,
          bottomBoundary: false,
          orderedWindowStitching: false,
          scrollPasses: 0,
          windowCount: 1,
          messageCount: 0,
          providerIdCount: 0,
          byteCount: 0
        }
    });
    if (
      !messageSelector ||
      !ownerSelector ||
      !turnOrdinalSelector ||
      !stopSelector ||
      !generationIndicatorSelector
    ) {
      return {
        captureWindow: partialCaptureWindow(),
        artifactInventory: emptyPartialConversationArtifactInventory()
      };
    }
    let captured;
    try {
      captured = await this.#evalCapture(`(async () => {
      const cap = ${maxCaptureBytes};
      const includeLegacyDiagnostic = ${includeLegacyDiagnostic === true ? 'true' : 'false'};
      const maxTurnTextChars = ${TRANSCRIPT_TURN_MAX_TEXT_CHARS};
      const maxProviderTurnOrdinal = 100_000;
      const maxProviderGapSpan = 64;
      const maxGapScanSteps = 4_096;
      const maxGapScanMs = 90_000;
      const messageSelector = ${JSON.stringify(messageSelector)};
      const ownerSelector = ${JSON.stringify(ownerSelector)};
      const turnOrdinalSelector = ${JSON.stringify(turnOrdinalSelector)};
      const stopSelector = ${JSON.stringify(stopSelector)};
      const generationIndicatorSelector = ${JSON.stringify(generationIndicatorSelector)};
      const artifactDownloadSelector = ${JSON.stringify(artifactDownloadSelector)};
      const artifactNamedButtonSelector = ${JSON.stringify(artifactNamedButtonSelector)};
      const artifactSelectorsAvailable = !!artifactDownloadSelector && !!artifactNamedButtonSelector;
      const transcriptTextForNode = ${extractChatGptTranscriptMessageText.toString()};
      const utf8Bytes = (value) => {
        let bytes = 0;
        for (const symbol of String(value || '')) {
          const code = symbol.codePointAt(0);
          bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        }
        return bytes;
      };
      const turnBytes = (turn) => utf8Bytes(turn.role) + utf8Bytes(turn.text) + utf8Bytes(turn.providerMessageId || '');
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const settle = async () => await wait(120);
      const settleProviderObservation = async () => {
        if (typeof requestAnimationFrame === 'function') {
          await new Promise((resolve) => requestAnimationFrame(() => resolve()));
          return;
        }
        await wait(16);
      };
      let mappedInputInvalid = false;
      const providerMessageIdForNode = (node) => {
        const owner = node.closest(ownerSelector);
        const messageId = (
          node.getAttribute('data-message-id') ||
          owner?.getAttribute('data-message-id')
        );
        if (typeof messageId !== 'string' || !messageId.length) return null;
        if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,511})$/.test(messageId)) {
          mappedInputInvalid = true;
          return null;
        }
        return messageId;
      };
      const providerTurnIndexForNode = (node) => {
        const owner = node.closest(turnOrdinalSelector);
        const testId = owner?.getAttribute('data-testid') || '';
        if (!owner) return null;
        const matched = /^conversation-turn-(\\d+)$/.exec(testId);
        if (!matched) {
          mappedInputInvalid = true;
          return null;
        }
        const value = Number(matched[1]);
        if (!Number.isSafeInteger(value) || value < 1 || value > maxProviderTurnOrdinal) {
          mappedInputInvalid = true;
          return null;
        }
        return value;
      };
      const unresolvedMessageSignatures = new Map();
      const unresolvedProviderMessageAnchors = new Map();
      const unresolvedTurnOwnerShells = new Set();
      const turnOwnerShellCleanObservationCounts = new Map();
      const provenAbsentProviderOrdinals = new Set();
      const providerTurnIndexForOwner = (owner) => {
        const testId = String(owner?.getAttribute?.('data-testid') || '');
        const matched = /^conversation-turn-(\\d+)$/.exec(testId);
        if (!matched) {
          mappedInputInvalid = true;
          return null;
        }
        const value = Number(matched[1]);
        if (!Number.isSafeInteger(value) || value < 1 || value > maxProviderTurnOrdinal) {
          mappedInputInvalid = true;
          return null;
        }
        return value;
      };
      const historicalChromeObservationSignatures = new Map();
      const historicalChromeObservationCounts = new Map();
      const historicalProviderChromeSignature = (owner) => {
        try {
          if (
            typeof owner.getAttribute?.('data-message-id') === 'string' ||
            (owner.querySelectorAll?.('[data-message-id]')?.length || 0) > 0
          ) return null;
          const elements = [owner, ...Array.from(owner.querySelectorAll?.('*') || [])];
          if (elements.length > 64) return null;
          const mappedChrome = (element) => {
            try {
              return !!element?.matches?.(generationIndicatorSelector);
            } catch {
              return false;
            }
          };
          if (!elements.some(mappedChrome)) return null;
          const semanticContentSelector = [
            'p', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
            'ul', 'ol', 'li', 'a', 'canvas', 'audio', 'video', 'iframe', 'figure', 'figcaption'
          ].join(', ');
          if ((owner.querySelectorAll?.(semanticContentSelector)?.length || 0) > 0) {
            return null;
          }
          const text = String(owner.textContent || '');
          if (text.length > 256) return null;
          return 'map-owned-historical-chrome';
        } catch {
          return null;
        }
      };
      const providerNodeIsServed = (node) => {
        if (!node || node.isConnected === false || node.hidden === true) return false;
        if (node.getAttribute?.('aria-hidden') === 'true' || node.hasAttribute?.('inert')) return false;
        if (node.closest?.('[aria-hidden="true"], [inert]')) return false;
        try {
          if (
            typeof node.checkVisibility === 'function' &&
            node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === false
          ) return false;
          const clientRectangles = node.getClientRects?.();
          if (
            clientRectangles &&
            typeof clientRectangles.length === 'number' &&
            clientRectangles.length === 0
          ) return false;
          const style = window.getComputedStyle?.(node);
          if (
            style?.display === 'none' ||
            style?.visibility === 'hidden' ||
            style?.visibility === 'collapse' ||
            style?.contentVisibility === 'hidden' ||
            Number.parseFloat(style?.opacity || '1') <= 0
          ) return false;
        } catch {
          return false;
        }
        return true;
      };
      const turnOwnerIsServed = (owner) => providerNodeIsServed(owner);
      const observeTurnOwnerShells = () => {
        const owners = Array.from(document.querySelectorAll(turnOrdinalSelector));
        if (owners.length > maxProviderTurnOrdinal) mappedInputInvalid = true;
        const groups = new Map();
        for (const owner of owners.slice(0, maxProviderTurnOrdinal)) {
          if (!turnOwnerIsServed(owner)) continue;
          const ordinal = providerTurnIndexForOwner(owner);
          if (!Number.isSafeInteger(ordinal)) continue;
          const group = groups.get(ordinal) || [];
          group.push(owner);
          groups.set(ordinal, group);
        }
        for (const ordinal of unresolvedTurnOwnerShells) {
          if (!groups.has(ordinal)) {
            turnOwnerShellCleanObservationCounts.set(ordinal, 0);
            historicalChromeObservationSignatures.delete(ordinal);
            historicalChromeObservationCounts.delete(ordinal);
          }
        }
        for (const [ordinal, group] of groups) {
          const ownerRecords = group.map((owner) => ({
            owner,
            mappedCount: (owner.matches?.(messageSelector) ? 1 : 0) +
              (owner.querySelectorAll?.(messageSelector)?.length || 0)
          }));
          const emptyOwners = ownerRecords.filter(({ mappedCount }) => mappedCount === 0);
          const hasEmptyOwner = emptyOwners.length > 0;
          if (hasEmptyOwner) {
            const historicalChromeSignatures = emptyOwners
              .map(({ owner }) => historicalProviderChromeSignature(owner));
            const historicalChromeSignature = historicalChromeSignatures.every(Boolean)
              ? 'eligible'
              : null;
            if (historicalChromeSignature !== null) {
              const priorSignature = historicalChromeObservationSignatures.get(ordinal);
              const observationCount = priorSignature === historicalChromeSignature
                ? Math.min(1_000, (historicalChromeObservationCounts.get(ordinal) || 0) + 1)
                : 1;
              historicalChromeObservationSignatures.set(ordinal, historicalChromeSignature);
              historicalChromeObservationCounts.set(ordinal, observationCount);
              if (observationCount >= 4) {
                unresolvedTurnOwnerShells.delete(ordinal);
                turnOwnerShellCleanObservationCounts.delete(ordinal);
                continue;
              }
            } else {
              historicalChromeObservationSignatures.delete(ordinal);
              historicalChromeObservationCounts.delete(ordinal);
            }
            unresolvedTurnOwnerShells.add(ordinal);
            turnOwnerShellCleanObservationCounts.set(ordinal, 0);
            continue;
          }
          historicalChromeObservationSignatures.delete(ordinal);
          historicalChromeObservationCounts.delete(ordinal);
          if (!unresolvedTurnOwnerShells.has(ordinal)) continue;
          const cleanCount = Math.min(
            1_000,
            (turnOwnerShellCleanObservationCounts.get(ordinal) || 0) + 1
          );
          turnOwnerShellCleanObservationCounts.set(ordinal, cleanCount);
          if (cleanCount >= 4) {
            unresolvedTurnOwnerShells.delete(ordinal);
            turnOwnerShellCleanObservationCounts.delete(ordinal);
          }
        }
      };
      const unresolvedMessageRecord = (message) => ({
        providerMessageId: message.providerMessageId,
        providerTurnIndex: message.providerTurnIndex,
        providerTurnPartIndex: message.providerTurnPartIndex,
        role: message.role
      });
      const unresolvedMessageAnchor = (message) => Number.isSafeInteger(message.providerTurnIndex) &&
          Number.isSafeInteger(message.providerTurnPartIndex)
        ? 'position:' + message.providerTurnIndex + ':' + message.providerTurnPartIndex
        : message.providerMessageId
          ? 'id:' + message.providerMessageId
          : 'unpositioned';
      const conversationArtifacts = new Map();
      let artifactInputInvalid = !artifactSelectorsAvailable;
      const artifactNodeIsServed = (node) => {
        if (!node || node.isConnected === false || node.hidden === true) return false;
        if (node.getAttribute?.('aria-hidden') === 'true' || node.hasAttribute?.('inert')) return false;
        if (node.closest?.('[aria-hidden="true"], [inert]')) return false;
        try {
          const style = window.getComputedStyle?.(node);
          if (
            style?.display === 'none' ||
            style?.visibility === 'hidden' ||
            style?.visibility === 'collapse' ||
            style?.contentVisibility === 'hidden'
          ) return false;
        } catch {
          return false;
        }
        return true;
      };
      const observeConversationArtifacts = ({
        scopeNode,
        role,
        providerMessageId,
        providerTurnIndex
      }) => {
        if (!artifactSelectorsAvailable) return;
        if (String(role || '').trim().toLowerCase() !== 'assistant') return;
        let downloadButtons;
        try {
          downloadButtons = Array.from(scopeNode.querySelectorAll?.(artifactDownloadSelector) || []);
        } catch {
          artifactInputInvalid = true;
          return;
        }
        for (let occurrenceWithinMessage = 0; occurrenceWithinMessage < downloadButtons.length; occurrenceWithinMessage += 1) {
          const downloadButton = downloadButtons[occurrenceWithinMessage];
          if (!artifactNodeIsServed(downloadButton)) {
            artifactInputInvalid = true;
            continue;
          }
          if (!providerMessageId || !Number.isSafeInteger(providerTurnIndex)) {
            artifactInputInvalid = true;
            continue;
          }
          let container = downloadButton.parentElement;
          let name = null;
          let depth = 0;
          while (container && container !== scopeNode && depth < 8) {
            let candidates = [];
            try {
              candidates = Array.from(container.querySelectorAll?.(artifactNamedButtonSelector) || [])
                .filter((candidate) => candidate !== downloadButton && artifactNodeIsServed(candidate))
                .filter((candidate) => String(candidate.getAttribute?.('aria-label') || '').trim() !== 'Download file');
            } catch {
              artifactInputInvalid = true;
              break;
            }
            if (candidates.length === 1) {
              name = String(candidates[0].getAttribute?.('aria-label') || '').trim();
              break;
            }
            if (candidates.length > 1) {
              artifactInputInvalid = true;
              break;
            }
            container = container.parentElement;
            depth += 1;
          }
          if (!name || name.length > 1_024 || name.includes('\u0000')) {
            artifactInputInvalid = true;
            continue;
          }
          const identity = providerMessageId + ':' + occurrenceWithinMessage;
          const observation = {
            providerMessageId,
            providerTurnIndex,
            occurrenceWithinMessage,
            name,
            kind: 'file'
          };
          const prior = conversationArtifacts.get(identity);
          if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) {
            artifactInputInvalid = true;
            continue;
          }
          conversationArtifacts.set(identity, observation);
        }
      };
      const readMessages = () => {
        observeTurnOwnerShells();
        const records = Array.from(document.querySelectorAll(messageSelector))
          .map((node) => {
            const turnOwner = node.closest(turnOrdinalSelector);
            if (!providerNodeIsServed(node) || (turnOwner && !turnOwnerIsServed(turnOwner))) {
              mappedInputInvalid = true;
              return null;
            }
            const roleValue = node.getAttribute('data-message-author-role');
            const role = typeof roleValue === 'string' && roleValue.length ? roleValue : 'unknown';
            const text = transcriptTextForNode(node);
            const normalizedRole = role.trim().toLowerCase();
            const roleInvalid = role.length < 1 || role.length > 64 ||
              /[\\u0000-\\u001f\\u007f]/.test(role) || !normalizedRole ||
              normalizedRole.length > 64 || /[\\u0000-\\u001f\\u007f]/.test(normalizedRole);
            const textInvalid = typeof text !== 'string' || text.length > maxTurnTextChars || text.includes('\\u0000');
            if (roleInvalid || textInvalid) mappedInputInvalid = true;
            const providerTurnIndex = providerTurnIndexForNode(node);
            const providerMessageId = providerMessageIdForNode(node);
            return {
              node,
              providerTurnIndex,
              providerMessageId,
              role,
              text: textInvalid ? '' : text,
              turnOwner
            };
          })
          .filter(Boolean);
        const assistantRecordsByOwner = new Map();
        for (const message of records) {
          if (String(message.role || '').trim().toLowerCase() !== 'assistant') continue;
          const scopeNode = message.turnOwner || message.node;
          const grouped = assistantRecordsByOwner.get(scopeNode) || [];
          grouped.push(message);
          assistantRecordsByOwner.set(scopeNode, grouped);
        }
        for (const [scopeNode, assistantRecords] of artifactSelectorsAvailable ? assistantRecordsByOwner : []) {
          let scopedDownloads = [];
          try {
            scopedDownloads = Array.from(scopeNode.querySelectorAll?.(artifactDownloadSelector) || []);
          } catch {
            artifactInputInvalid = true;
            continue;
          }
          if (!scopedDownloads.length) continue;
          if (assistantRecords.length !== 1) {
            artifactInputInvalid = true;
            continue;
          }
          const [message] = assistantRecords;
          observeConversationArtifacts({
            scopeNode,
            role: message.role,
            providerMessageId: message.providerMessageId,
            providerTurnIndex: message.providerTurnIndex
          });
        }
        const partCounts = new Map();
        const positioned = records
          .map((message) => {
            const providerTurnPartIndex = message.turnOwner
              ? partCounts.get(message.turnOwner) || 0
              : null;
            if (message.turnOwner) {
              partCounts.set(message.turnOwner, providerTurnPartIndex + 1);
            }
            if (providerTurnPartIndex !== null && providerTurnPartIndex >= maxProviderTurnOrdinal) {
              mappedInputInvalid = true;
            }
            return {
              providerTurnIndex: message.providerTurnIndex,
              providerTurnPartIndex,
              providerMessageId: message.providerMessageId,
              role: message.role,
              text: message.text
            };
          });
        const providerMessageIdCounts = new Map();
        const messageAnchorCounts = new Map();
        for (const message of positioned) {
          if (message.providerMessageId) {
            providerMessageIdCounts.set(
              message.providerMessageId,
              (providerMessageIdCounts.get(message.providerMessageId) || 0) + 1
            );
          }
          const anchor = unresolvedMessageAnchor(message);
          messageAnchorCounts.set(anchor, (messageAnchorCounts.get(anchor) || 0) + 1);
        }
        for (const message of positioned) {
          const anchor = unresolvedMessageAnchor(message);
          const signature = JSON.stringify(unresolvedMessageRecord(message));
          const unique = messageAnchorCounts.get(anchor) === 1 && (
            !message.providerMessageId || providerMessageIdCounts.get(message.providerMessageId) === 1
          );
          const empty = typeof message.text !== 'string' || !message.text.trim().length;
          if (anchor === 'unpositioned') {
            if (empty) unresolvedMessageSignatures.set(anchor, signature);
            continue;
          }
          if (!unique) continue;
          const priorAnchor = message.providerMessageId
            ? unresolvedProviderMessageAnchors.get(message.providerMessageId)
            : null;
          if (priorAnchor && priorAnchor !== anchor) mappedInputInvalid = true;
          const priorSignature = unresolvedMessageSignatures.get(anchor);
          if (priorSignature && priorSignature !== signature) mappedInputInvalid = true;
          if (empty) {
            if (!priorSignature) unresolvedMessageSignatures.set(anchor, signature);
            if (message.providerMessageId && !priorAnchor) {
              unresolvedProviderMessageAnchors.set(message.providerMessageId, anchor);
            }
          }
        }
        // Keep empty records inside the capture walk so their provider identity,
        // position, and ordering remain evidence-bearing. They are filtered only
        // from the published raw turns after the capture is proven partial.
        return positioned;
      };
      const messageNodes = () => Array.from(document.querySelectorAll(messageSelector));
      const messageNodeForProviderId = (providerMessageId) => messageNodes()
        .find((node) => providerMessageIdForNode(node) === providerMessageId) || null;
      const token = (turn) => turn.providerMessageId
        ? 'id:' + turn.providerMessageId
        : Number.isSafeInteger(turn.providerTurnIndex) && Number.isSafeInteger(turn.providerTurnPartIndex)
          ? 'turn:' + turn.providerTurnIndex + ':' + turn.providerTurnPartIndex
          : 'fallback:' + turn.role + '\\u0000' + turn.text;
      const hasProviderPosition = (turn) => Number.isSafeInteger(turn.providerTurnIndex) &&
        Number.isSafeInteger(turn.providerTurnPartIndex);
      const providerPositionKey = (turn) => hasProviderPosition(turn)
        ? turn.providerTurnIndex + ':' + turn.providerTurnPartIndex
        : null;
      const compareProviderPosition = (left, right) =>
        left.providerTurnIndex - right.providerTurnIndex ||
        left.providerTurnPartIndex - right.providerTurnPartIndex;
      const followsProviderPosition = (previous, turn) => {
        if (turn.providerTurnIndex === previous.providerTurnIndex) {
          return turn.providerTurnPartIndex === previous.providerTurnPartIndex + 1;
        }
        if (turn.providerTurnIndex <= previous.providerTurnIndex || turn.providerTurnPartIndex !== 0) {
          return false;
        }
        if (turn.providerTurnIndex - previous.providerTurnIndex - 1 > maxProviderGapSpan) return false;
        for (let ordinal = previous.providerTurnIndex + 1; ordinal < turn.providerTurnIndex; ordinal += 1) {
          if (!provenAbsentProviderOrdinals.has(ordinal)) return false;
        }
        return true;
      };
      const startsAtProvenProviderBoundary = (turn) => {
        if (!turn || !hasProviderPosition(turn) || turn.providerTurnPartIndex !== 0) return false;
        const leadingGapSpan = turn.providerTurnIndex - 1;
        if (leadingGapSpan > maxProviderGapSpan) return false;
        for (let ordinal = 1; ordinal < turn.providerTurnIndex; ordinal += 1) {
          if (!provenAbsentProviderOrdinals.has(ordinal)) return false;
        }
        return true;
      };
      const contiguousProviderPositionKeys = (turns) => {
        const ordered = turns.filter(hasProviderPosition).sort(compareProviderPosition);
        const keys = new Set();
        if (!startsAtProvenProviderBoundary(ordered[0])) return keys;
        keys.add(providerPositionKey(ordered[0]));
        for (let index = 1; index < ordered.length; index += 1) {
          if (!followsProviderPosition(ordered[index - 1], ordered[index])) break;
          keys.add(providerPositionKey(ordered[index]));
        }
        return keys;
      };
      const orderedCaptureStructure = () => {
        if (!transcript.every(hasProviderPosition)) return null;
        const turns = [...transcript];
        const positions = new Set(turns.map(providerPositionKey));
        for (const signature of unresolvedMessageSignatures.values()) {
          let unresolved;
          try {
            unresolved = JSON.parse(signature);
          } catch {
            return null;
          }
          if (!hasProviderPosition(unresolved)) return null;
          const { providerTurnIndex, providerTurnPartIndex } = unresolved;
          const positionKey = providerTurnIndex + ':' + providerTurnPartIndex;
          if (positions.has(positionKey)) continue;
          positions.add(positionKey);
          turns.push({ providerTurnIndex, providerTurnPartIndex });
        }
        return turns.sort(compareProviderPosition);
      };
      const sameTurn = (left, right) => {
        if (token(left) !== token(right)) return false;
        return left.providerTurnIndex === right.providerTurnIndex &&
          left.providerTurnPartIndex === right.providerTurnPartIndex &&
          left.providerMessageId === right.providerMessageId &&
          left.role === right.role && left.text === right.text;
      };
      const isExactUnavailableTextHydration = (turn) => {
        if (
          !hasProviderPosition(turn) ||
          !turn.providerMessageId ||
          typeof turn.text !== 'string' ||
          !turn.text.trim().length
        ) return false;
        const anchor = unresolvedMessageAnchor(turn);
        return unresolvedMessageSignatures.get(anchor) === JSON.stringify(unresolvedMessageRecord(turn)) &&
          unresolvedProviderMessageAnchors.get(turn.providerMessageId) === anchor;
      };
      const acceptUnavailableTextHydrations = (window) => {
        for (const turn of window) {
          if (!isExactUnavailableTextHydration(turn)) continue;
          if (!transcript.some((candidate) => sameTurn(candidate, turn))) continue;
          const anchor = unresolvedMessageAnchor(turn);
          unresolvedMessageSignatures.delete(anchor);
          unresolvedProviderMessageAnchors.delete(turn.providerMessageId);
        }
      };
      const sameSlice = (left, leftStart, right, rightStart, length) => {
        for (let index = 0; index < length; index += 1) {
          if (!sameTurn(left[leftStart + index], right[rightStart + index])) return false;
        }
        return true;
      };
      const fallbackIsAmbiguous = (turns) => {
        const seen = new Set();
        for (const turn of turns) {
          if (turn.providerMessageId) continue;
          const key = token(turn);
          if (seen.has(key)) return true;
          seen.add(key);
        }
        return false;
      };
      const visible = (node) => {
        if (!node) return false;
        const rectangle = node.getBoundingClientRect?.();
        const style = window.getComputedStyle?.(node);
        if (style?.visibility === 'hidden' || style?.display === 'none') return false;
        if (
          rectangle && Number.isFinite(rectangle.width) && Number.isFinite(rectangle.height) &&
          (rectangle.width <= 0 || rectangle.height <= 0)
        ) return false;
        return true;
      };
      const generationIsActive = () => {
        if (Array.from(document.querySelectorAll(stopSelector)).some(visible)) return true;
        const messages = messageNodes();
        return Array.from(document.querySelectorAll(generationIndicatorSelector)).some((node) => {
          if (!visible(node)) return false;
          if (messages.some((message) => message === node || message.contains?.(node))) return false;
          const text = String(node.textContent || node.getAttribute?.('aria-label') || '').trim();
          return /\\b(?:thinking|reasoning|working|searching|browsing|generating|analyzing)\\b/i.test(text);
        });
      };
      const generationActiveBefore = generationIsActive();

      let transcript = [];
      let byteCount = 0;
      let windowCount = 0;
      let reason = null;
      let legacyDiagnosticReason = null;
      const providerPositionStabilityObservations = 4;
      const providerPositionObservationCounts = new Map();
      const unsettledProviderPositions = new Set();
      const providerOwnerObservationSignatures = new Map();
      const providerOwnerObservationCounts = new Map();
      const unsettledProviderOwners = new Set();
      const hasUnresolvedStructuralState = () => mappedInputInvalid ||
        unresolvedTurnOwnerShells.size > 0 ||
        unsettledProviderPositions.size > 0 ||
        unsettledProviderOwners.size > 0;
      const providerOwnerGroups = (window) => {
        const groups = new Map();
        for (const turn of window) {
          if (!hasProviderPosition(turn)) continue;
          const key = String(turn.providerTurnIndex);
          const group = groups.get(key) || [];
          group.push(turn);
          groups.set(key, group);
        }
        return groups;
      };
      const providerOwnerSignature = (group) => JSON.stringify(group.map((turn) => ({
        part: turn.providerTurnPartIndex,
        identity: turn.providerMessageId
          ? { kind: 'provider', id: turn.providerMessageId }
          : { kind: 'fallback', role: turn.role, text: turn.text }
      })));
      const observeProviderOwners = (window, { reconcile = false } = {}) => {
        for (const [ownerKey, group] of providerOwnerGroups(window)) {
          const signature = providerOwnerSignature(group);
          const priorSignature = providerOwnerObservationSignatures.get(ownerKey);
          if (priorSignature === undefined) {
            providerOwnerObservationSignatures.set(ownerKey, signature);
            providerOwnerObservationCounts.set(ownerKey, 1);
            unsettledProviderOwners.add(ownerKey);
            continue;
          }
          if (priorSignature === signature) {
            const count = Math.min(1_000, (providerOwnerObservationCounts.get(ownerKey) || 0) + 1);
            providerOwnerObservationCounts.set(ownerKey, count);
            if (count >= providerPositionStabilityObservations) unsettledProviderOwners.delete(ownerKey);
            else unsettledProviderOwners.add(ownerKey);
            continue;
          }
          if (!reconcile || (providerOwnerObservationCounts.get(ownerKey) || 0) >= providerPositionStabilityObservations) {
            reason = 'compatibility_drift';
            return { ok: false, failure: 'provider-owner-composition-changed' };
          }
          const ownerOrdinal = Number(ownerKey);
          const existing = transcript.filter((turn) => turn.providerTurnIndex === ownerOrdinal);
          if (
            existing.some((turn) => !turn.providerMessageId) ||
            group.some((turn) => !turn.providerMessageId)
          ) {
            reason = 'compatibility_drift';
            return { ok: false, failure: 'provider-owner-idless-composition-changed' };
          }
          const existingIds = existing.map((turn) => turn.providerMessageId);
          const nextIds = group.map((turn) => turn.providerMessageId);
          let existingCursor = 0;
          for (const providerMessageId of nextIds) {
            if (providerMessageId === existingIds[existingCursor]) existingCursor += 1;
          }
          if (existingCursor !== existingIds.length || new Set(nextIds).size !== nextIds.length) {
            reason = 'compatibility_drift';
            return { ok: false, failure: 'provider-owner-sequence-changed' };
          }
          const otherProviderIds = new Set(transcript
            .filter((turn) => turn.providerTurnIndex !== ownerOrdinal && turn.providerMessageId)
            .map((turn) => turn.providerMessageId));
          if (nextIds.some((providerMessageId) => otherProviderIds.has(providerMessageId))) {
            reason = 'compatibility_drift';
            return { ok: false, failure: 'duplicate-provider-id' };
          }
          const existingBytes = existing.reduce((total, turn) => total + turnBytes(turn), 0);
          const replacementBytes = group.reduce((total, turn) => total + turnBytes(turn), 0);
          const nextByteCount = byteCount - existingBytes + replacementBytes;
          if (nextByteCount > cap) {
            reason = 'max_capture_bytes';
            return { ok: false, failure: 'capture-limit' };
          }
          for (const turn of existing) {
            const positionKey = providerPositionKey(turn);
            providerPositionObservationCounts.delete(positionKey);
            unsettledProviderPositions.delete(positionKey);
          }
          transcript = [
            ...transcript.filter((turn) => turn.providerTurnIndex !== ownerOrdinal),
            ...group
          ].sort(compareProviderPosition);
          byteCount = nextByteCount;
          for (const turn of group) {
            const positionKey = providerPositionKey(turn);
            providerPositionObservationCounts.set(positionKey, 1);
            unsettledProviderPositions.add(positionKey);
          }
          providerOwnerObservationSignatures.set(ownerKey, signature);
          providerOwnerObservationCounts.set(ownerKey, 1);
          unsettledProviderOwners.add(ownerKey);
        }
        return { ok: true };
      };
      const adopt = (window) => {
        windowCount += 1;
        if (mappedInputInvalid) {
          reason = 'compatibility_drift';
          return false;
        }
        if (!window.length) return true;
        const providerIds = new Set();
        const hasProviderPositions = window.every(hasProviderPosition);
        const hasAnyProviderPosition = window.some((turn) =>
          Number.isSafeInteger(turn.providerTurnIndex) || Number.isSafeInteger(turn.providerTurnPartIndex)
        );
        if (hasAnyProviderPosition && !hasProviderPositions) {
          reason = 'compatibility_drift';
          return false;
        }
        for (let index = 0; index < window.length; index += 1) {
          const turn = window[index];
          if (turn.providerMessageId && providerIds.has(turn.providerMessageId)) {
            reason = 'compatibility_drift';
            return false;
          }
          if (turn.providerMessageId) providerIds.add(turn.providerMessageId);
          if (
            hasProviderPositions && index > 0 &&
            compareProviderPosition(turn, window[index - 1]) <= 0
          ) {
            reason = 'compatibility_drift';
            return false;
          }
        }
        const ownerObservation = observeProviderOwners(window);
        if (!ownerObservation.ok) return false;
        const nextBytes = window.reduce((total, turn) => total + turnBytes(turn), 0);
        if (nextBytes > cap) {
          reason = 'max_capture_bytes';
          return false;
        }
        transcript = [...window];
        byteCount = nextBytes;
        for (const turn of window) {
          const positionKey = providerPositionKey(turn);
          if (positionKey) {
            providerPositionObservationCounts.set(positionKey, 1);
            unsettledProviderPositions.add(positionKey);
          }
        }
        acceptUnavailableTextHydrations(window);
        return true;
      };
      const mergeWindow = (window, direction, { allowTextRefresh = false } = {}) => {
        windowCount += 1;
        if (mappedInputInvalid) {
          reason = 'compatibility_drift';
          return { ok: false, added: 0, failure: 'invalid-mapped-input' };
        }
        if (!window.length) return { ok: true, added: 0 };
        if (!transcript.length) {
          windowCount -= 1;
          return { ok: adopt(window), added: transcript.length };
        }
        const windowHasProviderPositions = window.every(hasProviderPosition);
        const windowHasAnyProviderPosition = window.some((turn) =>
          Number.isSafeInteger(turn.providerTurnIndex) || Number.isSafeInteger(turn.providerTurnPartIndex)
        );
        if (windowHasProviderPositions) {
          const seenWindowPositions = new Set();
          for (let index = 0; index < window.length; index += 1) {
            const positionKey = providerPositionKey(window[index]);
            if (
              seenWindowPositions.has(positionKey) ||
              (index > 0 && compareProviderPosition(window[index], window[index - 1]) <= 0)
            ) {
              reason = 'compatibility_drift';
              return { ok: false, added: 0, failure: 'provider-order-changed' };
            }
            seenWindowPositions.add(positionKey);
          }
          const ownerObservation = observeProviderOwners(window, { reconcile: true });
          if (!ownerObservation.ok) return { ok: false, added: 0, failure: ownerObservation.failure };
        }
        const lockedProviderPositions = contiguousProviderPositionKeys(transcript);
        const providerTurns = new Map();
        const providerIndices = new Map();
        const providerPositionTurns = new Map();
        for (let index = 0; index < transcript.length; index += 1) {
          const turn = transcript[index];
          if (hasProviderPosition(turn)) {
            const positionKey = providerPositionKey(turn);
            if (providerPositionTurns.has(positionKey)) {
              reason = 'compatibility_drift';
              return { ok: false, added: 0, failure: 'duplicate-provider-position' };
            }
            providerPositionTurns.set(positionKey, turn);
          }
          if (!turn.providerMessageId) continue;
          if (providerTurns.has(turn.providerMessageId)) {
            reason = 'compatibility_drift';
            return { ok: false, added: 0, failure: 'duplicate-provider-id' };
          }
          providerTurns.set(turn.providerMessageId, turn);
          providerIndices.set(turn.providerMessageId, index);
        }
        const windowProviderIds = new Set();
        const windowProviderPositions = new Map();
        let refreshed = 0;
        for (const turn of window) {
          if (hasProviderPosition(turn)) {
            const positionKey = providerPositionKey(turn);
            if (windowProviderPositions.has(positionKey)) {
              reason = 'compatibility_drift';
              return { ok: false, added: 0, failure: 'duplicate-provider-position' };
            }
            windowProviderPositions.set(positionKey, turn);
            const priorPosition = providerPositionTurns.get(positionKey);
            if (priorPosition && !sameTurn(priorPosition, turn)) {
              const exactUnavailableTextHydration =
                !String(priorPosition.text || '').trim().length &&
                isExactUnavailableTextHydration(turn);
              const textRefresh = (
                exactUnavailableTextHydration ||
                allowTextRefresh ||
                !lockedProviderPositions.has(positionKey) ||
                (providerPositionObservationCounts.get(positionKey) || 0) < providerPositionStabilityObservations
              ) &&
                priorPosition.providerMessageId === turn.providerMessageId &&
                priorPosition.role === turn.role &&
                priorPosition.text !== turn.text;
              if (textRefresh) {
                const nextByteCount = byteCount - turnBytes(priorPosition) + turnBytes(turn);
                if (nextByteCount > cap) {
                  reason = 'max_capture_bytes';
                  return { ok: false, added: 0, refreshed, failure: 'capture-limit' };
                }
                transcript = transcript.map((candidate) =>
                  providerPositionKey(candidate) === positionKey ? turn : candidate
                );
                byteCount = nextByteCount;
                providerPositionTurns.set(positionKey, turn);
                if (turn.providerMessageId) providerTurns.set(turn.providerMessageId, turn);
                providerPositionObservationCounts.set(positionKey, 1);
                unsettledProviderPositions.add(positionKey);
                refreshed += 1;
                continue;
              }
              reason = 'compatibility_drift';
              const changedField = priorPosition.providerMessageId !== turn.providerMessageId
                ? 'id'
                : priorPosition.role !== turn.role
                  ? 'role'
                  : 'text';
              return {
                ok: false,
                added: 0,
                failure: 'provider-position-' + changedField + '-changed'
              };
            }
            if (priorPosition) {
              const observationCount = Math.min(
                1_000,
                (providerPositionObservationCounts.get(positionKey) || 0) + 1
              );
              providerPositionObservationCounts.set(positionKey, observationCount);
              if (observationCount >= providerPositionStabilityObservations) {
                unsettledProviderPositions.delete(positionKey);
              } else {
                unsettledProviderPositions.add(positionKey);
              }
            }
          }
          if (turn.providerMessageId && windowProviderIds.has(turn.providerMessageId)) {
            reason = 'compatibility_drift';
            return { ok: false, added: 0, failure: 'duplicate-provider-id' };
          }
          if (turn.providerMessageId) windowProviderIds.add(turn.providerMessageId);
          const prior = turn.providerMessageId ? providerTurns.get(turn.providerMessageId) : null;
          if (prior && !sameTurn(prior, turn)) {
            reason = 'compatibility_drift';
            return { ok: false, added: 0, failure: 'compatibility-drift' };
          }
        }
        if (windowHasProviderPositions) {
          if (!transcript.every(hasProviderPosition)) {
            reason = 'compatibility_drift';
            return { ok: false, added: 0, failure: 'provider-position-coverage-changed' };
          }
          for (let index = 1; index < window.length; index += 1) {
            if (compareProviderPosition(window[index], window[index - 1]) <= 0) {
              reason = 'compatibility_drift';
              return { ok: false, added: 0, failure: 'provider-order-changed' };
            }
          }
          const additions = window.filter((turn) => !providerPositionTurns.has(providerPositionKey(turn)));
          const addedBytes = additions.reduce((total, turn) => total + turnBytes(turn), 0);
          if (byteCount + addedBytes > cap) {
            reason = 'max_capture_bytes';
            return { ok: false, added: 0, failure: 'capture-limit' };
          }
          transcript = [...transcript, ...additions]
            .sort(compareProviderPosition);
          for (const turn of additions) {
            const positionKey = providerPositionKey(turn);
            providerPositionObservationCounts.set(positionKey, 1);
            unsettledProviderPositions.add(positionKey);
          }
          byteCount += addedBytes;
          return { ok: true, added: additions.length, refreshed };
        }
        if (windowHasAnyProviderPosition) {
          reason = 'compatibility_drift';
          return { ok: false, added: 0, failure: 'provider-position-coverage-changed' };
        }
        if (window.every((turn) => turn.providerMessageId)) {
          const known = [];
          const novel = [];
          for (let windowIndex = 0; windowIndex < window.length; windowIndex += 1) {
            const providerMessageId = window[windowIndex].providerMessageId;
            if (providerIndices.has(providerMessageId)) {
              known.push({ windowIndex, transcriptIndex: providerIndices.get(providerMessageId) });
            } else {
              novel.push(windowIndex);
            }
          }
          if (known.length > 0) {
            for (let index = 1; index < known.length; index += 1) {
              if (known[index].transcriptIndex <= known[index - 1].transcriptIndex) {
                reason = 'compatibility_drift';
                return { ok: false, added: 0, failure: 'provider-order-changed' };
              }
            }
            if (!novel.length) return { ok: true, added: 0 };
            const firstKnown = known[0];
            const lastKnown = known[known.length - 1];
            const additions = direction === 'prepend' && firstKnown.transcriptIndex === 0 &&
                novel.every((windowIndex) => windowIndex < firstKnown.windowIndex)
              ? window.slice(0, firstKnown.windowIndex)
              : direction === 'append' && lastKnown.transcriptIndex === transcript.length - 1 &&
                  novel.every((windowIndex) => windowIndex > lastKnown.windowIndex)
                ? window.slice(lastKnown.windowIndex + 1)
                : null;
            if (additions) {
              const addedBytes = additions.reduce((total, turn) => total + turnBytes(turn), 0);
              if (byteCount + addedBytes > cap) {
                reason = 'max_capture_bytes';
                return { ok: false, added: 0, failure: 'capture-limit' };
              }
              transcript = direction === 'prepend'
                ? [...additions, ...transcript]
                : [...transcript, ...additions];
              byteCount += addedBytes;
              return { ok: true, added: additions.length };
            }
          }
        }
        if (window.length <= transcript.length) {
          for (let start = 0; start <= transcript.length - window.length; start += 1) {
            if (sameSlice(transcript, start, window, 0, window.length)) {
              return { ok: true, added: 0 };
            }
          }
        }
        const limit = Math.min(window.length, transcript.length);
        const candidates = [];
        for (let overlap = 1; overlap <= limit; overlap += 1) {
          const matches = direction === 'prepend'
            ? sameSlice(window, window.length - overlap, transcript, 0, overlap)
            : sameSlice(transcript, transcript.length - overlap, window, 0, overlap);
          if (matches) candidates.push(overlap);
        }
        if (!candidates.length) {
          return { ok: false, added: 0, failure: 'no-overlap' };
        }
        const overlap = candidates[candidates.length - 1];
        const additions = direction === 'prepend'
          ? window.slice(0, window.length - overlap)
          : window.slice(overlap);
        if (additions.length > 0 && candidates.length > 1 && fallbackIsAmbiguous([...transcript, ...window])) {
          reason = 'ambiguous_message_overlap';
          return { ok: false, added: 0, failure: 'ambiguous-fallback' };
        }
        const addedBytes = additions.reduce((total, turn) => total + turnBytes(turn), 0);
        if (byteCount + addedBytes > cap) {
          reason = 'max_capture_bytes';
          return { ok: false, added: 0, failure: 'capture-limit' };
        }
        transcript = direction === 'prepend'
          ? [...additions, ...transcript]
          : [...transcript, ...additions];
        byteCount += addedBytes;
        return { ok: true, added: additions.length };
      };

      const merge = (window, direction, options = {}) => {
        const result = mergeWindow(window, direction, options);
        if (result.ok) acceptUnavailableTextHydrations(window);
        return { ...result, observedWindow: window };
      };
      const visibleWindowHasUnsettledProviderState = (window) => window.some((turn) => {
        const positionKey = providerPositionKey(turn);
        const ownerKey = Number.isSafeInteger(turn.providerTurnIndex)
          ? String(turn.providerTurnIndex)
          : null;
        return (positionKey ? unsettledProviderPositions.has(positionKey) : false) ||
          (ownerKey ? unsettledProviderOwners.has(ownerKey) : false);
      });
      const resultHasStableObservedWindow = (result) => result.ok &&
        (result.refreshed || 0) <= 0 &&
        Array.isArray(result.observedWindow) &&
        result.observedWindow.length > 0 &&
        !visibleWindowHasUnsettledProviderState(result.observedWindow);
      const confirmStableWindow = async (direction, initialResult) => {
        let result = initialResult;
        for (let retry = 0; result.ok && retry < providerPositionStabilityObservations * 2; retry += 1) {
          await settleProviderObservation();
          const observedWindow = readMessages();
          result = merge(observedWindow, direction);
          if (resultHasStableObservedWindow(result)) return result;
        }
        if (result.ok) {
          reason = 'compatibility_drift';
          return { ok: false, added: 0, failure: 'provider-position-did-not-settle' };
        }
        return result;
      };

      const findScroller = () => {
        const firstMessage = messageNodes()[0] || null;
        const candidates = [];
        const seen = new Set();
        const add = (node) => {
          if (!node || seen.has(node)) return;
          seen.add(node);
          candidates.push(node);
        };
        for (let node = firstMessage; node && node !== document.documentElement; node = node.parentElement) add(node);
        add(document.querySelector('main'));
        add(document.scrollingElement);
        add(document.documentElement);
        add(document.body);
        const ranked = candidates
          .filter((node) => Number.isFinite(node.scrollHeight) && Number.isFinite(node.clientHeight) && node.clientHeight > 32)
          .map((node) => {
            const overflow = node.scrollHeight - node.clientHeight;
            const containsMessage = !!firstMessage && node.contains(firstMessage);
            const messageCount = node.querySelectorAll?.(messageSelector).length || 0;
            const overflowY = String(getComputedStyle(node).overflowY || '').toLowerCase();
            const isDocumentScroller = node === document.scrollingElement || node === document.documentElement || node === document.body;
            const acceptsVerticalScroll = isDocumentScroller || /auto|scroll|overlay/.test(overflowY);
            return {
              node,
              overflow,
              score: (overflow > 8 && acceptsVerticalScroll ? 1_000_000 : 0) +
                (containsMessage ? 10_000 : 0) +
                (messageCount * 100) +
                Math.min(node.clientHeight, 2_000) * 1_000 +
                Math.max(0, overflow)
            };
          })
          .sort((left, right) => right.score - left.score);
        const movable = ranked.find(({ node, overflow }) => {
          if (overflow <= 1) return false;
          const previousTop = node.scrollTop;
          const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
          node.scrollTop = previousTop >= maximum - 1
            ? Math.max(0, previousTop - 1)
            : Math.min(previousTop + 1, maximum);
          const moved = node.scrollTop !== previousTop;
          node.scrollTop = previousTop;
          return moved;
        });
        if (movable) return movable.node;
        const windowScroller = {
          get scrollTop() {
            return Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0, document.body?.scrollTop || 0);
          },
          set scrollTop(value) {
            window.scrollTo(0, Math.max(0, Number(value) || 0));
          },
          get scrollHeight() {
            return Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
          },
          get clientHeight() {
            return Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
          }
        };
        if (windowScroller.scrollHeight - windowScroller.clientHeight > 1) {
          const previousTop = windowScroller.scrollTop;
          const maximum = windowScroller.scrollHeight - windowScroller.clientHeight;
          windowScroller.scrollTop = previousTop >= maximum - 1
            ? Math.max(0, previousTop - 1)
            : Math.min(previousTop + 1, maximum);
          const moved = windowScroller.scrollTop !== previousTop;
          windowScroller.scrollTop = previousTop;
          if (moved) return windowScroller;
        }
        return ranked.every(({ overflow }) => overflow <= 1) ? ranked[0]?.node || null : null;
      };

      const initial = readMessages();
      windowCount += 1;
      if (!initial.length || mappedInputInvalid) {
        const generationActiveAfter = generationIsActive();
        return {
          status: 'partial',
          reason: mappedInputInvalid || unresolvedTurnOwnerShells.size > 0
            ? 'compatibility_drift'
            : generationActiveBefore || generationActiveAfter
            ? 'conversation_generation_active'
            : 'conversation_messages_not_found',
          rawTurns: [],
          evidence: {
            topBoundary: false,
            bottomBoundary: false,
            orderedWindowStitching: false,
            scrollPasses: 0,
            windowCount,
            messageCount: 0,
            providerIdCount: 0,
            byteCount: 0
          }
        };
      }
      windowCount -= 1;

      const scroller = findScroller();
      let scrollPasses = 0;
      let topBoundary = false;
      let bottomBoundary = false;
      if (!scroller) {
        adopt(initial);
        let quietPasses = 0;
        for (let topPasses = 0; !reason && topPasses < 100; topPasses += 1) {
          scrollPasses += 1;
          const firstMessage = messageNodes()[0];
          if (!firstMessage) {
            reason = 'conversation_messages_not_found';
            break;
          }
          const beforeTop = firstMessage.getBoundingClientRect().top;
          firstMessage.scrollIntoView({ block: 'end', behavior: 'instant' });
          await settle();
          let result = merge(readMessages(), 'prepend', { allowTextRefresh: true });
          result = await confirmStableWindow('prepend', result);
          const afterTop = firstMessage.isConnected ? firstMessage.getBoundingClientRect().top : Number.NaN;
          const moved = !Number.isFinite(afterTop) || Math.abs(afterTop - beforeTop) > 2;
          if (!result.ok) {
            if (!reason) reason = 'ambiguous_message_overlap';
            break;
          }
          if (result.added > 0 || result.refreshed > 0 || moved) {
            quietPasses = 0;
            continue;
          }
          quietPasses += 1;
          if (quietPasses >= 4) {
            topBoundary = true;
            break;
          }
          await wait(250 * quietPasses);
        }
        if (!reason && !topBoundary) {
          reason = 'conversation_capture_limit_reached';
        }

        quietPasses = 0;
        for (let bottomPasses = 0; !reason && bottomPasses < 100; bottomPasses += 1) {
          scrollPasses += 1;
          const messages = messageNodes();
          const lastMessage = messages[messages.length - 1];
          if (!lastMessage) {
            reason = 'conversation_messages_not_found';
            break;
          }
          const beforeTop = lastMessage.getBoundingClientRect().top;
          lastMessage.scrollIntoView({ block: 'start', behavior: 'instant' });
          await settle();
          let result = merge(readMessages(), 'append');
          result = await confirmStableWindow('append', result);
          const afterTop = lastMessage.isConnected ? lastMessage.getBoundingClientRect().top : Number.NaN;
          const moved = !Number.isFinite(afterTop) || Math.abs(afterTop - beforeTop) > 2;
          if (!result.ok) {
            if (!reason) reason = 'ambiguous_message_overlap';
            break;
          }
          if (result.added > 0 || moved) {
            quietPasses = 0;
            continue;
          }
          quietPasses += 1;
          if (quietPasses >= 4) {
            bottomBoundary = true;
            break;
          }
          await wait(250 * quietPasses);
        }
        if (!reason && !bottomBoundary) {
          reason = 'conversation_capture_limit_reached';
        }
      } else {
        const originalTop = scroller.scrollTop;
        const recoverDisjointWindow = async (direction, previousScrollTop, attemptedScrollTop) => {
          const boundary = direction === 'prepend' ? transcript[0] : transcript[transcript.length - 1];
          if (!boundary?.providerMessageId) {
            reason = 'ambiguous_message_overlap';
            return { ok: false, added: 0, failure: 'unanchored-overlap' };
          }
          const block = direction === 'prepend' ? 'end' : 'start';
          const movedInDirection = () => direction === 'prepend'
            ? scroller.scrollTop < previousScrollTop - 0.5
            : scroller.scrollTop > previousScrollTop + 0.5;
          for (let retry = 0; retry < 6; retry += 1) {
            scroller.scrollTop = previousScrollTop;
            await wait(120 + (retry * 80));
            const anchor = messageNodeForProviderId(boundary.providerMessageId);
            if (anchor) {
              anchor.scrollIntoView({ block, behavior: 'instant' });
              await wait(120 + (retry * 80));
              const anchored = merge(readMessages(), direction);
              if ((anchored.ok && (anchored.added > 0 || movedInDirection())) ||
                  (!anchored.ok && anchored.failure !== 'no-overlap')) return anchored;
            }

            const divisor = 2 ** (retry + 1);
            const bridgeTop = previousScrollTop + ((attemptedScrollTop - previousScrollTop) / divisor);
            if (Math.abs(bridgeTop - previousScrollTop) <= 0.5) break;
            scroller.scrollTop = bridgeTop;
            await wait(120 + (retry * 80));
            const bridged = merge(readMessages(), direction);
            if ((bridged.ok && (bridged.added > 0 || movedInDirection())) ||
                (!bridged.ok && bridged.failure !== 'no-overlap')) return bridged;
          }
          reason = 'ambiguous_message_overlap';
          return { ok: false, added: 0, failure: 'overlap-recovery-exhausted' };
        };
        try {
          const topStartedAt = performance.now();
          let quietPasses = 0;
          let stillPasses = 0;
          for (let topPasses = 0; !reason && topPasses < 60; topPasses += 1) {
            scrollPasses += 1;
            if (performance.now() - topStartedAt >= 15_000) {
              reason = 'conversation_capture_timeout';
              legacyDiagnosticReason = 'conversation_top_capture_timeout';
              break;
            }
            const firstMessage = messageNodes()[0];
            if (!firstMessage) {
              reason = 'conversation_messages_not_found';
              break;
            }
            const beforeTop = firstMessage.getBoundingClientRect().top;
            const previousScrollTop = scroller.scrollTop;
            if (previousScrollTop > 1) {
              scroller.scrollTop = 0;
            } else {
              firstMessage.scrollIntoView({ block: 'end', behavior: 'instant' });
              scroller.scrollTop = 0;
            }
            await settle();
            const attemptedScrollTop = scroller.scrollTop;
            let result = merge(readMessages(), 'prepend', { allowTextRefresh: true });
            if (!result.ok && result.failure === 'no-overlap') {
              result = await recoverDisjointWindow('prepend', previousScrollTop, attemptedScrollTop);
            }
            result = await confirmStableWindow('prepend', result);
            const afterTop = firstMessage.isConnected ? firstMessage.getBoundingClientRect().top : Number.NaN;
            const moved = scroller.scrollTop < previousScrollTop ||
              !Number.isFinite(afterTop) || Math.abs(afterTop - beforeTop) > 2;
            if (!result.ok) {
              if (!reason) reason = 'ambiguous_message_overlap';
              break;
            }
            if (result.added > 0 || result.refreshed > 0 || moved) {
              quietPasses = 0;
              stillPasses = 0;
              continue;
            }
            if (scroller.scrollTop <= 1) {
              quietPasses += 1;
              if (quietPasses >= 4) {
                topBoundary = true;
                break;
              }
              await wait(250 * quietPasses);
              continue;
            }
            quietPasses = 0;
            stillPasses += 1;
            if (stillPasses >= 3) {
              reason = 'conversation_scroll_stalled';
              legacyDiagnosticReason = 'conversation_top_scroll_stalled';
              break;
            }
          }
          if (!reason && !topBoundary) reason = 'conversation_top_not_reached';

          const downStartedAt = performance.now();
          const maxDownwardNavigationPasses = 4_000;
          const maxDownwardGapProofPasses = maxProviderGapSpan * maxGapScanSteps;
          const maxDownwardCaptureMs = 300_000;
          let downwardNavigationPasses = 0;
          let downwardGapProofPasses = 0;
          let bottomQuietPasses = 0;
          let downwardProviderFrontier = 0;
          let downwardSearchLower = null;
          let downwardSearchUpper = null;
          let downwardSearchExpectedTop = null;
          let downwardSearchPreviousSnapshot = null;
          let downwardSearchCandidateOrdinals = [];
          let downwardSearchSuccessorOrdinal = null;
          let downwardSearchSawPredecessor = false;
          let downwardSearchSawSuccessor = false;
          let downwardSearchStartedAt = null;
          const observedTurnOwnerMessageCounts = new Map();
          const maxGapScrollPositionRetries = 6;
          const settleGapScan = async () => {
            if (typeof requestAnimationFrame === 'function') {
              await new Promise((resolve) => requestAnimationFrame(() => resolve()));
              return;
            }
            await wait(1);
          };
          const restoreGapScrollPosition = async (expectedTop) => {
            let adjusted = false;
            for (let attempt = 0; attempt < maxGapScrollPositionRetries; attempt += 1) {
              if (Math.abs(scroller.scrollTop - expectedTop) <= 0.5) return { ok: true, adjusted };
              adjusted = true;
              scroller.scrollTop = expectedTop;
              await settleGapScan();
            }
            return {
              ok: Math.abs(scroller.scrollTop - expectedTop) <= 0.5,
              adjusted
            };
          };
          const resetDownwardSearch = () => {
            downwardSearchLower = null;
            downwardSearchUpper = null;
            downwardSearchExpectedTop = null;
            downwardSearchPreviousSnapshot = null;
            downwardSearchCandidateOrdinals = [];
            downwardSearchSuccessorOrdinal = null;
            downwardSearchSawPredecessor = false;
            downwardSearchSawSuccessor = false;
            downwardSearchStartedAt = null;
          };
          const nextDownwardScrollTop = (top, maximum) => {
            const mappedNodes = messageNodes();
            const turnOwners = Array.from(document.querySelectorAll(turnOrdinalSelector));
            const scrollerRectangle = scroller.getBoundingClientRect?.();
            const viewportTop = Number.isFinite(scrollerRectangle?.top) ? scrollerRectangle.top : 0;
            const viewportBottom = viewportTop + Math.max(1, scroller.clientHeight);
            const rectangleForNode = (node) => {
              const turnOwner = node?.closest?.(turnOrdinalSelector);
              const ownerRectangle = turnOwner?.getBoundingClientRect?.();
              return ownerRectangle &&
                  Number.isFinite(ownerRectangle.top) && Number.isFinite(ownerRectangle.bottom)
                ? ownerRectangle
                : node?.getBoundingClientRect?.();
            };
            const intersectsViewport = (node) => {
              const rectangle = rectangleForNode(node);
              return Number.isFinite(rectangle?.top) && Number.isFinite(rectangle?.bottom) &&
                rectangle.bottom > viewportTop && rectangle.top < viewportBottom;
            };
            const nodesByOrdinal = new Map();
            const viewportNodesByOrdinal = new Map();
            const mappedCountsByOrdinal = new Map();
            const viewportMappedOrdinals = new Set();
            for (const node of mappedNodes) {
              const ordinal = providerTurnIndexForNode(node);
              if (Number.isSafeInteger(ordinal)) {
                mappedCountsByOrdinal.set(ordinal, (mappedCountsByOrdinal.get(ordinal) || 0) + 1);
                if (intersectsViewport(node)) viewportMappedOrdinals.add(ordinal);
                observedTurnOwnerMessageCounts.set(
                  ordinal,
                  Math.max(observedTurnOwnerMessageCounts.get(ordinal) || 0, mappedCountsByOrdinal.get(ordinal))
                );
              }
              const text = transcriptTextForNode(node);
              if (
                Number.isSafeInteger(ordinal) &&
                text.trim().length > 0
              ) {
                nodesByOrdinal.set(ordinal, node);
                if (intersectsViewport(node)) viewportNodesByOrdinal.set(ordinal, node);
              }
            }
            const viewportOwnerOrdinals = new Set();
            for (const owner of turnOwners) {
              const matched = /^conversation-turn-(\\d+)$/.exec(owner.getAttribute?.('data-testid') || '');
              const ordinal = matched ? Number(matched[1]) : null;
              if (!Number.isSafeInteger(ordinal)) continue;
              if (intersectsViewport(owner)) viewportOwnerOrdinals.add(ordinal);
              const mappedCount = (owner.matches?.(messageSelector) ? 1 : 0) +
                (owner.querySelectorAll?.(messageSelector)?.length || 0);
              observedTurnOwnerMessageCounts.set(
                ordinal,
                Math.max(observedTurnOwnerMessageCounts.get(ordinal) || 0, mappedCount)
              );
            }
            let target = nodesByOrdinal.get(downwardProviderFrontier) || null;
            let frontierAdvanced = false;
            const capturedProviderOrdinals = new Set(
              transcript.filter(hasProviderPosition).map((turn) => turn.providerTurnIndex)
            );
            while (
              nodesByOrdinal.has(downwardProviderFrontier + 1) ||
              capturedProviderOrdinals.has(downwardProviderFrontier + 1) ||
              provenAbsentProviderOrdinals.has(downwardProviderFrontier + 1)
            ) {
              downwardProviderFrontier += 1;
              target = nodesByOrdinal.get(downwardProviderFrontier) || target;
              frontierAdvanced = true;
            }
            if (frontierAdvanced) {
              resetDownwardSearch();
            }
            const missingOrdinal = downwardProviderFrontier + 1;
            const nearVisibleFutureOrdinals = [...viewportNodesByOrdinal.keys()]
              .filter((ordinal) => ordinal > missingOrdinal && ordinal <= missingOrdinal + maxProviderGapSpan);
            if (nearVisibleFutureOrdinals.length > 0) {
              if (downwardSearchUpper === null) {
                const successorOrdinal = Math.min(...nearVisibleFutureOrdinals);
                const servedScrollInterval = (node) => {
                  const rectangle = rectangleForNode(node);
                  if (
                    !Number.isFinite(rectangle?.top) ||
                    !Number.isFinite(rectangle?.bottom) ||
                    rectangle.bottom <= rectangle.top
                  ) return null;
                  return {
                    lower: Math.floor(top + rectangle.top - viewportBottom) + 1,
                    upper: Math.ceil(top + rectangle.bottom - viewportTop) - 1
                  };
                };
                const successorInterval = servedScrollInterval(
                  viewportNodesByOrdinal.get(successorOrdinal)
                );
                const predecessorOrdinal = missingOrdinal - 1;
                const predecessorInterval = predecessorOrdinal === 0 && topBoundary
                  ? { lower: 0, upper: Number.POSITIVE_INFINITY }
                  : servedScrollInterval(nodesByOrdinal.get(predecessorOrdinal));
                if (!successorInterval || (predecessorOrdinal === 0 && !predecessorInterval)) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                const overlapLower = predecessorInterval
                  ? Math.max(
                      0,
                      predecessorOrdinal === 0 ? 0 : predecessorInterval.lower,
                      successorInterval.lower
                    )
                  : null;
                const overlapUpper = predecessorInterval
                  ? Math.min(
                      maximum,
                      predecessorInterval.upper,
                      successorInterval.upper
                    )
                  : null;
                const overlapSampleCount = overlapLower === null || overlapUpper === null
                  ? 0
                  : overlapUpper - overlapLower + 1;
                const needsOvershootRecovery = predecessorOrdinal > 0 && overlapSampleCount <= 2;
                const searchLower = needsOvershootRecovery
                  ? Math.ceil(Math.max(0, top - scroller.clientHeight))
                  : overlapLower;
                const searchUpper = needsOvershootRecovery
                  ? Math.floor(Math.min(maximum, top + scroller.clientHeight))
                  : overlapUpper;
                const gapScanSampleCount = searchUpper - searchLower + 1;
                if (!Number.isSafeInteger(searchLower) || !Number.isSafeInteger(searchUpper)) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                if (gapScanSampleCount <= 2) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                if (gapScanSampleCount > maxGapScanSteps) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                downwardSearchLower = searchLower;
                downwardSearchUpper = searchUpper;
                downwardSearchSuccessorOrdinal = successorOrdinal;
                downwardSearchCandidateOrdinals = Array.from(
                  { length: successorOrdinal - missingOrdinal },
                  (_unused, offset) => missingOrdinal + offset
                );
                downwardSearchStartedAt = performance.now();
                downwardSearchExpectedTop = downwardSearchLower;
                return downwardSearchLower;
              }
            }
            if (downwardSearchUpper !== null) {
              if (performance.now() - downwardSearchStartedAt >= maxGapScanMs) {
                reason = 'ambiguous_message_overlap';
                return top;
              }
              const servedOrdinals = new Set([
                ...viewportMappedOrdinals,
                ...viewportOwnerOrdinals
              ]);
              const servedProviderIds = new Set(mappedNodes
                .filter(intersectsViewport)
                .map((node) => providerMessageIdForNode(node))
                .filter(Boolean));
              const sortedServedOrdinals = [...servedOrdinals].sort((left, right) => left - right);
              if (!sortedServedOrdinals.length) {
                reason = 'ambiguous_message_overlap';
                return top;
              }
              const predecessorOrdinal = downwardSearchCandidateOrdinals[0] - 1;
              const snapshot = {
                top,
                low: sortedServedOrdinals[0],
                high: sortedServedOrdinals[sortedServedOrdinals.length - 1],
                providerIds: servedProviderIds
              };
              if (downwardSearchPreviousSnapshot) {
                const previous = downwardSearchPreviousSnapshot;
                const scrollConnected = top >= previous.top - 0.5 && top - previous.top <= 1.5;
                const sharesProviderAnchor = [...servedProviderIds].some((id) => previous.providerIds.has(id));
                const ordinalRangesConnect = snapshot.low <= previous.high + 1 && previous.low <= snapshot.high + 1;
                if (!scrollConnected || (!sharesProviderAnchor && !ordinalRangesConnect)) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
              }
              downwardSearchPreviousSnapshot = snapshot;
              downwardSearchSawPredecessor ||= predecessorOrdinal === 0
                ? topBoundary
                : servedOrdinals.has(predecessorOrdinal);
              downwardSearchSawSuccessor ||= servedOrdinals.has(downwardSearchSuccessorOrdinal);
              if (top >= downwardSearchUpper) {
                const candidateOrdinals = new Set(downwardSearchCandidateOrdinals);
                const observedCandidate = downwardSearchCandidateOrdinals.some((ordinal) =>
                  (observedTurnOwnerMessageCounts.get(ordinal) || 0) > 0
                ) || transcript.some((turn) => candidateOrdinals.has(turn.providerTurnIndex));
                if (observedCandidate) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                if (!downwardSearchSawPredecessor) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                if (!downwardSearchSawSuccessor) {
                  reason = 'ambiguous_message_overlap';
                  return top;
                }
                for (const ordinal of downwardSearchCandidateOrdinals) {
                  provenAbsentProviderOrdinals.add(ordinal);
                }
                downwardProviderFrontier = downwardSearchSuccessorOrdinal - 1;
                resetDownwardSearch();
                return nextDownwardScrollTop(top, maximum);
              }
              const nextTop = Math.min(downwardSearchUpper, Math.floor(top) + 1);
              downwardSearchExpectedTop = nextTop;
              return nextTop;
            }
            const step = Math.max(240, Math.floor(scroller.clientHeight * 0.8));
            if (!target) return Math.min(maximum, top + step);
            const rectangle = rectangleForNode(target);
            const targetBottom = Number.isFinite(rectangle?.bottom) ? rectangle.bottom : null;
            const targetTop = Number.isFinite(rectangle?.top) ? rectangle.top : null;
            const overlap = Math.max(1, Math.floor(scroller.clientHeight * 0.2));
            const spansViewport = targetTop !== null && targetBottom !== null &&
              targetTop <= viewportTop + 1 && targetBottom > viewportBottom + 1;
            const distance = targetTop !== null && targetTop > viewportTop + 1
              ? targetTop - viewportTop
              : spansViewport
                ? targetBottom - viewportTop + 1
                : targetBottom !== null && targetBottom > viewportTop + overlap
                  ? targetBottom - viewportTop - overlap
                  : step;
            return Math.min(maximum, top + Math.max(1, distance));
          };
          while (!reason) {
            scrollPasses += 1;
            if (performance.now() - downStartedAt >= maxDownwardCaptureMs) {
              reason = 'conversation_capture_timeout';
              break;
            }
            const restoredGapPosition = downwardSearchUpper !== null
              ? await restoreGapScrollPosition(downwardSearchExpectedTop)
              : { ok: true, adjusted: false };
            if (!restoredGapPosition.ok) {
              reason = 'ambiguous_message_overlap';
              break;
            }
            if (downwardSearchUpper !== null) {
              if (downwardGapProofPasses >= maxDownwardGapProofPasses) {
                reason = 'conversation_capture_limit_reached';
                break;
              }
              downwardGapProofPasses += 1;
            } else {
              if (downwardNavigationPasses >= maxDownwardNavigationPasses) {
                reason = 'conversation_capture_limit_reached';
                break;
              }
              downwardNavigationPasses += 1;
            }
            if (restoredGapPosition.adjusted) {
              let result = merge(readMessages(), 'append');
              result = await confirmStableWindow('append', result);
              if (!result.ok) {
                if (!reason) reason = 'ambiguous_message_overlap';
                break;
              }
              continue;
            }
            const top = scroller.scrollTop;
            const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            if (top >= maximum - 1) {
              const recoveryTop = nextDownwardScrollTop(top, maximum);
              if (Math.abs(recoveryTop - top) > 0.5) {
                scroller.scrollTop = recoveryTop;
                await (downwardSearchUpper !== null ? settleGapScan() : settle());
                let result = merge(readMessages(), 'append');
                result = await confirmStableWindow('append', result);
                if (!result.ok) {
                  if (!reason) reason = 'ambiguous_message_overlap';
                  break;
                }
                bottomQuietPasses = 0;
                continue;
              }
              if (reason) break;
              await settle();
              let result = merge(readMessages(), 'append');
              if (!result.ok && result.failure === 'no-overlap') {
                result = await recoverDisjointWindow('append', top, scroller.scrollTop);
              }
              result = await confirmStableWindow('append', result);
              if (!result.ok) {
                if (!reason) reason = 'ambiguous_message_overlap';
                break;
              }
              const settledMaximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
              if (result.added > 0 || scroller.scrollTop < settledMaximum - 1) {
                bottomQuietPasses = 0;
                continue;
              }
              bottomQuietPasses += 1;
              if (bottomQuietPasses >= 4) {
                bottomBoundary = true;
                break;
              }
              await wait(250 * bottomQuietPasses);
              continue;
            }
            bottomQuietPasses = 0;
            const requestedScrollTop = nextDownwardScrollTop(top, maximum);
            const scanningProviderGap = downwardSearchUpper !== null;
            const movingBackward = requestedScrollTop < top - 0.5;
            scroller.scrollTop = requestedScrollTop;
            await (scanningProviderGap ? settleGapScan() : settle());
            const attemptedScrollTop = scroller.scrollTop;
            let result = merge(readMessages(), 'append');
            if (!result.ok && result.failure === 'no-overlap') {
              result = await recoverDisjointWindow('append', top, attemptedScrollTop);
            }
            result = await confirmStableWindow('append', result);
            if (!result.ok) {
              if (!reason) reason = 'ambiguous_message_overlap';
              break;
            }
            if (
              !scanningProviderGap &&
              !movingBackward &&
              scroller.scrollTop <= top &&
              scroller.scrollHeight - scroller.clientHeight > top + 1
            ) {
              reason = 'conversation_scroll_stalled';
              break;
            }
          }
        } finally {
          scroller.scrollTop = originalTop;
        }
      }

      const leadingTurnMissing = topBoundary && transcript[0]?.role === 'assistant';
      if (!reason && hasUnresolvedStructuralState()) reason = 'compatibility_drift';
      const captureStructure = !reason ? orderedCaptureStructure() : null;
      if (!reason && captureStructure) {
        // A clean assistant-first head can begin at a later provider turn: that
        // is the evidence for conversation_leading_turn_missing. It must still
        // begin at part zero and every served position after it must be ordered.
        const startsAtProviderTurnBoundary = captureStructure[0]?.providerTurnPartIndex === 0;
        let providerPositionsComplete = startsAtProvenProviderBoundary(captureStructure[0]) ||
          (leadingTurnMissing && startsAtProviderTurnBoundary);
        for (let index = 1; providerPositionsComplete && index < captureStructure.length; index += 1) {
          const previous = captureStructure[index - 1];
          const turn = captureStructure[index];
          if (!followsProviderPosition(previous, turn)) {
            providerPositionsComplete = false;
          }
        }
        if (!providerPositionsComplete) {
          reason = 'ambiguous_message_overlap';
        }
      } else if (!reason) {
        reason = 'compatibility_drift';
      }
      // A few mapped messages with no transcript text are ordinary image-only
      // turns. A fully served conversation where no mapped message produced any
      // text is text extraction failing against changed provider markup, not a
      // thread made entirely of images: a real conversation always carries at
      // least one text turn. Require both boundaries and a minimum message count
      // so a small or partially served window cannot manufacture drift.
      const TEXTLESS_CONVERSATION_DRIFT_MIN_MESSAGES = 4;
      const hasTranscriptText = (turn) => typeof turn.text === 'string' && turn.text.trim().length > 0;
      const textBearingTurnCount = transcript.filter(hasTranscriptText).length;
      if (
        !reason &&
        topBoundary &&
        bottomBoundary &&
        textBearingTurnCount === 0 &&
        unresolvedMessageSignatures.size >= TEXTLESS_CONVERSATION_DRIFT_MIN_MESSAGES
      ) {
        reason = 'compatibility_drift';
      }
      if (!reason && unresolvedMessageSignatures.size > 0) reason = 'conversation_message_text_unavailable';
      // The scroller quieted at the top of what the provider served, and that
      // head is an assistant turn: either the thread truly opens that way or
      // turn 1 was withheld. Report that only after structure and mapped text
      // are sound; those failures carry stronger evidence about the capture.
      // The top boundary remains proven, so a caller can distinguish this from
      // a scroll that fell short. Recovering turn 1 needs export import, not
      // another capture pass.
      if (!reason && leadingTurnMissing) {
        reason = 'conversation_leading_turn_missing';
      }
      if (!reason && (!topBoundary || !bottomBoundary)) {
        reason = !topBoundary ? 'conversation_top_not_reached' : 'conversation_scroll_stalled';
      }
      const generationActiveAfter = generationIsActive();
      if (generationActiveBefore || generationActiveAfter) reason = 'conversation_generation_active';
      const rawTurns = transcript
        .filter(hasTranscriptText)
        .map((turn, ordinal) => ({
          ordinal,
          providerMessageId: turn.providerMessageId,
          role: turn.role,
          text: turn.text
        }));
      const publishedByteCount = rawTurns.reduce((total, turn) => total + turnBytes(turn), 0);
      const evidence = {
        topBoundary,
        bottomBoundary,
        orderedWindowStitching: ![
          'ambiguous_message_overlap',
          'compatibility_drift'
        ].includes(reason),
        scrollPasses,
        windowCount: Math.max(1, windowCount),
        messageCount: rawTurns.length,
        providerIdCount: rawTurns.filter((turn) => turn.providerMessageId !== null).length,
        byteCount: publishedByteCount
      };
      const captureWindow = reason
        ? { status: 'partial', reason, rawTurns, evidence }
        : { status: 'complete', rawTurns, evidence };
      const artifactBoundaryInvalid = !topBoundary || !bottomBoundary || [
        'ambiguous_message_overlap',
        'conversation_capture_limit_reached',
        'conversation_capture_timeout',
        'conversation_scroll_stalled',
        'conversation_top_not_reached'
      ].includes(reason);
      const artifactReason = artifactInputInvalid
        ? 'compatibility_drift'
        : generationActiveBefore || generationActiveAfter
          ? 'conversation_generation_active'
          : artifactBoundaryInvalid
            ? reason === 'conversation_capture_timeout'
              ? 'conversation_capture_timeout'
              : 'conversation_boundary_incomplete'
            : null;
      const artifactItems = [...conversationArtifacts.values()]
        .sort((left, right) =>
          left.providerTurnIndex - right.providerTurnIndex ||
          left.occurrenceWithinMessage - right.occurrenceWithinMessage
        );
      const artifactInventory = artifactReason
        ? { status: 'partial', reason: artifactReason, items: artifactItems }
        : { status: 'complete', items: artifactItems };
      const publishedCaptureWindow = includeLegacyDiagnostic && legacyDiagnosticReason
        ? { ...captureWindow, legacyDiagnosticReason }
        : captureWindow;
      return { captureWindow: publishedCaptureWindow, artifactInventory };
      })()`);
    } catch (error) {
      if (error?.code !== 'conversation_capture_timeout') throw error;
      return {
        captureWindow: partialCaptureWindow('conversation_capture_timeout'),
        artifactInventory: emptyPartialConversationArtifactInventory('conversation_capture_timeout')
      };
    }
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
      return {
        captureWindow: partialCaptureWindow(),
        artifactInventory: emptyPartialConversationArtifactInventory()
      };
    }
    // Keep narrow page doubles that model only the historical transcript
    // scanner usable. The live evaluator always returns the bundle shape.
    if (captured.status === 'complete' || captured.status === 'partial') {
      captured = {
        captureWindow: captured,
        artifactInventory: { status: 'complete', items: [] }
      };
    }
    const rawInventory = captured.artifactInventory;
    const rawItems = Array.isArray(rawInventory?.items) ? rawInventory.items : [];
    if (!providerConversationId) {
      return {
        captureWindow: captured.captureWindow,
        artifactInventory: emptyPartialConversationArtifactInventory('artifact_identity_unavailable')
      };
    }
    let items;
    try {
      items = rawItems.map((item) => createConversationArtifactDescriptor({
        providerConversationId,
        providerMessageId: item?.providerMessageId,
        providerTurnIndex: item?.providerTurnIndex,
        occurrenceWithinMessage: item?.occurrenceWithinMessage,
        name: item?.name,
        kind: item?.kind
      }));
    } catch {
      return {
        captureWindow: captured.captureWindow,
        artifactInventory: emptyPartialConversationArtifactInventory()
      };
    }
    const artifactInventory = parseConversationArtifactInventory(
      rawInventory?.status === 'complete'
        ? { status: 'complete', items }
        : { status: 'partial', reason: rawInventory?.reason || 'compatibility_drift', items }
    );
    return { captureWindow: captured.captureWindow, artifactInventory };
  }

  async readConversationText({ maxChars = 200_000 } = {}) {
    const projectionCap = Math.max(1, Math.min(1_000_000, Math.floor(Number(maxChars) || 200_000)));
    const maxCaptureBytes = Math.min(16 * 1024 * 1024, (projectionCap * 4) + 4096);
    let captureWindow;
    let artifactInventory = emptyPartialConversationArtifactInventory('artifact_identity_unavailable');
    let legacyDiagnosticReason = null;
    try {
      let providerConversationId = null;
      try {
        const target = parseChatGptEntryTarget(await this.getUrl());
        if (target?.kind === 'canonical-conversation') {
          providerConversationId = providerConversationIdFromOwnedLocation(
            locationFromConversationUrl(target.chatUrl)
          );
        }
      } catch {}
      const capturedBundle = await this.#runCaptureWithHostDeadline(
        async () => await this.#captureConversationBundle({
          maxCaptureBytes,
          includeLegacyDiagnostic: true,
          providerConversationId
        })
      );
      ({ legacyDiagnosticReason = null, ...captureWindow } = capturedBundle.captureWindow);
      artifactInventory = capturedBundle.artifactInventory;
    } catch (error) {
      if (error?.code !== 'conversation_capture_timeout') throw error;
      captureWindow = {
        status: 'partial',
        reason: 'conversation_capture_timeout',
        rawTurns: [],
        evidence: {
          topBoundary: false,
          bottomBoundary: false,
          orderedWindowStitching: false,
          scrollPasses: 0,
          windowCount: 1,
          messageCount: 0,
          providerIdCount: 0,
          byteCount: 0
        }
      };
      artifactInventory = emptyPartialConversationArtifactInventory('conversation_capture_timeout');
    }
    return {
      ...projectLegacyConversationWindowText(captureWindow, {
        maxChars: projectionCap,
        legacyDiagnosticReason
      }),
      artifactInventory
    };
  }

  async #locateConversationArtifactTarget(descriptor, { timeoutMs = 20_000 } = {}) {
    const messageSelector = this.#transcriptDependencySelector(
      'transcript-message',
      '[data-message-author-role]'
    );
    const ownerSelector = this.#transcriptDependencySelector(
      'transcript-message-id',
      '[data-message-id]'
    );
    const turnOrdinalSelector = this.#transcriptDependencySelector(
      'transcript-turn-ordinal',
      '[data-testid^="conversation-turn-"]'
    );
    const artifactDownloadSelector = this.#transcriptDependencySelector(
      'conversation-artifact-download-button',
      'button[aria-label="Download file"]'
    );
    const artifactNamedButtonSelector = this.#transcriptDependencySelector(
      'conversation-artifact-named-button',
      'button[aria-label]'
    );
    if (
      !messageSelector ||
      !ownerSelector ||
      !turnOrdinalSelector ||
      !artifactDownloadSelector ||
      !artifactNamedButtonSelector
    ) return { status: 'capture_unavailable' };
    const cap = Math.max(1_000, Math.min(60_000, Math.floor(Number(timeoutMs) || 20_000)));
    return await this.#eval(`(async () => {
      const operation = 'locate-conversation-artifact';
      const target = ${JSON.stringify(descriptor)};
      const messageSelector = ${JSON.stringify(messageSelector)};
      const ownerSelector = ${JSON.stringify(ownerSelector)};
      const turnOrdinalSelector = ${JSON.stringify(turnOrdinalSelector)};
      const artifactDownloadSelector = ${JSON.stringify(artifactDownloadSelector)};
      const artifactNamedButtonSelector = ${JSON.stringify(artifactNamedButtonSelector)};
      const deadline = performance.now() + ${cap};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const served = (node) => {
        if (!node || node.isConnected === false || node.hidden === true) return false;
        if (node.getAttribute?.('aria-hidden') === 'true' || node.hasAttribute?.('inert')) return false;
        if (node.closest?.('[aria-hidden="true"], [inert]')) return false;
        try {
          const style = window.getComputedStyle?.(node);
          return style?.display !== 'none' && style?.visibility !== 'hidden' &&
            style?.visibility !== 'collapse' && style?.contentVisibility !== 'hidden';
        } catch {
          return false;
        }
      };
      const turnOrdinal = (owner) => {
        const matched = /^conversation-turn-(\d+)$/.exec(owner?.getAttribute?.('data-testid') || '');
        return matched ? Number(matched[1]) : null;
      };
      const messageId = (node) => node?.getAttribute?.('data-message-id') ||
        node?.closest?.(ownerSelector)?.getAttribute?.('data-message-id') || null;
      const messagesIn = (owner) => {
        const nodes = Array.from(owner?.querySelectorAll?.(messageSelector) || []);
        if (owner?.matches?.(messageSelector)) nodes.unshift(owner);
        return [...new Set(nodes)];
      };
      const artifactName = (scopeNode, downloadButton) => {
        let container = downloadButton?.parentElement || null;
        let depth = 0;
        while (container && container !== scopeNode && depth < 8) {
          const candidates = Array.from(container.querySelectorAll?.(artifactNamedButtonSelector) || [])
            .filter((candidate) => candidate !== downloadButton && served(candidate))
            .filter((candidate) => String(candidate.getAttribute?.('aria-label') || '').trim() !== 'Download file');
          if (candidates.length === 1) return String(candidates[0].getAttribute?.('aria-label') || '').trim();
          if (candidates.length > 1) return null;
          container = container.parentElement;
          depth += 1;
        }
        return null;
      };
      const scrollParentFor = (node) => {
        let current = node?.parentElement || null;
        while (current) {
          try {
            const style = window.getComputedStyle?.(current);
            if (/(auto|scroll)/.test(String(style?.overflowY || '')) && current.scrollHeight > current.clientHeight) {
              return current;
            }
          } catch {}
          current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      };
      let quietPasses = 0;
      while (performance.now() < deadline) {
        const owners = Array.from(document.querySelectorAll(turnOrdinalSelector)).filter(served);
        const exactOwner = owners.find((owner) => turnOrdinal(owner) === target.providerTurnIndex) || null;
        if (exactOwner) {
          const matchingMessages = messagesIn(exactOwner)
            .filter((node) => String(node.getAttribute?.('data-message-author-role') || '').trim().toLowerCase() === 'assistant')
            .filter((node) => messageId(node) === target.providerMessageId);
          if (matchingMessages.length !== 1) return { status: 'not_found' };
          const downloads = Array.from(exactOwner.querySelectorAll?.(artifactDownloadSelector) || []).filter(served);
          const button = downloads[target.occurrenceWithinMessage] || null;
          if (!button) return { status: 'not_found' };
          const name = artifactName(exactOwner, button);
          if (name !== target.name) return { status: 'name_mismatch' };
          button.scrollIntoView?.({ block: 'center', inline: 'center' });
          await wait(80);
          const rectangle = button.getBoundingClientRect?.();
          if (
            Number(rectangle?.width || 0) > 0 &&
            Number(rectangle?.height || 0) > 0
          ) {
            return {
              status: 'found',
              x: rectangle.left + rectangle.width / 2,
              y: rectangle.top + rectangle.height / 2
            };
          }
        }
        const ordinals = owners.map(turnOrdinal).filter(Number.isSafeInteger).sort((left, right) => left - right);
        const scroller = scrollParentFor(exactOwner || owners[0] || document.body);
        if (!scroller) return { status: 'capture_unavailable' };
        const before = Number(scroller.scrollTop || 0);
        const maximum = Math.max(0, Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0));
        const step = Math.max(240, Math.floor(Number(scroller.clientHeight || 0) * 0.8));
        const shouldMoveUp = ordinals.length === 0 || target.providerTurnIndex < ordinals[0];
        const next = shouldMoveUp
          ? Math.max(0, before - step)
          : Math.min(maximum, before + step);
        scroller.scrollTop = next;
        await wait(140);
        const after = Number(scroller.scrollTop || 0);
        quietPasses = Math.abs(after - before) < 0.5 ? quietPasses + 1 : 0;
        if (quietPasses >= 4) return { status: 'not_found' };
      }
      return { status: 'capture_unavailable' };
    })()`);
  }

  async downloadConversationArtifacts({
    artifactKeys = [],
    maxFiles = 6,
    maxBytesPerFile = 100 * 1024 * 1024,
    timeoutMs = 20_000,
    outDir = path.join(this.stateDir, 'downloads')
  } = {}) {
    const keys = Array.from(artifactKeys, String).slice(0, Math.max(0, Number(maxFiles) || 0));
    if (!keys.length) return [];
    let target;
    try {
      target = parseChatGptEntryTarget(await this.getUrl());
      if (target?.kind !== 'canonical-conversation') throw new Error('not_canonical');
    } catch {
      return keys.map((artifactKey) => ({ status: 'conversation_changed', artifactKey }));
    }
    const providerConversationId = providerConversationIdFromOwnedLocation(
      locationFromConversationUrl(target.chatUrl)
    );
    const bundle = await this.#captureConversationBundle({
      maxCaptureBytes: 16 * 1024 * 1024,
      providerConversationId
    });
    if (bundle.artifactInventory.status !== 'complete') {
      return keys.map((artifactKey) => ({
        status: 'download_failed',
        artifactKey,
        reason: 'capture_unavailable'
      }));
    }
    const descriptorByKey = new Map(
      bundle.artifactInventory.items.map((descriptor) => [descriptor.artifactKey, descriptor])
    );
    const outcomes = [];
    for (const artifactKey of keys) {
      const descriptor = descriptorByKey.get(artifactKey);
      if (!descriptor) {
        outcomes.push({ status: 'not_found', artifactKey });
        continue;
      }
      const firstTarget = await this.#locateConversationArtifactTarget(descriptor, { timeoutMs });
      if (firstTarget?.status !== 'found') {
        outcomes.push({
          status: firstTarget?.status === 'name_mismatch' ? 'download_failed' : 'not_found',
          artifactKey,
          ...(firstTarget?.status === 'name_mismatch' ? { reason: 'name_mismatch' } : {})
        });
        continue;
      }
      if (typeof this.page?.beginDownloadCapture !== 'function') {
        outcomes.push({ status: 'download_failed', artifactKey, reason: 'download_unavailable' });
        continue;
      }
      const capture = this.page.beginDownloadCapture({
        timeoutMs,
        outDir,
        maxBytes: maxBytesPerFile
      });
      const captureReady = await capture.ready;
      if (!captureReady) {
        await capture.outcome;
        outcomes.push({ status: 'download_failed', artifactKey, reason: 'download_unavailable' });
        continue;
      }
      const stableTarget = await this.#locateConversationArtifactTarget(descriptor, {
        timeoutMs: Math.min(timeoutMs, 5_000)
      });
      let currentConversationId = null;
      try {
        const currentTarget = parseChatGptEntryTarget(await this.getUrl());
        if (currentTarget?.kind === 'canonical-conversation') {
          currentConversationId = providerConversationIdFromOwnedLocation(
            locationFromConversationUrl(currentTarget.chatUrl)
          );
        }
      } catch {}
      if (currentConversationId !== providerConversationId) {
        capture.cancel?.();
        await capture.outcome;
        outcomes.push({ status: 'conversation_changed', artifactKey });
        continue;
      }
      if (stableTarget?.status !== 'found') {
        capture.cancel?.();
        await capture.outcome;
        outcomes.push({
          status: stableTarget?.status === 'name_mismatch' ? 'download_failed' : 'not_found',
          artifactKey,
          ...(stableTarget?.status === 'name_mismatch' ? { reason: 'name_mismatch' } : {})
        });
        continue;
      }
      await this.#clickAt(stableTarget.x, stableTarget.y);
      const downloaded = await capture.outcome;
      if (downloaded?.status === 'size_limit_exceeded') {
        outcomes.push({
          status: 'size_limit_exceeded',
          artifactKey,
          maxBytes: downloaded.maxBytes
        });
        continue;
      }
      if (downloaded?.status !== 'completed') {
        outcomes.push({
          status: 'download_failed',
          artifactKey,
          reason: downloaded?.status === 'timeout'
            ? 'timeout'
            : downloaded?.status === 'unavailable'
              ? 'download_unavailable'
              : 'interrupted'
        });
        continue;
      }
      const suggestedName = String(downloaded.suggestedName || downloaded.name || '').trim();
      if (suggestedName !== descriptor.name) {
        await fs.rm(downloaded.path, { force: true }).catch(() => {});
        outcomes.push({ status: 'download_failed', artifactKey, reason: 'name_mismatch' });
        continue;
      }
      outcomes.push({
        status: 'downloaded',
        artifactKey,
        filePath: downloaded.path,
        originalName: descriptor.name,
        mime: downloaded.mime || null,
        provenance: {
          schemaVersion: descriptor.schemaVersion,
          artifactKey,
          conversationUrl: target.chatUrl,
          providerConversationId: descriptor.providerConversationId,
          providerMessageId: descriptor.providerMessageId,
          providerTurnIndex: descriptor.providerTurnIndex,
          occurrenceWithinMessage: descriptor.occurrenceWithinMessage,
          name: descriptor.name,
          kind: descriptor.kind
        }
      });
    }
    return outcomes;
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

  async #applyModelIntent(options = {}) {
    const requested = normalizeChatGptModelIntent(options?.modelIntent, { fallback: null });
    if (!requested) return await this.#applyModelIntentImpl(options);
    return await this.runCompatibilityCapability(
      'mode-model',
      async () => await this.#applyModelIntentImpl(options),
      { anchorId: 'chat-mode-button', postcondition: (result) => result?.active === true, authoritativeTerminal: true }
    );
  }

  async #applyModelIntentImpl({ modelIntent, timeoutMs = 20_000 } = {}) {
    const supplied = typeof modelIntent === 'string' ? modelIntent.trim() : '';
    const normalizedIntent = normalizeChatGptModelIntent(modelIntent, { fallback: null });
    // Nothing was asked for, so nothing had to be activated.
    if (!normalizedIntent && !supplied) {
      return { active: true, reason: 'model_intent_not_requested', targetIntent: null };
    }

    // A generation was asked for that this build cannot express -- an unknown
    // name, or a known one with no picker metadata. The caller reads this result
    // for provenance only and never gates the send on it, so reporting active
    // here sent the query on whatever the tab already had selected while
    // claiming a pin that never happened. Fail before send, as a failed
    // activation does.
    const meta = normalizedIntent ? CHATGPT_MODEL_INTENT_META[normalizedIntent] : null;
    if (!meta) {
      const err = new Error('model_intent_unsupported');
      err.data = {
        reason: normalizedIntent ? 'model_intent_metadata_missing' : 'model_intent_unrecognized',
        requestedIntent: supplied || null,
        targetIntent: normalizedIntent,
        supportedIntents: [...CHATGPT_MODEL_INTENTS]
      };
      throw err;
    }

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
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-select-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [popover], [role="dialog"], [role="alertdialog"]'))
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
          ...Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], [aria-haspopup], [aria-expanded], [data-testid*="model" i], [data-testid*="mode" i], summary, [tabindex="0"]')),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], [aria-haspopup], [aria-expanded], [data-testid*="model" i], [data-testid*="mode" i], summary, [tabindex="0"]'))
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
            const ariaChecked =
              String(node?.getAttribute?.('aria-checked') || '').trim().toLowerCase() === 'true' ||
              modelPickerPrimitives.modelOptionLabelLooksSelected(label);
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

  async #applyModeIntent(options = {}) {
    const requested = normalizeChatGptModeIntent(options?.modeIntent, { fallback: null });
    if (!requested) return await this.#applyModeIntentImpl(options);
    return await this.runCompatibilityCapability(
      'mode-model',
      async () => await this.#applyModeIntentImpl(options),
      { anchorId: 'chat-mode-button', postcondition: (result) => result?.active === true, authoritativeTerminal: true }
    );
  }

  async #applyModeIntentImpl({ modeIntent, timeoutMs = 20_000 } = {}) {
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
          ...Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-select-content], [data-radix-popper-content-wrapper], [data-headlessui-state], [data-floating-ui-portal], [data-slot="popover-content"], [data-slot="dropdown-menu-content"], [popover], [role="dialog"], [role="alertdialog"]'))
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
          ...Array.from((composerRoot || document).querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], [aria-haspopup], [aria-expanded], [data-testid*="model" i], [data-testid*="mode" i], summary, [tabindex="0"]')),
          ...Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], [aria-haspopup], [aria-expanded], [data-testid*="model" i], [data-testid*="mode" i], summary, [tabindex="0"]'))
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
            return { node, label, intent, score, active: isActive(node), rect, signature: signatureOf(rect, label), modeRegion, highConfidence, promptProximityBoost };
          })
          .filter((item) => !blockedTriggerSignatures.has(item.signature))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score);
        const ariaActiveTrigger = triggerCandidates.find((item) => item.active && item.intent) || null;
        const confirmedTargetTrigger = triggerCandidates.find((item) =>
          modePickerPrimitives.modeTriggerConfirmsActive({
            label: item.label,
            intent: item.intent,
            targetIntent,
            active: item.active,
            highConfidence: item.highConfidence,
            modeRegion: item.modeRegion,
            inComposer: !!(composerRoot && composerRoot.contains(item.node)),
            promptProximityBoost: item.promptProximityBoost,
            menuOpen: menuRoots.length > 0
          })
        ) || null;
        if (confirmedTargetTrigger) {
          return {
            active: true,
            action: 'none',
            reason: confirmedTargetTrigger.active ? 'mode_already_active' : 'mode_visible_trigger_active',
            targetIntent,
            activeIntent: confirmedTargetTrigger.intent,
            label: confirmedTargetTrigger.label || null
          };
        }
        if (clickedRecently && !menuRoots.length) {
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
            activeIntent: ariaActiveTrigger?.intent || null,
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
            activeIntent: ariaActiveTrigger?.intent || null,
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
          activeIntent: ariaActiveTrigger?.intent || null,
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
      const hasAuthInput = !!document.querySelector('input[type=\"password\"], input[name=\"password\"], input[autocomplete=\"current-password\"]');
      const hasLoginText = /log in|sign in|continue with/i.test(bodyText);

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
      const loginLike = hasAuthInput || (!rawPromptVisible && hasLoginText);
      const promptVisible = rawPromptVisible && (!hasAuthInput || sendVisible);

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

  async ensureReady(options = {}) {
    return await this.runCompatibilityCapability(
      'readiness',
      async () => await this.#ensureReadyImpl(options),
      { anchorId: 'prompt-textarea', postcondition: (result) => result?.promptVisible === true, authoritativeTerminal: true }
    );
  }

  async #ensureReadyImpl({ timeoutMs = 10 * 60_000 } = {}) {
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

  async #focusPrompt(options = {}) {
    return await this.runCompatibilityCapability(
      'composer',
      async () => await this.#focusPromptImpl(options),
      { anchorId: 'prompt-textarea', postcondition: (result) => result?.ok === true, authoritativeTerminal: true }
    );
  }

  async #focusPromptImpl({ phase = null, clickPrompt = true } = {}) {
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

  async #waitForSendSignal({ timeoutMs = 1800, pollMs = 120, initialPromptLen = 0, initialStopCount = 0 } = {}) {
    const stopSel = JSON.stringify(this.selectors.stopButton);
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const promptSel = JSON.stringify(this.selectors.promptTextarea);
    const start = Date.now();
    const baselineStopCount = Math.max(0, Number(initialStopCount) || 0);
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      const snap = await this.#eval(`(() => {
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stopCount = Array.from(document.querySelectorAll(${stopSel})).filter(visible).length;
        const stopVisible = stopCount > 0;
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
        return { stopVisible, stopCount, sendDisabled, promptLen };
      })()`);

      const promptChanged = Number.isFinite(initialPromptLen) && initialPromptLen > 0 && snap?.promptLen >= 0 && snap.promptLen < initialPromptLen;
      const stopAppeared = Number.isFinite(snap?.stopCount)
        ? snap.stopCount > baselineStopCount
        : (!!snap?.stopVisible && baselineStopCount === 0);
      const disabledWithoutPromptRead = !!snap?.sendDisabled && !(snap?.promptLen >= 0);
      if (stopAppeared || promptChanged || disabledWithoutPromptRead) return true;
      await sleep(pollMs);
    }
    return false;
  }

  async #clickSend() {
    return await this.runCompatibilityCapability(
      'submit',
      async () => await this.#clickSendImpl(),
      { anchorId: 'send-button', postcondition: (result) => result?.acknowledged === true, authoritativeTerminal: true }
    );
  }

  async #clickSendImpl() {
    await this.#emitProgress({ phase: 'sending_prompt' });
    const sendSel = JSON.stringify(this.selectors.sendButton);
    const stopSel = JSON.stringify(this.selectors.stopButton);
    let lastSendDebug = null;
    const res = await this.#eval(`(() => {
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
      const stopNodes = Array.from(document.querySelectorAll(${stopSel})).filter(visible);
      const stopCount = stopNodes.length;
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
      if (!btn && stopCount > 0 && !submitter) return { ok:false, error:'already_generating', host, promptLen, stopCount };
      if (!btn) return { ok:true, fallbackEnter:true, requestSubmit: !!submitter, host, promptLen, stopCount, preExistingStopVisible: stopCount > 0 };
      const r = btn.getBoundingClientRect();
      return {
        ok:true,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        requestSubmit: !!submitter,
        host,
        promptLen,
        stopCount,
        preExistingStopVisible: stopCount > 0,
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
      preExistingStopVisible: !!res?.preExistingStopVisible,
      initialStopCount: Number.isFinite(res?.stopCount) ? res.stopCount : 0,
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
      sent = await this.#waitForSendSignal({
        timeoutMs: 1800,
        pollMs: 120,
        initialPromptLen: res?.promptLen || 0,
        initialStopCount: res?.stopCount || 0
      });
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
        sent = await this.#waitForSendSignal({
          timeoutMs: 2200,
          pollMs: 120,
          initialPromptLen: res?.promptLen || 0,
          initialStopCount: res?.stopCount || 0
        });
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
      sent = await this.#waitForSendSignal({
        timeoutMs: 1400,
        pollMs: 120,
        initialPromptLen: res?.promptLen || 0,
        initialStopCount: res?.stopCount || 0
      });
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
        sent = await this.#waitForSendSignal({
          timeoutMs: 1500,
          pollMs: 120,
          initialPromptLen: res?.promptLen || 0,
          initialStopCount: res?.stopCount || 0
        });
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
    return lastSendDebug;
  }

  async #attachFiles(files) {
    if (!files?.length) return await this.#attachFilesImpl(files);
    return await this.runCompatibilityCapability(
      'attachment',
      async () => await this.#attachFilesImpl(files),
      { anchorId: 'composer-menu-button', postcondition: () => true, authoritativeTerminal: true }
    );
  }

  async #attachFilesImpl(files) {
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
      const sawFileInput =
        attachOpen?.action === 'file_input_ready' ||
        Number(injected?.localInputCount || 0) > 0 ||
        Number(injected?.totalInputCount || 0) > 0;
      if (!sawFileInput) {
        const err = new Error('attachment_input_unavailable');
        err.data = {
          reason: clipText(injected?.error || attachOpen?.reason || 'no_file_input', 160),
          pickerAction: attachOpen?.action || null,
          pickerLabel: clipText(attachOpen?.label || '', 160) || null
        };
        throw err;
      }
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

  async #waitForAssistantStable(options = {}) {
    return await this.runCompatibilityCapability(
      'response',
      async () => await this.#waitForAssistantStableImpl(options),
      { anchorId: 'assistant-message', postcondition: (result) => typeof result?.text === 'string' && result.text.length > 0 }
    );
  }

  async #waitForAssistantStableImpl({
    timeoutMs = 5 * 60_000,
    stableMs = 1500,
    pollMs = 400,
    preSendCount = 0,
    preSendText = '',
    preSendPageText = '',
    preSendStopCount = 0,
    minimumTimeoutMs = 0,
    minimumStableMs = 0,
    extraThinkingPattern = '',
    imageGeneration = false,
    durableObservation = false
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
    let lastWaitDebugAt = 0;
    let reconciling = false;
    const baselineStopCount = Math.max(0, Number(preSendStopCount) || 0);

    while (durableObservation || Date.now() - start < effectiveTimeoutMs) {
      this.#throwIfStopRequested();
      if (durableObservation && !reconciling && Date.now() - start >= effectiveTimeoutMs) {
        reconciling = true;
        await this.#emitProgress({
          phase: 'reconciling_response',
          blocked: false,
          responseDebug: { softDeadlineMs: effectiveTimeoutMs, elapsedMs: Date.now() - start }
        });
      }
      const snap = await this.#eval(`(() => {
        const extraThinkingRe = ${extraThinkingSource} ? new RegExp(${extraThinkingSource}, 'i') : null;
        const visible = (n) => {
          if (!n) return false;
          const r = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const stopCount = Array.from(document.querySelectorAll(${stopSel})).filter(visible).length;
        const stop = stopCount > 0;
        const send = Array.from(document.querySelectorAll(${sendSel})).find((n) => {
          return visible(n);
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
          stopCount,
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
      const stopCount = Number.isFinite(Number(snap?.stopCount))
        ? Math.max(0, Number(snap.stopCount))
        : (snap?.stop ? 1 : 0);
      const activeStop = stopCount > baselineStopCount || (!!snap?.stop && baselineStopCount === 0);
      const hasImageOutput = Number(snap?.imageCandidateCount || 0) > 0;
      const imagePlaceholder = IMAGE_PLACEHOLDER_RE.test(txt);
      const hasThinkingLine = IMAGE_THINKING_LINE_RE.test(txt);
      const thinking = !!snap?.isThinking || imagePlaceholder || (imageGeneration && !hasImageOutput && hasThinkingLine);
      const finalImageOutput = hasImageOutput && !(imageGeneration && thinking);
      const conversationUrl = extractConversationUrl(snap?.currentUrl || '');
      if (conversationUrl && conversationUrl !== emittedConversationUrl) {
        emittedConversationUrl = conversationUrl;
        await this.#emitProgress({ conversationUrl });
      }
      if (Date.now() - lastWaitDebugAt >= 10_000) {
        lastWaitDebugAt = Date.now();
        await this.#emitProgress({
          responseDebug: {
            elapsedMs: Date.now() - start,
            count: snap?.count || 0,
            usedFallback: !!snap?.usedFallback,
            stop: activeStop,
            rawStop: !!snap?.stop,
            stopCount,
            baselineStopCount,
            sendFound: !!snap?.sendFound,
            sendEnabled: !!snap?.sendEnabled,
            thinking,
            hasContinue: !!snap?.hasContinue,
            hasError: !!snap?.hasError,
            currentUrl: snap?.currentUrl || null,
            textPreview: clipText(txt, 180) || null,
            pageTextChanged: pageText !== preSendPageText
          }
        });
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
      if (activeStop || thinking) generationObserved = true;

      if (!newResponseSeen) {
        if (assistantAdvanced || activeStop || thinking || (preSendCount === 0 && pageChanged)) {
          newResponseSeen = true;
          lastChange = Date.now(); // Reset stability timer for the new response
        }
      }

      // Treat as "generating" when: stop button visible and send not enabled,
      // thinking indicator detected, or stop button visible while send button missing.
      // A missing send button alone is NOT treated as generating — the selector may
      // simply not match the current UI. Only block completion when there's active
      // evidence of generation (stop button or thinking state).
      const generating = (activeStop && !snap?.sendEnabled) || thinking || (activeStop && !snap?.sendFound);
      if (generating) stopGoneAt = null;
      else if (stopGoneAt == null) stopGoneAt = Date.now();

      const dynamicStableMs = Math.max(
        stableMs,
        Number.isFinite(Number(minimumStableMs)) && Number(minimumStableMs) > 0 ? Math.floor(Number(minimumStableMs)) : 0,
        txt.length > 8000 ? 3000 : txt.length > 2000 ? 2200 : stableMs
      );
      const stable = Date.now() - lastChange >= dynamicStableMs;
      const stopGoneLongEnough = stopGoneAt != null && Date.now() - stopGoneAt >= 800;

      if (!activeStop && snap?.hasContinue && continueClicks < 3) {
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
      const sendReady = snap?.sendEnabled || (!snap?.sendFound && !activeStop && !thinking);
      const fallbackReady = fallbackWaited && pageChanged && (generationObserved || snap?.hasError);
      const contentReady = readyByNodes || fallbackReady || finalImageOutput || snap?.hasError;
      const responseReady = snap?.hasError || (imageGeneration ? (finalImageOutput || (txt.length > 0 && !thinking)) : txt.length > 0);
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
        const actualMode = inferActualModeIntent({ text: txt, pageText });
        return {
          text: txt,
          codeBlocks: extra?.codeBlocks || [],
          meta: {
            count: snap?.count || 0,
            hasError: !!snap?.hasError,
            modeUsed: actualMode?.intent || null,
            actualModeIntent: actualMode?.intent || null,
            actualModeLabel: actualMode?.label || null,
            actualModeSource: actualMode?.source || null
          }
        };
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
    modelIntent = null,
    durableObservation = false
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
      // Snapshot existing assistant messages before sending, so #waitForAssistantStable
      // can distinguish pre-existing responses from the new one. Capture this before
      // typing: on some ChatGPT pages fallback text includes the composer, so prompt
      // staging/clearing can otherwise masquerade as assistant progress.
      const assistantSel = JSON.stringify(this.selectors.assistantMessage);
      const prePrompt = await this.#eval(`(() => {
        const nodes = Array.from(document.querySelectorAll(${assistantSel}));
        const lastNode = nodes[nodes.length - 1];
        const pageText = ((document.querySelector('main') || document.body)?.innerText || '').trim();
        return { count: nodes.length, lastText: (lastNode?.innerText || '').trim(), pageText };
      })()`);
      await this.#typePrompt(prompt);
      const sendDebug = await this.#clickSend();
      const result = await this.#waitForAssistantStable({
        timeoutMs,
        preSendCount: prePrompt?.count || 0,
        preSendText: prePrompt?.lastText || '',
        preSendPageText: prePrompt?.pageText || '',
        preSendStopCount: sendDebug?.initialStopCount || 0,
        imageGeneration,
        durableObservation
      });
      const requestedModeIntent = normalizeChatGptModeIntent(modeIntent, { fallback: null });
      const modeUsed = normalizeChatGptModeIntent(result?.meta?.modeUsed || result?.meta?.actualModeIntent, { fallback: null });
      const actualModeSource = String(result?.meta?.actualModeSource || '');
      if (requestedModeIntent && modeUsed && modeUsed !== requestedModeIntent && actualModeSource === 'page_footer') {
        await this.#emitProgress({
          phase: 'mode_intent_mismatch',
          modeIntent: requestedModeIntent,
          modeUsed,
          degradedFrom: { modeIntent: requestedModeIntent }
        });
        throw buildModeIntentDowngradeError({
          requestedIntent: requestedModeIntent,
          modeUsed,
          actualMode: {
            intent: modeUsed,
            label: result?.meta?.actualModeLabel || null,
            source: result?.meta?.actualModeSource || null
          }
        });
      }
      return result;
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  async #activateResearchMode(options = {}) {
    return await this.runCompatibilityCapability(
      'research',
      async () => await this.#activateResearchModeImpl(options),
      { anchorId: 'research-mode-button', postcondition: (result) => result?.active === true }
    );
  }

  async #activateResearchModeImpl({ timeoutMs = 20_000 } = {}) {
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

  async #exportResearchMarkdown(options = {}) {
    return await this.runCompatibilityCapability(
      'file',
      async () => await this.#exportResearchMarkdownImpl(options),
      {
        anchorId: 'research-export-button',
        postcondition: (result) => Array.isArray(result?.files) && result.files.length > 0,
        authoritativeTerminal: true
      }
    );
  }

  async #exportResearchMarkdownImpl({ outDir, timeoutMs = 15_000, maxFiles = 6 } = {}) {
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

    const domItems = await this.#getLastAssistantDownloadsImpl({ maxFiles }).catch(() => []);
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
        const sendDebug = await this.#clickSend();
        const result = await this.#waitForAssistantStable({
          timeoutMs: effectiveTimeoutMs,
          preSendCount: preSend?.count || 0,
          preSendText: preSend?.lastText || '',
          preSendPageText: preSend?.pageText || '',
          preSendStopCount: sendDebug?.initialStopCount || 0,
          minimumTimeoutMs: 60 * 60_000,
          minimumStableMs: 60_000,
          durableObservation: true,
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
        const initialUrl = await this.getUrl().catch(() => '');
        const initialTarget = (() => {
          try { return parseChatGptEntryTarget(initialUrl); } catch { return null; }
        })();
        await this.ensureReady({ timeoutMs });
        await this.#typePrompt(prompt);
        await this.#clickSend();

        let materializedConversationUrl = null;
        if (initialTarget?.kind === 'shared-snapshot') {
          const startedAt = Date.now();
          const materializationTimeoutMs = Math.min(Math.max(1_000, timeoutMs), 15_000);
          while (Date.now() - startedAt < materializationTimeoutMs) {
            this.#throwIfStopRequested();
            const candidate = extractConversationUrl(await this.getUrl().catch(() => ''));
            if (candidate) {
              materializedConversationUrl = candidate;
              await this.#emitProgress({ phase: 'conversation_materialized', conversationUrl: candidate });
              break;
            }
            await sleep(120);
          }
          if (!materializedConversationUrl) {
            const error = new Error('shared_chat_materialization_failed');
            error.data = { sourceUrl: initialTarget.chatUrl };
            throw error;
          }
        }

        if (stopAfterSend) {
          const start = Date.now();
          while (Date.now() - start < 2500) {
            this.#throwIfStopRequested();
            const clicked = await this.#clickVisibleStop();
            if (clicked) break;
            await sleep(120);
          }
        }

        return materializedConversationUrl
          ? { ok: true, conversationUrl: materializedConversationUrl }
          : { ok: true };
      } finally {
        if (this.currentRun === run) this.currentRun = null;
      }
    });
  }

  async getLastAssistantImages(options = {}) {
    return await this.runCompatibilityCapability(
      'image',
      async () => await this.#getLastAssistantImagesImpl(options),
      {
        anchorId: 'assistant-message',
        postcondition: (result) => Array.isArray(result) && result.length > 0
      }
    );
  }

  async #getLastAssistantImagesImpl({ maxImages = 6 } = {}) {
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
    const collectedImages = await this.getLastAssistantImages({ maxImages });
    const imgs = [];
    const imageIndexBySource = new Map();
    for (const image of collectedImages) {
      const rawSource = String(image?.src || '').trim();
      let sourceKey = rawSource;
      if (/^https?:\/\//i.test(rawSource)) {
        try {
          const normalizedSource = new URL(rawSource);
          normalizedSource.hash = '';
          sourceKey = normalizedSource.href;
        } catch {}
      }
      if (!sourceKey || !imageIndexBySource.has(sourceKey)) {
        if (sourceKey) imageIndexBySource.set(sourceKey, imgs.length);
        imgs.push(image);
        continue;
      }

      const existingIndex = imageIndexBySource.get(sourceKey);
      const existing = imgs[existingIndex];
      const candidateHasAlt = !!String(image?.alt || '').trim();
      const existingHasAlt = !!String(existing?.alt || '').trim();
      if (candidateHasAlt && !existingHasAlt) {
        imgs[existingIndex] = {
          ...image,
          ...(image.dataUrl || !existing?.dataUrl ? {} : { dataUrl: existing.dataUrl })
        };
      } else if (!existing?.dataUrl && image?.dataUrl) {
        imgs[existingIndex] = { ...existing, dataUrl: image.dataUrl };
      }
    }
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

  async getLastAssistantDownloads(options = {}) {
    return await this.runCompatibilityCapability(
      'file',
      async () => await this.#getLastAssistantDownloadsImpl(options),
      {
        anchorId: 'assistant-message',
        postcondition: (result) => Array.isArray(result) && result.length > 0,
        authoritativeTerminal: true
      }
    );
  }

  async #getLastAssistantDownloadsImpl({ maxFiles = 6 } = {}) {
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
