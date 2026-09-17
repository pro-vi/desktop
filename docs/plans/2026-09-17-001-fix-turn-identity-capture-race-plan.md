---
title: Turn-Identity Capture Race Fix
objective: Unattended callers receive the answer to the prompt they sent — never the previous turn's reply wearing a valid receipt.
type: fix
status: active
date: 2026-09-17
origin: /oracle row O1 (handoff emitted 2026-09-15, this conversation); evidence docs/probes/2026-09-14-completion-qualification-probe.md
---

# Turn-Identity Capture Race Fix

## Background

Live probe 2026-09-14 (`docs/probes/2026-09-14-completion-qualification-probe.md`, 3/3 reproduction on project-routed conversations): after send, the stop control alone establishes `newResponseSeen`; the stop disappears and the previous assistant reply's text is stable, so the done condition fires (`stopGoneLongEnough` ≈ 800 ms + `stable` ≈ 1500 ms) before the new reply mounts (observed mount latency: seconds). Prompts "3+3?" / "5+5?" captured `'4'` / `'6'` — the previous answers — as receipt-backed `success` with valid completion evidence. The evidence gate of plan 2026-09-14-001 cannot see this: structurally an assistant node existed; the defect is turn identity, not finality.

Verified at planning time (2026-09-17, Explore agents, current HEAD `f4d1a72`):

- One shared wait loop serves `query()` (normal, image, structured-recovery tail) and `research()` (deep-research marker path): `#waitForAssistantStableImpl`, `chatgpt-controller.mjs:6089`.
- The live poll eval (:6169-6241) returns count/text/stop/send/thinking signals — **no provider message id**. `assistantAdvanced` (:6318) accepts `txt !== preSendText` at unchanged count, which is the channel the race rides.
- The fix's machinery already exists in the same file, used only by the post-timeout recovery tail on durable flows: `#readPreSendAssistantState` reads the pre-send tail node's `data-message-id` (:6073-6076, validated by the same regex as `transcript-contract.mjs:37`), `#captureAssistantBaseline` folds it into `{ kind: 'provider-tail', signature: 'provider:<id>' }` (:6048-6059, durable-only), and `captureExtendsAssistantBaseline` (:144-150) proves a new turn mounted by position of the baseline signature.
- No existing deterministic test simulates a stale previous reply *completing* the run (closest: test:1259 rides the same channel but pins progress-only qualification; test:2075 completes at count 2; test:1878 rejects a baseline-only recovery capture).
- Run 1 of the probe (cold-app chrome capture, answer absent) is the known cold-start residual (CLAUDE.md "Do not trust the first call after `agentify_shutdown`") — a readiness problem, **not** turn identity; out of scope here.

## Requirements

- **R1:** On a page that exposed a pre-send tail provider message id, a query completes on the assistant-node channel only when the completing node's provider message id differs from the pre-send tail id.
- **R2:** The same gate holds for the `research()` flow's assistant-node captures without blocking the deep-research marker path or the structured-recovery tail (which carries its own id proof).
- **R3:** Degradation is explicit and observable: when the pre-send tail had no readable id (vendor or page without the attribute), completion falls back to today's positional/textual advancement and the result records that no provider id was available — never silently.
- **R4:** The completing node's provider message id lands in the controller result meta, so receipts and run records identify which provider turn was captured.

## Naming Ledger

Naming pass: no new or renamed architectural vocabulary. The plan reuses `providerMessageId` (DOM read at :6073, transcript contract at `transcript-contract.mjs:130-138`), the `provider-tail` baseline kind (:6058), `assistantAdvanced` / `newResponseSeen` (:6318/:6330), and the `preSend*` parameter family. The new internal done-condition term and the additive `meta.providerMessageId` field reuse these tokens.

## Architecture Decision

**Approach:** Bring the existing pre-send provider-tail baseline into the live done condition. The pre-send id read stops being durable-only — every `query()`/`research()` send carries `preSendProviderMessageId` into the wait. The live poll eval gains the last assistant node's `providerMessageId` (same attribute + validation as :6073-6076). The done condition gains one term: when a pre-send id exists, the completing node's id must exist and differ; when the pre-send tail had no id, the gate is off and today's advancement logic applies, with the absence recorded in the result meta. The completing node's id is added to `result.meta`. The deep-research marker path and the structured-recovery tail keep their existing proofs and are exempt from the new term.

