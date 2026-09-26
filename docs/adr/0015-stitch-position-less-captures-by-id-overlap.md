# ADR 0015: Stitch Position-Less Captures by Id Overlap

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** the 2026-09-26 session, under the maintainer's instruction to "diagnose it first, and then you know, fix that" and their choice to continue into the long-conversation reader
- **References:** `8d94029`; `#captureConversationBundle()` and `captureConversation()` in `chatgpt-controller.mjs`; `controller-dom-043`, `-055`, `-056` in `chatgpt-compatibility.json`; `docs/probes/2026-09-26-search-unit-markup-probe.md`

## Context

The conversation capture proved a transcript complete from per-message positions (`conversation-turn-N`): windows were ordered by position and gaps were ruled out position by position. ChatGPT's current markup has no position. Each message is a search unit with a role and provider ids; the page renders about five exchanges at a time in a `column-reverse` scroller and loads older history in chunks. Without positions every capture ended `compatibility_drift`.

## Decision

On the search-unit markup (units present, no turn-ordinal owner), a capture is `complete` when all of these hold:

- every window joined the transcript through a provider id it shares with the transcript, the path the merge already had for id-bearing windows;
- every turn in the transcript carries a provider id;
- the top boundary: the message area cannot move up, no status spinner sits above the first message, and four passes in a row added nothing;
- the bottom boundary: the message area cannot move down and four passes in a row added nothing.

The walk steps the message area itself, lowering or raising `scrollTop` so the transcript's edge message stays 40 px inside the viewport. A message whose text changes under the same id takes the later reading, and a window is re-read until it produces no change. Before the transcript anchor is resolved, the capture waits (bounded by the first-message budget) for a served assistant message.

## Rationale

- **Derive positions from `fallback-turn-K`:** rejected. The number counts within what is rendered and is renumbered as the window moves.
- **Keep requiring positions:** rejected. It leaves every read and transcript sync failing on the current page.
- **Id overlap:** chosen because each rendered window is a contiguous run of messages, so a window that shares an id with the transcript's edge extends it with nothing skipped. The fail-closed cases stay fail-closed: a window with no shared id, a message without an id, or text still changing after the re-reads end `partial`.

## Consequences

Positive:

- Pro answers, conversation reads and transcript sync work on the current page; the earlier markup keeps its position-based path unchanged.

Negative:

- Contiguity of a rendered window is an assumption about ChatGPT's virtualizer, not something the page proves. A virtualizer that skipped messages inside one window would go unnoticed.
- A reply and the Deep Research report after it render as one unit with one content element; the capture keeps them as one turn under the unit's first id. Transcripts taken on the earlier markup split them.
- Conversation file artifacts still need positions, so on this markup an artifact inventory with file cards is `partial`.
- The top boundary rests on the status spinner; a load that fails without one would end early.

## Revisit Triggers

- A capture reports `complete` while a known message is missing from it.
- ChatGPT adds an absolute position to the search units: positions should then prove order again.
- The spinner or the unit keys change shape, and `controller-dom-055` or `-056` observations start failing.

## References

- Tests: "captureConversation stitches the search-unit markup by id up to a loaded top", "search-unit capture steps from its own edge when a chunk lands between passes", "search-unit capture keeps the later reading of a message whose content fills in", "a search-unit unit holding several messages is one turn under its first id", "a search-unit message without any id leaves the capture partial", "route inspection counts served search-unit messages by id", "capture waits for a hydrating conversation before resolving its transcript anchor" (`tests/chatgpt-controller.test.mjs`).
