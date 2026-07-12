# ADR 0001: Use Tagged ChatGPT Locations

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Agentify Desktop maintainers and Codex architecture/build session

## Context

Agentify previously represented ChatGPT routing as independently nullable `projectUrl` and `conversationUrl` strings. That allowed contradictory affinity: a standalone conversation could retain a stale project, and opening a shared-chat snapshot followed by a query could silently navigate into Agentify's default project.

Shared ChatGPT links are source snapshots rather than durable writable conversations. A reply materializes a private canonical `/c/...` conversation in the signed-in account.

## Decision

Represent browser-thread routing with one validated, tagged ChatGPT location. Resolve one route using this precedence: explicit `chatUrl`, explicit `projectUrl`, saved keyed location, default project, then ChatGPT home.

Treat `/share/...` as a transient entry target. Persist only the validated canonical `/c/...` location produced after the first reply, replacing the key's complete prior location atomically. Keep flat project and conversation URL fields only as compatibility projections, not routing authority.

## Rationale

This makes contradictory project/conversation authority unrepresentable and gives explicit conversation continuation stronger authority than ambient project defaults. The rejected alternative—adding another optional conversation URL—would retain stale merge semantics and duplicated precedence logic.

## Consequences

Positive:

- Explicit conversation continuation cannot silently fall back into Agentify's project.
- Standalone materialization clears stale project affinity.
- MCP queries, low-level sends, durable runs, and the coding orchestrator share one route contract.
- URL validation fails before navigation or persistence.

Negative:

- Legacy keyed metadata needs backward-compatible decoding.
- Shared-chat materialization depends on ChatGPT's browser UI and has a narrow crash-before-persistence duplication window.
- New ChatGPT URL families must be admitted deliberately by the parser.

## Revisit Triggers

- ChatGPT no longer permits replying from `/share/...` snapshots.
- OpenAI provides a supported API for importing or continuing shared conversations.
- Another provider needs the same location model and the ChatGPT-specific union prevents a clean shared abstraction.
- Production evidence shows the materialization crash window creates meaningful duplicate conversations.

## References

- `docs/plans/2026-07-11-001-feat-chat-url-continuation-plan.md`
- `chatgpt-location.mjs`
- `tests/chatgpt-location.test.mjs`
- `tests/http-api.test.mjs`

