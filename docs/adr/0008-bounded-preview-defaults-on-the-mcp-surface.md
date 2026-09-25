# ADR 0008: Bounded-Preview Defaults on the MCP Surface

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** Agentify Desktop maintainers and the 2026-09-15 build session
- **References:** `docs/token-cost-paths.md` (L1, L2, L4, L5), `docs/plans/2026-09-15-001-feat-token-cost-lever-defaults-plan.md`

## Context

The measured baseline (n=1,832 runs, 96% arriving via MCP) showed inline-payload defaults — not orchestration — dominate calling agents' token cost: `agentify_wait_run` returned the saved response unbounded by default (up to ~50k tokens in one call), the sync `agentify_query` result shipped the response text in both `content[0].text` and `structuredContent.text` plus a code-block copy, `agentify_read_page` defaulted to 200,000 chars, and every wait result embedded `responseDebug`/`recovery` JSON even on success.

## Decision

The MCP layer serves bounded previews by default with explicit opt-up through the existing parameters; the HTTP contract is unchanged. `agentify_wait_run` defaults `maxOutputChars` to 2,000 so the existing truncation marker and artifact path flow through; the sync query carries the response text exactly once (the content text block) with a metadata-only `structuredContent`; `agentify_read_page` defaults `maxChars` to 20,000; wait-result diagnostics appear only on non-success outcomes and remain in the persisted run record.

## Rationale

Flipping `includeOutputText` to false was rejected: callers lose the wait-returns-the-answer ergonomics every existing prompt teaches, while a preview default keeps the contract and cuts the worst case ~100x. Moving defaults in the HTTP layer was rejected: it would alter the direct-API contract for non-MCP consumers although the measured cost lives in the MCP surface.

## Consequences

Positive:

- Worst-case inline payload per wait/read drops from ~50k tokens to a bounded preview with an explicit cut marker and artifact path (`read_page` excepted below).

Negative:

- External callers relying on unbounded inline text or on `structuredContent.text` must opt up or read the artifact path; no in-repo consumer did at decision time.
- `read_page` truncation is silent (pre-existing at 200k, more reachable at 20k) — named as the L4 residual in `docs/token-cost-paths.md`. *(Amended 2026-09-17: the residual is closed — `/read-page` and `agentify_read_page` structuredContent now carry `truncated` and `totalChars`; exact on normal pages, `null`/unknown on the nested deep-research fallback.)*

## Amendments

- *(2026-09-25)* The structured-content revisit trigger fired for `agentify_read_page`: a caller session (inbox note `2026-09-25-pro-answer-unreadable-after-send.md`) read a result as `totalChars=69682` with no text anywhere — the text rode only the content block, which that client does not render. `agentify_read_page` structuredContent now carries `text` (the same `maxChars`-bounded string as the content block), so a structured-only client sees the page text instead of a bare length. The single-copy rule keeps holding for `agentify_query`/`agentify_wait_run`, where no such caller has been observed.

## Revisit Triggers

- A measured caller pattern needs full text on most waits (raise or drop the preview default).
- A client is shown to ingest `structuredContent.text` (restore that copy or version the field). *(Fired 2026-09-25 for `read_page` — see Amendments.)*
- `read_page` gains a persisted artifact or truncation flag (then mark cuts the way wait_run does).

## References

- `mcp-server.mjs` — `runStatusText`, the `agentify_wait_run`/`agentify_query`/`agentify_read_page` handlers
- `tests/mcp-tool-profile-integration.test.mjs` — preview default, opt-up, single-copy, and diagnostic-gating tests
