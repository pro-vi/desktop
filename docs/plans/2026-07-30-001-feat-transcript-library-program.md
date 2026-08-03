---
title: Transcript Library Program Design
objective: Preserve live and exported ChatGPT conversations as identity-stable, immutable, citable source material that coding agents can retrieve and continue safely.
type: feat
status: approved-for-build
date: 2026-07-30
origin: chat architecture + Fable second-opinion adjudication
---

# Transcript Library — Program Design

## 0. Brief

Agentify gains a Transcript Library with a deliberately small live core and an export-backed historical catalog. A user can manually track an open ChatGPT conversation, capture it as immutable ordered turns, retrieve and cite it through coding-agent tools, and continue it in the original thread. A downloaded ChatGPT export can then bootstrap older conversations without making undocumented export JSON or sidebar markup prerequisites for the live loop.

The decision is to ship the controllable live path first, then import exports through a recoverable evidence pipeline: immutable raw and normalized blobs are staged idempotently, and one bounded catalog commit makes a contiguous group of conversations visible while advancing its import cursor. Canonical identity is profile scope plus provider conversation ID; titles and navigation position are observations only. We reject the earlier cross-store attach sequence because a crash could split catalog and transcript state, and we defer sidebar crawling and timers because they are the least stable provider boundaries.

Not in V0: automating the export request/email download, sidebar discovery, periodic synchronization, deletion inference, psychological classification, embeddings, or audio-file archiving. The later U8 sidebar unit and U5 scheduler remain in the build order but have no premature signatures in this program. `[Assumed]` Local plaintext protected by a `0700` directory and `0600` files is acceptable for V0. `[Deferred]` Personal real-export acceptance is postponed until the user has an export ready. U7 remains in V0: one supported real ZIP fixture must traverse the production grant/reader/blob/catalog/service with a deterministic dialog result and a real private-filesystem/subprocess boundary; hostile real ZIP bytes must exercise production reader/service rejection; and recovered catalog state must appear through real Electron, HTTP, MCP, and Control Center entry points. Exact route outcomes remain contract-tested at the controller/service seams without claiming that a personal export or imported route was exercised live. `[Open]` A later personal-export rehearsal must report the available identity, account-hint, and active-branch evidence without inventing missing account metadata. `[Open]` Three captures of one unchanged 100+ turn voice conversation must produce the same normalization version and content hash before any periodic work is authorized.

## 1. Types & signatures

```diff
// conversation-identity.mjs                         + NEW · U1
+ type ChatGptProfileScopeId = Brand<string, 'ChatGptProfileScopeId'>
+ type ChatGptConversationId = Brand<string, 'ChatGptConversationId'>
+ type ConversationIdentityKey = Brand<string, 'ConversationIdentityKey'>
+
+ type ConversationIdentity = {
+   provider: 'chatgpt'
+   profileScopeId: ChatGptProfileScopeId
+   providerConversationId: ChatGptConversationId
+ }
+
+ parseProfileScopeId(value: unknown): ChatGptProfileScopeId
+ identityFromOwnedLocation(
+   scope: ChatGptProfileScopeId,
+   location: ChatGptOwnedConversationLocation,
+ ): ConversationIdentity
+ formatConversationIdentity(identity: ConversationIdentity): ConversationIdentityKey
    // discharges O7: scope + provider ID is identity; label, title, time, route, and rank never participate
    // pre: location passed the existing exact ChatGptLocation parser
    // post: one semantic identity has one stable serialized key; no fuzzy or title-based fallback exists
    // errors: invalid scope/route/provider IDs fail with stable identity protocol codes
    // hides: branded-string representation and future multi-profile discovery
```

```diff
// transcript-contract.mjs                            + NEW · U1
+ type NormalizationVersion = 1
+ type TurnRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown'
+ const TRANSCRIPT_PAGE_MAX_TEXT_CHARS = 1_000_000
+ const TRANSCRIPT_TURN_MAX_TEXT_CHARS = TRANSCRIPT_PAGE_MAX_TEXT_CHARS - 10
+ type TurnIdentity =
+   | { kind: 'provider'; providerMessageId: string }
+   | { kind: 'snapshot-local'; ordinal: number; turnContentHash: Sha256 }
+
+ type TranscriptTurn = {
+   turnId: string
+   ordinal: number
+   identity: TurnIdentity
+   role: TurnRole
+   rawRole: string | null
+   text: string
+ }
+
+ type NormalizedTranscript = {
+   normalizationVersion: NormalizationVersion
+   turns: TranscriptTurn[]
+   characterCount: number
+   contentHash: Sha256
+ }
    // contract: contentHash covers normalizationVersion + ordered canonical turn fields, never origin metadata
    // contract: hashes are comparable only when normalizationVersion agrees
    // contract: every accepted turn, including its longest rendered role label and separator, fits one whole-turn retrieval page
+
+ type CaptureReason =
+   | 'conversation_messages_not_found'
+   | 'conversation_top_not_reached'
+   | 'conversation_scroll_stalled'
+   | 'conversation_capture_timeout'
+   | 'conversation_generation_active'
+   | 'conversation_capture_limit_reached'
+   | 'max_capture_bytes'
+   | 'ambiguous_message_overlap'
+   | 'compatibility_drift'
+
+ type ConversationCapture =
+   | { status: 'complete'; conversationUrl: CanonicalConversationUrl; capturedAt: ISODateTime; rawTurns: RawTranscriptTurn[]; evidence: CaptureEvidence }
+   | { status: 'partial'; reason: CaptureReason; conversationUrl: CanonicalConversationUrl | null; capturedAt: ISODateTime; rawTurns: RawTranscriptTurn[]; evidence: CaptureEvidence }
    // discharges O1: completeness and its failures are one closed discriminated union
+
+ parseConversationCapture(value: unknown): ConversationCapture
+ normalizeLiveCapture(capture: Extract<ConversationCapture, {status:'complete'}>): NormalizedTranscript
+ normalizeArchiveConversation(record: CompleteArchiveConversation): NormalizedTranscript
+ renderTranscript(snapshot: TranscriptSnapshot, opts: RenderOptions): string
    // discharges O2/O4: browser/archive values are parsed exactly; text is a projection of structured turns
    // pre: boundary values are untrusted; normalization receives one proven complete branch
    // post: both origins use the same canonical turn ordering and versioned hash contract
    // errors: malformed protocol, contradictory ordinals, unsupported normalization version, and hash mismatch are distinct
    // hides: validator library, DOM traversal, archive fields, Markdown layout, and pagination
```

