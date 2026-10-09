---
title: Talk, read, and wait with personal Dot
objective: Coding agents can exchange messages with personal Dot and follow its incoming messages.
type: feat
status: completed
builder: cold
date: 2026-10-08
origin: conversation
supersedes: 2026-10-07-001-feat-dot-messaging-plan.md
---

# Talk, read, and wait with personal Dot

## Objective and background

Provide three messaging operations for coding agents: talk to Dot, read Dot's
messages, and wait for new messages. Dot may send several messages for one
prompt, send proactive updates, relay between agents, or perform cloud work.
The transport communicates messages; callers decide what those messages mean.

Source inspected: `2e8ad11f1591659a386b2d98da742de93d3ec1f6`. The
[browser probe](../probes/2026-10-07-dot-browser-contract-probe.md) established
personal Dot discovery and reopening in the existing authenticated session.
The personal sidebar control uses `data-sidebar-destination="builtin:orbit"`;
its route is `/dots/<conversationId>`. Native room and sender identifiers are
available. Both participants can have `role: user`, so Chat assistant-role
selectors cannot identify Dot messages.

The existing local `agentify_dot_query` protocol is unshipped scaffolding for
one matched reply. Replace that interface in place. Reuse recipient isolation,
leases, key affinity, and durable submission checkpoints. Ordinary Chat
completion evidence and receipts retain their current meanings. Earlier
single-reply units U2 and U3 are superseded by U6 and U7; keep the remaining
unit identities rather than renumbering them.

### Requirements and scope

- **R1:** Explicit Dot operations select the authenticated account's personal
  Dot automatically, with an optional exact Dot URL. Ordinary Chat operations
  remain Chat-only, and Dot never supplies a generic Work permission.
- **R2:** Talk returns message delivery status. Read and wait return batches of
  native Dot messages, including several messages from one prompt and proactive
  updates. They do not promise a matched reply or completed background work.
- **R3:** Preserve current ordinary query, image, research, send, transcript,
  profile, model, and reasoning behavior.
- **R4:** A cursor survives new messages and empty/time-out reads, stays scoped
  to the observed account and message room, and never skips unreturned data.
- **R5:** Uncertain delivery cannot trigger an automatic resend. Calls sharing
  one Dot room serialize submission; reading or waiting cannot monopolize it.
- **R6:** Reopening, restart, retry, HTTP, MCP, and run summaries preserve the
  operation's meaning and the observed target.
- **R7:** One authority defines each shared representation. Validate browser,
  HTTP, MCP, and stored data; prove the real process boundaries and negative
  cases without relying on display names or message prose as identity.

Included: text input, native message identity, bounded text reading, message
cursors, waiting, delivery checkpoints, local cancellation, and agent-facing
usage documentation. Dot messages with non-text content may expose metadata;
binary download and rich-card control are outside this change.

Excluded: task lifecycle tracking, worker orchestration, agent routing policy,
Dot app/permission administration, file/context uploads, voice, model controls,
whole-Dot Transcript Library capture, and background polling. A message can ask
Dot to act using its configured capabilities; Agentify supplies only message IO.
Do not change coding workspace paths from Dot URLs.

## Architecture Decision

**Approach:** Replace `agentify_dot_query` with `agentify_dot_talk`,
`agentify_dot_read`, and `agentify_dot_wait`, served by dedicated
`/dot/talk`, `/dot/read`, and `/dot/wait` routes. Keep `vendorId: chatgpt` and
immutable Dot recipients on tabs/controllers. Talk uses the existing `send`
run kind and confirms native message delivery. Read/wait are message
observations, not query runs.

**Rejected alternative: retain matched single-reply queries.** The inspected
message stream contains multiple incoming posts and does not establish a
native parent link for ordinary responses. Matching prose, a later timestamp,
or a quiet interval would manufacture a stronger contract than the stream
provides. A separate task-completion detector would expand the requested work.

