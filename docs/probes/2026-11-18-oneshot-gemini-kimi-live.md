# One-shot engine on Gemini and Kimi: live probes

The one-shot engine (ADR 0017) was run live on Gemini and Kimi on 2026-11-18, with the maintainer's consent for these probes. All content was synthetic:
- a one-line probe prompt with two made-up files: a one-page PDF and a one-paragraph Word document;
- a synthetic KYC client file (persona "Daniel Weiss"; every person, company and figure in it is invented).

Every run used a fresh chat in a separate Agentify instance (`npm run bench`). That instance was signed in to the sites under test and started with a local DevTools port. A watcher read the page every 0.5–0.7 s during each run, without acting on it, to check the profile selectors against what the page actually showed.

The probes found twelve defects. Each was fixed with a stub-page test that fails on a planted copy of the defect, before the next run.

Kimi never answered the KYC case. Between 11:01 and 12:42 UTC it refused the free account's sends under load ("Too many people are chatting with Kimi; a subscription will grant you priority access") on every model tried, Instant included, with one exception: K2.8 Preview took the case at 11:42, worked on it for over 30 minutes, and the run was cut off by a deadline defect since fixed. Kimi's end-to-end evidence is the probe run `25836d92`.

## Runtime

- Electron 39.6.0, unpackaged, run from the branch.
- Each run's code is named by the commit the instance was started from. "4797c63+" means that commit plus working-tree changes later committed in the commit named.
- Sites as served on 2026-11-18:
  - Gemini: the web app at `gemini.google.com/app`, on an organization (Workspace) account;
  - Kimi: the international site `www.kimi.ai`, on a free account.

## Runs

| Run | Site | Mode | Path | Files | Code | Outcome |
|---|---|---|---|---|---|---|
| `25836d92` | Kimi | page default (Instant) | HTTP | 2 probe | `4797c63` | success, 24.6 s |
| `cd4b8392` | Kimi | `k3.1-pro` | HTTP | 2 probe | `4797c63` | refused by Kimi's capacity notice; the engine took an emptied composer as the send and waited; stopped by hand |
| `4f43c6b7` | Gemini | page default (4 Hydrogen) | HTTP | 2 probe | `4797c63` | success, 24.7 s |
| `2d93a404` | Gemini | `pro` | HTTP | 2 probe | `4797c63` | `mode_intent_unavailable` before typing: the picker shows "Pro", not the option's "3.1 Pro" |
| `2581862d` | Gemini | `pro` | HTTP | 2 probe | `4797c63+` (`d0b8936`) | failed on a bug in uncommitted code after upload, before typing |
| `50cb82fd` | Gemini | `pro` | HTTP | 2 probe | `4797c63+` (`d0b8936`) | success, 66.5 s; mode confirmed through the menu's checked option |
| `b95ae10a` | Gemini | `pro` | HTTP | Weiss 8 | `d0b8936` | `mode_intent_unavailable` (`mode_picker_missing`) 0.6 s after the fresh chat opened: the picker had not rendered yet. Nothing uploaded. |
| `006e6111` | Gemini | `pro` | HTTP | Weiss 8 | `a2456a0` | `attachment_not_shown`: Gemini shortens long names in the middle. Files uploaded; nothing sent. |
| `5607df6e` | Kimi | `k3.1-pro` | MCP | Weiss 8 | `a2456a0` | `prompt_staging_failed`: the composer held the prompt with its last character doubled. Nothing sent. |
| `de740698` | Gemini | `pro` | MCP | Weiss 8 | `4266f50` | **success**, 84.9 s; labeled "mode downgraded" because the Pro option's model line turned into a quota notice after the answer (fixed in `e3e8902`) |
| `00f56b01` | Kimi | `k3.1-pro` | MCP | Weiss 8 | `4266f50` | `send_not_triggered`: Send stayed disabled while Kimi processed the files and the engine waited 3 s. Nothing sent. |
| `e82350b1` | Kimi | `k3.1-pro` | MCP | Weiss 8 | `e3e8902` | Kimi took the prompt, then showed its capacity notice and returned to an empty page; the engine waited; stopped by hand (fixed in `c71d17b`) |
| `ba420409` | Gemini | `deep-research` | MCP | 2 probe | `e3e8902` | refused: "Mode not offered", before any page work |
| `4b47ce0e` | Kimi | `deep-research` | MCP | 2 probe | `e3e8902` | refused: "Mode not offered", before any page work |
| `8d4052de` | Kimi | `k3` | MCP | Weiss 8 | `c71d17b` | `send_refused` by the capacity notice, 21.5 s |
| `47f16869` | Kimi | `k2.8-preview` | MCP | Weiss 8 | `c71d17b` | `timeout_waiting_for_response` at the 30-minute deadline while Kimi was still working (web searches, a to-do list, terminal commands, Python); fixed in `7ef19c6`. Kimi went on working until the chat was stopped by hand at 12:15 UTC. |
| `138af86e` | Kimi | `k2.8-preview` | MCP | Weiss 8 | `7ef19c6` | `send_refused`: "You already have several chats open", because the chat of `47f16869` was still running |
| `2dc20f9b` | Kimi | `k2.8-preview` | MCP | Weiss 8 | `7ef19c6` | `mode_intent_unavailable` (`mode_changed_before_send`) after 3.4 s: the composer still held the files of refused drafts, which passed the upload check at once (fixed in `78071d7`), and the model read Instant at the check before Send. Nothing sent. |
| `26dd36ce` | Kimi | `instant` | MCP | Weiss 8 | `7ef19c6` | `send_refused` by the capacity notice |
| `64c00bd5` | Kimi | `instant` | MCP | 2 probe | `7ef19c6` | `send_refused` by the capacity notice; the composer then held 26 files from refused drafts |
| `1241deed` | Kimi | `instant` | MCP | 2 probe | `78071d7` | the 25-file draft was removed and exactly the 2 probe files matched; `prompt_staging_failed`: the prompt's last character doubled on both attempts (fixed in `0ca879d`). Nothing sent. |
| `f623d943` | Kimi | page default | MCP | none | `78071d7` | staged exactly over a draft ending in "."; `send_refused` by the capacity notice |
| `2d2b4546` | Kimi | `k3.1-pro` | MCP | Weiss 8 | `0ca879d` | `send_refused` by the capacity notice |
| `a7b2047e` | Kimi | `instant` | MCP | Weiss 8 | `0ca879d` | the 8-file draft was removed (the watcher saw 8, 7, 5, 3, then the 8 uploads); `send_refused` by the capacity notice |

