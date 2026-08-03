import { identityFromOwnedLocation } from '../../conversation-identity.mjs';
import { locationFromConversationUrl } from '../../chatgpt-location.mjs';
import {
  createPrivateLibraryBlobStore,
  makeTranscriptSnapshot
} from '../../library-blob-store.mjs';
import { normalizeLiveCapture } from '../../transcript-contract.mjs';
import { createTranscriptStore } from '../../transcript-store.mjs';

const stateDir = process.argv[2];
const conversationUrl = 'https://chatgpt.com/c/subprocess-recovery-thread';
const location = locationFromConversationUrl(conversationUrl);
const capture = {
  status: 'complete',
  conversationUrl,
  capturedAt: '2026-07-30T12:00:02.000Z',
  rawTurns: [
    { ordinal: 0, providerMessageId: 'subprocess-message-1', role: 'user', text: 'Crash boundary fixture' },
    { ordinal: 1, providerMessageId: 'subprocess-message-2', role: 'assistant', text: 'Durable orphan fixture' }
  ],
  evidence: {
    topBoundary: true,
    bottomBoundary: true,
    orderedWindowStitching: true,
    scrollPasses: 2,
    windowCount: 2,
    messageCount: 2,
    providerIdCount: 2,
    byteCount: 0
  }
};
capture.evidence.byteCount = capture.rawTurns.reduce((total, turn) =>
  total + Buffer.byteLength(turn.role) + Buffer.byteLength(turn.text) + Buffer.byteLength(turn.providerMessageId), 0);

const blobs = createPrivateLibraryBlobStore({ stateDir });
const store = createTranscriptStore({
  stateDir,
  blobs,
  clock: (() => {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 6, 30, 12, 0, tick++)).toISOString();
  })(),
  randomId: (() => {
    let next = 0;
    return () => `child-${++next}`;
  })()
});

const source = await store.register({
  identity: identityFromOwnedLocation('personal', location),
  label: 'Subprocess recovery fixture',
  tags: ['recovery'],
  key: 'subprocess-recovery',
  target: { kind: 'owned-conversation', location }
});
await store.beginAttempt(source.id);
await blobs.putSnapshot(makeTranscriptSnapshot({
  identity: source.identity,
  normalizedTranscript: normalizeLiveCapture(capture),
  origin: {
    kind: 'live-capture',
    conversationUrl,
    captureEvidence: capture.evidence
  },
  capturedAt: capture.capturedAt
}));

process.exit(73);
