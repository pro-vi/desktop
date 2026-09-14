---
title: ChatGPT Final-Output Qualification and Page-Read Provenance
objective: Make unattended callers receive successful ChatGPT runs and page reads only when Agentify can identify a completed output and the page that supplied it.
type: fix
status: active
date: 2026-09-14
origin: conversation
---

# ChatGPT Final-Output Qualification and Page-Read Provenance

## Background

An inbox report recorded three ChatGPT runs that became receipt-backed `success` while the saved text was a transient `Pro thinking` label or a Deep Research planning panel. It also recorded `agentify_read_page` returning another conversation despite a requested key/tab. The observed application build was not captured, so the report proves the failure was observed but cannot identify which source revision ran.

The current source confirms both unsafe paths. `ChatGPTController.#waitForAssistantStable()` treats a stable nonempty assistant node as final output, while `http-api.mjs` writes and receipts any nonempty result. Deep Research also accepts changed nested-frame text without requiring its native completion marker when it no longer detects thinking. Separately, `/read-page` gives `tabId` resolution priority but can use a different supplied `key` to restore the resolved tab's route, and it returns text without served-page provenance.

## Requirements

- **R1:** A query or research run reaches `success` only after Agentify has qualified its capture as final output for that run.
- **R2:** Transient UI states, including `Pro thinking` and a Deep Research plan, keep the run live or lead to its existing non-success terminal path; they never create an output artifact, receipt, or `success`.
- **R3:** Qualification uses provider-specific terminal evidence, not output length, elapsed time, or a broad word match that rejects a real answer discussing thinking or research.
- **R4:** The existing receipt remains the proof that the selected final artifact was written, readable, registered, and hashed; it is not repurposed as a text-classification heuristic.
- **R5:** `agentify_read_page` rejects contradictory explicit `tabId` and `key` selectors before navigation or reading.
- **R6:** A successful page read exposes resolved tab identity and served URL to MCP callers while preserving its current plain-text content.
- **R7:** Key-only page reads, tab-only page reads, query logical-key aliases, existing run lifecycle statuses, and receipt kind parity remain unchanged.

## Naming Ledger

| Role / meaning | Existing repo term | Chosen name | Owner / placement | Status | Second consumer / reason | GR6 sibling disposition |
|---|---|---|---|---|---|---|
| Controller decision that a captured provider surface is final rather than progress | `completionReceipt`, `responseDebug` | `completion evidence` | `chatgpt-controller.mjs`, returned in controller result metadata | new | `http-api.mjs` accepts it before artifact creation; controller tests lock its sources | `completionReceipt` remains artifact-integrity evidence, not a rename |
| URL of the document actually read under the resolved tab lease | `servedUrl` in query routing | `servedUrl` | `/read-page` HTTP response and MCP structured content | reuse | `mcp-server.mjs` forwards it to callers | no asymmetry; reuse the existing route term |

## Architecture Decision

**Approach:** Make the ChatGPT controller the sole authority that qualifies a captured surface as final output. It returns completion evidence only for a final assistant answer, a Deep Research surface carrying ChatGPT's native research-complete marker, or an already-complete structured conversation recovery. HTTP accepts only that evidence before it writes a canonical response artifact or creates a receipt. Keep the receipt v1 shape: it remains an artifact-integrity record whose construction is now gated by qualified controller output.

For ordinary queries, classify only narrow, known progress-only assistant-node labels as transient; do not use a character floor or a broad `thinking` substring. For Deep Research, a changed nested frame is progress until the native completion marker appears. Apply the same qualification to the structured-recovery tail so recovery cannot bypass the boundary. If no final capture appears, preserve the current reconciliation/timeout failure path rather than converting a transient surface into success.

For `/read-page`, treat `tabId` plus `key` as two claims about one target. When both are supplied and the listed tab's key differs, return a selector-conflict 4xx response before controller work. When they agree, or when only one is present, read under the existing exclusive lease and return the resolved tab ID, resolved key, and `servedUrl` observed after any route restoration and read. MCP keeps its text content and adds that provenance as structured content.

The rejected alternative is adding length thresholds or a growing placeholder regex at receipt creation. It would duplicate provider semantics after the controller has discarded its observation context, would reject valid short answers, and would leave new UI states able to become receipts. The existing `looksLikeResearchPlaceholder()` remains only until its caller is replaced; it is not a second terminal classifier.

