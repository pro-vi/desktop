---
title: Fix inbox runtime contracts
objective: Make complete conversation reads recoverable in one call, make stalled durable runs terminate with evidence, and preserve exact Pro mode confirmation.
type: fix
status: completed
date: 2026-08-29
origin: .inbox/.read/2026-08-17-read-conversation-large-transcript-spill.md
---

# Background

This plan resolves three archived agentify-desktop inbox reports measured against `8e9f68f`:

- `.inbox/.read/2026-08-17-read-conversation-large-transcript-spill.md`
- `.inbox/.read/2026-08-27-extended-pro-run-never-terminates.md`
- `.inbox/.read/2026-08-29-pro-mode-confirmation-false-failure.md`

Current code captures a conversation and projects one inline text blob, keeps durable response observation alive without a hard terminal deadline, and requires an unrelated trigger candidate before accepting an exact supported power-slider state. Direct reproductions on current `main` proved all three conditions. The relevant baseline passed 344 tests.

This plan supersedes the read-purity clause in `docs/plans/2026-08-08-001-fix-conversation-artifact-download-plan.md` only where local transcript transport is concerned. `agentify_read_conversation` may write its rendered transcript into Agentify's private artifact store so a caller can read the complete result. It still must not download provider file cards or mutate the provider conversation as a side effect.

# Requirements

- **R1:** One `agentify_read_conversation` call returns a bounded inline preview plus a local owned path that contains the complete rendered capture, with character count and integrity evidence.
- **R2:** Preview length does not reduce browser capture scope or replace the underlying capture-completeness reason.
- **R3:** Durable response observation retains its soft `reconciling_response` phase but reaches an absolute service-owned terminal deadline.
- **R4:** At the hard deadline, a final exact transcript capture may recover a selector-missed assistant turn; partial or ambiguous capture cannot create success or a completion receipt.
- **R5:** Terminal reconciliation failure persists content-free response diagnostics and releases the provider slot through the existing lease owner.
- **R6:** `agentify_wait_run` returns terminal diagnostics and, on a caller-only wait timeout, returns the latest non-mutating run snapshot with an explicit wait-timeout marker.
- **R7:** A supported visible `0..4` power slider already at the requested intent's exact target index confirms that mode without a separate trigger candidate.
- **R8:** Missing, malformed, unsupported, or mismatched slider evidence remains fail-closed before send.

# Naming Ledger

| Role / meaning | Existing repo term | Chosen name | Owner / placement | Status | GR6 sibling disposition |
|---|---|---|---|---|---|
| Absolute local path containing the rendered conversation capture | `outputPath`, `responsePath` | `transcriptPath` | `/read-conversation` HTTP and MCP result | new | Keep run-output names unchanged because they identify run manifests, not conversation reads. |
| Inline head of the rendered transcript | `text` | `preview` | MCP result content; HTTP retains `text` as a compatibility alias | new | Existing run output uses `outputText`; different owner and lifecycle, so no rename. |
| Full rendered transcript length in JavaScript characters | `outputChars` | `totalChars` | transcript delivery result | new | Existing `outputChars` remains run-output-specific. |
| Whether only the inline view is shortened | `truncated` | `previewTruncated` | transcript delivery result | new | Keep legacy `truncated` as a compatibility projection during this change. |
| Extra service-owned window after the response soft deadline | none | `reconcileGraceMs` | `chatgpt-controller.mjs` response policy | new | Navigation and attachment timeouts have different owners and keep their names. |
| Terminal response-observation failure after reconciliation | `timeout_waiting_for_response` | `response_reconcile_timeout` | controller error and HTTP outcome mapping | new | Ordinary non-durable response timeout remains distinct. |
| Content-free durable evidence about the last response observation | in-memory `responseDebug` | `responseDebug` | run record and waiter result | reuse | Remove content previews at the persistence boundary; do not create a second diagnostic term. |
| Proof source for mode confirmation | provenance `reason` | `evidenceKind` | mode-intent provenance | new | Model-intent provenance is not slider-based; no sibling field until it gains multiple evidence kinds. |

# Architecture Decision