```diff
// transcript-source-contract.mjs                     + NEW · U2/U3/U7
+ const TRANSCRIPT_SOURCE_LABEL_MAX_LENGTH = 200
+ const TRANSCRIPT_SOURCE_KEY_MAX_LENGTH = 128
+ const TRANSCRIPT_SOURCE_TAG_MAX_LENGTH = 64
+ const TRANSCRIPT_SOURCE_TAGS_MAX_COUNT = 20
+ parseTranscriptSourceLabel(value: unknown): string
+ parseTranscriptSourceKey(value: unknown): string
+ parseTranscriptSourceTags(value: unknown): readonly string[]
    // contract: persistence, MCP registration, and route verification share one source-metadata authority
    // pre: boundary values are untrusted
    // post: accepted values are non-empty, exact, bounded, trimmed, control-free, and tags are unique
    // errors: malformed source metadata fails with one stable transcript_source_invalid code
    // hides: validation mechanics and downstream schema-library adapters
```

```diff
// private-filesystem.mjs                            + NEW · U2/U7
+ interface PrivateFileSystem {
+   ensurePrivateDirectory(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<void>
+   publishImmutable(path: AbsolutePath, bytes: Uint8Array, opts: { boundaryPath: AbsolutePath }): Promise<{ published: boolean }>
+   replaceFile(path: AbsolutePath, bytes: Uint8Array, opts: { boundaryPath: AbsolutePath }): Promise<void>
+   readPrivateFile(path: AbsolutePath, opts: { boundaryPath: AbsolutePath; maxBytes: number }): Promise<Uint8Array>
+   settleImmutable(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<void>
+   pathKind(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'>
+ }
    // contract: S1/S2/S10 share one real and failure-injectable filesystem boundary
    // post: directories are 0700, files are 0600, writes are fsynced, and paths remain below an exact non-symlink boundary
    // errors: link, mode, confinement, size, publication, replacement, and uncertain-write failures stay distinct
    // hides: temp names, hard-link publication, directory fsync portability, and platform file APIs
```

```diff
// chatgpt-controller.mjs                             ~ MODIFIED · U1
- readConversationText({ maxChars }): Promise<LegacyConversationText>
+ captureConversation({ maxCaptureBytes }): Promise<ConversationCapture>
    // pre: active page is an owned canonical ChatGPT conversation and controller mutex is held
    // post: complete requires generation inactive before and after capture, both transcript boundaries, and ordered-window stitching
    // post: one provider turn container may contain multiple exact messages; preserve served DOM order + provider IDs, and fail partial on conflicting duplicates or reorder
    // post: a numeric provider-turn gap is accepted only after a bounded overlapping served-range scan observes no mapped message there; empty or malformed mapped input still fails partial
    // errors: provider transport rejects; representable incomplete states return PartialCapture
    // hides: selectors, virtualization, scroll strategy, and overlap matching

+ readConversationText({ maxChars }): Promise<LegacyConversationText>
    // post: legacy text is rendered from captureConversation and owns no completeness semantics
    // errors: preserves the existing public error surface
    // hides: structured identities and snapshot storage
```

```diff
// library-blob-store.mjs                             + NEW · U2
+ type SnapshotOrigin =
+   | { kind: 'live-capture'; conversationUrl: CanonicalConversationUrl; captureEvidence: CaptureEvidence }
+   | { kind: 'chatgpt-export'; importId: CatalogImportId; rawRecord: RawRecordRef; branchEvidence: BranchEvidence }
+
+ type TranscriptSnapshot = {
+   schemaVersion: 1
+   identity: ConversationIdentity
+   snapshotHash: Sha256
+   contentHash: Sha256
+   normalizationVersion: NormalizationVersion
+   origin: SnapshotOrigin
+   capturedAt: ISODateTime
+   turns: TranscriptTurn[]
+   characterCount: number
+ }
+
+ interface LibraryBlobStore {                                  // seam S1
+   putRaw(record: RawArchiveRecord): Promise<RawRecordRef>
+   putSnapshot(snapshot: TranscriptSnapshot): Promise<SnapshotRef>
+   getRaw(ref: RawRecordRef): Promise<Uint8Array>
+   getSnapshot(ref: SnapshotRef): Promise<TranscriptSnapshot>
+   pathFor(ref: RawRecordRef | SnapshotRef): AbsolutePath
+ }
    // pre: callers pass bounded bytes or an exactly parsed snapshot
    // post: writes are immutable and idempotent by hash; reads re-hash bytes before returning
    // errors: IO, hash collision, corrupt blob, and unsupported schema remain distinct
    // hides: directory layout, atomic temporary names, garbage collection, and compression
```

```diff
// transcript-store.mjs                               + NEW · U2
+ type TranscriptSource = {
+   schemaVersion: 1
+   id: TranscriptSourceId
+   identity: ConversationIdentity
+   label: string
+   tags: string[]
+   key: string
+   target: { kind: 'owned-conversation'; location: ChatGptOwnedConversationLocation }
+   enabled: boolean
+   state: 'disabled' | 'syncing' | 'tracked' | 'complete' | 'partial' | 'failed' | 'interrupted'
+   latestLiveSnapshot: SnapshotRef | null
+   lastAttempt: AttemptSummary | null
+   createdAt: ISODateTime
+   updatedAt: ISODateTime
+ }
+
+ type AttemptOutcome =
+   | { kind: 'complete'; snapshot: SnapshotRef; changed: boolean }
+   | { kind: 'partial'; reason: CaptureReason }
+   | { kind: 'failed'; reason: SyncFailureReason }
+   | { kind: 'interrupted' }
    // discharges O1: durable attempt outcomes are closed and exhaustive
+
+ interface TranscriptStore {                                   // seam S2
+   register(input: RegisterTranscriptSource): Promise<TranscriptSource>
+   list(): Promise<TranscriptSourceSummary[]>
+   getSource(id: TranscriptSourceId): Promise<TranscriptSource>
+   findSource(identity: ConversationIdentity): Promise<TranscriptSource | null>
+   beginAttempt(id: TranscriptSourceId, trigger: 'manual' | 'post-query'): Promise<TranscriptAttempt>
+   commitComplete(attemptId: AttemptId, snapshot: SnapshotRef, contentHash: Sha256): Promise<SyncResult>
+   finishIncomplete(attemptId: AttemptId, outcome: Exclude<AttemptOutcome, {kind:'complete'}>): Promise<SyncResult>
+   forget(id: TranscriptSourceId): Promise<RecoverableDeletion>
+   recoverInterrupted(): Promise<number>
+ }
    // pre: register identity came from an exact owned route; snapshot blobs exist before commitComplete
    // post: one identity has at most one live source; latest advances atomically iff a complete new hash is durable
    // post: every begun attempt reaches one durable terminal outcome, including restart recovery
    // errors: not-found, duplicate identity (`transcript_source_exists`), duplicate key (`transcript_source_key_exists`), disabled, corrupt-state, and IO have stable symbolic codes
    // hides: source index, write queue, blob placement, and recoverable deletion mechanism
```

