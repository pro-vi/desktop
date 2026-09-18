---
title: Transcript by Default, Pointer-First Results
objective: Every keyed conversation gets a durable local transcript file by default, and query results lead with a pointer to it — agents read and grep the chat like a local file instead of pulling inline payloads.
type: feat
status: active
date: 2026-09-17
origin: conversation 2026-09-17 (the user's "chat as a queryable local file" ideal; three-gaps analysis; confirmation to architect)
---

# Transcript by Default, Pointer-First Results

## Background

The user's stated ideal: the chat script should be a queryable local file an agent reads easily, like a local transcript. Verified at planning time (2026-09-17, two Explore maps, current HEAD `99e5316`):

- The Transcript Library already has the file: `~/.agentify-desktop/transcript-library/blobs/snapshot/sha256/<hh>/<snapshotHash>.json` — canonical JSON of the whole conversation (`turns[]` with `turnId`/`role`/`text`, `contentHash`, identity triple), content-addressed, immutable, deduped; exposed by `agentify_get_transcript includePaths:true` (`transcript-read.mjs:272`). No new format is needed.
- Sources have exactly one creator: `transcriptSync.track()` (MCP `agentify_track_transcript` / HTTP `/transcripts/track`), caller-initiated only. Neither `/query` nor `/read-conversation` ever tracks. Dedup fails closed on duplicate identity (`transcript_source_exists`) or key (`transcript_source_key_exists`) — `transcript-store.mjs:654-657`.
- Post-query sync exists (`syncLiveTranscriptAfterQuery`, `http-api.mjs:1262-1289`, called at 4196/4224 and on retry at 3158/3180) but only when the caller supplied `liveSourceId`; its result (`{source, attempt, status, outcome}`) is **discarded** — nothing reaches the run record or response. In sync mode it currently delays the response while capturing the whole conversation.
- Timing: the run record learns its canonical `conversationUrl` at finalize (`durableRunFinalizeFromOutcome`, http-api.mjs:1895); the sync hook runs after that, with `completed.conversationUrl`, `effectiveKey`, and the finalized run available — everything auto-tracking needs.
- The run record's `outputManifest` is an unvalidated passthrough (`run-store.mjs:150`) that survives the summary projection — the natural home for the transcript pointer. `result.meta.providerMessageId` (shipped 2026-09-17, plan `-001`) already names the answer turn inside the snapshot's `turnId` space.
- The sync capture reuses the query's own tab and key (`transcript-sync.mjs:199-209`, exclusive lease serializes); the capture port re-derives identity from the served URL and fails closed on mismatch (234-242).

Gaps this plan closes, from the conversation's three-gap analysis: **coverage** (every keyed conversation tracked by default), **primacy** (results lead with the pointer), and **stability** (the pointer names the library's stable snapshot file, not `read_conversation`'s per-read uuid export at `http-api.mjs:4704-4711`).

**External review (2026-09-17):** one ChatGPT Pro extended consult (`run 7fc6a9c0-41bb-45b4-8606-99be16771e07`, ~16.5k chars), adjudicated locally against the repo. Adopted: answer-anchored snapshot readiness (a snapshot is *ready* for a run only if it verifiably contains that run's answer turn), persisted `pending` state with restart reconciliation (detached must not mean disposable), one result projection across the three completion paths with a bounded transcript grace wait on blocking paths, model-visible field trimming (hashes and counts stay in the record), and teaching the JSON selector (the condition under which JSON-as-the-file is defensible). Deferred with named triggers: a rendered markdown view, a stable `latest` discovery pointer, and shrinking the 2,000-char preview — each pending observed agent traces. Rejected: renaming `providerMessageId` to `answerMessageId` (drift from the established ADR 0009 vocabulary) and resource-link endpoints (our agents are local-shell clients; paths are the honest contract).

## Requirements

- **R1:** A successful non-image keyed text query on a canonical conversation ensures a tracked Transcript Library source for that conversation — idempotent by identity, with no caller knowledge of `liveSourceId` — and syncs it.
- **R2:** The run record carries a transcript block with an explicit lifecycle (`pending` written synchronously at finalize; `ready` only when the committed snapshot verifiably contains the run's answer turn by `providerMessageId`; `failed`/`not_applicable` otherwise) that lands whether the caller waited or not; stranded `pending` states reconcile after restart; the block never gates success.
- **R3:** All three completion surfaces (sync query, `wait_run`, `get_run`) expose one result projection — `providerMessageId` plus `transcript: {state, snapshotPath?}` — with identical field meanings; blocking paths (sync query, `wait_run`) wait a bounded grace (≤2s, notification-based) for `ready` before returning an explicit `pending`; `get_run` is immediate; model-visible results carry no hashes or counts (those stay in the record).
- **R4:** Existing explicit-`liveSourceId` continuation semantics are unchanged (binding checks, served-route validation, retry replay).

## Naming Ledger

Naming pass: no new or renamed architectural vocabulary. The plan reuses `transcriptSync.track`, `liveSourceId`, `sourceKey`, `snapshotPath`/`snapshotHash`/`contentHash` (blob-store refs), `outputManifest`, `providerMessageId`, and the `post-query` trigger. The pointer block is `outputManifest.transcript` — descriptive composite of existing terms.

## Architecture Decision

**Approach:** Make the existing post-finalize hook the universal path. `syncLiveTranscriptAfterQuery` becomes: resolve the source — explicit `liveSourceId` if supplied, else look up by identity derived from `conversationUrl`, else `track()` it with the query's key (the query's own tab is already sitting on the conversation, satisfying track's existing-tab requirement) — then sync, always detached from the response (including the sync `/query` path, which today blocks on it for tracked callers), and on completion patch the run record's `outputManifest.transcript`. The sync `/query` response and MCP structuredContent carry the cheap synchronous part (resolved `liveSourceId`/`sourceKey`); the snapshot path arrives via the record patch. `runStatusText` gains one `transcript=<path>` line. No new file format, no new MCP tools: the snapshot JSON is the local transcript file; `providerMessageId` is the turn anchor inside it.

**Rationale:** Consistency and simplicity — every mechanism exists and is live-proven (track, post-query sync's durable attempt/publication primitive — proven identical to manual by `tests/transcript-sync.test.mjs:618` — content-addressed publication, run-record patching, `outputManifest` passthrough). The alternative of extending `finalizeQueryOutputs` to await the sync was rejected: the sync captures the whole conversation (scroll passes, seconds) and would sit on every query's critical path; detaching removes the existing tracked-caller latency too, and nothing observable is lost because sync results were already discarded. The alternative of a rendered per-conversation markdown file was rejected: a second representation of the same content is drift surface (representation authority stays the snapshot blob; the per-read uuid export at `/read-conversation` keeps its own purpose).

**Predicate semantics:** source resolution is keyed on the identity triple (`chatgpt/<profileScopeId>/<providerConversationId>`); identity is stable per conversation URL, so equality lookup suffices — no comparator.

**Trade-offs:** the pointer may still be `pending` when the ≤2s grace closes on a blocking path (explicit state, no path, answer artifact fully usable; `get_run` shows it once ready); every successful keyed query now also captures the whole conversation (the cost tracked callers already pay, moved off the response path); a key whose existing source points at a different conversation is never rebound — that query simply records the skip; and this enables selective reading without by itself removing payload — the token win is realized by caller behavior (U5) and must be measured, not assumed.

**Convergence (agent-native posture, per the /cli AXI rubric and the `/agentify` skill's token-efficiency goal):** the MCP surface is an agent-native wrapper — agents are 96% of traffic, and tool descriptions are per-session token cost (the P-SESSION path in `docs/token-cost-paths.md`). Teaching therefore moves to **result time**, where it costs only when relevant: the pointer line and its compact hint ride results; description deltas stay minimal (one clause naming the file, not paragraphs). The pointer block carries precomputed aggregates (`turnCount`, `characterCount`) so callers can judge freshness without a follow-up read; the snapshot path is the composability seam — an agent greps/jqs the local file instead of pulling another inline payload. Pointer-missing states follow the actionable-error discipline: they name the state and the next move, never silence.

**Approval criteria:** a reviewer agrees that (a) extending the existing post-finalize hook is the right seam rather than finalize-time awaits or a new tool, (b) the run record patch with an iff-style presence rule is the honest pointer home, and (c) identity-keyed idempotent tracking with no-key-rebinding preserves the continuation machinery's guarantees.

## Program Obligations

- **O1 (anchored readiness):** `outputManifest.transcript.snapshotPath` is present iff a committed snapshot has been verified to contain this run's answer turn — the run's `meta.providerMessageId` appears among the snapshot's turn identities. Every other state is explicit, never absent-by-silence: `pending`, `failed {reason}`, `not_applicable` (image runs, non-canonical conversations, key-bound-elsewhere skips). The block never gates run success, and an attached snapshot stays attached (the conversation's latest may advance separately).
- **O2 (resolution idempotency):** Source resolution is idempotent on the identity triple: the same conversation queried under the same key resolves to the same `liveSourceId` across queries; an existing source whose key differs from the query's key is reused as-is (never rebound); an existing source with the query's key but a different identity causes a recorded skip, not a rebind and not an error; concurrent resolutions of the same conversation converge (register-exists errors are treated as lookup hits, and the store's atomic persist discipline holds uniqueness).
- **O3 (pending durability):** `transcript.state = 'pending'` is persisted synchronously with the run's finalize — before any detached work — so a crash between finalize and publication leaves a recoverable record, and startup reconciliation re-runs stranded pendings (bounded scan; no queue machinery).

## Implementation Units

### U1. Idempotent source resolution seam

- **Goal:** A `transcriptSync`-level resolution that turns `{key, conversationUrl}` into an existing or newly-tracked source, honoring O2's rules.
- **Requirements:** R1
- **Dependencies:** None
- **Files:**
  - Modify: `transcript-sync.mjs`, `transcript-store.mjs`
  - Test: `tests/transcript-sync.test.mjs`, `tests/transcript-store.test.mjs`
- **Approach:** A store lookup by identity (parseState already enforces uniqueness — surface it) plus a `resolveSource` wrapper around `track()` that returns `{source, created}` for the identity-match and key-match cases and a typed skip outcome (`{status:'skipped', reason:'key-bound-elsewhere'}`) for the collision case. Concurrent-resolution safety: `transcript_source_exists`/`transcript_source_key_exists` from `register` are treated as lookup hits (re-read, return the winner), not errors — the store's revision-checked atomic persist keeps uniqueness honest. No behavior change to explicit `track()`.
- **Patterns to follow:** `requireLiveContinuationBinding`'s single-enabled-source lookup (`http-api.mjs:1188-1260`); `track()` at `transcript-sync.mjs:296-305`.
- **Test scenarios:**
  - *Happy path:* unknown identity + free key → creates (`created: true`), same inputs again → same id (`created: false`).
  - *Edge:* identity exists under a different key → reuses that source, does not touch its key.
  - *Error path:* key exists bound to a different identity → `{status:'skipped', reason:'key-bound-elsewhere'}`; neither source mutates.
- **Verification:** the three scenarios green; `track()` explicit path untouched (existing tests green).
- **Checkpoint:** auto — transcript-sync and transcript-store files green.
- **Runtime evidence:** omit — pure store/service logic with deterministic tests.

### U2. The universal post-query hook: pending at finalize, detached publish, anchored patch

- **Goal:** Every successful non-image keyed text query gets a persisted `pending` transcript state at finalize, publishes its snapshot off the response path, and patches `outputManifest.transcript` to `ready` only when the snapshot verifiably contains the run's answer turn.
- **Requirements:** R1, R2, R4
- **Dependencies:** U1
- **Files:**
  - Modify: `http-api.mjs` (`syncLiveTranscriptAfterQuery` :1262-1289 and its four call sites; the finalize outcome assembly), `run-store.mjs` (patch path for `outputManifest` merge, if the existing finalize patch does not already cover it), `library-startup.mjs` (stranded-pending reconciliation)
  - Test: `tests/http-api.test.mjs`
- **Approach:** Three phases. (1) *Finalize:* the run's finalize outcome writes `outputManifest.transcript = {state: 'pending'}` (or `not_applicable` for image/non-canonical/key-skip cases) synchronously — O3's durability floor. (2) *Publish detached:* resolve the source via U1 (explicit `liveSourceId` wins, binding checks unchanged), run `transcriptSync.sync(sourceId, 'post-query')` detached in all paths (the sync path's inline await at :4224 becomes detached — its result was already discarded). (3) *Anchored patch:* on commit, read the committed snapshot's turn identities and require the run's `meta.providerMessageId` among them before writing `{state:'ready', snapshotPath, snapshotHash, contentHash, turnCount, characterCount}`; otherwise write `{state:'failed', reason:'answer_turn_absent'}`. Non-anchor failures write their closed reason. Startup reconciliation re-runs stranded pendings (bounded scan of recent runs; the `library-startup.mjs` recovery pattern). Errors remain non-fatal to the run.
- **Patterns to follow:** `durableRunPatchFromActive`'s patch shape (`http-api.mjs:1843-1845`); the owner adoption in `transcript-sync.mjs:372-376`; `recoverTranscriptLibraryStartup` (`library-startup.mjs:20-27`) for reconciliation.
- **Test scenarios:**
  - *Happy path:* keyed query → `pending` at finalize → sync commits → snapshot contains `providerMessageId` → patch `ready` with `snapshotPath`; the file exists on disk.
  - *Anchor negative:* sync commits a snapshot lacking the run's answer turn (later-turn or wrong-branch capture) → `failed: answer_turn_absent`, no path printed.
  - *Durability:* crash between finalize and publish (simulate: kill the detached promise) → record still `pending` → reconciliation re-runs and lands a terminal state.
  - *Async parity:* fire-and-forget query → same lifecycle without a waiter.
  - *Error path:* sync capture fails → `{state:'failed', reason}`; run stays `success`.
  - *Edge:* key bound elsewhere → `not_applicable` with the skip reason; explicit-`liveSourceId` query → existing binding checks exactly as today (R4).
- **Verification:** scenarios green; existing continuation tests unchanged.
- **Checkpoint:** auto — http-api file green.
- **Runtime evidence:** `unverified — the detached patch's timing against a real concurrent waiter needs the U4 live probe; deterministic tests assert the lifecycle, not its interleaving.`

### U3. One projection across the completion surfaces

- **Goal:** Sync query, `wait_run`, and `get_run` expose the same result projection — answer anchor plus transcript state/path — with a bounded grace wait on blocking paths and model-visible fields trimmed to what agents act on.
- **Requirements:** R3
- **Dependencies:** U2
- **Files:**
  - Modify: `http-api.mjs` (sync response + 202 body + `/runs/wait` grace), `mcp-server.mjs` (`agentify_query`/`agentify_wait_run`/`agentify_get_run` structuredContent and text, one-clause description deltas)
  - Test: `tests/mcp-tool-profile-integration.test.mjs`, `tests/http-api.test.mjs`
- **Approach:** One projection object, rendered per channel: `{providerMessageId, transcript: {state, snapshotPath?}}` — `snapshotPath` only when `ready`; hashes, counts, and source identifiers stay in the run record (the sync-query structuredContent additionally keeps `liveSourceId`/`sourceKey`, the supported continuation workflow's inputs). Blocking paths (sync `/query` response and `agentify_wait_run`) wait a bounded grace — ≤2s, notification-based on the U2 patch, never an unconditional sleep, caller deadline respected — then return the explicit `transcript_state=pending` without a path; `get_run` is immediate. `runStatusText` prints `transcript=<path>` only when ready, plus the adjacent `turn=<providerMessageId>` anchor. Description deltas stay at one clause each, spending it on what the agent should do ("returns answer-artifact and JSON-transcript paths for selective local reading"), not storage internals.
- **Patterns to follow:** the `outputPath=` line in `runStatusText` (`mcp-server.mjs:121`); `conversationReadText`'s path-first precedent (`mcp-server.mjs:130-143`); the sync-query structuredContent's metadata-only discipline (mcp-server.mjs:904-906 comment).
- **Test scenarios:**
  - *Happy path:* all three surfaces carry the same projection fields once `ready`; blocking paths resolve within grace when the snapshot lands quickly.
  - *Grace timeout:* sync not ready in 2s → explicit `transcript_state=pending`, no speculative path, answer artifact still fully usable; `get_run` immediate at all times.
  - *Edge:* MCP integration test through real stdio asserts the fields on all three tools and that each touched description grew by at most one clause (token budget held).
- **Verification:** both green; no existing assertion broken (additive fields).
- **Checkpoint:** auto — integration + http-api files green.
- **Runtime evidence:** omit — wire shapes asserted through the real stdio transport.

### U5. `/agentify` skill guidance converges on pointer-first

- **Goal:** The caller-facing skill teaches reading the local transcript file as the default way to consume chat content, matching the new surface.
- **Requirements:** R3
- **Dependencies:** U3
- **Files:**
  - Modify: `~/.claude-zai/skills/agentify/SKILL.md` (user-space, not this repo)
- **Approach:** Add a short pointer-first section next to the existing output-handling guidance (the skill already teaches `maxOutputChars` and names the saved output file at its line ~126): the durable conversation transcript is a local JSON file (path in the result's transcript block when `ready`), the answer turn is selected by `providerMessageId`, and — the condition under which JSON-as-the-file works — the concrete selector is taught, e.g. the jq one-liner returning only the answer turn's raw text from the snapshot. Keep it tight — the skill is ambient session guidance. Note the drift risk in one line: when this repo's surface changes, this section follows.
- **Patterns to follow:** the skill's existing gotcha sections (concise, incident-grounded).
- **Test scenarios:** none — prose artifact (its check is U4's live flow mirroring the guidance).
- **Verification:** section added, teaching matches the shipped surface exactly.
- **Checkpoint:** auto — section written and cross-checked against U3's fields.
- **Runtime evidence:** omit — documentation artifact.

### U4. Consent-gated live probe: the file exists and greps

- **Goal:** Live end-to-end: a fresh keyed query auto-tracks, the record carries the pointer, and the snapshot file on disk contains the answer turn by `providerMessageId`.
- **Requirements:** R1, R2, R3
- **Dependencies:** U2, U3
- **Files:**
  - Modify: `docs/probes/` (new record), `CLAUDE.md` (transcript-by-default section)
- **Approach:** Respawn the app at the built commit; one numeric query on a disposable keyed tab; read the run record after success settles: assert `outputManifest.transcript.snapshotPath` exists, `grep` the snapshot JSON for the run's `meta.providerMessageId` and the answer text; a second query on the same key must resolve the same `liveSourceId` (O2) and refresh the pointer; close the tab.
- **Patterns to follow:** the 2026-09-17 cold-start probe procedure.
- **Test scenarios:**
  - *Happy path:* both queries' pointers valid; snapshot files contain their respective turns; same `liveSourceId` across both.
  - *Falsifier:* a missing pointer, a snapshot without the turn, or a rebound source reopens the plan.
- **Verification:** probe record written; CLAUDE.md documents the default and the pointer fields.
- **Checkpoint:** gate — scoped consent (below) granted → run → all assertions hold: continue. Consent withheld → mark unverified, ship U1–U3, CLAUDE.md documents the deterministic evidence only.
- **Runtime evidence:** `unverified — the probe is this unit's evidence; runs only under the consent grant.`

## Scope Boundaries

- No new file format, no rendered per-conversation markdown — the snapshot JSON is the file; the `/read-conversation` uuid export is unchanged.
- No new MCP tools; `agentify_get_transcript`/`track_transcript`/`sync_transcript` unchanged.
- `finalizeQueryOutputs` timing and the completion-evidence gates (ADR 0007) untouched — the pointer is enhancement, never completion proof.
- Retention/pruning policy for growing snapshot blobs — explicitly deferred (no deletion API exists today; nothing regresses).

### Deferred to Follow-Up Work

- Transcript retention/GC policy (blobs are append-only by design; needs its own decision; constraint recorded from the Pro review: any future GC must preserve snapshots referenced by retained runs — an immutable path is not an immortal promise if collection deletes it) → revisit when blob growth is measurable.
- Rendered per-conversation markdown view — deferred pending observed agent traces (trigger: traces show repeated schema discovery or whole-file JSON dumps into context where prose navigation would have read less).
- Stable per-conversation `latest` discovery pointer (a mutable path that reveals turns added after this run's immutable snapshot) — deferred; trigger: agents re-opening conversations without a new query.
- Shrinking the 2,000-char preview for long outputs (keep small answers complete inline; compact receipt for long ones) — deferred with a measurement obligation: this plan *enables* selective reading, it does not by itself remove payload; before claiming token wins, compare complete agent traces (short-answer, long-answer, historical-lookup, delayed-capture) including file-read output, via the usage counter and run store.

## System-Wide Impact

- **Interaction graph:** every successful keyed text query now writes transcript-library state (source ensure + one sync attempt + one snapshot per changed conversation); the exclusive lease serializes the capture against the tab's next use.
- **Error propagation:** sync failures degrade to a recorded reason in the run record; they never fail the query (existing swallow semantics, now observable).
- **State lifecycle risks:** snapshot blobs grow with conversation churn (content-addressed dedupe is the mitigation); `live/state.json` gains one source per keyed conversation (64-attempt compaction already bounds history).
- **API surface parity:** additive response fields and one text line; HTTP defaults unchanged.
- **Integration coverage:** U2's http-api tests cover the patch lifecycle; U4 exercises the real disk and grep.
- **Unchanged invariants:** receipts (ADR 0002), completion evidence (ADR 0007), turn identity (ADR 0009), capture gating (ADR 0010), continuation binding (R4).

## Build Execution Contract

- **Closed decisions:** the post-finalize hook is the seam; `pending` persisted at finalize (O3); publish detached; `ready` only on answer-anchored verification (O1); one result projection across the three completion paths with ≤2s grace on blocking paths; model-visible fields are `providerMessageId` + `transcript{state, snapshotPath?}` only (`liveSourceId`/`sourceKey` additionally on sync-query structuredContent for continuation); identity-keyed resolution with no key rebinding; snapshot JSON is the file; no new tools.
- **Builder autonomy:** exact patch mechanics (store patch vs re-finalize merge); field order/naming inside the transcript block beyond the named fields; description wording; probe-record phrasing; how the 202 body carries the resolution.
- **Verify at contact:** how `profileScopeId` is resolved when deriving identity from `conversationUrl` inside the existing capture/binding helpers (grep `identityFromOwnedLocation` callers — the hook must reuse exactly that resolution); that `runStore` has a patch path merging `outputManifest` without clobbering `files[]` (if not, extend it — the finalize patch at http-api.mjs:1888-1904 is the pattern); whether existing http-api tests deep-equal `outputManifest` (update fixtures additively if so); the exact store API name for identity lookup (add if absent); `~/.claude-zai/skills/agentify/SKILL.md`'s current output-handling section (U5 edits beside it, ~line 126).
- **Expected gate map:** U1 → sync/store tests green; U2 → http-api green incl. patch lifecycle and unchanged continuation tests; U3 → integration + http-api green, additive fields only; U5 → skill section written; U4 → probe record. End → full `npm test` green.
- **Stop conditions:** the hook cannot resolve identity from the served URL with existing helpers; or the run-record patch cannot express the transcript block without a schema change beyond `outputManifest` passthrough.
- **Authority boundaries:** U4's live probe requires the scoped consent below; without it, ship deterministic and mark unverified.
- **Human inventory:** one *consent* item — U4: respawn the local app (by PID, traffic-quiet verified), one numeric query on a disposable keyed tab, read the run record, grep two local snapshot files, close the tab. One real ChatGPT turn. Resolved upfront if possible; withheld → U4 skipped-and-marked.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Run A's snapshot captured after run B advanced the conversation | Answer-anchored readiness (O1): `ready` requires the run's `providerMessageId` in the committed snapshot; later turns alongside it are fine, a missing anchor is `failed: answer_turn_absent` |
| Detached sync contends with the tab's next query | Exclusive lease serializes (existing mechanism for tracked callers); probe exercises back-to-back queries |
| Crash between finalize and publication | O3: `pending` persisted at finalize; startup reconciliation re-runs stranded pendings |
| Pointer still pending when the grace window closes | Explicit `transcript_state=pending`, no speculative path, answer artifact remains fully usable |
| Snapshot growth on chatty conversations | Content-addressed dedupe; retention deferred deliberately with the GC-preserves-referenced-snapshots constraint recorded |
| Auto-track floods `live/state.json` on many throwaway keys | One source per conversation identity; 16 MiB cap + attempt compaction already enforced |
| Fixture churn where `outputManifest` is deep-equal asserted | Verify at contact; additive updates only, same outcomes |