**Approach:** Extend the existing owners instead of adding a new shared subsystem. The HTTP API always writes each non-empty rendered conversation capture atomically into the private artifact store and returns a bounded preview plus `transcriptPath`, `totalChars`, byte count, SHA-256, and artifact identity. The MCP adapter puts path and counts before the preview and excludes the full transcript from `structuredContent`. The response controller retains the soft deadline, adds a fixed absolute grace window, performs one bounded final structured capture at that deadline, then either returns an exact recovered assistant turn or throws `response_reconcile_timeout`. HTTP persists a versioned, content-free `responseDebug` summary and lets the existing provider-slot `finally` release capacity. Exact supported power-slider evidence becomes sufficient inside the current fail-closed scale branch.

**Rationale:** This follows the repository's existing artifact, run-finalization, and mode-picker patterns. An always-written transcript artifact is simpler and more reliable than a spill threshold tied to an unknown caller result cap. Controller-owned terminal failure preserves tab ownership until polling has actually stopped; provider-slot stale reaping would release capacity while unsafe work still owned the tab. Exact `0..4` slider position is independent evidence already validated by the existing primitive, so requiring a separate trigger candidate adds no safety.

**Rejected alternatives:** Offset pagination leaves the caller responsible for stitching mutable live captures. Provider-slot stale reaping violates controller ownership. Trusting a generic `Pro` label without the exact supported slider would weaken fail-closed mode selection.

**Consequences:** Conversation reads now create private retained artifacts. They are mode `0600` and registered under Agentify's artifact root, but no retention cleanup exists yet. Durable runs can terminate after a late-response grace period even if the provider answers later. The caller wait deadline remains non-mutating and separate from the service hard deadline.

**Approval criteria:** Approval accepts local transcript persistence as the delivery mechanism, a bounded service response lifetime, and exact supported slider position as sufficient Pro evidence. It does not accept generic labels, unsupported slider scales, partial transcript capture as completion proof, or provider-slot release before controller termination.

# Program obligations

- **O1:** Capture completeness, preview truncation, and artifact-inventory completeness remain three independent states.
- **O2:** Persisted response diagnostics are versioned and content-free; transcript bodies and text previews do not enter run JSON.
- **O3:** The response hard deadline is absolute. Text growth or UI activity cannot extend it.
- **O4:** A final recovery capture can produce success only from a complete capture with an assistant turn that is provably newer than the pre-send baseline.
- **O5:** Power confirmation records its evidence kind and exact slider bounds/indexes without making unsupported indices into valid intents.

# High-Level Technical Design

Directional guidance for review, not implementation specification:

```text
agentify_read_conversation
  -> exclusive browser capture at full capture budget
  -> render one authoritative transcript
  -> atomic private file + read-back hash + artifact registration
  -> HTTP compatibility projection { text: preview, complete, ... }
  -> MCP content: path/counts/status first, then bounded preview
  -> MCP structuredContent: metadata only, never the full transcript

durable query
  -> soft deadline: phase = reconciling_response
  -> absolute deadline = soft deadline + reconcileGraceMs
  -> one bounded structured transcript recovery attempt
      -> exact newer assistant turn: existing manifest/receipt success path
      -> partial, ambiguous, or absent turn: response_reconcile_timeout
  -> HTTP terminal outcome + content-free responseDebug
  -> run-store durable error record
  -> existing provider-slot finally releases lease
  -> waiter returns terminal record
```

## Representation ledger

| Concept | Authority | Consumers / projections | Boundary rule | Drift guard |
|---|---|---|---|---|
| Structured conversation capture | `transcript-contract.mjs` parsers | Controller, transcript library, legacy delivery | Parse before rendering or recovery judgment | Contract, controller, and transcript tests |
| Transcript delivery | HTTP `/read-conversation` result | MCP content and metadata-only structured result | File must be inside artifact root, atomic, private, read back, and hashed | HTTP plus real-stdio MCP tests |
| Response reconciliation evidence | Controller response snapshot, narrowed at HTTP persistence | Active query, run JSON, waiter | Closed versioned content-free fields only | Controller, run-store, HTTP, waiter tests |
| Run lifecycle | `run-lifecycle.mjs` | Run store, HTTP run endpoints, waiter, Control Center | Terminal error has `finishedAt`, no receipt, and released slot projection | Lifecycle and integration tests |
| Mode intent/power mapping | `CHATGPT_MODE_INTENT_META` plus exact supported-scale primitive | Browser evaluation and provenance | Exact scale and target index; final label trust gate remains | Primitive parity and controller fixtures |

# Implementation Units

## U1. Durable transcript delivery