```diff
// transcript-sync.mjs                                + NEW · U3
+ interface TranscriptCapturePort {                              // seam S3
+   captureOwnedSource(source: TranscriptSource): Promise<ConversationCapture>
+ }
    // pre: source owns an exact canonical location
    // post: navigation and capture share one controller-exclusive operation on the source key
    // errors: login, challenge, tab closure, navigation, and transport failures stay distinct
    // hides: browser backend, tab IDs, selectors, and provider-slot coordination

+ interface TranscriptSyncService {                              // seam S4
+   track(input: TrackTranscriptInput): Promise<TranscriptSource>
+   sync(sourceId: TranscriptSourceId, trigger?: 'manual' | 'post-query'): Promise<SyncResult>
+   list(): Promise<TranscriptSourceSummary[]>
+   forget(sourceId: TranscriptSourceId): Promise<RecoverableDeletion>
+ }
    // discharges O3/O6: one service owns navigation, locking, normalization, blob publication, and attempt completion
    // pre: track accepts the current owned tab or one exact owned ChatGPT location
    // post: manual and post-query callers await the same typed promise; partial/failed attempts never advance latest
    // errors: source failures cross HTTP/MCP without transcript bodies or DOM excerpts
    // hides: retry policy, paths, controller instance, and provider automation
```

```diff
// transcript-read.mjs                                + NEW · U4/U7
+ type GetTranscriptRequest = {
+   identity: ConversationIdentity
+   snapshot?: SnapshotRef
+   cursor?: TranscriptCursor
+   limit?: number
+   includePaths?: boolean
+ }
+
+ type TurnCitation = {
+   identity: ConversationIdentityKey
+   snapshotHash: Sha256
+   turnId: string
+ }
    // discharges O5: every downstream interpretation can return to immutable source bytes
    // contract: only a human may promote a citation-backed interpretation to an endorsed personal claim

+ interface ImportedConversationIndex {                           // seam S5
+   latestImportedSnapshot(identity: ConversationIdentity): Promise<SnapshotRef | null>
+   hasIdentity(identity: ConversationIdentity): Promise<boolean>
+ }
+
+ interface TranscriptReadService {
+   get(request: GetTranscriptRequest): Promise<TranscriptPage>
+ }
    // pre: identity is exact; cursor belongs to the requested snapshot
    // post: explicit snapshot wins; otherwise newest complete live/imported snapshot wins by capturedAt with deterministic tie-break
    // post: every published turn is retrievable whole within TRANSCRIPT_PAGE_MAX_TEXT_CHARS; pagination never strands latest state
    // errors: unknown identity, no complete snapshot, corrupt blob, cursor mismatch, and page limit are distinct
    // hides: origin-selection query, Markdown rendering, local paths by default, and future search/indexing
```

```diff
// conversation-catalog-contract.mjs                  + NEW · U7
+ type CatalogRoute =
+   | { kind: 'unverified'; claimedConversationId: ChatGptConversationId }
+   | { kind: 'verified'; canonicalUrl: CanonicalConversationUrl; verifiedAt: ISODateTime; evidence: 'tracked-tab' | 'direct-navigation' }
+   | { kind: 'temporarily-unavailable'; previousUrl: CanonicalConversationUrl | null; observedAt: ISODateTime; reason: 'not-found' | 'forbidden' | 'foreign-profile' | 'challenge'; retryable: boolean }
    // discharges O8/O10: unverified IDs cannot navigate; one failed observation never means deletion
+
+ type CatalogConversation = {
+   schemaVersion: 1
+   identity: ConversationIdentity
+   title: string | null
+   route: CatalogRoute
+   firstObservedAt: ISODateTime
+   lastObservedAt: ISODateTime
+   latestArchiveRecord: RawRecordRef
+   latestImportedSnapshot: SnapshotRef | null
+ }
+
+ type CompleteArchiveConversation = {
+   status: 'complete'
+   identity: ConversationIdentity
+   title: string | null
+   rawRecord: RawArchiveRecord
+   rawTurns: RawTranscriptTurn[]
+   activeBranchEvidence: BranchEvidence
+   observedAt: ISODateTime
+ }
+
+ type DecodedArchiveConversation =
+   | CompleteArchiveConversation
+   | { status: 'catalog-only'; identity: ConversationIdentity | null; title: string | null; reason: 'provider-id-missing' | 'active-branch-ambiguous' | 'message-graph-invalid' | 'unsupported-content'; rawRecord: RawArchiveRecord; observedAt: ISODateTime }
+
+ type PreparedArchiveCommit = {
+   identity: ConversationIdentity | null
+   title: string | null
+   rawRecord: RawRecordRef
+   importedSnapshot: SnapshotRef | null
+   observedAt: ISODateTime
+   problem: ImportProblem | null
+ }
+
+ type ExportManifest = {
+   archiveHash: Sha256
+   layout: 'single-conversations-json' | 'numbered-conversations-json'
+   accountHint: OpaqueAccountHint | null
+ }
+
+ type ExportImportOutcome =
+   | { status: 'complete'; importId: CatalogImportId; counts: ImportCounts }
+   | { status: 'partial'; importId: CatalogImportId; counts: ImportCounts; problems: ImportProblem[]; resume: ImportCursor }
+   | { status: 'rejected'; reason: 'not-a-zip' | 'unsupported-export' | 'unsafe-archive' | 'scope-confirmation-required' | 'account-hint-conflict' }
+
+ parseExportImportOutcome(value: unknown): ExportImportOutcome
    // discharges O2: export and persisted variants are exact at every process boundary
    // pre: archive and persisted values are untrusted
    // post: unknown layouts, fields, branches, versions, and contradictory routes cannot enter catalog state
    // errors: malformed values fail with stable protocol codes rather than becoming partial success
    // hides: undocumented export JSON fields and whether accountHint exists in a given export generation
```

