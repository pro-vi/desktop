import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { writeToken, readProjects, writeProjects } from './state.mjs';
import {
  ensureArtifactsDir,
  ensureRunArtifactsDir,
  listArtifacts,
  registerArtifact,
  artifactsRoot,
  assertArtifactFileReady
} from './artifact-store.mjs';
import { deleteBundle, getBundle, listBundles, saveBundle } from './bundle-store.mjs';
import { assertWithin } from './orchestrator/security.mjs';
import { prepareQueryContext } from './context-packer.mjs';
import { createRunStore } from './run-store.mjs';

function isLoopback(remoteAddress) {
  const a = String(remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store, max-age=0',
    'access-control-allow-origin': 'http://127.0.0.1',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(data);
}

async function parseBody(req, { maxBytes = 2_000_000 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}

function authOk(req, token) {
  const hdr = String(req.headers.authorization || '');
  if (!hdr.startsWith('Bearer ')) return false;
  return hdr.slice('Bearer '.length).trim() === token;
}

function mapErrorToHttp(error) {
  const msg = String(error?.message || '');
  if (msg === 'body_too_large') return { code: 413, body: { error: 'body_too_large' } };
  if (msg === 'invalid_json') return { code: 400, body: { error: 'invalid_json' } };
  if (msg === 'invalid_vendor') return { code: 400, body: { error: 'invalid_vendor', data: error?.data || null } };
  if (msg === 'invalid_artifact_mode') return { code: 400, body: { error: 'invalid_artifact_mode', data: error?.data || null } };
  if (msg === 'relative_path_not_allowed') return { code: 400, body: { error: 'relative_path_not_allowed', data: error?.data || null } };
  if (msg === 'missing_url') return { code: 400, body: { error: 'missing_url' } };
  if (msg === 'missing_prompt') return { code: 400, body: { error: 'missing_prompt' } };
  if (msg === 'missing_attachment_path') return { code: 400, body: { error: 'missing_attachment_path', data: error?.data || null } };
  if (msg === 'missing_context_path') return { code: 400, body: { error: 'missing_context_path', data: error?.data || null } };
  if (msg === 'missing_bundle_name') return { code: 400, body: { error: 'missing_bundle_name' } };
  if (msg === 'bundle_name_too_large') return { code: 400, body: { error: 'bundle_name_too_large' } };
  if (msg === 'bundle_not_found') return { code: 404, body: { error: 'bundle_not_found', data: error?.data || null } };
  if (msg === 'missing_watch_folder_path') return { code: 400, body: { error: 'missing_watch_folder_path' } };
  if (msg === 'missing_watch_folder_name') return { code: 400, body: { error: 'missing_watch_folder_name' } };
  if (msg === 'watch_folder_not_directory') return { code: 400, body: { error: 'watch_folder_not_directory' } };
  if (msg === 'watch_folder_overlaps_existing') return { code: 409, body: { error: 'watch_folder_overlaps_existing' } };
  if (msg === 'watch_folder_cannot_be_filesystem_root') return { code: 400, body: { error: 'watch_folder_cannot_be_filesystem_root' } };
  if (msg === 'watch_folder_not_found') return { code: 404, body: { error: 'watch_folder_not_found' } };
  if (msg === 'prompt_too_large') return { code: 400, body: { error: 'prompt_too_large' } };
  if (msg === 'attachment_upload_failed') return { code: 409, body: { error: 'attachment_upload_failed', data: error?.data || null } };
  if (msg === 'attachment_upload_stalled') return { code: 409, body: { error: 'attachment_upload_stalled', data: error?.data || null } };
  if (msg === 'missing_staged_prompt') return { code: 409, body: { error: 'missing_staged_prompt', data: error?.data || null } };
  if (msg === 'send_not_triggered') return { code: 409, body: { error: 'send_not_triggered', data: error?.data || null } };
  if (msg === 'missing_tabId') return { code: 400, body: { error: 'missing_tabId' } };
  if (msg === 'missing_key') return { code: 400, body: { error: 'missing_key' } };
  if (msg === 'missing_run_id') return { code: 400, body: { error: 'missing_run_id' } };
  if (msg === 'run_not_found') return { code: 404, body: { error: 'run_not_found' } };
  if (msg === 'run_not_retryable') return { code: 409, body: { error: 'run_not_retryable' } };
  if (msg === 'tab_busy') return { code: 409, body: { error: 'tab_busy', data: error?.data || null } };
  if (msg === 'key_vendor_mismatch') return { code: 409, body: { error: 'key_vendor_mismatch' } };
  if (msg === 'tab_not_found') return { code: 404, body: { error: 'tab_not_found' } };
  if (msg === 'tab_closed') return { code: 409, body: { error: 'tab_closed' } };
  if (msg === 'default_tab_protected') return { code: 409, body: { error: 'default_tab_protected' } };
  if (msg === 'max_tabs_reached') return { code: 409, body: { error: 'max_tabs_reached' } };
  if (msg === 'rate_limited') return { code: 429, body: { error: 'rate_limited', ...(error?.data || {}) } };
  if (msg === 'query_aborted') return { code: 409, body: { error: 'query_aborted', data: error?.data || null } };
  if (msg === 'timeout_waiting_for_prompt') return { code: 408, body: { error: 'timeout_waiting_for_prompt', data: error?.data || null } };
  if (msg === 'timeout_waiting_for_response') return { code: 408, body: { error: 'timeout_waiting_for_response', data: error?.data || null } };
  if (msg === 'artifacts_folder_open_failed') return { code: 500, body: { error: 'artifacts_folder_open_failed', data: error?.data || null } };
  if (msg === 'artifact_save_failed') return { code: 500, body: { error: 'artifact_save_failed', data: error?.data || null } };
  if (msg === 'research_requires_chatgpt') return { code: 409, body: { error: 'research_requires_chatgpt', data: error?.data || null } };
  if (msg === 'research_mode_activation_failed') return { code: 409, body: { error: 'research_mode_activation_failed', data: error?.data || null } };
  return null;
}

function getTabIdFromUrl(url) {
  const tabId = String(url.searchParams.get('tabId') || '').trim();
  return tabId || null;
}

function envShowTabsDefault() {
  const v = String(process.env.AGENTIFY_DESKTOP_SHOW_TABS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function positiveIntOr(value, fallback, max = Number.POSITIVE_INFINITY) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeAbsolutePathList(items, { field } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(trimmed)) {
      const err = new Error('relative_path_not_allowed');
      err.data = { field: field || null, path: trimmed };
      throw err;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function normalizeAbsoluteSinglePath(value, { field } = {}) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (!path.isAbsolute(trimmed)) {
    const err = new Error('relative_path_not_allowed');
    err.data = { field: field || null, path: trimmed };
    throw err;
  }
  return path.resolve(trimmed);
}

async function runExclusive(controller, fn) {
  if (controller && typeof controller.runExclusive === 'function') return await controller.runExclusive(fn);
  return await fn();
}

function normalizeVendorToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function builtinChatGPTVendor() {
  return { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' };
}

function resolveVendor({ body, vendors = [] } = {}) {
  const raw = String(body?.vendorId || body?.model || '').trim();
  if (!raw) return null;
  const token = normalizeVendorToken(raw);
  const rows = Array.isArray(vendors) ? vendors : [];
  if (!rows.length && token === 'chatgpt') return builtinChatGPTVendor();
  const found = rows.find((item) => {
    const id = normalizeVendorToken(item?.id || '');
    const name = normalizeVendorToken(item?.name || '');
    return token && (token === id || token === name);
  });
  if (!found) {
    const err = new Error('invalid_vendor');
    err.data = { vendor: raw };
    throw err;
  }
  return found;
}

function defaultVendor(vendors = []) {
  const rows = Array.isArray(vendors) ? vendors : [];
  return rows.find((item) => String(item?.id || '').trim() === 'chatgpt') || rows[0] || builtinChatGPTVendor();
}

function listedTabMatchesVendor(tab, vendor) {
  if (!vendor) return true;
  const tabVendor = normalizeVendorToken(tab?.vendorId || '');
  const requestedVendor = normalizeVendorToken(vendor?.id || '');
  if (tabVendor && requestedVendor) return tabVendor === requestedVendor;
  const tabUrl = String(tab?.url || '').trim();
  const requestedUrl = String(vendor?.url || '').trim();
  if (tabUrl && requestedUrl) return tabUrl.startsWith(requestedUrl) || requestedUrl.startsWith(tabUrl);
  return false;
}

function normalizeLocationUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return new URL(text).toString();
  } catch {
    return text;
  }
}

function extractConversationUrl(value) {
  const text = normalizeLocationUrl(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return /\/c\/[^/]+\/?$/.test(parsed.pathname) ? parsed.toString() : null;
  } catch {
    return /\/c\/[^/?#]+/.test(text) ? text : null;
  }
}

function extractProjectUrl(value) {
  const text = normalizeLocationUrl(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return /\/project\/?$/.test(parsed.pathname) ? parsed.toString() : null;
  } catch {
    return /\/project\/?$/.test(text) ? text : null;
  }
}

function deriveProjectUrlFromConversationUrl(value) {
  const conversationUrl = extractConversationUrl(value);
  if (!conversationUrl) return null;
  try {
    const parsed = new URL(conversationUrl);
    const idx = parsed.pathname.indexOf('/c/');
    const prefix = idx > 0 ? parsed.pathname.slice(0, idx) : '';
    if (!prefix || prefix === '/') return null;
    parsed.pathname = `${prefix}/project`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const match = conversationUrl.match(/^(https?:\/\/[^/]+(?:\/[^/?#]+)+)\/c\/[^/?#]+/);
    return match ? `${match[1]}/project` : null;
  }
}

function locationPatchForPersistence({ url = null, projectUrl = null, conversationUrl = null } = {}) {
  const nextConversationUrl = extractConversationUrl(conversationUrl || url);
  const nextProjectUrl =
    extractProjectUrl(projectUrl || url) ||
    deriveProjectUrlFromConversationUrl(conversationUrl || url) ||
    null;
  const patch = {};
  if (nextProjectUrl) patch.projectUrl = nextProjectUrl;
  if (nextConversationUrl) patch.conversationUrl = nextConversationUrl;
  return patch;
}

async function resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault = false, createIfMissing = true, vendors = [] }) {
  const tabId = (body?.tabId ? String(body.tabId).trim() : '') || getTabIdFromUrl(url) || null;
  const key = (body?.key ? String(body.key).trim() : '') || null;
  const name = (body?.name ? String(body.name).trim() : '') || null;
  const explicitVendor = resolveVendor({ body, vendors });
  const vendor = explicitVendor || defaultVendor(vendors);
  if (tabId) return tabId;
  if (key) {
    if (!createIfMissing) {
      const existing = (tabs.listTabs?.() || []).find((t) => t?.key === key);
      if (explicitVendor && existing?.id && !listedTabMatchesVendor(existing, explicitVendor)) throw new Error('key_vendor_mismatch');
      if (existing?.id) return existing.id;
      throw new Error('tab_not_found');
    }
    return await tabs.ensureTab({
      key,
      name,
      show: envShowTabsDefault() || showTabsByDefault,
      url: vendor?.url,
      vendorId: vendor?.id,
      vendorName: vendor?.name
    });
  }
  if (explicitVendor) {
    const rows = Array.isArray(tabs.listTabs?.()) ? tabs.listTabs() : [];
    const defaultTab = rows.find((item) => String(item?.id || '') === String(defaultTabId || '')) || null;
    if (listedTabMatchesVendor(defaultTab, explicitVendor)) return defaultTabId;
    if (!createIfMissing) throw new Error('tab_not_found');
    return await tabs.ensureTab({
      key: `vendor:${explicitVendor.id}`,
      name: explicitVendor.name || explicitVendor.id,
      show: envShowTabsDefault() || showTabsByDefault,
      url: explicitVendor.url,
      vendorId: explicitVendor.id,
      vendorName: explicitVendor.name
    });
  }
  return defaultTabId;
}

function getTabMeta(tabs, tabId) {
  const rows = Array.isArray(tabs?.listTabs?.()) ? tabs.listTabs() : [];
  return rows.find((row) => String(row?.id || '') === String(tabId || '')) || null;
}

function contextBudgetForVendor(vendorId) {
  const key = String(vendorId || 'chatgpt').trim().toLowerCase() || 'chatgpt';
  const presets = {
    chatgpt: {
      maxContextChars: 110_000,
      maxFiles: 80,
      maxFileChars: 18_000,
      maxChunkChars: 6_000,
      maxChunksPerFile: 3,
      maxInlineFiles: 18,
      maxAttachmentFiles: 10
    },
    claude: {
      maxContextChars: 140_000,
      maxFiles: 100,
      maxFileChars: 22_000,
      maxChunkChars: 7_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 20,
      maxAttachmentFiles: 12
    },
    gemini: {
      maxContextChars: 90_000,
      maxFiles: 70,
      maxFileChars: 16_000,
      maxChunkChars: 5_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 16,
      maxAttachmentFiles: 10
    },
    aistudio: {
      maxContextChars: 120_000,
      maxFiles: 90,
      maxFileChars: 20_000,
      maxChunkChars: 6_500,
      maxChunksPerFile: 3,
      maxInlineFiles: 18,
      maxAttachmentFiles: 12
    },
    perplexity: {
      maxContextChars: 70_000,
      maxFiles: 55,
      maxFileChars: 12_000,
      maxChunkChars: 4_500,
      maxChunksPerFile: 2,
      maxInlineFiles: 12,
      maxAttachmentFiles: 8
    },
    grok: {
      maxContextChars: 80_000,
      maxFiles: 60,
      maxFileChars: 14_000,
      maxChunkChars: 5_000,
      maxChunksPerFile: 2,
      maxInlineFiles: 14,
      maxAttachmentFiles: 8
    }
  };
  return presets[key] || presets.chatgpt;
}

function defaultResearchMeta({ tabId = null, outputDir = null } = {}) {
  return {
    activation: {
      requested: true,
      activated: false,
      error: null,
      tabId: tabId || null,
      conversationUrl: null,
      debug: null
    },
    outputManifest: {
      dir: outputDir || null,
      responsePath: null,
      exportedMarkdownPath: null,
      files: []
    }
  };
}

function cloneResearchMeta(researchMeta, { tabId = null, outputDir = null } = {}) {
  const base = defaultResearchMeta({ tabId, outputDir });
  if (!researchMeta || typeof researchMeta !== 'object' || Array.isArray(researchMeta)) return base;
  const activationInput = researchMeta.activation && typeof researchMeta.activation === 'object' ? researchMeta.activation : {};
  const outputInput = researchMeta.outputManifest && typeof researchMeta.outputManifest === 'object' ? researchMeta.outputManifest : {};
  return {
    activation: {
      requested: activationInput.requested !== false,
      activated: !!activationInput.activated,
      error: activationInput.error ? String(activationInput.error) : null,
      tabId: String(activationInput.tabId || tabId || '').trim() || null,
      conversationUrl: String(activationInput.conversationUrl || '').trim() || null,
      debug: activationInput.debug && typeof activationInput.debug === 'object'
        ? JSON.parse(JSON.stringify(activationInput.debug))
        : null
    },
    outputManifest: {
      dir: String(outputInput.dir || outputDir || '').trim() || null,
      responsePath: String(outputInput.responsePath || '').trim() || null,
      exportedMarkdownPath: String(outputInput.exportedMarkdownPath || '').trim() || null,
      files: Array.isArray(outputInput.files)
        ? outputInput.files
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({ ...item }))
        : []
    }
  };
}

function responseMarkdownContent(text) {
  const body = String(text || '');
  return body.endsWith('\n') ? body : `${body}\n`;
}

function looksLikeResearchPlaceholder(text) {
  const raw = String(text || '');
  const compact = raw.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!compact) return true;
  const hasChromeTabs = /\bdeep research\b/.test(compact) && /\bapps\b/.test(compact) && /\bsites\b/.test(compact);
  const hasFooter = /chatgpt can make mistakes\.?\s*check important info\.?/.test(compact);
  const hasTranscript = /\byou said:\b/.test(compact) && /\bchatgpt said:\b/.test(compact);
  return (hasChromeTabs || hasTranscript) && hasFooter && compact.length <= 700;
}

async function writeResearchResponseFile({ outDir, text }) {
  await fs.mkdir(outDir, { recursive: true });
  const responsePath = path.join(outDir, 'response.md');
  await fs.writeFile(responsePath, responseMarkdownContent(text), 'utf8');
  return responsePath;
}

async function collectRegisteredArtifacts({
  stateDir,
  tabId,
  tabKey = null,
  vendorId = null,
  runId = null,
  outDir,
  candidates = []
}) {
  const realOutDir = await fs.realpath(outDir);
  const prepared = [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item || typeof item !== 'object') continue;
    const rawPath = String(item.filePath || '').trim();
    if (!rawPath) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: 'missing_artifact_path', kind: item?.kind || null };
      throw err;
    }
    let ready = null;
    try {
      ready = await assertArtifactFileReady(rawPath);
    } catch (error) {
      const err = new Error('artifact_save_failed');
      err.data = { reason: String(error?.message || 'artifact_invalid'), kind: item?.kind || null, filePath: path.resolve(rawPath) };
      throw err;
    }
    try {
      assertWithin({ filePath: ready.realFilePath || ready.filePath, allowedRoots: [realOutDir] });
    } catch (error) {
      if (String(error?.message || '') === 'path_not_allowed') {
        const err = new Error('artifact_save_failed');
        err.data = { reason: 'artifact_outside_output_dir', kind: item?.kind || null, filePath: ready.filePath, outDir };
        throw err;
      }
      throw error;
    }
    prepared.push({
      ...item,
      readyFilePath: ready.filePath
    });
  }
  const saved = [];
  for (const item of prepared) {
    const record = await registerArtifact({
      stateDir,
      tabId,
      tabKey,
      vendorId,
      kind: item.kind || 'file',
      filePath: item.readyFilePath,
      originalName: item.originalName || null,
      mime: item.mime || null,
      source: item.source || null,
      meta: {
        ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
        runId: runId || null
      }
    });
    saved.push(record);
  }
  return saved;
}

async function saveArtifactsForTab({
  stateDir,
  tabs,
  tabId,
  controller,
  mode = 'images',
  maxImages = 6,
  maxFiles = 6
}) {
  const normalizedMode = String(mode || 'images').trim().toLowerCase();
  if (!['images', 'files', 'all'].includes(normalizedMode)) {
    const err = new Error('invalid_artifact_mode');
    err.data = { mode };
    throw err;
  }
  const meta = getTabMeta(tabs, tabId);
  const outDir = await ensureArtifactsDir({
    stateDir,
    tabId,
    tabKey: meta?.key || null,
    vendorId: meta?.vendorId || null
  });
  const realOutDir = await fs.realpath(outDir);
  const candidates = [];

  if ((normalizedMode === 'images' || normalizedMode === 'all') && typeof controller.downloadLastAssistantImages === 'function') {
    const images = await controller.downloadLastAssistantImages({ maxImages, outDir });
    for (const item of images || []) {
      candidates.push({
        kind: 'image',
        filePath: item?.path,
        originalName: item?.name || null,
        mime: item?.mime || null,
        source: item?.source || null,
        meta: { alt: item?.alt || null }
      });
    }
  }

  if ((normalizedMode === 'files' || normalizedMode === 'all') && typeof controller.downloadLastAssistantFiles === 'function') {
    const files = await controller.downloadLastAssistantFiles({ maxFiles, outDir });
    for (const item of files || []) {
      candidates.push({
        kind: 'file',
        filePath: item?.path,
        originalName: item?.name || null,
        mime: item?.mime || null,
        source: item?.source || null,
        meta: null
      });
    }
  }

  const saved = await collectRegisteredArtifacts({
    stateDir,
    tabId,
    tabKey: meta?.key || null,
    vendorId: meta?.vendorId || null,
    outDir: realOutDir,
    candidates
  });

  return { dir: outDir, items: saved };
}

async function exportResearchArtifactsForTab({
  stateDir,
  tabs,
  tabId,
  controller,
  maxFiles = 6,
  timeoutMs = 20_000
}) {
  const meta = getTabMeta(tabs, tabId);
  const outDir = await ensureArtifactsDir({
    stateDir,
    tabId,
    tabKey: meta?.key || null,
    vendorId: meta?.vendorId || null
  });
  const realOutDir = await fs.realpath(outDir);
  const exported = typeof controller.exportResearchReport === 'function'
    ? await controller.exportResearchReport({ maxFiles, outDir, timeoutMs })
    : {
        files: await controller.downloadLastAssistantFiles({ maxFiles, outDir, linkMode: 'export' }),
        exportedMarkdownPath: null,
        state: null
      };
  const candidates = [];
  for (const item of exported?.files || []) {
    candidates.push({
      kind: 'file',
      filePath: item?.path,
      originalName: item?.name || null,
      mime: item?.mime || null,
      source: item?.source || null,
      meta: { role: 'download' }
    });
  }
  const saved = await collectRegisteredArtifacts({
    stateDir,
    tabId,
    tabKey: meta?.key || null,
    vendorId: meta?.vendorId || null,
    outDir: realOutDir,
    candidates
  });
  return {
    dir: outDir,
    items: saved,
    exportState: exported?.state || null,
    exportedMarkdownPath: exported?.exportedMarkdownPath || null
  };
}

function mergeQueryInputs({ bundle, promptPrefix, attachments, contextPaths }) {
  const mergedAttachments = normalizeAbsolutePathList([...(bundle?.attachments || []), ...(attachments || [])], {
    field: 'attachments'
  });
  const mergedContextPaths = normalizeAbsolutePathList([...(bundle?.contextPaths || []), ...(contextPaths || [])], {
    field: 'contextPaths'
  });
  const mergedPrefix = [String(bundle?.promptPrefix || '').trim(), String(promptPrefix || '').trim()].filter(Boolean).join('\n\n');
  return { promptPrefix: mergedPrefix, attachments: mergedAttachments, contextPaths: mergedContextPaths };
}

export function startHttpApi({
  host = '127.0.0.1',
  port,
  token,
  tabs,
  defaultTabId,
  vendors = [],
  serverId,
  stateDir,
  onShow,
  onHide,
  onShutdown,
  onOpenArtifactsFolder,
  onWatchFoldersList,
  onAddWatchFolder,
  onRemoveWatchFolder,
  onOpenWatchFolder,
  onScanWatchFolder,
  getStatus,
  getSettings,
  onRuntimeChanged,
  onRunsChanged
}) {
  const tokenRef = typeof token === 'string' ? { current: token } : token;

  // Persistent key → { projectUrl, conversationUrl } map.
  let keyMetaByKey = {};
  let keyMetaWriteQueue = Promise.resolve();
  const projectsReady = readProjects(stateDir).then((p) => { keyMetaByKey = p; }).catch(() => {});
  function persistKeyMeta(key, patch) {
    if (!key || !patch) return Promise.resolve(null);
    const existing = keyMetaByKey[key] || { projectUrl: null, conversationUrl: null };
    const updated = { ...existing, ...patch };
    if (existing.projectUrl === updated.projectUrl && existing.conversationUrl === updated.conversationUrl) {
      return Promise.resolve(updated);
    }
    const snapshot = { ...keyMetaByKey, [key]: updated };
    keyMetaByKey = snapshot;
    keyMetaWriteQueue = keyMetaWriteQueue
      .catch(() => {})
      .then(() => writeProjects(snapshot, stateDir));
    return keyMetaWriteQueue.then(() => updated).catch(() => updated);
  }
  function getPersistedKeyMeta(key) {
    return (key && keyMetaByKey[key]) || null;
  }

  function persistKeyLocation(key, { url = null, projectUrl = null, conversationUrl = null } = {}) {
    if (!key) return Promise.resolve(null);
    const patch = locationPatchForPersistence({ url, projectUrl, conversationUrl });
    if (!Object.keys(patch).length) return Promise.resolve(null);
    return Promise.resolve(persistKeyMeta(key, patch)).then(() => patch);
  }

  const runStore = createRunStore(stateDir);
  const runsSnapshot = ({ includeArchived = false, limit = 100 } = {}) => runStore.list({ includeArchived, limit });
  const emitRunsChanged = () => {
    try {
      onRunsChanged?.(runsSnapshot());
    } catch {}
  };
  const runsReady = runStore.load().then(() => {
    emitRunsChanged();
  });

  const createRunRecord = async (record) => {
    const created = await runStore.create(record);
    emitRunsChanged();
    return created;
  };

  const patchRunRecord = async (runId, patchData) => {
    const patched = await runStore.patch(runId, patchData);
    emitRunsChanged();
    return patched;
  };

  const finalizeRunRecord = async (runId, patchData) => {
    const finalized = await runStore.finalize(runId, patchData);
    emitRunsChanged();
    return finalized;
  };

  const archiveRunRecord = async (runId) => {
    const archived = await runStore.archive(runId);
    emitRunsChanged();
    return archived;
  };

  // Governor state (per-desktop instance).
  const inflight = { queries: 0 };
  const activeQueries = new Map(); // tabId -> runtime status
  const activeScopes = new Map(); // request scope -> runtime status
  const lastOutcomes = new Map(); // tabId -> last finished outcome
  const lastQueryAt = new Map(); // tabId -> ms
  let lastAnyQueryAt = 0;
  const bucket = { tokens: null, lastRefillAt: Date.now(), lastCap: null };

  const getGovernor = async () => {
    const s = (await getSettings?.().catch(() => null)) || {};
    const maxInflightQueries = Math.max(1, Number(s.maxInflightQueries || 2) || 2);
    const maxQueriesPerMinute = Math.max(1, Number(s.maxQueriesPerMinute || 12) || 12);
    const minTabGapMs = Math.max(0, Number(s.minTabGapMs || 0) || 0);
    const minGlobalGapMs = Math.max(0, Number(s.minGlobalGapMs || 0) || 0);
    const showTabsByDefault = !!s.showTabsByDefault;
    return { maxInflightQueries, maxQueriesPerMinute, minTabGapMs, minGlobalGapMs, showTabsByDefault };
  };

  const checkAndConsumeQueryBudget = ({ tabId, governor }) => {
    const now = Date.now();
    if (inflight.queries >= governor.maxInflightQueries) {
      const err = new Error('rate_limited');
      err.data = { reason: 'max_inflight', retryAfterMs: 250 };
      throw err;
    }

    const lastTab = lastQueryAt.get(tabId) || 0;
    const tabWait = governor.minTabGapMs - (now - lastTab);
    if (tabWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'tab_gap', retryAfterMs: tabWait };
      throw err;
    }

    const globalWait = governor.minGlobalGapMs - (now - lastAnyQueryAt);
    if (globalWait > 0) {
      const err = new Error('rate_limited');
      err.data = { reason: 'global_gap', retryAfterMs: globalWait };
      throw err;
    }

    // Token bucket (per minute).
    const cap = governor.maxQueriesPerMinute;
    const ratePerMs = cap / 60_000;
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    if (bucket.tokens == null) bucket.tokens = cap;
    if (bucket.lastCap == null) bucket.lastCap = cap;
    if (cap !== bucket.lastCap) {
      if (cap > bucket.lastCap) bucket.tokens = Math.min(cap, bucket.tokens + (cap - bucket.lastCap));
      else bucket.tokens = Math.min(cap, bucket.tokens);
      bucket.lastCap = cap;
    }
    bucket.tokens = Math.min(cap, bucket.tokens + elapsed * ratePerMs);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      const needed = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(needed / ratePerMs);
      const err = new Error('rate_limited');
      err.data = { reason: 'qpm', retryAfterMs: Math.max(50, retryAfterMs) };
      throw err;
    }

    bucket.tokens -= 1;
    lastQueryAt.set(tabId, now);
    lastAnyQueryAt = now;
  };

  const trimPreview = (value, max = 140) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };

  const requestSourceForBody = (body) => {
    const raw = String(body?.source || '').trim().toLowerCase();
    if (raw === 'mcp' || raw === 'cli') return 'mcp';
    if (raw === 'ui') return 'ui';
    return 'http';
  };

  const blockedLabelForKind = (kind) => {
    if (kind === 'login') return 'Needs sign-in';
    if (kind === 'captcha') return 'Needs CAPTCHA';
    if (kind === 'blocked') return 'Access blocked';
    if (kind === 'ui') return 'Needs page ready';
    return 'Needs attention';
  };

  const outcomeFromError = (error, op) => {
    const message = String(error?.message || 'error');
    const detail = error?.data || null;
    const base = {
      source: op?.source || 'http',
      kind: op?.kind || 'query',
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - Number(op?.startedAt || Date.now()))
    };
    if (message === 'query_aborted') {
      return {
        ...base,
        status: 'stopped',
        label: 'Stopped',
        detail: 'Break-glass stop requested.'
      };
    }
    if (message === 'timeout_waiting_for_prompt') {
      const kind = String(detail?.kind || '').trim() || 'blocked';
      return {
        ...base,
        status: 'blocked',
        label: blockedLabelForKind(kind),
        detail: kind === 'login'
          ? 'Waiting for sign-in in the provider window.'
          : kind === 'captcha'
            ? 'Waiting for CAPTCHA or human verification.'
            : 'Waiting for the page to become ready.',
        blocked: true,
        blockedKind: kind
      };
    }
    if (message === 'timeout_waiting_for_response') {
      return {
        ...base,
        status: 'error',
        label: 'Response timed out',
        detail: 'The provider did not finish responding in time.',
        conversationUrl: detail?.conversationUrl || null
      };
    }
    if (message === 'attachment_upload_failed') {
      return {
        ...base,
        status: 'error',
        label: 'Attachment rejected',
        detail: detail?.detail ? `The provider rejected the attachment: ${detail.detail}` : 'The provider rejected the attachment before send.',
        attachmentDebug: detail || null
      };
    }
    if (message === 'attachment_upload_stalled') {
      return {
        ...base,
        status: 'error',
        label: 'Attachment stalled',
        detail: detail?.pendingText ? `Attachment never finished uploading: ${detail.pendingText}` : 'Attachment never finished uploading.',
        attachmentDebug: detail || null
      };
    }
    if (message === 'missing_staged_prompt') {
      return {
        ...base,
        status: 'error',
        label: 'Prompt not staged',
        detail: 'The prompt never appeared in the active composer.'
      };
    }
    if (message === 'send_not_triggered') {
      return {
        ...base,
        status: 'error',
        label: 'Prompt not sent',
        detail: 'The provider UI never acknowledged the send action.',
        sendDebug: detail?.sendDebug || null
      };
    }
    if (message === 'rate_limited') {
      return {
        ...base,
        status: 'error',
        label: 'Rate limited',
        detail: detail?.reason ? `Governor blocked this run (${detail.reason}).` : 'Governor blocked this run.'
      };
    }
    if (message === 'tab_busy') {
      return {
        ...base,
        status: 'error',
        label: 'Tab busy',
        detail: 'Another run is already active on this tab.'
      };
    }
    if (message === 'research_requires_chatgpt') {
      return {
        ...base,
        status: 'error',
        label: 'ChatGPT required',
        detail: 'Research runs only support ChatGPT in this build.'
      };
    }
    if (message === 'research_mode_activation_failed') {
      const triggerAction = detail?.trigger?.action ? String(detail.trigger.action) : null;
      const triggerLabel = detail?.trigger?.label ? trimPreview(detail.trigger.label, 60) : null;
      const stateMenuOpen = typeof detail?.state?.menuOpen === 'boolean' ? detail.state.menuOpen : null;
      const stateDialog = detail?.state?.dialogText ? trimPreview(detail.state.dialogText, 80) : null;
      const stateComposerHint = Array.isArray(detail?.state?.composerHints) && detail.state.composerHints.length
        ? trimPreview(detail.state.composerHints.join(' | '), 100)
        : null;
      const debugSuffix = [triggerAction, triggerLabel, stateMenuOpen === null ? null : `menuOpen=${stateMenuOpen}`, stateDialog, stateComposerHint]
        .filter(Boolean)
        .join('; ');
      return {
        ...base,
        status: 'error',
        label: 'Deep Research unavailable',
        detail: detail?.reason
          ? `ChatGPT Deep Research could not be activated: ${detail.reason}${debugSuffix ? ` (${debugSuffix})` : ''}`
          : 'ChatGPT Deep Research could not be activated on this tab.'
      };
    }
    if (message === 'research_output_incomplete') {
      return {
        ...base,
        status: 'error',
        label: 'Research output incomplete',
        detail: detail?.preview
          ? `Deep Research finished, but the captured output still looked like placeholder UI text: ${detail.preview}`
          : 'Deep Research finished, but the final report could not be captured cleanly.',
        conversationUrl: detail?.conversationUrl || null
      };
    }
    return {
      ...base,
      status: 'error',
      label: 'Run failed',
      detail: message
    };
  };

  const logicalQueryRequest = ({
    body,
    prompt,
    promptPrefix,
    attachments,
    contextPaths,
    bundleName,
    timeoutMs,
    source,
    fireAndForget,
    projectUrl
  }) => ({
    prompt: String(prompt || ''),
    promptPrefix: String(promptPrefix || ''),
    attachments: Array.isArray(attachments) ? attachments.map(String) : [],
    contextPaths: Array.isArray(contextPaths) ? contextPaths.map(String) : [],
    bundleName: String(bundleName || '').trim() || null,
    timeoutMs: Number(timeoutMs) || null,
    source: String(source || 'http'),
    fireAndForget: !!fireAndForget,
    key: body?.key ? String(body.key).trim() : null,
    tabId: body?.tabId ? String(body.tabId).trim() : null,
    vendorId: body?.vendorId ? String(body.vendorId).trim() : (body?.model ? String(body.model).trim() : null),
    model: body?.model ? String(body.model).trim() : null,
    projectUrl: String(projectUrl || '').trim() || null
  });

  const logicalResearchRequest = ({
    body,
    prompt,
    attachments,
    contextPaths,
    bundleName,
    timeoutMs,
    source,
    projectUrl
  }) => ({
    prompt: String(prompt || ''),
    attachments: Array.isArray(attachments) ? attachments.map(String) : [],
    contextPaths: Array.isArray(contextPaths) ? contextPaths.map(String) : [],
    bundleName: String(bundleName || '').trim() || null,
    timeoutMs: Number(timeoutMs) || null,
    source: String(source || 'http'),
    fireAndForget: true,
    key: body?.key ? String(body.key).trim() : null,
    tabId: body?.tabId ? String(body.tabId).trim() : null,
    vendorId: 'chatgpt',
    projectUrl: String(projectUrl || '').trim() || null
  });

  const materializedReplay = ({ packed, timeoutMs, kind = 'query' }) => ({
    kind: String(kind || 'query'),
    prompt: String(packed?.prompt || ''),
    attachments: Array.isArray(packed?.attachments) ? packed.attachments.map(String) : [],
    timeoutMs: Number(timeoutMs) || null
  });

  const durableRunPatchFromActive = async (item) => {
    if (!item?.id) return;
    try {
      await patchRunRecord(item.id, {
        status: item.blocked ? 'blocked' : 'running',
        phase: item.phase || null,
        tabId: item.tabId || null,
        key: item.key || null,
        vendorId: item.vendorId || null,
        vendorName: item.vendorName || null,
        projectUrl: item.projectUrl || null,
        promptPreview: item.promptPreview || null,
        blocked: !!item.blocked,
        blockedKind: item.blockedKind || null,
        blockedTitle: item.blockedTitle || null,
        stopRequested: !!item.stopRequested,
        stopRequestedAt: item.stopRequestedAt || null,
        ...(item.conversationUrl
          ? { conversationUrl: item.conversationUrl }
          : {}),
        ...(item.researchMeta
          ? { researchMeta: cloneResearchMeta(item.researchMeta, { tabId: item.tabId || null }) }
          : {})
      });
    } catch {}
  };

  const durableRunFinalizeFromOutcome = async (runId, outcome) => {
    if (!runId || !outcome) return null;
    try {
      return await finalizeRunRecord(runId, {
        status: outcome.status || 'error',
        label: outcome.label || null,
        detail: outcome.detail || null,
        blocked: !!outcome.blocked,
        blockedKind: outcome.blockedKind || null,
        blockedTitle: outcome.blockedKind ? blockedLabelForKind(outcome.blockedKind) : null,
        conversationUrl: outcome.conversationUrl || null
      });
    } catch {
      return null;
    }
  };

  const vendorForId = (vendorId) => {
    const token = normalizeVendorToken(vendorId || '');
    if (!token) return defaultVendor(vendors);
    return vendors.find((item) => normalizeVendorToken(item?.id || '') === token) || defaultVendor(vendors);
  };

  const resolveRunTab = async ({ run, show = false } = {}) => {
    const vendor = vendorForId(run?.vendorId);
    const key = String(run?.key || '').trim() || null;
    if (key) {
      return await tabs.ensureTab({
        key,
        name: key,
        show,
        url: vendor?.url,
        vendorId: vendor?.id || run?.vendorId || null,
        vendorName: vendor?.name || run?.vendorName || null,
        projectUrl: run?.projectUrl || null
      });
    }
    const rows = Array.isArray(tabs.listTabs?.()) ? tabs.listTabs() : [];
    const advisoryTab = run?.tabId ? rows.find((item) => String(item?.id || '') === String(run.tabId || '')) || null : null;
    if (advisoryTab) {
      if (run?.projectUrl) tabs.updateTabMeta?.(advisoryTab.id, { projectUrl: run.projectUrl });
      return advisoryTab.id;
    }
    const vendorTab = vendor
      ? rows.find((item) => {
        if (!listedTabMatchesVendor(item, vendor)) return false;
        if (!run?.projectUrl) return true;
        return String(item?.projectUrl || '').trim() === String(run.projectUrl || '').trim();
      }) || rows.find((item) => listedTabMatchesVendor(item, vendor)) || null
      : null;
    if (vendorTab) {
      if (run?.projectUrl) tabs.updateTabMeta?.(vendorTab.id, { projectUrl: run.projectUrl });
      return vendorTab.id;
    }
    if (vendor) {
      return await tabs.createTab({
        name: run?.vendorName || vendor.name || vendor.id,
        show,
        url: vendor.url,
        vendorId: vendor.id,
        vendorName: vendor.name,
        projectUrl: run?.projectUrl || null
      });
    }
    return defaultTabId;
  };

  const ensureRunLocation = async ({ controller, tabId, timeoutMs, conversationUrl, projectUrl }) => {
    const targetConversation = String(conversationUrl || '').trim() || null;
    const targetProject = String(projectUrl || '').trim() || null;
    const currentUrl = typeof controller.getUrl === 'function' ? await controller.getUrl().catch(() => '') : '';
    if (targetConversation && currentUrl !== targetConversation) {
      patchActiveQuery(tabId, { phase: 'resuming_conversation' });
      await controller.navigate(targetConversation);
      if (typeof controller.ensureReady === 'function') await controller.ensureReady({ timeoutMs });
      return;
    }
    if (targetProject) {
      const projectBase = targetProject.replace(/\/project\/?$/, '');
      if (!currentUrl.startsWith(projectBase)) {
        patchActiveQuery(tabId, { phase: 'navigating_to_project' });
        await controller.navigate(targetProject);
        if (typeof controller.ensureReady === 'function') await controller.ensureReady({ timeoutMs });
      }
    }
  };

  const researchTimeoutMs = (value, fallback = 45 * 60_000) => positiveIntOr(value, fallback, 90 * 60_000);

  const assertResearchTab = (tabId) => {
    const tabMeta = getTabMeta(tabs, tabId);
    const vendorId = normalizeVendorToken(tabMeta?.vendorId || '');
    if (vendorId === 'chatgpt') return tabMeta || null;
    const err = new Error('research_requires_chatgpt');
    err.data = { tabId, vendorId: tabMeta?.vendorId || null };
    throw err;
  };

  const finalizeResearchOutputs = async ({
    runId,
    tabId,
    tabMeta,
    outDir,
    result,
    researchOutput
  } = {}) => {
    const hasDownloadedOutput = Array.isArray(researchOutput?.files) && researchOutput.files.length > 0;
    if (!hasDownloadedOutput && looksLikeResearchPlaceholder(result?.text)) {
      const err = new Error('research_output_incomplete');
      err.data = {
        preview: trimPreview(result?.text, 180),
        exportState: researchOutput?.exportState || null
      };
      throw err;
    }
    let responseText = String(result?.text || '');
    const exportedMarkdownFile = (Array.isArray(researchOutput?.files) ? researchOutput.files : []).find((item) => {
      const name = String(item?.name || item?.path || '').trim();
      const mime = String(item?.mime || '').trim();
      return /\.md$/i.test(name) || /markdown/i.test(mime);
    }) || null;
    if (exportedMarkdownFile?.path && looksLikeResearchPlaceholder(responseText)) {
      try {
        responseText = await fs.readFile(exportedMarkdownFile.path, 'utf8');
      } catch {}
    }
    const responsePath = await writeResearchResponseFile({ outDir, text: responseText });
    const candidates = [
      {
        kind: 'file',
        filePath: responsePath,
        originalName: path.basename(responsePath),
        mime: 'text/markdown',
        source: 'agentify_research',
        meta: { role: 'canonical_response' }
      }
    ];
    for (const item of researchOutput?.files || []) {
      candidates.push({
        kind: 'file',
        filePath: item?.path,
        originalName: item?.name || null,
        mime: item?.mime || null,
        source: item?.source || null,
        meta: { role: 'download' }
      });
    }
    const artifacts = await collectRegisteredArtifacts({
      stateDir,
      tabId,
      tabKey: tabMeta?.key || null,
      vendorId: tabMeta?.vendorId || null,
      runId,
      outDir,
      candidates
    });
    const exportedMarkdown = artifacts.find((item) => item?.meta?.role === 'download' && /\.md$/i.test(String(item?.name || item?.path || '')))
      || artifacts.find((item) => item?.meta?.role === 'download' && /markdown/i.test(String(item?.mime || '')));
    return {
      dir: outDir,
      responsePath,
      exportedMarkdownPath: exportedMarkdown?.path || null,
      files: artifacts.map((item) => ({
        id: item.id,
        path: item.path,
        name: item.name,
        mime: item.mime || null,
        source: item.source || null,
        role: item?.meta?.role || null
      }))
    };
  };

  const executeResearchFlow = async ({
    op,
    tabId,
    tabMeta,
    controller,
    prompt,
    attachments = [],
    timeoutMs,
    outDir,
    existingConversationUrl = null,
    projectUrl = null,
    effectiveKey = null
  } = {}) => {
    const result = await runExclusive(controller, async () => {
      await ensureRunLocation({
        controller,
        tabId,
        timeoutMs,
        conversationUrl: existingConversationUrl,
        projectUrl
      });
      return await controller.research({
        prompt,
        attachments,
        timeoutMs,
        outDir,
        onProgress: (patch) => patchActiveQuery(tabId, patch)
      });
    });
    const conversationUrl = typeof controller.getUrl === 'function'
      ? await controller.getUrl().catch(() => existingConversationUrl || null)
      : existingConversationUrl || null;
    if (effectiveKey && conversationUrl) persistKeyLocation(effectiveKey, { conversationUrl, projectUrl });
    let outputManifest;
    try {
      outputManifest = await finalizeResearchOutputs({
        runId: op.id,
        tabId,
        tabMeta,
        outDir,
        result,
        researchOutput: result?.research || null
      });
    } catch (error) {
      if (String(error?.message || '') === 'research_output_incomplete') {
        error.data = {
          ...(error?.data && typeof error.data === 'object' ? error.data : {}),
          conversationUrl
        };
      }
      throw error;
    }
    const researchMeta = cloneResearchMeta(result?.researchMeta || null, {
      tabId,
      outputDir: outDir
    });
    researchMeta.activation.activated = true;
    researchMeta.activation.error = null;
    researchMeta.activation.tabId = tabId;
    researchMeta.activation.conversationUrl = conversationUrl || researchMeta.activation.conversationUrl || null;
    researchMeta.outputManifest = outputManifest;
    await patchRunRecord(op.id, { researchMeta });
    const outcome = successOutcomeForResult({ result, op, conversationUrl });
    setLastOutcome(tabId, outcome);
    await durableRunFinalizeFromOutcome(op.id, outcome);
    return { result, researchMeta, outputManifest, conversationUrl };
  };

  const successOutcomeForResult = ({ result, op, conversationUrl }) => ({
    status: 'success',
    label: 'Response received',
    detail: result?.text ? trimPreview(result.text, 180) : 'The provider returned a response.',
    conversationUrl: conversationUrl || null,
    source: op?.source || 'http',
    kind: op?.kind || 'query',
    finishedAt: Date.now(),
    durationMs: Math.max(0, Date.now() - Number(op?.startedAt || Date.now()))
  });

  const runtimeSnapshot = () => ({
    inflightQueries: inflight.queries,
    activeQueries: Array.from(activeQueries.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)),
    lastOutcomes: Array.from(lastOutcomes.entries())
      .map(([tabId, item]) => ({ tabId, ...item }))
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
  });

  const emitRuntimeChanged = () => {
    try {
      onRuntimeChanged?.(runtimeSnapshot());
    } catch {}
  };

  const setActiveQuery = (tabId, item) => {
    if (!tabId || !item) return;
    const next = { ...item, updatedAt: Date.now() };
    activeQueries.set(tabId, next);
    if (next.key) persistKeyLocation(next.key, { conversationUrl: next.conversationUrl, projectUrl: next.projectUrl });
    durableRunPatchFromActive(next);
    emitRuntimeChanged();
  };

  const requestScopeForBody = (body) => {
    const tabId = body?.tabId ? String(body.tabId).trim() : '';
    if (tabId) return `tab:${tabId}`;
    const key = body?.key ? String(body.key).trim() : '';
    if (key) return `key:${key}`;
    const vendorId = body?.vendorId ? String(body.vendorId).trim() : '';
    if (vendorId) return `vendor:${vendorId}`;
    const model = body?.model ? String(body.model).trim() : '';
    if (model) return `vendor:${model}`;
    return `tab:${defaultTabId}`;
  };

  const assertTabNotBusy = (tabId) => {
    const current = activeQueries.get(tabId);
    if (!current) return;
    const err = new Error('tab_busy');
    err.data = {
      tabId,
      activeQuery: { ...current }
    };
    throw err;
  };

  const assertScopeNotBusy = (scope) => {
    const current = activeScopes.get(scope);
    if (!current) return;
    const err = new Error('tab_busy');
    err.data = {
      scope,
      activeQuery: { ...current }
    };
    throw err;
  };

  const reserveScope = (scope, item) => {
    if (!scope || !item) return;
    activeScopes.set(scope, { ...item });
  };

  const clearScope = (scope, expectedId = null) => {
    if (!scope) return;
    const current = activeScopes.get(scope);
    if (!current) return;
    if (expectedId && current.id !== expectedId) return;
    activeScopes.delete(scope);
  };

  const patchActiveQuery = (tabId, patch) => {
    const current = activeQueries.get(tabId);
    if (!current) return null;
    const next = { ...current, ...(patch || {}), updatedAt: Date.now() };
    if (current?.researchMeta || patch?.researchMeta) {
      next.researchMeta = cloneResearchMeta({
        ...(current?.researchMeta || {}),
        ...(patch?.researchMeta || {}),
        activation: {
          ...(current?.researchMeta?.activation || {}),
          ...(patch?.researchMeta?.activation || {})
        },
        outputManifest: {
          ...(current?.researchMeta?.outputManifest || {}),
          ...(patch?.researchMeta?.outputManifest || {})
        }
      }, {
        tabId: next.tabId || null,
        outputDir:
          patch?.researchMeta?.outputManifest?.dir ||
          current?.researchMeta?.outputManifest?.dir ||
          null
      });
    }
    activeQueries.set(tabId, next);
    if (next.key) persistKeyLocation(next.key, { conversationUrl: next.conversationUrl, projectUrl: next.projectUrl });
    durableRunPatchFromActive(next);
    emitRuntimeChanged();
    return next;
  };

  const setLastOutcome = (tabId, item) => {
    if (!tabId || !item) return;
    lastOutcomes.set(tabId, { ...item, updatedAt: Date.now() });
    emitRuntimeChanged();
  };

  const clearActiveQuery = (tabId, expectedId = null) => {
    const current = activeQueries.get(tabId);
    if (!current) return;
    if (expectedId && current.id !== expectedId) return;
    activeQueries.delete(tabId);
    emitRuntimeChanged();
  };

  const getRunRecordOrThrow = (runId) => {
    const id = String(runId || '').trim();
    if (!id) throw new Error('missing_run_id');
    const run = runStore.get(id);
    if (!run) throw new Error('run_not_found');
    return run;
  };

  const listRunsAction = async ({ includeArchived = false, limit = 100 } = {}) => {
    await runsReady;
    return runsSnapshot({ includeArchived, limit });
  };

  const openRunAction = async ({ runId, timeoutMs = 30_000, show = true } = {}) => {
    await runsReady;
    const run = getRunRecordOrThrow(runId);
    const savedMeta = getPersistedKeyMeta(run.key);
    const resolvedRun = {
      ...run,
      projectUrl: run.projectUrl || savedMeta?.projectUrl || null,
      conversationUrl: run.conversationUrl || savedMeta?.conversationUrl || null
    };
    const tabId = await resolveRunTab({ run: resolvedRun, show: false });
    if (resolvedRun.projectUrl) tabs.updateTabMeta?.(tabId, { projectUrl: resolvedRun.projectUrl });
    const controller = tabs.getControllerById(tabId);
    await runExclusive(controller, async () => {
      await ensureRunLocation({
        controller,
        tabId,
        timeoutMs,
        conversationUrl: resolvedRun.conversationUrl || null,
        projectUrl: resolvedRun.projectUrl || null
      });
    });
    if (show) await onShow?.({ tabId }).catch(() => {});
    return { ok: true, tabId, run: resolvedRun };
  };

  const retryRunAction = async ({ runId, timeoutMs = null, fireAndForget = false, show = false, source = 'ui' } = {}) => {
    await runsReady;
    const original = getRunRecordOrThrow(runId);
    const savedMeta = getPersistedKeyMeta(original.key);
    const originalProjectUrl = original.projectUrl || savedMeta?.projectUrl || null;
    const originalConversationUrl = original.conversationUrl || savedMeta?.conversationUrl || null;
    const replay = original.materializedReplay || null;
    if (!replay?.prompt) throw new Error('run_not_retryable');
    const nextKind = String(original.kind || replay.kind || 'query').trim() || 'query';
    const effectiveTimeoutMs = nextKind === 'research'
      ? researchTimeoutMs(timeoutMs, replay.timeoutMs || 45 * 60_000)
      : positiveIntOr(timeoutMs, replay.timeoutMs || 10 * 60_000, 30 * 60_000);
    const scope = original.key
      ? `key:${original.key}`
      : original.vendorId
        ? `vendor:${original.vendorId}`
        : original.tabId
          ? `tab:${original.tabId}`
          : `run:${original.id}`;
    assertScopeNotBusy(scope);
    const op = {
      id: crypto.randomUUID(),
      kind: nextKind,
      tabId: null,
      startedAt: Date.now(),
      promptPreview: original.promptPreview || trimPreview(replay.prompt),
      source,
      phase: 'resolving_tab',
      stopRequested: false,
      stopRequestedAt: null,
      blocked: false,
      blockedKind: null,
      scope
    };
    reserveScope(scope, op);
    let tabId = null;
    let runCreated = false;
    let outputDir = null;
    try {
      tabId = await resolveRunTab({
        run: {
          ...original,
          projectUrl: originalProjectUrl,
          conversationUrl: originalConversationUrl
        },
        show
      });
      assertTabNotBusy(tabId);
      if (originalProjectUrl) tabs.updateTabMeta?.(tabId, { projectUrl: originalProjectUrl });
      op.tabId = tabId;
      let tabMeta = getTabMeta(tabs, tabId);
      if (nextKind === 'research') {
        tabMeta = assertResearchTab(tabId);
        outputDir = await ensureRunArtifactsDir({
          stateDir,
          runId: op.id,
          kind: 'research',
          tabKey: original.key || tabMeta?.key || null,
          vendorId: tabMeta?.vendorId || null
        });
      }
      const effectiveKey = original.key || tabMeta?.key || null;
      await createRunRecord({
        id: op.id,
        kind: nextKind,
        source,
        status: 'running',
        phase: op.phase,
        tabId,
        key: effectiveKey,
        vendorId: tabMeta?.vendorId || original.vendorId || null,
        vendorName: tabMeta?.vendorName || original.vendorName || null,
        projectUrl: originalProjectUrl,
        conversationUrl: originalConversationUrl,
        promptPreview: op.promptPreview,
        startedAt: op.startedAt,
        retryOf: original.id,
        logicalRequest: {
          ...(original.logicalRequest || {}),
          source,
          fireAndForget: !!fireAndForget,
          timeoutMs: effectiveTimeoutMs,
          key: effectiveKey,
          tabId,
          vendorId: tabMeta?.vendorId || original.vendorId || null,
          projectUrl: originalProjectUrl
        },
        materializedReplay: {
          kind: nextKind,
          prompt: String(replay.prompt || ''),
          attachments: Array.isArray(replay.attachments) ? replay.attachments.map(String) : [],
          timeoutMs: effectiveTimeoutMs
        },
        packedContextSummary: original.packedContextSummary || null,
        packedContextBudget: original.packedContextBudget || null,
        ...(nextKind === 'research'
          ? { researchMeta: defaultResearchMeta({ tabId, outputDir }) }
          : {})
      });
      runCreated = true;
      setActiveQuery(tabId, {
        ...op,
        key: effectiveKey,
        vendorId: tabMeta?.vendorId || original.vendorId || null,
        vendorName: tabMeta?.vendorName || original.vendorName || null,
        projectUrl: originalProjectUrl,
        conversationUrl: originalConversationUrl,
        ...(nextKind === 'research'
          ? { researchMeta: defaultResearchMeta({ tabId, outputDir }) }
          : {})
      });
      checkAndConsumeQueryBudget({ tabId, governor: await getGovernor() });
      inflight.queries += 1;
      const controller = tabs.getControllerById(tabId);
      const executeRetry = async () => {
        if (nextKind === 'research') {
          return await executeResearchFlow({
            op,
            tabId,
            tabMeta,
            controller,
            prompt: String(replay.prompt || ''),
            attachments: Array.isArray(replay.attachments) ? replay.attachments.map(String) : [],
            timeoutMs: effectiveTimeoutMs,
            outDir: outputDir,
            existingConversationUrl: originalConversationUrl,
            projectUrl: originalProjectUrl,
            effectiveKey
          });
        }
        const result = await runExclusive(controller, async () => {
          await ensureRunLocation({
            controller,
            tabId,
            timeoutMs: effectiveTimeoutMs,
            conversationUrl: originalConversationUrl,
            projectUrl: originalProjectUrl
          });
          return controller.query({
            prompt: String(replay.prompt || ''),
            attachments: Array.isArray(replay.attachments) ? replay.attachments.map(String) : [],
            timeoutMs: effectiveTimeoutMs,
            onProgress: (patch) => patchActiveQuery(tabId, patch)
          });
        });
        const conversationUrl = typeof controller.getUrl === 'function'
          ? await controller.getUrl().catch(() => originalConversationUrl || null)
          : originalConversationUrl || null;
        if (effectiveKey && conversationUrl) persistKeyLocation(effectiveKey, { conversationUrl, projectUrl: originalProjectUrl });
        const outcome = successOutcomeForResult({ result, op, conversationUrl });
        setLastOutcome(tabId, outcome);
        await durableRunFinalizeFromOutcome(op.id, outcome);
        return { result, conversationUrl };
      };

      if (fireAndForget) {
        executeRetry().catch((error) => {
          const outcome = outcomeFromError(error, op);
          setLastOutcome(tabId, outcome);
          return durableRunFinalizeFromOutcome(op.id, outcome);
        }).finally(() => {
          clearActiveQuery(tabId, op.id);
          inflight.queries = Math.max(0, inflight.queries - 1);
          clearScope(scope, op.id);
        });
        return { ok: true, async: true, tabId, runId: op.id, retryOf: original.id };
      }

      const completed = await executeRetry();
      return { ok: true, tabId, runId: op.id, retryOf: original.id, result: completed?.result || null };
    } catch (error) {
      if (tabId) {
        const outcome = outcomeFromError(error, op);
        setLastOutcome(tabId, outcome);
        if (runCreated) await durableRunFinalizeFromOutcome(op.id, outcome);
      }
      throw error;
    } finally {
      if (!fireAndForget && tabId) {
        clearActiveQuery(tabId, op.id);
        inflight.queries = Math.max(0, inflight.queries - 1);
      }
      if (!fireAndForget) clearScope(scope, op.id);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'forbidden' });
      if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, serverId: serverId || null });

      if (!authOk(req, tokenRef.current)) return sendJson(res, 401, { error: 'unauthorized' });

      const governor = await getGovernor();

      if (url.pathname === '/status' && req.method === 'GET') {
        const statusBody = {
          tabId: url.searchParams.get('tabId') || '',
          key: url.searchParams.get('key') || '',
          vendorId: url.searchParams.get('vendorId') || '',
          model: url.searchParams.get('model') || ''
        };
        const hasScopedTab = !!(statusBody.tabId || statusBody.key || statusBody.vendorId || statusBody.model);
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body: statusBody, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : defaultTabId;
        const st = await getStatus({ tabId });
        return sendJson(res, 200, {
          ...st,
          activeQuery: activeQueries.get(tabId) || null,
          runtime: runtimeSnapshot()
        });
      }

      if (url.pathname === '/show' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        await onShow?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/hide' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors });
        await onHide?.({ tabId });
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/tabs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, tabs: tabs.listTabs(), defaultTabId });
      }
      if (url.pathname === '/bundles/list' && req.method === 'GET') {
        const bundles = await listBundles(stateDir);
        return sendJson(res, 200, { ok: true, bundles });
      }
      if (url.pathname === '/watch-folders/list' && req.method === 'GET') {
        const folders = (await onWatchFoldersList?.()) || [];
        return sendJson(res, 200, { ok: true, folders });
      }
      if (url.pathname === '/watch-folders/add' && req.method === 'POST') {
        const body = await parseBody(req);
        const folder = await onAddWatchFolder?.({
          name: String(body.name || '').trim(),
          folderPath: normalizeAbsoluteSinglePath(body.path, { field: 'path' })
        });
        return sendJson(res, 200, { ok: true, folder });
      }
      if (url.pathname === '/watch-folders/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        const deleted = await onRemoveWatchFolder?.({ name: String(body.name || '').trim() });
        return sendJson(res, 200, { ok: true, deleted: !!deleted });
      }
      if (url.pathname === '/tabs/create' && req.method === 'POST') {
        await projectsReady;
        const body = await parseBody(req);
        const key = (body.key ? String(body.key).trim() : '') || null;
        const name = (body.name ? String(body.name).trim() : '') || null;
        const show = typeof body.show === 'boolean' ? body.show : envShowTabsDefault() || governor.showTabsByDefault;
        const vendor = resolveVendor({ body, vendors }) || defaultVendor(vendors);
        const settings = await getSettings?.() || {};
        const savedMeta = getPersistedKeyMeta(key);
        const projectUrl = (body.projectUrl ? String(body.projectUrl).trim() : '') || savedMeta?.projectUrl || settings.defaultProjectUrl || null;
        const tabId = key
          ? await tabs.ensureTab({ key, name, show, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name, projectUrl })
          : await tabs.createTab({ name, show, url: vendor?.url, vendorId: vendor?.id, vendorName: vendor?.name, projectUrl });
        if (projectUrl) {
          tabs.updateTabMeta?.(tabId, { projectUrl });
          if (key) persistKeyMeta(key, { projectUrl });
        }
        if (show) await onShow?.({ tabId }).catch(() => {});
        return sendJson(res, 200, { ok: true, tabId });
      }
      if (url.pathname === '/tabs/close' && req.method === 'POST') {
        const body = await parseBody(req);
        const tabId = (body.tabId ? String(body.tabId).trim() : '') || null;
        if (!tabId) return sendJson(res, 400, { error: 'missing_tabId' });
        if (tabId === defaultTabId) throw new Error('default_tab_protected');
        await tabs.closeTab(tabId);
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/shutdown' && req.method === 'POST') {
        // Must be authenticated. Best-effort: return OK then let caller quit the app.
        const body = await parseBody(req);
        const scope = String(body.scope || 'app');
        if (scope !== 'app') return sendJson(res, 400, { error: 'invalid_scope' });
        sendJson(res, 200, { ok: true });
        await onHide?.({ tabId: defaultTabId }).catch(() => {});
        await onShutdown?.().catch(() => {});
        return;
      }

      if (url.pathname === '/rotate-token' && req.method === 'POST') {
        if (!stateDir) return sendJson(res, 500, { error: 'misconfigured_stateDir' });
        const next = crypto.randomBytes(24).toString('hex');
        await writeToken(next, stateDir);
        tokenRef.current = next;
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/navigate' && req.method === 'POST') {
        const body = await parseBody(req);
        const to = String(body.url || '').trim();
        if (!to) return sendJson(res, 400, { error: 'missing_url' });
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        await runExclusive(controller, async () => controller.navigate(to));
        const currentUrl = await controller.getUrl();
        const tabMeta = getTabMeta(tabs, tabId);
        const tabKey = (body.key ? String(body.key).trim() : '') || tabMeta?.key || null;
        const persistedLocation = tabKey
          ? await persistKeyLocation(tabKey, { url: currentUrl, projectUrl: tabMeta?.projectUrl || null })
          : null;
        if (persistedLocation?.projectUrl) tabs.updateTabMeta?.(tabId, { projectUrl: persistedLocation.projectUrl });
        return sendJson(res, 200, { ok: true, tabId, url: currentUrl });
      }

      if (url.pathname === '/ensure-ready' && req.method === 'POST') {
        const body = await parseBody(req);
        const timeoutMs = positiveIntOr(body.timeoutMs, 10 * 60_000, 30 * 60_000);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const st = await runExclusive(controller, async () => controller.ensureReady({ timeoutMs }));
        return sendJson(res, 200, { ok: true, tabId, state: st });
      }

      if (url.pathname === '/research' && req.method === 'POST') {
        await projectsReady;
        await runsReady;
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = researchTimeoutMs(body.timeoutMs, 45 * 60_000);
        const prompt = String(body.prompt || '');
        if (!prompt.trim()) throw new Error('missing_prompt');
        if (prompt.length > 200_000) throw new Error('prompt_too_large');
        const source = requestSourceForBody(body);
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const contextPaths = Array.isArray(body.contextPaths) ? body.contextPaths.map(String) : [];
        const bundleName = String(body.bundleName || '').trim() || null;
        const bodyProjectUrl = (body.projectUrl ? String(body.projectUrl).trim() : '') || null;
        const tabKey = (body.key ? String(body.key).trim() : '') || null;
        const researchBody = { ...body, vendorId: 'chatgpt' };
        const scope = requestScopeForBody(researchBody);
        assertScopeNotBusy(scope);
        const advisoryTabId = body?.tabId
          ? String(body.tabId).trim() || null
          : tabKey
            ? (() => {
              const existing = (tabs.listTabs?.() || []).find((item) => item?.key === tabKey) || null;
              return normalizeVendorToken(existing?.vendorId || '') === 'chatgpt' ? existing.id : null;
            })()
            : (() => {
              const defaultMeta = getTabMeta(tabs, defaultTabId);
              return normalizeVendorToken(defaultMeta?.vendorId || '') === 'chatgpt' ? defaultMeta.id : null;
            })();
        const advisoryTabScope = advisoryTabId && `tab:${advisoryTabId}` !== scope ? `tab:${advisoryTabId}` : null;
        if (advisoryTabScope) assertScopeNotBusy(advisoryTabScope);
        const settings = await getSettings?.() || {};
        const savedMeta = getPersistedKeyMeta(tabKey);
        const projectUrl = bodyProjectUrl || savedMeta?.projectUrl || settings.defaultProjectUrl || null;
        const savedConversationUrl = savedMeta?.conversationUrl || null;
        const op = {
          id: crypto.randomUUID(),
          kind: 'research',
          tabId: body?.tabId ? String(body.tabId).trim() : null,
          startedAt: Date.now(),
          promptPreview: trimPreview(prompt),
          source,
          phase: 'queued',
          stopRequested: false,
          stopRequestedAt: null,
          blocked: false,
          blockedKind: null,
          scope
        };
        reserveScope(scope, op);
        if (advisoryTabScope) reserveScope(advisoryTabScope, op);
        try {
          if (bodyProjectUrl && tabKey) persistKeyMeta(tabKey, { projectUrl: bodyProjectUrl });
          await createRunRecord({
            id: op.id,
            kind: 'research',
            source,
            status: 'queued',
            phase: op.phase,
            tabId: op.tabId || null,
            key: tabKey || null,
            vendorId: 'chatgpt',
            vendorName: 'ChatGPT',
            projectUrl: projectUrl || null,
            conversationUrl: savedConversationUrl || null,
            promptPreview: op.promptPreview,
            startedAt: op.startedAt,
            logicalRequest: logicalResearchRequest({
              body,
              prompt,
              attachments,
              contextPaths,
              bundleName,
              timeoutMs,
              source,
              projectUrl
            }),
            researchMeta: defaultResearchMeta({ tabId: op.tabId || null })
          });

          void (async () => {
          let tabId = null;
          let resolvedTabScope = null;
          let queryReserved = false;
          try {
            tabId = await resolveTab({
              tabs,
              defaultTabId,
              body: researchBody,
              url,
              showTabsByDefault: governor.showTabsByDefault,
              createIfMissing: true,
              vendors
            });
            assertTabNotBusy(tabId);
            resolvedTabScope = tabId ? `tab:${tabId}` : null;
            if (resolvedTabScope && resolvedTabScope !== scope && resolvedTabScope !== advisoryTabScope) {
              assertScopeNotBusy(resolvedTabScope);
              reserveScope(resolvedTabScope, { ...op, tabId, scope: resolvedTabScope });
            }
            let tabMeta = assertResearchTab(tabId);
            if (projectUrl) tabs.updateTabMeta?.(tabId, { projectUrl });
            op.tabId = tabId;
            const effectiveKey = tabKey || tabMeta?.key || null;
            const outputDir = await ensureRunArtifactsDir({
              stateDir,
              runId: op.id,
              kind: 'research',
              tabKey: effectiveKey,
              vendorId: tabMeta?.vendorId || null
            });
            const activeOp = {
              ...op,
              phase: 'resolving_tab',
              key: effectiveKey,
              vendorId: tabMeta?.vendorId || 'chatgpt',
              vendorName: tabMeta?.vendorName || 'ChatGPT',
              projectUrl: projectUrl || null,
              researchMeta: defaultResearchMeta({ tabId, outputDir })
            };
            await patchRunRecord(op.id, {
              status: 'running',
              phase: activeOp.phase,
              tabId,
              key: effectiveKey,
              vendorId: activeOp.vendorId,
              vendorName: activeOp.vendorName,
              projectUrl: projectUrl || null,
              researchMeta: activeOp.researchMeta
            });
            setActiveQuery(tabId, activeOp);

            const bundle = bundleName ? await getBundle(stateDir, bundleName) : null;
            if (bundleName && !bundle) {
              const err = new Error('bundle_not_found');
              err.data = { name: bundleName };
              throw err;
            }
            patchActiveQuery(tabId, { phase: 'preparing_context', blocked: false, blockedKind: null });
            const vendorBudget = contextBudgetForVendor('chatgpt');
            const merged = mergeQueryInputs({ bundle, promptPrefix: '', attachments, contextPaths });
            const effectiveBudget = {
              maxContextChars: positiveIntOr(body.maxContextChars, vendorBudget.maxContextChars, 500_000),
              maxFiles: positiveIntOr(body.maxContextFiles, vendorBudget.maxFiles, 500),
              maxFileChars: positiveIntOr(body.maxContextFileChars, vendorBudget.maxFileChars, 100_000),
              maxChunkChars: positiveIntOr(body.maxContextChunkChars, vendorBudget.maxChunkChars, 20_000),
              maxChunksPerFile: positiveIntOr(body.maxContextChunksPerFile, vendorBudget.maxChunksPerFile, 20),
              maxInlineFiles: positiveIntOr(body.maxContextInlineFiles, vendorBudget.maxInlineFiles, 100),
              maxAttachmentFiles: positiveIntOr(body.maxContextAttachments, vendorBudget.maxAttachmentFiles, 50)
            };
            const packed = await prepareQueryContext({
              prompt,
              promptPrefix: merged.promptPrefix,
              attachments: merged.attachments,
              contextPaths: merged.contextPaths,
              maxContextChars: effectiveBudget.maxContextChars,
              maxFiles: effectiveBudget.maxFiles,
              maxFileChars: effectiveBudget.maxFileChars,
              maxChunkChars: effectiveBudget.maxChunkChars,
              maxChunksPerFile: effectiveBudget.maxChunksPerFile,
              maxInlineFiles: effectiveBudget.maxInlineFiles,
              maxAttachmentFiles: effectiveBudget.maxAttachmentFiles
            });
            await patchRunRecord(op.id, {
              materializedReplay: materializedReplay({ packed, timeoutMs, kind: 'research' }),
              packedContextSummary: packed.context?.summary || null,
              packedContextBudget: effectiveBudget
            });
            checkAndConsumeQueryBudget({ tabId, governor });
            inflight.queries += 1;
            queryReserved = true;
            const controller = tabs.getControllerById(tabId);
            await executeResearchFlow({
              op,
              tabId,
              tabMeta,
              controller,
              prompt: packed.prompt,
              attachments: packed.attachments,
              timeoutMs,
              outDir: outputDir,
              existingConversationUrl: savedConversationUrl || null,
              projectUrl: projectUrl || tabMeta?.projectUrl || null,
              effectiveKey
            });
          } catch (error) {
            const outcome = outcomeFromError(error, op);
            if (tabId) setLastOutcome(tabId, outcome);
            if (String(error?.message || '') === 'research_mode_activation_failed') {
              const current = tabId ? activeQueries.get(tabId) : null;
              const researchMeta = cloneResearchMeta(current?.researchMeta || null, {
                tabId,
                outputDir: current?.researchMeta?.outputManifest?.dir || null
              });
              researchMeta.activation.error = error?.data?.reason ? String(error.data.reason) : String(error?.message || 'research_mode_activation_failed');
              await patchRunRecord(op.id, { researchMeta });
            }
            await durableRunFinalizeFromOutcome(op.id, outcome);
          } finally {
            if (tabId) clearActiveQuery(tabId, op.id);
            if (queryReserved) inflight.queries = Math.max(0, inflight.queries - 1);
            clearScope(scope, op.id);
            if (advisoryTabScope) clearScope(advisoryTabScope, op.id);
            if (resolvedTabScope) clearScope(resolvedTabScope, op.id);
          }
          })();

          return sendJson(res, 202, {
            ok: true,
            async: true,
            runId: op.id,
            queryId: op.id,
            key: tabKey || null,
            tabId: op.tabId || null
          });
        } catch (error) {
          clearScope(scope, op.id);
          if (advisoryTabScope) clearScope(advisoryTabScope, op.id);
          throw error;
        }
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        await projectsReady;
        await runsReady;
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = positiveIntOr(body.timeoutMs, 10 * 60_000, 30 * 60_000);
        const prompt = String(body.prompt || '');
        if (!prompt.trim()) throw new Error('missing_prompt');
        if (prompt.length > 200_000) throw new Error('prompt_too_large');
        const source = requestSourceForBody(body);
        const scope = requestScopeForBody(body);
        assertScopeNotBusy(scope);
        const attachments = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
        const contextPaths = Array.isArray(body.contextPaths) ? body.contextPaths.map(String) : [];
        const promptPrefix = String(body.promptPrefix || '');
        const bundleName = String(body.bundleName || '').trim() || null;
        const bodyProjectUrl = (body.projectUrl ? String(body.projectUrl).trim() : '') || null;
        const fireAndForget = !!body.fireAndForget;
        const tabKey = (body.key ? String(body.key).trim() : '') || null;
        const settings = await getSettings?.() || {};
        const savedMeta = getPersistedKeyMeta(tabKey);
        const projectUrl = bodyProjectUrl || savedMeta?.projectUrl || settings.defaultProjectUrl || null;
        const savedConversationUrl = savedMeta?.conversationUrl || null;
        const op = {
          id: crypto.randomUUID(),
          kind: 'query',
          tabId: null,
          startedAt: Date.now(),
          promptPreview: trimPreview(prompt),
          source,
          phase: 'resolving_tab',
          stopRequested: false,
          stopRequestedAt: null,
          blocked: false,
          blockedKind: null,
          scope
        };
        reserveScope(scope, op);
        let tabId = null;
        let runCreated = false;
        try {
          tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
          assertTabNotBusy(tabId);
          if (projectUrl) tabs.updateTabMeta?.(tabId, { projectUrl });
          if (bodyProjectUrl && tabKey) persistKeyMeta(tabKey, { projectUrl: bodyProjectUrl });
          op.tabId = tabId;
          const tabMeta = getTabMeta(tabs, tabId);
          const effectiveKey = tabKey || tabMeta?.key || null;
          const activeOp = {
            ...op,
            key: effectiveKey,
            vendorId: tabMeta?.vendorId || null,
            vendorName: tabMeta?.vendorName || null,
            projectUrl: projectUrl || null,
            conversationUrl: savedConversationUrl || null
          };
          // Set active query before the durable disk write so /status reflects
          // in-flight queries without waiting for run-record persistence.
          setActiveQuery(tabId, activeOp);
          await createRunRecord({
            id: op.id,
            kind: 'query',
            source,
            status: 'running',
            phase: op.phase,
            tabId,
            key: effectiveKey,
            vendorId: tabMeta?.vendorId || null,
            vendorName: tabMeta?.vendorName || null,
            projectUrl: projectUrl || null,
            conversationUrl: savedConversationUrl || null,
            promptPreview: op.promptPreview,
            startedAt: op.startedAt,
            logicalRequest: logicalQueryRequest({
              body,
              prompt,
              promptPrefix,
              attachments,
              contextPaths,
              bundleName,
              timeoutMs,
              source,
              fireAndForget,
              projectUrl
            })
          });
          runCreated = true;
          const vendorBudget = contextBudgetForVendor(tabMeta?.vendorId || 'chatgpt');
          try {
            patchActiveQuery(tabId, { phase: 'preparing_context', blocked: false, blockedKind: null });
            const bundle = bundleName ? await getBundle(stateDir, bundleName) : null;
            if (bundleName && !bundle) {
              const err = new Error('bundle_not_found');
              err.data = { name: bundleName };
              throw err;
            }
            const merged = mergeQueryInputs({ bundle, promptPrefix, attachments, contextPaths });
            const effectiveBudget = {
              maxContextChars: positiveIntOr(body.maxContextChars, vendorBudget.maxContextChars, 500_000),
              maxFiles: positiveIntOr(body.maxContextFiles, vendorBudget.maxFiles, 500),
              maxFileChars: positiveIntOr(body.maxContextFileChars, vendorBudget.maxFileChars, 100_000),
              maxChunkChars: positiveIntOr(body.maxContextChunkChars, vendorBudget.maxChunkChars, 20_000),
              maxChunksPerFile: positiveIntOr(body.maxContextChunksPerFile, vendorBudget.maxChunksPerFile, 20),
              maxInlineFiles: positiveIntOr(body.maxContextInlineFiles, vendorBudget.maxInlineFiles, 100),
              maxAttachmentFiles: positiveIntOr(body.maxContextAttachments, vendorBudget.maxAttachmentFiles, 50)
            };
            const packed = await prepareQueryContext({
              prompt,
              promptPrefix: merged.promptPrefix,
              attachments: merged.attachments,
              contextPaths: merged.contextPaths,
              maxContextChars: effectiveBudget.maxContextChars,
              maxFiles: effectiveBudget.maxFiles,
              maxFileChars: effectiveBudget.maxFileChars,
              maxChunkChars: effectiveBudget.maxChunkChars,
              maxChunksPerFile: effectiveBudget.maxChunksPerFile,
              maxInlineFiles: effectiveBudget.maxInlineFiles,
              maxAttachmentFiles: effectiveBudget.maxAttachmentFiles
            });
            checkAndConsumeQueryBudget({ tabId, governor });
            inflight.queries += 1;
            const controller = tabs.getControllerById(tabId);
            const effectiveProjectUrl = projectUrl || getTabMeta(tabs, tabId)?.projectUrl || null;
            await patchRunRecord(op.id, {
              materializedReplay: materializedReplay({ packed, timeoutMs }),
              packedContextSummary: packed.context?.summary || null,
              packedContextBudget: effectiveBudget
            });
            const runQuery = async () => {
              const result = await runExclusive(controller, async () => {
                if ((savedConversationUrl || effectiveProjectUrl) && typeof controller.getUrl === 'function') {
                  const currentUrl = await controller.getUrl().catch(() => '');
                  // Resume saved conversation if available and tab is on base URL (post-restart)
                  if (savedConversationUrl && (currentUrl === 'https://chatgpt.com/' || currentUrl.endsWith('/project') || currentUrl === '' || currentUrl === 'about:blank')) {
                    patchActiveQuery(tabId, { phase: 'resuming_conversation' });
                    await controller.navigate(savedConversationUrl);
                    await controller.ensureReady({ timeoutMs });
                  } else if (effectiveProjectUrl) {
                    const projectBase = effectiveProjectUrl.replace(/\/project\/?$/, '');
                    if (!currentUrl.startsWith(projectBase)) {
                      patchActiveQuery(tabId, { phase: 'navigating_to_project' });
                      await controller.navigate(effectiveProjectUrl);
                      await controller.ensureReady({ timeoutMs });
                    }
                  }
                }
                return controller.query({
                  prompt: packed.prompt,
                  attachments: packed.attachments,
                  timeoutMs,
                  onProgress: (patch) => patchActiveQuery(tabId, patch)
                });
              });
              // Capture conversation URL after successful query
              const conversationUrl = typeof controller.getUrl === 'function' ? await controller.getUrl().catch(() => null) : null;
              if (effectiveKey && conversationUrl) persistKeyLocation(effectiveKey, { conversationUrl, projectUrl: effectiveProjectUrl });
              const outcome = successOutcomeForResult({ result, op, conversationUrl });
              setLastOutcome(tabId, outcome);
              await durableRunFinalizeFromOutcome(op.id, outcome);
              return result;
            };

            if (fireAndForget) {
              const tabMeta = getTabMeta(tabs, tabId);
              runQuery().catch((error) => {
                const outcome = outcomeFromError(error, op);
                setLastOutcome(tabId, outcome);
                return durableRunFinalizeFromOutcome(op.id, outcome);
              }).finally(() => {
                clearActiveQuery(tabId, op.id);
                inflight.queries = Math.max(0, inflight.queries - 1);
                clearScope(scope, op.id);
              });
              return sendJson(res, 202, {
                ok: true,
                async: true,
                tabId,
                key: tabMeta?.key || tabKey || null,
                queryId: op.id,
                runId: op.id,
                packedContextSummary: packed.context?.summary || null
              });
            }

            const result = await runQuery();
            return sendJson(res, 200, {
              ok: true,
              tabId,
              runId: op.id,
              result,
              packedContext: packed.context,
              packedContextSummary: packed.context?.summary || null,
              packedContextBudget: effectiveBudget,
              bundle
            });
          } catch (error) {
            const outcome = outcomeFromError(error, op);
            setLastOutcome(tabId, outcome);
            if (runCreated) await durableRunFinalizeFromOutcome(op.id, outcome);
            throw error;
          } finally {
            if (!fireAndForget) {
              clearActiveQuery(tabId, op.id);
              inflight.queries = Math.max(0, inflight.queries - 1);
            }
          }
        } finally {
          if (!fireAndForget) clearScope(scope, op.id);
        }
      }

      if (url.pathname === '/send' && req.method === 'POST') {
        const body = await parseBody(req, { maxBytes: 5_000_000 });
        const timeoutMs = positiveIntOr(body.timeoutMs, 3 * 60_000, 30 * 60_000);
        const text = String(body.text || '');
        if (!text.trim()) throw new Error('missing_prompt');
        if (text.length > 200_000) throw new Error('prompt_too_large');
        const source = requestSourceForBody(body);
        const scope = requestScopeForBody(body);
        assertScopeNotBusy(scope);
        const stopAfterSend = !!body.stopAfterSend;
        const op = {
          id: crypto.randomUUID(),
          kind: 'send',
          tabId: null,
          startedAt: Date.now(),
          promptPreview: trimPreview(text),
          source,
          phase: 'resolving_tab',
          stopRequested: false,
          stopRequestedAt: null,
          blocked: false,
          blockedKind: null,
          scope
        };
        reserveScope(scope, op);
        let tabId = null;
        try {
          tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
          assertTabNotBusy(tabId);
          op.tabId = tabId;
          setActiveQuery(tabId, op);
          checkAndConsumeQueryBudget({ tabId, governor });
          inflight.queries += 1;
          const controller = tabs.getControllerById(tabId);
          const result = await runExclusive(controller, async () =>
            controller.send({
              text,
              timeoutMs,
              stopAfterSend,
              onProgress: (patch) => patchActiveQuery(tabId, patch)
            })
          );
          setLastOutcome(tabId, {
            status: 'success',
            label: 'Sent',
            detail: 'Prompt sent successfully.',
            source,
            kind: 'send',
            finishedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - op.startedAt)
          });
          return sendJson(res, 200, { ok: true, tabId, result });
        } catch (error) {
          if (tabId) setLastOutcome(tabId, outcomeFromError(error, op));
          throw error;
        } finally {
          if (tabId) clearActiveQuery(tabId, op.id);
          clearScope(scope, op.id);
          inflight.queries = Math.max(0, inflight.queries - 1);
        }
      }

      if (url.pathname === '/query/stop' && req.method === 'POST') {
        const body = await parseBody(req);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '')
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : defaultTabId;
        const active = patchActiveQuery(tabId, { stopRequested: true, stopRequestedAt: Date.now() }) || null;
        const controller = tabs.getControllerById(tabId);
        const stopped = typeof controller?.requestStop === 'function'
          ? await controller.requestStop({ reason: 'user_stop' })
          : { ok: true, requested: false, clicked: false };
        return sendJson(res, 200, {
          ok: true,
          tabId,
          requested: !!stopped?.requested || !!active,
          clicked: !!stopped?.clicked,
          activeQuery: activeQueries.get(tabId) || active || null,
          runtime: runtimeSnapshot()
        });
      }

      if (url.pathname === '/runs/list' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await parseBody(req) : {};
        const includeArchived = body.includeArchived === true || String(url.searchParams.get('includeArchived') || '').trim().toLowerCase() === 'true';
        const limit = positiveIntOr(body.limit || url.searchParams.get('limit'), 100, 500);
        const runs = await listRunsAction({ includeArchived, limit });
        return sendJson(res, 200, { ok: true, runs });
      }

      if (url.pathname === '/runs/get' && req.method === 'POST') {
        await runsReady;
        const body = await parseBody(req);
        const run = getRunRecordOrThrow(body.runId);
        return sendJson(res, 200, { ok: true, run });
      }

      if (url.pathname === '/runs/archive' && req.method === 'POST') {
        await runsReady;
        const body = await parseBody(req);
        const archived = await archiveRunRecord(String(body.runId || '').trim());
        return sendJson(res, 200, {
          ok: true,
          runId: archived.id,
          archivedAt: archived.archivedAt || null
        });
      }

      if (url.pathname === '/runs/open' && req.method === 'POST') {
        const body = await parseBody(req);
        const timeoutMs = positiveIntOr(body.timeoutMs, 30_000, 30 * 60_000);
        const opened = await openRunAction({
          runId: body.runId,
          timeoutMs,
          show: body.show !== false
        });
        return sendJson(res, 200, opened);
      }

      if (url.pathname === '/runs/retry' && req.method === 'POST') {
        const body = await parseBody(req);
        const retried = await retryRunAction({
          runId: body.runId,
          timeoutMs: body.timeoutMs,
          fireAndForget: !!body.fireAndForget,
          show: !!body.show,
          source: requestSourceForBody(body)
        });
        return sendJson(res, retried.async ? 202 : 200, retried);
      }

      if (url.pathname === '/read-page' && req.method === 'POST') {
        await projectsReady;
        const body = await parseBody(req);
        const maxChars = positiveIntOr(body.maxChars, 200_000, 1_000_000);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const tabKey = (body.key ? String(body.key).trim() : '') || getTabMeta(tabs, tabId)?.key || null;
        const text = await runExclusive(controller, async () => {
          // If tab is on base URL after restart, navigate to saved conversation
          if (tabKey && typeof controller.getUrl === 'function') {
            const currentUrl = await controller.getUrl().catch(() => '');
            const meta = getPersistedKeyMeta(tabKey);
            if (meta?.conversationUrl && meta.conversationUrl !== currentUrl &&
                (currentUrl === 'https://chatgpt.com/' || currentUrl === 'about:blank' || !currentUrl)) {
              await controller.navigate(meta.conversationUrl);
              await controller.ensureReady({ timeoutMs: 30_000 });
            }
          }
          return controller.readPageText({ maxChars });
        });
        return sendJson(res, 200, { ok: true, tabId, text });
      }

      if (url.pathname === '/download-images' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxImages = positiveIntOr(body.maxImages, 6, 50);
        const tabId = await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: true, vendors });
        const controller = tabs.getControllerById(tabId);
        const saved = await runExclusive(controller, async () =>
          saveArtifactsForTab({ stateDir, tabs, tabId, controller, mode: 'images', maxImages })
        );
        return sendJson(res, 200, { ok: true, tabId, files: saved.items, dir: saved.dir });
      }

      if (url.pathname === '/artifacts/save' && req.method === 'POST') {
        const body = await parseBody(req);
        const mode = String(body.mode || 'all').trim().toLowerCase();
        const maxImages = positiveIntOr(body.maxImages, 6, 50);
        const maxFiles = positiveIntOr(body.maxFiles, 6, 50);
        const tabId = await resolveTab({
          tabs,
          defaultTabId,
          body,
          url,
          showTabsByDefault: governor.showTabsByDefault,
          createIfMissing: true,
          vendors
        });
        const controller = tabs.getControllerById(tabId);
        const saved = await runExclusive(controller, async () =>
          saveArtifactsForTab({ stateDir, tabs, tabId, controller, mode, maxImages, maxFiles })
        );
        return sendJson(res, 200, { ok: true, tabId, artifacts: saved.items, dir: saved.dir });
      }

      if (url.pathname === '/research/export' && req.method === 'POST') {
        const body = await parseBody(req);
        const maxFiles = positiveIntOr(body.maxFiles, 6, 50);
        const timeoutMs = positiveIntOr(body.timeoutMs, 20_000, 60_000);
        const tabId = await resolveTab({
          tabs,
          defaultTabId,
          body,
          url,
          showTabsByDefault: governor.showTabsByDefault,
          createIfMissing: false,
          vendors
        });
        assertResearchTab(tabId);
        const controller = tabs.getControllerById(tabId);
        const saved = await runExclusive(controller, async () =>
          exportResearchArtifactsForTab({ stateDir, tabs, tabId, controller, maxFiles, timeoutMs })
        );
        return sendJson(res, 200, {
          ok: true,
          tabId,
          artifacts: saved.items,
          dir: saved.dir,
          exportState: saved.exportState,
          exportedMarkdownPath: saved.exportedMarkdownPath
        });
      }

      if (url.pathname === '/artifacts/list' && req.method === 'POST') {
        const body = await parseBody(req);
        const limit = positiveIntOr(body.limit, 50, 500);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '') ||
          getTabIdFromUrl(url)
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : null;
        const artifacts = await listArtifacts({ stateDir, tabId, limit });
        return sendJson(res, 200, { ok: true, tabId, artifacts });
      }

      if (url.pathname === '/artifacts/open-folder' && req.method === 'POST') {
        const body = await parseBody(req);
        const hasScopedTab = !!(
          (body?.tabId ? String(body.tabId).trim() : '') ||
          (body?.key ? String(body.key).trim() : '') ||
          (body?.vendorId ? String(body.vendorId).trim() : '') ||
          (body?.model ? String(body.model).trim() : '')
        );
        const tabId = hasScopedTab
          ? await resolveTab({ tabs, defaultTabId, body, url, showTabsByDefault: governor.showTabsByDefault, createIfMissing: false, vendors })
          : null;
        const meta = tabId ? getTabMeta(tabs, tabId) : null;
        const folderPath = tabId
          ? await ensureArtifactsDir({ stateDir, tabId, tabKey: meta?.key || null, vendorId: meta?.vendorId || null })
          : artifactsRoot(stateDir);
        const opened = await onOpenArtifactsFolder?.({ tabId, folderPath });
        if (opened === false) {
          const err = new Error('artifacts_folder_open_failed');
          err.data = { folderPath };
          throw err;
        }
        return sendJson(res, 200, { ok: true, tabId, folderPath });
      }

      if (url.pathname === '/bundles/save' && req.method === 'POST') {
        const body = await parseBody(req);
        const bundle = await saveBundle(stateDir, {
          name: body.name,
          promptPrefix: body.promptPrefix,
          attachments: normalizeAbsolutePathList(body.attachments, { field: 'attachments' }),
          contextPaths: normalizeAbsolutePathList(body.contextPaths, { field: 'contextPaths' })
        });
        return sendJson(res, 200, { ok: true, bundle });
      }

      if (url.pathname === '/bundles/get' && req.method === 'POST') {
        const body = await parseBody(req);
        const bundle = await getBundle(stateDir, body.name);
        if (!bundle) {
          const err = new Error('bundle_not_found');
          err.data = { name: String(body.name || '').trim() };
          throw err;
        }
        return sendJson(res, 200, { ok: true, bundle });
      }

      if (url.pathname === '/bundles/delete' && req.method === 'POST') {
        const body = await parseBody(req);
        const deleted = await deleteBundle(stateDir, body.name);
        return sendJson(res, 200, { ok: true, deleted });
      }

      if (url.pathname === '/watch-folders/open' && req.method === 'POST') {
        const body = await parseBody(req);
        const folders = (await onWatchFoldersList?.()) || [];
        const targetName = String(body.name || 'inbox').trim() || 'inbox';
        const target = folders.find((item) => String(item?.name || '') === targetName) || null;
        if (!target) throw new Error('watch_folder_not_found');
        const folderPath = target?.path || null;
        if (!folderPath) return sendJson(res, 500, { error: 'watch_folder_unavailable' });
        const opened = await onOpenWatchFolder?.({ name: targetName, folderPath });
        if (opened === false) {
          const err = new Error('artifacts_folder_open_failed');
          err.data = { folderPath };
          throw err;
        }
        return sendJson(res, 200, { ok: true, folder: { name: targetName, path: folderPath } });
      }

      if (url.pathname === '/watch-folders/scan' && req.method === 'POST') {
        const result = await onScanWatchFolder?.();
        return sendJson(res, 200, { ok: true, ...(result || {}) });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const mapped = mapErrorToHttp(error);
      if (mapped) return sendJson(res, mapped.code, mapped.body);
      return sendJson(res, 500, { error: 'internal_error', message: error?.message || String(error), data: error?.data || null });
    }
  });

  server.getRuntimeState = () => runtimeSnapshot();
  server.listRuns = async ({ includeArchived = false, limit = 100 } = {}) => {
    return await listRunsAction({ includeArchived, limit });
  };
  server.getRun = async ({ runId }) => {
    await runsReady;
    return getRunRecordOrThrow(runId);
  };
  server.archiveRun = async ({ runId }) => {
    await runsReady;
    return await archiveRunRecord(String(runId || '').trim());
  };
  server.openRun = async ({ runId, timeoutMs = 30_000, show = true } = {}) => {
    return await openRunAction({ runId, timeoutMs, show });
  };
  server.retryRun = async ({ runId, timeoutMs = null, fireAndForget = false, show = false, source = 'ui' } = {}) => {
    return await retryRunAction({ runId, timeoutMs, fireAndForget, show, source });
  };
  server.stopActiveQuery = async ({ tabId }) => {
    const active = patchActiveQuery(tabId, { stopRequested: true, stopRequestedAt: Date.now() }) || null;
    const controller = tabs.getControllerById(tabId);
    const stopped = typeof controller?.requestStop === 'function'
      ? await controller.requestStop({ reason: 'user_stop' })
      : { ok: true, requested: false, clicked: false };
    return {
      ok: true,
      tabId,
      requested: !!stopped?.requested || !!active,
      clicked: !!stopped?.clicked,
      activeQuery: activeQueries.get(tabId) || active || null,
      runtime: runtimeSnapshot()
    };
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