- **Goal:** Make one conversation read provide complete locally readable output without emitting an oversized MCP result.
- **Requirements:** R1, R2
- **Dependencies:** None
- **Files:**
  - Modify: `transcript-contract.mjs`
  - Modify: `chatgpt-controller.mjs`
  - Modify: `http-api.mjs`
  - Modify: `mcp-server.mjs`
  - Modify: `README.md`
  - Test: `tests/transcript-contract.test.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`
  - Test: `tests/http-api.test.mjs`
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
- **Approach:** Render once from the parsed structured capture. Decouple the full capture budget from inline preview length. Persist every non-empty rendered capture through existing atomic artifact primitives, read it back, hash it, register it, and return a unique absolute path. Keep HTTP `text` as a preview compatibility alias; add explicit delivery metadata. Put metadata before preview in MCP content and omit large text fields from `structuredContent`.
- **Patterns to follow:** `http-api.mjs:1958` for private run output persistence; `http-api.mjs:2600` for bounded output metadata; `artifact-store.mjs:47` for owned registration; `transcript-contract.mjs:464` for authoritative rendering.
- **Test scenarios:**
  - **Happy path:** a capture larger than the inline cap produces a file containing its head, middle, and tail; reported character count, byte count, and SHA-256 match the file; MCP content is bounded.
  - **Edge case:** a short capture still produces a valid artifact and an untruncated preview without duplicating full text in structured content.
  - **Error path:** file write, read-back, ownership validation, or registration failure returns an error and never publishes an unverified path.
  - **Integration:** real stdio MCP invocation returns path/count/status metadata and does not duplicate the full transcript.
- **Verification:** Preview size cannot change capture scope or capture status; every successful non-empty read exposes a verified artifact containing the entire rendered capture.
- **Runtime evidence:** unverified — a warm live read above the MCP display ceiling must compare `totalChars`, SHA-256, and head/middle/tail against `transcriptPath`.
- **Checkpoint:** auto — focused contract, controller, HTTP, artifact, and MCP integration tests.

## U2. Bounded response reconciliation

- **Goal:** End stalled durable observation safely while recovering an exact selector-missed assistant response when possible.
- **Requirements:** R3, R4
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** Keep the current soft timeout. Derive `reconcileGraceMs` as at least five minutes and at most ten minutes from the effective timeout, with a direct controller-only test override. At the absolute deadline, perform one bounded structured capture. Accept only a complete capture whose assistant-turn count or final assistant text proves advancement from the pre-send baseline. Otherwise throw `response_reconcile_timeout` with the final content-bearing diagnostics for the HTTP boundary to sanitize.
- **Patterns to follow:** `chatgpt-controller.mjs:5831` for response observation; `chatgpt-controller.mjs:840` for parsed structured capture; `chatgpt-controller.mjs:5763` for a bounded stall error carrying the final observation.
- **Test scenarios:**
  - **Happy path:** a response completes inside the grace period and follows the existing success path.
  - **Edge case:** ordinary text selectors miss a complete newer assistant turn, final structured capture recovers it exactly once, and success returns the recovered text.
  - **Error path:** absent, partial, route-drifted, or baseline-only final capture throws `response_reconcile_timeout` and cannot return a completion receipt.
  - **Integration:** the hard deadline remains absolute even when page text continues to change.
- **Verification:** Every durable controller query settles by the absolute deadline plus the bounded final capture; only exact newer assistant evidence can convert the terminal check to success.
- **Runtime evidence:** unverified — live Extended Pro behavior requires an intentionally controlled long run or a deterministic browser double.
- **Checkpoint:** auto — controller regression fixtures for late success, final recovery, partial rejection, and absolute timeout.

## U3. Durable reconciliation diagnostics and waiter evidence

