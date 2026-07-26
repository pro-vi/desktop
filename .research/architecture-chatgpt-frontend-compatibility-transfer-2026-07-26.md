---
title: ChatGPT frontend compatibility transfer
date: 2026-07-26
project: agentify-desktop
depth: Deep
status: ready-for-implementation
research_basis:
  - .research/synthesis-designer-ui-drift-2026-07-26.md
  - Designer snapshot 2371459db513437c2202f5771142b95f9e5b7367
  - Agentify snapshot 67f1b6e
---

# ChatGPT frontend compatibility transfer

## Outcome

Build a passive-first, ChatGPT-scoped compatibility sidecar around Agentify's production resolver and durable completion pipeline. It will tell us which declared UI branch actually worked, whether the user-visible capability completed, how much of the observed rollout cohort has been exercised, and whether the measuring apparatus itself failed. It will not claim to know the globally latest ChatGPT UI, create background traffic, evade protective measures, or guarantee account safety.

The load-bearing design law is:

> Runtime action and compatibility observation must consume the same resolver and semantic postcondition. A second DOM scanner is a second truth and is forbidden.

## Research basis

Designer MCP's strongest transferable pattern is a declared selector contract, ordered canonical/legacy resolution, semantic capability anchors, four-way anchor status, a separate apparatus verdict, scrubbed evidence, and temporal memory. Its important counterexample is equally useful: its current auto-healer can patch none of the real centralized anchors, so Agentify must not copy repair theater.

Agentify already has the raw ingredients:

- semantic prompt/model/mode scoring in `chatgpt-ui-primitives.mjs`;
- positive send, attachment, response, model, and mode postconditions in `chatgpt-controller.mjs`;
- constructor injection at `main.mjs:226-245`;
- a vendor-aware `TabManager` that currently drops vendor identity before controller construction at `tab-manager.mjs:62-100`;
- a common `page.evaluate(jsString)` boundary in both browser backends;
- closed lifecycle vocabularies in `run-lifecycle.mjs`;
- serialized, write-before-publish persistence in `run-store.mjs`;
- receipt-backed query/research completion in `http-api.mjs` and ADR 0002;
- authenticated status projection through `/status`, MCP, IPC, and the Control Center.

