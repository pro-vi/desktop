import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import { atomicWriteFile } from './fs-utils.mjs';
import {
  DEFAULT_CHAT_MODE_INTENT,
  DEFAULT_IMAGE_KEY,
  DEFAULT_IMAGE_MODE_INTENT,
  normalizeChatGptModeIntent,
  normalizePersistedChatGptKeyMeta
} from './chatgpt-mode-intent.mjs';

export function defaultStateDir() {
  return process.env.AGENTIFY_DESKTOP_STATE_DIR || path.join(os.homedir(), '.agentify-desktop');
}

function tokenPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'token.txt');
}

function statePath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'state.json');
}

function settingsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'settings.json');
}

export function defaultSettings() {
  return {
    browserBackend: 'electron',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',

    // Governor defaults (intentionally conservative).
    maxTabs: 24,
    maxInflightQueries: 2,
    maxQueriesPerMinute: 12,
    minTabGapMs: 1200,
    minGlobalGapMs: 200,

    // UX defaults.
    showTabsByDefault: false,
    allowAuthPopups: true,
    defaultProjectUrl: null,
    defaultChatModeIntent: DEFAULT_CHAT_MODE_INTENT,
    defaultImageProjectUrl: null,
    defaultImageModeIntent: DEFAULT_IMAGE_MODE_INTENT,
    defaultImageKey: DEFAULT_IMAGE_KEY,

    // Acknowledgment for changing settings (UX only; not required for operation).
    acknowledgedAt: null
  };
}

export function normalizeSettings(input) {
  const d = defaultSettings();
  const s = input && typeof input === 'object' ? input : {};

  const clampInt = (v, { min, max, fallback }) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return Math.max(min, Math.min(max, i));
  };

  const clampMs = (v, { min, max, fallback }) => clampInt(v, { min, max, fallback });

  const out = {
    browserBackend: ['electron', 'chrome-cdp'].includes(String(s.browserBackend || '').trim().toLowerCase())
      ? String(s.browserBackend || '').trim().toLowerCase()
      : d.browserBackend,
    chromeDebugPort: clampInt(s.chromeDebugPort, { min: 1024, max: 65535, fallback: d.chromeDebugPort }),
    chromeExecutablePath:
      typeof s.chromeExecutablePath === 'string' && s.chromeExecutablePath.trim() ? s.chromeExecutablePath.trim() : null,
    chromeProfileMode: ['isolated', 'existing'].includes(String(s.chromeProfileMode || '').trim().toLowerCase())
      ? String(s.chromeProfileMode || '').trim().toLowerCase()
      : d.chromeProfileMode,
    chromeProfileName:
      typeof s.chromeProfileName === 'string' && s.chromeProfileName.trim() ? s.chromeProfileName.trim() : d.chromeProfileName,
    maxTabs: clampInt(s.maxTabs, { min: 1, max: 50, fallback: d.maxTabs }),
    maxInflightQueries: clampInt(s.maxInflightQueries, { min: 1, max: 12, fallback: d.maxInflightQueries }),
    maxQueriesPerMinute: clampInt(s.maxQueriesPerMinute, { min: 1, max: 600, fallback: d.maxQueriesPerMinute }),
    minTabGapMs: clampMs(s.minTabGapMs, { min: 0, max: 60_000, fallback: d.minTabGapMs }),
    minGlobalGapMs: clampMs(s.minGlobalGapMs, { min: 0, max: 10_000, fallback: d.minGlobalGapMs }),
    showTabsByDefault: !!s.showTabsByDefault,
    allowAuthPopups: typeof s.allowAuthPopups === 'boolean' ? s.allowAuthPopups : d.allowAuthPopups,
    defaultProjectUrl: typeof s.defaultProjectUrl === 'string' && s.defaultProjectUrl.trim() ? s.defaultProjectUrl.trim() : null,
    defaultChatModeIntent: normalizeChatGptModeIntent(s.defaultChatModeIntent, { fallback: d.defaultChatModeIntent }),
    defaultImageProjectUrl:
      typeof s.defaultImageProjectUrl === 'string' && s.defaultImageProjectUrl.trim() ? s.defaultImageProjectUrl.trim() : null,
    defaultImageModeIntent: normalizeChatGptModeIntent(s.defaultImageModeIntent, { fallback: d.defaultImageModeIntent }),
    defaultImageKey:
      typeof s.defaultImageKey === 'string' && s.defaultImageKey.trim() ? s.defaultImageKey.trim() : d.defaultImageKey,
    acknowledgedAt: typeof s.acknowledgedAt === 'string' && s.acknowledgedAt.trim() ? s.acknowledgedAt.trim() : null
  };
  return out;
}

export async function ensureStateDir(stateDir = defaultStateDir()) {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function readToken(stateDir = defaultStateDir()) {
  const tokenFromEnv = (process.env.AGENTIFY_DESKTOP_TOKEN || '').trim();
  if (tokenFromEnv) return tokenFromEnv;
  try {
    return (await fs.readFile(tokenPath(stateDir), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function writeToken(token, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(tokenPath(stateDir), `${token}\n`, { mode: 0o600 });
}

export async function ensureToken(stateDir = defaultStateDir()) {
  const existing = await readToken(stateDir);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await writeToken(token, stateDir);
  return token;
}

export async function readState(stateDir = defaultStateDir()) {
  try {
    return JSON.parse(await fs.readFile(statePath(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readSettings(stateDir = defaultStateDir()) {
  try {
    const raw = await fs.readFile(settingsPath(stateDir), 'utf8');
    return normalizeSettings(JSON.parse(raw || '{}'));
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(settings, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  const normalized = normalizeSettings(settings);
  await atomicWriteFile(settingsPath(stateDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

// --- Key metadata persistence (key -> { projectUrl, conversationUrl, modeIntent }) ---

function projectsPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'projects.json');
}

export async function readProjects(stateDir = defaultStateDir()) {
  try {
    const raw = JSON.parse(await fs.readFile(projectsPath(stateDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      // Backwards compat: old format stored bare strings (projectUrl only).
      out[k] = normalizePersistedChatGptKeyMeta(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeProjects(projects, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(projectsPath(stateDir), `${JSON.stringify(projects, null, 2)}\n`);
}
