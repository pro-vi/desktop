# Search-Unit Message Markup Probe

- **Date:** 2026-09-25 evening to 2026-09-26 early morning PDT
- **Status:** The markup is mapped; answers, conversation reads and transcript sync work on it (`8d94029` and the commit that adds this record)
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session, read over a local DevTools port (`--remote-debugging-port`, 127.0.0.1 only) on a hand-started Electron; the app was restarted through MCP without the port afterwards
- **Consent:** reads need none (nothing is sent). The user approved two `extended-pro` sends on new keys for this probe: one to watch the markup while an answer is generated, one to verify the fix

## Question

Since 2026-09-25 every Pro query failed at the hard deadline with "no complete assistant turn was recognised", while the answer was on the page, and every conversation read returned `conversation_messages_not_found`. What does the conversation page serve now, and what does a reader need from it?

## What the page serves

Checked on four conversations: a one-exchange Pro answer, a one-exchange 46K-character consult, a 7-exchange consult and a 416-message conversation.

| Earlier markup | Current markup |
|---|---|
| `[data-message-author-role="user\|assistant"]` on each message | a unit per message, `[data-chatgpt-search-unit-key="fallback-turn-K:I:<role>"]`; the role is the last segment |
| `[data-message-id]` | user unit: `data-chatgpt-search-message-ids="<id>"`; assistant unit: the same list (an id repeated, or several ids), and its content element `[data-chatgpt-selection-conversation-id]` carries `data-chatgpt-selection-message-id` |
| `[data-testid="conversation-turn-N"]`, an absolute position per message | nothing absolute: one `[data-turn-key="<user message id>"]` container per exchange, and `fallback-turn-K` counts within what is rendered |
| a scroller whose top is `scrollTop` 0 | `[data-app-action-timeline-scroll]`, a `column-reverse` container: the bottom is `scrollTop` 0 and the top is negative |

The user unit holds only the message text. The assistant unit also holds an `h4` "ChatGPT said:" heading; its content element does not.

## While an answer is generated

Recorded once a second during send 1 (run `9ea73bf8-c0e6-46d9-819e-4bdbc24d2012`, "Write three short paragraphs about rivers.", stopped after the observation):

| Phase | Stop button | Assistant markup |
|---|---|---|
| thinking, 0–31 s | visible | no assistant unit; a `[role=status][aria-busy=true]` "ChatGPT is responding" span |
| streaming, about 1 s | visible | assistant unit with an empty id list; content element present, no message id, `data-markdown-animated` set |
| done | gone | the content element gains `data-chatgpt-selection-message-id`; the unit's id list stays empty until a reload |

## Long conversations

- The 416-message conversation (`690126b6`) serves about 5 exchanges at a time; scrolling up swaps older ones in and renumbers `fallback-turn-K` from what is rendered.
- Older history loads in chunks. While it loads, a `[role="status"]` spinner (screen-reader text "Loading older messages…") sits above the first message, and the area cannot scroll further up. Chunks arrived up to about 2 s apart. A fully loaded conversation has no spinner.
- A freshly loaded chunk rendered whole, about 7,300 px above the viewport, before the next scroll.
- Rich content fills in after a message is first served: one assistant message read 8,575 characters, then 8,623 once a news link card loaded.
- A reply and the Deep Research report after it are one unit: `data-chatgpt-search-message-ids="92ae40f1… 92ae40f1… 1790a703…"`, one content element, no selection id. The 416 messages of the earlier markup are 400 turns here; the 18 reports sit inside the turn of the reply before them, and all their text is present.

## Results

- Send 2 (run `d40d0884-de4a-406f-a1f3-3860c4e1a6cb`, same prompt, after `8d94029`): `success` in 40.6 s, `nodeBasis: role-qualified`, answer id `71c133b6-32b5-456f-b325-686534708d2e`, prompt delivery checked and complete.
- `agentify_read_conversation`, 7-exchange conversation `6ab4fab5`: `complete`, 14 messages, user and assistant alternating from the opening brief.
- Same, 416-message conversation `690126b6`, on a cold app: `complete`, 400 turns, 1,612,200 characters, 211 passes. Against the saved snapshot of the earlier markup: order preserved; the 18 absent ids are the Deep Research reports above.
- `agentify_sync_transcript` on `6ab76e72` (send 2's conversation): `partial` / `compatibility_drift` three times before the anchor wait, then `complete`; the snapshot holds `71c133b6…` as its assistant turn.

## Failures found on the way, each fixed and covered by a test

- The area was stepped from the first rendered message; a chunk that loaded between passes put that message 7,300 px above the transcript's edge, and the next window shared no id (`ambiguous_message_overlap`). Steps now anchor on the transcript's own edge message.
- Four quiet passes (about 2.6 s) could end at the top of what was loaded. The top now also requires no status spinner above the first message.
- The transcript capability resolved its assistant anchor right after navigation, before the conversation hydrated; an absent anchor turned a complete capture into drift. The capture now waits (bounded) for a served assistant message first.
