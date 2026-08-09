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

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function fmtSource(source) {
  const key = String(source || '').trim().toLowerCase();
  if (key === 'mcp') return 'MCP';
  if (key === 'ui') return 'UI';
  return 'HTTP';
}

function fmtPhase(phase) {
  const key = String(phase || '').trim().toLowerCase();
  if (key === 'resolving_tab') return 'Starting';
  if (key === 'preparing_context') return 'Packing context';
  if (key === 'waiting_for_ready') return 'Checking page';
  if (key === 'waiting_for_provider_slot') return 'Queued for slot';
  if (key === 'provider_slot_acquired') return 'Slot acquired';
  if (key === 'activating_model_intent') return 'Selecting model';
  if (key === 'model_intent_confirmed') return 'Model selected';
  if (key === 'activating_mode_intent') return 'Selecting mode';
  if (key === 'mode_intent_confirmed') return 'Mode selected';
  if (key === 'uploading_files') return 'Uploading files';
  if (key === 'typing_prompt') return 'Typing prompt';
  if (key === 'sending_prompt') return 'Sending prompt';
  if (key === 'waiting_for_response') return 'Waiting for response';
  if (key === 'reconciling_response') return 'Still listening for completion';
  if (key === 'awaiting_user') return 'Waiting for you';
  return key ? key.replace(/_/g, ' ') : 'Working';
}

function fmtOutcomeStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'success') return 'Last OK';
  if (key === 'stopped') return 'Last stop';
  if (key === 'interrupted') return 'Last interrupted';
  if (key === 'blocked') return 'Last blocked';
  if (key === 'error') return 'Last error';
  return 'Last run';
}

function fmtRunStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'success') return 'Succeeded';
  if (key === 'error') return 'Failed';
  if (key === 'blocked') return 'Blocked';
  if (key === 'stopped') return 'Stopped';
  if (key === 'interrupted') return 'Interrupted';
  if (key === 'running') return 'Running';
  if (key === 'queued') return 'Queued';
  if (key === 'archived') return 'Archived';
  return 'Run';
}

function fmtIntent(intent) {
  const key = String(intent || '').trim().toLowerCase();
  if (key === 'extended-pro') return 'Pro Extended';
  if (key === 'thinking') return 'Medium (Thinking)';
  if (key === 'instant') return 'Instant';
  if (key === 'gpt-5.5-pro') return 'GPT-5.5 Pro';
  if (key === 'gpt-5.4-pro') return 'GPT-5.4 Pro';
  return String(intent || '').trim();
}

function badgeClassForRunStatus(status) {
  const key = String(status || '').trim().toLowerCase();
  if (key === 'success') return 'ok';
  if (key === 'running') return 'ok';
  if (key === 'stopped') return 'info';
  if (key === 'interrupted') return 'warn';
  if (key === 'archived') return 'dim';
  if (key === 'queued') return 'dim';
  return 'warn';
}

