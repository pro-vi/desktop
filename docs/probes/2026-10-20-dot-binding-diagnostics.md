# Dot binding refusal diagnostics

Status: diagnostic implementation checked locally; recipient recovery and live
acceptance remain blocked. No Dot message was sent during this investigation.

## Evidence scope

The initial running application's exact revision was not exposed. The checkout
matched `origin/main` at `c907b769a504782a276940fbd5a512064874f6ec`.
The later diagnostic process was freshly started from that base plus the
changes in the commit containing this report. Electron was 39.6.0; Node was
24.14.0. The provider's complete release identifier was not exposed.

## Identity refusal

A read through the saved personal Dot key returned HTTP 409
`dot_binding_mismatch`. A separate read-only discovery succeeded and returned
one incoming message. Comparing identity metadata showed that only
`conversationId` differed: account, native message room and peer matched.
Message bodies and personal identifiers are omitted here.

The live React context paired the current conversation with the same native
room. The loaded provider module `TY` maintains `active_root_thread_id` on the
Dot profile separately from the messaging room. That explains the different
identities; it does not establish how often the active conversation changes.

The existing Agentify contract deliberately compares conversation, room, peer
and account. Its test in `tests/dot-message-stream.test.mjs` rejects changes to
each. Removing conversation identity from this contract requires an owner
decision. This commit preserves all existing comparisons.

## Diagnostic behavior

Binding refusals now return `mismatchedFields`, containing field names without
identity values. The native evaluator, controller, HTTP service and MCP
projection preserve this information. Rejected talk operations still retain
their existing durable delivery checkpoint. No error permits automatic resend.

The focused command exercises native identity drift and MCP read, wait and talk
refusals through the real local transport:

```sh
node --test tests/chatgpt-dot.test.mjs tests/dot-message-stream.test.mjs tests/dot-messaging-integration.test.mjs
```

The final focused suite passed 59 tests. These are synthetic provider fixtures,
not live sends. The full repository suite passed 1,058 tests before the final
MCP waiter diagnostic correction; the focused suite was rerun after that
correction. Removing the field-diagnostic assignment in an isolated copy made
all four field-specific controller cases fail at their diagnostic assertions.
The foreign-successful-batch MCP regression also failed before its correction.

Independent overbuild and invariance reviews found no issue. The failure-mode
review found the local waiter projection gap; its scoped recheck passed after
the correction. No acceptance rule was relaxed.

## Separate status signals

The earlier blocked-page heuristic matched `verify` and `403` inside rendered
Dot messages. It was not evidence of an HTTP refusal. The tab list's
`about:blank` came from Dot tab creation metadata; the controller's actual URL
was the personal Dot route. Neither signal caused the binding refusal.

After the idle application was restarted to load diagnostics, the provider
actually refused access: its error boundary reported `cloudflare_challenge`
with status 403, and `/backend-api/tbo/primary` returned 403. Provider access
stopped at that refusal. Live verification of the new diagnostic response and
recipient recovery remains incomplete until the challenge is cleared.

## Remaining acceptance

Choose whether the same verified account, room and peer may continue when the
active conversation changes, or retain strict conversation identity and repair
the saved binding explicitly. Then exercise the chosen recovery through
`agentify_dot_read`. Current talk/read/wait acceptance is blocked; the earlier
successful live exchange remains historical evidence only. Exact-SHA CI is
also unverified because this local commit has not been pushed.
