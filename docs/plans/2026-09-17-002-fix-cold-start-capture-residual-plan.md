---
title: Cold-Start Capture Residual
objective: The first read or query after the app spawns captures the real page state — never an empty transcript or a chrome-polluted node — without callers retrying.
type: fix
status: completed
date: 2026-09-17
origin: conversation 2026-09-17 (probe run 1 + CLAUDE.md 2026-08-03 note); evidence docs/probes/2026-09-17-turn-identity-gate-probe.md, CLAUDE.md "Do not trust the first call after agentify_shutdown"
---

# Cold-Start Capture Residual

## Background

Two observed cold-start shapes, both live-recordited, both caused by nothing gating a capture against a still-hydrating ChatGPT page:

- **Empty** (2026-08-03, CLAUDE.md): `agentify_read_conversation` ~3s after tab creation returned `messageCount: 0` while the tab sat on the right conversation URL; readiness recorded `fail`/`anchor-postcondition-failed` but gates nothing (`runCompatibilityCapability` still returns the result, chatgpt-controller.mjs:629); the warm rerun returned all messages. `#captureConversationBundle` returns immediately when its first `readMessages()` is empty (`conversation_messages_not_found`, no retry).
- **Polluted** (2026-09-17 probe run 1): the query wait loop matched ONE assistant node whose `innerText` was the whole page section — prompt echo, `Worked for 9s`, footer, the answer, `Pro`. `selectors.json`'s `assistantMessage` includes broad containers (`model-response`, `[data-testid="chat-message"]`, …) and the loop takes the last match verbatim with no role narrowing (warm pages work only because the narrow role-attributed node sorts after its container ancestor). The completing snapshot also showed the unguarded contradiction stop-visible + sendFound + sendEnabled, under which `generating` is false and `stopGoneAt` accumulates while the stop is still on screen.

Verified at planning time (2026-09-17, two Explore maps, current HEAD `35e07a5`): readiness proves only `promptVisible` (composer shell) and never inspects the transcript; the structured capture DOES narrow by `data-message-author-role` via the uiContract exemption selector (`#transcriptDependencySelector`); no networkidle/readystate/settle gate exists anywhere between navigation and capture; `/read-conversation` without `chatUrl` has no gate at all; no per-tab warm state exists. Boot: `loadURL` resolves at did-finish-load, `ensureDesktopRunning` returns once `/health` answers — both before hydration completes.

## Requirements

- **R1:** A query wait completes only on a role-qualified assistant node on pages where the chatgpt UI contract supplies the message-role selector; a page presenting only broad containers keeps waiting until the role-attributed node mounts (bounded by existing timeouts/recovery).
- **R2:** A conversation read on a canonical conversation URL waits (bounded) for the first message to mount before reporting `conversation_messages_not_found`.
- **R3:** "Stop gone" timing never starts while a stop control is still visible.
- **R4:** Vendors or contract states without the message-role selector keep today's verbatim behavior, and the result meta/debug records which node basis was used.

## Naming Ledger

Naming pass: no new or renamed architectural vocabulary. The qualified-node fields reuse the transcript contract's existing tokens (`providerMessageId`, the `data-message-author-role` family, `#transcriptDependencySelector`'s dependency keys); new eval fields follow the existing snake-less snapshot idiom (`qualifiedCount`, `qualifiedProviderMessageId`).

## Architecture Decision

**Approach:** Fix at the capture surfaces, not readiness. (1) The wait-loop poll eval and the pre-send assistant-state eval compute a *qualified* assistant node set — matches of the verbatim selector that themselves carry `data-message-author-role="assistant"` — alongside the verbatim matches; the controller prefers the qualified set whenever it is non-empty, treats zero-qualified-with-nonzero-verbatim as zero nodes when the role dependency selector resolves (chatgpt contract), and falls back to verbatim matches otherwise (vendor degradation). (2) `#captureConversationBundle` polls its first `readMessages()` on a bounded window (~10s, 500ms interval) when the initial read is empty and the URL is a canonical conversation, then returns today's not-found result. (3) `stopGoneAt` resets while a stop control is visible (`generating || activeStop`).

**Rationale:** Consistency — the structured capture already narrows by role through the same uiContract machinery; this routes the loop's node pick through the same authority instead of inventing a second classifier. Rejected alternatives: teaching readiness a transcript-hydration notion (readiness proves the composer and must not block new conversations, which have no transcript); retrying captures at the HTTP layer (two handlers, asymmetric gates — the defect is below both); a text-based chrome detector (the progress-only-label trap of ADR 0007: string classification of provider chrome reopens every UI change).

**Trade-offs:** On pages whose role attributes never mount, chatgpt-contract queries now run to their existing timeout/recovery instead of completing on a container (fail-closed, same direction as ADR 0009); genuinely-broken conversation reads take the bounded window before failing; the qualified-basis field adds one line to meta/debug.

**Approval criteria:** a reviewer agrees that (a) role-qualification through the existing uiContract dependency is the right authority for "which node is the assistant reply", (b) the bounded first-message wait belongs inside the capture bundle rather than the HTTP handlers, and (c) the stopGoneAt reset is semantically correct independent of the send state.

