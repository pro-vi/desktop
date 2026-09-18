# ADR 0011: Transcript by Default, Pointer-First Results

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Agentify Desktop maintainers and the 2026-09-17 build session
- **References:** `docs/probes/2026-09-17-transcript-default-probe.md`, `docs/plans/2026-09-17-003-feat-transcript-by-default-pointer-first-plan.md`, one ChatGPT Pro extended consult (`run 7fc6a9c0`), ADR 0008–0010

## Context

Agents consume chat through bounded inline payloads; the transcript library stored whole-conversation snapshots only for explicitly tracked sources (caller-supplied `liveSourceId`), and the post-query sync's result was discarded. The user's stated ideal: the chat script as a queryable local file an agent reads like a local transcript.

## Decision

Every successful keyed text query on a canonical conversation auto-tracks a transcript source — idempotent by conversation identity, never rebinding a key — and publishes a whole-conversation snapshot after finalize, detached from the response path. The run record carries an answer-anchored transcript lifecycle: `pending` persisted at finalize, `ready` only when the committed snapshot verifiably contains the run's answer turn (`providerMessageId`), explicit `failed`/`not_applicable` otherwise; stranded pendings reconcile at startup. All three completion surfaces expose one projection (`providerMessageId` + `transcript {state, snapshotPath?}`) with a ≤2s notification-based grace on blocking paths. The snapshot JSON is the local file; no new format, no new tools. Teaching rides results, not per-session description growth.

## Rationale

Rejected finalize-time awaits (whole-conversation capture on every query's critical path — detaching also removed latency tracked callers already paid for a result that was discarded); a rendered per-conversation markdown file (a second representation of the same content is drift surface; jq over the snapshot selects turns exactly — adopted on the Pro consult's condition that the selector is taught, which `/agentify` now does); MCP resource links (agents here are local-shell clients; paths are the honest contract). The answer-anchored readiness rule and pending durability come from the consult's strongest findings: "snapshot committed" is the wrong predicate when runs interleave, and a detached in-memory promise is not a durable publication.

## Consequences

Positive:

- The conversation is addressable locally by stable turn ids, verified live end-to-end.

Negative:

- Every keyed query also captures the whole conversation (off the response path); the pointer may still be `pending` past the grace window; token savings are realized by caller behavior and must be measured in complete traces, not response sizes.

## Revisit Triggers

- Traces show schema-discovery friction or whole-file dumps where prose navigation would read less (render a markdown view).
- Agents re-opening conversations without a new query (a stable `latest` discovery pointer).
- Blob growth becomes measurable (retention policy; any GC must preserve snapshots referenced by retained runs).

## References

- `transcript-sync.mjs` — `resolveSource`, `inspectSnapshot`; `http-api.mjs` — `publishRunTranscript`, `awaitRunTranscriptTerminal`; `run-store.mjs` — `attachTranscript`