```diff
// export-import-grants.mjs                            + NEW · U7
+ parseExportGrantId(value: unknown): ExportImportGrantId
+ interface ExportImportGrantPort {                              // seam S8
+   request(input: { profileScopeId: ChatGptProfileScopeId; browserWindow?: BrowserWindow }): Promise<ExportGrantOutcome>
+   consume(grantId: ExportImportGrantId, profileScopeId: ChatGptProfileScopeId): Promise<GrantedArchive>
+   close(archive: GrantedArchive): Promise<void>
+   revoke(grantId: ExportImportGrantId): Promise<boolean>
+   closeAll(): Promise<void>
+ }
    // pre: a human selected one ZIP in the desktop picker and confirmed a local profile scope
    // post: the one-use grant exposes a read handle and display-safe metadata, never an API-supplied path
    // errors: expired, reused, moved, and unreadable grants are distinct
    // hides: absolute path, bookmark implementation, and Electron dialog details
```

```diff
// chatgpt-export-reader.mjs                           + NEW · U7
+ interface ChatGptExportReader {                                // seam S9
+   inspect(archive: GrantedArchive): Promise<ExportManifest>
+   streamConversations(archive: GrantedArchive, scope: ChatGptProfileScopeId, cursor?: ImportCursor): AsyncIterable<DecodedArchiveConversation>
+ }
    // pre: archive came from a grant; entry count, expanded bytes, depth, and compression ratio are bounded
    // post: one conversations.json or numbered conversation JSON files stream without whole-archive buffering
    // errors: zip-slip, expansion bomb, corrupt JSON, unsupported layout, and record decode stay distinguishable
    // hides: ZIP library, streaming parser, undocumented fields, and future adapters
```

```diff
// conversation-catalog-store.mjs                     + NEW · U7
+ interface ConversationCatalogStore extends ImportedConversationIndex { // seam S10
+   beginImport(manifest: ExportManifest, assignment: ProfileScopeAssignment): Promise<CatalogImport>
+   commitPreparedRecords(importId: CatalogImportId, records: PreparedArchiveCommit[], nextCursor: ImportCursor): Promise<ImportBatchResult>
+   finishImport(importId: CatalogImportId, outcome: ExportImportOutcome): Promise<CatalogImport>
+   recoverInterruptedImports(): Promise<RecoveredImport[]>
+   interruptImport(importId: CatalogImportId): Promise<CatalogImport>
+   verifyRoute(identity: ConversationIdentity, result: VerifiedRoute): Promise<CatalogConversation>
+   observeUnavailable(identity: ConversationIdentity, result: UnavailableRouteObservation): Promise<CatalogConversation>
+   reassignScope(importId: CatalogImportId, newScope: ChatGptProfileScopeId, confirm: true): Promise<ScopeReassignmentResult>
+   list(request: ListCatalogRequest): Promise<CatalogPage>
+   listImports(): Promise<CatalogImport[]>
+   get(identity: ConversationIdentity): Promise<CatalogConversation>
+ }
    // discharges O8/O9/O10: absence never deletes; import replay is idempotent; route promotion needs exact live evidence
    // pre: one non-empty bounded contiguous batch; every immutable raw/snapshot blob exists before commitPreparedRecords
    // post: every projection in the batch + its import cursor advance in one serialized atomic write; a crash before it exposes nothing
    // post: startup converts every open import to visible resumable partial state; replay creates no duplicate identity/snapshot
    // errors: scope conflict, identity conflict, corrupt state, and IO are explicit; title/time matching is defined out
    // hides: metadata index, bounded batch sizing, orphan-blob collection, account-hint comparison, and event compaction
```

```diff
// conversation-catalog-sync.mjs                      + NEW · U7
+ type RouteVerificationOutcome =
+   | { status: 'verified'; identity: ConversationIdentity; canonicalUrl: CanonicalConversationUrl; evidence: 'direct-navigation' }
+   | { status: 'unavailable'; identity: ConversationIdentity; observation: UnavailableRouteObservation }
+   | { status: 'failed'; reason: 'login' | 'challenge' | 'transport' | 'compatibility-drift' }
+
+ type ServedConversationObservation =
+   | { status: 'served'; visibleTurnCount: number }
+   | { status: 'unavailable'; reason: 'not-found' }
+   | { status: 'failed'; reason: 'compatibility-drift' }
+
+ ChatGPTController.prepareChatEntry({ chatUrl, timeoutMs, forceNavigation: true }): Promise<ChatGptEntryTarget>
+   // post: forced navigation proves a replacement document committed before generic readiness can pass, including on Chrome CDP
+   // errors: unavailable document epoch fails closed; a replacement that does not commit is a transport failure
+   // hides: backend load timing and content-free document epoch polling
+
+ ChatGPTController.inspectConversationRoute(): Promise<ServedConversationObservation>
+   // post: served requires a visible role-bearing message nested in a positive provider turn ordinal from the shared compatibility map
+   // errors: no transcript text, role, provider ID, or DOM excerpt crosses this inspection boundary
+   // hides: provider DOM structure and visibility checks
+
+ interface ConversationRouteVerificationPort {                  // seam S11
+   verify(identity: ConversationIdentity, key: string): Promise<RouteVerificationOutcome>
+ }
    // pre: identity belongs to the selected authenticated local profile scope
    // post: verified requires a stable exact route, exact parsed provider ID, clear protective-state checks around inspection, and a served-conversation observation; composer readiness alone is insufficient
    // errors: negative provider observations are not deletion; local tab acquisition, challenge, login, and transport failures do not mutate route state
    // hides: URL construction, redirects, HTTP/UI evidence, and browser backend

+ interface ConversationCatalogService {                         // seam S12
+   importExport(request: ImportExportRequest): Promise<ExportImportOutcome>
+   verifyByNavigation(identity: ConversationIdentity, key: string): Promise<RouteVerificationOutcome>
+   reassignImportScope(input: ReassignScopeInput): Promise<ScopeReassignmentResult>
+   list(request: ListCatalogRequest): Promise<CatalogPage>
+   listImports(): Promise<CatalogImport[]>
+ }
    // pre: import consumes a human grant; comparable account hints must agree
    // post: raw/snapshot blobs stage first, then one bounded catalog commit publishes a contiguous batch + cursor; interrupted imports resume
    // errors: outcome unions cross HTTP/MCP unchanged; paths, raw records, and transcript bodies never enter errors
    // hides: batch assembly, decoder versions, route retry policy, and provider automation
```