The external-policy boundary is material. Current OpenAI terms prohibit automatic/programmatic extraction and bypassing restrictions or protective measures. The Computer Use guide recommends isolation, explicit allowlists, and human control for high-impact actions, but it does not authorize automating ChatGPT. Sources: [Terms of Use](https://openai.com/policies/terms-of-use/), [Services Agreement](https://openai.com/policies/services-agreement/), [Computer Use guide](https://developers.openai.com/api/docs/guides/tools-computer-use).

## Requirements

- **R1 — Declared contract:** A checked-in, versioned ChatGPT compatibility map owns every mapped selector branch, capture metadata, capability dependency, precondition id, postcondition id, and explicit exemption.
- **R2 — Provider isolation:** Only `vendorId === "chatgpt"` can emit ChatGPT compatibility evidence. Claude, Gemini, Perplexity, Grok, and AI Studio retain current behavior through an explicit legacy adapter.
- **R3 — Shared production resolver:** Production actions and passive observation use the same authority-ordered resolver. Mapped controller capabilities contain no selector literals outside named exemptions.
- **R4 — Semantic completion:** Health distinguishes mechanism resolution from capability postcondition and from the operation's authoritative terminal mode: `dispatch`, `predicate`, `receipt-backed`, or `artifact-backed`.
- **R5 — Honest status:** Anchor status is `ok | degraded | fail | skip`; apparatus verdict is `ok | drift | incomplete`. Missing, malformed, or unexecuted evidence never becomes green.
- **R6 — Private durable memory:** Compatibility state is runtime-validated, recursively allowlisted, bounded, mode `0600`, atomic, serialized across tabs, and explicit about corruption or write failure.
- **R7 — Existing visibility surfaces:** One versioned serializer feeds authenticated `/status`, `agentify_status`, IPC state, and the Control Center without exposing compatibility detail on public `/health`.
- **R8 — Discriminative proof:** Sanitized fixtures, mutation sentinels, backend/evaluator parity, provider isolation, passivity, privacy, persistence, terminal-source, and cross-surface tests can fail for the known wrong states.
- **R9 — Account-risk boundary:** Initial scope creates zero new provider-visible actions. Active canaries, anti-detection expansion, and automated repair/promotion are disabled and deferred; no surface claims "ban-safe" or globally latest.

## Architecture Decision

**Approach:** Introduce a passive-first, provider-scoped compatibility sidecar at the existing controller injection, browser-evaluation, and HTTP finalization seams. The sidecar consists of a checked-in ChatGPT contract, a shared ordered resolver, a closed observation union, a private bounded reducer/store, and a single authenticated health projection.

**Why this approach won:** It is the only option that preserves Agentify's actual multi-vendor controller shape while making the production path observable. It follows existing ES-module, injected-evaluator, closed-vocabulary, atomic-store, and receipt-backed patterns. It also minimizes new external behavior: compatibility evidence is collected during work the user already requested.

**Rejected credible alternative:** A scheduled ChatGPT canary with a parallel DOM health scanner. It would issue additional account actions, could bypass the existing governor if wired directly to the controller, would measure a path different from production, and would still observe only one rollout cohort. It adds both policy/account risk and duplicate-truth drift before Agentify has a trustworthy passive apparatus.

**Also rejected:** Replacing `selectors.json` globally with a ChatGPT-only structured map. The same controller and selector bag currently serve six vendors; wholesale replacement would create a cross-provider regression. The flat file remains the legacy/non-ChatGPT view during migration.

**Consequences accepted:**

- Initial coverage grows only when real, user-authorized operations exercise capabilities; unobserved is reported as unobserved/`skip`, never healthy.
- The controller migration is a deliberate census of a 4,162-line load-bearing module, not a cosmetic selector-file conversion.
- The contract and persisted event/status vocabularies are one-way doors and receive runtime parsers, exhaustive consumers, and migration/version tests.
- Electron and MCP processes must restart after schema changes because both are long-lived.
- Automatic live repair is not part of V1. Manual registry changes remain reviewable and must pass fixtures plus ordinary authorized use before promotion.

This decision should graduate into an ADR with the implementation PR.

## High-Level Technical Design

Directional guidance for review, not implementation specification:

```text
checked-in chatgpt-compatibility.json
       │ parse + hash + closed vocabularies
       ▼
ChatGPTCompatibilityProfile ───────────────┐
       │                                   │
       │ ordered evaluator plan            │ sanitized typed observations
       ▼                                   ▼
page.evaluate(jsString)              CompatibilityStore (0600)
 Electron │ Chrome CDP               atomic bounded state.json
       │ decode unknown                     │
       ▼                                    ▼
ChatGPTController action ──postcondition── HealthReducer
       │                                    │
       └──── attempt context ────────────────┤
                                            │
HTTP artifact/receipt finalizer ─terminal───┘
                                            │
                                   status serializer
                              ┌────────┬─────┴─────┐
                          /status    MCP/IPC   Control Center
```

The existing integration shape changes explicitly:

```js
// Current extension point
createController({ tabId, page, session })

// Required bridge; controller codomain and tab lifecycle remain unchanged
createController({ tabId, page, session, vendorId, vendorName })

// Main chooses the profile without widening other vendors into ChatGPT.
new ChatGPTController({
  page,
  selectors,
  uiContract: vendorId === 'chatgpt'
    ? createChatGptCompatibilityProfile(...)
    : createLegacyUiContract(selectors),
  onCompatibilityObservation
})
```

The browser boundary remains `evaluate(js: string) -> unknown`. A compiler renders an authority-ordered branch plan into the existing injected-JavaScript style; a decoder narrows the unknown response before any result affects readiness, action, health, persistence, or repair.

The controller API must centralize observation discipline rather than make every call site repeat it:

```js
await uiContract.runCapability('submit-accepted', attemptContext, async (probe) => {
  const composer = await probe.evaluateAnchor('composer', evaluatorBody);
  const result = await performExistingSendPath(composer.value);
  probe.assertPostcondition('submit-acknowledged', result.acknowledged);
  return result;
});
```

`runCapability` owns parsing, branch evidence, postcondition classification, and exactly-once mechanism/capability observation. Store failure is reported as apparatus `incomplete` but does not change the provider operation's result. Provider-operation failure still propagates through the existing controller/HTTP error path after its compatibility classification is emitted.

### Representation authority ledger

| Concept | Semantic authority | Derived consumers / mirrors | Boundary guard |
|---|---|---|---|
| Selector branches and capability dependency graph | `chatgpt-compatibility.json` | runtime profile, fixtures, coverage report, status labels | versioned parser + map contract test |
| Closed vocabularies and semantic primitive ids | `chatgpt-compatibility.mjs` frozen constants | resolver, reducer, serializer, tests | normalizers throw internally; external serializer renders unknown as incompatible |
| Browser resolution result | `chatgpt-compatibility-resolver.mjs` decoder | controller action + observation | `unknown -> ParsedResolution`; CDP `exceptionDetails` is apparatus error |
| Observation taxonomy | frozen discriminated union in `chatgpt-compatibility.mjs` | store, reducer, tests | exhaustive switch test over every `kind` |
| Current compatibility state | `${stateDir}/compatibility/chatgpt/state.json` through `compatibility-store.mjs` | authenticated status projection | version/hash parser; corruption quarantine + incomplete verdict |
| Status wire shape | one serializer/parser in `chatgpt-compatibility.mjs` | HTTP, MCP, IPC, renderer | cross-surface contract/round-trip test |
| Settings and future authorization | `state.mjs` | HTTP/UI policy projections | no parallel defaults in `config.mjs` |
| Flat selector override | existing operator file, adapted as a legacy-source branch | ChatGPT legacy profile and non-ChatGPT raw selector view | known-key parser; override use is always visible as degraded |

Necessary asymmetries remain explicit: canonical versus legacy; anchor status versus apparatus verdict; passive versus authorized-active; raw private evidence versus scrubbed projection; Electron versus CDP transport; host DOM versus research-frame realm; ESM versus CJS preload mirror; mechanism terminal versus durable terminal.

### Observation taxonomy

The observation stream is a first-class discriminated union; no `unknown[]` or arbitrary patch bag is allowed:

```js
ResolutionObservation = {
  kind: 'resolution', capabilityId, anchorId, branchId,
  branchKind: 'canonical' | 'legacy',
  branchSource: 'contract' | 'operator-override',
  selectorHash, rolloutSignature
}

CapabilityObservation = {
  kind: 'capability', capabilityId, postconditionId,
  status: 'ok' | 'degraded' | 'fail' | 'skip', reasonCode
}

TerminalObservation = {
  kind: 'terminal', capabilityId,
  mode: 'dispatch' | 'predicate' | 'receipt-backed' | 'artifact-backed',
  status: 'satisfied' | 'failed' | 'not-applicable', artifactCount
}

ApparatusObservation = {
  kind: 'apparatus', stage: 'map-parse' | 'eval' | 'decode' | 'store' | 'projection',
  verdict: 'incomplete', reasonCode
}
```

Every variant also carries `schemaVersion`, `attemptId` (random correlation id, never a run id), `observedAt`, `contractHash`, `vendorId: "chatgpt"`, and backend. Persisted data excludes tab ids, run ids, URLs, conversation/project ids, prompt/response text, filenames, arbitrary labels, raw DOM/HTML, screenshots, cookies, tokens, home paths, and account identifiers.

### Compatibility composition matrix

Old scalar assumption: each selector key is one comma-OR CSS string shared by all vendors, and a boolean result implies success.

New composed model: provider profile → capability → semantic anchor → ordered branch with source/kind → parsed structural evidence → behavioral postcondition → terminal mode → health projection. The profile builds the bundle; the resolver decides branch order; the reducer decides health; status surfaces only render the result.

| Mixed case | Expected visible contract | Typed decision/source | Locking test |
|---|---|---|---|
| Non-ChatGPT legacy happy path | Existing action behavior; no ChatGPT observation | legacy adapter / not applicable | `chatgpt-provider-isolation.test.mjs` |
| ChatGPT canonical branch + postcondition pass | Observed healthy for that capability | `ok`, contract/canonical | resolver fixture + health test |
| Canonical absent, legacy works | Capability works but drift is visible | `degraded`, contract/legacy | legacy fixture mutation |
| Operator override works | Capability works but upstream map is not certified | `degraded`, operator-override | override projection test |
| Branch matches, postcondition fails | Matching node is not called success | `fail`, postcondition reason | wrong-node fixture sentinel |
| Eval/decode/store cannot prove result | No drift claim and no green claim | apparatus `incomplete` wins | eval-boundary/store failure tests |
| Required observed anchor fails while another passes | Failing capability is named; passing one is not blamed | apparatus `drift` with per-anchor evidence | mixed reducer test |
| Capability never exercised | Coverage says unobserved; no global-current claim | `skip/not-observed` | cold-state status test |

Priority lattice:

1. Apparatus `incomplete` wins when the required evidence path did not execute reliably.
2. Otherwise any applicable required `fail` yields apparatus `drift`.
3. Otherwise observed applicable anchors may be `ok` or `degraded`; the apparatus is `ok` only for the explicitly reported observed cohort and coverage.
4. `skip` and absent observations never count as success evidence or alter failure streaks.
5. Operator override and legacy resolution are always degraded even when the action succeeds.

### Terminal-source matrix

| Consumer / operation | Intermediate mechanism signal | Authoritative terminal source | Explicit mode |
|---|---|---|---|
| synchronous query | stable new assistant response | output persisted, read back, hashed, registered, and receipted | `receipt-backed` |
| async query/retry | `runId` returned | `/runs/wait` sees terminal revision with valid receipt | `receipt-backed` |
| research | stable response plus export attempt | artifact/placeholder validation plus receipt | `receipt-backed` |
| `/send` / orchestrator | type/click strategy | prompt dispatch acknowledgment or conversation materialization | `dispatch` |
| image generation | response completion | required `/artifacts/save` result | `artifact-backed` |
| readiness/read/export predicates | evaluator result | same operation promise after parsed predicate | `predicate` |
| UI/MCP status | server snapshot | service-owned compatibility store | projection only |

Compatibility observations never replace `RunStore`, run lifecycle, completion receipts, or artifact authority.

### Operational contracts

Mechanism invariants:

- **Passive-action invariant:** enabling compatibility observation changes no provider-visible `navigate`, `input`, click, prompt submission, retry, or request count. Resolver evidence is returned by the evaluator already performing the action.
- **Provider invariant:** a persisted compatibility observation exists only if `vendorId === "chatgpt"` and the parsed profile hash matches the event hash.
- **Privacy invariant:** persisted/projected fields are constructed from an allowlist; recursive unknown fields are rejected, not redacted after the fact.
- **Publication invariant:** `publishedRevision === durableRevision`; subscribers and status never see a revision before the mode-`0600` atomic rename succeeds.
- **Current-map invariant:** every observation in the live ring has `contractHash === state.contractHash`; a map change archives/drops the live ring from current judgment and starts fresh coverage.
- **Judgment invariant:** an anchor is `ok | degraded | fail` iff its applicable postcondition executed; `skip` iff a declared precondition is not applicable or the capability has not been observed, with an explicit reason.
- **Streak invariant:** `failureStreak > 0` iff the most recent streak-affecting result for provider + capability + rollout signature + contract hash is `fail`; `ok/degraded` reset, `skip/incomplete` leave it unchanged.
- **Terminal invariant:** query/research `ok/degraded` cannot be durable-terminal until a matching receipt-backed terminal observation exists; send and predicate paths use their declared modes.
- **Telemetry-failure invariant:** compatibility persistence failure never converts a provider operation's return into failure, and never leaves compatibility green; the in-memory apparatus becomes `incomplete` synchronously.

Probe gates with kill conditions:

- **Drift lead-time probe:** after an exercised capability has a known injected DOM mutation, a failing/degraded/incomplete observation must exist before the operation is reported healthy. Kill the architecture if the user-visible failure occurs without an earlier or same-attempt compatibility signal.
- **Passivity probe:** compare instrumented and uninstrumented action traces. Kill passive mode if provider-visible action counts or challenge/retry behavior increase.
- **Privacy probe:** seed nested canary prompts, URLs, ids, tokens, filenames, and paths. Kill persistence/status publication if any canary survives serialization.
- **Provider-isolation probe:** run the same generic controller path for every vendor. Kill the release if any non-ChatGPT run updates ChatGPT health.
- **Honesty probe:** a cold profile, malformed evaluator result, or failed store must render `incomplete`/unobserved, never `ok`.
- **Real-world confidence probe:** after 30 exercised operations per capability or 30 days, whichever comes later, compare recorded signals with user-reported breakages. Two exercised breakages with no corresponding signal falsify coverage and force a resolver/postcondition redesign. This is cohort evidence, not a global-latest claim.

### State-action contract matrices

Cell notation below is expanded into five fields: caller observation, durable change, side effect, race/duplicate rule, and named test.

#### Observation outcome axis

| Current state + action | Caller observation | Durable change | Side effect | Race / duplicate behavior | Named test |
|---|---|---|---|---|---|
| unseen + record `ok` | accepted revision + `ok` | create aggregate, ring row, failure streak 0 | publish sanitized summary after write | global queue assigns one sequence; duplicate observation id returns prior revision | `store-first-ok` |
| current + record `ok` | accepted revision + `ok` | append bounded row, reset failure/degraded streaks | publish recovery | arrival sequence, not caller timestamp, decides latest | `store-ok-resets-fail` |
| unseen + record `degraded` | accepted revision + `degraded` | create aggregate, degraded streak 1, fail streak 0 | publish drift warning without operation failure | duplicate id deduped | `store-first-degraded` |
| current + record `degraded` | accepted revision + `degraded` | append row, increment degraded streak, reset fail streak | publish changed capability | serialized with simultaneous fail; later sequence wins | `store-degraded-ordering` |
| unseen + record `fail` | accepted revision + `fail` | create aggregate, fail streak 1 | apparatus projection becomes drift after write | duplicate fail does not double increment | `store-first-fail` |
| current + record `fail` | accepted revision + `fail` | append row, increment fail streak | publish drift | serialized across tabs; each unique observation increments once | `store-concurrent-fail-streak` |
| any + record `skip` | accepted revision + explicit reason | append bounded coverage row; authoritative streak unchanged | publish coverage only | duplicates deduped; cannot overtake authoritative status | `store-skip-preserves-streak` |
| any + record apparatus `incomplete` | provider caller continues; recorder returns incomplete revision | append apparatus row; anchor streak unchanged | in-memory and durable projection becomes incomplete | concurrent success cannot mask later incomplete without a new completed apparatus phase | `store-incomplete-precedence` |

#### Store lifecycle axis

| State + action | Caller observation | Durable change | Side effect | Race / duplicate behavior | Named test |
|---|---|---|---|---|---|
| missing file + `load` | empty state with `incomplete/no-observations` | none until first event | status exposes cold coverage | one shared load promise | `store-load-missing` |
| valid file + `load` | parsed clone at stored revision | none | status initialized once | concurrent readers share immutable clone | `store-load-valid` |
| corrupt/unknown-version file + `load` | typed incomplete result with reason | atomically rename to `.corrupt-<timestamp>`; start empty current state | one scrubbed error log/status update | one loader owns quarantine; followers see its result | `store-load-corrupt-quarantines` |
| idle + `record` | promise resolves only after atomic write | one revision with bounded ring | subscriber callback after rename | global serialized queue | `store-write-before-publish` |
| write in flight + second `record` | second promise waits | two ordered revisions, never a merged half-state | two ordered publications | dedupe by observation id before reducer | `store-serializes-tabs` |
| write failure + settle | provider action remains unchanged; recorder reports apparatus incomplete | old durable revision remains authoritative | in-memory incomplete + scrubbed log; no green publication | queued successors retry from last durable state | `store-write-failure-not-green` |
| new contract hash + first `record` | new revision reports cold/new-map coverage | current ring/streak namespace resets; prior snapshot moves to bounded prior-map slot | status announces map change | comparator is store sequence; stale-hash events reject | `store-map-hash-transition` |

Transition timing is synchronous for in-memory `incomplete` marking and event validation; durable publication is eventual only across the atomic write promise, during which the old durable revision remains visible. No UI receives a half-reduced state.

Production failure modes are deterministic in all environments: invalid map prevents ChatGPT profile activation and reports incomplete; invalid evaluator data reports incomplete and the existing operation error; invalid observation is rejected and reported incomplete; write failure preserves the old durable revision; unknown external status variant renders incompatible rather than healthy.

Omitted-state challenge:

- Process death between temp write and rename is covered by atomic rename; orphan temp files are ignored and may be cleaned on load.
- System clock regression is excluded from ordering because store-assigned sequence, not timestamps, is authoritative.

STPA pass: absent observation cannot become success; observation cannot be provided for a non-ChatGPT vendor; late terminal events cannot reopen a newer attempt; observation cannot outlive its contract hash; stopping an operation early emits incomplete/failed terminal evidence rather than a semantic pass.

## Implementation Units

### U1. Compatibility domain and checked-in map authority

- **Goal:** Introduce the versioned ChatGPT contract, closed vocabularies, map hash, parsers, semantic primitive ids, and explicit dependency/exemption census.
- **Requirements:** R1, R5, R8
- **Dependencies:** None
- **Files:**
  - Create: `chatgpt-compatibility.json`
  - Create: `chatgpt-compatibility.mjs`
  - Create: `tests/chatgpt-compatibility-map.contract.test.mjs`
  - Create: `tests/fixtures/chatgpt-compatibility/current.json`
- **Approach:** Use runtime-validated JSON plus frozen ES-module literals; do not introduce a TypeScript build. Registry branches are individually ordered, never comma-joined for priority. Pre/postcondition ids must resolve to registered semantic primitives.
- **Patterns to follow:** `run-lifecycle.mjs:1-67` for closed vocabularies and throwing normalizers; `chatgpt-ui-primitives.mjs:3-43` for frozen metadata and shared Node/browser semantics.
- **Test scenarios:**
  - *Happy path:* current map -> parse/freeze/hash -> stable profile with unique capability and branch ids.
  - *Edge cases:* optional capability and explicit exemption -> represented without weakening required coverage.
  - *Error path:* unknown version/status/primitive, duplicate ids, legacy-before-canonical, comma-joined registry branch, or missing dependency -> typed rejection.
  - *Integration:* every declared selector/semantic dependency is anchored or explicitly exempt; map mutation changes the hash.
- **Verification:** One parsed authority can enumerate every declared ChatGPT capability, dependency, branch provenance, and exemption; no consumer needs to restate the vocabulary.

### U2. Provider-aware controller bridge and legacy projection

- **Goal:** Carry vendor identity through `TabManager` into controller construction, activate the structured profile only for ChatGPT, and preserve current flat overrides/non-ChatGPT behavior.
- **Requirements:** R2, R3, R9
- **Dependencies:** U1
- **Files:**
  - Modify: `tab-manager.mjs`
  - Modify: `main.mjs`
  - Modify: `chatgpt-compatibility.mjs`
  - Modify: `tests/tab-manager.test.mjs`
  - Create: `tests/chatgpt-provider-isolation.test.mjs`
- **Approach:** Make the actual factory signature vendor-aware. The legacy adapter retains raw selector semantics and emits no ChatGPT observations. Existing flat ChatGPT overrides become visible legacy-source branches and therefore degraded when selected.
- **Patterns to follow:** `tab-manager.mjs:36-131` factory/lifecycle ownership; `main.mjs:59-74` known-key override loading; ADR 0001 for authoritative model plus compatibility projection.
- **Test scenarios:**
  - *Happy path:* ChatGPT tab -> structured profile; each other vendor -> legacy adapter and unchanged controller codomain.
  - *Edge cases:* missing/unknown vendor -> legacy adapter with no ChatGPT persistence; valid flat override -> highest-priority legacy-source branch.
  - *Error path:* malformed override remains explicit apparatus/config error for ChatGPT instead of silently certifying the canonical map.
  - *Integration:* create one tab per `vendors.json` entry and prove only ChatGPT can reach the observation sink.
- **Verification:** Vendor metadata survives the factory byte-for-byte, tab lifecycle is unchanged, and non-ChatGPT actions cannot update ChatGPT health.

### U3. Ordered evaluator compiler and untrusted-result decoder

- **Goal:** Resolve canonical/legacy branches in authority order through the existing string evaluator and return parsed branch/postcondition evidence identically across Electron and Chrome CDP.
- **Requirements:** R3, R5, R8
- **Dependencies:** U1, U2
- **Files:**
  - Create: `chatgpt-compatibility-resolver.mjs`
  - Modify: `chatgpt-ui-primitives.mjs`
  - Modify: `chrome-cdp-backend.mjs`
  - Test: `tests/chatgpt-compatibility-resolver.fixture.test.mjs`
  - Test: `tests/chatgpt-compatibility-eval-boundary.test.mjs`
  - Test: `tests/chatgpt-compatibility-backend-parity.test.mjs`
  - Modify: `tests/chrome-cdp-backend.test.mjs`
  - Modify: `tests/electron-browser-backend.test.mjs`
- **Approach:** Compile one injected evaluator envelope using the same pure-function/source-generation pattern as UI primitives. Decode `unknown`, including CDP `exceptionDetails`, before consumers see it. Return sanitized descriptors and selector hashes, never DOM nodes or text.
- **Patterns to follow:** `chatgpt-ui-primitives.mjs:395-459`; `electron-browser-backend.mjs:89-148`; `chrome-cdp-backend.mjs:356-438`.
- **Test scenarios:**
  - *Happy path:* canonical fixture -> canonical id and semantic value; canonical absent + legacy present -> legacy id.
  - *Edge cases:* ambiguous nodes preserve branch priority; hidden/wrong-surface nodes fail semantic postcondition.
  - *Error path:* invalid selector, thrown evaluator, malformed/unserializable payload, missing fields, CDP exception details -> apparatus incomplete.
  - *Integration:* identical raw result through both backend adapters -> identical domain result; actually execute generated evaluator source against sanitized fixtures rather than regex-inspecting it.
- **Verification:** Browser transport differences end at one parser, branch authority is observable, and malformed evidence cannot collapse into node absence or green status.

### U4. Privacy boundary, health reducer, and bounded compatibility store

- **Goal:** Persist typed observations, coverage, streaks, and the current health projection without leaking user content or letting concurrent tabs corrupt state.
- **Requirements:** R5, R6, R8
- **Dependencies:** U1
- **Files:**
  - Create: `chatgpt-capability-health.mjs`
  - Create: `chatgpt-compatibility-redaction.mjs`
  - Create: `compatibility-store.mjs`
  - Test: `tests/chatgpt-compatibility-health.test.mjs`
  - Test: `tests/chatgpt-compatibility-scrub.test.mjs`
  - Test: `tests/compatibility-store.test.mjs`
- **Approach:** Store one versioned, mode-`0600`, atomic `state.json` with a bounded recent-observation ring, current-map aggregates, bounded prior-map summary, and store-assigned sequence. Validate/allowlist before persistence; do not reuse arbitrary run progress or artifact metadata.
- **Patterns to follow:** `run-store.mjs:180-272` serialized write-before-publish; `fs-utils.mjs:5-15` atomic rename; `state.mjs:104-156` private file modes.
- **Test scenarios:**
  - *Happy path:* canonical/legacy/fail observations reduce to correct status, coverage, and streaks; restart round-trips exactly.
  - *Edge cases:* skip/incomplete preserve streak; map change creates cold coverage; ring cap and prior-map cap remain fixed.
  - *Error path:* nested privacy canaries reject; corrupt/unknown-version disk state quarantines; write failure preserves old revision and reports incomplete.
  - *Integration:* concurrent events from multiple tabs serialize, dedupe, publish after durable write, and never expose a half-state.
- **Verification:** Every state-action cell and named invariant above is locked; compatibility telemetry failure cannot fail user work or report health.

### U5. Production capability migration and passive mechanism census

- **Goal:** Route existing ChatGPT readiness, composer, submit, attachment, mode/model, response, research, image, and file paths through the shared contract and emit passive mechanism/capability observations at existing postconditions.
- **Requirements:** R1, R3, R4, R8, R9
- **Dependencies:** U2, U3, U4
- **Files:**
  - Modify: `chatgpt-controller.mjs`
  - Modify: `chatgpt-ui-primitives.mjs`
  - Modify: `tests/chatgpt-controller.test.mjs`
  - Create: `tests/chatgpt-compatibility-policy.test.mjs`
  - Modify: `tests/chatgpt-compatibility-map.contract.test.mjs`
- **Approach:** Use `runCapability`/`evaluateAnchor` to make parsing and exactly-once observation automatic. Migrate by capability family and require every remaining DOM selector or semantic dependency to be mapped or named as an exemption. Do not add another `runExclusive` layer; preserve existing lock ownership while instrumenting inside operations.
- **Patterns to follow:** composer readiness `chatgpt-controller.mjs:1843-1915`; send acknowledgment `1929-2519`; attachment acceptance `2689-2862`; stable response `2865-3105`; model/mode provenance `124-185`; challenge stop `1579-1744`.
- **Test scenarios:**
  - *Happy path:* each capability uses a canonical branch and emits one resolution plus one successful postcondition observation without changing returned values.
  - *Edge cases:* legacy/override branch succeeds -> action succeeds and health degrades; unexercised research/image capability remains skip/unobserved.
  - *Error path:* node match with failed behavior -> fail; login/CAPTCHA/browser/parser failure -> incomplete and existing challenge/error propagation.
  - *Integration:* instrumented versus baseline fake page traces have identical provider-visible actions; non-ChatGPT legacy path remains behaviorally identical.
- **Verification:** Runtime and health share one resolver for every mapped capability, controller literals are zero or explicitly exempt, and passive mode adds no provider action.

### U6. Attempt context and authoritative terminal-outcome bridge

- **Goal:** Correlate controller evidence with the correct HTTP/service terminal source without persisting run ids or weakening receipt-backed success.
- **Requirements:** R4, R5, R6, R8
- **Dependencies:** U4, U5
- **Files:**
  - Modify: `http-api.mjs`
  - Modify: `chatgpt-controller.mjs`
  - Modify: `mcp-server.mjs`
  - Create: `tests/chatgpt-compatibility-terminal.integration.test.mjs`
  - Modify: `tests/http-api.test.mjs`
- **Approach:** Create an ephemeral attempt context at the service boundary, pass it into the existing controller operation, and emit a typed terminal observation only from the operation's authoritative finalizer. Keep `RunStore`, receipts, active-query patches, and run wait semantics unchanged.
- **Patterns to follow:** receipt creation `http-api.mjs:1615-1633`; query finalization `3116+`; research finalization `1636+`; send dispatch `3199+`; `run-lifecycle.mjs:29-67`.
- **Test scenarios:**
  - *Happy path:* query/research produce receipt-backed terminal observation; send produces dispatch; image saves produce artifact-backed terminal evidence.
  - *Edge cases:* controller mechanism succeeds but artifact write fails -> terminal failed/incomplete, never capability healthy at durable boundary.
  - *Error path:* timeout/stop/challenge/rate limit is classified without inventing UI drift; late terminal event with stale attempt/hash is rejected.
  - *Integration:* `/runs/wait` and MCP still require valid completion receipts and return unchanged operation payloads.
- **Verification:** Each row in the terminal-source matrix has one explicit mode and source; compatibility cannot mark a run successful or reopen a terminal run.

### U7. One authenticated status projection across HTTP, MCP, IPC, and UI

- **Goal:** Make compatibility health easy to inspect everywhere Agentify already exposes status, while preserving unknown/incomplete semantics and the public-health privacy boundary.
- **Requirements:** R5, R7, R8
- **Dependencies:** U4, U6
- **Files:**
  - Modify: `main.mjs`
  - Modify: `http-api.mjs`
  - Modify: `mcp-server.mjs`
  - Modify: `ui/control-center.js`
  - Modify: `ui/control-center.html`
  - Modify: `ui/control-center.css`
  - Modify: `ui/preload.mjs`
  - Modify: `ui/preload.cjs`
  - Create: `tests/chatgpt-compatibility-status.integration.test.mjs`
  - Modify: `tests/preload-bridge.test.mjs`
  - Modify: `tests/preload-surface.test.mjs`
- **Approach:** Extend existing status/state responses rather than add an MCP tool. One serializer supplies schema version, contract hash, observed-cohort verdict, apparatus state, coverage/staleness, and per-capability summary. The renderer must say "observed healthy/degraded," not "latest."
- **Patterns to follow:** authenticated `/status` `http-api.mjs:2483-2499`; MCP forwarding `mcp-server.mjs:314-335`; state IPC `main.mjs:326-337`; Control Center refresh `ui/control-center.js:217+`.
- **Test scenarios:**
  - *Happy path:* one stored summary round-trips main -> HTTP -> MCP and main -> IPC -> renderer with equal schema/hash/verdict.
  - *Edge cases:* cold/unobserved, stale map, degraded override, and partial capability coverage remain visibly distinct.
  - *Error path:* unknown status variant or projection parser failure renders incompatible/incomplete; public `/health` contains no compatibility detail.
  - *Integration:* CJS/ESM preload methods, channels, defaults, and payload behavior are equivalent.
- **Verification:** Every status consumer derives from one serializer, retains incomplete and coverage, and exposes no private evidence.

### U8. Discriminative acceptance harness and operator contract

- **Goal:** Close false-green zones, document the map-maintenance/restart workflow and safety boundary, and encode the architecture decision as an ADR.
- **Requirements:** R8, R9
- **Dependencies:** U1-U7
- **Files:**
  - Modify: `README.md`
  - Create: `docs/adr/0004-use-passive-chatgpt-compatibility-observation.md`
  - Create: `tests/fixtures/chatgpt-compatibility/legacy.json`
  - Create: `tests/fixtures/chatgpt-compatibility/absent.json`
  - Create: `tests/fixtures/chatgpt-compatibility/malformed.json`
  - Modify: `tests/chatgpt-compatibility-map.contract.test.mjs`
  - Modify: `tests/chatgpt-compatibility-policy.test.mjs`
- **Approach:** Freeze mutation sentinels for canonical removal, wrong-node matches, malformed apparatus, privacy canaries, and provider leakage. Document manual registry edit -> fixture proof -> desktop/MCP restart -> ordinary authorized-use observation. Do not add live canary or repair code.
- **Patterns to follow:** ADR 0002 for durable authority and cross-surface consequences; `README.md:608-612` for the current operator selector workflow, replaced with an honest structured-map workflow.
- **Test scenarios:**
  - *Happy path:* clean suite proves the full acceptance inventory in one repo state.
  - *Edge cases:* map version change and stale override require restart and appear degraded/unobserved until new evidence.
  - *Error path:* mutation sentinels each make their owning verifier fail; terms/safety copy cannot claim ban immunity or global-latest coverage.
  - *Integration:* `npm test` executes every compatibility test plus existing multi-vendor, HTTP, MCP, preload, lifecycle, and store regression guards.
- **Verification:** A clean checkout can run one final verifier and distinguish every known wrong state; operator docs state exactly what is observed, what is unknown, and what is deferred.

## Scope Boundaries

- V1 is ChatGPT-specific compatibility observation; it does not create a generic provider-plugin architecture.
- No scheduled/background prompt, navigation, export, or account action.
- No active canary, dedicated canary account/profile, screenshot capture bridge, or background scheduler.
- No anti-detection expansion, account rotation, challenge bypass, CAPTCHA solving, retry-around-challenge, or claim that a profile is ban-safe.
- No LLM selector generation, automated registry patch, automatic PR, or automatic merge.
- No public `/health` detail and no persistence of raw DOM, screenshots, URLs, content, filenames, tokens, or account identifiers.
- No replacement of run lifecycle, receipts, artifact authority, governor, or current user-operation semantics.
- No wholesale removal of `selectors.json`; it remains the legacy/non-ChatGPT view during migration.
- No unrelated cleanup of duplicated blocked labels, pacing defaults, or unused `config.mjs` unless a touched contract cannot remain correct without it.

### Deferred to Follow-Up Work

- **Authorized active canary:** Separate decision/ADR after explicit account/profile authorization, legal/policy review, governor integration, fixed action budget, challenge fail-stop, and isolated environment.
- **Guarded registry repair:** Separate work only after passive evidence is trustworthy; candidates bind to map hash, patch the actual registry, fail loudly when unpatchable, pass fixtures, require explicitly authorized live postcondition, and remain human-reviewed.
- **Private visual evidence:** Add a cross-backend screenshot contract only if sanitized descriptors prove insufficient; raw evidence remains local and opt-in.
- **Multi-provider compatibility profiles:** Generalize only after ChatGPT's profile proves the seam without regressing the legacy adapter.
- **Existing fingerprint-reduction review:** Independently review `AutomationControlled`/`navigator.webdriver` behavior; this plan neither relies on nor extends it.
- **Lock-ownership cleanup:** Normalize nested `runExclusive` ownership in a focused refactor if U5/U6 cannot instrument safely without it.

## System-Wide Impact

- **Interaction graph:** `main.mjs` loads contract/store -> `TabManager` carries vendor -> controller profile resolves and observes -> HTTP finalizer adds terminal truth -> compatibility store reduces -> main/HTTP/MCP/IPC/UI render one summary.
- **Error propagation:** Map/eval/decode failures stop or fail the affected ChatGPT operation through existing paths and mark apparatus incomplete. Persistence/projection telemetry failures do not change provider operation results, but synchronously remove the green claim. Challenge/login remains a human stop, not drift.
- **State lifecycle risks:** Multiple tabs emit concurrently; a global serialized queue and write-before-publish revision prevent lost updates. Corrupt or wrong-version state is quarantined visibly. Map changes start a fresh current-map namespace. Ring and prior-map summaries are bounded.
- **API surface parity:** HTTP, MCP, IPC, ESM preload, CJS preload, and renderer must preserve schema/version/unknown semantics. Public `/health` remains shallow. Existing tool count/profile stays unchanged.
- **Integration coverage:** Real generated evaluator execution, both backend decoders, controller postconditions, HTTP receipts/artifacts, provider matrix, persistence restart/corruption, and both status paths require cross-layer tests; script-string mocks alone are insufficient.
- **Unchanged invariants:** Loopback/auth boundaries, vendor tab lifecycle, current query/send/research/image result shapes, provider governor, challenge handling, run statuses, receipt-backed completion, artifact registration, and non-ChatGPT selector behavior remain authoritative.
- **Deployment/reload:** Checked-in map and main/controller code are loaded by long-lived Electron; MCP is a separate long-lived process. Operator docs and tests must require restarting both after contract/schema changes.
- **Dependency footprint:** No new npm dependency is required; use built-in Node JSON/crypto/fs and the existing browser evaluator.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Passive evidence is mistaken for a globally latest UI map | Status always includes observed cohort, coverage, capture/map hash, and staleness; unobserved is never green. |
| Instrumentation diverges from runtime | The production resolver emits evidence; parallel scanner is forbidden; map coverage test rejects unanchored literals/dependencies. |
| Multi-vendor regression | Explicit vendor factory bridge, legacy adapter, provider matrix, and no ChatGPT observation for other vendors. |
| Matching the wrong element produces false green | Behavioral pre/postconditions and wrong-node mutation fixtures; unique match is insufficient. |
| Eval/backend failure is classified as drift or success | Parse unknown values, handle CDP exception details, and give apparatus incomplete highest priority. |
| User content leaks into durable state/status | Allowlist construction before persistence plus recursive nested canary tests; no raw evidence in V1. |
| Store failure silently drops telemetry | Write-before-publish, in-memory incomplete on failure, old durable revision preserved, visible status. |
| Controller migration becomes an unbounded rewrite | Capability-by-capability census, explicit exemption ledger, legacy adapter, and frozen U/AC inventory. |
| Existing lock mismatch deadlocks instrumentation | Do not add `runExclusive`; pass attempt context inside existing operation. Split lock cleanup if necessary. |
| Active probing creates account/policy risk | No active probe in V1. Future facility requires separate explicit authority and cannot claim safety. |
| Existing anti-detection code contaminates the safety claim | Architecture disclaims it, adds nothing similar, and defers independent review. |
| Fixtures become another stale truth | Fixtures prove resolver semantics, not current production; passive observed evidence carries contract hash/capture/staleness. |
| Schema becomes irreversible too early | Version every persisted/wire record, reject unknown variants, retain bounded prior-map summary, and lock round trips. |

## Disconfirming Evidence

The architecture is rejected or revised if any of these probes fails:

| Claim | Falsifier | Test / probe gate |
|---|---|---|
| Runtime and health share one truth | A mapped controller selector/dependency bypasses the registry | map coverage/exemption contract test |
| Legacy fallback is visible | Removing canonical fixture still reports `ok` | canonical-removal mutation -> resolver/health tests must report degraded |
| Node match is not capability success | Wrong-node fixture passes | postcondition mutation sentinel must fail |
| Apparatus failure cannot be green | Malformed/CDP/store failure renders `ok` | eval-boundary, store-failure, cold-status tests |
| Passive mode adds no external action | Instrumented trace has extra navigate/input/click/submit/retry/request | passivity comparison test; any delta kills V1 release |
| ChatGPT evidence is provider-isolated | Any other vendor changes ChatGPT state | provider matrix test |
| Durable query/research health means durable completion | Controller success without a receipt reports terminal success | terminal integration mutation test |
| Privacy boundary is structural | Any nested canary reaches disk, HTTP, MCP, IPC, or renderer | scrub + status integration tests |
| Evidence ordering is deterministic | Concurrent duplicate/out-of-order callbacks change streak twice or publish half-state | serialized store race tests |
| Passive apparatus catches exercised drift | Two exercised real breakages lack a same/earlier signal | 30-operation/30-day cohort probe; redesign resolver/postcondition |

No live ChatGPT action is required to accept the implementation. A later explicitly authorized manual observation may increase confidence, but it is not allowed to weaken deterministic fixture/integration proof.

## Bug-Trace / Confidence Cross-Check

| Bug / requirement | Contract clause or matrix cell | Planned behavior | Expected behavior | Match? |
|---|---|---|---|---|
| Repeated reactive selector fixes after user-visible failures | R1/R3; U1/U5; drift lead-time probe | Production resolution emits branch and postcondition evidence | Learn at the exercised failure boundary, not only after a support incident | yes |
| "How do we know our UI understanding is up to date?" | observed-cohort status + coverage/staleness | Report what this profile exercised under this map hash, and what remains unknown | Honest local knowledge, no global-latest fiction | yes |
| "How do we probe without getting banned?" | R9; passive-action invariant | Add no provider-visible action and make no ban guarantee | Minimize added risk; do not offer evasion | yes |
| Designer auto-heal can patch zero real anchors | deferred repair + registry-only future rule | No auto-repair in V1; future patch targets actual registry and fails loudly | No repair theater | yes |
| Caught challenge/eval error can become `ok: true`, `promptVisible: false` | U3/U4; incomplete precedence | Parse failures and missing apparatus become incomplete | No false green | yes |
| One ChatGPTController serves six vendors | U2 provider bridge | Only ChatGPT receives the structured profile; legacy behavior preserved | No cross-provider drift attribution/regression | yes |
| Controller tests inspect JavaScript substrings | U3/U8 fixture execution | Execute generated resolver against sanitized fixtures and mutation sentinels | Proof at consumer boundary | yes |
| Query DOM stability differs from receipt-backed completion | terminal-source matrix; U6 | Terminal observation comes from the correct finalizer | Compatibility does not weaken run truth | yes |
| Debug payloads contain URLs/text/filenames | privacy invariant; U4 | Allowlist at collection/persistence boundary | No content leak | yes |
| Compatibility state can race across tabs | store lifecycle matrix | One serialized queue, monotonic revision, dedupe | No lost/double updates | yes |

Confidence is high in the architectural seam because three independent local audits converged on it and it follows existing project patterns. Confidence is deliberately lower about current ChatGPT branch contents and future drift lead time; those are empirical properties, exposed as coverage/probe gates rather than asserted.

## High-Risk Self-Review

- [x] Decision rationale and rejected credible alternative are explicit.
- [x] Data flow is traced from map load through browser evaluation, controller postcondition, HTTP terminal source, persistence, and every status consumer.
- [x] Cross-layer integration scenarios are named.
- [x] Existing run, receipt, vendor, auth, governor, and result invariants are stated as unchanged.
- [x] External UI, policy, browser, parser, disk, and renderer failure modes are enumerated.
- [x] Files-to-touch come from local code inspection and three architecture lanes.
- [x] The actual controller-factory signature mismatch is a named bridge unit.
- [x] Observation and terminal taxonomies are first-class closed unions.
- [x] Equality/ordering uses store-assigned sequence; timestamps are evidence only.
- [x] Persistent state has explicit action/state cells, invariants, races, and named tests.
- [x] Privacy, passivity, ordering, retention, and honesty are discharged as mechanism invariants or falsifiable probes.
- [x] The registry, observation, persisted state, and status representations each have one authority plus parser/parity guards.
- [x] Active canary and automated repair authority are not smuggled into implementation scope.
