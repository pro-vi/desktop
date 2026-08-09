# ChatGPT Canvas Artifact Probe

- **Date:** 2026-08-09
- **Status:** Unsupported with current evidence
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session

## Question

Can a ChatGPT Canvas document use the same inventory and authenticated-download contract as conversation file cards?

## Procedure

1. Created a disposable ChatGPT conversation and explicitly requested a Canvas document titled `Agentify Canvas Probe` with two bullet points.
2. Repeated the request through the configured Pro workflow and attempted the existing Instant mode intent.
3. Inspected the public accessibility tree for the project composer and a standalone new-chat composer.
4. Opened each public `Add files and more` menu and recorded the served actions. No React private fields or internal provider requests were inspected.

## Observations

- Pro mode returned a normal assistant message stating that it could not open or edit Canvas.
- The existing Instant mode intent failed before sending with `mode_intent_activation_failed` in this project.
- The project and standalone composer menus exposed file upload, library selection, image creation, web search, deep research, and installed plugins.
- Neither composer menu exposed a Canvas action.
- No Canvas editor, Canvas message card, open control, export control, export format, or download event was served.

## Decision

Canvas documents do not enter the version 1 conversation-artifact inventory and cannot be requested through `agentify_download_conversation_artifacts`.

This is an evidence boundary, not a claim that ChatGPT never supports Canvas. A future implementation requires a live Canvas document whose public UI exposes stable message association and export controls. Until then, Agentify reports only `kind: "file"` conversation artifacts.

## Reprobe Conditions

- Canvas becomes available in the authenticated account and selected model mode.
- A supplied conversation contains a real Canvas document.
- The public accessibility tree exposes stable Canvas open and export controls.