**Trade-offs:** Several agents share one Dot channel. New messages after a
cursor may include another agent's exchange or a proactive update. Callers can
identify their work in message text and keep reading; Agentify does not rewrite
the supplied text or consume messages globally. A missing history anchor is an
explicit error, not silent reset to the channel tail.

**Existing-thing choice:** Reuse `startHttpApi`, `TabManager`, the current
provider operation leases, `createRunStore`, `requestJson`, and the installed
MCP SDK/Zod. Reuse deadline/abort patterns from `run-waiter.mjs`, while keeping
its query-completion policy unchanged. Transcript cursors belong to immutable
snapshots and cannot represent a growing Dot room. No new dependency is needed.

**Evidence:** Browser discovery/reopening was executed and is documented by
the probe. Native submission acknowledgement, live batch reading, cursor
history coverage, and the built send/read/wait chain remain unverified. The
inspected messaging asset `166137.5a625a2847.js` displays delivery only when
native delivery state is empty and no matching unconfirmed send remains; it
uses request IDs to reconcile optimistic and canonical outgoing message IDs.
Recheck those producers at contact before accepting a delivery checkpoint.

### Naming and representation authority

| Meaning | Name / owner | Consumers and boundary reason |
|---|---|---|
| Requested personal Dot | `recipient`, `chatgpt-recipient.mjs` | HTTP, tab factory, controller, storage; omitted recipient still means Chat |
| Observed target | `dotBinding`, `chatgpt-recipient.mjs` | Controller stamps it; service validates/persists it; cursors and leases compare it |
| Native UI observation | `DotPageObservation`, `chatgpt-dot-ui.mjs` | Browser producer and host decoder; actual metadata defines identity and delivery |
| Outgoing checkpoint | `dotSubmission`, `chatgpt-recipient.mjs` | Controller/service callback, run store, get/retry; separate from incoming messages |
| Caller reading position | `DotCursor`, `chatgpt-recipient.mjs` | HTTP/MCP requests and results; growing-room position, not a snapshot hash |
| Received message batch | `DotMessageBatch`, `chatgpt-recipient.mjs` | Browser/service/MCP; bodies once in text, IDs/cursor in metadata |
| Message wait | `agentify_dot_wait` / `/dot/wait` | Bounded HTTP observation plus MCP deadline loop; separate from `waitForRun` |

Keep ordinary `query`, `send`, completion receipts, and Transcript Library
vocabulary unchanged. Remove the draft Dot-only completion-evidence variant
and its exclusive consumers instead of retaining an unused compatibility path.

### Surface direction

- **D1:** A coding agent discovers talk/read/wait in the core profile and can
  use personal Dot without knowing its display name or URL.
- **D2:** Talk reports delivery; read/wait return multiple messages with a
  usable cursor. A message body appears once across MCP text and metadata.
- **D3:** Timeout and received-message labels describe observation, never
  matched prompt completion or background-task completion.

### Contracts

**C1. Explicit operations.** Dot requests use strict operation-specific parsers
shared by HTTP and MCP. Talk takes `text`; read takes optional `after`; wait
takes `after`. Optional target fields are `key` and `dotUrl`; each operation
has its relevant timeout/output bounds. Source labels are internal forwarding
metadata. Reject caller observation stamps, mode/model/project/chat controls,
attachments, context, bundles, and unknown fields before effects. Omitted
`dotUrl` selects the personal sidebar Dot; explicit URLs must resolve to that
owned target. Use a dedicated default Dot key rather than the default Chat tab.

**C2. Native binding.** Define the observed binding as normalized Dot URL,
provider conversation ID, native room ID, remote Aeon ID, and provider UI
account key. These are distinct fields; do not infer their meaning from local
profile names. Capture them from the same active personal Dot context. Persist
them before sending, revalidate after navigation, and compare all identity
fields on continuation/cursor use. Display names never establish identity.
Native sender metadata stamps direction outside message content; incoming Dot
posts must match the room's remote participant. Role alone supplies no author
evidence. Missing, ambiguous, loading, or drifted observations reject effects.