function isLiveRun(run) {
  const key = String(run?.status || '').trim().toLowerCase();
  return !run?.finishedAt && (key === 'queued' || key === 'running' || key === 'blocked');
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

const LIBRARY_SCOPE_STORAGE_KEY = 'agentify.transcriptLibrary.profileScopeId';
const LIBRARY_CATALOG_CACHE_MAX = 8;
const SAFE_CONTROL_CENTER_ERROR_CODES = new Set([
  'operation_failed',
  'missing_desktop_api',
  'missing_default_tab',
  'missing_vendor',
  'missing_tabid',
  'default_tab_protected',
  'missing_run_id',
  'run_not_found',
  'run_not_retryable',
  'tab_not_found',
  'tab_closed',
  'tab_busy',
  'max_tabs_reached',
  'key_vendor_mismatch',
  'missing_watch_folder_name',
  'missing_watch_folder_path',
  'watch_folder_cannot_be_filesystem_root',
  'watch_folder_not_directory',
  'watch_folder_not_found',
  'watch_folder_overlaps_existing',
  'invalid_catalog_contract',
  'catalog_response_invalid',
  'catalog_imports_response_invalid',
  'invalid_profile_scope_id',
  'catalog_cursor_mismatch',
  'catalog_store_corrupt_state',
  'catalog_store_schema_unsupported',
  'catalog_store_reload_required',
  'catalog_store_size_limit',
  'catalog_store_io',
  'catalog_import_active',
  'catalog_import_capacity_required',
  'catalog_import_grant_invalid',
  'catalog_import_grant_unavailable',
  'catalog_import_inspection_failed',
  'catalog_import_interrupted',
  'catalog_import_recovery_required',
  'catalog_import_manifest_conflict',
  'catalog_import_request_invalid',
  'catalog_import_state_missing',
  'catalog_scope_confirmation_required',
  'catalog_verification_identity_mismatch',
  'catalog_verification_key_invalid',
  'catalog_reassign_request_invalid',
  'export_grant_response_invalid',
  'export_grant_invalid',
  'export_grant_expired',
  'export_grant_reused',
  'export_grant_not_found',
  'export_grant_scope_mismatch',
  'export_grant_moved',
  'export_grant_symlink',
  'export_grant_unreadable',
  'export_grant_selection_invalid',
  'export_grant_picker_failed',
  'export_archive_changed',
  'export_archive_unreadable',
  'export_not_a_zip',
  'export_unsupported_layout',
  'export_unsafe_archive',
  'export_corrupt_archive',
  'export_corrupt_json',
  'export_malformed_identity',
  'export_scope_mismatch',
  'transcript_sources_response_invalid',
  'transcript_confirmation_required',
  'transcript_source_invalid',
  'transcript_source_exists',
  'transcript_source_key_exists',
  'transcript_source_not_found',
  'transcript_source_disabled',
  'transcript_sync_active',
  'transcript_store_corrupt_state',
  'transcript_store_schema_unsupported',
  'transcript_store_reload_required',
  'transcript_store_size_limit',
  'transcript_store_io',
  'transcript_capture_identity_mismatch',
  'transcript_capture_route_mismatch',
  'transcript_snapshot_content_hash_mismatch',
  'transcript_snapshot_identity_mismatch',
  'transcript_snapshot_origin_mismatch',
  'library_blob_not_found',
  'library_blob_corrupt',
  'library_blob_hash_collision',
  'library_blob_size_limit',
  'library_blob_io'
]);
let libraryActionInFlight = false;
const libraryBusySourceIds = new Set();
const libraryMetadata = {
  imports: { value: [], loaded: false, error: null },
  sources: { value: [], loaded: false, error: null },
  catalogs: new Map()
};
let libraryScopeGeneration = 0;
let libraryRefreshInFlight = null;
let libraryRefreshRerun = false;

function localProfileScope(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function selectedProfileScope() {
  return localProfileScope(el('libraryProfileScope').value);
}

function applyProfileScopeSelection(profileScopeId) {
  if (!profileScopeId || profileScopeId !== selectedProfileScope()) return false;
  const section = libraryMetadata.catalogs.get(profileScopeId);
  if (!section?.loaded || section.error) {
    try {
      window.localStorage?.removeItem(LIBRARY_SCOPE_STORAGE_KEY);
    } catch {}
    const reason = section?.error ? ` (${section.error})` : '';
    libraryStatus(`Profile scope could not be selected${reason}.`, 'warn');
    return false;
  }
  try {
    window.localStorage?.setItem(LIBRARY_SCOPE_STORAGE_KEY, profileScopeId);
  } catch {}
  libraryStatus(`Profile scope selected: ${profileScopeId}`);
  return true;
}

function allowlistedControlCenterErrorCode(value) {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_CONTROL_CENTER_ERROR_CODES.has(code) ? code : null;
}

function safeControlCenterError(error) {
  const structuredCode = allowlistedControlCenterErrorCode(error?.code);
  if (structuredCode) return structuredCode;

  // Electron wraps main-process errors in a fixed prefix and keeps the original
  // symbolic code at the end. Accept only that final allowlisted token; never
  // render the rest of an exception message.
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  const wrappedCode = message.match(/(?:^|:\s)([a-z][a-z0-9_]{0,63})$/i)?.[1] || null;
  return allowlistedControlCenterErrorCode(wrappedCode) || 'operation_failed';
}

function libraryStatus(message, kind = 'dim') {
  const node = el('libraryActionStatus');
  node.textContent = message;
  node.className = `hint libraryStatus ${kind}`;
}

function setLibraryBusy(busy) {
  libraryActionInFlight = !!busy;
  el('btnImportChatGptExport').disabled = !!busy;
  el('btnRefreshLibrary').disabled = !!busy;
}

function formatIdentity(identity) {
  if (!identity || identity.provider !== 'chatgpt') return 'Unknown conversation';
  return `chatgpt/${identity.profileScopeId}/${identity.providerConversationId}`;
}

function addBadge(parent, label, className = 'dim') {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.textContent = label;
  parent.appendChild(badge);
}

function addSubline(parent, text, className = '') {
  const sub = document.createElement('div');
  sub.className = `sub ${className}`.trim();
  sub.textContent = text;
  parent.appendChild(sub);
  return sub;
}

function makeLibraryRow(titleText) {
  const row = document.createElement('div');
  row.className = 'tab libraryItem';
  row.setAttribute('role', 'listitem');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = titleText;
  meta.appendChild(title);
  const controls = document.createElement('div');
  controls.className = 'controls';
  row.appendChild(meta);
  row.appendChild(controls);
  return { row, meta, controls };
}

function makeLibraryButton(label, onClick, { destructive = false, disabled = false, title = '' } = {}) {
  const button = document.createElement('button');
  button.className = `btn secondary tabActionBtn${destructive ? ' destructive' : ''}`;
  button.textContent = label;
  button.disabled = !!disabled || libraryActionInFlight;
  if (title) button.title = title;
  button.onclick = onClick;
  return button;
}

async function withLibraryAction(pendingMessage, operation, { sourceId = null } = {}) {
  if (libraryActionInFlight) return null;
  if (sourceId) libraryBusySourceIds.add(sourceId);
  setLibraryBusy(true);
  renderLibraryFromMetadata();
  libraryStatus(pendingMessage, 'info');
  try {
    return await operation();
  } catch (error) {
    await refreshLibraryMetadata().catch(() => {});
    libraryStatus(`Action failed: ${safeControlCenterError(error)}`, 'fail');
    return null;
  } finally {
    if (sourceId) libraryBusySourceIds.delete(sourceId);
    setLibraryBusy(false);
    renderLibraryFromMetadata();
  }
}

async function importChatGptExport(profileScopeId) {
  return await withLibraryAction('Waiting for one ZIP selection…', async () => {
    const grantResult = await callApi('requestExportGrant', { profileScopeId }, { required: true });
    if (grantResult?.status === 'cancelled') {
      libraryStatus('Import cancelled. No file access was retained.', 'dim');
      return grantResult;
    }
    if (grantResult?.status !== 'granted' || !grantResult?.grant?.grantId) {
      throw new Error('export_grant_response_invalid');
    }
    libraryStatus(`Importing ${grantResult.grant.displayName || 'selected ZIP'}…`, 'info');
    const outcome = await callApi('importChatGptExport', {
      grantId: grantResult.grant.grantId,
      profileScopeId
    }, { required: true });
    if (outcome?.status === 'rejected') {
      libraryStatus(`Import rejected: ${String(outcome.reason || 'unsupported-export')}`, 'fail');
    } else if (outcome?.status === 'partial') {
      const problemCount = outcome.counts?.problems || 0;
      libraryStatus(`Import saved as partial: ${outcome.counts?.cataloged || 0} cataloged, ${problemCount} problem${problemCount === 1 ? '' : 's'}.`, 'warn');
    } else {
      libraryStatus(`Import complete: ${outcome?.counts?.cataloged || 0} conversation(s), ${outcome?.counts?.snapshots || 0} snapshot(s).`, 'ok');
    }
    await refreshLibraryMetadata();
    return outcome;
  });
}

async function verifyCatalogConversation(identity) {
  const key = String(el('libraryVerifyKey').value || '').trim();
  if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
    libraryStatus('Enter a valid verification tab key first.', 'warn');
    return;
  }
  await withLibraryAction('Checking the exact conversation route…', async () => {
    const outcome = await callApi('verifyCatalogConversation', { identity, key }, { required: true });
    if (outcome?.status === 'verified') {
      libraryStatus('Route verified by exact provider conversation ID.', 'ok');
    } else if (outcome?.status === 'unavailable') {
      libraryStatus(`Route is temporarily unavailable (${outcome.observation?.reason || 'unknown'}). The catalog record was kept.`, 'warn');
    } else {
      libraryStatus(`Route check failed (${outcome?.reason || 'transport'}). The catalog record was not changed.`, 'warn');
    }
    await refreshLibraryMetadata();
  });
}

async function reassignCatalogImport(catalogImport, newProfileScopeId) {
  const oldScope = catalogImport?.assignment?.profileScopeId || 'unknown';
  const confirmed = window.confirm(
    `Reassign this import from ${oldScope} to ${newProfileScopeId}? Imported snapshots will be cleared and the same ZIP must be selected again.`
  );
  if (!confirmed) return;
  await withLibraryAction('Reassigning import scope…', async () => {
    const outcome = await callApi('reassignCatalogImport', {
      importId: catalogImport.id,
      newProfileScopeId,
      confirm: true
    }, { required: true });
    libraryStatus(outcome?.changed
      ? 'Scope reassigned. Re-open the same ZIP to rebuild snapshots under the new identity.'
      : 'The import already uses that profile scope.', outcome?.changed ? 'warn' : 'dim');
    await refreshLibraryMetadata();
  });
}

async function syncTranscriptSource(source) {
  await withLibraryAction('Synchronizing the tracked conversation…', async () => {
    const outcome = await callApi('syncTranscript', { sourceId: source.id }, { required: true });
    if (outcome?.status === 'complete' && outcome?.outcome?.changed === false) {
      libraryStatus('Sync complete. Transcript content was unchanged, so the content hash stayed the same.', 'ok');
    } else if (outcome?.status === 'complete' && outcome?.outcome?.changed === true) {
      libraryStatus('Sync complete. New transcript content was saved in the latest immutable snapshot.', 'ok');
    } else if (outcome?.status === 'complete') {
      libraryStatus('Sync complete. The latest capture was recorded.', 'ok');
    } else {
      libraryStatus(`Sync did not advance the complete snapshot (${outcome?.status || 'failed'}).`, 'warn');
    }
    await refreshLibraryMetadata();
  }, { sourceId: source.id });
}

async function forgetTranscriptSource(source) {
  const confirmed = window.confirm(
    'Forget this local tracked source from Agentify’s active list? Recoverable deletion history and immutable transcript blobs may remain locally. The ChatGPT conversation remains untouched.'
  );
  if (!confirmed) return;
  await withLibraryAction('Forgetting the local source…', async () => {
    const outcome = await callApi('forgetTranscript', { sourceId: source.id, confirm: true }, { required: true });
    libraryStatus(outcome?.deleted === false
      ? 'The source was already absent from the active list. Recoverable history and immutable blobs may remain locally. The provider conversation was untouched.'
      : 'Local source forgotten from the active list. Recoverable history and immutable blobs may remain locally. The provider conversation was untouched.', 'ok');
    await refreshLibraryMetadata();
  });
}

function appendLibrarySectionError(list, label, section) {
  if (!section?.error) return;
  const error = document.createElement('div');
  error.className = 'librarySectionError';
  error.setAttribute('role', 'status');
  error.textContent = `${label} refresh failed (${section.error}). ${section.loaded ? 'Showing the last known local state.' : 'No local state has loaded yet.'}`;
  list.appendChild(error);
}

function renderLibrary({ imports, catalog, sources, profileScopeId, stateDir }) {
  const importsList = el('libraryImportsList');
  const catalogList = el('libraryCatalogList');
  const sourcesList = el('librarySourcesList');
  importsList.innerHTML = '';
  catalogList.innerHTML = '';
  sourcesList.innerHTML = '';
  const selectedScopeAccepted = !!profileScopeId && catalog?.loaded === true && !catalog?.error;

  appendLibrarySectionError(importsList, 'Imports', imports);
  const importItems = Array.isArray(imports?.value) ? imports.value : [];
  const importsEmpty = el('libraryImportsEmpty');
  importsEmpty.textContent = imports?.loaded
    ? 'No export imports yet. Choose a ChatGPT export ZIP to build the local catalog.'
    : 'Loading local import state…';
  importsEmpty.style.display = importItems.length || imports?.error ? 'none' : 'block';
  for (const catalogImport of importItems) {
    const { row, meta, controls } = makeLibraryRow(`Import ${catalogImport.id || 'unknown'}`);
    addSubline(meta, `Profile scope: ${catalogImport.assignment?.profileScopeId || 'unknown'} • updated ${fmtTime(catalogImport.updatedAt)}`);
    const statusRow = document.createElement('div');
    statusRow.className = 'statusRow';
    const status = String(catalogImport.status || 'partial');
    addBadge(statusRow, status, status === 'complete' ? 'ok' : status === 'open' ? 'info' : 'warn');
    addBadge(statusRow, `${catalogImport.counts?.recordsSeen || 0} seen`);
    addBadge(statusRow, `${catalogImport.counts?.cataloged || 0} cataloged`);
    addBadge(statusRow, `${catalogImport.counts?.snapshots || 0} snapshots`);
    if (catalogImport.counts?.problems) {
      const problemCount = catalogImport.counts.problems;
      addBadge(statusRow, `${problemCount} problem${problemCount === 1 ? '' : 's'}`, 'warn');
    }
    meta.appendChild(statusRow);
    const legacyReadOnly = catalogImport.readOnlyReason === 'legacy-record-limit';
    if (legacyReadOnly) {
      addSubline(meta, 'Read-only legacy history: this import exceeds the current record limit. Existing local evidence remains available; Resume and Reassign are disabled.');
    } else if (catalogImport.suspension) {
      addSubline(meta, `Recovery state: ${catalogImport.suspension.reason}. Resume cursor ${catalogImport.cursor?.recordIndex || 0}.`);
    }
    if (!legacyReadOnly && catalogImport.status === 'partial' && catalogImport.suspension) {
      controls.appendChild(makeLibraryButton('Resume with ZIP', () =>
        importChatGptExport(catalogImport.assignment.profileScopeId)));
    }
    const canReassign = !legacyReadOnly && selectedScopeAccepted &&
      profileScopeId !== catalogImport.assignment?.profileScopeId;
    if (canReassign) {
      controls.appendChild(makeLibraryButton('Reassign scope', () =>
        reassignCatalogImport(catalogImport, profileScopeId)));
    }
    importsList.appendChild(row);
  }

  appendLibrarySectionError(catalogList, 'Catalog', catalog);
  const catalogPage = catalog?.value;
  const catalogItems = Array.isArray(catalogPage?.items) ? catalogPage.items : [];
  const catalogEmpty = el('libraryCatalogEmpty');
  catalogEmpty.textContent = !profileScopeId
    ? 'Choose a profile scope to list its conversations.'
    : catalog?.loaded
      ? 'No conversations in the selected profile scope.'
      : 'Loading the selected profile scope…';
  catalogEmpty.style.display = catalogItems.length || catalog?.error ? 'none' : 'block';
  for (const conversation of catalogItems) {
    const identity = conversation.identity;
    const { row, meta, controls } = makeLibraryRow(conversation.title || identity?.providerConversationId || 'Untitled conversation');
    addSubline(meta, formatIdentity(identity), 'mono');
    const statusRow = document.createElement('div');
    statusRow.className = 'statusRow';
    const routeKind = conversation.route?.kind || 'unverified';
    addBadge(statusRow, routeKind.replace(/-/g, ' '), routeKind === 'verified' ? 'ok' : routeKind === 'temporarily-unavailable' ? 'warn' : 'dim');
    addBadge(statusRow, conversation.latestImportedSnapshot ? 'snapshot available' : 'catalog only', conversation.latestImportedSnapshot ? 'info' : 'dim');
    meta.appendChild(statusRow);
    if (routeKind === 'temporarily-unavailable') {
      addSubline(meta, `Last route observation: ${conversation.route.reason}. This is not a deletion.`);
    }
    controls.appendChild(makeLibraryButton(routeKind === 'verified' ? 'Verify again' : 'Verify route', () =>
      verifyCatalogConversation(identity)));
    catalogList.appendChild(row);
  }
  el('libraryCatalogPageHint').textContent = catalogPage?.nextCursor
    ? 'Showing the first 100 conversations. Bounded HTTP and MCP pagination can retrieve the next page.'
    : '';

  appendLibrarySectionError(sourcesList, 'Tracked sources', sources);
  const sourceItems = profileScopeId
    ? (Array.isArray(sources?.value) ? sources.value : [])
      .filter((source) => source.identity?.profileScopeId === profileScopeId)
    : [];
  const sourcesEmpty = el('librarySourcesEmpty');
  sourcesEmpty.textContent = !profileScopeId
    ? 'Choose a profile scope to list its tracked live sources.'
    : sources?.loaded
      ? 'No live conversations are tracked locally in this profile scope.'
      : 'Loading tracked live sources…';
  sourcesEmpty.style.display = sourceItems.length || sources?.error ? 'none' : 'block';
  for (const source of sourceItems) {
    const { row, meta, controls } = makeLibraryRow(source.label || source.identity?.providerConversationId || source.id || 'Tracked conversation');
    addSubline(meta, formatIdentity(source.identity), 'mono');
    const statusRow = document.createElement('div');
    statusRow.className = 'statusRow';
    const state = String(source.state || 'tracked');
    const locallyBusy = libraryBusySourceIds.has(source.id);
    const rowUnavailable = locallyBusy || ['syncing', 'disabled', 'busy'].includes(state);
    if (rowUnavailable) row.className += ' isBusy';
    addBadge(statusRow, locallyBusy ? 'syncing' : state.replace(/_/g, ' '), state === 'complete' ? 'ok' : state === 'syncing' || locallyBusy ? 'info' : state === 'tracked' ? 'dim' : 'warn');
    if (source.latestLiveSnapshot) {
      addBadge(statusRow, `snapshot ${String(source.latestLiveSnapshot.contentHash || source.latestLiveSnapshot.hash || '').slice(0, 12)}`, 'info');
    } else {
      addBadge(statusRow, 'no complete snapshot', 'dim');
    }
    meta.appendChild(statusRow);
    if (source.lastAttempt?.outcome?.kind && source.lastAttempt.outcome.kind !== 'complete') {
      addSubline(meta, `Last attempt: ${source.lastAttempt.outcome.kind}. The latest complete snapshot was not advanced.`);
    }
    if (rowUnavailable) {
      const reason = state === 'disabled'
        ? 'This source is disabled. Source actions are unavailable.'
        : 'A source operation is in progress. Sync and local forgetting are temporarily unavailable.';
      addSubline(meta, reason, 'libraryDisabledReason');
    }
    controls.appendChild(makeLibraryButton(locallyBusy || state === 'syncing' ? 'Syncing…' : 'Sync now', () => syncTranscriptSource(source), {
      disabled: rowUnavailable,
      title: rowUnavailable ? 'Wait until the source is available.' : 'Capture this tracked conversation now.'
    }));
    controls.appendChild(makeLibraryButton('Forget locally', () => forgetTranscriptSource(source), {
      destructive: true,
      disabled: rowUnavailable,
      title: rowUnavailable ? 'Wait until the source is available.' : 'Remove only this local source record.'
    }));
    sourcesList.appendChild(row);
  }

  el('libraryStorageLocation').textContent = stateDir
    ? `Local storage: ${stateDir}/transcript-library (private directories and files).`
    : 'Local transcript storage lives inside Agentify’s private state folder.';
}

function emptyCatalogSection() {
  return { value: { items: [], nextCursor: null }, loaded: false, error: null };
}

function renderLibraryFromMetadata() {
  const profileScopeId = selectedProfileScope();
  const catalog = profileScopeId
    ? libraryMetadata.catalogs.get(profileScopeId) || emptyCatalogSection()
    : { value: { items: [], nextCursor: null }, loaded: true, error: null };
  renderLibrary({
    imports: libraryMetadata.imports,
    catalog,
    sources: libraryMetadata.sources,
    profileScopeId,
    stateDir: lastState.stateDir
  });
}

function requireLibraryArray(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function requireCatalogPage(value) {
  if (!value || !Array.isArray(value.items)) throw new Error('catalog_response_invalid');
  return value;
}

function updatedLibrarySection(section, result) {
  if (result.status === 'fulfilled') {
    return { value: result.value, loaded: true, error: null };
  }
  return { ...section, error: safeControlCenterError(result.reason) };
}

function cacheCatalogSection(profileScopeId, section) {
  libraryMetadata.catalogs.delete(profileScopeId);
  libraryMetadata.catalogs.set(profileScopeId, section);
  while (libraryMetadata.catalogs.size > LIBRARY_CATALOG_CACHE_MAX) {
    const oldestScope = libraryMetadata.catalogs.keys().next().value;
    libraryMetadata.catalogs.delete(oldestScope);
  }
}

async function runLibraryMetadataRefresh() {
  const generation = libraryScopeGeneration;
  const profileScopeId = selectedProfileScope();
  const [importsResult, catalogResult, sourcesResult] = await Promise.allSettled([
    callApi('getCatalogImports', undefined, { required: true })
      .then((value) => requireLibraryArray(value, 'catalog_imports_response_invalid')),
    profileScopeId
      ? callApi('getCatalog', { profileScopeId, limit: 100 }, { required: true })
        .then(requireCatalogPage)
      : Promise.resolve(null),
    callApi('getTranscriptSources', undefined, { required: true })
      .then((value) => requireLibraryArray(value, 'transcript_sources_response_invalid'))
  ]);

  if (generation !== libraryScopeGeneration || profileScopeId !== selectedProfileScope()) {
    libraryRefreshRerun = true;
    return;
  }

  libraryMetadata.imports = updatedLibrarySection(libraryMetadata.imports, importsResult);
  libraryMetadata.sources = updatedLibrarySection(libraryMetadata.sources, sourcesResult);
  if (profileScopeId) {
    const prior = libraryMetadata.catalogs.get(profileScopeId) || emptyCatalogSection();
    cacheCatalogSection(profileScopeId, updatedLibrarySection(prior, catalogResult));
  }
  renderLibraryFromMetadata();
}

async function refreshLibraryMetadata() {
  libraryRefreshRerun = true;
  if (libraryRefreshInFlight) return await libraryRefreshInFlight;
  libraryRefreshInFlight = (async () => {
    while (libraryRefreshRerun) {
      libraryRefreshRerun = false;
      await runLibraryMetadataRefresh();
    }
  })().finally(() => {
    libraryRefreshInFlight = null;
  });
  return await libraryRefreshInFlight;
}

function libraryReadErrorCount() {
  const profileScopeId = selectedProfileScope();
  return [
    libraryMetadata.imports,
    libraryMetadata.sources,
    profileScopeId ? libraryMetadata.catalogs.get(profileScopeId) : null
  ].filter((section) => section?.error).length;
}

async function callApi(name, args, { fallback = null, required = false } = {}) {
  const b = getBridge();
  if (typeof b?.[name] !== 'function') {
    if (required) throw new Error('missing_desktop_api');
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
    maxTabs: 50,
    stateDir: '',
    browserBackend: 'electron',
    browser: null,
    compatibility: null,
    runtime: { inflightQueries: 0, providerSlots: { max: 2, activeLeases: [], queued: [] }, activeQueries: [], lastOutcomes: [] }
  };
}

function renderCompatibilityStatus(status) {
  const known = new Set(['observed-healthy', 'observed-degraded', 'drift', 'incomplete', 'unobserved', 'stale', 'incompatible']);
  const verdict = known.has(status?.verdict) ? status.verdict : 'incompatible';
  const labels = {
    'observed-healthy': 'Observed cohort healthy',
    'observed-degraded': 'Observed cohort degraded',
    drift: 'Observed compatibility drift',
    incomplete: 'Compatibility measurement incomplete',
    unobserved: 'Compatibility unobserved',
    stale: 'Compatibility evidence stale',
    incompatible: 'Incompatible compatibility status'
  };
  const verdictNode = el('compatibilityVerdict');
  verdictNode.textContent = labels[verdict];
  verdictNode.className = `compatibilityVerdict ${verdict === 'observed-healthy' ? 'ok' : verdict === 'incompatible' || verdict === 'drift' ? 'fail' : 'warn'}`;
  const observed = Number.isSafeInteger(status?.coverage?.observed) ? status.coverage.observed : 0;
  const total = Number.isSafeInteger(status?.coverage?.total) ? status.coverage.total : 0;
  const schemaVersion = Number.isSafeInteger(status?.schemaVersion) ? status.schemaVersion : '?';
  const contractHash = /^[a-f0-9]{64}$/.test(status?.contractHash || '') ? status.contractHash.slice(0, 12) : 'unknown';
  const apparatus = ['ok', 'drift', 'incomplete'].includes(status?.apparatus?.verdict) ? status.apparatus.verdict : 'incomplete';
  const staleLabel = status?.staleness?.status === 'current'
    ? 'current local evidence'
    : status?.staleness?.status === 'cold' ? 'no exercised evidence'
      : status?.staleness?.status === 'stale-map' ? 'new map awaiting observation'
        : status?.staleness?.status === 'stale' ? 'local evidence is stale' : 'staleness unknown';
  el('compatibilitySummary').textContent = `Observed coverage ${observed}/${total} • apparatus ${apparatus} • map ${contractHash} • schema v${schemaVersion} • ${staleLabel}. This reports only this installation’s exercised cohort.`;
  const list = el('compatibilityCapabilities');
  list.innerHTML = '';
  for (const capability of Array.isArray(status?.capabilities) ? status.capabilities : []) {
    const badge = document.createElement('span');
    const badgeClass = capability.status === 'ok' ? 'ok' : capability.status === 'fail' ? 'warn' : capability.status === 'degraded' ? 'info' : 'dim';
    badge.className = `badge ${badgeClass}`;
    badge.textContent = `${capability.id}: ${capability.status}`;
    list.appendChild(badge);
  }
}

function defaultSettings() {
  return {
    browserBackend: 'electron',
    chromeDebugPort: 9222,
    chromeExecutablePath: null,
    chromeProfileMode: 'isolated',
    chromeProfileName: 'Default',
    maxTabs: 50,
    maxInflightQueries: 2,
    maxQueriesPerMinute: 12,
    minTabGapMs: 0,
    minGlobalGapMs: 0,
    showTabsByDefault: false,
    allowAuthPopups: true,
    defaultProjectUrl: null,
    defaultChatModeIntent: 'extended-pro',
    defaultImageProjectUrl: null,
    defaultImageModeIntent: 'thinking',
    defaultImageKey: 'image-default',
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
let lastRefreshAt = 0;
let hasLiveUpdates = false;

function tabSortWeight(tab, active, outcome) {
  if (active?.blocked) return 0;
  if (active) return 1;
  if (outcome?.status === 'blocked') return 2;
  if (outcome?.status === 'error') return 3;
  if (outcome?.status === 'stopped') return 4;
  if (outcome?.status === 'success') return 5;
  return tab?.protectedTab ? 7 : 6;
}

async function refresh() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const state = (await callApi('getState', undefined, { fallback: lastState })) || lastState;
    const settings = (await callApi('getSettings', undefined, { fallback: defaultSettings() })) || defaultSettings();
    const runsData = (await callApi(
      'getRuns',
      { includeArchived: !!el('showArchivedRuns').checked, limit: 100 },
      { fallback: { runs: [] } }
    )) || { runs: [] };
    const watchFoldersData = (await callApi('listWatchFolders', undefined, { fallback: { folders: [] } })) || { folders: [] };
    lastState = { ...defaultState(), ...state };
    renderCompatibilityStatus(lastState.compatibility);

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
    const runtime = lastState.runtime || { inflightQueries: 0, providerSlots: { max: 2, activeLeases: [], queued: [] }, activeQueries: [], lastOutcomes: [] };
    const activeQueries = Array.isArray(runtime.activeQueries) ? runtime.activeQueries : [];
    const lastOutcomes = Array.isArray(runtime.lastOutcomes) ? runtime.lastOutcomes : [];
    const providerSlots = runtime.providerSlots || { max: settings.maxInflightQueries || 2, activeLeases: [], queued: [] };
    const activeByTab = new Map(activeQueries.map((item) => [item.tabId, item]));
    const outcomeByTab = new Map(lastOutcomes.map((item) => [item.tabId, item]));
    const sortedTabs = [...tabs].sort((a, b) => {
      const aActive = activeByTab.get(a.id) || null;
      const bActive = activeByTab.get(b.id) || null;
      const aOutcome = outcomeByTab.get(a.id) || null;
      const bOutcome = outcomeByTab.get(b.id) || null;
      const weightDelta = tabSortWeight(a, aActive, aOutcome) - tabSortWeight(b, bActive, bOutcome);
      if (weightDelta !== 0) return weightDelta;
      return Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0);
    });
    const list = el('tabsList');
    const empty = el('tabsEmpty');
    list.innerHTML = '';
    const nonDefaultTabs = tabs.filter((item) => !item.protectedTab);
    if (!tabs.length) {
      empty.textContent = 'No tabs listed yet. Open the default tab or create a new vendor tab to start working.';
      empty.style.display = 'block';
    } else if (!nonDefaultTabs.length) {
      empty.textContent = 'Only the pinned default tab is open. Create a keyed vendor tab when you want a dedicated workflow or side-by-side run.';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
    }

    for (const t of sortedTabs) {
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
      const active = activeByTab.get(t.id) || null;
      const outcome = outcomeByTab.get(t.id) || null;
      sub.textContent = `${vendorLabel} • ${keyLabel}${used ? ` • used ${used}` : ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const statusRow = document.createElement('div');
      statusRow.className = 'statusRow';
      const addBadge = (label, className = 'dim') => {
        const badge = document.createElement('span');
        badge.className = `badge ${className}`.trim();
        badge.textContent = label;
        statusRow.appendChild(badge);
      };
      if (t.protectedTab) addBadge('Pinned', 'info');
      if (active) {
        const queuedForSlot = active.providerSlot?.status === 'queued' || active.phase === 'waiting_for_provider_slot';
        addBadge(active.stopRequested ? 'Stopping' : queuedForSlot ? 'Queued' : 'Running', active.stopRequested ? 'warn' : queuedForSlot ? 'dim' : 'ok');
        if (active.source) addBadge(fmtSource(active.source), 'info');
        if (active.modelIntent) addBadge(fmtIntent(active.modelIntent), 'info');
        if (active.modeIntent) addBadge(fmtIntent(active.modeIntent), 'info');
        addBadge(fmtPhase(active.phase), active.blocked ? 'warn' : 'dim');
        if (active.blocked) addBadge(active.blockedTitle || 'Needs attention', 'warn');
        if (active.startedAt) addBadge(`Started ${fmtDuration(Date.now() - active.startedAt)} ago`, 'dim');
      } else {
        addBadge('Idle', 'dim');
        if (t.modelIntent) addBadge(fmtIntent(t.modelIntent), 'dim');
        if (t.modeIntent) addBadge(fmtIntent(t.modeIntent), 'dim');
        if (outcome?.status) addBadge(fmtOutcomeStatus(outcome.status), outcome.status === 'success' ? 'ok' : outcome.status === 'stopped' ? 'info' : 'warn');
        if (outcome?.source) addBadge(fmtSource(outcome.source), 'dim');
      }
      meta.appendChild(statusRow);

      if (active?.promptPreview) {
        const activity = document.createElement('div');
        activity.className = 'sub';
        activity.textContent = `Current job: ${active.promptPreview}`;
        meta.appendChild(activity);
      }
      if (active?.blockedTitle) {
        const blocked = document.createElement('div');
        blocked.className = 'sub';
        blocked.textContent = active.blockedTitle;
        meta.appendChild(blocked);
      } else if (outcome?.detail) {
        const last = document.createElement('div');
        last.className = 'sub';
        last.textContent = `${outcome.label || fmtOutcomeStatus(outcome.status)}: ${outcome.detail}`;
        meta.appendChild(last);
      }

      const controls = document.createElement('div');
      controls.className = 'controls';

      if (active) {
        const btnStop = document.createElement('button');
        btnStop.className = 'btn secondary tabActionBtn';
        btnStop.textContent = active.stopRequested ? 'Stopping…' : 'Stop';
        btnStop.title = 'Break-glass stop for the running query';
        btnStop.setAttribute('aria-label', 'Stop running query');
        btnStop.disabled = !!active.stopRequested;
        btnStop.onclick = async () => {
          try {
            const out = await callApi('stopQuery', { tabId: t.id, runId: active.id }, { required: true });
            statusText(out?.requested ? `Stop requested for ${t.name || t.key || t.id}` : `No active query on ${t.name || t.key || t.id}`);
          } catch (e) {
            statusText(`Stop failed: ${safeControlCenterError(e)}`);
          } finally {
            await refresh();
          }
        };
        controls.appendChild(btnStop);
      }

      const btnShow = document.createElement('button');
      btnShow.className = 'btn secondary tabActionBtn';
      btnShow.textContent = 'Show';
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
      btnHide.className = 'btn secondary tabActionBtn';
      btnHide.textContent = 'Hide';
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
      btnClose.className = 'btn secondary tabActionBtn destructive';
      btnClose.textContent = t.protectedTab ? 'Pinned' : 'Close';
      btnClose.title = t.protectedTab
        ? 'The default tab stays pinned so Agentify always has a fallback tab.'
        : 'Close tab';
      btnClose.setAttribute('aria-label', t.protectedTab ? 'Pinned tab' : 'Close tab');
      btnClose.disabled = !!t.protectedTab;
      btnClose.onclick = async () => {
        if (t.protectedTab) return;
        try {
          await callApi('closeTab', { tabId: t.id }, { required: true });
        } finally {
          await refresh();
        }
      };

      controls.appendChild(btnShow);
      controls.appendChild(btnHide);
      controls.appendChild(btnClose);

      row.appendChild(meta);
      row.appendChild(controls);
      list.appendChild(row);
    }

    const runs = Array.isArray(runsData.runs) ? runsData.runs : [];
    const runsList = el('runsList');
    const runsEmpty = el('runsEmpty');
    runsList.innerHTML = '';
    if (!runs.length) {
      runsEmpty.textContent = el('showArchivedRuns').checked
        ? 'No runs match the current filter.'
        : 'No durable runs yet. Long-running jobs will show up here after the first query finishes or blocks.';
      runsEmpty.style.display = 'block';
    } else {
      runsEmpty.style.display = 'none';
    }

    for (const run of runs) {
      const row = document.createElement('div');
      row.className = 'tab';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = run.promptPreview || run.label || run.id;

      const sub = document.createElement('div');
      sub.className = 'sub';
      const vendorLabel = run.vendorName || run.vendorId || 'Unknown vendor';
      const keyLabel = run.key ? `key=${run.key}` : fmtSource(run.source);
      const updated = run.updatedAt ? fmtTime(run.updatedAt) : '';
      sub.textContent = `${vendorLabel} • ${keyLabel}${updated ? ` • updated ${updated}` : ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const statusRow = document.createElement('div');
      statusRow.className = 'statusRow';
      const addBadge = (label, className = 'dim') => {
        const badge = document.createElement('span');
        badge.className = `badge ${className}`.trim();
        badge.textContent = label;
        statusRow.appendChild(badge);
      };
      addBadge(fmtRunStatus(run.status), badgeClassForRunStatus(run.status));
      if (run.source) addBadge(fmtSource(run.source), 'info');
      if (run.modelIntent) addBadge(fmtIntent(run.modelIntent), 'info');
      if (run.modeIntent) addBadge(fmtIntent(run.modeIntent), 'info');
      if (run.phase && !run.finishedAt) addBadge(fmtPhase(run.phase), run.blocked ? 'warn' : 'dim');
      if (run.retryOf) addBadge('Retry', 'info');
      if (run.archivedAt) addBadge('Archived', 'dim');
      meta.appendChild(statusRow);

      if (run.blockedTitle) {
        const blocked = document.createElement('div');
        blocked.className = 'sub';
        blocked.textContent = run.blockedTitle;
        meta.appendChild(blocked);
      } else if (run.detail) {
        const detail = document.createElement('div');
        detail.className = 'sub';
        detail.textContent = `${run.label || fmtRunStatus(run.status)}: ${run.detail}`;
        meta.appendChild(detail);
      }

      const controls = document.createElement('div');
      controls.className = 'controls';

      const btnOpen = document.createElement('button');
      btnOpen.className = 'btn secondary tabActionBtn';
      btnOpen.textContent = 'Open';
      btnOpen.title = 'Open the saved run context';
      btnOpen.onclick = async () => {
        try {
          const out = await callApi('openRun', { runId: run.id, show: true }, { required: true });
          statusText(`Opened run ${run.id} on ${out?.tabId || 'tab'}`);
        } catch (e) {
          statusText(`Open run failed: ${safeControlCenterError(e)}`);
        } finally {
          await refresh();
        }
      };

      const btnRetry = document.createElement('button');
      btnRetry.className = 'btn secondary tabActionBtn';
      btnRetry.textContent = 'Retry';
      btnRetry.title = 'Replay the stored packed prompt and attachments';
      btnRetry.disabled = isLiveRun(run);
      btnRetry.onclick = async () => {
        try {
          const out = await callApi('retryRun', { runId: run.id, fireAndForget: true }, { required: true });
          statusText(out?.async ? `Retry queued: ${out.runId}` : `Retry finished: ${out?.runId || run.id}`);
        } catch (e) {
          statusText(`Retry failed: ${safeControlCenterError(e)}`);
        } finally {
          await refresh();
        }
      };

      const btnArchive = document.createElement('button');
      btnArchive.className = 'btn secondary tabActionBtn destructive';
      btnArchive.textContent = run.archivedAt ? 'Archived' : 'Archive';
      btnArchive.title = 'Hide this run from the default inbox view';
      btnArchive.disabled = !!run.archivedAt || isLiveRun(run);
      btnArchive.onclick = async () => {
        try {
          const out = await callApi('archiveRun', { runId: run.id }, { required: true });
          statusText(`Archived run ${out?.runId || run.id}`);
        } catch (e) {
          statusText(`Archive failed: ${safeControlCenterError(e)}`);
        } finally {
          await refresh();
        }
      };

      controls.appendChild(btnOpen);
      controls.appendChild(btnRetry);
      controls.appendChild(btnArchive);
      row.appendChild(meta);
      row.appendChild(controls);
      runsList.appendChild(row);
    }

    const watchFolders = Array.isArray(watchFoldersData.folders) ? watchFoldersData.folders : [];
    const watchList = el('watchFoldersList');
    const watchEmpty = el('watchFoldersEmpty');
    watchList.innerHTML = '';
    watchEmpty.style.display = watchFolders.length ? 'none' : 'block';
    for (const folder of watchFolders) {
      const row = document.createElement('div');
      row.className = 'tab';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = folder.name || folder.path;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${folder.path}${folder.isDefault ? ' • default' : ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const controls = document.createElement('div');
      controls.className = 'controls';

      const btnOpen = document.createElement('button');
      btnOpen.className = 'btn secondary tabActionBtn';
      btnOpen.textContent = 'Open';
      btnOpen.title = 'Open folder';
      btnOpen.setAttribute('aria-label', 'Open folder');
      btnOpen.onclick = async () => {
        try {
          await callApi('openWatchFolder', { name: folder.name }, { required: true });
          statusText(`Opened watch folder: ${folder.path}`);
        } catch (e) {
          statusText(`Open watch folder failed: ${safeControlCenterError(e)}`);
        }
      };

      const btnRemove = document.createElement('button');
      btnRemove.className = 'btn secondary tabActionBtn destructive';
      btnRemove.textContent = folder.isDefault ? 'Default' : 'Remove';
      btnRemove.title = 'Remove watch folder';
      btnRemove.setAttribute('aria-label', 'Remove watch folder');
      btnRemove.disabled = !!folder.isDefault;
      btnRemove.onclick = async () => {
        try {
          const out = await callApi('removeWatchFolder', { name: folder.name }, { required: true });
          el('watchFoldersHint').textContent = out?.deleted ? `Removed ${folder.name}.` : `Folder ${folder.name} not found.`;
          await refresh();
        } catch (e) {
          el('watchFoldersHint').textContent = `Remove failed: ${safeControlCenterError(e)}`;
        }
      };

      controls.appendChild(btnOpen);
      controls.appendChild(btnRemove);
      row.appendChild(meta);
      row.appendChild(controls);
      watchList.appendChild(row);
    }

    lastRefreshAt = Date.now();
    const browserSummary =
      lastState.browserBackend === 'chrome-cdp'
        ? `Chrome CDP${lastState.browser?.profileMode === 'existing' ? ' (existing profile)' : ''}${lastState.browser?.debugPort ? `:${lastState.browser.debugPort}` : ''}`
        : 'Electron';
    const activeSlots = Array.isArray(providerSlots.activeLeases) ? providerSlots.activeLeases.length : Number(runtime.inflightQueries || 0);
    const queuedSlots = Array.isArray(providerSlots.queued) ? providerSlots.queued.length : 0;
    const runningSummary = ` • Slots: ${activeSlots}/${providerSlots.max || settings.maxInflightQueries || 2}${queuedSlots ? ` +${queuedSlots} queued` : ''} • Running: ${activeQueries.length}`;
    const runsSummary = ` • Runs: ${runs.length}`;
    const liveSummary = hasLiveUpdates ? 'Live updates on' : 'Polling every 3s';
    const refreshedSummary = lastRefreshAt ? ` • Refreshed ${new Date(lastRefreshAt).toLocaleTimeString()}` : '';
    statusText(`Backend: ${browserSummary} • Tabs: ${tabs.length}/${lastState.maxTabs || settings.maxTabs || 50}${runningSummary}${runsSummary} • ${liveSummary}${refreshedSummary} • State: ${lastState.stateDir || ''}`);

  // Settings UI.
    el('setBrowserBackend').value = settings.browserBackend || 'electron';
    el('setChromeProfileMode').value = settings.chromeProfileMode || 'isolated';
    el('setChromeProfileName').value = settings.chromeProfileName || 'Default';
    setNum('setMaxTabs', settings.maxTabs);
    setNum('setMaxInflight', settings.maxInflightQueries);
    setNum('setQpm', settings.maxQueriesPerMinute);
    setNum('setTabGap', settings.minTabGapMs);
    setNum('setGlobalGap', settings.minGlobalGapMs);
    setChecked('setShowTabsDefault', settings.showTabsByDefault);
    setChecked('setAllowAuthPopups', settings.allowAuthPopups !== false);
    el('setDefaultProjectUrl').value = settings.defaultProjectUrl || '';
    el('setDefaultChatModeIntent').value = settings.defaultChatModeIntent || 'extended-pro';
    el('setDefaultImageProjectUrl').value = settings.defaultImageProjectUrl || '';
    el('setDefaultImageModeIntent').value = settings.defaultImageModeIntent || 'thinking';
    el('setDefaultImageKey').value = settings.defaultImageKey || 'image-default';
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

  try {
    const savedScope = String(window.localStorage?.getItem(LIBRARY_SCOPE_STORAGE_KEY) || '').trim();
    if (localProfileScope(savedScope)) el('libraryProfileScope').value = savedScope;
  } catch {}

  const libraryScopeChanged = () => {
    libraryScopeGeneration += 1;
    renderLibraryFromMetadata();
    refreshLibraryMetadata().catch(() => {});
  };
  el('libraryProfileScope').oninput = libraryScopeChanged;
  el('libraryProfileScope').onchange = async () => {
    const profileScopeId = selectedProfileScope();
    libraryScopeChanged();
    if (!profileScopeId) {
      try {
        window.localStorage?.removeItem(LIBRARY_SCOPE_STORAGE_KEY);
      } catch {}
      libraryStatus('Profile scope could not be selected (invalid_profile_scope_id).', 'warn');
      return;
    }
    await refreshLibraryMetadata();
    applyProfileScopeSelection(profileScopeId);
  };

  el('btnImportChatGptExport').onclick = async () => {
    const profileScopeId = selectedProfileScope();
    if (!profileScopeId) {
      libraryStatus('Enter a profile scope before choosing a ZIP.', 'warn');
      return;
    }
    await refreshLibraryMetadata();
    if (!applyProfileScopeSelection(profileScopeId)) return;
    await importChatGptExport(profileScopeId);
  };

  el('btnRefreshLibrary').onclick = async () => {
    if (libraryActionInFlight) return;
    libraryStatus('Refreshing local library state…', 'info');
    try {
      await refreshLibraryMetadata();
      const errorCount = libraryReadErrorCount();
      libraryStatus(errorCount
        ? `Local refresh finished with ${errorCount} section error${errorCount === 1 ? '' : 's'}. Last known rows were kept.`
        : selectedProfileScope()
          ? 'Local library state refreshed.'
          : 'Local library state refreshed. Choose a profile scope to list its catalog.', errorCount ? 'warn' : 'dim');
    } catch (error) {
      libraryStatus(`Refresh failed: ${safeControlCenterError(error)}`, 'fail');
    }
  };

  el('btnRefresh').onclick = () => refresh().catch((e) => statusText(`Refresh failed: ${safeControlCenterError(e)}`));
  el('btnOpenState').onclick = async () => {
    try {
      await callApi('openStateDir', undefined, { required: true });
      statusText(`Opened state directory: ${lastState.stateDir || ''}`);
    } catch (e) {
      statusText(`State failed: ${safeControlCenterError(e)}`);
    }
  };
  el('btnOpenArtifacts').onclick = async () => {
    try {
      await callApi('openArtifactsDir', undefined, { required: true });
      statusText(`Opened artifacts directory under: ${lastState.stateDir || ''}`);
    } catch (e) {
      statusText(`Artifacts failed: ${safeControlCenterError(e)}`);
    }
  };
  el('btnOpenWatch').onclick = async () => {
    try {
      const out = await callApi('openWatchFolder', { name: 'inbox' }, { required: true });
      statusText(`Opened watch folder: ${out?.folderPath || ''}`);
    } catch (e) {
      statusText(`Watch folder failed: ${safeControlCenterError(e)}`);
    }
  };
  el('btnPickWatchFolder').onclick = async () => {
    try {
      const out = await callApi('pickWatchFolder', undefined, { required: true });
      if (out?.path) el('watchFolderPath').value = out.path;
    } catch (e) {
      el('watchFoldersHint').textContent = `Browse failed: ${safeControlCenterError(e)}`;
    }
  };
  el('btnAddWatchFolder').onclick = async () => {
    const name = String(el('watchFolderName').value || '').trim();
    const folderPath = String(el('watchFolderPath').value || '').trim();
    el('watchFoldersHint').textContent = '';
    try {
      const out = await callApi('addWatchFolder', { name, path: folderPath }, { required: true });
      el('watchFoldersHint').textContent = `Added watch folder ${out?.folder?.name || ''}.`;
      el('watchFolderName').value = '';
      el('watchFolderPath').value = '';
      await refresh();
    } catch (e) {
      el('watchFoldersHint').textContent = `Add failed: ${safeControlCenterError(e)}`;
    }
  };
  el('btnScanWatchFolders').onclick = async () => {
    try {
      const out = await callApi('scanWatchFolders', undefined, { required: true });
      const ingested = Array.isArray(out?.ingested) ? out.ingested.length : 0;
      el('watchFoldersHint').textContent = ingested ? `Indexed ${ingested} new file(s).` : 'No new files found.';
    } catch (e) {
      el('watchFoldersHint').textContent = `Scan failed: ${safeControlCenterError(e)}`;
    }
  };
  el('btnShowDefault').onclick = async () => {
    try {
      const st = await callApi('getState', undefined, { fallback: lastState, required: true });
      const target = st?.defaultTabId || lastState.defaultTabId || null;
      if (!target) throw new Error('missing_default_tab');
      await callApi('showTab', { tabId: target }, { required: true });
      statusText(`Default tab opened: ${target}`);
    } catch (e) {
      statusText(`Open default tab failed: ${safeControlCenterError(e)}`);
    }
  };
  el('showArchivedRuns').onchange = () => {
    refresh().catch((e) => statusText(`Run refresh failed: ${safeControlCenterError(e)}`));
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
      el('createHint').textContent = `Create failed: ${safeControlCenterError(e)}`;
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
      el('settingsHint').textContent = `Reset failed: ${safeControlCenterError(e)}`;
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
          maxTabs: num('setMaxTabs', 50),
          maxInflightQueries: num('setMaxInflight', 2),
          maxQueriesPerMinute: num('setQpm', 12),
          minTabGapMs: num('setTabGap', 0),
          minGlobalGapMs: num('setGlobalGap', 0),
          showTabsByDefault: !!el('setShowTabsDefault').checked,
          allowAuthPopups: !!el('setAllowAuthPopups').checked,
          defaultProjectUrl: String(el('setDefaultProjectUrl').value || '').trim() || null,
          defaultChatModeIntent: String(el('setDefaultChatModeIntent').value || 'extended-pro').trim() || 'extended-pro',
          defaultImageProjectUrl: String(el('setDefaultImageProjectUrl').value || '').trim() || null,
          defaultImageModeIntent: String(el('setDefaultImageModeIntent').value || 'thinking').trim() || 'thinking',
          defaultImageKey: String(el('setDefaultImageKey').value || '').trim() || 'image-default',
          acknowledge: true
        },
        { required: true }
      );
      const backendChanged = String(saved?.browserBackend || 'electron') !== String(lastState.browserBackend || 'electron');
      el('settingsHint').textContent = `Saved.${saved?.acknowledgedAt ? ` ${saved.acknowledgedAt}` : ''}${backendChanged ? ' Restart Agentify Desktop to apply backend changes.' : ''}`;
      setChecked('setAcknowledge', false);
      el('btnSaveSettings').disabled = true;
    } catch (e) {
      el('settingsHint').textContent = `Save failed: ${safeControlCenterError(e)}`;
    }
  };

  let liveBound = false;
  try {
    const b = getBridge();
    if (hasApi('onTabsChanged')) {
      b?.onTabsChanged?.(() => refresh().catch(() => {}));
      liveBound = true;
    }
    if (hasApi('onRunsChanged')) {
      b?.onRunsChanged?.(() => refresh().catch(() => {}));
      liveBound = true;
    }
  } catch (e) {
    liveBound = false;
    statusText(`Live listener unavailable: ${safeControlCenterError(e)}`);
  }
  hasLiveUpdates = liveBound;
  if (!liveBound) {
    hasLiveUpdates = false;
    statusText('Live listeners unavailable (compat mode). Auto-refresh every 3s.');
    setInterval(() => refresh().catch(() => {}), 3000);
  }

  await refresh();

  try {
    const b = getBridge();
    if (hasApi('onLibraryChanged')) {
      b?.onLibraryChanged?.(() => refreshLibraryMetadata().catch(() => {}));
    } else {
      libraryStatus('Live library updates are unavailable. Use Refresh after HTTP or MCP changes.', 'warn');
    }
  } catch {
    libraryStatus('Live library updates are unavailable. Use Refresh after HTTP or MCP changes.', 'warn');
  }

  await refreshLibraryMetadata();
  const initialProfileScopeId = selectedProfileScope();
  if (initialProfileScopeId) applyProfileScopeSelection(initialProfileScopeId);
}

main().catch((e) => {
  const st = el('statusLine');
  st.textContent = `Control Center error: ${safeControlCenterError(e)}`;
});