The Weiss files, the same on both sites, are:
- the source-of-wealth narrative (`.docx`);
- seven PDFs: passport, bank statement, share purchase agreement, completion statement, a property contract, audited accounts, and a valuation.

That makes eight files, about 5 MB, within Gemini's limit of about ten files per message. The Weiss prompt (966 characters), as typed:

> I'm onboarding this client, Daniel Ari Weiss: born 1965 in Tel Aviv, Israeli and Italian, living in Forte dei Marmi, Italy since 2019. He plans to fund USD 10M with Intesa Sanpaolo Private Banking. From his source-of-wealth write-up:
> - Trained as a goldsmith in Ramat Gan, then worked as a bench jeweller in Hatton Garden, London, from 1990.
> - Founded Aurelia Costume Jewellery Ltd. (UK) in 1993, held 100% of it, and sold it in August 2018 for GBP 34.2M to a PE-backed accessories group.
> - Made gains trading London flats between 1998 and 2014, and from Bitcoin and Ethereum between 2017 and 2024.
> - Holds a USD 2.8M investment portfolio at Intesa Sanpaolo.
> The attached files are his source-of-wealth write-up and supporting documents. Research the client and review the profile: say whether the story is consistent with the documents and with what you can find online, flag anything missing, contradictory, or needing a supporting document, and cite your sources.

## End-to-end checks

**Gemini, Weiss run `de740698` (`pro`, through `agentify_query` and `agentify_wait_run`):**
- All 8 files matched:
  - 2 by stem and extension shown apart ("PDF doc_01_passport");
  - 6 by a name shortened in the middle ("PDF doc_02_ban..._statement").
- The prompt was delivered complete, as the 6-line check found it in Gemini's recorded user turn. The watcher saw the user turn collapsed, but the delivery check read every line.
- `assistant-node` evidence; receipt over `assistant_response.md` (6,694 characters).
- The model and mode were recorded:
  - before Send: "Detailed research" (3.1 Pro);
  - after the answer: still "Detailed research", but its model line read "Limit resets Nov 18, 7:03 AM". The account's Pro allowance was used up by this answer.
