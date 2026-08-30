# ADR 0002: Use Service-Owned Runs and Receipt-Backed Completion

- **Status:** Accepted
- **Date:** 2026-07-12
- **Amended:** 2026-08-29
- **Deciders:** Agentify Desktop maintainers and Codex architecture/build session

## Context

Agentify formerly treated the ChatGPT DOM observer's deadline as provider truth. The observer could time out and permanently finalize a durable run as failed while ChatGPT continued generating and later completed. A caller polling that record could never recover the actual result.

## Decision

Make the long-lived Electron service own output-bearing provider runs through their true terminal state. Treat the response observation deadline as a soft transition to `running/reconciling_response` while retaining the same browser observer, controller ownership, tab scope, and provider lease.

Bound service ownership with a separate absolute reconciliation deadline. At that deadline, perform one route-guarded structured conversation capture. A complete capture with a provably new assistant turn may continue through the existing artifact and completion-receipt path. Missing, partial, ambiguous, or unchanged evidence terminalizes the run as an error with content-free response diagnostics. The controller must settle before the existing provider-lease owner releases its slot.

Keep `agentify_get_run` as a snapshot. Provide `/runs/wait`, `agentify_wait_run`, and a standalone waiter process as observers of the service-owned lifecycle. A waiter deadline or disconnect never mutates the run.

Report output-bearing success only in the same durable transition that records a completion receipt for atomically persisted, read-back, hashed, and registered response artifacts. Mark live runs found after Electron restart as `interrupted`; do not replay prompts or claim provider failure.

## Rationale

Provider execution and truth belong to the process that owns the authenticated browser session. A detached DOM observer would duplicate browser authority and race the existing controller. Repeated `get_run` polling would only observe the original false terminal state. Service-owned supervision plus passive waiters separates work lifetime from caller lifetime and makes process exit `0` meaningful. A service hard deadline is distinct from a caller wait deadline: it prevents an observer defect or provider stall from owning browser and slot resources forever without turning a normal caller disconnect into cancellation.

## Consequences

Positive:

- Slow provider responses can complete after the original observation deadline.
- A selector-missed completed assistant turn gets one final structured recovery path.
- Multiple callers can wait without competing for browser or provider ownership.
- Successful completion has durable artifact proof rather than elapsed-time inference.
- Caller timeouts and disconnects cannot cancel provider work accidentally.

Negative:

- A provider response that arrives after the service hard deadline is not attached to the terminal run automatically.
- A synchronous caller may remain connected until the service terminalizes unless it chooses fire-and-forget plus a bounded waiter.
- Electron restart cannot reattach the DOM observer in V1, so an in-flight run becomes `interrupted`.
- Lifecycle status and completion receipt changes require coordinated HTTP, MCP, CLI, UI, and persisted-record compatibility.

## Revisit Triggers

- ChatGPT exposes a stable supported API or event stream for run completion.
- Interrupted runs can be safely reattached using a provider-issued generation identity.
- Long polling causes measurable local resource pressure that justifies a push transport.
- Real Extended Pro completions routinely exceed the hard reconciliation deadline, or final structured recovery rejects complete new assistant turns.
- Receipt persistence and artifact registration need a transactional store spanning both records.

## References

- `docs/plans/2026-07-12-001-fix-durable-run-completion-plan.md`
- `run-lifecycle.mjs`
- `run-waiter.mjs`
- `tests/http-api.test.mjs`
- `tests/run-waiter.test.mjs`
- `docs/plans/2026-08-29-001-fix-inbox-runtime-contracts-plan.md`
- `tests/chatgpt-controller.test.mjs` — hard reconciliation and final structured recovery
- `tests/http-api.test.mjs` — terminal diagnostics and provider-slot release
