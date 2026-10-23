# Attachment failure evidence

The historical attachment exception remains unexplained. The change described
here preserves evidence for the next failure; it does not claim to repair the
older upload failure. No additional provider upload or chat message was sent
for this change.

## What was lost

Baseline: `701e53fdc78296fc8cae83eaddcaf70440259832`.
Electron 39.6.0 replaces a thrown renderer exception with a generic error when
`webContents.executeJavaScript` rejects. A disposable renderer reproduced that
loss. Separately, an HTTP test showed that `attachmentDebug` was absent after
failed-run finalization: neither finalization nor run normalization carried it.

## Capture and persistence

Attachment evaluations now request native exception details. Electron uses
`Runtime.evaluate` with the same awaited result and user-gesture behavior;
Chrome CDP already uses that command. The selected renderer evidence contains
the error name, first message line, script positions, and stack-frame function
names and positions. Electron 39.6.0 supplies native frames in the exception
description for the tested synchronous and asynchronous failures; those frames
are extracted when protocol stack-frame fields are absent. It does not retain the protocol object's preview, full source text,
or source URLs.

If Electron cannot attach its debugger before evaluation, it uses the original
native evaluation once. A failure after command dispatch never causes another
evaluation. Driver-side failures remain identified as host exceptions when
native renderer details are unavailable.

The attachment operation records its stage and the filename, byte count and
SHA-256 of each buffer actually read for upload. Those buffers also supply the
base64 file payload. No additional file-content copy or base64 field is added
to diagnostics. Files not yet read have no computed identity.

Failed run records now retain this evidence through finalization, summary and
reload. Renderer preparation failures remain failures before Send; their label
identifies preparation failure rather than claiming provider rejection.
Default evaluations retain their existing path.

## Verification

- Native runtime and syntax exceptions were exercised in a disposable Electron
  renderer. Both retain renderer exception fields.
- A real File was created and read in an isolated renderer with intercepted
  local HTTPS content. Its byte count and digest matched the source buffer.
- A synthetic DataTransfer constructor exception was then injected. The
  production controller retained stage, input identity and native TypeError
  details; no Send evaluation ran.
- Tests cover picker, file-injection and upload-status exceptions; no attachment
  body is included in the diagnostic object.
- Renderer and generic host failures retain attachment evidence through failed
  HTTP query finalization and run-store reload.
- A full Electron application fixture keeps production main, controller, HTTP
  and MCP composition active while intercepting provider HTTPS locally. A
  public MCP query records the injected constructor failure with native frames,
  upload stage and the exact input digest. Public page reading observes zero
  fixture Send clicks. After shutdown and a fresh app session, MCP retrieves
  identical diagnostics. The owned processes exit and their state is removed.
- Adapter tests preserve the ordinary evaluation path, permit one native
  evaluation when debugger attachment fails, and forbid fallback after dispatch.

The native integration and full application fixtures made no provider requests.
Live acceptance of the
recovered historical input was not tested. Full byte identity with the original
historical attachment is unproved.

A later [live transfer check](2026-10-23-text-attachment-transfer.md) observed
a storage response and composer completion, with final server readiness still
unverified.