- Tool use is `none`. Gemini ran no web search: its answer says "I am unable to run live external searches to verify public records". No search switch was offered in the composer's tools menu ("Create image", "Create music", "Canvas", "Deep research", "Guided learning").
- Gemini cited the attached files 15 times. This run predates file citations (`e3e8902`), so its `sources.json` is empty.
- The answer found that the narrative's GBP 34.2M sale price contradicts the GBP 14.2M in the share purchase agreement, completion statement and valuation, and listed further contradictions and missing evidence.

**Kimi, Weiss runs:** no answer (see above). What the runs did show:
- Every refusal ended the run as `send_refused` with Kimi's notice quoted, before or after the send was acknowledged, and no run waited on a refused send.
- K2.8 Preview (`47f16869`) took the case and worked as an agent for over 30 minutes: the stop control showed and the turn had no action bar the whole time, so the completion rule kept waiting, as designed. The caller's 30-minute deadline then ended the run while Kimi was still working; the deadline is now soft (`7ef19c6`).
- Kimi keeps a refused send in the composer as a draft, files included, and the next chat shows it again. Runs `1241deed` and `a7b2047e` removed such drafts (25 and 8 files) through each chip's delete control before uploading.

**Probe runs `25836d92` (Kimi) and `4f43c6b7`, `50cb82fd` (Gemini):**
- Both files were matched and the prompt was delivered complete.
- `assistant-node` receipts were written.
- Each answer named Paris with a Britannica link, saved as an inline Markdown link and in `sources.json`.
- Kimi's Instant answer showed a tool-call flow with one web search ("Found 7 web pages") and a Reference panel citing Britannica.

## Selectors checked on the live pages

Now `live-page` in the profiles:

| Site | Anchor | Selector | What the watcher saw |
|---|---|---|---|
| Kimi | stop control | `div.send-button-container.stop` | present while the answer streamed, gone after |
| Kimi | idle signal | `.segment-assistant-actions` | on the finished turn |
| Kimi | attachment chip / pending | `div.file-card-container`, `.parsing` | "probe-brief Parsing" then "probe-brief PDF 622 Bytes" |
| Kimi | turns, answer | `div.segment.segment-user`, `div.segment.segment-assistant`, `div.markdown` | as on the share pages; the answer sits outside `.toolcall-rollup__part` |
| Kimi | refusal notice | `.modal-container` | "Too many people are chatting with Kimi; a subscription will grant you priority access." and "You already have several chats open." |
| Kimi | attachment delete control | `div.file-card-delete` | inside each chip; it removes the file only after the pointer has rested on the chip (a click without that did nothing) |
| Kimi | Reference panel | `.ref-action`, `div.ref`, `a.site-item` | "Reference sources 1", Britannica |
| Kimi | tool-call flow | `.toolcall-flow`, `button.toolcall-flow__summary`, `.toolcall-container.toolcall-web_search`, `.toolcall-trigger`, `a.search-tool-detail-item` | "Found 7 web pages", seven links with title and site |
| Gemini | stop control | `button[aria-label="Stop response"]` | present while the answer streamed |
| Gemini | idle signal | `message-actions` | absent while the Weiss answer streamed; present when finished |
| Gemini | attachment chip / pending | `uploader-file-preview`, `.gem-attachment-content.loading`, `mat-spinner` | "PDF probe-brief" after loading |
| Gemini | turns, answer | `user-query`, `model-response`, `message-content .markdown` | live |
| Gemini | citations | `source-inline-chip`, its dialog button, and file titles | file citations show `inline-source-card .title`, no link |
| Gemini | sources list | `sources-list` | present and empty on every answer seen |

Still guesses:
- Kimi: the attachment error state; the answer error element; inline citation markers. None appeared, since Kimi's sources showed only in its Reference panel.
- Gemini: the disabled Send state; the attachment error state; the thinking panel (`model-thoughts`), which no answer showed; the code-block header and language; the answer error element.

## Defects found live, and their fixes