**C3. Cursors and batches.** A cursor contains the validated binding and a
canonical message position; its wire encoding is opaque and unversioned. It
is a caller-requested position, not trusted provider evidence. The observed
context must match it. A position at the current tail remains valid forever
within that context. Read after a cursor returns the next ordered, unique,
canonical Dot posts available in that native timeline, without requiring a
reply parent. Read without a cursor returns a bounded recent batch. Return a
cursor at the last fully returned position, never past unreturned content.
Independent readers retain independent cursors; there is no shared consumed
flag. Empty reads and timed-out waits retain their input position.

Use the actual timeline's loaded/order/history signals. If an anchor is outside
the loaded range, seek it through observed native history behavior within the
operation's bounds; if its presence/coverage cannot be established, return an
explicit cursor-unavailable error. Never substitute an immutable transcript
cursor, a run revision, guessed timestamp watermark, or body matching.

Reuse existing read character bounds. Return complete message bodies within
the requested budget; pagination must retain the next unreturned message. If
one message cannot fit, return its ID and required character count with the
input cursor unchanged so the caller can increase the budget. Non-text posts
are represented explicitly rather than silently consumed. Message edits and
deletions are not a separate watched event stream in this scope.

**C4. Wait semantics and ownership.** Wait returns the available batch as soon
as new canonical Dot messages are observable after its cursor. It does not
wait for silence, a single final response, or a task result. Finite timeout
returns an empty timed-out observation with the same cursor; cancellation ends
local observation only. HTTP waits are bounded using the existing 25/30-second
wait pattern; MCP loops to its caller-owned deadline or indefinite wait.
Browser ownership is held only during an individual capture. Release it while
waiting so another agent can talk. Serialize sends by observed room identity,
including aliases through different keys/tabs, only through delivery settlement.

**C5. Delivery and replay.** Persist `not-submitted` before preparation, then
durable `unknown` before any input. Correlate the native optimistic send's
request ID with its canonical outgoing message ID and native delivery state,
including unconfirmed-send removal. Save native request ID as soon as observed.
`submitted` iff a correlated accepted outgoing ID exists and its checkpoint
was durably saved. Never accept a new incoming post, matching prose alone, or
composer clearing as delivery evidence. Recheck target/draft/upload state at
every actual input/submit action; a foreign draft must remain intact.

Talk returns a run ID, accepted message ID, and the cursor captured before
submission, preserving messages that arrive during delivery. A successful
`send` run means message delivery only. The run cursor and checkpoint survive
restart. Unknown or submitted delivery never replays input automatically;
completed retry returns the delivery acknowledgement. A safe pre-input retry
may send once after all preparation checks. Stop is local and never clicks
Dot Stop/Pause controls or cancels its background work. Source rollback does
not undo delivered messages; preserve stored evidence and provider messages.

**C6. Structural authority and projections.** Request, binding, checkpoint,
cursor, native message, and batch definitions each have one owner. Derive
same-process consumers; validate page evaluations, wire JSON, and stored rows.
Electron and CDP adapters deliver equivalent decoded observations. Stored Dot
data cannot become ordinary Chat data through location repair. MCP message
bodies occur only in text content; structured content retains metadata and
cursor without duplicating bodies. Generic run waiters retain query/research
completion semantics; they do not become Dot message waiters.

**C7. Privacy and ordinary behavior.** Explicit read/wait captures only the
requested bounded Dot message range. No whole-Dot transcript publication or
library tracking occurs. Do not read secret values or change browser auth
configuration. Preserve current Chat-only submission checks, outputs, receipts,
profiles, compatibility coverage, and filesystem workspace mapping. Dot
observations cannot satisfy ordinary Chat coverage.

### State and action

