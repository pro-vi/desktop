# Prompt Line Delivery Probe

- **Date:** 2026-09-23 (morning PDT)
- **Status:** Loss reproduced four times; the composer read-back did not catch it and was dropped; the after-send check in `1e55f49` reports it
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session, Instant mode, new keyed tab
- **Build:** `2f4ab64` (composer read-back before send, since dropped), respawned via `agentify_shutdown` at 07:19 PDT with no run in flight; verification on `1e55f49`, respawned at 16:23 PDT
- **Consent:** the user approved this one probe: resend the exact brief once, check the run and ChatGPT's copy, record, close the tab

## Question

On 2026-09-04, run `6e473397-2890-446a-9725-0ecd77ed687c` sent a 41-line brief. ChatGPT's copy lacked one line, the "verifiable judgment" bullet: `  - verifiable judgment: … Resolved by writing the shape and a branch per outcome: `gate — <exercise> → if <shape A> continue; if <shape B> <named re-plan>; else stop`.` Agentify's run record held the line. Does the same prompt lose the same line again? If it does, does a read-back of the composer before send catch it?

## Procedure

1. Confirmed no run was in flight (`/status`: no active queries), then ran `agentify_shutdown` and respawned at `2f4ab64`.
2. `POST /query` with the prompt copied byte for byte from run `6e473397`'s `logicalRequest.prompt` (9,035 chars, 41 non-empty lines), key `probe-composer-readback`, `modeIntent: instant`, `fireAndForget: true`.
3. Polled `/runs/get` until the run was terminal, then read the committed transcript snapshot.
4. Closed the probe tab.

## Observations

- Run `c848342b-e231-4680-972b-831e1052aa45` finished `success`. It did not fail with `prompt_composer_mismatch`. The run record keeps only the final phase, so it cannot show whether a `retyping_prompt` retry happened.
- In the transcript snapshot (`transcript-library/blobs/snapshot/sha256/74/74164044…`), ChatGPT's copy of the prompt holds 40 of 41 lines. The one missing line is the "verifiable judgment" bullet, the same line as on 2026-09-04. The text runs straight from the end of the `content` bullet ("…the build continues with everything else.") into "- taste judgment:".
- The model confirms it did not receive the line: "H1 says four kinds but lists three: consent, content, taste judgment."
- Lines holding other `<…>` tokens arrived intact: line 10 (`` `auto — <check>` ``, `` `pause — <exercise>` ``) and the `content` bullet (`"unverified — needs <content>"`).
- Conversation: `https://chatgpt.com/g/g-p-69c9d0b3c3b88191872d6b59cb5adfb8-agentify/c/6ab3e020-bfec-83e8-ac93-7e1ce83e582f`.

## Verdict

- The loss is deterministic for this line: the same prompt lost the same line on two builds, 19 days apart.
- The model's input lacked the line, so the loss happens at or before ChatGPT receives the message, not in the transcript capture.
- The composer read-back in `2f4ab64` passed while the line was lost. Two explanations fit, and this probe cannot tell them apart. Either the composer's DOM held the full text and ChatGPT dropped the line when it serialized or sent the message. Or the read-back could not read the composer and skipped itself, which it does by design when the read fails.
- What distinguishes this line from the two surviving `<…>` lines is not established. Candidates are tokens with a space inside the brackets (`<shape A>`, `<named re-plan>`), several tokens in one code span, and the `→` character.

## Trigger search (three more sends, consented, one tab)

The user approved up to three further short Instant-mode sends to find the trigger. Each send put several variants into one message, rather than one variant per send, so three sends covered more cases. Each was checked two ways: in ChatGPT's copy of the user turn, and in the model's own answer.

| Run | What was sent | "verifiable judgment" bullet reached the model? |
|---|---|---|
| `a7b9e907-26a7-464a-aa61-b62f9b8d19ba` | 12 labelled paragraphs: the exact line inside a 3-item bullet list, the line as plain text, with `<…>` swapped for `[…]`, without backticks, with `->` for `→`, the code span alone, and single-token pieces. Every line ended with a `(Vnn)` label. | yes: the model listed all 12 labels |
| `a0098ddf-e6b4-437f-ae50-a795781b112f` | lines 16–24 of the original brief, verbatim | no: "3: consent, content, taste judgment" |
| `42bb9017-bf02-45f3-927d-6ac2d5f80895` | two sections: X with the preceding bullet's `<content>` swapped for `[content]`; Y verbatim but with a blank line between the `H1.` line and the list | no in both: "X 3 consent content taste judgment Y 3 consent content taste judgment" |

What this settles:
- The trigger is inside the four verbatim H1 bullets. A bare `<content>` in the preceding bullet is not needed, and neither is a list that follows a paragraph line directly.
- The same line survives when a label follows its closing `` `. ``, and when the other bullets are not its full-length neighbors. This probe did not separate those two differences.

Both probe tabs were closed afterwards.

## Verifying the after-send check (one more send, consented)

`2f4ab64` was dropped because it guards the wrong step. `1e55f49` instead reads the last user turn ChatGPT recorded after the answer completes, and checks that every prompt line's letters and digits appear in it. With Agentify respawned on `1e55f49`, the verbatim excerpt (lines 16–24) was sent once more on key `probe-delivery-check`:

- Run `29090c00-105c-4b3d-ae1a-e215de862ef9`: the model again answered "3 consent content taste judgment".
- The run record carries `promptDelivery: { checked: true, complete: false, missingLineCount: 1, firstMissingLine: "- verifiable judgment: a decision that needs evidence the unit produces, …" }`.
- The probe tab was closed.

The check reports this loss on the real page. It does not prevent the loss, which happens on ChatGPT's side; the trigger inside those four bullets is still not isolated.
