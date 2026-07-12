# ADR 0002: Use Service-Owned Runs and Receipt-Backed Completion

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** Agentify Desktop maintainers and Codex architecture/build session

## Context

Agentify formerly treated the ChatGPT DOM observer's deadline as provider truth. The observer could time out and permanently finalize a durable run as failed while ChatGPT continued generating and later completed. A caller polling that record could never recover the actual result.

## Decision

Make the long-lived Electron service own output-bearing provider runs through their true terminal state. Treat the response observation deadline as a soft transition to `running/reconciling_response` while retaining the same browser observer, controller ownership, tab scope, and provider lease.

Keep `agentify_get_run` as a snapshot. Provide `/runs/wait`, `agentify_wait_run`, and a standalone waiter process as observers of the service-owned lifecycle. A waiter deadline or disconnect never mutates the run.

Report output-bearing success only in the same durable transition that records a completion receipt for atomically persisted, read-back, hashed, and registered response artifacts. Mark live runs found after Electron restart as `interrupted`; do not replay prompts or claim provider failure.

## Rationale

Provider execution and truth belong to the process that owns the authenticated browser session. A detached DOM observer would duplicate browser authority and race the existing controller. Repeated `get_run` polling would only observe the original false terminal state. Service-owned supervision plus passive waiters separates work lifetime from caller lifetime and makes process exit `0` meaningful.

## Consequences

Positive:

- Slow provider responses can complete after the original observation deadline.
- Multiple callers can wait without competing for browser or provider ownership.
- Successful completion has durable artifact proof rather than elapsed-time inference.
- Caller timeouts and disconnects cannot cancel provider work accidentally.

Negative:

- A synchronous caller may remain connected indefinitely unless it chooses fire-and-forget plus a bounded waiter.
- Electron restart cannot reattach the DOM observer in V1, so an in-flight run becomes `interrupted`.
- Lifecycle status and completion receipt changes require coordinated HTTP, MCP, CLI, UI, and persisted-record compatibility.

## Revisit Triggers

- ChatGPT exposes a stable supported API or event stream for run completion.
- Interrupted runs can be safely reattached using a provider-issued generation identity.
- Long polling causes measurable local resource pressure that justifies a push transport.
- Receipt persistence and artifact registration need a transactional store spanning both records.

## References

- `docs/plans/2026-07-12-001-fix-durable-run-completion-plan.md`
- `run-lifecycle.mjs`
- `run-waiter.mjs`
- `tests/http-api.test.mjs`
- `tests/run-waiter.test.mjs`