| State | Talk | Read | Wait | Retry/restart |
|---|---|---|---|---|
| Unbound/loading | Prepare and validate; no input until confirmed | Prepare or return unconfirmed | Prepare or return unconfirmed | Revalidate saved context |
| Ready, no new posts | One guarded send and delivery checkpoint | Empty batch, usable cursor | Observe without holding send ownership | Preserve cursor |
| Several new posts | Independent outgoing delivery | Ordered batch, remaining data preserved | Return available batch | No task-completion claim |
| Delivery unknown | Report uncertainty | Observe messages only | Observe messages only | Never resend automatically |
| Delivery submitted | Return accepted ID and pre-send cursor | Read later posts | Wait for later posts | Return original acknowledgement |
| Cursor missing/drifted | Do not reuse foreign context | Explicit error; no cursor reset | Explicit error; no cursor reset | No generic Chat repair |
| Timeout/cancellation | Retain actual checkpoint | Retain reading position | Empty timeout or local cancellation | No provider Stop/Pause |

### Program obligations and shared scenarios

- **O1:** Personal Dot identity and canonical timeline observations come from
  the actual provider context, not role/display-name/prose classifications.
- **O2:** Every effect is preceded by a final target/draft/upload check; no
  submitting fallback follows uncertain delivery — defined in C2 and C5.
- **O3:** Checkpoint failure before input prevents input; interruption after
  input preserves uncertainty and cannot duplicate a message — defined in C5.
- **O4:** Read/wait retain all unreturned positions across batches, deadlines,
  process boundaries, and identity changes — defined in C3, C4, and C6.

Shared tests: one talk followed by two incoming posts is received in order
across repeated read/wait calls; a proactive post has no parent and remains
readable; a limited batch cannot jump past another post; two readers do not
consume each other's data; a waiting reader cannot block a sender; cursor at
the tail remains valid when a later post arrives; drift rejects before input
or cursor advancement; failed checkpoint/stop/restart never resends. Each test
uses real service/storage/stdio boundaries where its owner crosses them.

## Implementation Units

### U1. Characterize Dot and validate its provider observations

- **Goal:** A tested read-only adapter yields the native binding, canonical
  message envelopes, and timeline/loading/history observations.
- **Requirements:** R1, R4, R7; O1.
- **Dependencies:** None.
- **Files:** Create `chatgpt-dot-ui.mjs` and sanitized
  `tests/fixtures/chatgpt-dot/` fixtures; modify `chatgpt-recipient.mjs` and
  `tests/chatgpt-dot.test.mjs`; maintain the dated browser contract probe.
- **Approach:** Derive selectors/getters from the observed browser and pinned
  messaging asset. Resolve current host props by rendered message ID; verify
  ordering/coverage and composer send-integrity signals at contact.
- **Patterns to follow:** `chatgpt-location.mjs`,
  `chatgpt-compatibility-resolver.mjs`, backend evaluation parity tests.
- **Test scenarios:** Native binding and role-independent incoming/outgoing
  identity; renamed label; current-tail/empty timeline; loading/unknown shape;
  account/room/peer drift; optimistic versus canonical IDs; missing content or
  cursor. Capture identical live metadata through the reader and inspected UI.
- **Verification:** C2/C3/C6 observations are validated; unobservable states
  remain explicit. No send is performed by this adapter.
- **Proven through:** Native-shape fixtures and read-only actual page evaluation.
- **Runtime evidence:** Discovery/reopening observed; new adapter unverified.
- **Rollback:** Remove source only; preserve native messages and private data.
- **Checkpoint:** auto — adapter/parser tests and executed read-only projection.

### U6. Send a Dot message and return its delivery acknowledgement

- **Goal:** Real MCP/HTTP talk sends text through the bound controller and
  returns durable delivery plus a pre-send cursor.
- **Requirements:** R1–R3, R5–R7; O2/O3; D1–D3.
- **Dependencies:** U1.
- **Files:** Modify `mcp-server.mjs`, `mcp-tool-profile.mjs`, `http-api.mjs`,
  `main.mjs`, `tab-manager.mjs`, `chatgpt-controller.mjs`, `run-store.mjs`,
  `state.mjs`, `chatgpt-mode-intent.mjs`, `chatgpt-completion-evidence.mjs`;
  test their existing test files and `tests/mcp-tool-profile-integration.test.mjs`.
