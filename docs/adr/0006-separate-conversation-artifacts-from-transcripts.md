# ADR 0006: Separate Conversation Artifacts from Transcripts

- **Status:** Accepted
- **Date:** 2026-08-09
- **Deciders:** Agentify Desktop maintainers and the 2026-08-09 implementation session

## Context

ChatGPT conversations can contain downloadable file cards that are not represented by transcript text. The existing transcript contract is exact, text-only, and persisted by content hash. Expanding its turns with provider file metadata would change the meaning and storage format of an established capture.

Downloading a file is also different from reading a transcript. It mutates the local filesystem, requires the authenticated browser session, and may expose a temporary signed provider URL if the responsibility is placed at the wrong boundary.

## Decision

Keep conversation artifacts in an exact sidecar inventory produced during the same virtualized conversation walk. Transcript completeness continues to describe only transcript text; artifact-inventory completeness is reported separately.

Download selected artifacts through a separate command. The browser owns authenticated download capture, the controller identifies and clicks the exact provider message and file card, and the HTTP service validates and registers the resulting local file. Do not return or persist signed provider URLs.

The first contract supports ChatGPT file cards only. Canvas documents remain unsupported until a live public Canvas surface supplies evidence for a separate contract.

## Rationale

This preserves the established transcript schema and content hashes while still observing file cards before virtualized turns unmount. A separate mutation makes filesystem effects explicit. Keeping authentication in the browser avoids copying cookies, account headers, or signed URLs into Node-owned storage.

## Consequences

Positive:

- Existing transcript captures and stored snapshots retain their meaning.
- Callers can distinguish complete text capture from complete file-card coverage.
- Downloads use the signed-in browser session without exporting credentials.
- Each requested key receives a terminal result, and only validated local files are registered.

Negative:

- Reading and downloading require two calls and a second virtualized scan.
- Provider message identity and public file-card controls remain compatibility dependencies.
- Canvas documents require another probe and contract rather than inheriting file-card behavior.

## Revisit Triggers

- The transcript contract gains a deliberate version that includes non-text message parts.
- ChatGPT exposes a stable public artifact API that does not require browser credentials or signed URLs.
- A live Canvas document exposes stable public inventory and export controls.

## References

- `conversation-artifact-contract.mjs`
- `chatgpt-controller.mjs` — conversation capture, inventory, and selected download flow
- `http-api.mjs` — service-owned validation and artifact registration
- `electron-browser-backend.mjs` and `chrome-cdp-backend.mjs` — bounded native download capture
- `docs/probes/chatgpt-canvas-artifacts.md`
- Commits `bf751e9`, `5a3de00`, `d9c2a71`, and `1cb948d`