| Seen in | Defect | Fix |
|---|---|---|
| `cd4b8392` | An emptied composer counted as a sent prompt; Kimi had emptied it, refused, and refilled it. | `d0b8936`: only a new user turn or a stop control acknowledges a send; a refusal notice ends the run as `send_refused`. |
| `2d93a404` | Gemini's picker shortens "3.1 Pro" to "Pro", so a correct selection was refused. | `d0b8936`: confirmed through the checked option in the reopened menu. |
| `b95ae10a` | The mode picker renders after the composer, so it was reported missing. | `a2456a0`: wait up to 10 s for it. |
| `006e6111` | Gemini shortens long names in the middle, and no rule matched them. | `4266f50`: a shortened name matches the one file whose stem fits both ends and shows no other type. |
| `5607df6e` | The prompt's last character was doubled after the Electron typing path. Typing the same lines by hand through DevTools staged exactly; the cause was not found. | `4266f50`: one clear-and-retype; a second mismatch still fails before Send. |
| `00f56b01` | Kimi keeps Send disabled while it processes attachments after typing; the engine gave up after 3 s. | `e3e8902`: wait up to 60 s. |
| `de740698` | A quota notice in Gemini's model line was read as a mode change. | `e3e8902`: each adapter names its selection (Kimi's model, Gemini's option), and that is compared. |
| `de740698` | Citations of attached files were dropped. | `e3e8902`: kept as file sources with no URL. |
| `e82350b1` | A refusal after the send was acknowledged left the run waiting. | `c71d17b`: a refusal notice with no answer text ends the run. |
| `47f16869` | The run ended at the caller's 30-minute deadline while Kimi was visibly still working. | `7ef19c6`: the deadline is soft; past it the run waits while a stop control or the idle signal shows, up to two hours. |
| `2dc20f9b`, `64c00bd5` | A refused send's files stayed in Kimi's composer for the next chat, and chips with the same names passed the upload check. | `78071d7`: a fresh chat must start with no files (the Kimi adapter removes a draft's files); the composer must show exactly the requested files. |
| `1241deed` | The prompt's last character doubled again, on both typing attempts, so the retype did not help. The cause is still not known; text inserted through DevTools staged exactly in five tries. | `0ca879d`: extra text after the complete prompt is deleted from the end, and the comparison is run again. |

## Probe runs after review round 2

The 2-file probe was run once more per site at `8933fc6`, through public MCP, on a bench started with plain `npm run bench` (no DevTools port, so no watcher).

| Run | Site | Mode | Outcome |
|---|---|---|---|
| `e92da7f2` | Gemini | `thinking` | success, 40.2 s |
| `704dda68` | Kimi | `instant` | `send_refused` after Kimi took the prompt (capacity notice), 13.8 s |
| `32fced69` | Kimi | `instant` | the same, 10.5 s |
| `60346b4d` | Kimi | `instant` | the same, 7.1 s |

What they showed:
- **Gemini `e92da7f2`:**
  - The mode was confirmed: "Solves complex problems", 4 Hydrogen Thinking, both before Send and after the answer.
  - Both files matched: `probe-brief.pdf` by stem and extension, `probe-notes.docx` by stem.
  - Typing took one attempt, and prompt delivery was complete.
  - The answer cited the two attached files. They were saved in `sources.json` as file sources with no URL, which is the first live check of file citations. Both chips gave their sources (`sourcesComplete: true`).
  - `tool_use.json` is `none`: no chip named a web page, the sources list was present and empty, and no thinking panel showed. The answer named Paris without a web source.
  - Attachment delivery reads "not checked", because Gemini's profile has no anchor for files in the sent turn.
- **Kimi:** each refusal was recorded with `failureStage: after_send` and a detail saying Kimi took the prompt first. No answer, so no tool use was saved. Each run reached Send, so the two probe files were found inside `div.chat-editor-attachment-area`: the composer's attachment area confirmed on the live page. Kimi had put back the earlier refused draft before these runs (seen at 12:42 UTC). Runs that reached Send therefore removed that draft inside the area first. This is inferred: a failed run's record does not list removed files.

## Review round 1 items checked live

| Item | What the live pages showed |
|---|---|
| Shift+Return sends | No, on either site. On Kimi, the engine typed the 6-line Weiss prompt in `5607df6e` and `00f56b01` without a user turn appearing, and typing it again by hand through DevTools did the same. On Gemini, the engine typed the same prompt in `de740698` and the turn count rose only at Send. |
| Clearing the composer removes attachments | No: the before-Send re-check passed on every run that reached Send. |
| Escape closes a Gemini citation card before the next chip | Yes. On the Weiss answer, a card opened by clicking its chip was gone 0.8 s after Escape. This was checked by hand through DevTools, with nothing sent. The loop now stops if a card is still open anyway. |
| Provider errors as answer text | Not seen. The answer-error selectors stay guesses. |
| Gemini collapses a long prompt in the user turn | The watcher flagged the Weiss user turn as collapsed. Prompt delivery still read all 6 lines as present. |
| Mode reset before Send | Not seen. The re-check passed on every run that reached Send. |
| Kimi's pending selector `[class*="loading"]` | Replaced by `div.file-card-container.parsing`, the class the chip carried while parsing. |