```diff
// http-api.mjs                                       ~ MODIFIED · U3/U4/U7
+ POST /catalog/import       -> 200 ExportImportOutcome
+ POST /catalog/verify       -> 200 RouteVerificationOutcome
+ POST /catalog/reassign     -> 200 ScopeReassignmentResult
+ GET  /catalog/list         -> 200 CatalogPage
+ POST /transcripts/track    -> 200 TranscriptSource
+ POST /transcripts/sync     -> 200 SyncResult
+ GET  /transcripts/list     -> 200 TranscriptSourceSummary[]
+ POST /transcripts/get      -> 200 TranscriptPage
+ POST /transcripts/forget   -> 200 RecoverableDeletion
    // pre: loopback bearer authentication is already satisfied
    // post: request/response bodies round-trip exact contracts
    // errors: identifiers and symbolic reasons only; never granted paths, raw records, transcript bodies, or DOM
    // hides: storage paths unless explicitly requested by the authenticated caller
```

```diff
// mcp-server.mjs                                     ~ MODIFIED · U3/U4/U7
+ agentify_import_chatgpt_export(grantId: string, profileScopeId: string): ExportImportOutcome
+ agentify_verify_catalog_conversation(identity: ConversationIdentity, key: string): RouteVerificationOutcome
+ agentify_list_chatgpt_catalog(request: ListCatalogRequest): CatalogPage
+ agentify_track_transcript(input: TrackTranscriptInput): TranscriptSourceSummary
+ agentify_sync_transcript(sourceId: string): SyncResult
+ agentify_list_transcripts(): TranscriptSourceSummary[]
+ agentify_get_transcript(request: GetTranscriptRequest): TranscriptPage
+ agentify_forget_transcript(sourceId: string, confirm: true): RecoverableDeletion
    // post: MCP text is bounded/paginated; structuredContent preserves exact metadata
    // errors: unknown HTTP variants fail closed instead of string coercion
    // hides: bearer transport, storage layout, granted path, and entire-transcript response size
```

```diff
// main.mjs — composition root                        ~ MODIFIED · U2/U3/U4/U7
+ const blobs = createPrivateLibraryBlobStore({ stateDir, fileSystem: privateFileSystem })                 // S1
+ const transcriptStore = createTranscriptStore({ stateDir, blobs, fileSystem: privateFileSystem })        // S2
+ const catalogStore = createConversationCatalogStore({ stateDir, blobs, fileSystem: privateFileSystem })  // S10/S5
+ await transcriptStore.recoverInterrupted()
+ await catalogStore.recoverInterruptedImports()
+ const capture = createChatGptTranscriptCapture({ tabs })                                        // S3
+ const routeVerifier = createChatGptRouteVerifier({ tabs })                                       // S11
+ const grants = createElectronExportImportGrants({ dialog })                                      // S8
+ const exportReader = createChatGptExportReader()                                                  // S9
+ const transcriptSync = createTranscriptSyncService({ store: transcriptStore, blobs, capture, onChanged: emitLibraryChanged })
+ const transcriptRead = createTranscriptReadService({ sources: transcriptStore, imported: catalogStore, blobs })
+ const catalogSync = createConversationCatalogService({ store: catalogStore, blobs, grants, exportReader, routeVerifier, onChanged: emitLibraryChanged })
+ server = startHttpApi({ ..., transcriptSync, transcriptRead, catalogSync })
    // the only production construction site for the library object graph
```

## 2. Call stacks

```diff
// Track the current live conversation · U3
+ agentify_track_transcript({ label, tags, key, profileScopeId })
+   parseTranscriptSourceLabel(label)
+   parseTranscriptSourceTags(tags)
+   parseTranscriptSourceKey(key)
+   POST /transcripts/track
+     resolveTab({ key, createIfMissing: false })
+     controller.getUrl()
+     parseChatGptEntryTarget(url)
+       guard target.kind === 'canonical-conversation' -> 409 'owned-conversation-required'
+     identityFromOwnedLocation(profileScopeId, target.location)
+     transcriptSync.track({ label, tags, key, identity, location })
+       TranscriptStore.register(...)
+         guard identity unique -> 409 'transcript_source_exists'
+         guard key unique -> 409 'transcript_source_key_exists'
+         source -> tracked/no-latest
```

```diff
// Manual live synchronization · U1/U2/U3
+ agentify_sync_transcript(sourceId)
+   POST /transcripts/sync
+     transcriptSync.sync(sourceId, 'manual')
+       TranscriptStore.beginAttempt(sourceId, 'manual')
+       TranscriptCapturePort.captureOwnedSource(source)
+         controller.runExclusive(...)
+           controller.prepareChatEntry({ chatUrl: source.target.location.chatUrl })
+           controller.captureConversation({ maxCaptureBytes })
+             parseConversationCapture(browserValue)
+       complete:
+         normalized = normalizeLiveCapture(capture)
+         snapshot = makeTranscriptSnapshot(source.identity, normalized, liveEvidence)
+         ref = LibraryBlobStore.putSnapshot(snapshot)
+         TranscriptStore.commitComplete(attemptId, ref, normalized.contentHash)
+           atomically advance latestLiveSnapshot + finish attempt
+           // immutable blob first, one metadata commit second: restart can replay or ignore an orphan
+       partial:
+         TranscriptStore.finishIncomplete(attemptId, { kind: 'partial', reason })
+           // prior latest stays untouched
+       failed:
+         capture/navigation/transport -> classified SyncFailureReason
+         normalization/snapshot construction -> 'capture_failed'
+         blob or provable precommit validation -> 'snapshot_write_failed'
+         TranscriptStore.finishIncomplete(attemptId, { kind: 'failed', reason })
+           // every begun attempt terminalizes durably; prior latest stays untouched
```

