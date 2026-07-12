---
title: Standalone ChatGPT URL Continuation
objective: Let coding agents continue supplied ChatGPT conversations without silently moving work into Agentify's default ChatGPT project.
type: feat
status: completed
date: 2026-07-11
origin: standalone architecture conversation
---

# Standalone ChatGPT URL Continuation

## Background

Agentify can navigate to and read a supplied ChatGPT `/share/...` or `/c/...` URL, but a subsequent query re-applies the saved/default Agentify project and may navigate away before sending. Routing is represented as independently nullable `projectUrl` and `conversationUrl` strings, which permits contradictory affinity and prevents a standalone conversation from clearing a stale project.

ChatGPT shared links are snapshots. A reply creates a private conversation in the signed-in user's history, so Agentify must model `source share URL -> materialized canonical /c URL` rather than persisting the share URL as a writable conversation.

## Requirements

- **R1:** An agent can provide a ChatGPT `/c/...` or `/share/...` URL and continue from it.
- **R2:** An explicit chat URL never inherits or falls back to the Agentify project.
- **R3:** Replying to a shared snapshot captures the resulting private `/c/...` URL.
- **R4:** Key-only follow-ups, restart recovery, run opening, and retries resume that private conversation.
- **R5:** Existing project-routed keys and image-generation isolation remain unchanged.
- **R6:** The built-in coding orchestrator can read and post to the bound conversation, and posting failures are visible.
- **R7:** Unsupported, malformed, or ambiguous URLs fail before navigation or persistence.

## Architecture Decision

**Approach:** Introduce a validated tagged ChatGPT location model and a public `chatUrl` request field. `chatUrl` accepts canonical conversations and shared snapshots; `conversationUrl` remains reserved internally for a materialized canonical `/c/...` URL.

Routing precedence is:

1. explicit `chatUrl`
2. explicit `projectUrl`
3. saved keyed location
4. default project
5. ChatGPT home

`chatUrl` and `projectUrl` are mutually exclusive. If `chatUrl` has no key, Agentify derives a deterministic URL-based key so the continuation cannot contaminate the default project key.

Reject the smaller alternative of adding another nullable conversation URL. That would preserve the incoherent URL pair, stale-project behavior, and duplicated routing branches.

**Trade-offs:** persisted metadata requires backward-compatible decoding; shared continuation remains UI-dependent; exact-once materialization cannot be guaranteed across a crash after ChatGPT creates the copy but before Agentify persists its URL.

## High-Level Technical Design

Directional model:

```text
ChatGptEntryTarget
  canonical-conversation { chatUrl: /c/... }
  shared-snapshot        { chatUrl: /share/... }

ChatGptLocation
  home
  project-home            { projectUrl }
  standalone-conversation { conversationUrl, sourceUrl? }
  project-conversation    { projectUrl, conversationUrl, sourceUrl? }
```

```text
MCP query/send or orchestrator
  -> parse chatUrl
  -> resolve one location
  -> navigate exact target
  -> for /share, send first reply and observe /c transition
  -> atomically replace keyed location
  -> durable run and key-only follow-ups resume canonical /c
```

The semantic authority lives in `chatgpt-location.mjs`. Flat `projectUrl` and `conversationUrl` fields may remain as reduced run/UI projections, not routing authority. No stable “Continue this conversation” CTA is assumed.

### Legacy composition

| Existing metadata | Migrated location |
|---|---|
| Project only | `project-home` |
| Matching project + project conversation | `project-conversation` |
| Standalone `/c` + stale project | `standalone-conversation`; discard stale project |
| Project conversation + mismatched stored project | Derive project from the conversation URL |
| Invalid conversation + valid project | `project-home` |
| Both invalid | `home`; do not rewrite until a valid binding exists |

### State invariants

- `location.kind` is the sole routing authority.
- `projectUrl` exists iff the location is a project variant.
- `conversationUrl` exists iff the location is a materialized conversation variant.
- A `/share/...` URL is never persisted as `conversationUrl`.
- A key remains unchanged until a shared reply yields a validated `/c/...` URL.
- Explicit `chatUrl` suppresses project fallback across all writers.

## Implementation Units

### U1. Canonical ChatGPT location model

- **Goal:** Replace nullable routing pairs with a validated tagged location.
- **Requirements:** R2, R4, R5, R7
- **Dependencies:** None
- **Files:**
  - Create: `chatgpt-location.mjs`
  - Modify: `chatgpt-mode-intent.mjs`, `state.mjs`
  - Test: `tests/chatgpt-location.test.mjs`, `tests/chatgpt-mode-intent.test.mjs`, `tests/state.test.mjs`
- **Approach:** Centralize URL classification, precedence, legacy decoding, canonical encoding, and flat compatibility projections. Persist complete locations with replacement semantics.
- **Patterns to follow:** `chatgpt-mode-intent.mjs:28-76`; serialized writes at `http-api.mjs:736-767`.
- **Test scenarios:**
  - *Happy path:* supported top-level/project `/c` URLs parse to correct variants.
  - *Migration:* standalone conversation plus stale project becomes standalone.
  - *Error:* foreign host, HTTP, credentials, malformed path, custom-GPT ambiguity, and `chatUrl + projectUrl` are rejected.
  - *Compatibility:* legacy bare project strings remain readable.
- **Verification:** Every accepted location round-trips and contradictory project/conversation authority is unrepresentable.

### U2. Browser materialization boundary

