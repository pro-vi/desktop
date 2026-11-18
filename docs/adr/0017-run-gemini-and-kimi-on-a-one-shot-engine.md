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
- **Mode by intent, confirmed on the page before the composer is touched and read again just before Send:** an intent the adapter does not know, or one the page does not confirm or no longer shows, fails the run without sending. This is the rule ADR 0005 set for ChatGPT's `modelIntent`.
- **Attachments:** a fresh chat must start with no files. A send the site refused can leave its files in the composer for the next chat; the adapter removes them, or the run stops. Files then go into the page's `input[type=file]`, and the run waits until the page shows exactly the requested files as uploaded, each matched by its full name, by its stem with the extension shown apart, by a stem no other file shares, or by a name shortened in the middle. The same check runs again just before Send. An upload error, a pending upload at the deadline, a file the page never shows, or a file nobody requested fails the run before send.
- **Prompt staging:** the prompt is typed, then the composer's text is compared with it. Extra text after the complete prompt is deleted from the end; any other mismatch is cleared and retyped once; a mismatch left after that fails with ChatGPT's `prompt_staging_failed` shape. A user turn that appears while typing fails the run as `prompt_sent_early`.
- **Send acknowledgment:** only a new user turn or a stop control proves the send. An emptied composer does not, because a site can empty it and refill it when it refuses. A refusal notice with no answer text, before or after the acknowledgment, ends the run as `send_refused`.
- **Completion:** the run completes on an assistant turn newer than the pre-send count, whose answer text is not a progress-only label and has not changed for the stable window, with no stop control showing, the turn's own idle signal showing (its action bar), and no error in the turn. A missing stop control alone never completes a run: a search pause looks the same. Only then does the result carry `assistant-node` completion evidence (ADR 0007). The caller's timeout is a soft deadline, as ADR 0002 makes it for ChatGPT: past it the run keeps waiting while the page shows a stop control or the turn's idle signal, up to two hours.
- **Prompt delivery:** each prompt line's letters and digits must appear somewhere in the user turn the site recorded (ADR 0014). It is a report, not a gate, and it does not catch reordered lines, a lost line repeated or contained elsewhere, or changed digits inside a line.

Each site is an adapter: a page-element profile (`oneshot-sites/<site>.json`) plus functions to build the fresh-chat URL, remove files a refused draft left behind, apply a mode intent, read the mode label for the check before Send, reveal the file input, prepare the answer for capture, read the tool use, and read the model and mode the page shows after the answer.

The profile keeps the capabilities → anchors → branches shape of `chatgpt-compatibility.json`. Each branch records where its selector came from: `live-page`, `share-page` or `guess`. It is read by a sibling parser, `oneshot-profile.mjs`, instead of a generalized `chatgpt-compatibility.mjs`. The ChatGPT parser is bound to vendor `chatgpt`, to `legacySelectorKey` projection, to exemptions and to the compatibility store's observations. Generalizing it would change code on the ChatGPT path, which this decision keeps fixed.

Deep research is not offered on either site. Its first stable text can be a plan or a clarifying question, and the engine has no check for its final report; it returns only with a site-specific final-report check and its own completion evidence source, which the query flow does not accept.

The page's tool use (the web searches and pages it shows for the answer, never the reasoning text) is saved as `tool_use.json` in one of three states: `shown` with the steps in page order, `none` when the page showed none, or `unread` with the reason. The run record carries its counts (`toolUseCounts`).

Answers are captured as Markdown. Links stay inline, and citation markers become numbered links. Sources from citations or a sources panel are listed under the answer. The run writes the same `assistant_response.md` and `metadata.json` as a ChatGPT run, and adds three sibling files:

- `assistant_response.txt`: the plain text.
- `sources.json`: every distinct source, with the kinds of place it appeared. A cited attached file has a title and no URL.
- `tool_use.json`: the tool use described above.

The sources go in a sibling file, not the run record, because a run record is listed and returned whole, and a researched answer can cite dozens of pages. `outputManifest` (and `metadata.json`) carry `answerSettings`: the model and mode the page showed, or the reason they could not be read. An unread setting labels the run "mode unverified". A selection that reads differently after the answer than before Send also labels it "mode downgraded" and records `degradedFrom`.

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

- Gemini and Kimi runs end in the same artifact, receipt and run-record shape as ChatGPT runs. A mode the page does not confirm, a prompt the composer does not hold, an attachment the page does not show, and an answer without its idle signal each stop the run before an answer is saved.
- A new site is a profile and an adapter. It does not touch the ChatGPT path.

Negative:

- A Gemini or Kimi key no longer continues a conversation. Every query opens a fresh chat, which changes behavior for existing Gemini callers.
- `selectors.override.json` no longer applies to Gemini or Kimi.
- Turn identity is by count, not by provider message id, so it relies on the fresh chat having no assistant turn before send.
- Some selectors are still guesses: the attachment and answer error surfaces, Kimi's inline citation markers, and Gemini's disabled Send state, thinking panel and code-block header. The profiles mark them `guess` until a live probe confirms them.
- Gemini citations hold no URL in the answer. The adapter clicks each citation chip (at most 40) after the answer completes to read its source card, which adds page interaction after the answer.

## Revisit Triggers

Move ChatGPT onto the engine when any of these holds:

- A ChatGPT UI change forces rework of its composer, attachment or completion path anyway.
- A third one-shot site is added and the duplication starts to cost more than the proofs above.
- The benchmark needs ChatGPT runs to produce `answerSettings`, `sources.json` and plain text in exactly the engine's shape.

Revisit the engine itself when a site exposes per-message ids (to restore id-based turn identity), or when a live probe shows a site's final answer surface that the completion rule cannot express.