```diff
// Retrieve exact live or imported material · U4/U7
+ agentify_get_transcript({ identity, snapshot, cursor, limit, includePaths })
+   POST /transcripts/get
+     transcriptRead.get(request)
+       explicit snapshot ?? newest(
+         TranscriptStore.findSource(identity).latestLiveSnapshot,
+         ImportedConversationIndex.latestImportedSnapshot(identity),
+       )
+       guard identity exists -> 404 'transcript_identity_not_found'
+       explicit missing ref -> 404 'transcript_snapshot_not_found'
+       no complete live/imported ref -> 409 'transcript_no_complete_snapshot'
+       LibraryBlobStore.getSnapshot(ref)
+       paginateByTurnIdentity(snapshot.turns, cursor, limit)
+       return { citations, nextCursor, text, structuredTurns, optionalPaths }
```

```diff
// Continue a live-bound conversation · U4
+ agentify_get_transcript({ identity })
+   returns { liveSourceId, sourceKey, conversationUrl, ... }
+ guard liveSourceId && sourceKey && conversationUrl -> 409 'conversation-not-live-bound'
+ agentify_query({ liveSourceId, key: sourceKey, chatUrl: conversationUrl, prompt })
+   POST /query
+     when liveSourceId is present, require the exact all-or-none liveSourceId + key + canonical chatUrl trio
+     before tab/run/provider work:
+       transcriptSync.list()
+       guard exactly one enabled source agrees on source ID, key, source identity, target identity, and requested URL identity
+         -> 409 'conversation-not-live-bound'
+     existing durable query lifecycle
+     after navigation and before provider send:
+       controller.getUrl()
+       guard exact source/request/served provider-ID agreement -> 409 'conversation-not-live-bound'
+     persist liveSourceId in the durable logical request; /runs/retry repeats both guards before provider send
+     on receipt-backed canonical success:
+       transcriptSync.sync(liveSourceId, 'post-query')
+         // same typed sync primitive; continuation creates no second transcript authority
+   // generic queries without liveSourceId retain the existing non-library behavior
```

```diff
// Export-first historical bootstrap · U7
+ Control Center "Import ChatGPT export…"
+   desktop.showOpenDialog({ extensions: ['zip'] })
+   user confirms profile scope
+   ExportImportGrantPort -> one-use grantId
+   agentify_import_chatgpt_export({ grantId, profileScopeId })
+     POST /catalog/import
+       grants.consume(grantId, profileScopeId)
+       exportReader.inspect(archive)
+         guard archive limits -> rejected 'unsafe-archive'
+         guard supported JSON layout -> rejected 'unsupported-export'
+         if comparable accountHint conflicts -> rejected 'account-hint-conflict'
+       catalogStore.beginImport(manifest, assignment)
+       preparedBatch = [] // bounded by record count before any catalog write
+       for await decoded of exportReader.streamConversations(...):
+         rawRef = blobs.putRaw(decoded.rawRecord)
+         snapshotRef = decoded.status === 'complete'
+           ? blobs.putSnapshot(makeImportedSnapshot(normalizeArchiveConversation(decoded)))
+           : null
+         prepared = { identity, title, rawRef, snapshotRef, problem, observedAt }
+         preparedBatch.push(prepared)
+         when batch bound reached or stream ends:
+           catalogStore.commitPreparedRecords(importId, preparedBatch, nextCursor)
+             atomically publish the contiguous batch + cursor
+             // crash before commit leaves only safe immutable orphans; replay is idempotent
+       on stream/decode/store error:
+         catalogStore.interruptImport(importId)
+           publish visible resumable partial state without advancing beyond the committed cursor
+         throw 'catalog_import_interrupted'
+       catalogStore.finishImport(importId, complete|partial)
```

```diff
// Interrupted import recovery · U7
+ app startup
+   catalogStore.recoverInterruptedImports()
+     each open import -> visible partial outcome + durable resume cursor
+ agentify_import_chatgpt_export({ same archive grant, profileScopeId })
+   archiveHash agrees
+   stream from durable cursor
+   repeated raw/snapshot blob writes -> same refs
+   commitPreparedRecords -> exact batch replay creates no duplicate identity or snapshot
```

```diff
// Verify an imported route without sidebar discovery · U7
+ agentify_verify_catalog_conversation(identity, key)
+   parseTranscriptSourceKey(key)
+   POST /catalog/verify
+     routeVerifier.verify(identity, key)
+       force a replacement document at the exact claimed owned URL under selected authenticated profile
+       require an explicit non-blocked challenge observation
+       controller.inspectConversationRoute()
+         map-owned visible role-bearing provider turn -> served
+         retained route + generic composer/error shell -> unavailable
+       require another explicit non-blocked challenge observation
+       stable served owned route + exact provider ID -> verified
+       not-found/forbidden/foreign-profile -> unavailable observation
+       local tab acquisition/login/challenge/transport -> failed; no route mutation
+     verified -> catalogStore.verifyRoute(identity, result)
+     unavailable -> catalogStore.observeUnavailable(identity, observation)
+       // availability observation is not deletion and may be retried
```

```diff
// Explicit local forgetting · U3/U6
+ agentify_forget_transcript({ sourceId, confirm: true })
+   POST /transcripts/forget
+     guard confirm === true -> 400 'confirmation-required'
+     guard no active attempt -> 409 'transcript-sync-active'
+     transcriptSync.forget(sourceId)
+       TranscriptStore.forget(sourceId)
+         remove source from active index atomically
+         move local source metadata to recoverable deletion target
+         return { recoverable: true, recoveryLocation }
```

## 3. File-tree diff

