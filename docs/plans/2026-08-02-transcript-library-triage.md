# Transcript Library V0 review triage

Date: 2026-08-02  
Source review: 44 deduplicated findings, F1–F44  
Scope: Transcript Library V0 on the implementation descended from `190f0ec`

This ledger separates whether the reported mechanism is true from whether it is reachable and violates the approved Program. `ACCEPT` means the finding caused a code or contract correction. `DOCUMENT` means the observed behavior is real but the missing part is disclosure or evidence, not a safe V0 code change. `REJECT` means the proposed change would violate or weaken an approved invariant, or the reported consequence is not reachable. `DEFER` records deliberately unapproved scope. `SKIP` means no material defect was demonstrated after execution.

| ID | Facts and reachability | Decision | Resolution and evidence |
|---|---|---|---|
| F1 | An error after atomic rename was previously indistinguishable from a pre-rename failure and could latch a process-local uncertain state. | ACCEPT | `69269ce`: reconcile durable bytes after replacement errors, keep definite pre-rename failures retryable, and reload truly uncertain state before later operations. |
| F2 | Unguarded transcript/catalog recovery could abort all desktop startup when one library state file was unreadable or had an unsafe mode. | ACCEPT | `7bca35b`: independent best-effort library recovery with content-free unavailable status. `cd34b0f`: a packaged-process probe changes the live state file to `0644` and proves health, authenticated tabs, catalog startup, and the Control Center preload remain available while only transcripts return the safe unavailable code. |
| F3 | The 10,000 catalog-problem limit was accidentally reused as the archive conversation-record limit. | ACCEPT | `ed0f0a7`, `29274b0`: separate record/problem authorities and real ZIP bytes prove 10,001 records stream. Independent capacity review later showed 100,000 minimal records exceed the atomic 64 MiB catalog, so the Program and reader ceiling are now 20,000—still independent of the unchanged 10,000-problem limit. A worst-shape import fits an empty catalog, while an atomic reservation against current metadata survives interruption/restart so an accepted import cannot strand its cursor at the ceiling. |
| F4 | Extended-year ISO output could pass the JavaScript `Date` range but fail the shared four-digit-year parser. The review overstated the cursor consequence because production preflight runs before `beginImport`. | ACCEPT | `9376b63`: unrepresentable update/create times fall through deterministically to the next timestamp or epoch before any visible import. |
| F5 | A representable year-9999 provider timestamp could dominate default snapshot selection indefinitely. | ACCEPT | `e0e5e99`: raw provider evidence remains immutable, while visible imported records/snapshots use durable `CatalogImport.createdAt`; replay/restart retains the ref and a later live capture wins. |
| F6 | A present non-string or contradictory provider identity rejects the archive. This is reachable, but it is the approved malformed-identity safety boundary, not a catalog-only ambiguity. | DOCUMENT | Keep whole-archive `unsafe-archive` rejection. Do not weaken exact identity or add a new per-record reason without a Program signature change. |
| F7 | Routing legacy `readConversationText` through public library capture imposed the owned canonical `/c/...` precondition on share/custom-GPT reads. | ACCEPT | `b7aa8f6`: legacy read uses the same structured DOM-window primitive without the library route gate; public capture remains exact-owned-route only. |
| F8 | The first projection mapped only part of the pre-V0 reason vocabulary. | ACCEPT | `b7aa8f6`: exhaustive closed mapping plus legacy-only top-timeout/top-stall diagnostics; public structured reasons remain closed and unchanged. The old scroller sentinel was proven unreachable at `190f0ec`. |
| F9 | Ordinary navigation consumed part of its readiness timeout while navigating, unlike the pre-V0 behavior. | ACCEPT | `15f83b3`: ordinary callers receive the full readiness window after navigation; forced verification retains its combined replacement deadline. |
| F10 | Empty text, including an image-only mapped message under the current compatibility map, produces a partial capture. | REJECT | The Program explicitly requires empty mapped input to fail partial. Manufacturing a complete text transcript would weaken evidence. Supporting image-only turns needs a new structured-content contract first. |
| F11 | Legitimate partial capture incorrectly failed the compatibility capability and marked the map as drifted. | ACCEPT | `72c8dd7`: valid partial capture is a healthy closed protocol outcome; only contract/provider disagreement marks drift. |
| F12 | Route-history dedup included the fresh timestamp, so it never deduplicated and could grow to the parse ceiling. | ACCEPT | `448a090`: semantic transition dedup plus a 256-observation retention bound; oversized legacy histories load and compact on mutation. |
| F13 | Terminal attempts and deletion tombstones shared unbounded state. | ACCEPT | `c9ef75f`: retain every open attempt and at most 64 terminal attempts per active/forgotten source, with a persisted predecessor snapshot preserving latest/change semantics. Tombstone count remains a restore-contract problem, durably deferred in [the retention follow-up](./2026-08-02-transcript-tombstone-retention-follow-up.md). |
| F14 | The reported routes did not reserve the provider slot like `/query`, but sync and verification already serialize on the controller. The reachable corruption was reading a served URL after releasing that lock. | ACCEPT | `3b21eb4`: capture the served route inside the controller lock for query/retry/research/send and validate it before durable affinity. Track exact-route reading is likewise documented under its controller lock. |
| F15 | Capture timeout fallback could close a shared Chrome target or crash a shared Electron renderer and report only a partial result. | ACCEPT | `af6892c`: cancellation failure never destroys the shared tab/renderer; focused backend tests prove it remains alive. |
| F16 | Direct verification held the controller lock across provider calls without a host deadline. | ACCEPT | `f8f9c9a`: bound the whole exclusive operation; expiry returns failed/transport, performs no route mutation, and releases the lock. |
| F17 | Metadata refresh could render before initial state populated the storage directory. | ACCEPT | `2065c28`: initial state refresh precedes library rendering; renderer/visual tests cover the ordering. |
| F18 | Renderer scope validation accepted spaces, then surfaced a generic error for the production parser's rejection. | ACCEPT | `2065c28`: renderer uses the production rule/code and explains allowed characters. |
| F19 | Visual-proof privacy booleans were literals rather than observations that could fail. | ACCEPT | `f721406`: fake private sentinels cross real IPC/preload, with body, renderer diagnostic, and process-output observers. Three negative Electron probes flip the relevant verdict without leaking markers. |
| F20 | `--pixel-review` and reviewer name are caller declarations; the script cannot authenticate that a human looked at the pixels. | DOCUMENT | Keep the provenance fields, but never count them as human evidence without external attestation. The Program and final report say the human checkpoint is unverified. |
| F21 | Account-hint comparison works only when both hints are supplied, but production has no trusted browser-profile hint port. | DOCUMENT | README and Program now state the comparison is conditional and currently unavailable; scope remains explicit human confirmation and no account identifier is invented or scraped. |
| F22 | Forget returns `recoverable: true` and a `local-trash/...` logical identifier, but V0 has no restore API or physical trash directory. | DOCUMENT | Describe it as a logical tombstone, not moved files. Restore/purge requires the separate storage contract in the F13 follow-up. |
| F23 | Post-query sync is awaited before the response and while the live key remains busy. | REJECT | This matches the approved promise that manual and post-query callers await the same typed sync primitive. README now makes the wait explicit. |
| F24 | Live-binding lookup collapsed transcript-store failures into the unrelated `conversation-not-live-bound` response. | ACCEPT | `c59e001`: one library error authority preserves safe symbolic store/service/blob failures and redacts details before any provider action. |
| F25 | Retry was reported to prefer a stale project URL over its conversation URL. | REJECT | Executed branch inspection confirms exact saved conversation location has precedence; project URL is only fallback. |
| F26 | `liveSourceId` is mutually exclusive with competing tab/model/project selectors. | DOCUMENT | This is a deliberate anti-ambiguity contract. README now names the exact trio and the selectors callers must omit. |
| F27 | Early archive iteration was alleged to leak a zlib context because cleanup was not in `finally`. | SKIP | Node stream iteration destroys the transform/inflate chain on early break; no retained handle or growth was demonstrated. |
| F28 | A roughly 9–10 MiB ZIP is decoded twice during safe preflight/import. | SKIP | Measurement was about 290 ms per pass on this machine; the bounded double pass buys zero-visibility late-corruption rejection and is not a demonstrated hot-path defect. |
| F29 | Records were alleged to publish before full archive validation. | REJECT | Production performs a complete real-reader preflight before `beginImport`; late corruption leaves zero catalog visibility. Immutable blobs are published only in the later committed import pass. |
| F30 | Electron moving to `devDependencies` was alleged to leave no production fallback. | REJECT | This is a private packaged desktop app: source start/build requires development dependencies and the packaged artifact embeds Electron. `npm run dist` is the supported packaging gate. |
| F31 | Failure to persist an interrupted import was discarded, potentially leaving a misleading open import. | ACCEPT | `6c5201f`: retry interruption once, then return explicit `catalog_import_recovery_required`; mappings remain symbolic/redacted. |
| F32 | Control Center forget copy implied stronger local erasure/recovery behavior than the store provides. | ACCEPT | `2065c28`: copy says active-list removal plus retained logical history/blobs and no provider deletion. README documents the missing restore surface. |
| F33 | A `syncing` row disables sync/forget actions. | DOCUMENT | This is the concurrency guard, not the F1 failure latch. Startup changes stale open attempts to interrupted; README directs restart for a stale syncing state. |
| F34 | Several safe library errors could fall through the general HTTP mapper. | ACCEPT | `c59e001`: general routing consults the transcript/catalog authorities and includes controller/service/blob codes. No runtime aliases were added for misspelled Program codes. |
| F35 | Three Program examples used kebab-case codes that production never emits. | ACCEPT | Program corrected to `owned_conversation_required`, `transcript_confirmation_required`, and `transcript_sync_active`; production remains the single symbolic authority. |
| F36 | Loading both default candidates with `Promise.all` means one corrupt candidate fails retrieval rather than silently using the other. | REJECT | Fail-closed corruption is the approved behavior. An explicit healthy snapshot remains retrievable; silent fallback could hide evidence corruption and change deterministic selection. |
| F37 | Scope-reassignment replay used repeated `records.indexOf`, making replacement quadratic. | ACCEPT | `e98e516`: pre-index durable records once and replace in linear time; behavior and replay checks remain unchanged. |
| F38 | Control Center renders only the first 100 catalog rows. | DOCUMENT | The renderer already shows a next-page hint when present; README directs larger catalogs to bounded paginated HTTP/MCP. Adding UI pagination is not required for the minimal V0 surface. |
| F39 | `orderedWindowStitching` was described as independent evidence. | REJECT | It is a derived summary of executed overlap/order/gap checks, not a hard-coded pass. Complete snapshots still require both boundaries and inactive generation; Program wording is corrected. |
| F40 | Explicit alternate ChatGPT ports are rejected. | REJECT | Exact canonical provider origin is intentional. Explicit default `:443` canonicalizes; arbitrary ports must not become owned routes. |
| F41 | Control Center disables forget for a disabled source. | DOCUMENT | No production enable/disable surface currently makes that state user-reachable. Store and confirmed HTTP/MCP forget permit a disabled source; README records the renderer limitation. |
| F42 | V0 has no action to discard a partial import. | DEFER | Destructive discard/purge was not authorized and needs confirmation, orphan-retention, and recovery contracts. A current within-ceiling partial import safely resumes the same archive instead; migrated over-limit V1 history is explicitly terminal and read-only. |
| F43 | The verification tab was alleged to have no route back to the user. | REJECT | Hidden verification windows remain ordinary entries in the main tab list; the existing Show/Hide controls can reveal them. No library-specific control is needed. |
| F44 | Path checks have a same-user time-of-check/time-of-use race. | DOCUMENT | Mechanism is real but requires a malicious process with the same user access already trusted to read owner-only plaintext. README/Program state this residual threat boundary. |