**Trade-offs:** Unknown future transient UI surfaces now fail closed into continued observation or a non-success timeout, which can delay a caller instead of returning incorrect text. Live verification remains necessary because the report did not capture the affected build or DOM shape.

**Approval criteria:** A reviewer agrees that controller qualification, not a file hash, decides semantic completion; Deep Research needs its own terminal signal; and page-read callers can prove the page they received or receive a selector conflict.

## High-Level Technical Design

*Directional guidance for review, not implementation specification.*

```text
ChatGPT DOM / nested research frame
          |
          v
controller observation -- transient --> keep observing / existing timeout path
          |
          +-- qualified final + completion evidence --> HTTP output finalizer
                                                        |
                                                        v
                                             artifact readback + receipt v1
                                                        |
                                                        v
                                                   run success

MCP {tabId?, key?} --> /read-page selector check --> resolved controller lease
                                                     |
                                                     v
                                      {text, tabId, key, servedUrl} --> MCP text + structured content
```

### Completion state-action contract

| Observation action | State | Caller observation | Durable state / side effects | Duplicate or race behavior | Locking test |
|---|---|---|---|---|---|
| Controller sees a known transient assistant label or an incomplete research plan | run live | no final result returned | no response artifact, receipt, or terminal success | later observations may replace the transient surface; existing controller lease stays held | controller regression fixture with transient then final answer |
| Controller sees qualified query answer or completed research report | run live | final result carries completion evidence | HTTP may write the selected artifact, then receipt, then success | run-store terminal-write rules remain authoritative | query and research success fixtures |
| Controller reaches reconciliation deadline without qualified output | reconciling response | existing error/timeout result | no receipt and no success | terminal store state cannot be overwritten by a late local result | existing reconciliation timeout test extended with transient text |
| Artifact write or readback fails after qualification | run live | existing output failure | no receipt; terminal error path | existing serialized finalization prevents a second success | HTTP artifact-failure regression |

Invariant for new output-bearing runs: `status === 'success'` only after qualified completion evidence selected the artifact and a valid receipt was created for that artifact. A transient observation has no artifact or receipt transition. Timing is eventual from provider observation; the explicit intermediate state is the existing live/reconciling run, never `success`.

## Program Obligations

- **O1:** Completion evidence has a closed set of final sources, and every controller path that can return output supplies one; transient, error, and timeout paths cannot fabricate it.
- **O2:** HTTP finalizers reject output that lacks controller completion evidence before response-file creation, receipt creation, compatibility-terminal satisfaction, or durable success.
- **O3:** A page-read result binds text to the resolved tab and post-read served URL; an explicit tab/key disagreement performs no navigation or read.

## Implementation Units

### U1. Controller final-output qualification

- **Goal:** Distinguish final ChatGPT output from transient assistant and Deep Research UI at the one layer that observes provider surfaces.
- **Requirements:** R1, R2, R3, R7
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** Add `completion evidence` to successful controller results and require it in the response capability postcondition. Make known progress-only assistant labels non-final without treating ordinary answer prose as UI chrome. Require the native Deep Research completion marker before nested-frame text can satisfy the report path. Route structured-recovery output through the same qualification rule. Reuse the durable controller predicate and the `743da3b` two-phase regression pattern; do not add a module or dependency.
- **Patterns to follow:** `chatgpt-controller.mjs:6316` — durable content predicate; `chatgpt-controller.mjs:6363` — fail-closed structured recovery; `tests/chatgpt-controller.test.mjs:1160` — transient surface followed by real assistant node.
- **Test scenarios:**
  - *Happy path:* a normal final answer, including text that discusses “thinking,” produces final completion evidence and returns normally.
  - *Edge case:* a `Pro thinking` assistant-node label stabilizes, then a real answer arrives; the controller waits and returns only the answer.
  - *Edge case:* changed Deep Research planning text appears after generation settles; it remains non-final until a completed report marker and report text appear.
  - *Error path:* only transient text through the reconciliation deadline returns the existing non-success result with no completion evidence.
  - *Integration:* structured conversation recovery with a qualified advanced assistant tail succeeds; an advanced transient tail does not bypass qualification.
- **Verification:** Every returned output-bearing query/research result has an allowed final source; all transient fixtures remain live until final output or existing non-success termination.
- **Runtime evidence:** unverified — after deterministic tests, an explicitly authorized live disposable-key probe must record the running source commit/build, observed DOM labels, final result source, saved artifact hash, and run status.
- **Checkpoint:** auto — focused controller tests pass, including all transient non-firing fixtures.

### U2. Qualified artifact and receipt finalization

