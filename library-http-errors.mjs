function createStatusMap(groups) {
  const statuses = new Map();
  for (const [status, codes] of groups) {
    for (const code of codes) {
      const existing = statuses.get(code);
      if (existing !== undefined && existing !== status) {
        throw new Error('library_http_error_status_conflict');
      }
      statuses.set(code, status);
    }
  }
  return statuses;
}

const TRANSCRIPT_HTTP_STATUS_BY_ERROR_CODE = createStatusMap([
  [400, [
    'invalid_json',
    'invalid_profile_scope_id',
    'invalid_conversation_identity',
    'invalid_provider_conversation_id',
    'transcript_confirmation_required',
    'transcript_request_invalid',
    'transcript_source_invalid',
    'transcript_track_invalid',
    'transcript_page_limit'
  ]],
  [404, [
    'tab_not_found',
    'transcript_source_not_found',
    'transcript_identity_not_found',
    'transcript_snapshot_not_found'
  ]],
  [409, [
    'key_vendor_mismatch',
    'owned_conversation_required',
    'tab_busy',
    'tab_closed',
    'transcript_source_disabled',
    'transcript_source_exists',
    'transcript_source_key_exists',
    'transcript_sync_active',
    'transcript_no_complete_snapshot',
    'transcript_snapshot_identity_mismatch',
    'transcript_cursor_mismatch'
  ]],
  [413, [
    'body_too_large',
    'transcript_page_character_limit'
  ]],
  [500, [
    'transcript_store_corrupt_state',
    'transcript_store_schema_unsupported',
    'transcript_store_io',
    'transcript_store_reload_required',
    'transcript_store_size_limit',
    'transcript_controller_unavailable',
    'transcript_service_unavailable',
    'transcript_import_index_invalid',
    'library_blob_corrupt',
    'library_blob_hash_collision',
    'library_blob_hash_failure',
    'library_blob_invalid_ref',
    'library_blob_invalid_snapshot',
    'library_blob_io',
    'library_blob_not_found',
    'library_blob_schema_unsupported',
    'library_blob_size_limit',
    'library_blob_snapshot_hash_mismatch'
  ]]
]);

const CATALOG_HTTP_STATUS_BY_ERROR_CODE = createStatusMap([
  [400, [
    'catalog_archive_record_invalid',
    'catalog_batch_invalid',
    'catalog_change_listener_invalid',
    'catalog_clock_invalid',
    'catalog_import_grant_invalid',
    'catalog_import_id_invalid',
    'catalog_import_invalid',
    'catalog_import_outcome_invalid',
    'catalog_import_request_invalid',
    'catalog_profile_hint_invalid',
    'catalog_profile_hints_invalid',
    'catalog_reassign_request_invalid',
    'catalog_request_invalid',
    'catalog_route_invalid',
    'catalog_scope_confirmation_required',
    'catalog_scope_invalid',
    'catalog_verification_key_invalid',
    'catalog_verification_timeout_invalid',
    'export_grant_invalid',
    'export_grant_selection_invalid',
    'export_grant_symlink',
    'export_grant_unreadable',
    'invalid_catalog_contract',
    'invalid_conversation_identity',
    'invalid_json',
    'invalid_profile_scope_id',
    'invalid_provider_conversation_id'
  ]],
  [404, [
    'catalog_conversation_not_found',
    'catalog_import_not_found',
    'catalog_import_grant_unavailable'
  ]],
  [409, [
    'catalog_import_active',
    'catalog_import_capacity_required',
    'catalog_import_manifest_conflict',
    'catalog_import_replay_conflict',
    'catalog_import_cursor_mismatch',
    'catalog_import_not_open',
    'catalog_import_outcome_mismatch',
    'catalog_record_index_mismatch',
    'catalog_scope_conflict',
    'catalog_cursor_mismatch',
    'catalog_route_identity_mismatch',
    'catalog_verification_identity_mismatch',
    'tab_busy',
    'export_grant_moved'
  ]],
  [413, ['body_too_large']],
  [500, [
    'catalog_import_inspection_failed',
    'catalog_import_interrupted',
    'catalog_import_recovery_required',
    'catalog_raw_blob_invalid',
    'catalog_service_unavailable',
    'catalog_snapshot_blob_invalid',
    'catalog_snapshot_mismatch',
    'catalog_store_blobs_required',
    'catalog_store_clock_invalid',
    'catalog_store_corrupt_state',
    'catalog_store_io',
    'catalog_store_reload_required',
    'catalog_store_required',
    'catalog_store_schema_unsupported',
    'catalog_store_size_limit',
    'catalog_store_state_dir_required',
    'export_grant_clock_invalid',
    'export_grant_id_collision',
    'export_grant_picker_failed',
    'library_blob_corrupt',
    'library_blob_hash_collision',
    'library_blob_hash_failure',
    'library_blob_invalid_raw_record',
    'library_blob_invalid_ref',
    'library_blob_invalid_snapshot',
    'library_blob_io',
    'library_blob_non_json_value',
    'library_blob_not_found',
    'library_blob_schema_unsupported',
    'library_blob_size_limit',
    'library_blob_snapshot_hash_mismatch',
    'library_blob_state_dir_required'
  ]]
]);

export function transcriptHttpStatusForErrorCode(code) {
  if (typeof code !== 'string') return null;
  return TRANSCRIPT_HTTP_STATUS_BY_ERROR_CODE.get(code) ?? null;
}

export function catalogHttpStatusForErrorCode(code) {
  if (typeof code !== 'string') return null;
  return CATALOG_HTTP_STATUS_BY_ERROR_CODE.get(code) ?? null;
}

export function isSafeLibraryHttpErrorCode(code) {
  if (code === 'internal_error') return true;
  return transcriptHttpStatusForErrorCode(code) !== null || catalogHttpStatusForErrorCode(code) !== null;
}
