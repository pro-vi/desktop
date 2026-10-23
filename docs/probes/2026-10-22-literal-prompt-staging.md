# Literal prompt staging

The attachment failure reported on 2026-10-17 remains unexplained. One current
29-byte text attachment uploaded successfully with explicit consent, reached
`upload_done`, and was removed. No renderer exception was observed. This does
not establish why the older uploads failed, or verify other attachment types.

## Prompt staging

Baseline: `f5f046b76c9c21c6bfe966fe79dd21949c4d17df`.
Runtime: Electron 39.6.0, Chromium 142.0.7444.265, embedded Node 22.22.0.
The ChatGPT web build is not exposed. The observed
`composerController.updateLiteralText` function has SHA-256
`4914a092c55695bc01077083ceac6600ffe70f6b4c6105ef4b28881dbf3f7bb4`.

Character insertion converted ``Use `value` here.`` into rendered inline code
without its backticks. Whole-line insertion avoided that example, but still
rewrote a bare inline-code line and a code fence. Native HTML insertion and
composition input did not reliably preserve all cases. None of those attempted
input changes is included in the repair.

The focused rich editor exposes `composerController.updateLiteralText`. The
controller now uses its literal replacement transaction when that controller's
`view.dom` is exactly the editor it focused. The existing keyboard path remains
for editors without that capability. Focus validation and the existing whitespace-folded rich-editor comparison
still run before Send; differences beyond that normalization are rejected.

Seven synthetic prompts passed the production controller's staging path in the
live Electron renderer, driven through CDP and stopped before Send:

- inline code inside prose;
- prose ending in inline code;
- a bare inline-code line;
- a fenced JavaScript block;
- two plain lines;
- a heading, blank line, and bullet with inline code;
- angle brackets, ampersand, quotes, and Chinese text.

For every case, `getChatGptPrompt().prompt` exactly equaled the requested string.
The visible rich-editor text also passed the existing whitespace-folded staging
comparison. Zero chat messages were submitted. This verifies preparation, not
receipt-backed model completion or the MCP query journey.

Regression coverage exercises embedded and bare inline code, rejects a native
controller belonging to another editor, and rejects changed text after native
replacement. The embedded-code and bare-code tests each failed before the
corresponding repair. Existing textarea and focus checks remain in place.

## Attachment investigation

The reported attachment exceptions have no saved renderer stack. Their run
records cannot establish which renderer operation threw. A disposable Electron
fixture accepted a real File and read its text. On the current provider page,
the single approved upload reached a completed file chip with a remove control;
removal left no matching chip. No message was submitted.

An earlier inspection tab expired before file injection; its transport failure
was not a provider upload attempt. No unknown upload was retried.

The original attachment defect needs a new failing reproduction with its
renderer exception details before a repair can be chosen. This change does not
alter attachment injection or claim that the older failure is fixed.
