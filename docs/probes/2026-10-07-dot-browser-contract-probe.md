# Dot browser contract probe

Status: Dot discovery and reopening observed; per-prompt reply association
remains unconfirmed. No prompt was entered or sent by this probe.

## Scope and source

The probe used the existing authenticated Agentify Electron session and its
page evaluator. No browser authentication configuration changed. A temporary
diagnostic import in `main.mjs` exposed controlled inspection to an owned local
runner; that import was removed after capture. No inspection endpoint or tool
was added to the product.

Application source: `16b44718bf08ae45f89ac34e35d0571fa0748cff`, with the
temporary diagnostic import during capture. Installed Electron: 39.6.0.
Capture date: 2026-10-07. The complete ChatGPT release identifier was not
exposed. The loaded messaging asset was
[166137.5a625a2847.js](https://chatgpt.com/cdn/assets/async/166137.5a625a2847.js),
SHA-256 `de28eeb91b9368fc2eccc7cb45031d0b406894538b5e3559ce499c1dd1fe08ed`.

Capture was restricted to navigation controls, composer availability and
length, identity fields, message metadata, and field shapes. Message bodies,
authentication values, and a whole-conversation transcript were not exported.
Personal names and identifiers are omitted from this report.

## Finding the personal Dot

The sidebar's personal Dot entry is a button with this observed attribute:

```css
button[data-sidebar-destination="builtin:orbit"]
```

The entry sits within the sidebar navigation. Selecting it opens
`https://chatgpt.com/dots/<conversationId>`. Its selected state is
`aria-current="page"`.

The probe first found the entry by its visible display name. It then returned
to the home page and selected the same entry by the attribute above while
passing an unrelated display label. That exercise reopened the same route,
native message room, and remote participant. Dot discovery therefore did not
depend on the display name in this exercised session.

Direct navigation to the observed Dot URL also reopened the same room and
remote participant. This establishes the locator for the captured session;
it does not prove behavior after a provider change or an account switch.

## Observed browser representation

| Meaning | Observed location |
|---|---|
| Native conversation identifier | Dot route segment and matching React `conversationId` props |
| Native message room | React `roomId` props and `room.id` |
| Remote participant identifier | `room.aeon_id`, matching incoming `message.senderAeonId` |
| Provider UI account scope | Sidebar ancestor's React `accountKey` prop |
| Message identifier | `article[data-message-id]` and matching React `message.id` |
| Sender identity | `message.senderId`, `message.senderAeonId`, and `message.self` |
| Local delivery marker | `message.deliveryState` |
| Reply relationship fields | `message.replyTo` and `message.replyRootMessageId` |

The hydrated composer was a visible contenteditable textbox. An earlier
loading snapshot exposed a textarea with a message placeholder. The loading
snapshot alone must not establish a writable, identity-confirmed Dot page.

The direct-navigation capture contained 32 rendered message records: 10 marked
`self: true`, and 22 marked `self: false`. Both participants used `role: user`.
All captured incoming sender identities matched the room's remote participant.
An ordinary Chat assistant-role selector cannot identify these Dot messages.

These are observed metadata locations. The semantic binding adapter, submitting
guards, accepted-message checkpoint, and received-message capture remain to be
implemented and tested against them.

## Reply association limitation

None of those 32 records exposed a populated reply parent or reply root in the
captured representation. Incoming records had empty request identifiers;
outgoing records carried request identifiers. This bounded capture does not
establish whether every future Dot exchange lacks a native reply relationship.

A subsequent capture resolved message data from the current DOM host props’
child elements, keyed by rendered message identifier. It matched the fiber
capture’s identifiers and sender fields for all 35 rendered records. Neither
reply field was populated there either. This supports the current capture; it
does not make private React properties a stable provider API.

The inspected messaging asset explicitly consumes `replyTo.messageId` and
`replyRootMessageId` to record thread relationships. It also uses request
identifiers to reconcile optimistic send identifiers with canonical message
identifiers. Request identifiers must not be treated as reply links merely
because their name sounds suitable.

The current evidence does not satisfy the active plan's requirement to return
the reply to a particular submitted prompt. A new incoming Dot message could
also be a proactive update. Its arrival alone must not become a matched reply
or completed background work.

The product decision remains open: preserve the matched-reply requirement and
investigate a stronger native association, or expose separate message delivery
and message-reading operations. The latter is a proposed change to the active
plan, not an implemented fallback or a completed feature.

## Closeout

The temporary source import was removed. The extra inspection tab was closed;
the existing main session was used for the successful discovery and remains
on the Dot page. No permission or task-control button was operated. The
read-only inspector remains in the running diagnostic process until it exits;
it is absent from the source tree and has no product tool registration.

The active plan remains active. The protocol commit has not been pushed, and
this probe does not establish runtime send support or CI verification.
