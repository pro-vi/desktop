---
title: Token-Cost Lever Defaults
objective: Cut the tokens agent callers burn per query and per read by moving the MCP surface's inline-payload defaults from unbounded to bounded-preview, without removing any capability an explicit parameter already offers.
type: feat
status: completed
date: 2026-09-15
origin: docs/token-cost-paths.md (L1, L2, L4, L5; conversation 2026-09-15)
---

# Token-Cost Lever Defaults

## Background

`docs/token-cost-paths.md` measured where calling agents' tokens go (baseline 2026-09-15, n=1,832 runs, 96% MCP-driven): `agentify_wait_run` returns saved response text by default with a 200,000-char ceiling (P-INLINE-OUTPUT, up to ~50k tokens in one call), the sync `agentify_query` result ships the full text in both `content[0].text` and `structuredContent.text` plus `codeBlocks` repeating code already in the text (P-SYNC-DUP), `agentify_read_page` defaults to 200,000 chars of page text (P-READ-PAGE), and every wait result embeds `responseDebug`/`recovery` JSON even on success (P-WAIT-NOISE).

Verified at planning time: `agentify_get_run` already defaults to no inline output (`includeOutputText: !!includeOutputText`, mcp-server.mjs:1508), so L1's change is scoped to `agentify_wait_run` (mcp-server.mjs:1541, `includeOutputText: includeOutputText !== false`, `maxOutputChars` passed through undefined → HTTP default 200,000). The read_page default is the MCP-layer `maxChars: maxChars || 200_000` at mcp-server.mjs:979. No in-repo consumer reads `structuredContent.text`; the only occurrence is the producer itself (mcp-server.mjs:913).

## Requirements

- **R1:** A `agentify_wait_run` success returns, by default, a bounded preview of the saved response plus the artifact path and its hash; the full text remains available through the existing explicit parameters.
- **R2:** A sync `agentify_query` result carries the response text exactly once across `content` and `structuredContent`, and code appears either in the text or in `codeBlocks`, not both.
- **R3:** `agentify_read_page` returns at most 20,000 characters unless the caller passes a larger `maxChars`.
- **R4:** Wait-result diagnostics (`responseDebug`, `recovery`) appear on non-success outcomes, not on successful waits; they remain persisted on the run record either way.

## Naming Ledger

Naming pass: no new or renamed architectural vocabulary. The plan reuses the existing `maxOutputChars`, `includeOutputText`, and `maxChars` parameters and the existing truncation-marker mechanics in `runStatusText`.

## Architecture Decision

**Approach:** Move defaults inside the MCP layer only, reusing the existing parameter and truncation plumbing rather than adding new parameters or a separate preview mode. `agentify_wait_run` keeps `includeOutputText` defaulting to true but defaults `maxOutputChars` to 2,000, so the existing `outputTruncated` marker and artifact path flow through unchanged; full text is the existing explicit `maxOutputChars` opt-up. The sync query result keeps the full text in `content[0].text` (what clients ingest) and slims `structuredContent` to metadata. `agentify_read_page` drops its MCP default from 200,000 to 20,000. `runStatusText` gates its diagnostic lines on the run not being a success.

**Rationale:** Consistency and simplicity — every mechanism already exists (`maxOutputChars` truncation with an explicit marker, the artifact path in the result, `runStatusText` line assembly); the change is default placement, not new code paths. A preview default beats flipping `includeOutputText` to false because callers keep the wait-returns-the-answer ergonomics every existing prompt teaches, while the worst-case call drops from ~50k to ~0.5k tokens. The rejected alternative — HTTP-layer default changes — would alter the direct-API contract for non-MCP consumers for no measured benefit; the cost lives in the MCP surface (96% of runs).

**Trade-offs:** External MCP callers that relied on unbounded inline text must now pass `maxOutputChars` (or read the artifact path every result already carries); callers reading `structuredContent.text` lose that copy. These are default movements, not removals — every capability remains one explicit parameter away.

**Approval criteria:** A reviewer agrees that bounded-preview defaults with explicit opt-up preserve capability while cutting the measured worst cases; that the sync result carrying text exactly once is safe given no in-repo consumer reads the structured copy; and that HTTP-layer defaults stay unchanged.

## Program Obligations

- **O1:** Every default this plan moves remains explicitly overridable by its existing parameter, and every truncation surfaces the existing explicit marker plus the artifact path — a caller can always tell the text was cut and where the whole thing lives. No silent cuts, no removed parameters.

