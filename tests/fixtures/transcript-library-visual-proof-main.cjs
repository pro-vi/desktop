const path = require('node:path');

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');

const PROFILE_SCOPE_ID = 'visual-proof-scope';
const FIXTURE_STATE_DIR = '/tmp/agentify-transcript-library-visual-proof-state';
const FIXTURE_DATE = '2026-07-31T09:00:00.000Z';
const SNAPSHOT_HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);

function parseScenario(argv) {
  const value = argv.find((argument) => argument.startsWith('--scenario='))?.slice('--scenario='.length);
  if (value !== 'states' && value !== 'forget') throw new Error('visual_proof_fixture_scenario_invalid');
  return value;
}

function identity(providerConversationId) {
  return Object.freeze({
    provider: 'chatgpt',
    profileScopeId: PROFILE_SCOPE_ID,
    providerConversationId
  });
}

function snapshotRef(suffix) {
  return Object.freeze({
    kind: 'snapshot',
    algorithm: 'sha256',
    hash: `${suffix}${SNAPSHOT_HASH.slice(1)}`,
    contentHash: CONTENT_HASH,
    byteLength: 512
  });
}

function source({ id, label, state, attempt = null, snapshot = null }) {
  return {
    schemaVersion: 1,
    id,
    identity: identity(`conversation-${id}`),
    label,
    tags: [],
    key: `key-${id}`,
    target: {
      kind: 'owned-conversation',
      location: { kind: 'conversation', chatUrl: `https://chatgpt.com/c/conversation-${id}` }
    },
    enabled: state !== 'disabled',
    latestLiveSnapshot: snapshot,
    lastAttempt: attempt,
    state,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE
  };
}

function fixtureSources(scenario) {
  const tracked = source({ id: 'tracked', label: 'Tracked source', state: 'tracked' });
  if (scenario === 'forget') return [tracked];
  return [
    source({ id: 'disabled', label: 'Disabled source', state: 'disabled', snapshot: snapshotRef('c') }),
    source({ id: 'syncing', label: 'Syncing source', state: 'syncing', snapshot: snapshotRef('d') }),
    source({
      id: 'partial',
      label: 'Partial source',
      state: 'partial',
      snapshot: snapshotRef('e'),
      attempt: {
        schemaVersion: 1,
        id: 'attempt-partial',
        sourceId: 'partial',
        trigger: 'manual',
        startedAt: FIXTURE_DATE,
        finishedAt: FIXTURE_DATE,
        outcome: { kind: 'partial', reason: 'conversation_scroll_stalled' }
      }
    }),
    tracked
  ];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registerFixtureIpc(scenario, getWindow) {
  let sources = fixtureSources(scenario);
  const importedIdentity = identity('catalog-route-observation');

  ipcMain.handle('agentify:getState', async () => ({
    ok: true,
    stateDir: FIXTURE_STATE_DIR,
    vendors: [],
    tabs: [],
    runtime: { inflightQueries: 0, providerSlots: { max: 1, activeLeases: [], queued: [] }, activeQueries: [], lastOutcomes: [] },
    compatibility: null
  }));
  ipcMain.handle('agentify:getSettings', async () => ({}));
  ipcMain.handle('agentify:getRuns', async () => ({ runs: [] }));
  ipcMain.handle('agentify:listWatchFolders', async () => ({ folders: [] }));
  ipcMain.handle('agentify:getCatalogImports', async () => scenario === 'states'
    ? [{
        schemaVersion: 1,
        id: 'import-visual-proof',
        manifest: {
          archiveHash: 'f'.repeat(64),
          layout: 'single-conversations-json',
          accountHint: null
        },
        assignment: { profileScopeId: PROFILE_SCOPE_ID, confirmed: true },
        status: 'partial',
        cursor: { schemaVersion: 1, recordIndex: 12 },
        suspension: { reason: 'interrupted', observedAt: FIXTURE_DATE },
        counts: { recordsSeen: 12, cataloged: 11, snapshots: 10, problems: 1 },
        problems: [],
        createdAt: FIXTURE_DATE,
        updatedAt: FIXTURE_DATE
      }]
    : []);
  ipcMain.handle('agentify:getCatalog', async (_event, request) => {
    if (request?.profileScopeId !== PROFILE_SCOPE_ID) {
      const error = new Error('invalid_profile_scope_id');
      error.code = 'invalid_profile_scope_id';
      throw error;
    }
    return scenario === 'states'
      ? {
          items: [{
            schemaVersion: 1,
            identity: importedIdentity,
            title: 'Route observation fixture',
            route: {
              kind: 'temporarily-unavailable',
              previousUrl: 'https://chatgpt.com/c/catalog-route-observation',
              observedAt: FIXTURE_DATE,
              reason: 'not-found',
              retryable: true
            },
            firstObservedAt: FIXTURE_DATE,
            lastObservedAt: FIXTURE_DATE,
            latestArchiveRecord: {
              kind: 'raw',
              algorithm: 'sha256',
              hash: '9'.repeat(64),
              byteLength: 256
            },
            latestImportedSnapshot: snapshotRef('8')
          }],
          nextCursor: null
        }
      : { items: [], nextCursor: null };
  });
  ipcMain.handle('agentify:getTranscriptSources', async () => clone(sources));
  ipcMain.handle('agentify:forgetTranscript', async (_event, request) => {
    if (request?.confirm !== true) throw new Error('transcript_confirmation_required');
    const priorLength = sources.length;
    sources = sources.filter(({ id }) => id !== request?.sourceId);
    if (sources.length === priorLength) throw new Error('transcript_source_not_found');
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('agentify:libraryChanged');
    return {
      sourceId: request.sourceId,
      recoverable: true,
      recoveryLocation: 'local-trash/visual-proof-source',
      forgottenAt: FIXTURE_DATE
    };
  });
}

async function main() {
  const scenario = parseScenario(process.argv.slice(2));
  nativeTheme.themeSource = 'dark';
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();

  let window = null;
  registerFixtureIpc(scenario, () => window);
  window = new BrowserWindow({
    width: 720,
    height: 1000,
    useContentSize: true,
    show: false,
    title: `Transcript Library visual proof — ${scenario}`,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', '..', 'ui', 'preload.cjs')
    }
  });
  window.setMenuBarVisibility(false);
  await window.loadFile(path.join(__dirname, '..', '..', 'ui', 'control-center.html'));
  window.webContents.setVisualZoomLevelLimits(1, 1);
  window.webContents.setZoomFactor(1);

  app.on('window-all-closed', () => app.quit());
}

main().catch(() => {
  process.stderr.write('visual_proof_fixture_failed\n');
  app.exit(1);
});