- **Approach:** Replace the draft Dot query route/tool with dedicated talk.
  Reuse send-run, constructor binding, leases, and awaited checkpoints. Remove
  Dot reply qualification; leave ordinary completion evidence unchanged.
- **Patterns to follow:** HTTP `/send` lifecycle and the precursor's serialized
  checkpoint callback; `TabManager.createTab` constructor bridge.
- **Test scenarios:** Exact text; forbidden fields before effects; automatic
  discovery/exact locator; canonical acknowledgement; updates during delivery;
  foreign draft/upload; drift at every submitting action; two keys; checkpoint
  failure; local/HTTP stop; unknown delivery; real stdio forwarding.
- **Verification:** C1/C2/C5/C6 hold; UI/MCP label says delivery only.
- **Proven through:** Controller native-input fixtures, real service/storage,
  and real MCP stdio with an owned provider fixture.
- **Runtime evidence:** Native send unverified until the scoped live exercise.
- **Rollback:** C5; no provider message deletion or automatic replay.
- **Checkpoint:** auto — relevant controller/HTTP/storage/MCP/profile tests;
  planted missing guards must fail their designated cases; `npm test`.

### U7. Read and wait for batches of Dot messages

- **Goal:** Real MCP read/wait receive several Dot posts using independent,
  persistent reading positions, without waiting for a task or matched reply.
- **Requirements:** R2–R7; O4; D1–D3.
- **Dependencies:** U1, U6's registration/request boundary.
- **Files:** Modify `chatgpt-recipient.mjs`, `chatgpt-dot-ui.mjs`,
  `chatgpt-controller.mjs`, `http-api.mjs`, `mcp-server.mjs`,
  `mcp-tool-profile.mjs`; test Dot/controller/HTTP/profile/MCP integration files.
- **Approach:** One batch parser/cursor owner; one read path shared by wait.
  Follow native timeline order and coverage. Use existing deadline/abort
  patterns while releasing browser ownership between captures.
- **Patterns to follow:** `run-waiter.mjs` deadline handling and
  `provider-tab-operation-leases.mjs` scoped cleanup, without copying run completion.
- **Test scenarios:** Two posts for one talk; proactive posts; independent
  readers; tail cursor then later post; bounded batches and oversized body;
  missing anchor/unknown content; wait timeout/abort; sending during wait;
  sender and scope mismatch; output bodies appear once through real stdio.
- **Verification:** C3/C4/C6/C7 hold; read/wait never send or stop Dot work.
- **Proven through:** Native timeline fixtures and real MCP/HTTP integration.
- **Runtime evidence:** New read/wait chain unverified until exercised.
- **Rollback:** Source only; cursors are caller-owned and cannot mutate provider data.
- **Checkpoint:** auto — parser, controller, HTTP, deadline, and stdio tests;
  planted cursor/sender/budget mistakes fail named scenarios; `npm test`.

### U4. Continue and recover Dot conversations without duplicate sends

- **Goal:** Saved bindings, delivery, and cursors survive reload/reopen/retry.
- **Requirements:** R3–R7; D2/D3.
- **Dependencies:** U6, U7.
- **Files:** Modify/test `http-api.mjs`, `run-store.mjs`, `state.mjs`,
  `chatgpt-mode-intent.mjs`, `tab-manager.mjs`, `chatgpt-controller.mjs`,
  `mcp-server.mjs`, and their existing integration tests.
- **Approach:** Revalidate native context before reuse. Return accepted sends
  as acknowledgements; never reconstruct a query from a Dot send or message wait.
- **Patterns to follow:** Current Dot guards before ordinary key repair and retry.
- **Test scenarios:** Restart with pending/unknown/submitted delivery; completed
  retry; pre-input retry; cursor reuse after new posts; invalid saved Dot entry
  alongside Chat; changed account/room; unchanged display label binding;
  expired tab reopens the saved Dot URL; ordinary replay remains unchanged.
