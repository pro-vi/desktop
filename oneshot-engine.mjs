import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { completionEvidenceFor } from './chatgpt-completion-evidence.mjs';
import {
  captureAnswer,
  focusComposer,
  injectFiles,
  pageScript,
  readAttachments,
  readComposer,
  readLastUserText,
  readPageState,
  readPageText,
  readSendButton,
  readTurns
} from './oneshot-page-scripts.mjs';

// One fresh chat, one prompt, one answer, on a site described by an adapter
// (ADR 0017). ChatGPT keeps its own controller; this engine serves the sites
// whose adapters are registered in oneshot-sites/index.mjs.

const DEFAULT_TIMINGS = Object.freeze({
  pollMs: 500,
  // The answer text must hold still this long, with no stop control showing.
  stableMs: 3_000,
  sendAckMs: 8_000,
  // Kimi keeps Send disabled while it processes attached files after typing.
  sendEnableMs: 60_000,
  uploadMs: 120_000,
  navigationMs: 30_000,
  promptDeliveryMs: 2_000,
  uiCheckMs: 5_000,
  // How long an adapter waits for a menu it opened to show its options.
  menuMs: 3_000,
  // How long an adapter waits for a page control (a mode picker) to render
  // after the composer is ready: a fresh chat draws it a moment later.
  controlMs: 10_000
});

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
});