## Independent implementation gate

After the F1–F44 adjudication, a separate read-only state-machine review executed adversarial probes against the resulting branch. These are additional gate defects, not retroactive changes to the 44-finding count.

| Gate | Defect found | Resolution |
|---|---|---|
| G1 | A timed-out route verification could release the controller while its late navigation was still running. | Controller quarantine keeps later exclusive work busy until the exact provider operation settles; route tests reproduce timeout, busy refusal, and release. |
| G2 | A capture timeout with unconfirmed renderer cancellation had the same late-work overlap. | The capture host deadline installs the same quarantine; the focused controller test proves no later exclusive entry before evaluation settlement. |
| G3 | Two concurrent uncertain-write reloads could install stale in-memory transcript or catalog state over a later durable write. | Each store now coalesces one reload promise; real gated-read tests prove later attempt/import state remains aligned with disk. |
| G4 | A transient initial metadata read error poisoned the cached load promise for the process lifetime. | Only transient store-I/O rejection clears the initial promise; corruption/schema failures remain fail-closed, and both stores prove one-shot retry. |
| G5 | Metadata decoding replaced invalid UTF-8, and catalog titles admitted ill-formed UTF-16 strings. | Fatal UTF-8 decoding plus shared well-formed-title parsing reject new corruption without rewriting bytes; the V1 migration preserves identity/raw/snapshot evidence while nulling only an old-valid malformed optional title. Real ZIP and restarted-state tests cover both paths. |
| G6 | Re-reading an applied replacement did not re-establish parent-directory durability. | `settleReplacement` validates the private final file and fsyncs its directory before uncertainty clears; failure/retry is executed against the real filesystem boundary. |
| G7 | A final import-status write failure could leave an immediately unretryable open import. | Finalization is inside the interruption/reconciliation path; definite failure becomes resumable and applied-but-uncertain completion returns its durable terminal outcome. |
| G8 | The first revised archive ceiling fit one empty catalog but did not protect accumulated imports. | Complete preflight supplies record count; `beginImport` atomically reserves a worst-shape projection against current state. The reservation survives interruption/restart, concurrent maximum imports serialize to one success, and insufficient capacity rejects before visibility. |
| G9 | A temp-write failure before any rename was misclassified as uncertain, so a missing final file forced restart recovery forever. | `replaceFile` now labels the provably pre-rename failure `private_replace_not_applied`; an in-process store retry succeeds without entering uncertain recovery. |
| G10 | Adding import-capacity rows without a store schema migration would reject every V1 catalog at startup. | Store schema V2 loads one internally consistent V1 state tree, preserves identity/raw/snapshot evidence, nulls only an old-valid ill-formed optional title, and migrates nested rows together. Compact encoding preserves the old exact terminal-recovery byte budget without raising the 64 MiB ceiling. Within-ceiling suspended imports require a full preflight reservation. Legacy imports proven above 20,000 records become terminal read-only history (complete stays complete; every other state becomes partial); an exact same-archive/same-scope preflight can set that marker without touching another import, and Control Center offers neither Resume nor Reassign. A nested-version matrix proves both directions for import, record, and route rows. |
| G11 | Controller quarantine could make a second direct route-verification port call throw `tab_busy` outside its closed outcome union. | The route verifier catches outer exclusive-entry failures as `failed/transport`; a direct repeated-verification test proves the port stays closed while raw controller work remains busy. |
| G12 | HTTP, MCP, and Control Center error allowlists drifted, hiding import inspection and legacy-capacity failures behind generic errors. | `library-http-errors.mjs` is the shared HTTP/MCP status and safety authority; authenticated loopback and real MCP stdio tests preserve exact `catalog_import_inspection_failed` and `catalog_import_capacity_required` symbols, while the renderer allowlist displays the latter without private detail. |
| G13 | The accepted F11 rule still treated F10's expected empty mapped message as `compatibility_drift`, and the resulting image-only limitation was absent from the README. | The capture contract gains `conversation_message_text_unavailable`; otherwise structurally valid empty mapped messages remain partial and cannot advance latest state, but the compatibility capability stays healthy. Malformed, duplicate, or reordered structure remains drift. The README states the limitation explicitly. |

