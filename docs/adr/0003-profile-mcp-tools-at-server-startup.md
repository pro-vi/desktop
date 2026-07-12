# ADR 0003: Profile MCP Tools at Server Startup

- **Status:** Accepted
- **Date:** 2026-07-12
- **Deciders:** Agentify Desktop maintainers and Codex build session

## Context

Agentify's MCP server exposes 34 tools spanning core provider work, browser control, context ingestion, artifacts, run operations, media, and administration. Presenting all of them to every coding agent increases schema context and creates avoidable tool-selection competition around the common `query -> wait_run` workflow.

## Decision

Filter tool registration through named startup profiles: `core`, `browser`, `context`, `operations`, `media`, and `admin`. Allow profiles to compose as a comma-separated union without duplicate tools. Retain `full` as the compatibility default.

Select the profile using `--tool-profile` or `AGENTIFY_MCP_TOOL_PROFILE`. Keep the selected tool list stable for the lifetime of one MCP server process; clients refresh it by restarting their MCP connection.

## Rationale

Startup profiles reduce the advertised schema without replacing clear single-purpose tools with a large action-dispatch schema. A stable list also avoids relying on uneven client support for dynamic MCP tool-list refresh.

## Consequences

Positive:

- The recommended core surface contains 9 tools rather than 34.
- Specialized capabilities remain available through explicit additive profiles.
- Existing installations retain the full surface until they opt into profiling.

Negative:

- Profile changes require restarting the MCP connection.
- Configuration must include every specialized capability an agent needs for that session.
- The profile catalog must remain in parity with registered tools.

## Revisit Triggers

- Major MCP clients reliably support dynamic tool discovery and list-change notifications.
- Usage evidence supports changing the compatibility default from `full` to `core`.
- Core workflows routinely require tools currently placed in specialized profiles.

## References

- `mcp-tool-profile.mjs`
- `tests/mcp-tool-profile.test.mjs`
- `tests/mcp-tool-profile-integration.test.mjs`
- `README.md`