- **Goal:** Prevent unqualified controller text from becoming a response artifact, receipt, compatibility-terminal success, or durable run success.
- **Requirements:** R1, R2, R4, R7
- **Dependencies:** U1
- **Files:**
  - Modify: `http-api.mjs`
  - Test: `tests/http-api.test.mjs`
- **Approach:** Make query and research finalization require controller completion evidence before writing canonical response files. Select downloaded Research Markdown as canonical only after the controller has observed research completion; remove the narrow placeholder predicate from the success decision so controller and HTTP do not maintain divergent UI-string rules. Keep `completionReceiptForManifest()` and receipt v1 as post-write integrity work; do not migrate `run-lifecycle.mjs`, `run-store.mjs`, or `run-waiter.mjs` unless U1 proves a persisted semantic proof is required.
- **Patterns to follow:** `http-api.mjs:1913` — research output finalizer; `http-api.mjs:1988` — query output finalizer; `http-api.mjs:2071` — artifact readback and hash before receipt; `run-lifecycle.mjs:78` — existing receipt-kind success invariant.
- **Test scenarios:**
  - *Happy path:* qualified query/research output writes a readable artifact, matching-kind receipt, and success.
  - *Edge case:* a completed research run with downloaded Markdown uses that Markdown as the receipt-hashed canonical output.
  - *Error path:* missing or transient completion evidence creates no response artifact, receipt, compatibility satisfaction, or success.
  - *Integration:* a planning-panel fixture without a downloaded report remains non-success; the same report with qualified completion and downloaded Markdown succeeds.
- **Verification:** HTTP cannot create a success receipt from bare nonempty result text; existing receipt kind and artifact-readback guarantees still pass.
- **Runtime evidence:** unverified — the authorized live probe from U1 confirms the finalizer receives qualified evidence before the artifact is written.
- **Checkpoint:** auto — focused HTTP, lifecycle, and waiter tests pass with receipt kind parity unchanged.

### U3. Page-read selector integrity and provenance

- **Goal:** Make `agentify_read_page` either prove the selected page or reject contradictory targeting input without changing query key-alias behavior.
- **Requirements:** R5, R6, R7
- **Dependencies:** None
- **Files:**
  - Modify: `http-api.mjs`
  - Modify: `mcp-server.mjs`
  - Test: `tests/http-api.test.mjs`
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
  - Test: `tests/mcp-server-names.test.mjs`
- **Approach:** Scope strict `tabId`/`key` consistency to the read-page API. Compare both selectors with `TabManager`'s listed metadata before controller lookup; on disagreement return a named selector-conflict 4xx result and do nothing else. On success, collect the resolved key and controller URL after restoration/read under the existing exclusive lease. Preserve MCP’s text block and forward the complete HTTP read result as structured content. Do not alter `resolveTab()` globally because query intentionally uses logical keys independently of its physical tab.
- **Patterns to follow:** `http-api.mjs:552` — explicit tab resolution precedence; `http-api.mjs:4466` — existing page-read lease; `tab-manager.mjs:140` — key-to-tab authority; `mcp-server.mjs:962` — existing tool forwarding.
- **Test scenarios:**
  - *Happy path:* tab-only and key-only reads return the selected controller's distinct text plus matching tab/key/served URL provenance.
  - *Edge case:* a base-URL keyed tab restores only its own persisted conversation before returning its served URL.
  - *Error path:* explicit tab A plus key B returns selector conflict; neither controller navigates or reads.
  - *Integration:* MCP retains plain text for compatibility and exposes the matching structured provenance.
- **Verification:** Every successful page-read result identifies the tab and URL that supplied its text; a contradictory selector pair cannot mutate either target.
- **Runtime evidence:** unverified — an authorized two-tab probe records requested selectors, returned provenance, and the independently visible URL/text in each tab.
- **Checkpoint:** auto — deterministic two-controller HTTP and MCP integration tests pass; the live probe remains optional and consent-gated.

## Scope Boundaries

- No receipt v2, historical run migration, or new completion-status vocabulary unless implementation proves controller evidence cannot be enforced before receipt creation.
- No output-length or duration threshold.
- No broad NLP/regex classifier for normal assistant prose.
- No global `tabId`/`key` consistency policy for query, research, send, navigation, or their intentional logical-key aliases.
- No claim that the reported September 11 runtime has been reproduced until a build-identified live probe completes.

## System-Wide Impact

