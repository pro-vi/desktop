---
title: Native reference attachments for image generation
objective: Let callers generate and automatically save style-consistent images from local reference files in one MCP call.
type: feat
status: completed
date: 2026-07-15
origin: .inbox/.read/2026-07-15-image-gen-reference-attachment.md
---

# Native reference attachments for image generation

## Background

Stroke verified that reference-anchored generation already succeeds through a two-call agentify_query plus agentify_download_images workflow. The lower layers upload the reference before sending, wait for image completion, and save the result with strong style fidelity. The public agentify_image_gen MCP tool is the gap: it downloads generated images automatically but hard-codes an empty attachment list.

This plan exposes the existing attachment pipeline through that tool. It intentionally preserves the synchronous lifecycle, latest-assistant image selection, artifact directory ownership, and result shape. The observed image-only text scrape, duplicate download entries, provider-slot error terminology, caller-controlled output directories, and per-message download correlation remain separate follow-up concerns.

## Acceptance Criteria

- **R1 — Public schema:** the served agentify_image_gen MCP schema accepts an optional array of local attachment path strings.
- **R2 — Boundary normalization:** image-generation attachment paths are trimmed and resolved relative to the MCP process working directory before crossing the HTTP boundary.
- **R3 — End-to-end forwarding:** the normalized list reaches the existing query pipeline together with imageGeneration enabled, and omitted attachments preserve the current empty-list behavior.
- **R4 — Existing output contract:** the tool still waits for query completion, saves images from the resulting tab, and returns the existing text, files, directory, and tab projection.
- **R5 — Caller guidance:** public documentation shows the one-call reference-anchored image-generation workflow and the test suite remains green.

## Architecture Decision

**Approach:** Extend only the agentify_image_gen MCP adapter. Mirror the attachment field already served by agentify_query, reuse resolveLocalPaths at the MCP boundary, and forward the resolved list into the existing /query request before the unchanged artifact-save request.

**Rationale:** Consistency and simplicity decide this. The /query, context-packing, controller-upload, durable replay, and artifact layers already accept the exact same string-array shape with imageGeneration enabled. Reusing that path is a byte-for-byte integration match and keeps validation and upload ownership in their existing layers.

**Rejected alternative:** A new image-specific upload endpoint, controller method, or combined query/download abstraction would duplicate working behavior and widen the change into lifecycle and artifact-correlation design. Those concerns are real but not prerequisites for exposing attachments.

**Trade-offs:** This preserves the known two-request latest-assistant race and duplicate-source behavior inside agentify_image_gen. It also keeps synchronous provider-slot admission and service-owned artifact destinations. The feature removes the caller's manual two-tool dance without claiming to solve those independent limitations.

## High-Level Technical Design

Directional guidance for review:

MCP arguments
→ agentify_image_gen Zod boundary
→ resolveLocalPaths against MCP cwd
→ POST /query with attachments plus imageGeneration
→ prepareQueryContext existence validation and durable replay
→ ChatGPTController uploads files before typing the prompt
→ existing image-aware completion
→ unchanged POST /artifacts/save
→ unchanged text/files/dir result

### Representation ledger

| Concept | Authority | Boundary mirrors / projections | Guard |
|---|---|---|---|
| Explicit attachment paths | Existing /query preparation and context-packer validation | MCP tool schemas; durable logical request and replay; controller upload list | Served-schema test, image-gen-block forwarding test, HTTP integration assertion |
| Image-generation mode | Existing /query imageGeneration branch and controller flag | agentify_image_gen constructs the boundary value; durable request persists it | HTTP integration assertion keeps the flag and attachment list together |
| Generated-image result | Existing saveArtifactsForTab and artifact store | MCP text/files/dir/tab projection | Block-scoped contract assertions plus unchanged artifact tests |

Relative MCP paths becoming absolute while direct HTTP rejects relative paths is intentional boundary asymmetry and must remain.

## Implementation Units

### U1. Expose and prove the attachment boundary

- **Goal:** Make agentify_image_gen accept local reference files and deliver them to the already-working upload flow without altering generation or download semantics.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** None
- **Files:**
  - Modify: mcp-server.mjs
  - Modify: tests/mcp-server-names.test.mjs
  - Modify: tests/mcp-tool-profile-integration.test.mjs
  - Modify: tests/http-api.test.mjs