- **Goal:** Prepare canonical conversations and materialize shared snapshots without project fallback.
- **Requirements:** R1, R2, R3, R7
- **Dependencies:** U1
- **Files:**
  - Modify: `chatgpt-controller.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`
- **Approach:** Navigate exact targets inside the existing exclusive controller section. For a shared snapshot, require an authenticated writable composer, send through the normal controller, and emit only a validated canonical `/c` transition.
- **Patterns to follow:** `chatgpt-controller.mjs:1570-1713`, `chatgpt-controller.mjs:2968-2974`.
- **Test scenarios:** shared reply transitions to canonical `/c`; canonical `/c` needs no materialization; deleted/private share, missing composer, login, and foreign redirect fail closed.
- **Verification:** `/share` is never labeled canonical and no CTA is assumed.

### U3. HTTP routing, persistence, and replay

- **Goal:** Make tagged location authoritative across query, send, run opening, and retry.
- **Requirements:** R1-R5, R7
- **Dependencies:** U1, U2
- **Files:**
  - Modify: `http-api.mjs`, `run-store.mjs`
  - Test: `tests/http-api.test.mjs`, `tests/run-store.test.mjs`
- **Approach:** Replace duplicated fallback branches with one location preparation service. Store source provenance in the logical request and canonical location in run/key records.
- **Patterns to follow:** `http-api.mjs:1395-1413`, `http-api.mjs:2102-2325`.
- **Test scenarios:** share-to-canonical-to-follow-up; restart/open/retry; failure preserves binding; same-key concurrency; normal project/image regression.
- **Verification:** Every writer uses one resolver and generic progress cannot mutate affinity.

### U4. MCP contract and agent ergonomics

- **Goal:** Let coding agents continue a chat in one request.
- **Requirements:** R1, R2, R5, R7
- **Dependencies:** U3
- **Files:**
  - Modify: `mcp-server.mjs`
  - Test: `tests/mcp-server-names.test.mjs`
- **Approach:** Add `chatUrl` to query and low-level send; document conflict with `projectUrl`; derive a dedicated key when neither key nor tab is supplied.
- **Patterns to follow:** injected image key at `chatgpt-mode-intent.mjs:79-102`.
- **Test scenarios:** forwarding, conflict before browser calls, no-key isolation.
- **Verification:** Agents no longer need navigate/read/query choreography.

### U5. Built-in coding orchestrator continuation

- **Goal:** Keep orchestrator reads and result posts in the supplied conversation.
- **Requirements:** R1, R2, R4, R6
- **Dependencies:** U3
- **Files:**
  - Modify: `orchestrator.mjs`
  - Test: `tests/orchestrator-continuation.test.mjs`
- **Approach:** Accept `--chat-url`, navigate/read it, pass the explicit target on the first write, then rely on the canonical key binding. Surface final posting failures.
- **Patterns to follow:** `orchestrator.mjs:30-46`, `orchestrator.mjs:71-81`.
- **Test scenarios:** shared source read/post/materialization; subsequent canonical posts; failed result posting is visible.
- **Verification:** Chat location never changes the local filesystem workspace.

### U6. Documentation and operational clarity

- **Goal:** Explain project routing versus explicit chat continuation.
- **Requirements:** R1, R5, R6
- **Dependencies:** U4, U5
- **Files:**
  - Modify: `README.md`, `CLAUDE.md`
- **Approach:** Add one-call examples, shared-copy semantics, restart behavior, and reload instructions.
- **Test expectation:** none — documentation-only.
- **Verification:** ChatGPT project location, browser key, and local coding workspace are clearly distinct.

## Disconfirming Evidence

Before depending on shared continuation, run `chatgpt-shared-reply-materialization-probe`: open an authenticated `/share/...`, verify a writable composer without relying on a named CTA, send a harmless reply, observe a private `/c/...`, and confirm it does not land in Agentify's project.

If this transition is not reliable, canonical `/c/...` continuation may ship while `/share/...` fails closed. Do not add brittle CTA automation or project fallback.

## Scope Boundaries

- No change to Codex filesystem workspace selection.
- No Control Center UI in this iteration.
- No mutation or movement of the original shared conversation.
- No generic continuation for other vendors.
- No shared-link CTA selector.
- No ChatGPT API integration.
- No group-chat semantics.

### Deferred to Follow-Up Work

- Control Center paste-and-bind action.
- Equivalent typed locations for other vendors.
- `chatUrl` support for Deep Research and image workflows.
- Recovery tooling for the crash-before-canonical-persistence window.

## System-Wide Impact

- **Interaction graph:** MCP/orchestrator -> HTTP location resolver -> controller -> key metadata/run store.
- **Error propagation:** validation fails before navigation; materialization preserves prior affinity; orchestrator post failures become visible.
- **State lifecycle:** shared source is transient; canonical conversation becomes durable after validation.
- **API parity:** `/query` and `/send` share route preparation; `/navigate` remains generic.
- **Unchanged invariants:** image keys do not persist chat locations; default project routing and local coding workspaces remain intact.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| ChatGPT shared-page behavior changes | Live probe and fail-closed behavior |
| Duplicate private copy after crash | Persist canonical URL immediately; document remaining at-least-once window |
| Legacy migration changes routing | Conversation-specific URL wins over stale broad project; exhaustive fixtures |
| Explicit URL contaminates default key | Deterministic dedicated key when none supplied |
| Future URL families are misclassified | Allowlist HTTPS host/path families and reject unknown variants |
