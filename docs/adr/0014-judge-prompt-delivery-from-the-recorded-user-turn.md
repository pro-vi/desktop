# ADR 0014: Judge Prompt Delivery From the Recorded User Turn

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** the maintainer, who selected "Drop it, check after send" on 2026-09-23, and the 2026-09-23 session
- **References:** `1e55f49`; `#readPromptDelivery()` in `chatgpt-controller.mjs`; `docs/probes/2026-09-23-prompt-line-delivery-probe.md`; `BACKLOG.md`, "Isolate what makes ChatGPT drop a prompt line"

## Context

A 41-line brief loses one of its bullets on the way to ChatGPT, every time (4 of 4 sends). Agentify's run record holds the line. ChatGPT's copy of the user turn lacks it, and the model answers without it. A read-back of the composer before send was built and never merged: on the real page it passed while the line was still lost. So the loss happens at or after send, where the composer cannot show it.

## Decision

After a query completes, read the last user turn ChatGPT recorded and check that each prompt line's letters and digits appear in it. Expand a collapsed user message before reading it. Record `promptDelivery: { checked, complete, missingLineCount, firstMissingLine, firstMissingLineNumber, lastMissingLineNumber, missingLines }` on the result and the run record. Line numbers are one-based positions in the original prompt; the first/last positions bound the missing lines without claiming every intervening line is missing. Keep the text preview bounded to ten lines. Add a `prompt_delivery_incomplete` text line to `agentify_query` and `agentify_wait_run`. Report, do not fail. A user turn that cannot be read within 2 seconds is `checked: false` and never blocks the result. Expansion gets at most 1 second within that budget. Transcript capture uses the same expansion before reading each window and remains partial if expansion fails.

## Rationale

- **Composer read-back before send:** rejected. It passed on the real page while the line was lost.
- **Escape `<…>` in prompts:** rejected. Angle brackets are not the trigger: other `<…>` lines in the same brief arrived, and the lost line's placeholders were already inside backticks.
- **Fail the run:** rejected. The provider has already answered, and the caller can decide with the flag in hand.
- **Compare letters and digits line by line:** chosen because it tolerates markdown rendering and labels the page adds inside a turn. A whole-prompt substring match would break on any inserted label.

## Consequences

Positive:

- A partial prompt is no longer silent: the caller sees it in text, whichever read path it uses.

Negative:

- The check reports the loss; it cannot prevent it.
- A loss inside a single line is not detected.
- Expansion depends on the provider's user-message control. If it stops working, delivery is unchecked and transcript capture is partial.
- The user-turn selector is a new submit dependency (`controller-dom-051` in `chatgpt-compatibility.json`).

## Revisit Triggers

- The trigger is isolated and can be avoided client-side: prevention may join or replace reporting.
- Real runs report a false missing line despite expanding the recorded user message.
- ChatGPT changes the user-turn DOM, and `controller-dom-051` observations start failing.

## Evidence update — 2026-10-10

A collapsed user message produced a false incomplete-delivery report and a clipped transcript on `45f4dcbc`. Expanding its native Show more control revealed every prompt line. The initial read-only checks in the [collapsed-message probe](../probes/2026-10-10-collapsed-user-message-read.md) verified the delivery reader and repeated transcript capture without another provider send. The report also records the subsequent live acceptance checks.

## References

- Tests: "a line missing from the user turn ChatGPT recorded is reported on the result", "markdown rendering and page labels in the recorded user turn are not missing lines", "a user turn that cannot be read leaves delivery unchecked without blocking the result" (`tests/chatgpt-controller.test.mjs`); "a query result that reports a missing prompt line keeps it on the run record" (`tests/http-api.test.mjs`); "mcp query and wait_run state an incomplete prompt delivery in text" (`tests/mcp-tool-profile-integration.test.mjs`).
