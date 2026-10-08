# ADR 0016: Separate Dot delivery from message observation

- **Status:** Accepted
- **Date:** 2026-10-08

## Decision

Expose personal Dot through separate talk, read, and wait operations. Talk
records native outgoing delivery. Read and wait return independent batches
with caller-owned cursors. A received post does not prove a matched prompt
reply or completed background work.

Keep Dot delivery as a send run. Preserve uncertainty before native input and
never replay unknown or submitted delivery automatically. Ordinary Chat query
and research completion continue to require their saved-output receipts.

This decision spans controller, service, storage, and MCP boundaries. Provider
getter and acknowledgement behavior remain subject to separate live verification.

## Revisit trigger

Revisit the separation only if a supported provider contract establishes
request/reply or task-completion relationships and a consumer requires them.

## Enforcement

- `chatgpt-recipient.mjs`: `parseDotRunFields`, `parseDotMessageBatch`
- `dot-message-waiter.mjs`: `waitForDotMessages`
- `tests/chatgpt-dot.test.mjs`
- `tests/dot-messaging-integration.test.mjs`
- [Local verification](../probes/2026-10-08-dot-messaging-fixtures.md)