## F10/F11 follow-up adjudication

Finding: An empty served message is correctly excluded from transcript evidence, but its partial result is incorrectly classified as `compatibility_drift` and the limitation is not documented.

Observation at review: `unresolvedMessageKeys` was populated when a mapped message had no extracted text, and the terminal reason assignment mapped that set to `compatibility_drift`.

Claimed consequence: A normal image-only assistant turn prevents a complete snapshot, marks the ChatGPT compatibility capability as failed, and makes the compatibility map appear drifted even though the extractor is following its declared no-fabrication rule.

Reviewer-proposed remedy: Give empty mapped input its own partial reason and state the image-only limitation in README.

Evidence: The production controller path and the existing empty compound-message test reproduce the reason. The transcript capability postcondition accepts every partial reason except `compatibility_drift`, so the false drift result follows directly and is common-path reachable.

Fact status: CONFIRMED; common path for a conversation containing an image-only mapped message.

Invariant: When an otherwise structurally valid served mapped message has no transcript text, capture must remain partial without inventing evidence, and that expected content limitation must not report a provider compatibility-map disagreement. Malformed, duplicate, or reordered provider structure must still report compatibility drift.

Invariant status: Violated by the reason classification and by the missing operator documentation.

Change relationship: INTRODUCED by the V0 structured capture contract and left exposed by the narrower F11 correction.