- **Verification:** C2–C6 survive persistence; executed input counters prove no resend.
- **Proven through:** Owned-state restart fixtures and real MCP operations.
- **Runtime evidence:** Persistence substrate tested previously; new recovery unverified.
- **Rollback:** C5; retain records without converting them to Chat/home.
- **Checkpoint:** auto — restart/storage/operation tests and `npm test`.

### U5. Verify the built client path and document its limits

- **Goal:** Coding agents can discover and exercise talk/read/wait end to end.
- **Requirements:** R1–R7; O1–O4; D1–D3.
- **Dependencies:** U1, U6, U7, U4.
- **Files:** Create `scripts/e2e-mcp-dot-messaging.mjs` and a dated probe report;
  modify `README.md`, `docs/mcp-method-happy-paths.md`, and MCP/native fixture tests.
- **Approach:** Execute real stdio and browser fixture paths; separately run an
  authorized actual Dot exchange and continuation. Record source/backend/provider
  identity evidence and all native message IDs, without publishing personal data.
- **Patterns to follow:** `scripts/e2e-mcp-local-state.mjs` and existing live probe reports.
- **Test scenarios:** Discover three tools; talk, receive multiple fixture posts,
  read/wait again, restart and reuse cursor, receive a later update; real first
  message and continuation; ordinary Chat regression; native/CDP observation parity.
- **Verification:** The complete messaging path is proved; remaining runtime
  gaps are named rather than presented as supported-but-hidden behavior.
- **Proven through:** Fixture browser runner plus separately authorized live MCP calls.
- **Runtime evidence:** Unverified — no Dot message has been sent by this work.
- **Rollback:** Close only owned probe tabs; retain messages and saved evidence.
- **Checkpoint:** gate — local checks continue automatically; scoped live consent
  permits only its named text exchanges. Missing consent holds live sends and the
  support-complete claim, while all independent local work continues.

## Risks and Build Execution Contract

- **Closed decisions:** Architecture Decision, C1–C7, O1–O4, D1–D3. Multiple
  messages and proactive updates are normal. No reply-parent or job-completion
  requirement may be reintroduced through an inherited helper.
- **Builder autonomy:** Reversible local placement and fixtures, existing read
  bounds, derived schemas, and implementation sequencing. Record choices the
  plan did not cover; no new framework, dependency, or private provider endpoint.
- **Verify at contact:** Native binding mapping, current versus stale render
  props, timeline loaded/order/history state, draft/uploads, request-ID creation,
  canonical acknowledgement, and unconfirmed-send removal. Reuse actual getters
  only after observing their schema. Unknown metadata rejects effects; missing
  history returns explicit cursor-unavailable instead of fabricated empty data.
- **Stop conditions:** No reliable observed recipient/sender, no native send
  acknowledgement correlated to one submission, or no way to preserve cursor
  coverage within the permitted UI. Hold the affected action and continue
  independent work; do not replace evidence with timestamps/prose/quiet periods.
- **Authority boundaries:** Existing authenticated browser handling; no secret
  values, auth configuration changes, app permissions, or task-control actions.
  Synthetic fixtures cover mechanism. Real sends require the repository's
  explicit scoped provider-probe consent.
- **Human inventory:** The messaging direction is settled by the conversation.
  Existing read-only session/locator is available; actual CAPTCHA/account prompts
  require human handling only if encountered. Before live acceptance, prepare
  the tested revision and request one scoped grant for a connection message and
  a continuation/multiple-message exercise to the observed Dot, text only and
  no requested app actions. Its exact revision exists only after implementation;
  until granted, live sends remain held. No new taste judgment or calibration
  quantity is selected: caller output/deadline bounds retain existing owners,
  and native history page size is defined by the observed provider interface.
- **Expected gate map:** Each unit's parser/controller/service/stdio checkpoint
  must pass; no temporary ordinary Chat failures are permitted. Full-range
  `/gate`, ADR disposition, local proof, and exact-SHA CI precede publication
  completion. Compatibility of ordinary Chat consumers is required; no consumer
  or release obligation keeps the unshipped Dot query API alive.
