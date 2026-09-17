# ADR 0010: Gate Cold-Start Captures at the Capture Surface, Not Readiness

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Agentify Desktop maintainers and the 2026-09-17 build session
- **References:** `docs/probes/2026-09-17-cold-start-capture-probe.md`, `docs/plans/2026-09-17-002-fix-cold-start-capture-residual-plan.md`, ADR 0007, ADR 0009

## Context

The first read or query after an Electron spawn could capture a still-hydrating ChatGPT page in two shapes, both live-recorded: an empty transcript (`messageCount: 0`, 2026-08-03) because the capture bundle returns immediately when its first message read finds nothing; and a chrome-polluted node (prompt echo + timing + footer + answer, 2026-09-17) because the wait loop takes the last `assistantMessage` selector match verbatim, and hydrating pages present only broad containers (`model-response`), with an unguarded stop-visible + send-enabled contradiction letting completion fire early.

## Decision

Captures are gated at the capture surfaces, using the provider-contract machinery already in place. The wait loop's poll and pre-send evals expose a role-qualified node set (matches carrying `data-message-author-role="assistant"`, the same authority the structured capture narrows by); completion prefers it, strict-waits on chatgpt-contract pages when only containers are present, and degrades to verbatim behavior for vendors or unresolved selectors, with the active basis recorded in `meta.nodeBasis`. On canonical conversations the capture bundle polls (bounded, default 10s) for the first role-bearing message before declaring the conversation empty. No completion channel fires while a stop control is visible.

## Rationale

Rejected teaching readiness a transcript-hydration notion: readiness proves the composer and must not block send paths, which legitimately have no transcript to wait for. Rejected HTTP-layer retry gates: two asymmetric handlers sit above a defect that lives below both. Rejected text-based chrome detection: classifying provider chrome by string reopens the closed-vocabulary problem ADR 0007 settled.

## Consequences

Positive:

- The first calls after spawn capture real page state, verified live on both historical failure shapes.

Negative:

- Pages whose role attributes never mount run to existing timeout/recovery instead of completing on a container (fail-closed, consistent with ADR 0009).
- Genuinely-broken conversation reads take the bounded wait before failing; cold captures can be slower.

## Revisit Triggers

- ChatGPT ships a final surface without per-message role attributes (extend the qualification source through the compatibility contract).
- Hydration windows routinely exceed the 10s first-message bound (raise or make adaptive).

## References

- `chatgpt-controller.mjs` — `applyAssistantNodeBasis`, the first-message probe in `#captureConversationBundle`, the stop-visibility clauses in `#waitForAssistantStableImpl`
- `tests/chatgpt-controller.test.mjs` — the three oracles (container, first-message, stop-visibility)
