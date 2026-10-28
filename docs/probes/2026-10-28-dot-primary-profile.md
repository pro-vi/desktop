# Dot primary-profile discovery and readiness reasons

The old exact `builtin:orbit` sidebar marker is absent on the observed page.
A diagnostic production read failed with `dot_binding_unconfirmed` and reason
`sidebar-ambiguous`. After primary-profile discovery replaced that marker, a
production MCP read returned a bounded message batch and an opaque string cursor.
No live message was sent. Message bodies and personal identifiers are omitted.

## Provider evidence

The observation used Electron 39.6.0. The complete ChatGPT release identifier was
not exposed. Loaded public sidebar asset `76629.ffb823c03a.js`, SHA-256
`c4354e07f7dead00d6fa01aadb9ac07fba7587d1c1334e4c92835d1264b51251`,
builds profile-specific sidebar destinations as `builtin:orbit:${profile.id}`.
Its primary-profile predicate reads `profile.is_primary`.

The live primary profile matched its sidebar destination suffix, native room,
peer and active conversation. The `/dots/home` alias displayed a loaded room
while the profile sidebar item was not marked current. Requiring that item's
`aria-current="page"` would therefore reject this valid alias too. Loaded message
senders passed the existing checks. This proves the observed failure and repair;
it does not establish exactly when the provider changed or how often it occurs.

## Adapter behavior

The adapter selects one visible sidebar control whose native profile has
`is_primary === true` and an ID matching its destination suffix. It confirms one
account key and one native conversation context, then requires the profile's
`id`, `messaging_room_id` and `active_root_thread_id` to match the room's peer,
room ID and conversation ID. Account, room, peer and message-sender checks remain
fail-closed. Display names are not selectors.

Every native not-ready branch now emits a static reason. The parser, preparation
timeout, HTTP mapping and fresh MCP server preserve only allowlisted reasons;
unknown strings and additional native fields are discarded. Existing error names
and cursor encoding are unchanged. Previously started MCP servers need their
normal client-side restart to display the new diagnostics. Successful reads use
the repaired Electron adapter without that MCP restart.

## Verification

The focused native/controller/HTTP/MCP suite passed 89 tests:

```sh
node --test --test-reporter=tap tests/chatgpt-dot.test.mjs tests/dot-messaging-integration.test.mjs
```

It covers every reason, malformed diagnostic rejection, the home alias without a
selected sidebar item, primary-profile refusal, profile/room/conversation mismatch,
duplicate controls, saved cursors, account drift and no resend after uncertain
delivery. The selector fixture distinguishes the old exact marker from the new
profile-specific selector.

Before each shared-app reload, authenticated status showed no in-flight or active
queries; durable run records and provider slots were also idle. The final reload
restored ordinary operation, and the temporary loopback inspection port closed.
Source hashes recorded at launch identify the code used by the successful read.
Live talk and wait journeys were not repeated for this repair.

The full `npm test` suite passed 1,112 tests with no failures or skips. Isolated source-copy mutations restored the obsolete selector, removed the primary-profile guard, removed profile/context pairing, or removed reason retention. Each mutation failed exactly its expected regression tests (1, 1, 2 and 20 respectively).