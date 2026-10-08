# Dot messaging local verification

Status: local transport and native-page fixtures pass. The actual personal Dot
exchange remains unverified; no provider message was sent by these checks.

The interface is three explicit core-profile tools: `agentify_dot_talk`,
`agentify_dot_read`, and `agentify_dot_wait`. Delivery acknowledges one outgoing
message. Incoming messages are independent batches; no reply parent, silence
interval, or background-task-completion condition is required.

## Executed fixtures

`node scripts/e2e-mcp-dot-messaging.mjs` exercises the actual message evaluator,
controller, HTTP service, durable run/key files, and stdio MCP client. It proves
one native outgoing input, two incoming posts across read/wait, an independent
reader, service restart, cursor reuse, and a later incoming post. The received
message body appears once across MCP text and structured metadata.

The same command launches a separate Electron 39.6.0 process with a disposable
profile and synthetic HTTPS page served locally. The production Electron page
adapter executes the native observation/submission scripts against actual DOM
nodes and native-shaped state. One text message is accepted by the fixture and
two incoming posts are read. No authenticated provider session is used.

The fixture receipt records the command, source SHA, dirty state, fixture digest,
Electron version, exercised observations, and owned-resource cleanup. A fixture
receipt establishes these mechanisms, not ChatGPT's present getter behavior.

Targeted native/controller/service tests additionally exercise final draft and
upload checks, sender/account/room drift, failed checkpoints, optimistic IDs,
uncertain-delivery restart, safe pre-input retry, independent cursors, complete
body budgets, unavailable history, local stop/cancellation, and sending while
another caller waits. Two different local keys cannot submit to one native room
until the first delivery settles.

Five defects were temporarily planted and removed. Each produced exactly one
intended failing test: removing the final draft guard, accepting a foreign
sender, skipping the first batch position, refusing a current-tail cursor, and
omitting the pre-input checkpoint. Restored tests pass. The complete repository
suite also passes; final exact-revision verification is reported by the build
handoff and CI rather than inferred from this source report.

## Source verification and remaining live checks

The pinned ChatGPT messaging asset `166137.5a625a2847.js`, SHA-256
`de28eeb91b9368fc2eccc7cb45031d0b406894538b5e3559ce499c1dd1fe08ed`, contains
consumers of `composer.sendPrepared(roomId, {requestId,text,createdAt})`, native
drafts, attachment drafts, and unconfirmed-send entries. It displays delivery
only after empty native delivery state and removal of the matching unconfirmed
send. These source consumers were inspected. Their underlying producer modules
and the running provider behavior were not established by the fixtures.

Actual account/room/peer binding, timeline order/tail coverage, prepared-send
acceptance, request-ID reconciliation, acknowledgement, and history seeking
still need an authorized provider exercise. Missing metadata or unavailable
history returns an explicit error. Message text, display names, timestamps,
and incoming posts do not substitute for those observations.

Live verification requires a scoped connection message plus a continuation to
the observed personal Dot, text only, with no requested app or permission action.
The exact revision and text must be approved before sending. Existing provider
messages and durable checkpoints remain intact on rollback; source reversion
cannot undo a delivered message.
