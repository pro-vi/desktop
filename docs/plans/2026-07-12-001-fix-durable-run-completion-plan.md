---
title: Durable Run Completion and Background Waiters
objective: Make Agentify report completion only after provider work is truly finished and durable output artifacts are validated.
type: fix
status: active
date: 2026-07-12
origin: timeout reproduction and approved architecture conversation
---

# Durable Run Completion and Background Waiters

## Problem

`agentify_get_run` can permanently report `error` after Agentify's ChatGPT response observer times out, even though ChatGPT continues and later completes. The observer timeout is currently converted into a terminal run outcome; the provider generation is not cancelled, and terminal records cannot reconcile. This makes an observation deadline masquerade as provider truth.

## Requirements

- **R1:** Query work is supervised by the long-lived Electron service, independent of the submitting caller.
- **R2:** An observer soft timeout cannot become terminal failure while provider work may still complete.
- **R3:** A background waiter exits successfully only after a truly terminal successful run.
- **R4:** `agentify_get_run` remains a non-blocking snapshot API.
- **R5:** Multiple waiters can observe one run; waiter timeout, disconnect, or death never mutates it.
- **R6:** Provider slot, controller mutex, tab scope, and routing affinity remain held until the provider run is terminal.
- **R7:** Output-bearing query/research success requires readable, validated, registered artifacts and a completion receipt.
- **R8:** Runs live during Electron restart become explicitly `interrupted`, never falsely successful or provider-failed.
- **R9:** Synchronous query remains a convenience over the same durable lifecycle rather than a separate execution model.

## Decision

All output-bearing query work becomes a service-owned supervised run. The agent may spawn a lightweight waiter process—`npm run wait-run -- <runId>`—or use MCP `agentify_wait_run`. Both consume an authenticated long-poll endpoint, `POST /runs/wait`; neither inspects the DOM nor owns provider execution.

Three deadlines remain distinct:

1. submission deadline: accepting and dispatching work;
2. observation soft deadline: transition to `running/reconciling_response`, not terminal failure;
3. caller wait deadline: return control to that waiter only, without changing the run.

V1 does not attempt to reattach a DOM observer after Electron restarts. Previously live output-bearing runs are finalized as `interrupted`, causing waiters to exit nonzero. This is truthful and avoids replaying a prompt with uncertain send state.

## Lifecycle

Live statuses are `queued`, `running`, and `blocked`. Terminal statuses are `success`, `error`, `stopped`, and `interrupted`. Terminal phases are derived from status; live response phases include `waiting_for_response` and `reconciling_response`.

An output-bearing terminal success includes a `completionReceipt`:

```text
CompletionReceipt {
  version: 1
  kind: assistant-response | research-report
  responsePath
  metadataPath?
  artifactIds[]
  responseSha256
  conversationUrl?
  capturedAt
}
```

`send` remains dispatch-only and is rejected by output wait semantics.

### Invariants

- `finishedAt` exists if and only if status is terminal.
- Output-bearing success exists if and only if a completion receipt exists.
- `success` always implies phase `completed`.
- A receipt implies its artifacts were atomically written, read back, validated, and registered.
- `reconciling_response` implies a live unfinished run.
- Waiter deadlines and disconnects cannot mutate run state.
- Receipt and success are committed in one serialized store transition.
- Provider/controller ownership is retained while a sent run remains live.

## Wait Contract

`POST /runs/wait` accepts `runId`, optional `afterRevision`, `waitTimeoutMs`, and `includeOutputText`.

- `200`: terminal run
- `202`: still live at heartbeat/deadline
- `404`: unknown run
- `409`: unsupported dispatch-only `send` run

The CLI maps terminal status to process exit codes: success `0`, error `2`, stopped `3`, interrupted `4`, usage/unsupported `64`, optional caller deadline `75`, and signal `130`.

## Implementation Units

### U1. Closed lifecycle model

- Create `run-lifecycle.mjs` as the semantic authority for statuses, phases, terminal checks, receipt validation, and transition invariants.
- Modify `run-store.mjs` to normalize and enforce the closed model.
- Add lifecycle and store tests, including rejection of finished-live and receiptless output success.

### U2. Observable run store and wait endpoint

- Add monotonically increasing run revisions and transition subscriptions after durable writes.
- Add `/runs/wait` long polling with multiple-waiter, heartbeat, disconnect, and no-mutation tests.

### U3. Service-owned supervision

- Change controller/HTTP orchestration so an observation soft timeout enters reconciliation rather than finalizing error.
- Keep provider slot, exclusive controller ownership, and tab scope through actual completion or explicit terminal failure.
- Replace the regression test that encodes permanent timeout failure.

### U4. Receipt-backed output commit

- Atomically persist response/metadata artifacts, read them back, hash/validate them, then finalize success plus receipt in one run-store transition.
- Cover query and research output paths and failure before receipt creation.

### U5. Agent waiters

- Create `wait-run.mjs`, add the `wait-run` npm script, and add MCP `agentify_wait_run`.
- Implement status-specific exit codes, output inclusion, caller deadline, and signal handling.

### U6. UI, documentation, and operational verification

- Update Control Center status/phase projections and MCP/README documentation.
- Mark startup survivors `interrupted`.
- Run focused tests, full suite, quality gate, and a live background-waiter probe.

## Scope Boundaries

- No second DOM inspector in the waiter.
- No prompt replay across an uncertain send boundary.
- No output-completion claim for `send`.
- No push transport beyond local long polling.
- No changes to chat routing or local coding workspace selection.
- No automatic DOM observer recovery across Electron restart in V1.

## Risks

| Risk | Mitigation |
|---|---|
| ChatGPT UI exposes no stable completion signal after the soft deadline | Keep the service observer alive and use existing response-stability signals; never infer success from elapsed time. |
| Process crash between artifact write and run commit | Atomic artifact writes plus receipt validation; startup treats unfinished run as interrupted. |
| Duplicated lifecycle literals drift in plain UI code | Central authority plus parity tests for the UI projection. |
| Long-poll waiter leaks listeners | Abort/close cleanup and bounded heartbeat tests. |
| Existing sync callers depend on timeout errors | Preserve a caller wait deadline while leaving service-owned run live and returning its run ID/state. |
