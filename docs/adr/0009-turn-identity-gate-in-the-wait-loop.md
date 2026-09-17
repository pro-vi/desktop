# ADR 0009: Turn-Identity Gate in the Wait Loop

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Agentify Desktop maintainers and the 2026-09-17 build session
- **References:** `docs/probes/2026-09-14-completion-qualification-probe.md` (defect), `docs/probes/2026-09-17-turn-identity-gate-probe.md` (fix verified), ADR 0007, `docs/plans/2026-09-17-001-fix-turn-identity-capture-race-plan.md`

## Context

On project-routed conversations the previous assistant reply stays mounted and stable while a new turn takes seconds to mount. The wait loop's done condition treated a stable last assistant node plus a vanished stop control as completion, so a prompt could capture the *previous* turn's answer as receipt-backed success (live 3/3, 2026-09-14: "3+3?"/"5+5?" captured `'4'`/`'6'`). Completion evidence (ADR 0007) could not see this: the defect is turn identity, not finality.

## Decision

The pre-send tail's provider message id (`data-message-id`, already read for the structured-recovery baseline) is carried into every wait. On pages that expose it, the live done condition additionally requires the completing node's id to differ from the pre-send tail; the completing id lands in `result.meta` and in the wait-debug record. Pages without ids degrade to the prior positional/textual advancement with the absence recorded in meta. The deep-research marker path and the structured-recovery tail keep their own proofs.

## Rationale

Rejected a content-hash baseline (pre-send text can be polluted and hydration changes text without changing identity), a hard count-growth gate (brittle, and count growth still cannot prove which node was captured), and require-id-always (would hang pages that never expose the attribute). Inequality against the provider's own stable id is the same proof the recovery tail already uses, applied at the earlier decision point.

## Consequences

Positive:

- The completing capture is a node that did not exist at send time; verified live on the exact setup that reproduced the defect.

Negative:

- On id-bearing pages, a completing node whose id has not landed yet waits (bounded by existing timeouts; durable runs fall through to structured recovery).
- The non-durable fallback channel fails closed to timeout where it previously could complete on page text — that channel could carry the previous answer, so timeout is the accepted direction.

## Revisit Triggers

- A vendor's final surfaces carry no per-message ids but need turn proof (add a vendor-specific identity source).
- ChatGPT changes or drops `data-message-id` (the compatibility layer's `transcript-message-id` exemption already fails closed — surfaces as the degradation path).

## References

- `chatgpt-controller.mjs` — `turnIdentitySatisfied` in `#waitForAssistantStableImpl`, `#readPreSendAssistantState`
- `tests/chatgpt-controller.test.mjs` — oracle pair (witnessed red pre-fix) and the non-firing table
