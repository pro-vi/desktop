import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readUi(name) {
  return await fs.readFile(path.join(__dirname, '..', 'ui', name), 'utf8');
}

function bridgeInvocation(source, method) {
  return new RegExp(`(?:callApi\\(\\s*['"]${method}['"]|\\.${method}\\s*\\()`).exec(source);
}

function assertConfirmedMutation(source, method) {
  const invocation = bridgeInvocation(source, method);
  assert.ok(invocation, `expected renderer to invoke ${method}`);
  const nearby = source.slice(Math.max(0, invocation.index - 1_600), invocation.index + 600);
  assert.match(nearby, /(?:window\.)?confirm\s*\(/, `expected a human confirmation before ${method}`);
  assert.match(nearby, /confirm\s*:\s*true/, `expected ${method} to send confirm: true`);
}

function fakeElement(tagName = 'div') {
  const classes = new Set();
  const node = {
    tagName: tagName.toUpperCase(),
    value: '',
    checked: false,
    disabled: false,
    textContent: '',
    className: '',
    style: {},
    children: [],
    options: [],
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    appendChild(child) {
      this.children.push(child);
      if (child.tagName === 'OPTION') this.options.push(child);
      return child;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    }
  };
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set(value) {
      assert.equal(value, '');
      node.children = [];
      node.options = [];
    }
  });
  return node;
}

function uiHarness(source, { savedScope = 'scope-a', getState, getCatalog, getRuns } = {}) {
  const elements = new Map();
  const intervals = [];
  const libraryChangedListeners = [];
  const localStorageWrites = [];
  const localStorageRemovals = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: (tagName) => fakeElement(tagName)
  };
  const bridge = {
    getState: getState || (async () => ({ vendors: [], tabs: [], stateDir: '/private/state', runtime: {} })),
    getSettings: async () => ({}),
    getRuns: getRuns || (async () => ({ runs: [] })),
    listWatchFolders: async () => ({ folders: [] }),
    getCatalogImports: async () => [],
    getCatalog: getCatalog || (async () => ({ items: [], nextCursor: null })),
    getTranscriptSources: async () => [],
    onTabsChanged: () => {},
    onRunsChanged: () => {},
    onLibraryChanged: (callback) => {
      libraryChangedListeners.push(callback);
      return () => {};
    }
  };
  const window = {
    agentifyDesktop: bridge,
    confirm: () => true,
    localStorage: {
      getItem: () => savedScope,
      setItem: (key, value) => localStorageWrites.push({ key, value }),
      removeItem: (key) => localStorageRemovals.push(key)
    }
  };
  vm.runInNewContext(source, {
    window,
    document,
    console,
    Date,
    Map,
    Set,
    Promise,
    String,
    Number,
    Math,
    Object,
    Array,
    RegExp,
    Error,
    setInterval(callback, delay) {
      intervals.push({ callback, delay });
      return intervals.length;
    }
  });
  return {
    bridge,
    elements,
    intervals,
    localStorageWrites,
    localStorageRemovals,
    async emitLibraryChanged() {
      await Promise.all(libraryChangedListeners.map(async (callback) => await callback()));
    }
  };
}

test('Control Center labels proofless legacy run history as unverified', async () => {
  const source = await readUi('control-center.js');
  const harness = uiHarness(source, {
    getRuns: async () => ({
      runs: [{
        id: 'legacy-run',
        kind: 'query',
        status: 'unverified',
        phase: 'unverified',
        label: 'Legacy output unverified',
        detail: 'Recorded before receipt-backed completion.',
        finishedAt: 2,
        updatedAt: 2,
        completionVerification: {
          status: 'legacy-unverified',
          legacyStatus: 'success',
          reason: 'missing_completion_receipt'
        }
      }]
    })
  });
  await waitFor(
    () => harness.elements.get('runsList')?.children?.length === 1,
    'expected one durable run row'
  );
  const text = descendantText(harness.elements.get('runsList'));
  assert.match(text, /Unverified/);
  assert.doesNotMatch(text, /Succeeded/);
});

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function descendantText(node) {
  return [node?.textContent || '', ...(node?.children || []).map(descendantText)].join(' ');
}

