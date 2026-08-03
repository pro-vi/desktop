const SAFE_TRANSCRIPT_CODES = new Set([
  'transcript_store_corrupt_state',
  'transcript_store_schema_unsupported',
  'transcript_store_reload_required',
  'transcript_store_size_limit',
  'transcript_store_io'
]);

const SAFE_CATALOG_CODES = new Set([
  'catalog_store_corrupt_state',
  'catalog_store_schema_unsupported',
  'catalog_store_reload_required',
  'catalog_store_size_limit',
  'catalog_store_io'
]);

function unavailable(error, safeCodes, fallbackCode) {
  return Object.freeze({
    status: 'unavailable',
    code: safeCodes.has(error?.code) ? error.code : fallbackCode
  });
}

export async function recoverTranscriptLibraryStartup({ transcriptStore, catalogStore }) {
  let transcripts;
  try {
    const recoveredAttempts = await transcriptStore.recoverInterrupted();
    transcripts = Object.freeze({ status: 'ready', recoveredAttempts });
  } catch (error) {
    transcripts = unavailable(error, SAFE_TRANSCRIPT_CODES, 'transcript_service_unavailable');
  }

  let catalog;
  try {
    const recoveredImports = await catalogStore.recoverInterruptedImports();
    catalog = Object.freeze({ status: 'ready', recoveredImports: recoveredImports.length });
  } catch (error) {
    catalog = unavailable(error, SAFE_CATALOG_CODES, 'catalog_service_unavailable');
  }

  return Object.freeze({ transcripts, catalog });
}
