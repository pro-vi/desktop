# Dot message text and native delivery handles

Status: complete message text passed live read-only MCP checks. Native delivery
confirmation passed the controller, service, MCP and Electron fixtures. No new
provider message was sent, and live talk acceptance was not rerun.

## Evidence scope

Investigation began at `d09a94ebdd52c9879888bae0fcfcbc3709356b67` on current
`origin/main`. The repairs are in the commit containing this report. The native
inspection used a freshly started production Electron 39.6.0 application.
The calling client's reported behavior was observed on Claude Code 2.1.304;
this investigation used the MCP SDK stdio client rather than repeating that
client's rendering behavior. Node was 24.14.0. The provider's complete release
identifier was not exposed.

The final normal-app restart initially showed the provider page error
“ChatGPT hit a snag” and could not confirm the native binding. The page later
recovered and the same saved-key read succeeded. The recovery cause was not
established. The diagnostic port was closed, and the original reported run's
stored bytes remained unchanged.

## Message text

The original `dotBatchResult()` retained message text only in MCP text blocks
and deliberately removed it from `structuredContent.messages`. A client selecting
structured results therefore received the message metadata without its body.
The revised projection retains the validated complete batch in structured
content and preserves the existing readable text blocks. Body length, cursor
positions, pagination and non-text message metadata retain the same rules.
The same body can now occur twice in one MCP response. The plan's earlier
single-copy projection requirement has been amended.

Fresh production MCP calls read two existing incoming messages, then waited
from the first message's position. Every text field matched its text block;
the wait returned the same second message and identical text. Only hashes and
result-shape checks were retained as evidence; no new send was needed.

## Native delivery

Read-only inspection of the active provider's `composer.sendPrepared` found
that it returns `null` or `{ delivery: Promise }`, rather than the literal
`true` expected by the adapter. The inspected function's SHA-256 was
`a65b9da9ed0d8c003f9dcd03db3d64051553a7db962e8c95e0ecb13a2874211b`.
The old adapter reproduces the early exit with this handle shape. The original
run did not retain its native return value.

The reported run persisted an unknown checkpoint and ended after 73 ms.
A read-only native timeline inspection found its matching request with a
canonical outgoing ID, empty delivery state and no unconfirmed-send entry.
The native creation timestamp was 588 ms after the run started. Incoming
reply text was not used to establish delivery. Personal identifiers and bodies
are omitted from this report.

The adapter now recognizes the delivery handle as queued submission. The
controller still requires one matching outgoing request, a canonical message
ID, empty delivery state and removal of the unconfirmed-send marker before
persisting `submitted`. Resolving the delivery promise alone is insufficient;
the controller does not await that promise in place of its bounded observation.
No retry rule or stored run was changed. The historical unknown checkpoint is
preserved, and uncertain delivery still cannot automatically replay input.

## Regression checks

Three new regressions failed on the old code: structured message text was
absent; a delivery handle exited before observing pending messages; and a
canonical accepted message was rejected when the native promise remained
pending. They passed after the adapter repairs.

The final focused Dot suite passed 66 tests, including a native null-return
case that retains the durable unknown checkpoint and refuses automatic replay.
The actual Electron fixture also passed using the native delivery-handle shape. Existing checks retain uncertain-send
restart, no automatic replay, failed durable checkpoints, request-ID matching,
binding drift, independent cursors and message budgets. Exact-revision CI
remains required after publication.

A full local run passed 1,065 tests before the final null-return case was
added. A later full rerun lost the ordinary Chat controller worker to
`SIGSEGV` in V8 garbage collection on Node 24.14.0, macOS 26.7.1. No JavaScript
assertion failure was emitted by that worker. Replaying the unchanged main
controller file passed 259 tests; this did not reproduce the crash, and its
underlying native cause remains unestablished. The failed run is retained as
evidence rather than treated as a clean result.

Another full run passed 1,065 tests and timed out one unchanged Transcript
Library visual-proof test at its 60-second parent deadline. That test launches
three separate Electron proofs, each allowed a 60-second child deadline. The
unchanged-main case passed alone in 17.1 seconds. A fresh executable startup
probe took 1.841 seconds during the investigation. This is a local timing
limit, not a failed privacy assertion; it does not establish that the full GUI
suite is reliable under concurrent load. The scoped Dot Electron fixture passed
separately. No verification timeout or skip rule was changed.
