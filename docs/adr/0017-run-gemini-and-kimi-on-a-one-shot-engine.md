# ADR 0017: Run Gemini and Kimi on a One-Shot Engine Beside the ChatGPT Controller

- **Status:** Accepted
- **Date:** 2026-11-18
- **Deciders:** the maintainer, who approved this design on 2026-11-18, and the 2026-11-18 build session
- **References:** `oneshot-engine.mjs`, `oneshot-page-scripts.mjs`, `oneshot-profile.mjs`, `oneshot-sites/`; ADR 0002 (receipt-backed completion), ADR 0005 (fail closed on an unhonored intent), ADR 0007 (completion evidence), ADR 0009 (turn identity), ADR 0014 (prompt delivery)

## Context

A benchmark needs the same one-shot task on ChatGPT, Gemini and Kimi: open a fresh chat, pick the site's strongest setting, attach documents, send one prompt, and save the answer with its sources. ChatGPT already does this through `ChatGPTController`. Every other vendor was also created as a `ChatGPTController`, fed `selectors.json` as one flat list of fallback selectors shared by all sites, and given a "legacy" compatibility contract with no profile. Kimi was not a vendor at all.

That path cannot serve a benchmark on Gemini or Kimi. It has no way to select their modes, it waits on ChatGPT's completion signals, it captures plain text without links, and it keeps reusing one conversation per key.

## Decision

Add a site-neutral one-shot engine (`OneShotController`) beside `ChatGPTController`. `main.mjs` gives a tab the engine when `oneshot-sites/index.mjs` has an adapter for its vendor, which today means Gemini and Kimi. Every other vendor, ChatGPT included, keeps the controller it had.

The engine owns what every site shares:

- **Readiness:** the composer must show with no sign-in marker, terms gate, password field or CAPTCHA in front of it. A blocked page puts the tab in needs-attention.
- **One fresh chat per query:** a chat that opens with turns in it is refused. `chatUrl`, `projectUrl` and `liveSourceId` are refused for these vendors at the HTTP layer.
- **Mode by intent, confirmed on the page before the composer is touched:** an intent the adapter does not know, or one the page does not confirm, fails the run without sending. This is the rule ADR 0005 set for ChatGPT's `modelIntent`.
- **Attachments:** files go into the page's `input[type=file]`, and the run waits until each one shows as uploaded. An upload error, a pending upload at the deadline, or a file the page never shows fails the run before send.
- **Prompt staging:** the prompt is typed, then the composer's text is compared with it. A mismatch fails with ChatGPT's `prompt_staging_failed` shape.
- **Send acknowledgment.**
- **Completion:** the run completes on an assistant turn newer than the pre-send count, whose answer text is not a progress-only label and has not changed for the stable window, with no stop control showing and no error in the turn. Only then does the result carry `assistant-node` completion evidence (ADR 0007).
- **Prompt delivery:** the user turn the site recorded is checked for every prompt line (ADR 0014).

Each site is an adapter: a page-element profile (`oneshot-sites/<site>.json`) plus functions to build the fresh-chat URL, apply a mode intent, reveal the file input, prepare the answer for capture, and read the model and mode the page shows after the answer.

The profile keeps the capabilities → anchors → branches shape of `chatgpt-compatibility.json`. Each branch records where its selector came from: `live-page`, `share-page` or `guess`. It is read by a sibling parser, `oneshot-profile.mjs`, instead of a generalized `chatgpt-compatibility.mjs`. The ChatGPT parser is bound to vendor `chatgpt`, to `legacySelectorKey` projection, to exemptions and to the compatibility store's observations. Generalizing it would change code on the ChatGPT path, which this decision keeps fixed.

Answers are captured as Markdown. Links stay inline, and citation markers become numbered links. Sources from citations or a sources panel are listed under the answer. The run writes the same `assistant_response.md` and `metadata.json` as a ChatGPT run, and adds two sibling files:

- `assistant_response.txt`: the plain text.
- `sources.json`: every distinct source, with the kinds of place it appeared.

The sources go in a sibling file, not the run record, because a run record is listed and returned whole, and a researched answer can cite dozens of pages. `outputManifest` (and `metadata.json`) carry `answerSettings`: the model and mode the page showed, or the reason they could not be read. An unread setting labels the run "mode unverified".

## Why ChatGPT stays on its controller for now

`ChatGPTController` carries ChatGPT-specific proofs that the engine does not have:

- the answer mode read from response metadata;
- the turn-identity gate on provider message ids;
- structured conversation recovery after the soft deadline;
- Deep Research export;
- Dot messaging;
- project and conversation routing.

Each of these comes with tests and live probes. Moving ChatGPT onto the engine would mean re-proving all of them for no gain to the benchmark, whose ChatGPT arm already works. Some duplication between the two (prompt staging, the delivery check, typing) is accepted until then.

## Consequences

Positive:

- Gemini and Kimi runs end in the same artifact, receipt and run-record shape as ChatGPT runs. Any intent, staging, attachment or completion failure stops the run before a wrong answer is saved.
- A new site is a profile and an adapter. It does not touch the ChatGPT path.

Negative:

- A Gemini or Kimi key no longer continues a conversation. Every query opens a fresh chat, which changes behavior for existing Gemini callers.
- `selectors.override.json` no longer applies to Gemini or Kimi.
- Turn identity is by count, not by provider message id, so it relies on the fresh chat having no assistant turn before send.
- Many selectors start as guesses: stop controls, attachment chips, error surfaces, Kimi's citations, and Gemini's live answer turn. The profiles mark them `guess` until a live probe confirms them. A wrong stop selector leaves completion to text stability alone.
- Gemini citations hold no URL in the answer. The adapter clicks each citation chip after the answer completes to read its source card, which adds page interaction after the answer.

## Revisit Triggers

Move ChatGPT onto the engine when any of these holds:

- A ChatGPT UI change forces rework of its composer, attachment or completion path anyway.
- A third one-shot site is added and the duplication starts to cost more than the proofs above.
- The benchmark needs ChatGPT runs to produce `answerSettings`, `sources.json` and plain text in exactly the engine's shape.

Revisit the engine itself when a site exposes per-message ids (to restore id-based turn identity), or when a live probe shows a site's final answer surface that the completion rule cannot express.