**Rationale:** Consistency and simplicity — the mechanism is already designed, validated, and live-proven in the same file (the recovery tail's `captureExtendsAssistantBaseline`); the fix routes its input into the earlier decision point instead of inventing a second identity scheme. Rejected alternatives: a content-hash baseline (the probe's run 1 shows pre-send text can be polluted, and hydration changes text without changing identity — the provider's own id is the identity); a hard count-growth gate (brittle under vendor variation, and count growth still cannot prove *which* node was captured); fail-closed require-id-always (would hang every query on a page that never exposes `data-message-id`; the compatibility layer already fails the message-id selector closed for ChatGPT without its exemption, so degradation must be an explicit, observable path, not a hang).

**Predicate semantics:** provider ids are opaque stable strings compared by inequality only; DOM order is the arrival order, so out-of-order arrival is impossible and no comparator is needed.

**Trade-offs:** Existing fake-page fixtures whose pre-send snapshots model a `providerMessageId` must also model poll-snapshot ids (a poll id that equals the baseline now correctly waits) — honest fixture churn in ~23 wait-loop tests. A page that exposes ids pre-send but not at poll time is treated as not-advanced (fail-closed within id-bearing pages; the real page presents the new node's id at mount).

**Approval criteria:** a reviewer agrees that (a) id-inequality is the right advancement proof given the recovery tail already uses it, (b) the no-baseline degradation path is explicit rather than a hang, and (c) the closed completion-evidence vocabulary stays unchanged — the gate tightens *when* `assistant-node` evidence may fire, it does not add a source.

## Program Obligations

- **O1:** Whenever a pre-send tail provider message id was readable, assistant-node completion requires a completing-node id that differs; and whenever that gate is inactive (no pre-send id, deep-research marker path, structured-recovery tail), the result meta makes the active identity basis observable rather than leaving it unstated.

## Implementation Units

### U1. Deterministic oracle — the race reproduced in the fake page

- **Goal:** A fake-page test that reproduces the probe mechanism exactly, asserted against the *correct* outcome; on current code it must fail with the race's signature (the witnessed red), then serve as the regression test.
- **Requirements:** R1
- **Dependencies:** None
- **Files:**
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** Pre-send snapshot `{ count: 1, lastText: '4', providerMessageId: 'msg-old' }`; post-send polls: count stays 1, text '4', stop visible (polls 1-2) then gone, send enabled; the new node (`count: 2, text: '6', providerMessageId: 'msg-new'`) mounts at a later poll. Assert the result text is `'6'` and meta identifies the new turn. Companion negative: the new node never mounts → `timeout_waiting_for_response`, never success. Run both before the fix and record the failure signature (captured `'4'` at unchanged count) — that recorded red is this unit's verification.
- **Patterns to follow:** test:1259 (pre-send `providerMessageId` fixture, delayed mount via mutable poll counters) and test:2075 (pre-existing reply, completion at count 2).
- **Test scenarios:**
  - *Witnessed red:* current code completes with the previous reply's text at unchanged count — observed and recorded before U2 lands.
  - *Happy path (post-fix):* completes with `'6'` and the new turn's identity.
  - *Error path:* no new node ever mounts → timeout, no artifact-worthy success.
- **Verification:** the new test fails on current HEAD for exactly the recorded race signature, with no other suite change.
- **Checkpoint:** auto — the red is observed and its signature matches the probe's mechanism (previous reply text, `count === preSendCount`); then continue to U2 with the test left failing (the suite is red only for this named test until U2).
- **Runtime evidence:** `unverified — run the new test against current HEAD and paste the failure into the build log` (this red is the unit's product).

### U2. The turn-identity gate in the live done condition

- **Goal:** The live loop completes the assistant-node channel only on a node whose provider message id differs from the pre-send tail; degradation is observable; meta carries the completing turn's id.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** U1 (the red is on record)
- **Files:**
  - Modify: `chatgpt-controller.mjs` (pre-send id carried for all flows, poll eval reads the last node's id, done-condition term, meta field)
  - Test: `tests/chatgpt-controller.test.mjs` (fixture churn + new gate tests)
  - Test: `tests/http-api.test.mjs` (only if any fixture asserts the exact shape of `meta` — additive field check)
- **Approach:** Mirror :6073-6076 inside the poll eval (attribute read + regex + `closest(ownerSelector)` fallback); extend `#readPreSendAssistantState`'s callers to pass `preSendProviderMessageId` for non-durable flows too (the read already happens — only the durable-only folding at :6079-6085 gates it); add the done-condition term scoped to the assistant-node completion source, exempting the deep-research marker path and letting the recovery tail keep its own proof; record in meta which basis applied (completing `providerMessageId`, and `null` when the page offered none).
- **Patterns to follow:** `captureExtendsAssistantBaseline` (:144-150) for the comparison's shape; the durable tail's plumbing (:6079-6085) for the baseline carrier.
- **Non-firing table (test scenario contract):**
  - pre-send id exists + completing id equals it → **must not complete** (the race).
  - pre-send id exists + completing id is null → must not complete (fail-closed on id-bearing pages).
  - pre-send id exists + completing id differs → completes, meta carries the id.
  - no pre-send id (vendor/page without the attribute) → completes via today's logic; meta records `null` id (R3).
  - new conversation (`preSendCount === 0`) → gate off; existing tests :1163-style must stay green.
  - deep-research marker path (`nestedResearchReport`) → gate exempt; tests :4427/:4629 stay green.
  - structured-recovery tail → unchanged proof; tests :1643/:1878 stay green.
- **Edge cases:** fixtures that model a pre-send id but omit poll ids now wait (update them to model ids consistently — the page does); image-output completions take the assistant-node id when present, otherwise degrade explicitly.
- **Verification:** U1's test green; the non-firing table each pinned by a named test; full controller file and full suite green.
- **Checkpoint:** auto — full `npm test` green including U1's oracle.
- **Runtime evidence:** `unverified — the in-page attribute read inside the poll eval is executed only by U3's live probe; deterministic tests exercise the fake page's dispatch, which shares the real eval string.`

### U3. Consent-gated live probe — the fix against the real project-routed conversation

- **Goal:** Live confirmation that a project-routed conversation now captures the answer to the prompt sent, with the captured turn's id differing from the pre-send tail.
- **Requirements:** R1, R3, R4
- **Dependencies:** U2
- **Files:**
  - Modify: `docs/probes/` (new probe record)
- **Approach:** Same shape as the 2026-09-14 probe: disposable keyed tab routed into the user's `agentify` project, warm app, two short numeric prompts ("3+3?", then "5+5?"), each followed by a run-record read asserting the captured text is the current prompt's answer and `meta.providerMessageId` differs from the pre-send tail id; close the tab after.
- **Patterns to follow:** `docs/probes/2026-09-14-completion-qualification-probe.md` procedure and artifact format.
- **Test scenarios:**
  - *Happy path:* second query on the same conversation captures `'10'` (not `'6'`), receipt hashes that text, meta ids differ.
  - *Degradation observable:* probe run record shows the identity basis (id present/differing) — the R3 visibility claim checked on real output.
- **Verification:** probe record written with per-run observations and verdict; a capture of the previous reply would falsify the fix and reopens the plan.
- **Checkpoint:** gate — scoped consent (below) granted → run the two queries → both runs capture their own prompt's answer and show differing ids: continue. Consent withheld → mark U3 `unverified — needs live probe consent`, ship U1/U2 (deterministic evidence stands on its own), and record the open live check in the probe tracker. Unknown: no further units depend on U3.
- **Runtime evidence:** `unverified — the probe itself is this unit's evidence; it runs only under the consent grant.`

## Scope Boundaries

- The cold-start chrome capture (probe run 1) — readiness/capture-early residual, already documented in CLAUDE.md; not turn identity.
- Every other "last assistant message" consumer — `readPageText`, `readConversationText`, `getLastAssistantImages`/`Downloads`, `#exportResearchMarkdown`'s node pick: different identity semantics, untouched.
- The closed completion-evidence vocabulary (ADR 0007) — no new source; the gate tightens when `assistant-node` may fire.
- HTTP contract — additive `meta` field only; no endpoint, status, or gate changes.

### Deferred to Follow-Up Work

- None — the oracle row's remaining items (O2 probe runner, O3 canonical gate, O4 acceptance) stay in the conversation's banked handoff, not this plan.

## System-Wide Impact

- **Interaction graph:** one shared loop → `query()` (text, image, recovery tail) and `research()` (marker path) all inherit the gate; HTTP finalizers see only an additive meta field.
- **Error propagation:** on id-bearing pages a missing completing id now *waits* instead of completing — worst case a longer wait ending in the existing `response_reconcile_timeout`/recovery paths, never a silent wrong-answer success.
- **State lifecycle risks:** none new — no persisted state changes; run records gain a field.
- **API surface parity:** `agentify_wait_run`/`get_run` output text is unchanged in shape; the identity metadata rides `meta` as the qualification evidence already does.
- **Integration coverage:** deterministic fake-page tests exercise the real eval strings; U3 exercises the real DOM.
- **Unchanged invariants:** receipt integrity (ADR 0002), evidence qualification (ADR 0007), the usage counter, timeout floors.

## Build Execution Contract

- **Closed decisions:** id-inequality as the advancement proof; the degradation path is explicit-in-meta, never a hang; the deep-research marker path and recovery tail are exempt; the closed evidence vocabulary is unchanged; `providerMessageId` is the token for the meta field.
- **Builder autonomy:** exact predicate placement inside the done condition; fixture-churn mechanics; the meta's exact field names beyond reusing `providerMessageId`; probe-record phrasing.
- **Verify at contact:** line numbers in this plan shift — locate by code shape (`captureExtendsAssistantBaseline`, the poll eval's `fallbackMainText`, the durable-only folding at :6079-6085), not by number. Confirm no new consumer of `result.meta` shape appeared since 2026-09-17 (grep `\.meta\.` in http-api.mjs and tests; fallback: additive field, no action). Confirm the poll eval's returned snapshot shape change breaks no other caller (it is loop-local).
- **Stop conditions:** a same-runtime consumer requires the old advancement semantics on id-bearing pages (none known); or the poll eval cannot read the id without breaking the eval string's size/perf contract (none expected — one attribute read).
- **Authority boundaries:** live provider queries (U3) require the scoped consent below; without it, ship U1/U2 and mark U3 unverified. No other external action.
- **Expected gate map:** U1 → new test red for exactly the race signature, rest of suite green; U2 → full `npm test` green (expected fixture churn confined to wait-loop tests whose fixtures model pre-send ids); U3 → probe record with both runs correct. No permitted temporary failures beyond U1's named red between U1 and U2.
- **Human inventory:** one item — *consent* for U3's live probe: two trivial numeric queries ("3+3?", "5+5?") on a disposable keyed tab routed into the user's `agentify` ChatGPT project, on the warm app, run records read, tab closed after. Resolved upfront if possible; if withheld, U3 is skipped-and-marked, nothing else blocks.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Fixtures modeling ids inconsistently mask the gate | Non-firing table pins each state with a named test; U1's oracle is the race itself |
| A provider page variant mounts the new node before its id attribute appears | Within-poll the id is read fresh each cycle; a null id simply keeps waiting until the attribute lands — bounded by existing timeouts and recovery |
| Vendor without `data-message-id` regresses to hangs | R3 degradation path is explicit and tested; the compat layer's fail-closed selector behavior documented in Background |
| Fixture churn hides a real behavioral break | Every changed fixture must keep asserting the same outcome it asserted before the churn |
| Live probe spends Pro quota / hits mount latency | Two short numeric prompts on a normal (non-Pro) tab, warm app — same cost class as the 2026-09-14 probe |
