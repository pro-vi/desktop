# ADR 0004: Reuse Query Attachments for Image Generation

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Agentify Desktop maintainers and Codex architecture/build session

## Context

The public agentify_image_gen MCP tool combined two existing capabilities: image-aware query execution and automatic artifact saving. However, it hard-coded an empty attachment list even though agentify_query already accepted local files and the shared /query, context-packing, durable replay, and controller layers already supported attachments together with image-generation mode.

Callers needing a reference image therefore had to use agentify_query followed by agentify_download_images. That workaround duplicated orchestration at every caller and retained the same latest-assistant download behavior as the composed image tool.

## Decision

Expose an optional attachment-path list on agentify_image_gen. Resolve relative paths at the MCP process boundary with the same helper used by agentify_query, then forward the normalized list into the existing /query request with image generation enabled.

Keep attachment existence validation, upload ordering, durable replay, and provider errors owned by the shared query pipeline. Keep the subsequent image-only artifact-save request and the text, files, directory, and tab result projection unchanged.

## Rationale

The existing query pipeline accepts the exact string-array shape and already uploads files before sending the prompt. Reusing it preserves one validation and lifecycle authority. A new image-specific upload endpoint or controller method would duplicate behavior without resolving the independent latest-message correlation problem.

## Consequences

Positive:

- Reference-anchored image generation and automatic saving require one MCP call.
- Relative-path handling, missing-file validation, upload errors, and durable replay remain consistent with agentify_query.
- No new controller, HTTP, artifact-store, or MCP-profile surface is introduced.

Negative:

- Image generation remains synchronous and subject to current provider-slot admission.
- Query and artifact saving remain separate requests, so latest-assistant interleaving is still possible.
- Duplicate image source URLs and caller-selected output directories remain unsupported.

## Revisit Triggers

- Agentify gains a correlated query-and-save primitive keyed to one assistant message or durable run.
- MCP attachment paths adopt a different trust or working-directory policy.
- Image generation stops using the shared /query pipeline.
- Evidence shows the two-request interleaving risk returns stale images often enough to require an atomic operation.

## References

- `docs/plans/2026-07-15-001-feat-image-gen-attachment-support-plan.md`
- `mcp-server.mjs`
- `tests/mcp-server-names.test.mjs`
- `tests/mcp-tool-profile-integration.test.mjs`
- `tests/http-api.test.mjs`