## Program Obligations

- **O1:** Zero-qualified-nonzero-verbatim pages fail closed (wait) only while the chatgpt contract resolves the message-role dependency; every other contract state keeps today's verbatim behavior, and the active basis is observable in the result meta and wait-debug record.

## Implementation Units

### U1. Role-qualified assistant nodes in the wait loop

- **Goal:** Query capture completes only on a role-qualified assistant node on chatgpt-contract pages; the poll and pre-send evals expose the qualified set; meta/debug record the basis.
- **Requirements:** R1, R4
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs` (poll eval ~:6184, pre-send eval in `#readPreSendAssistantState` ~:6067, done-path selection, meta/debug fields)
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** Both evals add `qualifiedCount`/`qualifiedProviderMessageId` computed from the same `querySelectorAll` result filtered to nodes carrying the role attribute (dependency selector via `#transcriptDependencySelector` for the role family — verify the exact dependency key at contact; the structured capture's usage at ~:1099-1110 is the pattern). Controller prefers qualified (`qualifiedCount > 0` → count/txt/id from the qualified last node); when verbatim count > 0 but qualified is 0 AND the role dependency resolved → treat as count 0 (keep waiting); when the dependency did not resolve → verbatim behavior. Existing fixtures return no qualified fields → undefined → degradation path → no churn.
- **Patterns to follow:** the structured capture's role filter (~:1498) and `#transcriptDependencySelector` usage (~:1099-1110).
- **Test scenarios:**
  - *Witnessed red / oracle:* fake page where polls 1–5 return only a broad container (count 1, qualifiedCount 0, container text = chrome + answer) and poll 6+ the role-attributed node (count 2, qualifiedCount 1, clean text) — pre-send fixture models the same shape. Assert completion text is the clean node's text; on current code this red is the probe run-1 shape (completes on the container).
  - *Degradation:* vendor page, dependency unresolved, qualifiedCount absent/0, verbatim count 2 → completes as today; meta records the verbatim basis.
  - *Never mounts:* qualified stays 0, container present, chatgpt contract → runs to timeout (non-durable) / recovery (durable), never a container capture.
  - *Warm path:* existing wait-loop tests stay green with no fixture changes (no qualified fields → fallback).
- **Verification:** oracle green; degradation and never-mount tests green; full controller file green with zero fixture churn.
- **Checkpoint:** auto — controller file green including the oracle.
- **Runtime evidence:** `unverified — in-page qualified-set computation executes only live; deterministic tests exercise the controller's preference logic over the snapshot fields.`

### U2. Bounded first-message wait in the capture bundle

- **Goal:** A conversation read waits for the transcript's first message before reporting not-found.
- **Requirements:** R2
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs` (`#captureConversationBundle` empty-initial branch ~:2227)
  - Test: `tests/chatgpt-controller.test.mjs` (vm-based page doubles if the bundle eval must execute; else the plain harness's capture dispatch)
- **Approach:** When `initial.length === 0` and the current URL parses as a canonical conversation, re-run `readMessages()` every ~500ms up to ~10s inside the bundle eval's host deadline; on timeout return today's not-found result unchanged (same reason codes, same shape).
- **Patterns to follow:** `waitForPromptVisible`'s 500ms poll cadence; the bundle's existing `generationActive` distinction (`conversation_generation_active` vs `conversation_messages_not_found`).
- **Test scenarios:**
  - *Happy path:* first two readMessages calls empty, third returns messages → capture proceeds normally (would have failed not-found today).
  - *Error path:* never any messages → not-found after the bound, same reason as today.
  - *Edge:* non-conversation URL (home page) → no wait, immediate today-behavior.
- **Verification:** the three scenarios green; existing capture tests unchanged.
- **Checkpoint:** auto — capture tests green.
- **Runtime evidence:** `unverified — the hydration window's real duration is known only live; the bound is a planner default the builder may tune (record the chosen value).`

### U3. stopGoneAt never accumulates while the stop is visible

- **Goal:** "Stop gone" timing starts only when no stop control is visible.
- **Requirements:** R3
- **Dependencies:** None
- **Files:**
  - Modify: `chatgpt-controller.mjs` (~:6365)
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** One clause: reset `stopGoneAt` when `generating || activeStop`; add the contradiction snapshot (stop visible + sendFound + sendEnabled) as a test fixture asserting no completion while the stop stays visible and completion after it disappears.
- **Patterns to follow:** the existing `generating` comment block's evidence-only-blocking discipline.
- **Test scenarios:**
  - *Happy path:* stop visible with send enabled, text stable 3s → no completion; stop disappears → completes.
  - *Warm path unchanged:* normal stop-then-send cycles complete as today (existing tests).
- **Verification:** both green; no existing test changes.
- **Checkpoint:** auto — controller file green.
- **Runtime evidence:** omit — pure controller-logic change with deterministic tests.

### U4. Consent-gated cold-start probe

- **Goal:** Live confirmation across a real spawn: an immediate read and an immediate query capture real page state.
- **Requirements:** R1, R2
- **Dependencies:** U1, U2, U3
- **Files:**
  - Modify: `docs/probes/` (new record), `CLAUDE.md` (the cold-start warning section)
- **Approach:** Kill the app by PID, respawn via `ensureDesktopRunning`, then immediately (no warm-up): read the probe tab's conversation and issue one short numeric query on a disposable keyed tab; assert the read is non-empty and the query capture is a clean role-qualified node; record per-run debug (qualified basis, ids). Update CLAUDE.md's warning to state what is now guaranteed vs. still advised.
- **Patterns to follow:** the 2026-09-17 turn-identity probe procedure.
- **Test scenarios:**
  - *Happy path:* immediate read_conversation returns all messages; immediate query captures the clean answer text with qualified basis recorded.
  - *Falsifier:* any empty or chrome-polluted immediate capture reopens the plan.
- **Verification:** probe record written; CLAUDE.md updated truthfully.
- **Checkpoint:** gate — scoped consent (below) granted → run → both immediate captures clean: continue. Consent withheld → mark unverified, ship U1–U3 (deterministic evidence stands), keep the CLAUDE.md warning as-is.
- **Runtime evidence:** `unverified — the probe is this unit's evidence; runs only under the consent grant.`

## Scope Boundaries

- Readiness/`prepareChatEntry` semantics unchanged (composer-based; correct for send paths).
- HTTP handler structure unchanged (no new gates in `/read-page`//`read-conversation`; the fix is below them).
- The compatibility anchor `anchor-postcondition-failed` observation flow unchanged (it gates nothing by design; not this defect).
- `#readDeepResearchText`, `readPageText` chrome handling, and ADR 0007/0009 vocabularies untouched.

### Deferred to Follow-Up Work

- Per-tab warm/cold state or first-capture warm-up at boot — no consumer needs it if capture-side gating lands; revisit only if the probe shows residual windows.

## System-Wide Impact

- **Interaction graph:** one shared wait loop (query/research/image/recovery) inherits qualification; capture bundle changes affect `readConversationText` and transcript sync (same bundle).
- **Error propagation:** unqualified pages fail closed to existing timeout/recovery paths — never a silent polluted success.
- **State lifecycle risks:** none new; no persisted state changes beyond additive meta/debug fields.
- **API surface parity:** no endpoint or schema changes; `parseResponseDebug` whitelist gains the basis fields if added to the debug record.
- **Integration coverage:** deterministic oracle + degradation tests; U4 exercises the real hydration window.
- **Unchanged invariants:** receipt integrity, completion-evidence vocabulary, turn-identity gate (ADR 0009) — qualification composes with it.

## Build Execution Contract

- **Closed decisions:** qualification via the existing role dependency selector with strict chatgpt behavior and vendor degradation; the bounded wait lives inside the capture bundle; stopGoneAt reset; no readiness changes.
- **Builder autonomy:** the exact poll interval and bound values (planner defaults 500ms / ~10s); eval field names beyond the qualified* prefix; fixture details; probe-record phrasing.
- **Verify at contact:** line numbers shift — locate by code shape (`readMessages()` initial-empty branch, the poll eval's `qualifiedCount` insertion point, `stopGoneAt = null`). Confirm the exact uiContract dependency key for the role selector (the structured capture's usage names it). Confirm `parseResponseDebug` covers any new debug fields (extend the whitelist as done for the turn-identity fields).
- **Stop conditions:** the role dependency cannot be resolved through `#transcriptDependencySelector` for the chatgpt contract (then the exemption must be added, a compat-contract change — surface, don't improvise); or the bundle eval cannot loop without breaking its host-deadline shape.
- **Authority boundaries:** U4's live restart + immediate read + one query requires the scoped consent; without it, ship deterministic and mark unverified.
- **Expected gate map:** U1 → controller file green with the oracle and zero fixture churn; U2 → capture tests green; U3 → contradiction test green; U4 → probe record. End → full `npm test` green. No permitted temporary failures.
- **Human inventory:** one *consent* item — U4: kill and respawn the local app (only this machine's instance, by PID), immediately read one existing conversation and send one numeric query on a disposable keyed tab, read run records, close the tab. Resolved upfront if possible; withheld → U4 skipped-and-marked, nothing else blocks.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| ChatGPT role attributes land later than the timeout on very slow loads | Bounded by existing durable timeout + structured recovery, which has its own role-based proof |
| Qualification stalls a vendor that uses broad containers legitimately | Strictness applies only when the role dependency resolves (chatgpt contract); vendor path unchanged and tested |
| Bundle wait adds latency to genuinely-broken reads | Bounded ~10s, only on canonical conversation URLs |
| Fixture harness can't express in-page qualification | Controller-side preference logic is field-driven; fixtures model qualified/verbatim fields directly |
| Probe restart disrupts a concurrent session | App is idle-verified before kill (recent-traffic check), restart is the supported shutdown/respawn cycle |