test('Transcript Library Control Center exposes the minimal V0 controls and privacy copy', async () => {
  const html = await readUi('control-center.html');
  const requiredIds = [
    'transcriptLibraryCard',
    'libraryProfileScope',
    'libraryVerifyKey',
    'btnImportChatGptExport',
    'btnRefreshLibrary',
    'libraryActionStatus',
    'libraryImportsEmpty',
    'libraryImportsList',
    'libraryCatalogEmpty',
    'libraryCatalogList',
    'libraryCatalogPageHint',
    'librarySourcesEmpty',
    'librarySourcesList'
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `expected Control Center element ${id}`);
  }

  assert.match(html, /Transcript Library/);
  assert.match(html, /<h2[^>]*class=["']cardTitle["'][^>]*>Transcript Library<\/h2>/);
  for (const heading of ['Imports', 'Tracked live sources', 'Catalog']) {
    assert.match(html, new RegExp(`<h3[^>]*>${heading}<\\/h3>`));
  }
  assert.equal((html.match(/role=["']list["']/g) || []).length, 3);
  assert.equal(html.indexOf('Tracked live sources') < html.indexOf('>Catalog<'), true);
  assert.match(html, /ChatGPT profile scope/i);
  assert.match(html, /Choose ZIP and import/i);
  assert.match(html, /role=["']status["']/);
  assert.match(html, /Imports/);
  assert.match(html, /Catalog/);
  assert.match(html, /Tracked live sources/);
  assert.match(html, /direct route checks/i);
  assert.match(html, /No sidebar scan is performed/i);
  assert.match(html, /ZIP access is one-use/i);
  assert.match(html, /private file permissions/i);
  assert.match(html, /letters, numbers, dots, underscores, colons, or hyphens/i);
  assert.match(html, /spaces are not allowed/i);
  assert.match(html, /active list/i);
  assert.match(html, /Recoverable deletion history/i);
  assert.match(html, /immutable transcript blobs may remain locally/i);
  assert.match(html, /never deletes the provider conversation/i);
});

test('Transcript Library renderer invokes every V0 bridge and requires confirmation for local destruction and reassignment', async () => {
  const source = await readUi('control-center.js');
  const requiredBridgeMethods = [
    'requestExportGrant',
    'importChatGptExport',
    'getCatalog',
    'getCatalogImports',
    'getTranscriptSources',
    'syncTranscript',
    'forgetTranscript',
    'verifyCatalogConversation',
    'reassignCatalogImport'
  ];
  for (const method of requiredBridgeMethods) {
    assert.ok(bridgeInvocation(source, method), `expected renderer to invoke ${method}`);
  }

  assert.match(source, /recordsSeen/, 'expected import progress counts');
  assert.match(source, /snapshots/, 'expected imported snapshot progress');
  assert.match(source, /problems/, 'expected import problem progress');
  assert.match(source, /(?:cursor|resume)/, 'expected resumable import position');
  assert.match(source, /(?:suspension|interrupted|partial)/i, 'expected interrupted-import recovery state');
  assertConfirmedMutation(source, 'forgetTranscript');
  assertConfirmedMutation(source, 'reassignCatalogImport');
});

test('Transcript Library renderer keeps private values in text nodes and has no deferred scan, backfill, or sync timer hook', async () => {
  const source = await readUi('control-center.js');
  const innerHtmlAssignments = Array.from(
    source.matchAll(/\.innerHTML\s*=\s*([^;\n]+)[;\n]/g),
    (match) => match[1].trim()
  );
  for (const expression of innerHtmlAssignments) {
    assert.match(expression, /^(?:''|"")$/, `innerHTML may only clear a container, received ${expression}`);
  }
  assert.doesNotMatch(source, /\.insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(source, /\.outerHTML\s*=/);
  assert.doesNotMatch(source, /document\.write\s*\(/);
  assert.match(source, /document\.createElement\s*\(/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /setAttribute\(\s*['"]role['"]\s*,\s*['"]listitem['"]\s*\)/);

  assert.doesNotMatch(
    source,
    /\b(?:scanTranscriptSidebar|scanCatalogSidebar|backfillTranscript|backfillCatalog|scheduleTranscriptSync|scheduleCatalogSync|startTranscriptTimer|startCatalogTimer)\b/
  );
  assert.doesNotMatch(
    source,
    /callApi\(\s*['"][^'"]*(?:sidebar|backfill|schedule|timer)[^'"]*['"]/i
  );
  assert.doesNotMatch(
    source,
    /set(?:Interval|Timeout)\s*\([\s\S]{0,300}(?:syncTranscript|importChatGptExport|verifyCatalogConversation|reassignCatalogImport|forgetTranscript)/
  );
  assert.doesNotMatch(source, /setInterval\(\(\) => refreshLibraryMetadata\(\)/);
  assert.doesNotMatch(
    source.match(/async function refresh\(\)[\s\S]*?async function main\(\)/)?.[0] || '',
    /refreshLibraryMetadata/
  );
  assert.match(source, /onLibraryChanged/);
});

test('Control Center renders only allowlisted symbolic error codes', async () => {
  const source = await readUi('control-center.js');
  assert.doesNotMatch(source, /\$\{(?:e|error)\?\.message\s*\|\|\s*String\((?:e|error)\)\}/);
  assert.match(source, /const SAFE_CONTROL_CENTER_ERROR_CODES = new Set\(/);
  assert.match(source, /return allowlistedControlCenterErrorCode\(wrappedCode\) \|\| 'operation_failed'/);

  const harness = uiHarness(source);
  const createButton = harness.elements.get('btnCreate');
  await waitFor(() => typeof createButton?.onclick === 'function', 'create control did not initialize');

  const privateDetail = 'private journal text at /private/export/path';
  harness.bridge.createTab = async () => {
    const error = new Error(privateDetail);
    error.code = 'catalog_private_journal_text';
    throw error;
  };
  await createButton.onclick();
  assert.equal(harness.elements.get('createHint').textContent, 'Create failed: operation_failed');
  assert.doesNotMatch(harness.elements.get('createHint').textContent, /journal|private|export\/path/);

  harness.bridge.createTab = async () => {
    throw new Error("Error invoking remote method 'agentify:createTab': Error: max_tabs_reached");
  };
  await createButton.onclick();
  assert.equal(harness.elements.get('createHint').textContent, 'Create failed: max_tabs_reached');

  harness.bridge.createTab = async () => {
    const error = new Error(privateDetail);
    error.code = 'catalog_store_io';
    throw error;
  };
  await createButton.onclick();
  assert.equal(harness.elements.get('createHint').textContent, 'Create failed: catalog_store_io');

  harness.bridge.createTab = async () => {
    const error = new Error(privateDetail);
    error.code = 'catalog_import_capacity_required';
    throw error;
  };
  await createButton.onclick();
  assert.equal(harness.elements.get('createHint').textContent, 'Create failed: catalog_import_capacity_required');
  assert.doesNotMatch(harness.elements.get('createHint').textContent, /journal|private|export\/path/);
});

test('Transcript Library metadata refresh retains last-good rows and reports bounded section errors', async () => {
  const source = await readUi('control-center.js');
  assert.match(source, /Promise\.allSettled\s*\(/);
  assert.match(source, /return \{ \.\.\.section, error: safeControlCenterError\(result\.reason\) \}/);
  assert.match(source, /Showing the last known local state/);
  assert.match(source, /No local state has loaded yet/);
  assert.match(source, /librarySectionError/);

  const refreshBody = source.slice(
    source.indexOf('async function runLibraryMetadataRefresh'),
    source.indexOf('async function refreshLibraryMetadata')
  );
  for (const method of ['getCatalogImports', 'getCatalog', 'getTranscriptSources']) {
    assert.match(refreshBody, new RegExp(`callApi\\('${method}'[\\s\\S]*?required: true`));
  }
  assert.doesNotMatch(refreshBody, /fallback\s*:/);
  assert.doesNotMatch(refreshBody, /syncTranscript|importChatGptExport|verifyCatalogConversation/);

  const conversation = {
    title: 'Last good conversation',
    identity: { provider: 'chatgpt', profileScopeId: 'scope-a', providerConversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    route: { kind: 'unverified' },
    latestImportedSnapshot: null
  };
  const harness = uiHarness(source, {
    getCatalog: async () => ({ items: [conversation], nextCursor: null })
  });
  await waitFor(
    () => descendantText(harness.elements.get('libraryCatalogList')).includes(conversation.title),
    'initial catalog row did not render'
  );
  const catalogList = harness.elements.get('libraryCatalogList');

  harness.bridge.getCatalog = async () => {
    const error = new Error('catalog_store_io at /private/export/path');
    error.code = 'catalog_store_io';
    throw error;
  };
  await harness.elements.get('btnRefreshLibrary').onclick();
  const rendered = descendantText(catalogList);
  assert.match(rendered, /Last good conversation/);
  assert.match(rendered, /Catalog refresh failed \(catalog_store_io\)/);
  assert.match(rendered, /Showing the last known local state/);
  assert.doesNotMatch(rendered, /private\/export\/path/);
});

test('Transcript Library initial metadata waits for the private state directory', async () => {
  const source = await readUi('control-center.js');
  let stateRequested = false;
  let releaseState;
  const pendingState = new Promise((resolve) => { releaseState = resolve; });
  let catalogCalls = 0;
  const harness = uiHarness(source, {
    getState: async () => {
      stateRequested = true;
      return await pendingState;
    },
    getCatalog: async () => {
      catalogCalls += 1;
      return { items: [], nextCursor: null };
    }
  });

  await waitFor(() => stateRequested, 'initial state refresh did not start');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalogCalls, 0, 'library metadata rendered before stateDir was available');

  releaseState({ vendors: [], tabs: [], stateDir: '/private/ordered-state', runtime: {} });
  await waitFor(
    () => catalogCalls > 0 && harness.elements.get('libraryStorageLocation')?.textContent.includes('/private/ordered-state/transcript-library'),
    'library metadata did not render with the resolved private state directory'
  );
});

test('Transcript Library scope refresh discards stale scope results and reruns for the current scope', async () => {
  const source = await readUi('control-center.js');
  let resolveScopeA;
  const scopeA = new Promise((resolve) => { resolveScopeA = resolve; });
  const requestedScopes = [];
  const harness = uiHarness(source, {
    getCatalog: async ({ profileScopeId }) => {
      requestedScopes.push(profileScopeId);
      if (profileScopeId === 'scope-a') return await scopeA;
      return {
        items: [{
          title: 'Scope B conversation',
          identity: { provider: 'chatgpt', profileScopeId: 'scope-b', providerConversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          route: { kind: 'unverified' },
          latestImportedSnapshot: null
        }],
        nextCursor: null
      };
    }
  });

  const scopeInput = harness.elements.get('libraryProfileScope');
  await waitFor(() => typeof scopeInput?.oninput === 'function' && requestedScopes.includes('scope-a'), 'scope A refresh did not start');
  scopeInput.value = 'scope-b';
  scopeInput.oninput();
  resolveScopeA({
    items: [{
      title: 'Scope A conversation',
      identity: { provider: 'chatgpt', profileScopeId: 'scope-a', providerConversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      route: { kind: 'unverified' },
      latestImportedSnapshot: null
    }],
    nextCursor: null
  });

  const catalogList = harness.elements.get('libraryCatalogList');
  await waitFor(
    () => requestedScopes.includes('scope-b') && descendantText(catalogList).includes('Scope B conversation'),
    'scope B results did not render after the stale request'
  );
  assert.doesNotMatch(descendantText(catalogList), /Scope A conversation/);
});

test('Transcript Library change events render open import progress while import IPC is still pending', async () => {
  const source = await readUi('control-center.js');
  const harness = uiHarness(source);
  await waitFor(() => typeof harness.elements.get('btnImportChatGptExport')?.onclick === 'function', 'import control did not initialize');

  let importOpen = false;
  let importSettled = false;
  let resolveImport;
  const pendingImport = new Promise((resolve) => { resolveImport = resolve; });
  harness.bridge.requestExportGrant = async () => ({
    status: 'granted',
    grant: { grantId: 'grant-1', displayName: 'selected.zip' }
  });
  harness.bridge.importChatGptExport = async () => {
    importOpen = true;
    const result = await pendingImport;
    importSettled = true;
    return result;
  };
  harness.bridge.getCatalogImports = async () => importOpen ? [{
    id: 'import-open',
    status: 'open',
    assignment: { profileScopeId: 'scope-a' },
    updatedAt: '2026-07-31T12:00:00.000Z',
    counts: { recordsSeen: 12, cataloged: 8, snapshots: 7, problems: 0 },
    cursor: { recordIndex: 12 },
    suspension: null
  }] : [];

  const actionPromise = harness.elements.get('btnImportChatGptExport').onclick();
  await waitFor(() => importOpen, 'import IPC did not enter its pending state');
  assert.equal(importSettled, false);
  assert.equal(harness.elements.get('btnImportChatGptExport').disabled, true);

  await harness.emitLibraryChanged();
  const importsText = descendantText(harness.elements.get('libraryImportsList'));
  assert.match(importsText, /Import import-open/);
  assert.match(importsText, /open/);
  assert.match(importsText, /12 seen/);
  assert.match(importsText, /8 cataloged/);
  assert.equal(importSettled, false, 'progress must render before the import IPC resolves');

  resolveImport({ status: 'complete', counts: { cataloged: 8, snapshots: 7 } });
  await actionPromise;
  assert.equal(importSettled, true);
});

test('Transcript Library labels oversized legacy imports read-only and hides invalid recovery actions', async () => {
  const source = await readUi('control-center.js');
  const harness = uiHarness(source, { savedScope: 'scope-b' });
  await waitFor(
    () => harness.elements.get('libraryImportsEmpty')?.textContent.includes('No export imports yet'),
    'initial library metadata did not render'
  );
  harness.bridge.getCatalogImports = async () => [{
    id: 'legacy-over-limit',
    status: 'partial',
    assignment: { profileScopeId: 'scope-a' },
    readOnlyReason: 'legacy-record-limit',
    updatedAt: '2026-07-31T12:00:00.000Z',
    counts: { recordsSeen: 20_001, cataloged: 20_001, snapshots: 20_001, problems: 0 },
    cursor: { schemaVersion: 1, recordIndex: 20_001 },
    // A stale suspension must not revive actions after the read-only marker wins.
    suspension: { reason: 'interrupted', observedAt: '2026-07-31T12:00:00.000Z' }
  }];

  await harness.emitLibraryChanged();
  const importList = harness.elements.get('libraryImportsList');
  await waitFor(
    () => descendantText(importList).includes('legacy-over-limit'),
    'read-only legacy import did not render'
  );
  const importRow = importList.children
    .find((node) => node.className.includes('libraryItem'));
  assert.match(descendantText(importRow), /Read-only legacy history/);
  const actionLabels = importRow.children[1].children.map(({ textContent }) => textContent);
  assert.equal(actionLabels.includes('Resume with ZIP'), false);
  assert.equal(actionLabels.includes('Reassign scope'), false);
});

test('Transcript Library source rows expose busy/disabled state and unchanged sync copy honestly', async () => {
  const source = await readUi('control-center.js');
  const css = await readUi('control-center.css');
  assert.match(source, /\['syncing', 'disabled', 'busy'\]\.includes\(state\)/);
  assert.match(source, /Syncing…/);
  assert.match(source, /Source actions are unavailable/);
  assert.match(source, /Sync and local forgetting are temporarily unavailable/);
  assert.match(source, /outcome\?\.outcome\?\.changed === false/);
  assert.match(source, /Transcript content was unchanged, so the content hash stayed the same/);
  assert.match(css, /\.libraryItem\.isBusy/);
  assert.match(css, /\.libraryDisabledReason/);
  assert.match(css, /\.mono\s*\{[\s\S]*overflow-wrap:\s*anywhere/);

  const harness = uiHarness(source);
  await waitFor(() => typeof harness.bridge.onLibraryChanged === 'function', 'library change listener did not initialize');
  await waitFor(() => harness.elements.has('librarySourcesList'), 'initial library metadata did not render');
  const makeSource = (id, state) => ({
    id,
    label: `${state} source`,
    state,
    identity: { provider: 'chatgpt', profileScopeId: 'scope-a', providerConversationId: `${id}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(0, 36) },
    latestLiveSnapshot: null,
    lastAttempt: null
  });
  harness.bridge.getTranscriptSources = async () => [
    makeSource('sync', 'syncing'),
    makeSource('disable', 'disabled'),
    makeSource('busy', 'busy')
  ];
  await harness.emitLibraryChanged();
  const sourceRows = harness.elements.get('librarySourcesList').children
    .filter((node) => node.className.includes('libraryItem'));
  assert.equal(sourceRows.length, 3);
  for (const row of sourceRows) {
    const controls = row.children[1];
    assert.equal(controls.children.length, 2);
    assert.ok(controls.children.every((button) => button.disabled));
    assert.match(descendantText(row), /unavailable/i);
  }

  const tracked = makeSource('tracked', 'tracked');
  harness.bridge.getTranscriptSources = async () => [tracked];
  harness.bridge.syncTranscript = async () => ({ status: 'complete', outcome: { changed: false } });
  await harness.emitLibraryChanged();
  const trackedRow = harness.elements.get('librarySourcesList').children
    .find((node) => node.className.includes('libraryItem'));
  const syncButton = trackedRow.children[1].children.find((button) => button.textContent === 'Sync now');
  assert.equal(syncButton.disabled, false);
  await syncButton.onclick();
  assert.match(harness.elements.get('libraryActionStatus').textContent, /content was unchanged/i);

  harness.bridge.syncTranscript = async () => {
    const error = new Error('tab_busy');
    error.code = 'tab_busy';
    throw error;
  };
  await syncButton.onclick();
  assert.equal(harness.elements.get('libraryActionStatus').textContent, 'Action failed: tab_busy');
});

test('Transcript Library renderer accepts a profile scope only after backend validation', async () => {
  const source = await readUi('control-center.js');
  assert.doesNotMatch(source, /PROFILE_SCOPE_PATTERN/);
  assert.match(source, /trimmed\.length > 128/);
  assert.match(source, /\\u0000-\\u001f/);
  assert.match(source, /callApi\('getCatalog',[\s\S]*?required: true/);

  const requestedScopes = [];
  const harness = uiHarness(source, {
    getCatalog: async ({ profileScopeId }) => {
      requestedScopes.push(profileScopeId);
      if (profileScopeId === 'bad scope') {
        const error = new Error('invalid_profile_scope_id');
        error.code = 'invalid_profile_scope_id';
        throw error;
      }
      return { items: [], nextCursor: null };
    }
  });
  const input = harness.elements.get('libraryProfileScope');
  await waitFor(() => typeof input?.onchange === 'function' && requestedScopes.includes('scope-a'), 'initial scope did not validate');
  harness.bridge.getCatalogImports = async () => [{
    id: 'import-1',
    status: 'complete',
    assignment: { profileScopeId: 'scope-a' },
    counts: { recordsSeen: 1, cataloged: 1, snapshots: 1, problems: 0 },
    cursor: { schemaVersion: 1, recordIndex: 1 },
    suspension: null,
    updatedAt: '2026-07-30T12:00:00.000Z'
  }];
  input.value = 'bad scope';
  await input.onchange();

  assert.equal(requestedScopes.includes('bad scope'), true);
  assert.equal(harness.localStorageWrites.some(({ value }) => value === 'bad scope'), false);
  assert.equal(harness.localStorageRemovals.includes('agentify.transcriptLibrary.profileScopeId'), true);
  assert.match(harness.elements.get('libraryActionStatus').textContent, /could not be selected \(invalid_profile_scope_id\)/);
  const importRow = harness.elements.get('libraryImportsList').children
    .find((node) => node.className.includes('libraryItem'));
  const reassignButton = importRow.children[1].children.find((button) => button.textContent === 'Reassign scope');
  assert.equal(reassignButton, undefined);

  let grantRequests = 0;
  harness.bridge.requestExportGrant = async () => {
    grantRequests += 1;
    return { status: 'cancelled' };
  };
  await harness.elements.get('btnImportChatGptExport').onclick();
  assert.equal(grantRequests, 0);
});