- **Goal:** Make terminal reconciliation failure visible to callers and prove that it releases provider capacity.
- **Requirements:** R5, R6
- **Dependencies:** U2
- **Files:**
  - Modify: `http-api.mjs`
  - Modify: `run-store.mjs`
  - Modify: `run-waiter.mjs`
  - Modify: `mcp-server.mjs`
  - Modify: `README.md`
  - Test: `tests/http-api.test.mjs`
  - Test: `tests/run-store.test.mjs`
  - Test: `tests/run-waiter.test.mjs`
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
- **Approach:** Sanitize controller diagnostics into a versioned content-free `responseDebug` record, persist it during progress and terminal finalization, and retain it in summary views. Map `response_reconcile_timeout` to a named terminal run error. Preserve the final run snapshot on caller-only `run_wait_timeout`; the MCP adapter returns that snapshot with `waitTimedOut: true` instead of an opaque thrown string. Provider capacity is released only by the existing `withProviderSlot` `finally` after controller settlement.
- **Patterns to follow:** `run-store.mjs:50` for durable normalization; `http-api.mjs:1704` for active-to-durable projection; `http-api.mjs:1768` for exact-once finalization; `run-waiter.mjs:11` for non-mutating waits.
- **Test scenarios:**
  - **Happy path:** a terminal reconciliation error is returned by `agentify_wait_run` with final content-free diagnostics and released slot evidence.
  - **Edge case:** a caller wait deadline expires before the service hard deadline and returns the latest running snapshot with `waitTimedOut: true` without stopping or changing the run.
  - **Error path:** malformed or content-bearing diagnostic values are dropped or rejected at the persistence boundary.
  - **Integration:** with one provider slot, a stalled first run terminalizes, persists `providerSlot.status=released`, and a second tab starts successfully.
- **Verification:** Run JSON, restarted run-store summary, HTTP wait response, and MCP waiter all agree on the terminal status and safe diagnostics; no transcript text is persisted in `responseDebug`.
- **Runtime evidence:** unverified — HTTP integration tests must prove real run-store writes and provider-slot reuse.
- **Checkpoint:** auto — run-store reload, waiter, HTTP slot-release, and real-stdio MCP tests.

## U4. Exact supported Pro slider confirmation

