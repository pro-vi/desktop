# Personal Dot live messaging verification

Status: passed on `05a9f8b0d1198131148c8784b89e03f87ac2a075`.
The exerciser used a fresh MCP stdio client, production HTTP service, and
authenticated Electron 39.6.0 browser. This was an actual provider exchange,
separate from the synthetic native-page fixtures.

## Scoped exchange

The operator authorized two text-only messages before sending. The sender
identified itself as a coding agent. The messages requested a connection marker,
then two separate continuation markers. They requested no app use or tasks.

| Operation | Observed result |
|---|---|
| Talk | Both outgoing messages returned durable `submitted` checkpoints. |
| Delivery | Each request ID correlated to a distinct canonical outgoing ID. |
| First wait | One incoming message contained `DOT_CONNECTED`. |
| Continuation waits | Separate incoming IDs contained `DOT_FIRST` and `DOT_SECOND`. |
| Read | Empty reads after the received positions preserved usable cursors. |
| Durable verification | Both saved runs remained successful with matching checkpoints and pre-send cursors. |
| Cleanup | The owned probe tab closed; the diagnostic browser process exited. |

No repeated input was needed. The incoming messages returned independently of
prompt matching or task completion. Their native sender, room, account, and peer
metadata passed the production decoder. Personal names, account IDs, room IDs,
message IDs, and URLs are omitted from this public report.

## Native identifier correction

The live personal route redirected to a URL whose route ID differed from the
native conversation ID. The conversation ID remained paired with the observed
room ID in current native props. Agentify now treats the URL as a locator and
reads conversation identity from that pair. Account, room, peer, and conflicting
context checks remain enforced. Unrelated locators reject before input.

Read-only inspection validated the current metadata, empty draft/uploads, and
complete tail before the corrected exchange. Synthetic regression cases cover
redirects and conflicting visible contexts in both DOM orders. The affected
invariance recheck passed.

## Verification limits

The full local suite passed 998 tests on the exercised source revision. The
earlier synthetic transport/browser fixtures also cover independent readers,
service restart, timeout, uncertain delivery, and unavailable history.
This live exchange establishes current talk/read/wait behavior, not provider
frequency, all older-history loading, or a background-task-completion signal.
The native messaging interfaces can change; delivery uncertainty never permits
automatic resend. Exact-SHA CI remains required after publication.