```diff
agentify-desktop/
+ conversation-identity.mjs                         NEW       shared exact provider identity             U1
+ transcript-contract.mjs                          NEW       structured turns + versioned normalization U1/U4
+ transcript-source-contract.mjs                   NEW       exact shared source metadata               U2/U3/U7
+ private-filesystem.mjs                            NEW       private confined atomic filesystem         U2/U7
+ library-blob-store.mjs                           NEW       immutable raw/snapshot evidence             U2/U7
+ transcript-store.mjs                             NEW       live source + attempt authority             U2
+ transcript-sync.mjs                              NEW       manual/post-query orchestration             U3
+ transcript-read.mjs                              NEW       live/import selection + pagination          U4/U7
+ conversation-catalog-contract.mjs                NEW       import/catalog/route outcomes               U7
+ conversation-catalog-store.mjs                   NEW       atomic batch+cursor catalog commits         U7
+ conversation-catalog-sync.mjs                    NEW       import + direct verification authority      U7
+ export-import-grants.mjs                         NEW       human one-use desktop archive grants        U7
+ chatgpt-export-reader.mjs                         NEW       safe streaming export decoder               U7
~ chatgpt-controller.mjs                          MODIFIED  structured capture + route verification     U1/U7
~ chrome-cdp-backend.mjs                         MODIFIED  capture cancellation + route drift guard    U1/U7
~ electron-browser-backend.mjs                   MODIFIED  capture cancellation + route drift guard    U1/U7
~ chatgpt-compatibility.json                      MODIFIED  transcript capability authority             U1/U7
~ chatgpt-compatibility.mjs                       MODIFIED  transcript capability validation            U1/U7
~ chatgpt-location.mjs                            MODIFIED  exact canonical conversation parsing        U1/U7
~ http-api.mjs                                    MODIFIED  catalog + transcript routes                  U3/U4/U7
~ mcp-server.mjs                                  MODIFIED  coding-agent library tools                   U3/U4/U7
~ mcp-tool-profile.mjs                            MODIFIED  catalog/transcript tool membership           U3/U4/U7
~ main.mjs                                        MODIFIED  composition + recovery                       U2/U3/U4/U7
~ ui/preload.cjs                                  MODIFIED  import/catalog/transcript IPC mirror         U6/U7
~ ui/preload.mjs                                  MODIFIED  import/catalog/transcript IPC mirror         U6/U7
~ ui/control-center.html                          MODIFIED  grant/import/catalog/source review           U6/U7
~ ui/control-center.js                            MODIFIED  import/verify/source actions                 U6/U7
~ ui/control-center.css                           MODIFIED  import/catalog/sync states                   U6/U7
~ README.md                                       MODIFIED  bootstrap, privacy, reload, recovery         U4/U6/U7
~ package.json                                    MODIFIED  package-safe Electron dependency placement   U6
~ package-lock.json                               MODIFIED  package dependency metadata                 U6
+ scripts/e2e-transcript-library.mjs               NEW       real Electron/MCP acceptance runner          U6/U7
+ scripts/visual-proof-transcript-library.mjs      NEW       deterministic Control Center visual proof    U6/U7
  run-store.mjs                                   (context — serialized durability precedent, not modified)
  context-packer.mjs                              (context — bounded projection consumer, not authority)
~ tests/chatgpt-compatibility-map.contract.test.mjs MODIFIED transcript compatibility-map authority     U1/U7
~ tests/chatgpt-compatibility-policy.test.mjs     MODIFIED  transcript compatibility policy             U1/U7
~ tests/chatgpt-controller.test.mjs               MODIFIED  structured capture adversarial cases         U1
~ tests/chrome-cdp-backend.test.mjs              MODIFIED  CDP capture cancellation + route guard       U1/U7
~ tests/electron-browser-backend.test.mjs        MODIFIED  Electron capture cancellation + route guard  U1/U7
~ tests/chatgpt-location.test.mjs                 MODIFIED  exact owned-route parsing                    U1/U7
~ tests/fixtures/chatgpt-compatibility/current.json MODIFIED transcript compatibility fixture          U1/U7
+ tests/conversation-identity.test.mjs             NEW       identity exactness and dedup                 U1
+ tests/transcript-contract.test.mjs               NEW       normalization/version/hash contract         U1/U7
+ tests/library-blob-store.test.mjs                NEW       immutable/hash/corruption invariants        U2/U7
+ tests/transcript-source-contract.test.mjs        NEW       source metadata boundary parity             U2/U3/U7
+ tests/transcript-store.test.mjs                  NEW       source/attempt/restart invariants           U2
+ tests/transcript-sync.test.mjs                   NEW       manual/post-query lifecycle                 U3
+ tests/transcript-read.test.mjs                   NEW       live/import selection + citations           U4/U7
+ tests/export-import-grants.test.mjs              NEW       one-use picker and file identity             U7
+ tests/chatgpt-export-reader.test.mjs             NEW       format, branch, and hostile ZIP fixtures    U7
+ tests/conversation-catalog-store.test.mjs        NEW       atomic cursor/replay/recovery               U7
+ tests/conversation-catalog-sync.test.mjs         NEW       import + route verification                 U7
+ tests/conversation-route-verifier.test.mjs       NEW       exact direct-navigation outcomes            U7
+ tests/control-center-transcript-library.test.mjs NEW       renderer states and action guards           U6/U7
+ tests/transcript-library-reporter-redaction.test.mjs NEW   acceptance output privacy boundary          U6/U7
+ tests/transcript-library-visual-proof.test.mjs  NEW       Electron visual proof contract              U6/U7
+ tests/fixtures/transcript-library-crash-child.mjs NEW      import subprocess crash/recovery            U7
+ tests/fixtures/transcript-library-visual-proof-main.cjs NEW real renderer proof process                U6/U7
+ tests/fixtures/transcript-store-crash-child.mjs  NEW       live subprocess crash/recovery              U2/U3
+ tests/fixtures/zip-archive.mjs                   NEW       real hostile/archive byte fixtures          U7
~ tests/http-api.test.mjs                         MODIFIED  exact route/protocol integration             U3/U4/U7
~ tests/mcp-server-names.test.mjs                 MODIFIED  tool registration                           U3/U4/U7
~ tests/mcp-tool-profile-integration.test.mjs     MODIFIED  real MCP profile protocol                   U3/U4/U7
~ tests/mcp-tool-profile.test.mjs                 MODIFIED  profile contract                             U3/U4/U7
~ tests/preload-bridge.test.mjs                   MODIFIED  CJS/ESM IPC parity                           U6/U7
  tests/preload-surface.test.mjs                  (context — existing generic renderer parity)
```

## 4. Seams & enabling points

