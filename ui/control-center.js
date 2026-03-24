/* global window */

function el(id) {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing_element:${id}`);
  return n;
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch {
    return '';
  }
}

function num(id, fallback) {
  const v = Number(el(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function setNum(id, value) {
  el(id).value = String(Number(value));
}

function setChecked(id, value) {
  el(id).checked = !!value;
}

function setHidden(id, hidden) {
  el(id).classList.toggle('isHidden', !!hidden);
}

function getBridge() {
  return window?.agentifyDesktop || null;
}
const fallbackVendors = [
  { id: 'chatgpt', name: 'ChatGPT', status: 'supported' },
  { id: 'perplexity', name: 'Perplexity', status: 'supported' },
  { id: 'claude', name: 'Claude', status: 'supported' },
  { id: 'grok', name: 'Grok', status: 'supported' },
  { id: 'aistudio', name: 'Google AI Studio', status: 'supported' },
  { id: 'gemini', name: 'Gemini', status: 'supported' }
];

function hasApi(name) {
  const b = getBridge();
  return typeof b?.[name] === 'function';
}

async function callApi(name, args, { fallback = null, required = false } = {}) {
  const b = getBridge();
  if (typeof b?.[name] !== 'function') {
    if (required) throw new Error(`missing_desktop_api:${name} (open Control Center inside Agentify Desktop, then restart)`);
    return fallback;
  }
  try {
    if (typeof args === 'undefined') return await b[name]();
    return await b[name](args);
  } catch (e) {
    if (required) throw e;
    return fallback;
  }
}

function defaultState() {
  return {
    ok: false,
    vendors: [...fallbackVendors],
    tabs: [],
    defaultTabId: null,
    stateDir: '',
    browserBackend: 'electron',
    browser: null
  };
}

function defaultSettings() {
  return {
    browserBackend: 'electron',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',
    maxInflightQueries: 2,
    maxQueriesPerMinute: 12,
    minTabGapMs: 0,
    minGlobalGapMs: 0,
    showTabsByDefault: false,
    allowAuthPopups: true,
    acknowledgedAt: null
  };
}

function statusText(msg) {
  el('statusLine').textContent = msg;
}

function isChromeCdpSelected() {
  return String(el('setBrowserBackend').value || '').trim() === 'chrome-cdp';
}

function syncChromeProfileFields() {
  const hidden = !isChromeCdpSelected();
  setHidden('chromeProfileModeField', hidden);
  setHidden('chromeProfileNameField', hidden);
}

let lastState = defaultState();
let refreshInFlight = null;

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const state = (await callApi('getState', undefined, { fallback: lastState })) || lastState;
    const settings = (await callApi('getSettings', undefined, { fallback: defaultSettings() })) || defaultSettings();
    lastState = { ...defaultState(), ...state };

    const vendorSelect = el('vendorSelect');
    const prev = String(vendorSelect.value || '').trim();
    vendorSelect.innerHTML = '';
    const vendors = Array.isArray(lastState.vendors) && lastState.vendors.length ? lastState.vendors : fallbackVendors;
    for (const v of vendors) {
    const opt = document.createElement('option');
      opt.value = String(v.id || '').trim();
    opt.textContent = `${v.name}${v.status && v.status !== 'supported' ? ` (${v.status})` : ''}`;
      if (prev && prev === opt.value) opt.selected = true;
      else if (!prev && v.id === 'chatgpt') opt.selected = true;
    vendorSelect.appendChild(opt);
  }
    if (!vendorSelect.value && vendorSelect.options.length > 0) {
      vendorSelect.value = vendorSelect.options[0].value;
    }

    const tabs = Array.isArray(lastState.tabs) ? lastState.tabs : [];
    const list = el('tabsList');
    const empty = el('tabsEmpty');
    list.innerHTML = '';
    empty.style.display = tabs.length ? 'none' : 'block';

    for (const t of tabs) {
    const row = document.createElement('div');
    row.className = 'tab';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.name || t.key || t.id;

    const sub = document.createElement('div');
    sub.className = 'sub';
    const vendorLabel = t.vendorName ? `${t.vendorName}` : 'Unknown vendor';
    const keyLabel = t.key ? `key=${t.key}` : 'no key';
    const used = t.lastUsedAt ? fmtTime(t.lastUsedAt) : '';
    sub.textContent = `${vendorLabel} • ${keyLabel}${used ? ` • used ${used}` : ''}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    const controls = document.createElement('div');
    controls.className = 'controls';

    const btnShow = document.createElement('button');
    btnShow.className = 'btn secondary tabIconBtn';
    btnShow.textContent = '◎';
    btnShow.title = 'Show tab';
    btnShow.setAttribute('aria-label', 'Show tab');
    btnShow.onclick = async () => {
        try {
          await callApi('showTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    const btnHide = document.createElement('button');
    btnHide.className = 'btn secondary tabIconBtn';
    btnHide.textContent = '◒';
    btnHide.title = 'Hide tab';
    btnHide.setAttribute('aria-label', 'Hide tab');
    btnHide.onclick = async () => {
        try {
          await callApi('hideTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    const btnClose = document.createElement('button');
    btnClose.className = 'btn secondary tabIconBtn';
    btnClose.textContent = '✕';
    btnClose.title = 'Close tab';
    btnClose.setAttribute('aria-label', 'Close tab');
    btnClose.onclick = async () => {
      if (t.protectedTab) return;
        try {
          await callApi('closeTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
    };

    if (t.protectedTab) btnClose.disabled = true;
    controls.appendChild(btnShow);
    controls.appendChild(btnHide);
    controls.appendChild(btnClose);

    row.appendChild(meta);
    row.appendChild(controls);
    list.appendChild(row);
  }

    const browserSummary =
      lastState.browserBackend === 'chrome-cdp'
        ? `Chrome CDP${lastState.browser?.profileMode === 'existing' ? ' (existing profile)' : ''}${lastState.browser?.debugPort ? `:${lastState.browser.debugPort}` : ''}`
        : 'Electron';
    statusText(`Backend: ${browserSummary} • Tabs: ${tabs.length} • State: ${lastState.stateDir || ''}`);

  // Settings UI.
    el('setBrowserBackend').value = settings.browserBackend || 'electron';
    el('setChromeProfileMode').value = settings.chromeProfileMode || 'isolated';
    el('setChromeProfileName').value = settings.chromeProfileName || 'Default';
    setNum('setMaxInflight', settings.maxInflightQueries);
    setNum('setQpm', settings.maxQueriesPerMinute);
    setNum('setTabGap', settings.minTabGapMs);
    setNum('setGlobalGap', settings.minGlobalGapMs);
    setChecked('setShowTabsDefault', settings.showTabsByDefault);
    setChecked('setAllowAuthPopups', settings.allowAuthPopups !== false);
    setChecked('setAcknowledge', false);
    el('btnSaveSettings').disabled = true;
    el('settingsHint').textContent = settings.acknowledgedAt ? `Last acknowledged: ${settings.acknowledgedAt}` : 'Not acknowledged yet.';
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function main() {
  if (!getBridge()) {
    statusText('Control Center starting (waiting for desktop bridge)…');
  }

  el('btnRefresh').onclick = () => refresh().catch((e) => statusText(`Refresh failed: ${e?.message || String(e)}`));
  el('btnOpenState').onclick = async () => {
    try {
      await callApi('openStateDir', undefined, { required: true });
      statusText(`Opened state directory: ${lastState.stateDir || ''}`);
    } catch (e) {
      statusText(`State failed: ${e?.message || String(e)}`);
    }
  };
  el('btnShowDefault').onclick = async () => {
    try {
      const st = await callApi('getState', undefined, { fallback: lastState, required: true });
      const target = st?.defaultTabId || lastState.defaultTabId || null;
      if (!target) throw new Error('missing_default_tab');
      await callApi('showTab', { tabId: target }, { required: true });
      statusText(`Default tab shown: ${target}`);
    } catch (e) {
      statusText(`Show default failed: ${e?.message || String(e)}`);
    }
  };

  el('btnCreate').onclick = async () => {
    const vendorId = String(el('vendorSelect').value || '').trim() || 'chatgpt';
    const key = String(el('tabKey').value || '').trim() || null;
    const name = String(el('tabName').value || '').trim() || null;
    const show = !!el('tabShow').checked;
    el('createHint').textContent = '';
    try {
      const out = await callApi('createTab', { vendorId, key, name, show }, { required: true });
      el('createHint').textContent = `Created tab ${out.tabId || ''}`;
      await refresh();
    } catch (e) {
      el('createHint').textContent = `Create failed: ${e?.message || String(e)}`;
    }
  };

  el('setBrowserBackend').onchange = () => {
    syncChromeProfileFields();
  };

  const updateSaveEnabled = () => {
    el('btnSaveSettings').disabled = !el('setAcknowledge').checked;
  };
  el('setAcknowledge').onchange = updateSaveEnabled;
  syncChromeProfileFields();

  el('btnResetSettings').onclick = async () => {
    el('settingsHint').textContent = '';
    try {
      await callApi('setSettings', { reset: true }, { required: true });
      el('settingsHint').textContent = 'Reset to defaults.';
      await refresh();
    } catch (e) {
      el('settingsHint').textContent = `Reset failed: ${e?.message || String(e)}`;
    }
  };

  el('btnSaveSettings').onclick = async () => {
    if (!el('setAcknowledge').checked) return;
    el('settingsHint').textContent = '';
    try {
      const saved = await callApi(
        'setSettings',
        {
          browserBackend: String(el('setBrowserBackend').value || 'electron').trim() || 'electron',
          chromeProfileMode: String(el('setChromeProfileMode').value || 'isolated').trim() || 'isolated',
          chromeProfileName: String(el('setChromeProfileName').value || 'Default').trim() || 'Default',
          maxInflightQueries: num('setMaxInflight', 2),
          maxQueriesPerMinute: num('setQpm', 12),
          minTabGapMs: num('setTabGap', 0),
          minGlobalGapMs: num('setGlobalGap', 0),
          showTabsByDefault: !!el('setShowTabsDefault').checked,
          allowAuthPopups: !!el('setAllowAuthPopups').checked,
          acknowledge: true
        },
        { required: true }
      );
      const backendChanged = String(saved?.browserBackend || 'electron') !== String(lastState.browserBackend || 'electron');
      el('settingsHint').textContent = `Saved.${saved?.acknowledgedAt ? ` ${saved.acknowledgedAt}` : ''}${backendChanged ? ' Restart Agentify Desktop to apply backend changes.' : ''}`;
      setChecked('setAcknowledge', false);
      el('btnSaveSettings').disabled = true;
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${e?.message || String(e)}`;
    }
  };

  if (hasApi('onTabsChanged')) {
    try {
      const b = getBridge();
      b?.onTabsChanged?.(() => refresh().catch(() => {}));
    } catch (e) {
      statusText(`Tabs listener unavailable: ${e?.message || String(e)}`);
      setInterval(() => refresh().catch(() => {}), 3000);
    }
  } else {
    statusText('Tabs listener unavailable (compat mode). Auto-refresh every 3s.');
    setInterval(() => refresh().catch(() => {}), 3000);
  }

  await refresh();
}

main().catch((e) => {
  const st = el('statusLine');
  st.textContent = `Control Center error: ${e?.message || String(e)}`;
});
