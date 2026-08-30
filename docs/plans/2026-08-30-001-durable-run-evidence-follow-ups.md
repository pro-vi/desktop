# Durable run evidence follow-ups

These are two separate deferred findings from the 2026-08-30 run-contract review.
Neither is completed by the local lifecycle fixes in this worktree.

## F-D1 — Provider-attempt reconciliation

**Problem:** The durable run record distinguishes local queue, execution, wait, and
output states, but it does not give the provider-side send attempt a durable identity.
After Electron exits near the composer submit boundary, the stored run cannot prove
whether ChatGPT never received the request, accepted it, or completed it later.

**Affected invariant:** When local execution ends with an unknown external outcome,
Agentify must preserve that uncertainty and must not automatically repeat or attribute
a provider effect until it has reconciled the exact attempt.

**Concrete failure sequence:** Agentify persists a running query, submits through the
ChatGPT UI, and exits before it records provider acknowledgement or the accepted
assistant turn. On restart, the live run becomes `interrupted`, in-memory leases are
gone, and a same-key retry cannot be joined to or fenced from the original external
effect.

**Why this is a separate implementation unit:** A complete fix defines idempotency,
attempt identity, fencing, restart reconciliation, late provider observations, and
compatibility for existing callers. Adding one field or one pre-send log would record
intent without resolving ambiguous outcomes.

**Required architectural seams:**

- run schema and migration for logical request, attempt, and fence identities;
- durable pre-submit intent and post-submit observation boundaries;
- provider-slot and tab-operation ownership tied to the current fence;
- restart quarantine or reconciliation before same-tab reuse;
- exact provider conversation/turn evidence when ChatGPT exposes it;
- explicit late-output adoption or rejection without rewriting historical status.

**Acceptance tests:**

1. Kill Electron before durable send intent; retry sends once.
2. Kill after intent but before the DOM action; restart does not assume it sent.
3. Kill after the DOM action but before local acknowledgement; retry does not send
   again and the tab remains fenced until reconciliation or explicit abandonment.
4. Let a provider answer arrive after local terminalization; the original status stays
   historical, the late observation is attached to the exact attempt, and adoption is
   a separate decision.
5. Race queued stop against slot release; no provider mutation occurs after the
   durable stop barrier wins.

**Temporary containment:** Successful query and research runs still require
receipt-backed saved output; queued and pre-provider stops are checked repeatedly
before the provider callback. Documentation and E2E reports must not claim exactly-once
provider execution or restart reconciliation.

**Relationship to current work:** Pre-existing and not widened by the method-level
happy-path runners or the local run-store fixes.

**Merge impact:** NON-BLOCK for the current local lifecycle fixes and named happy-path
coverage. BLOCK for any claim that Agentify provides exactly-once provider submission,
safe automatic replay after ambiguous failure, or durable provider-outcome recovery.

## F-D2 — Invalid historical run quarantine

**Status:** Partially completed on 2026-08-30. Proofless legacy successes now have a
closed public state; malformed or otherwise invalid run files still lack a visible
quarantine inventory.

**Problem:** `run-store.mjs` normalizes JSON records during `load()` without applying
the same lifecycle assertion used on writes. A legacy query success without a valid
completion receipt can therefore appear as `success` through snapshot reads while the
waiter rejects it as `success_without_completion_receipt`. Malformed files are skipped
without a visible quarantine record.

**Affected invariant:** Public run readers must agree on whether a durable run is a
valid success, and incompatible history must remain visible as incompatible rather
than silently disappearing or being promoted.

**Concrete failure sequence:** Seed a pre-receipt query success, restart Agentify, call
`agentify_get_run`, then call `agentify_wait_run`. The first can report success while
the second rejects the same run.

**Why this is a separate implementation unit:** The fix needs an explicit migration or
quarantine state for prior on-disk formats. Silently dropping the record or rewriting
it to a modern terminal status would destroy evidence about what the older service
actually recorded.

**Required architectural seams:** versioned run parsing, quarantine storage or a
closed legacy-unverified projection, consistent get/list/wait behavior, and operator
visibility for unreadable records without exposing prompt or response content.

**Acceptance tests:**

1. Receiptless legacy success returns the same explicit unverified state from list,
   get, and wait after restart.
2. Invalid JSON and invalid lifecycle records remain countable and diagnosable without
   entering the valid run index.
3. Valid historical runs retain their ids, revisions, archive visibility, and receipts.
4. Migration is idempotent across repeated restarts and never fabricates stop or
   completion evidence.

**Implemented boundary:** `load()` preserves a proofless query or research success as
terminal `unverified` history with a closed `completionVerification` reason. List,
get, wait, archive, the CLI exit code, MCP error status, and Control Center rendering
now agree that this is not verified success. A read-only migration rehearsal preserved
all 1,708 current run files: 858 became `unverified`, 325 remained verified success,
and no record disappeared.

**Remaining gap:** Invalid JSON and lifecycle shapes outside the legacy-success case
are still skipped by the per-file load catch without a visible quarantine count. That
is still required before claiming every malformed historical record is operator-visible.

**Relationship to current work:** Pre-existing and now narrowed. The legacy-success
contract is fixed; general malformed-file quarantine remains a separate storage unit.

**Merge impact:** NON-BLOCK for new-run and migrated legacy-success paths. BLOCK for a
claim that every malformed historical file is represented in the valid run index.