- **Interaction graph:** controller completion evidence flows to HTTP finalizers; artifacts, receipts, run store, waiters, and compatibility terminal state remain downstream consumers of a qualified result. Read-page provenance flows HTTP to MCP structured content.
- **Error propagation:** unqualified observations keep observing or use the existing timeout/error path; selector conflict returns before navigation/read. Neither becomes silent success.
- **State lifecycle risks:** no new persisted schema; new runs preserve terminal immutability and receipt-kind parity. The main risk is a too-narrow UI label fixture causing a safe timeout, not a false success.
- **API surface parity:** MCP keeps `content[0].text`; structured page-read metadata is additive. HTTP gains equivalent provenance for direct consumers.
- **Unchanged invariants:** waiters still return success only from receipt-backed run success; query logical-key aliases remain valid; `TabManager` remains the tab/key mapping authority.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| The reported UI labels differ from the unpinned build's current DOM | Lock only observed narrow fixtures, fail closed on them, and record source revision/build in the consented live probe. |
| A normal answer resembles a progress label | Match progress-only state labels, not generic words such as “thinking”; add a non-firing answer fixture. |
| Research completion marker changes | Keep the controller in the existing reconciliation path and report non-success rather than writing planning text; update the marker only from captured live evidence. |
| Added page-read provenance leaks a stale URL | Read `servedUrl` from the resolved controller after restoration/read under the same lease, not from cached tab metadata. |
| Strict selectors break existing logical-key workflows | Limit selector conflict enforcement to `/read-page`; regression-test existing query alias behavior. |

## Disconfirming Evidence

| Claim | Evidence that would disprove it | Required response |
|---|---|---|
| `Pro thinking` is always a transient UI state in the assistant node | A build-identified live capture shows it is a completed answer or a normal answer exactly equal to that label | Revise the narrow transient classifier before release. |
| The Deep Research completion marker distinguishes a report from planning | A captured completed report lacks the marker, or planning contains it | Do not broaden the success predicate; capture a stronger native completion signal first. |
| Explicit tab/key mismatch caused the wrong-page report | A live two-tab probe with matching selectors still returns a different controller URL/text | Trace Electron session/controller binding; do not call selector validation a full root-cause fix. |

## Bug-Trace / Confidence Cross-Check

| Bug / requirement | Contract clause | Planned behavior | Expected behavior | Match? |
|---|---|---|---|---|
| Two Extended Pro runs saved byte-identical `Pro thinking` as success | R1–R3; U1/U2 | transient label has no completion evidence and cannot reach artifact/receipt finalization | wait for actual answer or terminate non-success | yes |
| Deep Research saved its planning panel as `response.md` | R1–R4; U1/U2 | only native completed research output is final; planning creates no receipt | no successful report until actual final report exists | yes |
| Page read returned unrelated older conversation | R5–R6; U3 | contradictory selectors fail; successful reads reveal resolved identity and URL | caller can detect target mismatch rather than trust opaque text | partial — matching-selector runtime fault remains a live probe |

## Build Execution Contract

- **Closed decisions:** Controller owns final-output qualification; receipt v1 remains artifact integrity; Deep Research requires native terminal evidence; `/read-page` alone rejects conflicting explicit selectors and returns provenance.
- **Builder autonomy:** Choose exact local helper placement and narrow observed-label fixtures within `chatgpt-controller.mjs`; reuse existing HTTP error serialization; add no dependency or new file without re-running the naming pass.
- **Verify at contact:** Fetch and inspect `origin/main` before editing because this checkout is behind `743da3b`; re-read controller and HTTP finalization paths; confirm the existing test helper shapes before adding fixtures. If the reported UI cannot be observed, keep the plan's deterministic fixtures and leave live evidence unverified.
- **Stop conditions:** Stop only if current source has already implemented equivalent final-output qualification/provenance, if the necessary controller result cannot be carried to HTTP without a receipt schema decision, or if a change would require sending a real ChatGPT prompt without explicit scoped consent.
- **Authority boundaries:** Do not inspect real prompt/response artifacts or run a live provider probe without explicit consent. Use synthetic controllers and temporary test state for all automated checks.
- **Expected gate map:** U1 → controller regressions green; U2 → HTTP plus lifecycle/waiter receipt tests green; U3 → HTTP and MCP integration tests green. No temporary red state is permitted after its unit.
- **Human inventory:** `live disposable-key probe` — consent + assistance: only needed to verify current ChatGPT UI. Without it, deterministic implementation/tests continue and live DOM-label claims remain unverified; no dependent source edit is held.
