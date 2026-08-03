import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { locationFromConversationUrl } from '../chatgpt-location.mjs';
import { createConversationCatalogStore } from '../conversation-catalog-store.mjs';
import { identityFromOwnedLocation } from '../conversation-identity.mjs';
import { recoverTranscriptLibraryStartup } from '../library-startup.mjs';
import { createPrivateLibraryBlobStore } from '../library-blob-store.mjs';
import { createTranscriptStore } from '../transcript-store.mjs';

test('library startup: one corrupt private store does not block recovery of the other', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-library-startup-'));
  t.after(async () => await fs.rm(stateDir, { recursive: true, force: true }));
  const blobs = createPrivateLibraryBlobStore({ stateDir });
  const initialTranscriptStore = createTranscriptStore({ stateDir, blobs });
  await initialTranscriptStore.load();
  const location = locationFromConversationUrl('https://chatgpt.com/c/startup-thread');
  await initialTranscriptStore.register({
    identity: identityFromOwnedLocation('startup-scope', location),
    label: 'Startup fixture',
    tags: [],
    key: 'startup-key',
    target: { kind: 'owned-conversation', location }
  });
  await fs.chmod(initialTranscriptStore.statePath, 0o644);
  const transcriptStore = createTranscriptStore({ stateDir, blobs });
  const catalogStore = createConversationCatalogStore({ stateDir, blobs });

  const result = await recoverTranscriptLibraryStartup({ transcriptStore, catalogStore });

  assert.deepEqual(result.transcripts, {
    status: 'unavailable',
    code: 'transcript_store_corrupt_state'
  });
  assert.deepEqual(result.catalog, { status: 'ready', recoveredImports: 0 });
  assert.equal((await fs.stat(initialTranscriptStore.statePath)).mode & 0o777, 0o644);
});

test('library startup: reports only allowlisted error codes and always attempts both stores', async () => {
  const calls = [];
  const secretBearingError = Object.assign(new Error('private archive path and transcript body'), {
    code: 'unexpected_secret_error'
  });

  const result = await recoverTranscriptLibraryStartup({
    transcriptStore: {
      async recoverInterrupted() {
        calls.push('transcripts');
        throw secretBearingError;
      }
    },
    catalogStore: {
      async recoverInterruptedImports() {
        calls.push('catalog');
        throw secretBearingError;
      }
    }
  });

  assert.deepEqual(calls, ['transcripts', 'catalog']);
  assert.deepEqual(result, {
    transcripts: { status: 'unavailable', code: 'transcript_service_unavailable' },
    catalog: { status: 'unavailable', code: 'catalog_service_unavailable' }
  });
  assert.doesNotMatch(JSON.stringify(result), /archive|transcript body|secret/i);
});