## Implementation Units

### U1. Bounded wait_run preview default

- **Goal:** Make a successful `agentify_wait_run` return a ~2,000-char preview with truncation marker and artifact path by default; full text via explicit `maxOutputChars`.
- **Requirements:** R1
- **Dependencies:** None
- **Files:**
  - Modify: `mcp-server.mjs` (wait_run handler ~1536-1541 and its schema descriptions)
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
  - Modify: `docs/token-cost-paths.md` (L1 status)
- **Approach:** Pass `maxOutputChars: maxOutputChars || 2_000` in the `waitForRun` call; leave `includeOutputText` semantics untouched; update the tool's parameter descriptions to state the 2,000 default and name the opt-up. The HTTP `/runs/wait` default stays 200,000 for direct consumers.
- **Patterns to follow:** `tests/mcp-tool-profile-integration.test.mjs:379` — stub-server wait test asserting result shape via `callTool`.
- **Test scenarios:**
  - *Happy path:* successful wait over a stub run whose saved output exceeds 2,000 chars → result text ends with the existing `[output truncated at 2000 chars]` marker, carries `outputPath`, and `structuredContent.outputText` is the truncated preview.
  - *Edge case:* output shorter than 2,000 chars → full text, no truncation marker.
  - *Opt-up:* `maxOutputChars: 200000` passed → full text as today.
  - *Timeout path:* wait timeout still returns `responseDebug` diagnostics (guards U4's boundary from the other side).
- **Verification:** Stub-server wait tests green showing preview default, marker, path, and opt-up; L1 status in the tracker reads `shipped <commit>`.
- **Checkpoint:** auto — the stub-server wait tests pass, including the opt-up and timeout scenarios.

### U2. Single copy of the sync query response

- **Goal:** The sync `agentify_query` result carries the response text once (in `content[0].text`) and `structuredContent` carries metadata only.
- **Requirements:** R2
- **Dependencies:** None
- **Files:**
  - Modify: `mcp-server.mjs` (sync return ~905-915)
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
  - Modify: `docs/token-cost-paths.md` (L2 status)
- **Approach:** Remove `text` and `codeBlocks` from the sync return's `structuredContent`; keep `runId`, `meta`, `recovery`, `packedContextSummary`, `bundle`, `tabId`. The async (fire-and-forget) return is already metadata-only and stays untouched. Update the tool description to say the response text is the content block.
- **Patterns to follow:** `agentify_read_conversation`'s split (text block carries prose; `structuredContent` carries metadata, tests assert `'text' in structuredContent === false`) — `tests/mcp-tool-profile-integration.test.mjs:373-375`.
- **Test scenarios:**
  - *Happy path:* sync query → `content[0].text` holds the full response; `structuredContent` has no `text` and no `codeBlocks` keys.
  - *Edge case:* fire-and-forget return unchanged (runId + guidance text only).
  - *Error path:* tool error shape unchanged.
- **Verification:** Integration test asserts the single-copy shape; L2 status `shipped <commit>`. Client-side token saving stays conditional on client ingestion (tracked as residual in the tracker, not claimed here).
- **Checkpoint:** auto — integration test asserting the single-copy shape passes.

### U3. read_page default ceiling

- **Goal:** `agentify_read_page` returns at most 20,000 characters unless the caller asks for more.
- **Requirements:** R3
- **Dependencies:** None
- **Files:**
  - Modify: `mcp-server.mjs` (~979)
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
  - Modify: `docs/token-cost-paths.md` (L4 status)
- **Approach:** `maxChars: maxChars || 20_000` in the tool's request body plus description update; HTTP `/read-page` default stays 200,000.
- **Patterns to follow:** `agentify_read_conversation`'s 20,000 default at `mcp-server.mjs:1015`.
- **Test scenarios:**
  - *Happy path:* read_page without `maxChars` → stub receives `maxChars: 20000` (assert on the captured request body, mirroring the existing assertion pattern at `tests/mcp-tool-profile-integration.test.mjs:369`).
  - *Opt-up:* explicit `maxChars: 150000` forwarded verbatim.
- **Verification:** Request-body assertions green; L4 status `shipped <commit>`.
- **Checkpoint:** auto — request-body assertions pass.

### U4. Diagnostics only on non-success waits

- **Goal:** Successful wait results stop embedding `responseDebug` and `recovery` JSON; timeouts and errors keep them.
- **Requirements:** R4
- **Dependencies:** None
- **Files:**
  - Modify: `mcp-server.mjs` (`runStatusText` ~105-126)
  - Test: `tests/mcp-tool-profile-integration.test.mjs`
  - Modify: `docs/token-cost-paths.md` (L5 status)
- **Approach:** Gate the `responseDebug` and `recovery` lines on the run's status not being `success`; the structured payload and the persisted run record keep both fields regardless, so post-mortems lose nothing.
- **Patterns to follow:** The existing timeout test asserting diagnostics presence (`tests/mcp-tool-profile-integration.test.mjs:507-510`) — extend with the success-path absence.
- **Test scenarios:**
  - *Happy path:* successful wait → text contains status/label/output lines, no `responseDebug=` line.
  - *Error path:* error-status wait → diagnostics present.
  - *Timeout path:* existing timeout assertions unchanged (diagnostics present).
- **Verification:** Success-wait leanness and timeout/error diagnostic tests green; L5 status `shipped <commit>`.
- **Checkpoint:** auto — both diagnostic-presence and diagnostic-absence tests pass.

## Scope Boundaries

- L3 (core tool profile for sessions) — bootstrap config change, tracked in `docs/token-cost-paths.md`, not this repo's code.
- Prompt-side packing policy (P-PROMPT) — caller-side decision, open in the tracker.
- HTTP-layer defaults (`/runs/wait`, `/runs/get`, `/read-page`) — unchanged; only the MCP layer's defaults move.
- No new parameters, no schema redesign, no prompt/telemetry beyond the existing usage counter.

### Deferred to Follow-Up Work

- None — every lever the batch names is a unit above; the two out-of-scope levers already have their durable record in `docs/token-cost-paths.md`.

## System-Wide Impact

- **Interaction graph:** MCP callers (agent sessions) are the only affected consumers; HTTP direct consumers are untouched by design.
- **Error propagation:** unchanged — truncation surfaces the existing marker; diagnostics move from success texts to the persisted record they already inhabit.
- **State lifecycle risks:** none — no persisted state changes; defaults are per-call.
- **API surface parity:** `agentify_get_run` already defaults conservatively and needs only description accuracy if its wording drifts; the async query return is already metadata-only.
- **Integration coverage:** stub-server `callTool` tests cover each wire shape end-to-end through the real stdio transport.
- **Unchanged invariants:** receipt-backed completion, run-record immutability, the usage counter, and every explicit parameter's semantics.

## Build Execution Contract

- **Closed decisions:** preview default over flipping `includeOutputText` to false; text lives in `content[0].text`, `structuredContent` is metadata-only; HTTP defaults unchanged; read_page MCP default 20,000.
- **Builder autonomy:** exact description wording; test fixture details; tracker status phrasing.
- **Verify at contact:** line numbers in this plan shift — locate handlers by code shape (`includeOutputText: includeOutputText !== false`, `maxChars: maxChars || 200_000`, the `runStatusText` line assembly), not by line number. Confirm no new in-repo consumer of `structuredContent.text` has appeared since 2026-09-15 (grep; fallback if found: leave that consumer's expectation explicit in a test before slimming).
- **Stop conditions:** a same-runtime consumer of the slimmed fields exists and cannot be updated within this plan; or a moved default cannot be expressed through its existing parameter.
- **Authority boundaries:** none — all verification is deterministic stub-server tests; no live provider calls, no consented probes.
- **Expected gate map:** U1 → wait tests green (preview, marker, opt-up, timeout diagnostics); U2 → single-copy query test green; U3 → request-body assertions green; U4 → diagnostic presence/absence tests green; end → full `npm test` green. No permitted temporary failures.
- **Human inventory:** none — every contribution is deterministic and within builder authority.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| External callers depend on unbounded wait text | Explicit `maxOutputChars` opt-up unchanged; every result carries the artifact path; tracker records the default movement date |
| External callers read `structuredContent.text` | No in-repo consumer exists; description names the text's home; breaking note in tracker |
| Preview hides a needed tail of a long answer | Truncation marker is explicit; artifact path and hash in the same result; `get_run`/re-read available |
| Tool-description drift confuses agents | Each unit updates its tool's parameter descriptions in the same commit |