- **Goal:** Confirm an already-selected Pro mode from exact supported slider evidence without weakening fail-closed behavior.
- **Requirements:** R7, R8
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`
  - Test: `tests/chatgpt-ui-primitives.test.mjs`
- **Approach:** Inside the existing exact supported-scale branch, derive the current intent and label from the declared five-position mapping. When current index equals the requested intent's target index, return active without consulting trigger candidates. Record slider evidence in provenance. All unsupported scales, unmapped indices, hidden controls, missing attributes, and mismatches remain on the current click-or-fail path and still pass the final label trust gate.
- **Patterns to follow:** `chatgpt-ui-primitives.mjs:3` for intent metadata; `chatgpt-ui-primitives.mjs:88` for exact scale validation; `chatgpt-controller.mjs:271` for final label trust.
- **Test scenarios:**
  - **Happy path:** exact `0..4` slider at index `4`, no usable trigger candidate, zero slider clicks, confirmed Extended Pro provenance, prompt sent.
  - **Edge case:** indices `2` and `3` remain unsupported; exact Instant and Medium positions retain their declared mapping.
  - **Error path:** malformed bounds, missing values, hidden track, mismatched index, or unusable label fails before send.
- **Verification:** Only a parsed exact supported slider at the requested mapped index bypasses trigger-candidate confirmation; every ambiguous state remains fail-closed.
- **Runtime evidence:** unverified — a warm live compact-picker run already at Pro must prove zero re-clicks and a successful send.
- **Checkpoint:** auto — primitive parity and controller query regression tests.

# Scope Boundaries

- Do not add transcript offset pagination in this change; the verified local file is the complete-access mechanism.
- Do not download provider file cards during a conversation read.
- Do not release or reap a provider slot while its controller promise is active.
- Do not treat generic Pro text, unsupported slider scales, or indices `2` and `3` as supported mode evidence.
- Do not change model-generation intent behavior.
- Do not add a new package or shared service.

## Deferred to Follow-Up Work

- Artifact retention policy for repeated transcript reads: separate policy work because the artifact store currently retains other outputs without cleanup.
- Mode-power selector ownership and reverse-map consolidation: the representation audit found literals duplicated between `chatgpt-compatibility.json`, `chatgpt-ui-primitives.mjs`, and the controller. This is not causal to the reported false rejection; handle it in a dedicated compatibility-contract change rather than expanding this bug fix.
- Strict public `modeIntent` schema validation: unknown strings currently normalize through fallback behavior across existing surfaces; changing that contract is separate from confirming an exact supported state.

# System-Wide Impact

- **Interaction graph:** MCP read tool → HTTP route and operation scopes → controller capture → artifact store; durable query → controller response loop → active query → run store → wait endpoint → MCP waiter; mode intent → browser power control → provenance → pre-send gate.
- **Error propagation:** transcript persistence failures stop the read before a path is published; reconciliation failure becomes a terminal durable error; ambiguous mode evidence remains a pre-send error.
- **State lifecycle risks:** repeated reads retain files; terminal run finalization must update diagnostic and provider-slot projections together; caller wait timeout must not mutate the run.
- **API surface parity:** direct HTTP retains `text` as a preview alias while MCP stops duplicating it in structured content. Run list/get/wait summaries share the same sanitized `responseDebug` representation.
- **Integration coverage:** real stdio MCP tests cover result size; HTTP tests cover artifact ownership, run persistence, and provider-slot reuse; controller tests cover DOM decisions.
- **Unchanged invariants:** capture and artifact-inventory completeness remain independent; success still requires receipt-backed output; mode downgrade detection and final label trust remain active.

# Disconfirming Evidence

- If a large MCP read still contains the full transcript in `structuredContent`, U1 is not complete.
- If preview length changes capture byte budget or masks a partial capture reason, U1 is not complete.
- If a durable controller promise can remain unsettled beyond the hard deadline and final capture window, U2 is not complete.
- If a terminal failure lacks durable diagnostics or its slot remains leased, U3 is not complete.
- If an unsupported or malformed power observation can send a prompt, U4 is not complete.

# Bug Trace Cross-Check

| Bug / requirement | Contract clause | Expected behavior | Match? |
|---|---|---|---|
| Large transcript middle is unreachable | R1, U1 | One call returns a verified path to the complete rendered capture plus a bounded preview | Yes |
| `maxChars` silently hides coverage | R2, O1 | Preview truncation and capture completeness are separate and counted | Yes |
| Durable run loops forever | R3, O3, U2 | Absolute hard deadline ends observation | Yes |
| Real answer can exist outside ordinary selector | R4, O4, U2 | One final complete structured capture may recover it | Yes |
| Provider slots remain leased | R5, U3 | Controller terminates first; existing owner releases and persists released state | Yes |
| Waiter timeout is opaque | R6, U3 | Latest snapshot and content-free diagnostics return with a wait-timeout marker | Yes |
| Pro slider at index 4 is rejected without trigger | R7, U4 | Exact supported target index confirms independently | Yes |
| Fail-closed mode policy must remain | R8, U4 | All ambiguous observations still fail before send | Yes |

# Build Execution Contract

- **Closed decisions:** Always persist non-empty rendered conversation reads; keep the artifact local and private; use a bounded preview; keep the soft response phase plus an absolute hard deadline; perform at most one final structured recovery; release provider slots only after controller settlement; accept only exact supported slider evidence.
- **Builder autonomy:** Choose local helper placement, unique transcript filename shape, and exact content-free diagnostic field ordering. Record any choice not fixed here.
- **Verify at contact:** `ensureArtifactsDir` produces an owned tab directory → verify before writing → if false, stop U1 without publishing a path. `captureConversation` can be called safely inside response ownership → verify no nested mutex or compatibility recursion → if false, use the internal structured capture primitive under the current owner. Run summary views include newly normalized fields → verify after reload → if false, repair normalization rather than adding an MCP-only side channel.
- **Stop conditions:** Stop only if complete transcript rendering cannot be obtained without mutating the provider conversation, if final structured capture cannot preserve controller ownership, or if a required change would publish files outside Agentify's artifact root.
- **Authority boundaries:** Do not use production secrets, destructive cleanup, or external account mutation. Local fixtures and the existing authenticated warm browser may provide runtime evidence; if the live provider is unavailable, complete deterministic tests and report the live evidence gap.
- **Expected gate map:** U1: transcript contract/controller/HTTP/MCP integration green. U2: controller response tests green. U3: run-store/waiter/HTTP/MCP integration green. U4: picker primitive/controller tests green. Final: full `npm test` green and `/gate` dry.
- **Pause warrants:** none; all four units have deterministic auto checks and no result requires replanning the remaining units.

# Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Transcript artifacts retain sensitive conversation text | Private artifact root, mode `0600`, owned-path validation, hash/read-back verification, and explicit documentation. |
| A hard deadline cuts off an unusually late valid answer | Preserve a five-to-ten-minute grace after the caller's soft timeout and perform one final exact structured recovery. |
| Final recovery mistakes old content for the new answer | Require complete capture plus provable advancement from pre-send assistant baseline. |
| Diagnostic persistence leaks response content | Exact versioned content-free projection; tests reject text fields. |
| Slider acceptance weakens mode safety | Gate on exact `0..4` scale, mapped target index, visible control, and existing label trust; negative fixtures cover malformed states. |
