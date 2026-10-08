---
title: Explicit Dot messaging through Agentify
objective: Coding agents can exchange messages with the account's personal Dot and continue that conversation.
type: feat
status: superseded
builder: cold
date: 2026-10-07
origin: conversation
---

# Explicit Dot messaging through Agentify

## Objective and background

Add a deliberate way for coding agents to message the account's actual ChatGPT Dot, receive its reply, and continue the same conversation. This is a messaging transport. A returned Dot reply does not establish that background work mentioned in that reply has finished.

Origin: the Agentify inbox, Chat-only verification, and Dot-support architecture conversation. Source inspected: `c44287cf464f40608b87256ad5ff69ffbba598d6`. Its [CI run passed](https://github.com/pro-vi/desktop/actions/runs/37610098953). No Dot message was sent while planning.

Agentify already owns browser transport, tab operations, durable query runs, waiting, and receipt-backed output. `agentify_query` forwards to `/query` (`mcp-server.mjs:840`, `:905`); the service resolves location, calls the controller, writes output, and finalizes the run (`http-api.mjs:4106`, `:4298`, `:4368`). Existing ChatGPT query, image, research, and direct-send paths require Chat (`chatgpt-controller.mjs:5470`, `:5496`).

[Dot messaging documentation](https://learn.chatgpt.com/docs/dots/channels), checked 2026-10-07, documents desktop web messaging. [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) distinguishes conversation replies from delegated tasks and persistent notes. The provider's deployed build identifier was not captured. These documents establish product availability, not the browser contract Agentify needs.

### Requirements

- **R1:** A coding agent explicitly selects Dot; a generic Work composer, reasoning intent, or reused key never supplies that choice.
- **R2:** A query returns a new, completed message from the bound Dot, with saved output and a matching completion receipt.
- **R3:** Existing Chat calls retain their Chat-only behavior, including `modeIntent: none`, image generation, research, and direct send.
- **R4:** Continuation, reopening, restart, and retry preserve Dot identity and conversation identity. Uncertain submission must not cause automatic duplicate sends.
- **R5:** Calls addressing the same Dot conversation cannot interleave through different Agentify keys or tabs.
- **R6:** Run metadata and agent output distinguish a Dot message reply from completion of Dot's background work. Failures retain that distinction.
- **R7:** Provider observations, wire projections, and persisted data have one structural authority, validated boundaries, and meaningful negative tests.

## Architecture Decision

**Approach:** Add `agentify_dot_query` as a distinct MCP operation. It sends an explicit Dot recipient through the existing HTTP `/query` execution path. Keep the provider `chatgpt` and the output-bearing run kind `query`. Bind each created tab/controller to its recipient; a send request cannot change that binding.

**Rejected alternative: model Dot as a new vendor.** `vendorId` currently selects website transport and compatibility behavior, not the assistant within an account. A `dot` vendor would bypass ChatGPT-specific profile, compatibility, output, and continuation handling unless those branches were duplicated. Source: `main.mjs:272`, `chatgpt-compatibility.mjs:509`, `http-api.mjs:4140`.

The existing image tool provides a local pattern for a dedicated agent-facing operation sharing `/query`. The new operation is explicit without turning `modeIntent` into a recipient selector. A Slack bridge is outside this decision: it would require a new connected service while the selected design extends Agentify's browser transport.

**Trade-offs:** Dot browser changes remain a maintenance responsibility. A missing identity or reply signal produces an explicit failure rather than a guessed answer. Different keys may address one shared Dot conversation; they do not provide private memory isolation.

**Approval criteria:** Accept the separate Dot operation, the message-reply completion boundary in C4, the submission/retry rules in C5, and the initial scope below. Accept that provider characterization and an authorized live round trip must establish the currently unverified browser contract before support is declared complete. No feature flag or demo-only release is proposed.

**Probed:** No provider experiment ran. A previous native screenshot showed a distinct Dot conversation, but established neither its browser route nor message identifiers. The planning attempt to inspect Agentify's browser failed with `Sky Computer Use native pipe startup failed`; no interaction followed. O1 remains unmet.

## High-Level Technical Design

Directional guidance for review, not implementation specification:

```text
agentify_query --------------------> /query: ordinary recipient [existing]
agentify_dot_query ----------------> /query: explicit Dot       [proposed]
                                         |
                               validated recipient and location
                                         |
                      recipient-bound tab -> controller observation
                                         |
                      identity check -> conversation operation lease
                                         |
                   durable submission intent -> guarded browser input
                                         |
                        bound user turn -> associated Dot reply
                                         |
                        private output -> receipt -> query run
                                         |
                         existing get/wait/open/retry consumers
```

The constructor bridge is a real change, not an existing capability: `TabManager.createTab` currently forwards only tab, page, and vendor information (`tab-manager.mjs:100`); `main.mjs:272` and `ChatGPTController` (`chatgpt-controller.mjs:619`) must receive the parsed recipient. U2 carries that bridge. Its lifecycle remains unverified until the real client exercise in U5.

### Naming ledger and representation authority

| Meaning | Existing term | Chosen name | Owner / placement | Status | Consumer or boundary reason | Sibling disposition |
|---|---|---|---|---|---|---|
| Requested assistant within ChatGPT | none; `modeIntent` is reasoning | `recipient` | `chatgpt-recipient.mjs` | new | MCP, HTTP, controller, storage | Keep vendor and reasoning terms distinct. |
| Provider-observed Dot and conversation | conversation identity alone | `dotBinding` | controller, decoded by `chatgpt-recipient.mjs` | new | submission, reply, continuation | Retain ordinary conversation identity; never claim it identifies an assistant. |
| Provider-facing Dot observations | ordinary Chat readers | Dot UI observations | `chatgpt-dot-ui.mjs` | new | Isolate authenticated DOM evidence from caller input. | Preserve Chat readers and their checks. |
| Whether a particular Dot message was submitted | transient send flags | `dotSubmission` | HTTP durable run writer | new | restart and retry | Do not reinterpret transient Chat flags as durable delivery proof. |
| Allowed final-output evidence shapes | controller literals, HTTP policy sets | completion evidence | `chatgpt-completion-evidence.mjs` | new shared owner | controller and HTTP | Preserve their different per-flow acceptance policies. |
| Saved reply lifecycle | query run / receipt | query run / receipt | existing run modules | reuse | wait, get, UI, operations | No `dot-query` run kind or new receipt version. |

The pure recipient module beats independent MCP, HTTP, and storage literals. The Dot UI module beats adding Dot-specific DOM interpretation to every submit fallback; its one consumer owns an untrusted browser boundary. The completion module beats extending the existing duplicated structural source lists independently. Native `URL`, existing atomic writes, operation leases, and the installed MCP SDK and Zod supply transport and validation infrastructure. No dependency is added.

MCP schemas are necessary boundary mirrors; they refine through the same parser and have protocol parity tests. Tab metadata, run summaries, and private artifact metadata are projections. Browser evaluation results are unknown until the observation decoder validates them. Only the controller stamps observed identity and reply provenance; caller payloads cannot supply those stamps. HTTP writes submission checkpoints and output receipts. `profileScopeId` remains a local namespace, not evidence of the signed-in account.

## Surface Direction

Origin: the existing MCP answer-once presentation at `mcp-server.mjs:942` and run status presentation at `:126`. Visitor mode: operate. Extend that settled presentation rather than introduce a new graphical control surface.

- **D1:** The tool catalog exposes `agentify_dot_query` separately from the ordinary Chat query.
- **D2:** The answer appears once; compact metadata visibly names Dot and the reply's conversation binding.
- **D3:** Dot output describes a message reply, without a Pro reasoning label or a claim that background work finished.

## Program obligations

- **O1:** Actual provider observations establish an owned Dot route, stable recipient identity, writable composer, message identity, reply association, and a completed-message signal. A generic Work label, display name, or stable page text is insufficient. U1 records observations; U5 proves the built path.
- **O2:** Identity and binding remain checked at every existing submission strategy, including DOM evaluation, pointer release, and keyboard fallback. U3 satisfies C2.
- **O3:** Persisted submission intent precedes external input; a failed checkpoint write prevents submission. U3 satisfies C5.
- **O4:** A Dot reply cannot become successful output through the ordinary assistant-source policy, or bypass query receipt enforcement. U2 and U3 satisfy C4.

## Contracts

### C1. Explicit request

The MCP tool accepts required `dotUrl` and `prompt`, with optional `key`, `tabId`, `timeoutMs`, and `fireAndForget`. No-key requests derive a stable Dot key from the validated locator, following `derivedChatKey`'s existing convention. Explicit keys remain in the existing key namespace.

HTTP carries `recipient: { kind: dot, dotUrl }` through `/query`. The authoritative parser accepts only the documented Dot request fields, including the existing caller `source` label. Unknown recipient variants and caller-supplied observation fields are rejected before creating or navigating a tab. The source label conveys no identity or authority.

Dot requests reject Chat vendor overrides, `chatUrl`, `projectUrl`, reasoning/model intents, image generation, `liveSourceId`, bundles, attachments, and context paths. Those fields have consumers that assume ordinary Chat or uncharacterized provider capabilities. A legitimate Dot-with-files request therefore receives an explicit unsupported-input error; it is not silently truncated. Files are outside the initial messaging requirement, not a compatibility promise.

Absent recipient retains the current ordinary request meaning. Non-ChatGPT vendor requests keep their existing transport behavior; Dot is permitted only with the ChatGPT transport. Neither a saved Dot key nor an existing Dot tab upgrades that request: a mismatch returns `recipient_conflict`. The ordinary MCP query never forwards a Dot choice. Research, image, and direct-send entry points retain their current Chat requirement.

### C2. Observed binding and location

`dotBinding` contains the provider's stable Dot identifier, canonical owned entry locator, and stable conversation identifier/locator obtained through O1. Names and avatars are presentation only. A unique observed binding is required before prompt preparation and again at submission and reply acceptance.

Use the observed provider contract to validate HTTPS `chatgpt.com` Dot locators. Do not guess a pathname or strip query state before its meaning is established. Do not widen `parseChatGptEntryTarget` to accept arbitrary Work pages. Dot routing remains separate from the ordinary Chat location decoder, which currently repairs unknown variants to home (`chatgpt-location.mjs:89`).

The requested recipient is immutable for the operation and the controller. Saved or live binding drift causes `dot_binding_mismatch`; missing evidence causes `dot_binding_unconfirmed`. An invalid saved Dot record cannot fall back to ordinary home, project defaults, or a fresh Dot conversation.

Binding is confirmed iff all required provider identity/location observations uniquely match. Account changes must be detected through provider-observed identity, not `profile-main`. U1 must establish whether stable Dot identity suffices or an additional provider account identifier is necessary; without that evidence, live sends remain blocked.

### C3. Conversation ownership

Acquire the existing tab/key operation leases, then an additional lease keyed by the observed Dot/conversation identity before preparing a message. Hold it through reply qualification and output finalization. Different keys or tabs resolving to that same identity receive the existing busy-style conflict rather than interleave. Recheck binding under the lease.

An existing foreign draft is not overwritten. Human messages or independent provider activity that break the reply association cause explicit unconfirmed observation. Local leases coordinate this Agentify process; they do not prevent a human or another service from talking to Dot.

### C4. Reply and durable output

Keep `kind: query` and the current `assistant-response` receipt shape. Add structural completion source `dot-message` in the shared completion-evidence owner. HTTP accepts that source only for an explicit Dot run with validated binding and submission/reply association. Ordinary queries refuse it; Dot queries refuse ordinary `assistant-node`, `structured-recovery`, image, and research evidence.

A completed Dot message must be associated with the submitted user turn by provider message/group evidence and carry the bound Dot's author evidence. Matching reply prose or merely observing a newer assistant node is insufficient. Task cards, progress surfaces, and unsolicited Dot updates cannot establish that relationship. If the provider exposes no sufficient association, O1 fails; do not substitute text matching.

The controller's returned evidence includes binding, user message identity, reply message identity, and the observed completed-message signal. HTTP validates it before writing the private response and metadata, then hashes the saved bytes and finalizes success with the existing receipt.

`status: success` means this message reply was received and saved. It says nothing about background task completion. The artifact and run metadata include the Dot binding; reply text is returned once. No new polymorphic event stream or background-task taxonomy is introduced. Existing compatibility event kinds remain unchanged.

### C5. Submission checkpoint and retry

Persist `dotSubmission` with the run. Its state is one of:

- `not-submitted`: no submission-capable input has been attempted.
- `unknown`: an awaited durable intent checkpoint was written before that input, but delivery is not yet proven.
- `submitted`: provider evidence identifies the accepted user message.

`state === submitted` iff a validated user message identity is present. Transition to `unknown` is durable before external input; transition to `submitted` follows provider acknowledgement. An ordinary progress callback is insufficient: `#emitProgress` currently swallows callback errors (`chatgpt-controller.mjs:1044`). U3 introduces an awaited checkpoint callback whose failure propagates.

Submission fallbacks obey the same rule as retry: after an action could have submitted, no second submitting action is attempted without authoritative proof that delivery did not occur. Pre-action strategies remain available; unacknowledged input becomes observation-only, not a reason to try another click or Enter.

Retry may send only from `not-submitted`. From `submitted`, reopen the exact binding and observe the same reply without resending. From `unknown`, observe and upgrade only if provider evidence can uniquely establish delivery; otherwise return `dot_delivery_unconfirmed` without input. A completed original run returns its existing output. Generic retry never creates a new recipient or silently issues another message.

`requestStop` currently always tries a visible provider Stop button (`chatgpt-controller.mjs:5564`), and both HTTP and local server stop actions call it (`http-api.mjs:4732`, `:5348`). U3 must make a Dot-bound controller's stop operation local even when no current run exists. Stopping observation preserves the checkpoint. It does not click Dot's global pause, stop unrelated delegated work, cancel schedules, or claim rollback of an already delivered message.

### C6. Persistence and consumer projections

The existing key metadata writer stores verified `recipient` and `dotBinding` for Dot affinity. Extend the existing normalization owner to branch on the validated Dot record before ordinary location repair. A malformed Dot entry fails only its own lookup. It remains on disk, does not make valid Chat entries disappear, and is not discarded when another key is saved. The current whole-file catch in `state.mjs:167` must not turn a strict Dot parse error into an empty map. Keep ordinary records and inputs unchanged; add no migration, versioned successor, compatibility alias, or separate metadata store.

Run records retain `recipient`, `dotBinding`, and `dotSubmission` as validated top-level fields as well as the relevant replay intent. Summary, get, wait, open, retry, artifact metadata, and MCP projections retain the necessary binding. Placement solely inside `logicalRequest` is insufficient because summaries remove it (`run-store.mjs:240`).

Reusing a key with a different recipient or conversation refuses the request. Reopening is read-only navigation. Restart does not resubmit an interrupted message. Equality compares stable provider identities, not display labels or timestamp ordering. Observation of a different conversation never replaces saved affinity implicitly.

Existing observation deadlines and waiter behavior remain owned by the current run/controller timing code. No new Dot latency promise or picked timeout is introduced. Dot observation must not inherit a Pro-mode timing assumption or invoke Chat-specific structured recovery.

### C7. Capture scope and compatibility coverage

Save only the current operation's reply and required private binding/checkpoint metadata. Dot calls do not auto-track or publish the full personal Dot conversation into Transcript Library. Their transcript publication state is `not_applicable`; ordinary library behavior is unchanged. Dot metadata is not injected into transcript roles or hashes.

The existing ChatGPT map owns the distinct Dot capability identities `dot-readiness`, `dot-composer`, `dot-submit`, and `dot-response`. Reuse its existing semantic primitives and postconditions, with C2/C4 enforced by the owning operation; do not invent a second unvalidated selector registry. Derive projections from that map. A Chat `response` observation cannot establish Dot `dot-response` coverage. Reuse current contract-hash coverage reset and redacted event parsing; do not record personal Dot names, message text, raw page content, or account identifiers in compatibility telemetry.

### Shared scenarios and state × action

Cells below name observation / durable change / effect / concurrency rule / locking scenario. They describe the required contract, not current implementation.

| Binding state | New query | Continue or open saved affinity |
|---|---|---|
| uniquely confirmed | reply or query run / binding retained / C3–C5 input / same-conversation conflict / **bound exchange** | same binding / locator refreshed only for identical IDs / exact navigation / lease conflict / **same Dot continuation** |
| wrong or ambiguous | `dot_binding_mismatch` or `dot_binding_unconfirmed` / no affinity replacement / no prompt input / conflicting callers cannot bypass / **recipient drift** | same errors / original record retained / no fresh conversation / lease conflict / **restart drift** |
| unavailable, logged out, or old binding malformed | readiness or saved-binding error / original record retained / existing login handoff only / tab ownership retained / **unavailable Dot** | same error / no home repair / no send / no competing reopen / **invalid saved binding** |

| Submission state | Retry or recovery | Stop observation |
|---|---|---|
| not-submitted | new guarded attempt / C5 checkpoint transitions / at most one submit attempt at a time / C3 conflict / **pre-send retry** | stopped / not-submitted retained / no provider stop control / ownership released after settlement / **stop before send** |
| unknown | recovered acknowledgement or `dot_delivery_unconfirmed` / upgrade only on unique evidence / observation only / C3 conflict / **ambiguous delivery** | stopped / unknown retained / no Dot task cancellation / ownership released after settlement / **stop during delivery** |
| submitted | saved associated reply or observation error / identity retained / no resend / C3 conflict / **observe-only retry** | stopped / submitted identity retained / no background-task cancellation / ownership released after settlement / **stop after send** |

Consumer behavior is fixed by the same named scenarios:

| State | MCP query / HTTP caller | Get and wait | Open / retry | Existing Control Center |
|---|---|---|---|---|
| reply being observed | run ID in async form; sync call waits | live query, binding, checkpoint | open exact route; retry cannot compete | Dot message waiting, existing stop-observation action |
| completed associated reply | answer once, Dot metadata | receipt-backed saved output | open exact route; retry returns saved output | Dot reply received |
| ended with uncertain delivery | explicit error, no fabricated reply | terminal failure with unknown checkpoint | observation-only recovery; no automatic input | delivery unconfirmed, no task-completion claim |
| interrupted or stopped after delivery | terminal status | submitted message identity retained | C5 observation-only branch | observation stopped; delivered message remains |

**Completion counterexamples:** a completed reply saying it started a task satisfies message completion but not task completion; a stable task card without an associated completed message satisfies neither. **Guard neighbors:** a renamed Dot with identical stable IDs stays valid; an ordinary Chat page remains valid for a Chat request but invalid for Dot. **Additional states:** old receipt-backed Dot output remains readable after UI drift; a foreign draft refuses preparation. These are included in U3–U5 scenarios.

## Implementation Units

### U1. Characterize Dot and validate its provider observations

- **Goal:** Establish the factual provider contract and a tested read-only Dot observation adapter.
- **Requirements:** R1, R2, R7; O1.
- **Direction:** none — no user-facing operation is introduced by this reader.
- **Dependencies:** None.
- **Files:** Create `chatgpt-recipient.mjs`, `chatgpt-dot-ui.mjs`, `tests/chatgpt-dot.test.mjs`, sanitized `tests/fixtures/chatgpt-dot/` fixtures, and a dated Dot contract report under `docs/probes/`. Modify no browser auth configuration.
- **Approach:** Read the authenticated desktop-web Dot surface without sending. Record route meaning, stable identities, writable-composer evidence, turn relationship, and message-end evidence; derive the strict parsers and fixture reader from that capture rather than guessed selectors.
- **Patterns to follow:** `chatgpt-location.mjs:15` for origin checks; `chatgpt-compatibility-resolver.mjs` for validated browser results; `tests/chatgpt-compatibility-backend-parity.test.mjs:27` for transport decoding.
- **Test scenarios:** Happy path: owned Dot fixture produces a unique binding and associated completed reply. Edge: renamed display label preserves stable identity. Errors: ordinary Work, ambiguous Dot, unknown variant, missing IDs, unrelated update, and malformed evaluation result never produce binding or reply evidence.
- **Verification:** O1's evidence gaps are stated individually; local parser/reader checks discriminate confirmed, absent, and unobservable states.
- **Proven through:** Fixture-backed page evaluations; read-only actual-provider capture where available.
- **Runtime evidence:** Unverified — requires actual desktop-web Dot capture. Native screenshots and official docs do not settle O1.
- **Checkpoint:** auto — `node --test tests/chatgpt-dot.test.mjs` plus the read-only contract report. Missing provider evidence permits synthetic checks and independent U2 protocol work; it does not permit live sends or a runtime-support claim.

### U2. Expose explicit Dot queries through the existing run path

- **Goal:** A real MCP-to-HTTP fixture exchange preserves the recipient through tabs, records, output, and waiting.
- **Requirements:** R1, R2, R3, R6, R7; O4.
- **Direction:** D1, D2, D3.
- **Dependencies:** U1's semantic parsers; protocol fixtures may proceed while live observations remain open.
- **Files:** Create `chatgpt-completion-evidence.mjs`; modify `mcp-server.mjs`, `mcp-tool-profile.mjs`, `http-api.mjs`, `main.mjs`, `tab-manager.mjs`, `chatgpt-controller.mjs`, `run-store.mjs`, `state.mjs`, `chatgpt-mode-intent.mjs`; test `tests/http-api.test.mjs`, `tests/tab-manager.test.mjs`, `tests/run-store.test.mjs`, `tests/mcp-tool-profile.test.mjs`, `tests/mcp-tool-profile-integration.test.mjs`, `tests/mcp-server-names.test.mjs`, `tests/chatgpt-mode-intent.test.mjs`, and `tests/state.test.mjs`.
- **Approach:** Register the dedicated tool in core/full profiles, parse Dot requests before effects, and bridge immutable recipient metadata through controller creation. Keep query kind and receipt handling; centralize structural completion evidence while preserving recipient-specific HTTP acceptance.
- **Patterns to follow:** `mcp-server.mjs:840`, `:905`, `:942`; `tab-manager.mjs:100`; `http-api.mjs:2282`; `run-store.mjs:101`.
- **Test scenarios:** Happy: real stdio tool sends a complete Dot request to a fixture HTTP server and returns an answer once with a receipt. Errors: caller observation stamps, unsupported Dot fields, unknown recipients, Chat/Dot key collisions, mismatched tab/key, ordinary evidence for Dot, Dot evidence for Chat, and missing receipts. Regression: all current ordinary request defaults and tool-profile semantics remain intact.
- **Verification:** C1, C4, and C6 hold across actual process boundaries; the constructor bridge retains the same parsed recipient.
- **Proven through:** Real MCP stdio and HTTP fixture servers with injected controller results and an owned temporary state directory.
- **Rollback:** Revert source without deleting runs or key files. New Dot records remain clearly tagged; older code must not be used to send from them. Inspect private state before any intentional downgrade.
- **Runtime evidence:** Unverified — U2's protocol exerciser must execute the registration, forwarding, dispatch, and saved-output path. Type or schema inspection alone is insufficient.
- **Checkpoint:** auto — the named unit tests and actual stdio fixture exchange, then `npm test`; no permitted temporary ordinary-Chat failures.

### U3. Submit and save only replies from the bound Dot

- **Goal:** The browser query path enforces identity, conversation ownership, durable delivery checkpoints, and Dot reply qualification.
- **Requirements:** R2, R3, R5, R6, R7; O2, O3, O4.
- **Direction:** D2, D3.
- **Dependencies:** U1's actual provider contract; U2.
- **Files:** Modify `chatgpt-controller.mjs`, `chatgpt-dot-ui.mjs`, `http-api.mjs`, `chatgpt-compatibility.json`, `chatgpt-compatibility.mjs`, `main.mjs`, and `selectors.json` only if its derived projection changes; test `tests/chatgpt-controller.test.mjs`, `tests/http-api.test.mjs`, `tests/provider-tab-operation-leases.test.mjs`, `tests/chatgpt-compatibility-map.contract.test.mjs`, `tests/chatgpt-compatibility-backend-parity.test.mjs`, `tests/chatgpt-compatibility-terminal.integration.test.mjs`, `tests/chatgpt-compatibility-scrub.test.mjs`, and `tests/fixtures/chatgpt-compatibility/current.json`.
- **Approach:** Select Dot input/readers from the immutable recipient and its map-backed observations. Reuse native/DOM input mechanics with recipient checks at every final action. Acquire the conversation lease and await durable checkpoint writes before submission; accept only C4 Dot evidence. Skip Dot transcript publication explicitly. Replace provider-button stop with local Dot observation cancellation in both service entry points; prevent a second submitting fallback after uncertain delivery.
- **Patterns to follow:** `chatgpt-controller.mjs:5496`, `:6152`, `:6196`, `:6270`, `:6394`; `provider-tab-operation-leases.mjs:64`; `http-api.mjs:2373`. Do not use the error-swallowing progress callback for O3.
- **Test scenarios:** Bound exchange; foreign draft; recipient changes at every existing submission fallback; route/account drift after preparation; two keys sharing one conversation; checkpoint failure before input; crash at unknown delivery; ordinary assistant node, task card, unsolicited Dot message, incomplete delivery, and missing reply association. Also exercise HTTP and local-server stop before send, during delivery, after send, and without a current Dot run; no provider Stop/Pause action is permitted. Test both triggering and adjacent valid cases. Removing each final check must make its designated unsafe-send case fail.
- **Verification:** C2–C5 and C7 hold. Submitted iff accepted user-message identity exists. No response artifact or success exists without bound Dot completion and receipt. Chat observations cannot satisfy Dot coverage.
- **Proven through:** Controller VM/DOM fixtures, service/controller integration doubles, and existing native cancellation fixture patterns. Real backend transport decoding must be tested separately from mocked input.
- **Rollback:** Source reversion cannot undo a delivered Dot message or Dot memory. Preserve checkpoints and saved output; do not delete provider messages as cleanup.
- **Runtime evidence:** Unverified — built Dot input and observation must be exercised under U5's scoped consent. Fixture coverage establishes mechanism, not live provider viability.
- **Checkpoint:** auto — relevant controller, HTTP, lease, map, parity, terminal, and redaction tests, followed by `npm test`. Fixture states are derived from U1; no guessed provider fallback is allowed.

### U4. Continue and recover Dot conversations without duplicate sends

- **Goal:** Restart, open, and retry use the saved recipient and delivery state rather than reconstructing an ordinary Chat request.
- **Requirements:** R3, R4, R5, R6, R7.
- **Direction:** D2, D3.
- **Dependencies:** U2, U3.
- **Files:** Modify `http-api.mjs`, `run-store.mjs`, `state.mjs`, `chatgpt-mode-intent.mjs`, `tab-manager.mjs`, `mcp-server.mjs`, and `chatgpt-controller.mjs`; test `tests/http-api.test.mjs`, `tests/run-store.test.mjs`, `tests/state.test.mjs`, `tests/tab-manager.test.mjs`, `tests/run-waiter.test.mjs`, and `tests/mcp-tool-profile-integration.test.mjs`.
- **Approach:** Branch before ordinary location/profile repair in key loading, run opening, and retry. Revalidate the complete binding after navigation. For submitted or uncertain delivery, reuse Dot observation without prompt preparation; expose checkpoints in summaries and text status.
- **Patterns to follow:** `http-api.mjs:3044`, `:3112`, `:3304`; `state.mjs:162`; `run-store.mjs:240`; `run-waiter.mjs:98`.
- **Test scenarios:** Same Dot continuation; restart drift; invalid saved binding alongside an intact Chat key; saving another key retains that invalid value; submitted interrupted run receives its original reply without a second submit; unknown delivery refuses resend; pre-send retry performs one guarded attempt; completed retry returns saved output; changed display name preserves binding; changed default Chat project or model cannot redirect Dot. Ordinary open/retry/library scenarios remain unchanged.
- **Verification:** C5–C7 survive write/reload/open/retry. The runtime restart test observes browser input counts, not only stored fields.
- **Proven through:** Owned-state service restart fixtures and instrumented controller submission counters across real MCP operations.
- **Rollback:** Retain durable Dot records and checkpoints. No downgrade converts them to home or ordinary Chat; no automatic replay is part of rollback.
- **Runtime evidence:** Unverified — execute the restart/operation fixture, then the live continuation in U5.
- **Checkpoint:** auto — the named persistence, restart, operation, waiter, and MCP scenarios plus `npm test`; no temporary failures permitted.

### U5. Verify the built client path and document its limits

- **Goal:** Establish end-to-end evidence and a clear public Dot messaging contract.
- **Requirements:** R1–R7; O1–O4.
- **Direction:** D1–D3.
- **Dependencies:** U1–U4.
- **Files:** Create `scripts/e2e-mcp-dot-query.mjs` and a dated live report under `docs/probes/`; modify `README.md` and `docs/mcp-method-happy-paths.md`; extend `tests/mcp-tool-profile-integration.test.mjs` and the Dot/backend fixture tests as needed.
- **Approach:** Model the local runner after existing stdio/owned-state exercises, using fixture provider pages by default. Separately exercise an authorized actual Dot first reply and same-conversation continuation through the built MCP tools. Record code revision, backend, provider build if exposed, identity/turn evidence, saved-byte hashes, and limitations.
- **Patterns to follow:** `scripts/e2e-mcp-local-state.mjs:111`; `tests/mcp-tool-profile-integration.test.mjs:16`; `docs/probes/2026-10-07-chat-only-send-probe.md` for evidence structure, not reused consent.
- **Test scenarios:** The real local MCP client discovers the tool, completes a fixture Dot query, waits for async output, reopens, restarts, and retries without duplicate input. Electron direct results and CDP-wrapped results decode equally. The live first reply and continuation preserve Dot/conversation identity and match receipt hashes. Run the current Chat-only deterministic regression suite; real Chat probes require their own authorization.
- **Verification:** D1–D3 are visible in actual MCP results; all obligations are discharged or explicitly unmet. A failed live probe is recorded as failed, not a supported-but-hidden feature.
- **Proven through:** `node scripts/e2e-mcp-dot-query.mjs` with an owned fixture service/profile, plus separately authorized live MCP calls.
- **Rollback:** Close only owned probe tabs. Preserve provider messages, private evidence, and saved receipts; provider memory is not rolled back.
- **Runtime evidence:** Unverified — no live Dot query or continuation has run.
- **Checkpoint:** gate — local exerciser and scoped live grant: local checks continue automatically; grant plus matching identity, reply association, and receipts permits the live acceptance action. Missing grant holds live sends and the support-complete claim; local tests and documentation continue. Disconfirming provider evidence blocks acceptance and requires revising the affected design.

## Scope Boundaries

Included: text messages, explicit Dot identity, reply capture, async wait/get, exact continuation, safe open/retry, local observation cancellation, and honest compatibility coverage.

Not included: general Work transport; controlling Dot's computer; administering Dot permissions, tasks, schedules, or memory; Slack/Teams connections; voice; file/context uploads; image/research controls; arbitrary custom GPTs; whole-Dot transcript import, tracking, or background polling. Do not change the local coding workspace from a Dot URL. No shared Agentify skill policy edit belongs in this implementation.

### Deferred to Follow-Up Work

No implementation unit is deferred. The excluded capabilities are scope boundaries rather than promised future work. Do not add a backlog item merely for completeness. Unrelated compatibility drift and shared-skill maintenance already have their owning records; this plan does not expand them.

## System-Wide Impact

- **Interaction graph:** MCP discovery and forwarding, `/query`, tab/controller construction, provider observation, operation leases, run storage, artifact finalization, waiter, open/retry, and existing status rendering.
- **Error propagation:** malformed request → 400 before effects; recipient/binding/draft/operation conflict → 409; unavailable browser follows existing readiness handoff; unconfirmed reply or delivery remains a content-free failure without successful output. Async callers see the same semantics through the persisted run.
- **Lifecycle risks:** ignored new fields, ordinary home repair, cross-key interleaving, restart resend, stale browser URL, and success on an unrelated/progress-only Dot update. C2–C7 own these risks.
- **API parity:** metadata survives synchronous result, async submission, list/get/wait summaries, open/retry, private artifacts, and MCP text/structured projections. The Control Center consumes the existing outcome label; no separate task lifecycle UI is added.
- **Integration coverage:** U5 executes real stdio/HTTP boundaries; U3 covers actual submitting evaluations; U4 restarts the service and counts inputs. A controller stub alone proves none of those provider interactions.
- **Unchanged invariants:** normal Chat-only enforcement, receipt-backed query success, vendor transport selection, current Transcript Library roles/hashes, browser account handling, and filesystem workspace routing.

## Build Execution Contract

- **Closed decisions:** Architecture Decision; C1–C7; D1–D3; O1–O4. Do not add a Dot vendor, reinterpret reasoning, change reply success into task success, or silently widen normal sends.
- **Builder autonomy:** reversible local layout and fixture details consistent with those definitions. Record plan-silent choices and why they preserve the contracts. No generic framework extraction, new dependency, or invented provider selector is authorized by omission.
- **Verify at contact:** re-read changed boundaries against the inspected revision; if the current code already supplies a required primitive, reuse it. Confirm Dot routes and observations through O1; unsupported evidence stays unverified. Confirm creation URL versus served URL using the controller getter, not tab list metadata. Confirm profile identity semantics rather than treating local names as account evidence. Confirm new fields survive actual store reload and MCP projection; repair the owner if they do not.
- **Stop conditions:** an actual provider capture supplies no stable owned Dot identity, no safe writable target, or no sufficient reply association/finality signal; the proposed contract cannot be met without inspecting secret values or inventing private provider APIs; preserving normal Chat behavior requires changing its settled authorization boundary. Stop the affected integration decision and retain the findings. Missing live permission alone holds live effects, not independent local work.
- **Authority boundaries:** use existing authenticated browser handling without reading secret values. Never add app/computer access or pause unrelated Dot work. Never send a provider prompt under planning authority. Existing ordinary-query verification consent does not cover Dot.
- **Expected gate map:** U1's observation/parser checks, U2's protocol/output checks, U3's submission/qualification checks, and U4's restart/retry checks must each be green. U5 adds full local exchange and live acceptance. No ordinary tests are permitted to fail temporarily. Publication follows the repository's exact-SHA CI contract; commit or push only within the execution instruction's authority.

### Human inventory

| Contribution | Role | Resolution / stand-in | Held without it |
|---|---|---|---|
| Actual owned Dot locator and usable desktop-web session | content, assistance | Obtain the non-secret locator through the UI. The human handles login or account prompts. Sanitized fixtures prove parsing and mechanism only. | Actual provider characterization if unavailable; all live acceptance. |
| Bounded Dot acceptance messages | consent | Before sending, request a grant naming the actual Dot, the built revision, one reply-only connection message and one continuation message, text-only effects, no requested app actions, and owned-tab cleanup. These two exchanges are the minimum cases for first send and continuation, not a performance calibration. | Both live messages and the support-complete claim. |
| Additional account/app permissions | consent, assistance | Not requested by this plan. Remain ungranted. | Any permission expansion; no implementation unit depends on it. |

No calibration quantity is selected: input, context, observation, and retention limits retain their existing owners. No visual taste judgment is needed for the existing MCP presentation. The live grant must be checked before effects, not after a commit. Every unverified runtime claim names its fixture stand-in and the live action it does not prove.

## Risks, disconfirming evidence, and confidence

| Risk or unknown | Evidence that would disconfirm the approach | Required response |
|---|---|---|
| Dot lacks stable observable ownership/identity | Actual desktop-web capture exposes only a name or generic Work state | O1 fails; stop the binding design. Do not accept a name-based fallback. |
| Replies cannot be attributed to a submitted message | Proactive updates and prompted replies share indistinguishable provider structure | O1/C4 fail; revise the transport's promised output rather than guess. |
| Dot route state is not durable | Reopening the captured locator selects another conversation or recipient | C2/C6 fail; do not replace saved affinity or submit. |
| Backend contract differs | Identical fixture observations decode differently through Electron and CDP | Repair the boundary decoder; a transport exception is not absence. |
| Mutable UI defeats final checks | A planted recipient change at a submitting evaluation still emits input | O2 fails; repair that actual input boundary. |
| Checkpoint failure or restart duplicates a message | Instrumented input count increases during unknown/submitted recovery | O3/C5 fail; acceptance remains blocked. |
| Dot success claims completed work | Reply with an active background task produces a task-completed label | C4/D3 fail; correct the consumer projection. |

The source trace is strong for existing transport and storage ownership. Runtime confidence for Dot is unverified. In particular, `TabManager.listTabs` reports a creation URL, `profileScopeId` is not account evidence, `#emitProgress` suppresses callback failure, `requestStop` clicks provider Stop, strict key decoding can reach a whole-file empty-map catch, and ordinary recovery can capture a different semantic source. Those facts change C2, C5, C6, and U2–U4; they are not general assurances that reuse works.

Plant defects at the recipient, evidence-source, checkpoint, and retry boundaries and observe their named scenarios fail before claiming those tests protect the contract. Count the expected failures. The live report must keep the actual provider build/date, source revision, observed scope, and unproved background-task behavior beside its conclusions.