| Seam | Interface | Enabling point | Test double | Contract comments proved |
|---|---|---|---|---|
| **S1** | `LibraryBlobStore` | blob store plus `PrivateFileSystem` passed in `main.mjs` | real private filesystem plus corrupt/failing operations | immutable idempotent writes; private modes; hash verification; orphan safety |
| **S2** | `TranscriptStore` | `createTranscriptSyncService({ store })`; store accepts `fileSystem` | real private filesystem plus subprocess crash fixture | one live source per identity; shared source-field parsing; atomic complete-only latest; restart recovery |
| **S3** | `TranscriptCapturePort` | `createTranscriptSyncService({ capture })` | scripted complete/partial/thrown captures | one critical section; exact failure distinctions; no content in errors |
| **S4** | `TranscriptSyncService` | injected into HTTP/MCP handlers | in-memory service implementing exact results | shared source-field schema parity; route schemas; status mapping; confirmation guards |
| **S5** | `ImportedConversationIndex` | `createTranscriptReadService({ imported })` | empty index for U4; catalog store for U7 | live loop builds before import; deterministic live/import selection |
| **S6** | `ChatGptLocation` parser | identity and route-verifier dependencies | existing exact parser tests plus live rehearsal | foreign origin refusal; exact provider ID; query/hash stripping |
| **S7** | Browser DOM/virtualization | `ChatGPTController.captureConversation()` | VM-backed virtualized DOM plus none — live e2e | repeated turns, compound same-container messages, proven non-message provider gaps, delayed boundaries, stable normalized hash |
| **S8** | `ExportImportGrantPort` | `createElectronExportImportGrants()` injected into catalog service | one-use grants with expired/reused/moved variants | human selection, path confinement, scope confirmation, no path leakage |
| **S9** | `ChatGptExportReader` | `createConversationCatalogService({ exportReader })` | single/numbered JSON, ambiguous graph, zip-slip, expansion-bomb fixtures | bounded streaming; exact decode; hostile archive rejection |
| **S10** | `ConversationCatalogStore` | catalog service constructor and read-service imported index | real private filesystem plus failure-injecting atomic writer/subprocess | bounded batch+cursor atomicity; replay idempotence; interrupted recovery; no fuzzy identity |
| **S11** | `ConversationRouteVerificationPort` | catalog service constructor plus map-owned served-conversation inspection | verified/unavailable/failed scripted outcomes plus retained-route error shell and live e2e | exact promotion requires stable route + provider ID + visible provider turn; transient failure non-mutation; unavailable-is-not-deleted |
| **S12** | `ConversationCatalogService` | injected into HTTP/MCP handlers | in-memory service implementing exact import/verify variants | shared verification-key schema; protocol mapping; account-hint gate; sensitive-error redaction |

## 5. Build order

```text
U1  shared identity + structured capture   deps: —
    establishes: live capture yields one exact identity and a complete versioned ordered-turn sequence; O1/O2/O4/O7 are executable
    checkpoint: pause — capture one unchanged 100+ turn voice thread three times; hashes and turn identities agree

U2  immutable blobs + live store           deps: U1
    establishes: immutable evidence lands before one atomic live pointer; restart cannot invent or advance incomplete state
    checkpoint: auto — store contract suite with atomic-write and corruption injection

U3  manual track/sync tool slice           deps: U1, U2
    establishes: track → sync → restart → sync works without export/sidebar dependencies; O3/O6 are executable
    checkpoint: pause — live authenticated track/sync/restart rehearsal on one journal source

U4  paginated retrieval + continuation     deps: U3
    establishes: bounded citations retrieve immutable live material and continuation returns to the original key; O5 is executable
    checkpoint: pause — retrieve an old turn, continue by returned key, observe the exchange in the next snapshot

U7  export import + direct verification    deps: U1, U2, U4
    establishes: a human-granted ZIP resumes idempotently through atomic bounded batch+cursor commits; ambiguous branches stay catalog-only; unverified routes fail closed; O8/O9/O10 are executable
    checkpoint: auto — one supported real ZIP fixture crosses the production grant/reader/blob/catalog/service with a deterministic dialog result and real private-filesystem/subprocess crash/replay; hostile real ZIP bytes pass through production reader/service rejection; recovered state is then listed and retrieved through real Electron/HTTP/MCP and Control Center entry points; exact route outcomes and unavailable-is-not-deleted pass at the controller/service contract seams
    deferred acceptance: pause when a user-selected personal export is ready — import and re-import it, retrieve one item without logging content, verify one exact route, and retain the catalog identity/snapshot after one unavailable or failed observation

U6  minimal control + privacy + E2E        deps: U3, U4, U7
    establishes: import scope/result, recovery, catalog route, live source, storage, and local forgetting are user-legible and exercised through real Electron/MCP entry points
    checkpoint: pause — human review of disabled, syncing, partial, suspended, complete, and forget states

U8  sidebar catalog reconciliation         deps: U7, U6       DEFERRED POST-V0
    establishes later: bounded observations can classify first-seen/resurfaced without making title, rank, or absence authoritative
    checkpoint: pause — scan the head, open a known old conversation so it resurfaces, rescan, and observe one resurfaced event with the same catalog identity

U5  opt-in periodic scheduler              deps: U8 and U1/U3 live gates   DEFERRED POST-V0
    establishes later: foreground work wins and every scheduled observation/capture has a visible durable outcome
    checkpoint: pause — multi-hour one-source canary with a concurrent foreground query and a forced restart
```

### Review contract

The approved V0 boundary is U1 → U2 → U3 → U4 → U7 → U6. U8 and U5 remain named so the intended future exists, but a builder must not implement their sidebar or timer contracts in this pass. Approval requires automated contract tests; real-process Electron, HTTP, MCP, private-filesystem, restart, and controlled ZIP acceptance; and live authenticated E2E for manual track/sync/restart, paginated retrieval with exact citations, continuation into the same thread, and local forget. U7 approval composes four explicit proofs: one supported real ZIP fixture traverses the production grant/reader/blob/catalog/service with a deterministic dialog result and real filesystem/subprocess crash recovery and replay; hostile real ZIP bytes exercise production reader/service rejection; recovered imported state is listed and retrieved through real Electron, HTTP, MCP, and Control Center entry points; and exact route promotion, unavailable, failed, and non-deletion outcomes pass controller/service contract tests. These proofs must not be collapsed into a claim that one controlled import traversed every entry point or that an imported route was verified live. The personal real-export import, same-archive re-import, imported-item retrieval, and imported-route verification journey is explicitly deferred until the user has an export ready; its absence is recorded as unverified follow-up evidence, not a V0 blocker and never a passed check. A missing authenticated ChatGPT profile remains a human-input blocker for the live path.
