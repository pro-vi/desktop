# Dot binding continuity and refusal diagnostics

Status: saved-binding reads, older-conversation cursors and message waits passed
through production MCP. No live message was sent during this investigation.

## Evidence scope

The initial running application's exact revision was not exposed. The checkout
matched `origin/main` at `c907b769a504782a276940fbd5a512064874f6ec`.
The continuity probe used a freshly started production application from
`1ffd1f431ce8e9309eea407f3df64b3d02342542` plus the continuity changes in the
commit containing this report. Electron was 39.6.0; Node was 24.14.0.
The provider's complete release identifier was not exposed.

## Identity rule

The saved personal Dot binding initially returned HTTP 409
`dot_binding_mismatch`. Separate read-only discovery succeeded. Only the
active provider conversation ID differed: account, native message room and
remote peer matched. The live native context paired the current conversation
with that same room. This establishes the observed change, not its frequency.
Message bodies and personal identifiers are omitted here.

Continuation, cursor validation and send serialization now use account, room
and peer identity, as recorded in ADR 0016. The active conversation ID remains
observed metadata and refreshes after the stable identity checks pass. Cursor
encoding is unchanged; saved message positions remain usable. Explicit URLs
still require current provider confirmation. Caller-created cursor metadata
cannot establish URL authority.

Refusals name mismatched account, room or peer fields without returning identity
values. HTTP and MCP preserve those diagnostics and the existing durable
submission checkpoint. Unknown or submitted delivery never permits automatic
resend.

## Read-only production verification

| Operation | Observed result |
|---|---|
| Read through the original saved personal key | Succeeded after the active conversation changed; account, room and peer still matched. |
| Read using an older-conversation binding at the current message position | Succeeded with an empty batch and preserved the exact opaque cursor. |
| Wait across successive message positions | Returned the next message, then continued with its returned cursor to the following message. |
| Wait at the resulting tail | Timed out with no messages and preserved the exact opaque cursor. |
| Original failed run | Its not-submitted submission checkpoint remained unchanged after final-code reload and reads. |
| Provider sends | None. |

An earlier reload encountered a real `cloudflare_challenge` HTTP 403, including
`/backend-api/tbo/primary`. Access stopped at that refusal. The successful
production reads above occurred after verification was cleared.

## Local verification

The focused command covers native submission, drift refusal, cursor continuity
across restart, real HTTP/MCP transport, stable send serialization and durable
uncertain-delivery behavior:

```sh
node --test tests/chatgpt-dot.test.mjs tests/dot-message-stream.test.mjs tests/dot-messaging-integration.test.mjs tests/state.test.mjs tests/run-store.test.mjs
```

The final focused suite passed 92 tests. The final `npm test` run passed 1,062
tests with no failures or skips. The unrelated-locator correction was included
in both final runs.

Isolated source-copy checks restored strict conversation identity, restored
conversation-specific operation locks, or removed each stable identity check.
All expected failures occurred at the corresponding continuity, lock-scope or
field-refusal assertions. The unrelated-locator HTTP regression also failed
before the final native URL guard was restored.

Independent overbuild, comment, invariance and failure-mode reviews ran. The
unreachable test conditions and the cursor-as-locator-authority finding were
corrected. The invariant recheck passed.

## Separate status signals

The original blocked-page heuristic matched `verify` and `403` inside rendered
Dot messages. It was not evidence of an HTTP refusal. The tab list's
`about:blank` came from Dot tab creation metadata; the controller's actual URL
was the personal Dot route. Neither signal caused the binding refusal.

## Verification limits

No new live talk exchange ran. Synthetic native/controller/HTTP/MCP coverage
exercises sending after an active-conversation change and preserves the
no-resubmission checks. The earlier live talk exchange remains historical
evidence. Live read and wait acceptance passed; live talk acceptance was not
rerun. Exact-SHA CI is unverified because this work has not been pushed.