// The engine's own error codes, with the HTTP status and run outcome each one
// gets. Every code whose detail says "No prompt was sent" ends the run before
// Send; the others happen after it and record the chat's URL.
export const ONESHOT_ERRORS = Object.freeze({
  mode_intent_unsupported: {
    status: 400,
    label: 'Mode not offered',
    detail: (d) => `${d?.vendorId || 'This site'} has no mode intent "${d?.modeIntent || ''}"${Array.isArray(d?.supported) ? ` (supported: ${d.supported.join(', ')})` : ''}. No prompt was sent.`
  },
  oneshot_location_unsupported: {
    status: 400,
    label: 'Location not supported',
    detail: (d) => `${d?.vendorId || 'This site'} runs every query in a fresh chat; ${(d?.fields || []).join(', ') || 'a chat location'} cannot be used. No prompt was sent.`
  },
  image_generation_unsupported: { status: 400, label: 'Image generation unsupported', detail: () => 'This site runs text queries only. No prompt was sent.' },
  oneshot_send_unsupported: { status: 400, label: 'Send not supported', detail: (d) => `${d?.vendorId || 'This site'} answers one query per fresh chat; use agentify_query. Nothing was sent.` },
  attachment_unreadable: { status: 400, attachment: true, label: 'Attachment unreadable', detail: (d) => `An attachment could not be read from disk${d?.file ? `: ${d.file}` : ''}. No prompt was sent.` },
  attachment_too_large: { status: 400, attachment: true, label: 'Attachment too large', detail: () => 'The attachments exceed the size limit. No prompt was sent.' },
  mode_intent_unavailable: {
    status: 409,
    label: 'Mode unavailable',
    detail: (d) => `The page did not confirm mode "${d?.modeIntent || ''}" (${d?.reason || 'unconfirmed'}). No prompt was sent.`
  },
  fresh_chat_unavailable: { status: 409, label: 'Fresh chat unavailable', detail: () => 'The provider did not open an empty chat. No prompt was sent.' },
  attachment_input_missing: { status: 409, attachment: true, label: 'Attachment not sent', detail: () => 'No file input was found on the page. No prompt was sent.' },
  attachment_not_shown: { status: 409, attachment: true, label: 'Attachment not shown', detail: (d) => `The page did not show every attached file as uploaded${d?.stage === 'before_send' ? ' when the prompt was ready to send' : ''}. No prompt was sent.` },
  prompt_sent_early: { status: 409, label: 'Prompt sent while typing', detail: () => 'The page sent part of the prompt before typing finished; the chat holds an incomplete prompt.' },
  send_refused: { status: 409, label: 'Send refused', detail: (d) => `The provider refused the send${d?.notice ? `: "${d.notice}"` : ''}. No answer was produced.` },
  click_target_missing: { status: 409, label: 'Page control not found', detail: () => 'A control the run needed had no size on the page. No prompt was sent.' },
  answer_capture_failed: { status: 409, label: 'Answer not captured', detail: () => 'The answer finished but could not be read from the page.' },
  provider_response_error: { status: 409, label: 'Provider error', detail: () => 'The provider showed an error in place of an answer.' }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function namedError(message, data = null) {
  const error = new Error(message);
  if (data) error.data = data;
  return error;
}

function letterCore(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function clipText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The same comparison the ChatGPT controller makes before send: exact for a
// textarea value, whitespace-folded for rendered rich text. Returns null when
// the composer holds the prompt, else the prompt_staging_failed detail.
export function compareStagedPrompt(expected, staged, { usesValue = false } = {}) {
  const normalize = usesValue
    ? (text) => String(text || '').replace(/\r\n?/g, '\n')
    : (text) => String(text || '').replace(/\s+/gu, ' ').trim();
  const want = normalize(expected);
  const got = normalize(staged);
  if (got === want) return null;
  let at = 0;
  while (at < want.length && want[at] === got[at]) at += 1;
  let line = 1;
  if (usesValue) {
    line = want.slice(0, at + 1).split('\n').length;
  } else {
    let start = 0;
    const lines = String(expected || '').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const part = normalize(lines[i]);
      if (!part) continue;
      line = i + 1;
      if (at < start + part.length) break;
      start += part.length + 1;
    }
  }
  return {
    expectedChars: String(expected || '').length,
    stagedChars: String(staged || '').length,
    // Quote only the caller's prompt: the composer may hold a draft from elsewhere.
    firstDifference: { at, line, expected: want.slice(at, at + 60) }
  };
}

// Each prompt line's letters and digits must appear in the user turn the site
// recorded (ADR 0014). Reports; never fails the run.
export function promptDeliveryFor(prompt, recorded) {
  if (typeof recorded !== 'string') return { checked: false };
  const core = letterCore(recorded);
  const missing = String(prompt || '')
    .split('\n')
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter(({ text }) => letterCore(text) && !core.includes(letterCore(text)));
  return {
    checked: true,
    complete: missing.length === 0,
    missingLineCount: missing.length,
    firstMissingLine: missing.length ? clipText(missing[0].text) : null,
    firstMissingLineNumber: missing[0]?.lineNumber ?? null,
    lastMissingLineNumber: missing.at(-1)?.lineNumber ?? null,
    missingLines: missing.slice(0, 10).map(({ text }) => clipText(text))
  };
}

// What the run can say about its mode once the answer is in: unverified when
// the page's setting could not be read, and downgraded when the page shows a
// different model after the answer than it confirmed before Send.
export function modeVerificationFor({ mode, modeApplied, answerSettings }) {
  if (answerSettings?.unreadReason) {
    return { modeVerification: 'unverified', modeVerificationReason: answerSettings.unreadReason };
  }
  // Each adapter names the selection it made (Kimi's model, Gemini's picker
  // option); a model line the page rewrites, such as Gemini's quota notice,
  // is not a change of selection.
  const before = modeApplied?.shown?.selection ?? modeApplied?.shown?.model ?? null;
  const after = answerSettings?.selection ?? answerSettings?.model ?? null;
  if (mode && before && after && before !== after) {
    return {
      modeVerification: 'unverified',
      modeVerificationReason: 'mode_changed_after_send',
      degradedFrom: { modeIntent: mode.intent, shownBeforeSend: before, shownAfterAnswer: after }
    };
  }
  return {};
}

// Citation and panel sources are listed under the answer; inline links are
// already in its text. Returns the Markdown with that list appended.
export function appendSourcesSection(markdown, sources) {
  const listed = (sources || []).filter((source) => source.kinds.includes('citation') || source.kinds.includes('panel'));
  if (!listed.length) return markdown;
  const lines = listed.map((source) => (source.url
    ? `${source.index}. [${source.title || source.url}](${source.url})`
    : `${source.index}. ${source.title || source.file} (attached file)`));
  return `${markdown}\n\n## Sources\n\n${lines.join('\n')}`;
}

// Tool use is what the page showed of the model's searches and the pages it
// read, never its reasoning text. Three states stay apart: "shown" with the
// steps in page order, "none" when the page showed no tool use, and "unread"
// with a reason when the adapter could not read it; "unread" never carries an
// empty list that would read as "none".
export function normalizeToolUse(read) {
  const text = (value) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null);
  if (read?.state === 'none') return { state: 'none', reason: null, steps: [] };
  if (read?.state !== 'shown') return { state: 'unread', reason: text(read?.reason) || 'tool_use_unread', steps: null };
  const steps = (Array.isArray(read.steps) ? read.steps : []).map((step) => ({
    tool: text(step?.tool) || 'unknown',
    title: text(step?.title),
    query: text(step?.query),
    count: Number.isFinite(step?.count) ? step.count : null,
    pages: (Array.isArray(step?.pages) ? step.pages : [])
      .filter((page) => text(page?.url))
      .map((page) => ({ url: text(page.url), title: text(page.title), site: text(page.site) }))
  }));
  if (!steps.length) return { state: 'unread', reason: 'tool_use_shown_without_steps', steps: null };
  return { state: 'shown', reason: null, steps };
}

export function toolUseCounts(toolUse) {
  const steps = Array.isArray(toolUse?.steps) ? toolUse.steps : [];
  return {
    state: toolUse?.state || 'unread',
    reason: toolUse?.reason || null,
    stepCount: toolUse?.state === 'unread' ? null : steps.length,
    searchCount: toolUse?.state === 'unread' ? null : steps.filter((step) => /search/i.test(step.tool) || step.query).length,
    pageCount: toolUse?.state === 'unread' ? null : steps.reduce((sum, step) => sum + step.pages.length, 0)
  };
}

// A file counts as uploaded when a chip names it and is not pending. Full
// names are matched first; then a chip showing the file's stem and its
// extension as a word (Kimi and Gemini drop the extension from the name and
// show it apart); then the stem alone, only when no other expected file shares
// it; then a name shortened in the middle. A chip is used for one file at most.
export function matchAttachments(expected, after) {
  const items = (Array.isArray(after?.items) ? after.items : []).map((item) => ({ ...item, text: String(item.text || '').toLowerCase() }));
  const used = new Set();
  const parts = (name) => {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf('.');
    return dot > 0 ? { stem: lower.slice(0, dot), ext: lower.slice(dot + 1) } : { stem: lower, ext: '' };
  };
  const report = expected.map((file) => ({ ...file, matchedBy: null, pending: false }));
  const claim = (entry, accept, how) => {
    const index = items.findIndex((item, i) => !used.has(i) && accept(item.text));
    if (index === -1) return;
    used.add(index);
    entry.matchedBy = how;
    entry.pending = !!items[index].pending;
  };
  for (const entry of report) claim(entry, (text) => text.includes(entry.name.toLowerCase()), 'name');
  for (const entry of report) {
    if (entry.matchedBy) continue;
    const { stem, ext } = parts(entry.name);
    if (stem.length < 4 || !/^[a-z0-9]+$/.test(ext)) continue;
    const extWord = new RegExp(`(^|[^a-z0-9])${ext}([^a-z0-9]|$)`);
    claim(entry, (text) => text.includes(stem) && extWord.test(text), 'stem-and-extension');
  }
  for (const entry of report) {
    if (entry.matchedBy) continue;
    const { stem } = parts(entry.name);
    if (stem.length < 4 || report.some((other) => other !== entry && parts(other.name).stem === stem)) continue;
    claim(entry, (text) => text.includes(stem), 'stem');
  }
  // Gemini shortens a long name in the middle ("doc_02_ban..._statement").
  // Such a chip names a file only when its two ends fit that file's stem and
  // no other expected file's, and it shows no other file type.
  const TYPE_WORD = /(^|[^a-z0-9])(pdf|docx?|xlsx?|pptx?|txt|md|csv|json|png|jpe?g|webp)([^a-z0-9]|$)/g;
  const shortenedFits = (text, entry) => {
    const { stem, ext } = parts(entry.name);
    const types = [...text.matchAll(TYPE_WORD)].map((found) => found[2]);
    if (types.some((type) => type !== ext)) return false;
    return [...text.matchAll(/([^\s]+?)(?:\.\.\.|…)([^\s]+)/g)].some(([, head, tail]) =>
      head.length + tail.length >= 6 && stem.startsWith(head) && stem.endsWith(tail) &&
      !report.some((other) => other !== entry && parts(other.name).stem.startsWith(head) && parts(other.name).stem.endsWith(tail)));
  };
  for (const entry of report) {
    if (entry.matchedBy) continue;
    claim(entry, (text) => shortenedFits(text, entry), 'shortened-name');
  }
  return {
    done: report.every((entry) => entry.matchedBy && !entry.pending),
    report,
    anyPending: items.some((item) => item.pending)
  };
}

export class OneShotController {
  constructor({
    page,
    adapter,
    vendorId = null,
    vendorName = null,
    onBlocked = null,
    onUnblocked = null,
    timings = {}
  } = {}) {
    for (const hook of ['freshChatUrl', 'applyMode', 'readAnswerSettings']) {
      if (typeof adapter?.[hook] !== 'function') throw namedError('oneshot_adapter_invalid', { missing: hook });
    }
    if (!adapter.profile) throw namedError('oneshot_adapter_invalid', { missing: 'profile' });
    this.page = page;
    this.adapter = adapter;
    this.vendorId = vendorId || adapter.vendorId;
    this.vendorName = vendorName || adapter.vendorName || null;
    this.onBlocked = onBlocked;
    this.onUnblocked = onUnblocked;
    this.timings = Object.freeze({ ...DEFAULT_TIMINGS, ...timings });
    this.exclusiveTail = Promise.resolve();
    this.blocked = false;
    this.currentRun = null;
    const sel = (anchorId) => adapter.profile.selectorsFor(anchorId);
    this.selectors = Object.freeze({
      composer: sel('composer'),
      send: sel('send-button'),
      sendDisabled: sel('send-disabled'),
      stop: sel('stop-button'),
      fileInput: sel('file-input'),
      attachmentItem: sel('attachment-item'),
      attachmentPending: sel('attachment-pending'),
      attachmentError: sel('attachment-error'),
      userTurn: sel('user-turn'),
      assistantTurn: sel('assistant-turn'),
      answerBody: sel('answer-body'),
      answerExclude: sel('answer-exclude'),
      answerSkip: sel('answer-skip'),
      answerError: sel('answer-error'),
      codeLanguage: sel('code-language'),
      citation: sel('citation'),
      sourceItem: sel('source-item'),
      signedOut: sel('signed-out-marker'),
      termsGate: sel('terms-gate'),
      idle: sel('idle-signal'),
      notice: sel('blocking-notice'),
      sourcePanel: sel('source-panel')
    });
  }

  async #eval(fn, args = this.selectors) {
    return await this.page.evaluate(pageScript(fn, args));
  }

  // One page operation at a time, in arrival order; a failed one frees the next.
  runExclusive(fn) {
    const run = this.exclusiveTail.then(fn);
    this.exclusiveTail = run.catch(() => {});
    return run;
  }

  async navigate(url) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(namedError('timeout_waiting_for_navigation', { timeoutMs: this.timings.navigationMs })),
        this.timings.navigationMs
      );
    });
    try {
      await Promise.race([Promise.resolve().then(() => this.page.navigate(url)), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getUrl() {
    return await this.page.getUrl();
  }

  async readPageText({ maxChars = 200_000 } = {}) {
    const cap = Math.max(0, Math.floor(Number(maxChars) || 0));
    const result = await this.#eval(readPageText, { maxChars: cap });
    const text = String(result?.text || '');
    const totalChars = Number.isFinite(Number(result?.totalChars)) ? Number(result.totalChars) : text.length;
    return { text, truncated: totalChars > cap, totalChars };
  }

  async detectChallenge() {
    const state = await this.#eval(readPageState);
    const kind = state.captcha || state.verifyText
      ? 'captcha'
      : state.signedOut || state.authInput
        ? 'login'
        : state.termsGate
          ? 'ui'
          : null;
    return {
      url: state.url,
      readyState: state.readyState,
      blocked: !!kind,
      promptVisible: state.composerVisible && !kind,
      kind,
      turns: { user: state.userTurns, assistant: state.assistantTurns },
      indicators: {
        captcha: state.captcha,
        verifyText: state.verifyText,
        signedOut: state.signedOut,
        authInput: state.authInput,
        termsGate: state.termsGate,
        rawPromptVisible: state.composerVisible
      }
    };
  }

  // Waits until the composer shows with no sign-in wall, terms gate or
  // challenge in front of it. A blocked page puts the tab in needs-attention.
  async ensureReady({ timeoutMs = 10 * 60_000 } = {}) {
    await this.#emitProgress({ phase: 'waiting_for_ready', blocked: false, blockedKind: null, blockedTitle: null });
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      last = await this.detectChallenge().catch(() => null);
      if (last?.promptVisible) {
        await this.#exitBlockedStateIfNeeded();
        return last;
      }
      if (last?.blocked) {
        await this.#enterBlockedState(last);
      } else if (!this.blocked && Date.now() - start > this.timings.uiCheckMs && last?.readyState === 'complete') {
        await this.#enterBlockedState({ ...last, blocked: true, kind: 'ui' });
      }
      await sleep(this.timings.pollMs);
    }
    throw namedError('timeout_waiting_for_prompt', last);
  }

  async requestStop({ reason = 'user_stop' } = {}) {
    if (this.currentRun) {
      this.currentRun.requested = true;
      this.currentRun.requestedAt = Date.now();
      this.currentRun.reason = reason || 'user_stop';
    }
    const clicked = await this.#eval((a, h) => {
      const stop = h.first(a.stop);
      if (!stop) return false;
      stop.click();
      return true;
    }).catch(() => false);
    return { ok: true, requested: !!this.currentRun || !!clicked, clicked: !!clicked };
  }

  async query({
    prompt,
    attachments = [],
    timeoutMs = 10 * 60_000,
    onProgress = null,
    modeIntent = null,
    modelIntent = null,
    imageGeneration = false,
    recipient = undefined
  } = {}) {
    if (recipient?.kind && recipient.kind !== 'chat') throw new Error('recipient_conflict');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('missing_prompt');
    if (prompt.length > 200_000) throw new Error('prompt_too_large');
    if (imageGeneration) throw namedError('image_generation_unsupported', { vendorId: this.vendorId });
    if (modelIntent) {
      throw namedError('model_intent_unsupported', {
        modelIntent,
        reason: `${this.vendorName || this.vendorId} takes modeIntent only.`
      });
    }
    // An intent the adapter does not know fails here, before any page work.
    const mode = this.#resolveModeIntent(modeIntent);
    const run = { kind: 'query', requested: false, requestedAt: null, reason: null, onProgress };
    this.currentRun = run;
    let sent = false;
    try {
      const freshChat = await this.#openFreshChat({ mode, timeoutMs });
      const modeApplied = mode ? await this.#applyMode(mode) : null;
      const attachmentReport = await this.#attachFiles(attachments);
      const baseline = await this.#eval(readTurns);
      const typing = await this.#typePrompt(prompt, baseline);
      await this.#recheckBeforeSend({ modeApplied, attachmentReport });
      const sendDebug = await this.#clickSend(baseline);
      sent = true;
      await this.#waitForAnswer({ baseline, timeoutMs });
      // Opening citation cards only adds sources; a failure there must not
      // cost the finished answer.
      const captureNotes = await this.#prepareCapture();
      const capture = await this.#eval(captureAnswer);
      if (!capture?.found || !String(capture.markdown || '').trim()) {
        throw namedError('answer_capture_failed', { reason: capture?.reason || 'answer_empty' });
      }
      const toolUse = await this.#readToolUse();
      const promptDelivery = await this.#readPromptDelivery(prompt);
      const answerSettings = await this.#readAnswerSettings();
      const conversationUrl = await this.getUrl().catch(() => null);
      const verification = modeVerificationFor({ mode, modeApplied, answerSettings });
      await this.#emitProgress({ phase: 'answer_captured' });
      return {
        text: appendSourcesSection(capture.markdown, capture.sources),
        meta: {
          oneShot: true,
          vendorId: this.vendorId,
          completionEvidence: completionEvidenceFor('assistant-node'),
          conversationUrl,
          freshChatUrl: freshChat.url,
          plainText: capture.text,
          sources: capture.sources,
          toolUse,
          requestedModeIntent: mode?.intent || null,
          modeApplied,
          answerSettings,
          ...verification,
          attachments: attachmentReport,
          promptDelivery,
          sendDebug: { ...sendDebug, typingAttempts: typing.attempts },
          ...(captureNotes ? { captureNotes } : {}),
          profileContractVersion: this.adapter.profile.contractVersion
        }
      };
    } catch (error) {
      // After Send the provider holds a reply; the record must say where.
      if (sent && error && typeof error === 'object') {
        const conversationUrl = await this.getUrl().catch(() => null);
        error.data = { ...(error.data || {}), conversationUrl: error.data?.conversationUrl || conversationUrl };
      }
      throw error;
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  #resolveModeIntent(modeIntent) {
    const requested = typeof modeIntent === 'string' ? modeIntent.trim() : '';
    // "none" leaves the page's selection as it is, as it does for ChatGPT.
    if (!requested || requested.toLowerCase() === 'none') return null;
    const key = requested.toLowerCase();
    // Own properties only: "constructor" must not resolve through the prototype.
    const definition = Object.hasOwn(this.adapter.modeIntents || {}, key) ? this.adapter.modeIntents[key] : null;
    if (!definition) {
      throw namedError('mode_intent_unsupported', {
        vendorId: this.vendorId,
        modeIntent: requested,
        supported: Object.keys(this.adapter.modeIntents || {})
      });
    }
    return { intent: key, ...definition };
  }

  async #openFreshChat({ mode, timeoutMs }) {
    await this.#emitProgress({ phase: 'opening_fresh_chat' });
    const currentUrl = await this.getUrl().catch(() => '');
    const url = this.adapter.freshChatUrl(currentUrl, mode);
    await this.navigate(url);
    const ready = await this.ensureReady({ timeoutMs });
    if (ready.turns.user || ready.turns.assistant) {
      throw namedError('fresh_chat_unavailable', {
        requestedUrl: url,
        servedUrl: ready.url,
        userTurns: ready.turns.user,
        assistantTurns: ready.turns.assistant
      });
    }
    return { url: ready.url };
  }

  // Selecting a mode must be confirmed on the page before the composer is
  // touched; anything short of that fails the run without sending, the rule
  // ADR 0005 set for ChatGPT's modelIntent.
  async #applyMode(mode) {
    this.#throwIfStopRequested();
    await this.#emitProgress({ phase: 'applying_mode', modeIntent: mode.intent });
    let applied;
    try {
      applied = await this.adapter.applyMode(this.#adapterContext(), mode);
    } catch (error) {
      if (error?.message === 'query_aborted') throw error;
      throw namedError('mode_intent_unavailable', {
        vendorId: this.vendorId,
        modeIntent: mode.intent,
        reason: error?.data?.reason || error?.message || 'mode_selection_failed',
        shown: error?.data?.shown || null,
        options: error?.data?.options || null
      });
    }
    if (!applied?.confirmed) {
      throw namedError('mode_intent_unavailable', {
        vendorId: this.vendorId,
        modeIntent: mode.intent,
        reason: 'selection_not_confirmed',
        shown: applied?.shown || null
      });
    }
    await this.#emitProgress({ phase: 'mode_intent_confirmed', modeIntent: mode.intent });
    return { intent: mode.intent, shown: applied.shown || null, label: applied.label ?? null };
  }

  async #attachFiles(files) {
    if (!Array.isArray(files) || !files.length) return [];
    await this.#emitProgress({ phase: 'uploading_files' });
    const filePaths = files.map((file) => path.resolve(String(file)));
    let totalBytes = 0;
    for (const filePath of filePaths) {
      const stat = await fs.stat(filePath).catch((error) => {
        throw namedError('attachment_unreadable', { file: path.basename(filePath), code: error?.code || null });
      });
      totalBytes += stat.size;
    }
    if (totalBytes > MAX_ATTACHMENT_BYTES) throw namedError('attachment_too_large', { maxBytes: MAX_ATTACHMENT_BYTES, totalBytes });
    const prepared = [];
    for (const filePath of filePaths) {
      const bytes = await fs.readFile(filePath).catch((error) => {
        throw namedError('attachment_unreadable', { file: path.basename(filePath), code: error?.code || null });
      });
      prepared.push({
        name: path.basename(filePath),
        mime: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        data: bytes.toString('base64'),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
    }
    const expected = prepared.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
    // An adapter may open a menu to make the input exist; it returns how to close it.
    const revealed = typeof this.adapter.revealFileInput === 'function'
      ? await this.adapter.revealFileInput(this.#adapterContext())
      : null;
    let injected = await this.#eval(injectFiles, { ...this.selectors, files: prepared.map(({ name, mime, data }) => ({ name, mime, data })) });
    if (!injected?.ok && injected?.reason === 'file_input_single') {
      for (const file of prepared) {
        injected = await this.#eval(injectFiles, { ...this.selectors, files: [{ name: file.name, mime: file.mime, data: file.data }] });
        if (!injected?.ok) break;
      }
    }
    await revealed?.close?.();
    if (!injected?.ok) {
      throw namedError('attachment_input_missing', { reason: injected?.reason || 'file_input_not_found', files: expected.map((item) => item.name) });
    }
    const start = Date.now();
    let after = null;
    let match = null;
    while (Date.now() - start < this.timings.uploadMs) {
      this.#throwIfStopRequested();
      await sleep(this.timings.pollMs);
      after = await this.#eval(readAttachments);
      const providerErrors = [
        ...(after?.errorTexts || []),
        ...(after?.items || []).filter((item) => item.error).map((item) => item.text)
      ].filter(Boolean);
      if (providerErrors.length) {
        throw namedError('attachment_upload_failed', {
          reason: 'provider_error',
          detail: clipText(providerErrors[0], 200),
          files: expected.map((item) => item.name)
        });
      }
      match = matchAttachments(expected, after);
      if (match.done) {
        await this.#emitProgress({ attachmentDebug: { stage: 'uploaded', files: match.report.map((item) => item.name) } });
        return match.report.map(({ name, bytes, sha256, matchedBy }) => ({ name, bytes, sha256, matchedBy }));
      }
    }
    if (match?.anyPending) {
      throw namedError('attachment_upload_stalled', {
        pendingText: clipText((after?.items || []).filter((item) => item.pending).map((item) => item.text).join(' | '), 200)
      });
    }
    throw namedError('attachment_not_shown', {
      expected: expected.map((item) => item.name),
      shown: (after?.items || []).map((item) => item.text)
    });
  }

  async #typePrompt(prompt, baseline) {
    this.#throwIfStopRequested();
    await this.#emitProgress({ phase: 'typing_prompt' });
    const composer = await this.#eval(readComposer);
    if (!composer?.found) throw namedError('prompt_focus_failed', { reason: 'composer_not_found' });
    await this.#clickRect(composer.rect);
    const focus = await this.#eval(focusComposer);
    if (!focus?.found) throw namedError('prompt_focus_failed', { reason: 'composer_not_found' });
    // A fresh chat's composer should be empty; clearing also removes any draft.
    await this.page.sendKey('A', { modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await this.page.sendKey('Backspace');
    // One retype is allowed: on 2026-11-18 the Electron typing path once
    // left Kimi's composer with the prompt's last character doubled, which
    // typing the same lines by hand did not reproduce. The comparison stays
    // the gate; a second mismatch fails the run before Send.
    let mismatch = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        await this.page.sendKey('A', { modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
        await this.page.sendKey('Backspace');
      }
      const lines = prompt.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        this.#throwIfStopRequested();
        if (lines[i]) await this.page.insertText(lines[i]);
        if (i < lines.length - 1) await this.page.sendKey('Return', { modifiers: ['shift'] });
      }
      // Shift+Return must add a line, never send; a user turn that appeared
      // while typing means part of the prompt went out.
      const afterTyping = await this.#eval(readTurns);
      if (afterTyping.userTurns > baseline.userTurns) throw namedError('prompt_sent_early', { userTurns: afterTyping.userTurns });
      const staged = await this.#eval(readComposer);
      if (!staged?.found) throw namedError('missing_staged_prompt', { reason: 'composer_not_found' });
      mismatch = compareStagedPrompt(prompt, staged.text, { usesValue: staged.usesValue });
      if (!mismatch) return { attempts: attempt };
    }
    throw namedError('prompt_staging_failed', mismatch);
  }

  // Typing can reset a picker or clear attachment chips, so both are read
  // again right before Send.
  async #recheckBeforeSend({ modeApplied, attachmentReport }) {
    if (modeApplied?.label != null && typeof this.adapter.readModeLabel === 'function') {
      const label = await this.adapter.readModeLabel(this.#adapterContext()).catch(() => null);
      if (label !== modeApplied.label) {
        throw namedError('mode_intent_unavailable', {
          vendorId: this.vendorId,
          modeIntent: modeApplied.intent,
          reason: 'mode_changed_before_send',
          shown: { label }
        });
      }
    }
    if (attachmentReport.length) {
      const expected = attachmentReport.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
      const match = matchAttachments(expected, await this.#eval(readAttachments));
      if (!match.done) {
        throw namedError('attachment_not_shown', {
          stage: 'before_send',
          expected: expected.map((item) => item.name),
          missing: match.report.filter((item) => !item.matchedBy || item.pending).map((item) => item.name)
        });
      }
    }
  }

  async #prepareCapture() {
    if (typeof this.adapter.prepareCapture !== 'function') return null;
    try {
      return await this.adapter.prepareCapture(this.#adapterContext());
    } catch (error) {
      if (error?.message === 'query_aborted') throw error;
      return { failed: true, reason: error?.message || 'prepare_capture_failed' };
    }
  }

  async #clickSend(baseline) {
    this.#throwIfStopRequested();
    await this.#emitProgress({ phase: 'sending' });
    const start = Date.now();
    let send = await this.#eval(readSendButton);
    while ((!send?.found || !send.enabled) && Date.now() - start < this.timings.sendEnableMs) {
      await sleep(this.timings.pollMs);
      send = await this.#eval(readSendButton);
    }
    if (!send?.found || !send.enabled) {
      throw namedError('send_not_triggered', { sendDebug: { found: !!send?.found, enabled: !!send?.enabled, clicked: false } });
    }
    this.#throwIfStopRequested();
    await this.#clickRect(send.rect);
    const ackStart = Date.now();
    while (Date.now() - ackStart < this.timings.sendAckMs) {
      await sleep(this.timings.pollMs);
      // Only a new user turn or a stop control proves the send; a composer can
      // empty for a moment and refill when the provider refuses (Kimi did).
      const turns = await this.#eval(readTurns);
      if (turns.userTurns > baseline.userTurns) return { acknowledgedBy: 'user_turn' };
      if (turns.stopVisible) return { acknowledgedBy: 'stop_control' };
      if (turns.notice) throw namedError('send_refused', { notice: turns.notice });
    }
    throw namedError('send_not_triggered', { sendDebug: { found: true, enabled: true, clicked: true } });
  }

  // Complete only on an assistant node that did not exist before send, whose
  // answer text is not a progress label and has stopped changing for
  // stableMs, with no stop control showing, the turn's idle signal showing,
  // and no provider error in the turn. A missing stop control alone is not
  // proof the answer is done: a search pause can look like that.
  async #waitForAnswer({ baseline, timeoutMs }) {
    await this.#emitProgress({ phase: 'waiting_for_response' });
    const start = Date.now();
    let lastText = null;
    let stableSince = null;
    let last = null;
    while (Date.now() - start < timeoutMs) {
      this.#throwIfStopRequested();
      await sleep(this.timings.pollMs);
      last = await this.#eval(readTurns);
      const answer = last.lastAssistant;
      // A fresh chat has no assistant turn before send, so a new turn is one
      // more than the baseline count (ADR 0009's rule, without message ids).
      const isNew = !!answer && last.assistantTurns > baseline.assistantTurns;
      const text = String(answer?.answerText || '');
      // Kimi took a prompt, opened a chat, then showed its capacity notice and
      // went back to an empty page (2026-11-18): no answer will come.
      if (last.notice && !(isNew && text.trim())) {
        throw namedError('send_refused', { notice: last.notice, stage: 'after_send' });
      }
      if (!isNew || last.stopVisible || !answer.idle || this.#isProgressOnly(text)) {
        lastText = null;
        stableSince = null;
        continue;
      }
      if (text !== lastText) {
        lastText = text;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince < this.timings.stableMs) continue;
      if (answer.error) {
        throw namedError('provider_response_error', { preview: clipText(text, 180) });
      }
      return;
    }
    throw namedError('timeout_waiting_for_response', {
      conversationUrl: await this.getUrl().catch(() => null),
      assistantTurns: last?.assistantTurns ?? null,
      stopVisible: last?.stopVisible ?? null,
      idleVisible: last?.lastAssistant?.idle ?? null,
      answerChars: String(last?.lastAssistant?.answerText || '').length
    });
  }

  #isProgressOnly(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.…]+$/u, '');
    if (!normalized) return true;
    return (this.adapter.progressLabels || []).includes(normalized);
  }

  async #readPromptDelivery(prompt) {
    let timer = null;
    const recorded = await Promise.race([
      this.#eval(readLastUserText).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), this.timings.promptDeliveryMs); })
    ]).finally(() => clearTimeout(timer));
    return promptDeliveryFor(prompt, recorded);
  }

  // Read after the answer is captured, so opening tool-use expanders cannot
  // change the answer text.
  async #readToolUse() {
    if (typeof this.adapter.readToolUse !== 'function') {
      return normalizeToolUse({ state: 'unread', reason: 'adapter_has_no_tool_use_reader' });
    }
    try {
      return normalizeToolUse(await this.adapter.readToolUse(this.#adapterContext()));
    } catch (error) {
      if (error?.message === 'query_aborted') throw error;
      return normalizeToolUse({ state: 'unread', reason: error?.message || 'tool_use_read_failed' });
    }
  }

  // What the page shows as the model and mode once the answer is in. The
  // reading never comes from the request; an unreadable page says why.
  async #readAnswerSettings() {
    try {
      const shown = await this.adapter.readAnswerSettings(this.#adapterContext());
      const model = typeof shown?.model === 'string' && shown.model.trim() ? shown.model.trim() : null;
      const mode = typeof shown?.mode === 'string' && shown.mode.trim() ? shown.mode.trim() : null;
      return {
        model,
        mode,
        ...(typeof shown?.selection === 'string' && shown.selection.trim() ? { selection: shown.selection.trim() } : {}),
        source: shown?.source || null,
        unreadReason: model || mode ? null : shown?.unreadReason || 'not_shown'
      };
    } catch (error) {
      return { model: null, mode: null, source: null, unreadReason: error?.message || 'read_failed' };
    }
  }

  #adapterContext() {
    return {
      evaluate: async (fn, args) => await this.#eval(fn, args),
      selectorsFor: (anchorId) => this.adapter.profile.selectorsFor(anchorId),
      click: async (rect) => await this.#clickRect(rect),
      pressKey: async (key, options) => await this.page.sendKey(key, options),
      sleep,
      timings: this.timings,
      throwIfStopRequested: () => this.#throwIfStopRequested(),
      getUrl: async () => await this.getUrl()
    };
  }

  async #clickRect(rect) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) throw namedError('click_target_missing', { rect: rect || null });
    const x = Math.floor(rect.x + rect.w / 2);
    const y = Math.floor(rect.y + rect.h / 2);
    await this.page.moveMouse(x, y);
    await this.page.mouseDown(x, y, { button: 'left', clickCount: 1 });
    await this.page.mouseUp(x, y, { button: 'left', clickCount: 1 });
  }

  #throwIfStopRequested() {
    if (!this.currentRun?.requested) return;
    throw namedError('query_aborted', {
      reason: this.currentRun.reason || 'user_stop',
      requestedAt: this.currentRun.requestedAt || null
    });
  }

  async #emitProgress(patch) {
    if (!this.currentRun?.onProgress || !patch || typeof patch !== 'object') return;
    try {
      await this.currentRun.onProgress({ ...patch });
    } catch {}
  }

  async #enterBlockedState(state) {
    if (this.blocked) return;
    this.blocked = true;
    await this.#emitProgress({ phase: 'awaiting_user', blocked: true, blockedKind: state?.kind || 'blocked' });
    await this.onBlocked?.(state);
  }

  async #exitBlockedStateIfNeeded() {
    if (!this.blocked) return;
    this.blocked = false;
    await this.#emitProgress({ blocked: false, blockedKind: null, blockedTitle: null });
    await this.onUnblocked?.();
  }
}
