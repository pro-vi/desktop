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

Agentify gains a Transcript Library with a deliberately small live core and an export-backed historical catalog. Talking with a coding agent through MCP is the primary workflow: the agent can track an open ChatGPT conversation, capture it as immutable ordered turns, retrieve and cite it, continue it in the original thread, and administer imported history. The Control Center remains an optional tested fallback. A downloaded ChatGPT export can bootstrap older conversations without making undocumented export JSON or sidebar markup prerequisites for the live loop; the agent opens the same native desktop picker used by the fallback UI, and only the human can select the ZIP.

The decision is to ship the controllable live path first, then import exports through a recoverable evidence pipeline: immutable raw and normalized blobs are staged idempotently, and one bounded catalog commit makes a contiguous group of conversations visible while advancing its import cursor. Canonical identity is profile scope plus provider conversation ID; titles and navigation position are observations only. We reject the earlier cross-store attach sequence because a crash could split catalog and transcript state, and we defer sidebar crawling and timers because they are the least stable provider boundaries.

Not in V0: automating the export request/email download, sidebar discovery, periodic synchronization, deletion inference, psychological classification, embeddings, or audio-file archiving. The later U8 sidebar unit and U5 scheduler remain in the build order but have no premature signatures in this program. `[Assumed]` Local plaintext protected by a `0700` directory and `0600` files is acceptable for V0. `[Verified 2026-08-08]` The authorized long-thread gate reported 416 total turns across three complete captures with normalization version 1 and stable content hash `c2dfe4656d729cc29dfd5b823767c1e38e0a773c606b24b4b30276dd75d8d129`; acceptance retrieved two pages with stable citations, and the runner produced no transcript-content output. `[Approved decision 2026-08-08]` The product owner changed U6's fallback-UI checkpoint from pause to auto because MCP is the primary workflow; this changes the approval gate and does not claim that a human visual review passed. `[Deferred]` Personal real-export acceptance is postponed until the user has an export ready. U7 remains in V0: exact MCP contract tests must prove that the selected-import tool requests the authenticated Electron grant endpoint and immediately consumes the returned one-use grant without exposing it; one supported real ZIP fixture must traverse the production grant/reader/blob/catalog/service with a deterministic dialog result and a real private-filesystem/subprocess boundary; hostile real ZIP bytes must exercise production reader/service rejection; and recovered catalog state must appear through real Electron, HTTP, MCP, and the optional Control Center fallback. The native OS file choice remains part of the deferred user-selected export rehearsal because it requires a foreground human action. Before that rehearsal, the agent picker needs a bounded human-interaction HTTP lifecycle that cannot leave a consumable orphan grant after caller timeout or disconnect, a one-request in-flight guard, and restoration of any window state changed only to foreground the picker. Exact route outcomes remain contract-tested at the controller/service seams without claiming that a personal export or imported route was exercised live. Automated renderer and real-process checks prove the fallback UI; human pixel review is optional evidence rather than a V0 approval gate. `[Deferred lease recovery]` V0 does not expose the content-free retained-lease snapshot to an operator, and tab close does not yet identify the owning operation and call `releaseAll`; a timed-out provider promise that never settles can therefore require process restart. `[Deferred alias coverage]` Serialization is key/tab-level only: two pre-existing keys or tabs already bound to the same provider conversation do not share a conversation-ID lease. Both lease gaps must close before U5 can introduce concurrent periodic work. `[Deferred read-route disclosure]` `/read-page` and `/read-conversation` already return content-free 409 `tab_busy` for a conflicting owner, but README and the `agentify_read_page`/`agentify_read_conversation` descriptions do not yet tell an agent to wait and retry. `[Open]` A later personal-export rehearsal must report the available identity, account-hint, and active-branch evidence without inventing missing account metadata.

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
+   | 'conversation_leading_turn_missing'
+   | 'conversation_scroll_stalled'
+   | 'conversation_capture_timeout'
+   | 'conversation_generation_active'
+   | 'conversation_capture_limit_reached'
+   | 'max_capture_bytes'
+   | 'conversation_message_text_unavailable'
+   | 'ambiguous_message_overlap'
+   | 'compatibility_drift'
+
+ type ConversationCapture =
+   | { status: 'complete'; conversationUrl: CanonicalConversationUrl; capturedAt: ISODateTime; rawTurns: RawTranscriptTurn[]; evidence: CaptureEvidence }
+   | { status: 'partial'; reason: CaptureReason; conversationUrl: CanonicalConversationUrl | null; capturedAt: ISODateTime; rawTurns: RawTranscriptTurn[]; evidence: CaptureEvidence }
    // discharges O1: completeness and its failures are one closed discriminated union
    // contract: a structurally valid served mapped message with no transcript text remains partial without being classified as provider compatibility drift
    // contract: a fully served conversation of four or more mapped messages whose every mapped message lacks transcript text is drift; below four, a legitimate short image-only thread remains representable as unavailable text
    // contract: a capture that quiets at the top of the served thread keeps evidence.topBoundary true even when that head is an assistant turn, and reports conversation_leading_turn_missing rather than conversation_top_not_reached, so a proven boundary is never denied to signal a missing turn 1
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
+   settleReplacement(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<void>
+   readPrivateFile(path: AbsolutePath, opts: { boundaryPath: AbsolutePath; maxBytes: number }): Promise<Uint8Array>
+   settleImmutable(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<void>
+   pathKind(path: AbsolutePath, opts: { boundaryPath: AbsolutePath }): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'>
+ }
    // contract: S1/S2/S10 share one real and failure-injectable filesystem boundary
    // post: directories are 0700, files are 0600, writes are fsynced, and paths remain below an exact non-symlink boundary
    // post: settleReplacement validates a single-link 0600 regular final file below that boundary and fsyncs its containing directory; callers still reload and parse the bytes before clearing uncertainty
    // threat boundary: rejects escapes and pre-existing symlinks; V0 trusts the owning OS user and does not defend against a same-user process racing files inside the owner-only state directory
    // errors: link, mode, confinement, size, publication, replacement, and uncertain-write failures stay distinct
    // hides: temp names, hard-link publication, directory fsync portability, and platform file APIs
```

```diff
// provider-tab-operation-leases.mjs                  + NEW · U3/U4/U7
+ type ProviderTabOperationScope = `key:${string}` | `tab:${string}` | `vendor:${string}` | `run:${string}`
+ type ProviderTabOperationEvidence = {
+   id: string
+   kind?: string
+   tabId?: string
+   key?: string
+   source?: string
+   phase?: string
+   scope?: ProviderTabOperationScope
+   startedAt?: number
+ }
+ interface ProviderTabOperationLeases {                         // seam S14
+   assertAvailable(scope: ProviderTabOperationScope, ownerId?: string | null): void
+   current(scope: ProviderTabOperationScope): ProviderTabOperationEvidence | null
+   currentOwnerId(): string | null
+   reserve(scope: ProviderTabOperationScope, operation: ProviderTabOperationEvidence): boolean
+   release(scope: ProviderTabOperationScope, expectedId?: string | null): boolean
+   releaseAll(operationId: string): ProviderTabOperationScope[]
+   runWithOwner<T>(operationId: string, operation: () => Promise<T>): Promise<T>
+   snapshot(): Array<{ scope: ProviderTabOperationScope; operation: ProviderTabOperationEvidence }>
+ }
+ createProviderTabOperationLeases(): ProviderTabOperationLeases
    // contract: one process-wide production authority arbitrates the request-derived, advisory-tab, and resolved-tab scopes acquired by the named HTTP operations and by library sync/verification; it does not infer conversation-ID aliases
    // contract: only the ambient async owner may re-enter; post-query sync retains the query owner, while unrelated nested work cannot borrow it
    // contract: a timed-out provider operation keeps its leases until that exact operation settles; lexical owners release only their own aliases
    // errors: busy evidence contains identifiers, aliases, phase, and time only; never prompts, transcript text, DOM, paths, credentials, or journal content
    // deferred recovery: snapshot() is not exposed through runtime status, and tab close does not yet identify the owning operation and call releaseAll(operationId); a provider promise that never settles can retain aliases until process restart
    // deferred alias coverage: no conversation:<providerConversationId> scope exists, so distinct pre-existing key/tab bindings to the same provider conversation remain outside V0 serialization
    // hides: AsyncLocalStorage propagation, alias-map ordering, and cleanup bookkeeping
```

```diff
// chatgpt-controller.mjs                             ~ MODIFIED · U1
- readConversationText({ maxChars }): Promise<LegacyConversationText>
+ captureConversation({ maxCaptureBytes }): Promise<ConversationCapture>
    // pre: active page is an owned canonical ChatGPT conversation and controller mutex is held
    // post: complete requires generation inactive before and after capture, both transcript boundaries, and passing overlap/order/gap checks; orderedWindowStitching is their derived summary flag
    // post: one provider turn container may contain multiple exact messages; preserve served DOM order + provider IDs, and fail partial on conflicting duplicates or reorder
    // post: a numeric provider-turn gap is accepted only after a bounded overlapping served-range scan observes no mapped message there; empty or malformed mapped input still fails partial
    // errors: provider transport rejects; representable incomplete states return PartialCapture
    // hides: selectors, virtualization, scroll strategy, and overlap matching

+ readConversationText({ maxChars }): Promise<LegacyConversationText>
    // post: legacy text is rendered from the same structured window-capture primitive, without adopting the library capture's canonical-route or compatibility-capability preconditions
    // errors: preserves the existing public error surface and closed legacy reason vocabulary
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
    // post: every begun attempt reaches one durable terminal outcome in-process or through startup recovery; uncertain replacements are reconciled from durable bytes before later operations
    // post: retain every open attempt plus at most 64 terminal attempts per active or forgotten source; an internal predecessor snapshot preserves latest/change semantics across compaction
    // deferred: tombstone count itself remains unbounded in V0; docs/plans/2026-08-02-transcript-tombstone-retention-follow-up.md owns the separate restore-safe storage redesign
    // errors: not-found, duplicate identity (`transcript_source_exists`), duplicate key (`transcript_source_key_exists`), disabled, corrupt-state, and IO have stable symbolic codes
    // hides: source index, write queue, blob placement, and recoverable deletion mechanism
```

```diff
// transcript-sync.mjs                                + NEW · U3
+ createChatGptTranscriptCapture({ tabs, providerTabOperations: ProviderTabOperationLeases }): TranscriptCapturePort
+ createTranscriptSyncService({ store, blobs, capture, providerTabOperations: ProviderTabOperationLeases, onChanged? }): TranscriptSyncService
+ interface TranscriptCapturePort {                              // seam S3
+   captureOwnedSource(source: TranscriptSource): Promise<ConversationCapture>
+ }
    // pre: source owns an exact canonical location
    // post: navigation and capture share one controller-exclusive operation while one shared lease owner holds the source key and every known physical-tab alias
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
    // post: live capturedAt is the capture time; imported capturedAt is the durable local CatalogImport.createdAt, while untrusted provider timestamps remain only in immutable raw archive evidence
    // post: every published turn is retrievable whole within TRANSCRIPT_PAGE_MAX_TEXT_CHARS; pagination never strands latest state
    // errors: unknown identity, no complete snapshot, corrupt blob, cursor mismatch, and page limit are distinct
    // hides: origin-selection query, Markdown rendering, local paths by default, and future search/indexing
```

```diff
// conversation-catalog-contract.mjs                  + NEW · U7
+ const MAX_CATALOG_IMPORT_RECORDS = 20_000
+ parseImportCapacity(value: unknown): ImportCapacity
+ parseCatalogTitle(value: unknown): string | null
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
+ type ImportCapacity = { recordCount: number }
+ type StoredImportCapacity = ImportCapacity | null // migrated V1 only: terminal/read-only, or suspended until complete preflight reserves V2 capacity
+ type CatalogImportReadOnlyReason = 'legacy-record-limit'
+ type CatalogImport = { /* existing fields */ readOnlyReason: CatalogImportReadOnlyReason | null }
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
    // deferred before personal-export rehearsal: bound the human picker HTTP lifecycle without orphaning a later grant after caller timeout/disconnect, reject a second concurrent agent picker, and restore only the window state changed to foreground the picker
    // hides: absolute path, bookmark implementation, and Electron dialog details
```

```diff
// chatgpt-export-reader.mjs                           + NEW · U7
+ interface ChatGptExportReader {                                // seam S9
+   inspect(archive: GrantedArchive): Promise<ExportManifest>
+   streamConversations(archive: GrantedArchive, scope: ChatGptProfileScopeId, cursor?: ImportCursor): AsyncIterable<DecodedArchiveConversation>
+ }
    // pre: archive came from a grant; entry count, expanded bytes, depth, compression ratio, and conversation count (20,000 maximum) are bounded independently from the 10,000-problem outcome limit; a maximum-shape import fits an otherwise empty atomic catalog
    // post: one conversations.json or numbered conversation JSON files stream without whole-archive buffering
    // errors: zip-slip, expansion bomb, corrupt JSON, unsupported layout, and record decode stay distinguishable
    // hides: ZIP library, streaming parser, undocumented fields, and future adapters
```

```diff
// conversation-catalog-store.mjs                     + NEW · U7
+ const CONVERSATION_CATALOG_STORE_SCHEMA_VERSION = 2
+ interface ConversationCatalogStore extends ImportedConversationIndex { // seam S10
+   beginImport(manifest: ExportManifest, assignment: ProfileScopeAssignment, capacity: ImportCapacity): Promise<CatalogImport>
+   commitPreparedRecords(importId: CatalogImportId, records: PreparedArchiveCommit[], nextCursor: ImportCursor): Promise<ImportBatchResult>
+   finishImport(importId: CatalogImportId, outcome: ExportImportOutcome): Promise<CatalogImport>
+   recoverInterruptedImports(): Promise<RecoveredImport[]>
+   interruptImport(importId: CatalogImportId): Promise<CatalogImport>
+   terminalizeLegacyOverLimit(manifest: ExportManifest, profileScopeId: ChatGptProfileScopeId): Promise<CatalogImport | null>
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
    // post: startup converts every current or within-ceiling legacy open import to visible resumable partial state; replay creates no duplicate identity/snapshot
    // post: begin/reopen atomically reserves a conservative final catalog projection against existing state; every mutation preserves it through interruption and restart recovery until terminal finish clears it
    // post: legacy V1 identity/raw/snapshot evidence loads without data loss; an old-valid ill-formed optional title migrates to null, and compact V2 encoding supplies migration headroom without raising the 64 MiB ceiling
    // post: a within-ceiling legacy row keeps an explicit missing reservation until complete archive preflight acquires V2 capacity; an over-limit legacy open/suspended row or exact matching archive preflight becomes terminal read-only with readOnlyReason 'legacy-record-limit' (complete stays complete; every non-complete row becomes partial)
    // post: read-only legacy history preserves committed evidence and is never offered as resumable or reassignable
    // errors: insufficient local catalog capacity rejects before a new import becomes visible; a reserved import cannot strand its cursor at the metadata ceiling; a suspended legacy row without preflight or an over-limit legacy row fails with stable catalog_import_capacity_required
    // errors: scope conflict, identity conflict, corrupt state, and IO are explicit; title/time matching is defined out
    // hides: metadata index, bounded batch sizing, orphan-blob collection, account-hint comparison, and event compaction
```

```diff
// conversation-catalog-sync.mjs                      + NEW · U7
+ createChatGptRouteVerifier({ tabs, providerTabOperations: ProviderTabOperationLeases, navigationTimeoutMs? }): ConversationRouteVerificationPort
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
+ ChatGPTController.quarantineExclusiveUntil(operation: Promise<unknown>): void
+   // pre: a host deadline expired while provider work still owns the controller operation
+   // post: later exclusive work fails busy until that exact operation settles; releasing the mutex cannot expose a late navigation to another query/sync/verification
+   // errors: quarantine never destroys the shared tab or cancels provider work by crashing its renderer/target
+   // hides: promise settlement tracking and controller-local quarantine state
+
+ interface ConversationRouteVerificationPort {                  // seam S11
+   verify(identity: ConversationIdentity, key: string): Promise<RouteVerificationOutcome>
+ }
    // pre: identity belongs to the selected authenticated local profile scope
    // post: verified requires a stable exact route, exact parsed provider ID, clear protective-state checks around inspection, a served-conversation observation, and shared key/tab leases retained until any timed-out provider operation settles; composer readiness alone is insufficient
    // errors: negative provider observations are not deletion; local tab acquisition, challenge, login, and transport failures do not mutate route state
    // hides: URL construction, redirects, HTTP/UI evidence, and browser backend

+ interface ConversationCatalogService {                         // seam S12
+   importExport(request: ImportExportRequest): Promise<ExportImportOutcome>
+   verifyByNavigation(identity: ConversationIdentity, key: string): Promise<RouteVerificationOutcome>
+   reassignImportScope(input: ReassignScopeInput): Promise<ScopeReassignmentResult>
+   list(request: ListCatalogRequest): Promise<CatalogPage>
+   listImports(): Promise<CatalogImport[]>
+ }
    // pre: import consumes a human grant; comparable account hints must agree only when a stable profile-hint port is explicitly injected and both sides expose a value
    // post: raw/snapshot blobs stage first, then one bounded catalog commit publishes a contiguous batch + cursor; interrupted imports resume
    // errors: outcome unions cross HTTP/MCP unchanged; paths, raw records, and transcript bodies never enter errors
    // hides: batch assembly, decoder versions, route retry policy, and provider automation
```

```diff
// library-http-errors.mjs                           + NEW · U3/U4/U7 · seam S13
+ transcriptHttpStatusForErrorCode(code: unknown): 400 | 404 | 409 | 413 | 500 | null
+ catalogHttpStatusForErrorCode(code: unknown): 400 | 404 | 409 | 413 | 500 | null
+ isSafeLibraryHttpErrorCode(code: unknown): boolean
    // contract: loopback HTTP and MCP consume one allowlisted symbolic-error authority
    // post: every explicitly allowlisted HTTP-boundary code has one stable status; unknown/private errors fail closed
    // hides: entry-point response shaping and private exception text
```

```diff
// http-api.mjs                                       ~ MODIFIED · U3/U4/U7
+ type CatalogImportSummary = {
+   schemaVersion: 1
+   importId: CatalogImportId
+   profileScopeId: ChatGptProfileScopeId
+   status: 'open' | 'complete' | 'partial'
+   readOnlyReason: CatalogImportReadOnlyReason | null
+   cursor: ImportCursor
+   counts: ImportCounts
+   suspension: { reason: 'interrupted' | 'scope-reassigned'; observedAt: ISODateTime } | null
+   createdAt: ISODateTime
+   updatedAt: ISODateTime
+ }
+ type CatalogImportSummaryPage = { items: CatalogImportSummary[]; truncated: boolean } // 100 most recently updated imports
+ POST /catalog/export-grant -> 200 ExportGrantOutcome
+ POST /catalog/import       -> 200 ExportImportOutcome
+ POST /catalog/verify       -> 200 RouteVerificationOutcome
+ POST /catalog/reassign     -> 200 ScopeReassignmentResult
+ GET  /catalog/imports      -> 200 CatalogImportSummaryPage
+ GET  /catalog/list         -> 200 CatalogPage
+ POST /transcripts/track    -> 200 TranscriptSource
+ POST /transcripts/sync     -> 200 SyncResult
+ GET  /transcripts/list     -> 200 TranscriptSourceSummary[]
+ POST /transcripts/get      -> 200 TranscriptPage
+ POST /transcripts/forget   -> 200 RecoverableDeletion
    // pre: loopback bearer authentication is already satisfied
    // post: request/response bodies round-trip exact contracts; import administration returns at most the 100 most recently updated content-free summaries and reports truncation
    // post: /transcripts/track, /navigate, /research, /query, /send, /read-page, /read-conversation, /runs/open, and /runs/retry reserve their request-derived scope plus any already-listed advisory-tab aliases before tab resolution, then reserve the resolved tab's current key/tab aliases before controller work; /transcripts/sync and /catalog/verify acquire their aliases inside the injected services
    // errors: identifiers and symbolic reasons only; never granted paths, raw records, transcript bodies, or DOM; /read-page and /read-conversation return 409 'tab_busy' when a conflicting request/advisory/resolved alias is owned, which means wait and retry rather than content unavailable
    // hides: storage paths unless explicitly requested by the authenticated caller
```

```diff
// mcp-server.mjs                                     ~ MODIFIED · U3/U4/U7
+ type TranscriptSourceSummaryPage = { count: number; sources: TranscriptSourceSummary[] }
+ agentify_import_selected_chatgpt_export(profileScopeId: string): ExportImportOutcome | { status: 'cancelled' }
+ agentify_import_chatgpt_export(grantId: string, profileScopeId: string): ExportImportOutcome
+ agentify_list_chatgpt_imports(): CatalogImportSummaryPage
+ agentify_reassign_chatgpt_import(importId: string, newProfileScopeId: string, confirm: true): ScopeReassignmentResult
+ agentify_verify_catalog_conversation(identity: ConversationIdentity, key: string): RouteVerificationOutcome
+ agentify_list_chatgpt_catalog(request: ListCatalogRequest): CatalogPage
+ agentify_track_transcript(input: TrackTranscriptInput): TranscriptSourceSummary
+ agentify_sync_transcript(sourceId: string): SyncResult
+ agentify_list_transcripts(): TranscriptSourceSummaryPage
+ agentify_get_transcript(request: GetTranscriptRequest): TranscriptPage
+ agentify_forget_transcript(sourceId: string, confirm: true): RecoverableDeletion
    // post: MCP text is bounded/paginated; structuredContent preserves exact metadata; import administration omits archive paths, transcript bodies, raw records, and account hints
    // errors: unknown HTTP variants fail closed instead of string coercion
    // deferred disclosure: README and the agentify_read_page/agentify_read_conversation descriptions still need to explain that HTTP 409 tab_busy means a conflicting owner is active and the agent should wait/retry
    // hides: bearer transport, storage layout, granted path, and entire-transcript response size
```

```diff
// main.mjs — composition root                        ~ MODIFIED · U2/U3/U4/U7
+ const blobs = createPrivateLibraryBlobStore({ stateDir, fileSystem: privateFileSystem })                 // S1
+ const transcriptStore = createTranscriptStore({ stateDir, blobs, fileSystem: privateFileSystem })        // S2
+ const catalogStore = createConversationCatalogStore({ stateDir, blobs, fileSystem: privateFileSystem })  // S10/S5
+ const libraryStartup = await recoverTranscriptLibraryStartup({ transcriptStore, catalogStore })
+   // recover each store independently; Electron/HTTP still start and expose content-free unavailable status if one library store cannot recover
+ const providerTabOperations = createProviderTabOperationLeases()                                 // S14
+ const capture = createChatGptTranscriptCapture({ tabs, providerTabOperations })                   // S3
+ const routeVerifier = createChatGptRouteVerifier({ tabs, providerTabOperations })                 // S11
+ const grants = createElectronExportImportGrants({ dialog })                                      // S8
+ const requestExportGrant = ({ profileScopeId, browserWindow? }) => grants.request({ profileScopeId, browserWindow })
+ const exportReader = createChatGptExportReader()                                                  // S9
+ const transcriptSync = createTranscriptSyncService({ store: transcriptStore, blobs, capture, providerTabOperations, onChanged: emitLibraryChanged })
+ const transcriptRead = createTranscriptReadService({ sources: transcriptStore, imported: catalogStore, blobs })
+ const catalogSync = createConversationCatalogService({ store: catalogStore, blobs, grants, exportReader, routeVerifier, onChanged: emitLibraryChanged })
+ server = startHttpApi({ ..., transcriptSync, transcriptRead, catalogSync, requestExportGrant, providerTabOperations })
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
+     controller.runExclusive(...)
+       servedUrl = controller.getUrl()
+       parseChatGptEntryTarget(servedUrl)
+         guard target.kind === 'canonical-conversation' -> 409 'owned_conversation_required'
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
+       reserve key:<source.key> in ProviderTabOperationLeases before beginning durable work
+       runWithOwner(syncOperationId)
+       TranscriptStore.beginAttempt(sourceId, 'manual')
+       TranscriptCapturePort.captureOwnedSource(source)
+         re-enter the owned key lease and reserve every known physical-tab alias
+         controller.runExclusive(...)
+           controller.prepareChatEntry({ chatUrl: source.target.location.chatUrl })
+           controller.captureConversation({ maxCaptureBytes })
+             host deadline expiry -> partial 'conversation_capture_timeout'; quarantine later controller work until the exact renderer evaluation settles
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
+       finally release only aliases acquired by this lexical owner
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
// Read a provider page or conversation without colliding with route work · U4
+ agentify_read_page(...) | agentify_read_conversation(...)
+   POST /read-page | POST /read-conversation
+     requestOperationScopes(body)
+     reserve request-derived scope + aliases for any already-listed advisory tab
+     guard conflicting owner -> 409 'tab_busy'
+       // runtime meaning is wait/retry, not content unavailable; README and MCP tool descriptions do not disclose that yet
+     resolveTab(...)
+     reserve resolved tab:<id> + its current key:<key> before controller work
+     guard conflicting owner -> 409 'tab_busy'
+     controller.runExclusive(...)
+       read-page may restore one persisted canonical route before reading
+       read-conversation may navigate read-only to one supplied exact route before structured capture
+     finally release only aliases acquired by this read owner
```

```diff
// Continue a live-bound conversation · U4
+ agentify_get_transcript({ identity })
+   returns { liveSourceId, sourceKey, conversationUrl, ... }
+ guard liveSourceId && sourceKey && conversationUrl -> 409 'conversation-not-live-bound'
+ agentify_query({ liveSourceId, key: sourceKey, chatUrl: conversationUrl, prompt })
+   POST /query
+     when liveSourceId is present, require the exact all-or-none liveSourceId + key + canonical chatUrl trio
+     reject competing tabId, model, vendorId, projectUrl, imageGeneration, or query-string tab selectors
+     before tab/run/provider work:
+       transcriptSync.list()
+       guard exactly one enabled source agrees on source ID, key, source identity, target identity, and requested URL identity
+         -> 409 'conversation-not-live-bound'
+     existing durable query lifecycle
+     reserve the requested key plus advisory/resolved physical-tab and listed-key aliases, then run the lifecycle under that operation owner
+     inside the same controller lock, after navigation and before provider send:
+       guard exact source/request/served provider-ID agreement -> 409 'conversation-not-live-bound'
+       after receipt-backed send, capture the served URL before releasing that lock
+       validate the captured URL before persisting durable affinity
+     persist liveSourceId in the durable logical request; /runs/retry repeats both guards before provider send
+     on receipt-backed canonical success:
+       transcriptSync.sync(liveSourceId, 'post-query')
+         // the ambient query owner re-enters its key/tab leases; the same typed sync primitive creates no second transcript authority
+     finally release every query alias only after post-query sync settles
+   // generic queries without liveSourceId retain the existing non-library behavior
```

```diff
// Agent-first historical bootstrap with optional Control Center fallback · U7
+ coding agent calls agentify_import_selected_chatgpt_export({ profileScopeId })
+   POST /catalog/export-grant
+     desktop.showOpenDialog({ extensions: ['zip'] })
+     human selects one ZIP; cancel returns without importing
+     ExportImportGrantPort -> one-use grantId kept inside the MCP/HTTP call chain, never returned to the agent
+     // deferred before personal-export rehearsal: bound the human wait without orphaning a later grant after caller timeout/disconnect; reject a second in-flight agent picker; restore window visibility/minimized/focus state changed only for this dialog
+ optional fallback: Control Center "Import ChatGPT export…" calls the same ExportImportGrantPort
+   POST /catalog/import with the internal grantId
+       grants.consume(grantId, profileScopeId)
+       exportReader.inspect(archive)
+         guard archive limits -> rejected 'unsafe-archive'
+         guard supported JSON layout -> rejected 'unsupported-export'
+         if an injected stable profile hint and export accountHint are both present and conflict -> rejected 'account-hint-conflict'
+       importCapacity = complete preflight { recordCount }
+         exact record-limit refusal after manifest -> catalogStore.terminalizeLegacyOverLimit(manifest, profileScopeId)
+           only an exact same-archive/same-scope capacity-less V1 row becomes terminal read-only; current imports and nonmatches do not mutate
+         return rejected 'unsafe-archive'
+       catalogStore.beginImport(manifest, assignment, importCapacity)
+         atomically reserve a conservative maximum final projection against the current catalog
+         reject before visibility when the remaining 64 MiB metadata capacity is insufficient
+       importObservedAt = catalogImport.createdAt // durable local receipt time, reused on resume/replay
+       preparedBatch = [] // bounded by record count before any catalog write
+       for await decoded of exportReader.streamConversations(...):
+         rawRef = blobs.putRaw(decoded.rawRecord)
+         snapshotRef = decoded.status === 'complete'
+           ? blobs.putSnapshot(makeImportedSnapshot(normalizeArchiveConversation(decoded), { capturedAt: importObservedAt }))
+           : null
+         prepared = { identity, title, rawRef, snapshotRef, problem, observedAt: importObservedAt }
+         preparedBatch.push(prepared)
+         when batch bound reached or stream ends:
+           catalogStore.commitPreparedRecords(importId, preparedBatch, nextCursor)
+             atomically publish the contiguous batch + cursor
+             // crash before commit leaves only safe immutable orphans; replay is idempotent
+       catalogStore.finishImport(importId, complete|partial)
+       on stream/decode/store error, or a final-status error not already durable:
+         catalogStore.interruptImport(importId)
+           retain the reservation and publish visible resumable partial state without advancing beyond the committed cursor
+         throw 'catalog_import_interrupted'
+       applied-but-uncertain final status -> reconcile exact durable terminal outcome and return it
```

```diff
// Interrupted import recovery · U7
+ app startup
+   recoverTranscriptLibraryStartup({ transcriptStore, catalogStore })
+     catch transcript and catalog recovery independently
+     each current/within-ceiling open import -> visible partial outcome + durable resume cursor when catalog recovery succeeds
+     each legacy open/suspended import already holding >20,000 committed records -> terminal read-only partial outcome preserving its evidence
+     a shorter legacy prefix becomes read-only only when exact same-archive/same-scope preflight proves the archive exceeds the ceiling
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
+       reserve key:<key> and every known physical-tab alias under a fresh non-reentrant verification owner
+       bound the whole controller-exclusive verification by navigationTimeoutMs
+       force a replacement document at the exact claimed owned URL under selected authenticated profile
+       require an explicit non-blocked challenge observation
+       controller.inspectConversationRoute()
+         map-owned visible role-bearing provider turn -> served
+         retained route + generic composer/error shell -> unavailable
+       require another explicit non-blocked challenge observation
+       stable served owned route + exact provider ID -> verified
+       not-found/forbidden/foreign-profile -> unavailable observation
+       local tab acquisition/login/challenge/transport -> failed; no route mutation
+       host deadline expiry -> failed 'transport'; quarantine later controller work and retain every lease until the timed-out provider operation settles, then release without route mutation
+     verified -> catalogStore.verifyRoute(identity, result)
+     unavailable -> catalogStore.observeUnavailable(identity, observation)
+       // availability observation is not deletion and may be retried
```

```diff
// Explicit local forgetting · U3/U6
+ agentify_forget_transcript({ sourceId, confirm: true })
+   POST /transcripts/forget
+     guard confirm === true -> 400 'transcript_confirmation_required'
+     guard no active attempt -> 409 'transcript_sync_active'
+     transcriptSync.forget(sourceId)
+       TranscriptStore.forget(sourceId)
+         remove source from active index atomically
+         append a logical tombstone containing the retained bounded attempt history; no files move and V0 exposes no restore action
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
+ provider-tab-operation-leases.mjs                NEW       shared key/tab operation ownership          U3/U4/U7
+ transcript-sync.mjs                              NEW       manual/post-query orchestration             U3
+ transcript-read.mjs                              NEW       live/import selection + pagination          U4/U7
+ conversation-catalog-contract.mjs                NEW       import/catalog/route outcomes               U7
+ conversation-catalog-store.mjs                   NEW       atomic batch+cursor catalog commits         U7
+ conversation-catalog-sync.mjs                    NEW       import + direct verification authority      U7
+ export-import-grants.mjs                         NEW       human one-use desktop archive grants        U7
+ chatgpt-export-reader.mjs                         NEW       safe streaming export decoder               U7
+ library-http-errors.mjs                           NEW       shared safe HTTP/MCP error authority         U3/U4/U7
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
+ library-startup.mjs                              NEW       isolated best-effort library recovery        U2/U7
~ ui/preload.cjs                                  MODIFIED  import/catalog/transcript IPC mirror         U6/U7
~ ui/preload.mjs                                  MODIFIED  import/catalog/transcript IPC mirror         U6/U7
~ ui/control-center.html                          MODIFIED  optional ZIP + diagnostic/recovery fallback U6/U7
~ ui/control-center.js                            MODIFIED  fallback import/verify/source actions        U6/U7
~ ui/control-center.css                           MODIFIED  fallback import/catalog/sync states          U6/U7
~ README.md                                       MODIFIED  agent workflow, privacy, reload, recovery    U4/U6/U7
~ package.json                                    MODIFIED  Electron/electron-builder build dependencies U6
~ package-lock.json                               MODIFIED  package dependency metadata                 U6
+ scripts/e2e-transcript-library.mjs               NEW       real Electron/MCP acceptance runner          U6/U7
+ scripts/visual-proof-transcript-library.mjs      NEW       deterministic fallback visual regression     U6/U7
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
+ tests/provider-tab-operation-leases.test.mjs     NEW       alias ownership/re-entry/cleanup            U3/U4/U7
+ tests/library-startup.test.mjs                    NEW       isolated recovery/startup availability      U2/U7
+ tests/transcript-sync.test.mjs                   NEW       manual/post-query lifecycle                 U3
+ tests/transcript-read.test.mjs                   NEW       live/import selection + citations           U4/U7
+ tests/export-import-grants.test.mjs              NEW       one-use picker and file identity             U7
+ tests/chatgpt-export-reader.test.mjs             NEW       format, branch, and hostile ZIP fixtures    U7
+ tests/conversation-catalog-store.test.mjs        NEW       atomic cursor/replay/recovery               U7
+ tests/conversation-catalog-sync.test.mjs         NEW       import + route verification                 U7
+ tests/conversation-route-verifier.test.mjs       NEW       exact direct-navigation outcomes            U7
+ tests/control-center-transcript-library.test.mjs NEW       fallback renderer states and action guards  U6/U7
+ tests/transcript-library-reporter-redaction.test.mjs NEW   acceptance output privacy boundary          U6/U7
+ tests/transcript-library-visual-proof.test.mjs  NEW       fallback visual regression contract         U6/U7
+ tests/fixtures/transcript-library-crash-child.mjs NEW      import subprocess crash/recovery            U7
+ tests/fixtures/transcript-library-visual-proof-main.cjs NEW real fallback renderer proof process       U6/U7
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
| **S7** | Browser DOM/virtualization | `ChatGPTController.captureConversation()` | VM-backed virtualized DOM plus none — live e2e | repeated turns, compound same-container messages, proven non-message provider gaps, delayed boundaries, overlap/order/gap outcomes, and stable normalized hash; `orderedWindowStitching` is their derived summary flag, not independent evidence |
| **S8** | `ExportImportGrantPort` | `createElectronExportImportGrants()` injected into the authenticated HTTP picker route, catalog service, and Control Center IPC | one-use grants with cancelled/expired/reused/moved variants | human selection, path confinement, scope confirmation, no path leakage |
| **S9** | `ChatGptExportReader` | `createConversationCatalogService({ exportReader })` | single/numbered JSON, ambiguous graph, zip-slip, expansion-bomb fixtures | independently bounded 20,000 records/10,000 problems; exact decode; hostile archive rejection; maximum-shape archive fits an empty atomic catalog and supplies its exact record-count reservation |
| **S10** | `ConversationCatalogStore` | catalog service constructor and read-service imported index | real private filesystem plus failure-injecting atomic writer/subprocess | bounded batch+cursor atomicity; replay idempotence; capacity reserved against existing metadata through interruption/restart; no fuzzy identity |
| **S11** | `ConversationRouteVerificationPort` | catalog service constructor plus map-owned served-conversation inspection | verified/unavailable/failed scripted outcomes plus retained-route error shell and live e2e | exact promotion requires stable route + provider ID + visible provider turn; transient failure non-mutation; unavailable-is-not-deleted |
| **S12** | `ConversationCatalogService` | injected into HTTP/MCP handlers | in-memory service implementing exact import/verify variants | shared verification-key schema; protocol mapping; conditional injected account-hint gate; sensitive-error redaction |
| **S13** | `library-http-errors` | imported by loopback HTTP and MCP response handling | real authenticated HTTP routes plus real MCP stdio subprocess | one safe symbolic-code/status authority; inspection/capacity errors retain exact codes; read routes return content-free 409 `tab_busy`; README and MCP wait/retry disclosure remains deferred; unknown/private errors redact |
| **S14** | `ProviderTabOperationLeases` | one instance created in `main.mjs` and injected into HTTP, transcript sync/capture, and route verification | real HTTP context-packing races plus service-level foreign-owner and ambient-owner tests | named HTTP operations reserve request/advisory aliases before tab resolution and resolved key/tab aliases before controller work; sync/verification acquire inside their services; post-query sync alone re-enters; timeout ownership and busy evidence are content-free; conversation-ID aliases plus retained-lease snapshot/tab-close recovery remain explicitly deferred |

## 5. Build order

```text
U1  shared identity + structured capture   deps: —
    establishes: live capture yields one exact identity and a complete versioned ordered-turn sequence; O1/O2/O4/O7 are executable
    checkpoint: VERIFIED 2026-08-08 — one authorized thread reported totalTurns=416 across three complete captures with normalizationVersion=1 and stable contentHash c2dfe4656d729cc29dfd5b823767c1e38e0a773c606b24b4b30276dd75d8d129; pagesRetrieved=2, citationsStable=true, and the runner produced no transcript-content output

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
    checkpoint: auto — exact MCP contracts prove that the selected-import tool requests the authenticated Electron grant endpoint and immediately consumes its one-use grant without exposing it; one supported real ZIP fixture crosses the production grant/reader/blob/catalog/service path with a deterministic dialog result and real private-filesystem/subprocess crash/replay; hostile real ZIP bytes pass through production reader/service rejection; recovered state is then listed and retrieved through real Electron/HTTP/MCP and the optional Control Center fallback; exact route outcomes and unavailable-is-not-deleted pass at the controller/service contract seams
    deferred acceptance: pause when a user-selected personal export is ready — first bound picker HTTP wait/disconnect without orphan grants, reject a second in-flight agent picker, and restore picker-only window changes; then invoke the selected-import tool, make the foreground native file choice, import and re-import it, retrieve one item without logging content, verify one exact route, and retain the catalog identity/snapshot after one unavailable or failed observation

U6  agent-first control + fallback UI + privacy + E2E   deps: U3, U4, U7
    establishes: MCP is primary for live transcript work and import administration; the Control Center remains an optional fallback for the same picker, import/recovery state, first-page catalog inspection, source actions, verification, and storage status
    checkpoint: auto — explicit product-owner decision on 2026-08-08 changed this checkpoint from pause to auto because the Control Center is a fallback; exact MCP schemas, renderer/preload contracts, and real-process Electron coverage exercise disabled, syncing, partial, suspended, complete, and forget states; optional human pixel review is extra evidence, and no passed human visual gate is claimed

U8  sidebar catalog reconciliation         deps: U7, U6       DEFERRED POST-V0
    establishes later: bounded observations can classify first-seen/resurfaced without making title, rank, or absence authoritative
    checkpoint: pause — scan the head, open a known old conversation so it resurfaces, rescan, and observe one resurfaced event with the same catalog identity

U5  opt-in periodic scheduler              deps: U8 and U1/U3 live gates   DEFERRED POST-V0
    establishes later: foreground work wins and every scheduled observation/capture has a visible durable outcome
    checkpoint: pause — multi-hour one-source canary with a concurrent foreground query and a forced restart
```

### Review contract

The approved V0 boundary is U1 → U2 → U3 → U4 → U7 → U6. U8 and U5 remain named so the intended future exists, but a builder must not implement their sidebar or timer contracts in this pass. Talking with a coding agent through the `core,library` MCP profiles is the primary user workflow; the Control Center remains a supported optional fallback. The product owner explicitly changed U6 from a pause checkpoint to an automated checkpoint on 2026-08-08; that is an approval decision, not evidence that a human visual review passed. Approval requires automated contract tests; real-process Electron, HTTP, MCP, private-filesystem, restart, controlled ZIP acceptance, renderer/preload fallback coverage; and live authenticated E2E for manual track/sync/restart, paginated retrieval with exact citations, continuation into the same thread, and local forget. The U1 100+ turn gate is verified: an authorized thread reported 416 total turns across three complete normalization-version-1 captures with stable content hash `c2dfe4656d729cc29dfd5b823767c1e38e0a773c606b24b4b30276dd75d8d129`; acceptance retrieved two pages with stable citations, and the runner produced no transcript-content output. U7 approval composes five explicit proofs: the selected-import MCP contract requests the authenticated Electron grant endpoint and immediately consumes its one-use grant without exposing it; one supported real ZIP fixture traverses the production grant/reader/blob/catalog/service with a deterministic dialog result and real filesystem/subprocess crash recovery and replay; hostile real ZIP bytes exercise production reader/service rejection; recovered imported state is listed and retrieved through real Electron, HTTP, MCP, and the optional Control Center fallback; and exact route promotion, unavailable, failed, and non-deletion outcomes pass controller/service contract tests. These proofs must not be collapsed into a claim that one controlled import traversed every entry point, that the native OS panel was automated, or that an imported route was verified live. The foreground native file choice, personal real-export import, same-archive re-import, imported-item retrieval, and imported-route verification journey is explicitly deferred until the user has an export ready; before that rehearsal, picker timeout/disconnect must not orphan a grant, only one agent picker may be in flight, and picker-only window changes must be restored. Its absence is recorded as unverified follow-up evidence, not a V0 blocker and never a passed check. Retained-lease status visibility plus owner-scoped `releaseAll` on tab close, a provider-conversation alias shared by pre-existing key/tab bindings, and README plus MCP wait/retry guidance for read-route 409 `tab_busy` remain deferred; neither lease gap authorizes U5 periodic work. A caller-supplied `--pixel-review` value remains a declaration rather than human evidence, but no human visual attestation is required for V0 approval. A missing authenticated ChatGPT profile remains a human-input blocker for the live path.