- **Approach:** Add the optional attachment schema beside prompt, destructure it, normalize with the shared MCP helper, and replace only the hard-coded empty list. Scope source-contract assertions to the image-gen registration block, verify the schema through tools/list, and extend an existing image-query integration test to assert the absolute attachment list and image flag together.
- **Patterns to follow:** mcp-server.mjs:94 and mcp-server.mjs:130 for schema and boundary resolution; tests/mcp-server-names.test.mjs:12 for registration-block scoping; tests/mcp-tool-profile-integration.test.mjs:12 for live tools/list inspection; tests/http-api.test.mjs:2866 for image-query integration.
- **Test scenarios:**
  - *Happy path:* a valid absolute reference file is supplied with an image prompt → the controller receives that exact path with imageGeneration true → the request succeeds.
  - *Edge case:* attachments are omitted → the MCP handler forwards an empty resolved list and existing prompt-only behavior remains.
  - *Edge case:* a relative MCP path is supplied → it is resolved against MCP cwd before the HTTP request.
  - *Error path:* a missing or non-file attachment continues to fail through the existing context-packer validation before provider send.
  - *Integration:* live MCP tools/list exposes attachments as an optional array whose items are strings.
- **Verification:** The image-gen block contains its own schema, resolution, and forwarding contract; served schema and HTTP integration tests prove the boundary; the old hard-coded empty list is absent; existing artifact-save and output projection remain unchanged.

### U2. Document native reference-anchored generation

- **Goal:** Make the one-call workflow discoverable to MCP callers.
- **Requirements:** R5
- **Dependencies:** U1
- **Files:**
  - Modify: README.md
- **Approach:** Add a concise agentify_image_gen example to the artifact workflow and update practical upload guidance so attachments are not described as query-only.
- **Patterns to follow:** README.md:175 for executable JSON workflow examples and README.md:554 for compact capability guidance.
- **Test scenarios:**
  - Test expectation: none — documentation-only behavior is verified by reviewing the example against the served schema.
- **Verification:** README demonstrates a prompt plus reference attachment in one image-gen call and states that the resulting images are saved automatically.

## Scope Boundaries

- No new HTTP endpoint, controller upload primitive, artifact-store shape, or MCP tool profile.
- No fire-and-forget mode or provider-slot queueing for agentify_image_gen.
- No change to direct-HTTP path trust rules or existing attachment validation.
- No change to image detection, latest-assistant selection, or returned result fields.

### Deferred to Follow-Up Work

- Correlate image saving to the assistant message or run produced by the same prompt.
- Deduplicate image candidates by source URL before writing artifacts.
- Consider a policy-safe caller-selected output directory.
- Improve image-only output text extraction.
- Distinguish local provider-slot admission from provider rate limiting.

## System-Wide Impact

- **Interaction graph:** MCP registration → /query → context packing → controller upload/send → durable completion → /artifacts/save. Only the first adapter changes.
- **Error propagation:** Existing missing-path, upload-rejected, upload-stalled, query, and artifact-save errors continue to propagate without translation changes.
- **State lifecycle risks:** Attachments remain stored in logical request and materialized replay by /query. The separate post-query artifact request can still observe interleaving; this plan does not worsen or conceal that existing risk.
- **API surface parity:** agentify_query, agentify_research, and agentify_image_gen all expose immediate-upload path lists; image-gen intentionally does not acquire bundle, context-path, prompt-prefix, model-intent, or async-query options.
- **Integration coverage:** A tools/list assertion proves the public schema and an HTTP test proves attachment plus image-generation composition with a real temporary file.
- **Unchanged invariants:** Files upload before prompt send; query failure prevents artifact saving; successful query still performs image-only artifact saving; the return projection remains stable.

## Bug / requirement trace

| Requirement | Contract clause | Expected behavior | Match |
|---|---|---|---|
| R1 | MCP schema mirror | Callers can supply reference paths directly to image_gen | Yes |
| R2 | resolveLocalPaths boundary | Relative caller paths become absolute before /query | Yes |
| R3 | Existing query/controller authority | References upload before the image prompt | Yes |
| R4 | Unchanged second request and projection | Generated images are still downloaded and returned | Yes |
| R5 | README plus fresh tests | The native workflow is discoverable and regression-locked | Yes |

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| A global source-string test passes even if image_gen drops attachments | Extract and assert within the image-gen registration block |
| Source tests prove code text but not the served contract | Inspect image_gen inputSchema through a real MCP tools/list client |
| Schema and lower-layer behavior work independently but not together | Extend the image-query HTTP test with a real temporary attachment |
| Scope expands into stale-image or output-directory redesign | Keep those concerns explicit in Deferred to Follow-Up Work |
