# ADR 0007: Qualify Final Output in the Controller, Not the Receipt

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** Agentify Desktop maintainers and the 2026-09-14 build session
- **Amends:** ADR 0002 — receipt-backed completion now requires controller completion evidence before receipt creation

## Context

Three ChatGPT runs became receipt-backed `success` while the saved text was a transient `Pro thinking` label or a Deep Research planning panel. The DOM wait loop treated any stable nonempty assistant surface as final output, and the HTTP finalizers wrote and receipted any nonempty result text. Deep Research also accepted a changed nested frame as final once it stopped detecting a thinking banner, without requiring ChatGPT's native completion marker. A file hash proves bytes, not that the bytes are an answer.

## Decision

Make the controller the sole authority that qualifies a captured provider surface as final output. Successful controller results carry completion evidence with a closed source set — final assistant answer (`assistant-node`), image output (`image-output`), a Deep Research surface carrying ChatGPT's native `research completed in` marker (`deep-research-report`), or a complete structured conversation recovery (`structured-recovery`). Transient, error, and timeout paths never construct one.

HTTP finalizers require that evidence, with a per-flow allowed set, before creating any response artifact, receipt, compatibility-terminal satisfaction, or durable success. Bare nonempty text qualifies for nothing. The receipt keeps its ADR 0002 shape as an artifact-integrity record; semantic finality is decided upstream, at the layer that still holds its observation context.

Transient classification matches exact progress-only assistant labels only (`isProgressOnlyAssistantText`) — never a character floor or a broad word match, so an answer that discusses "thinking" stays final. The structured-recovery tail passes the same label rule so recovery cannot bypass the boundary.

## Rationale

The rejected alternative was classifying text at receipt creation: length thresholds or a growing placeholder regex. It would duplicate provider semantics after the controller has discarded its observation context, reject valid short answers, and leave each new UI state able to become a receipt until its string was added. Provider-specific terminal evidence at the observing layer fails closed on unknown surfaces instead.

## Consequences

Positive:

- Unattended callers cannot receive a transient UI state as a successful answer.
- Unknown future transient surfaces degrade to continued observation or the existing non-success timeout, never to a wrong success.
- The controller, HTTP, and tests share one closed vocabulary of final sources; a new surface is a controller change, not a string list in the finalizer.

Negative:

- A genuinely final surface the controller cannot qualify delays the caller or fails the run; live, build-identified probes are needed when the provider ships new UI states.
- Completions on provider error surfaces (`hasError`) no longer become success artifacts; those runs now fail.
- Every vendor's queries flow through the same wait loop, so a vendor whose final surfaces differ from ChatGPT's needs its own qualification sources added to the closed set.

## Revisit Triggers

- A build-identified live capture shows `Pro thinking` as a completed answer rather than a transient state.
- The Deep Research completion marker changes shape or stops distinguishing a report from planning.
- A vendor's final surfaces need qualification rules the shared wait loop cannot express.
- Receipt consumers need the evidence persisted in the run record rather than the run's `metadata.json` artifact.

## References

- `docs/plans/2026-09-14-001-fix-chatgpt-completion-provenance-plan.md`
- ADR 0002 — service-owned runs and receipt-backed completion
- `chatgpt-controller.mjs` — `completionEvidenceFor`, `isQualifiedCompletionEvidence`, `isProgressOnlyAssistantText`
- `http-api.mjs` — `COMPLETION_EVIDENCE_ALLOWED`, `completionEvidenceForResult`
- `tests/chatgpt-controller.test.mjs` — transient-label, planning-panel, and recovery-tail qualification
- `tests/http-api.test.mjs` — evidence-missing finalization gates