Smallest complete fix: Carry one explicit partial reason through the Program, transcript contract, legacy projection, controller, MCP schema, persistence validation, focused compatibility tests, and README limitation.

Fix class: COORDINATED; it extends an existing closed union without changing capture lifecycle or snapshot publication.

Risk if deferred: Common image-containing conversations continue to report false compatibility drift and cannot be tracked, with no user-facing explanation.

Risk if fixed now: Low; every closed-union consumer is enumerable and focused contract/controller/MCP tests can prove the propagation.

Merge impact: BLOCK for the claim that all V0 ship blockers are resolved; the already-pushed series needs this follow-up before release.

Disposition: ACCEPT.

Action: Add `conversation_message_text_unavailable`, keep capture partial and latest state unchanged, ensure compatibility health stays green for structurally valid empty input, retain compatibility drift for structural conflicts, document the limitation, and run focused plus full gates.

Resolution: Implemented. Capture retains empty mapped records internally so duplicate IDs, duplicate positions, reordering, changed identity, and changed position remain observable structural failures. It validates provider-position coverage over captured turns plus retained unresolved positions before classifying missing text. It publishes only text-bearing structured turns, classifies unresolved otherwise-valid text as `conversation_message_text_unavailable`, and clears that partial state only after exact identified hydration at the same provider position has been accepted, including hydration after the position-stability lock. All-image windows use the new reason instead of appearing to contain no messages; unmounted unresolved messages remain sticky partial evidence. `orderedWindowStitching` remains the derived structural result rather than being forced false by the content-only reason.

Verification: Focused controller tests cover all-image windows, missing provider positions, duplicate and reordered structure, changed identity and position, immediate and post-lock exact hydration, identified and id-less unmounts, derived stitching evidence, and mixed structural-shell cases. Contract, compatibility-policy, sync, and real MCP stdio tests cover the closed reason end to end. The final full-suite, package, and packaged-process results are recorded in the handoff report.

Draft reviewer response: Confirmed. The no-fabrication decision remains correct, but otherwise-valid empty mapped content is an expected capture limitation rather than compatibility drift. The new closed reason preserves the partial result, keeps compatibility health accurate, documents that image-only turns prevent complete tracking, and leaves structural disagreement on the drift path.

## Count

- ACCEPT: 23
- DOCUMENT: 9
- REJECT: 9
- DEFER: 1
- SKIP: 2
- Total: 44

No finding is dropped. F13 is accepted for bounded attempt history while its restore-safe tombstone-count residue remains linked to a durable follow-up. Personal-export and externally attested human visual review are evidence follow-ups, not fabricated passes.
