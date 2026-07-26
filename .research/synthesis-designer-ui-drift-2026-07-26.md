---
topic: designer-frontend-compatibility-transfer
date: 2026-07-26
project: agentify-desktop
status: complete
designer_snapshot: 2371459db513437c2202f5771142b95f9e5b7367
evidence:
  local:
    - /Users/provi/Development/_projs/designer
    - /Users/provi/Development/_setup/agentify-desktop
  first_party:
    - https://openai.com/policies/terms-of-use/
    - https://openai.com/policies/services-agreement/
    - https://developers.openai.com/api/docs/guides/tools-computer-use
---

# Designer MCP's frontend-compatibility apparatus

Date: 2026-07-26  
Designer snapshot: `2371459db513437c2202f5771142b95f9e5b7367` (`main`)  
Compared project: Agentify Desktop

## Question

Why does Designer MCP tolerate `claude.ai/design` frontend drift better, and which parts should Agentify adopt for its more load-bearing ChatGPT adapter?

## Verdict

Designer treats the external frontend as an explicit compatibility contract with an evidence loop:

```text
typed selector contract
        | shared by
runtime resolver ---- executable semantic anchors
                          |
                    scheduled probe
                          |
          ok / degraded / drift / incomplete
                          |
              scrubbed artifact + streak
                          |
              diagnostic PR / guarded repair
```

Its advantage is not a secret selector technique. It makes uncertainty, fallback use, probe failure, and repair blindness observable. Agentify currently has substantial runtime heuristics, but not the equivalent declared map and proactive feedback loop.

The important correction is that Designer's current auto-heal *design* is careful, but its repair reach is zero: after selectors were centralized in `selectors.json`, the old patcher could no longer rewrite any real anchor. The current branch detects and fails loudly on that condition. The focused health-apparatus suite passes 53/53 and explicitly asserts that all current anchors are unpatchable.

## Mechanism map

| Designer concept | Function | Agentify analogue |
|---|---|---|
| `selectors.json` | Versioned canonical and legacy DOM contract | Frontend compatibility map |
| `UI_ANCHORS` | Named capabilities with executable invariants | Semantic capability landmarks |
| ordered resolver | Canonical-first action resolution | Stable ChatGPT adapter |
| `designer health` | Detect contract drift | Drift census/canary |
| health artifact + streak | Evidence and temporal memory | Compatibility telemetry |
| auto-heal PR | Guarded candidate updater | Proposed registry patch |

## What Designer did well

### 1. One shared contract, not scattered selector folklore

`selectors.ts` declares the registry to be the single source used by controller verbs, setup, and health anchors. It also forbids comma-joined canonical/legacy selectors for actions because CSS document order is not fallback priority (`/Users/provi/Development/_projs/designer/selectors.ts:6-20,92-108`).

The JSON records capture dates, live drift observations, why stable test IDs were chosen, and the canonical/legacy branch policy (`/Users/provi/Development/_projs/designer/selectors.json:2-8`). Selectors are grouped by semantic surface rather than held as one flat bag (`selectors.json:9-53`). A user override is deep-merged without forking the runtime (`selectors.ts:70-90`).

This enables a question Agentify cannot currently answer mechanically: “Which declared frontend dependency has no health probe?” Designer's contract tests require every selector to be anchored or explicitly exempt (`/Users/provi/Development/_projs/designer/tests/health-apparatus.contract.test.mjs:507-562`).

### 2. It maps capabilities, not merely DOM nodes

Each UI anchor has a stable id, category, required page state, description, and executable check (`/Users/provi/Development/_projs/designer/ui-anchors.ts:19-82`). The strongest checks assert outcomes:

- the composer accepts the intended input, not just that an input node exists (`ui-anchors.ts:418-460`);
- a chat-only turn reaches the observed finished/released/chat-open protocol state (`ui-anchors.ts:165-262`);
- the preview reader returns rendered OOPIF content instead of a bootstrap shell (`ui-anchors.ts:547-595`);
- the production file-panel path yields filenames (`ui-anchors.ts:735-825`);
- the actual export endpoint returns the expected response (`ui-anchors.ts:657-710`).

This is the core design principle: a selector match is evidence for a mechanism, while successful behavior is evidence for a capability.

### 3. Compatibility confidence is explicit and ordinal

Anchor state is one of `ok`, `degraded`, `fail`, or `skip`. `degraded` means the canonical route is gone but an ordered legacy branch still works; `skip` means the relevant state was not actually probed (`ui-anchors.ts:21-59,90-114`). Exhaustive predicates keep new states from silently falling through downstream decisions (`ui-anchors.ts:28-59`).

There is no general numeric runtime confidence score. Numeric confidence is used only for an LLM repair proposal. Operational confidence is stronger because it describes the evidence obtained.

### 4. The probe proves that the probe ran

The daily orchestrator navigates both home and a fixed session canary, runs state-specific anchors, and records phase tags (`/Users/provi/Development/_projs/designer/scripts/ci-health.ts:26-40,466-511`). It separates:

- `ok`: the compatibility checks ran and passed;
- `drift`: live UI capability checks failed;
- `incomplete`: the browser/tooling apparatus did not run reliably.

Every exit path must publish one of those verdicts (`ci-health.ts:137-206,611-639`). A dead CDP browser therefore cannot masquerade as a frontend redesign or a green probe (`ci-health.ts:427-458`). The current history shows why: a wrongly guessed CLI filename kept the doctor half of the apparatus from launching for about two months, while the old reporting shape hid that fact (`ci-health.ts:51-87`).

This self-suspicion is one of Designer's most mature ideas: the detector is also load-bearing and needs its own contract tests.

### 5. It has evidence and temporal memory

Each run writes a scrubbed artifact containing navigation, doctor state, per-anchor details, four-way counts, interstitial diagnosis, and failure snapshot metadata (`ci-health.ts:511-575`). Redaction is applied recursively at the serialization boundary so new fields cannot accidentally publish project URLs or home paths (`ci-health.ts:99-135,556-562`). Raw signed-in HTML and screenshots stay on the self-hosted runner for repair rather than entering the public artifact (`/Users/provi/Development/_projs/designer/scripts/auto-heal.ts:570-604`).

Failure streaks persist across daily runs. Failure in either phase wins; `ok` or `degraded` resets; `skip` does not alter the streak; removed anchors are pruned (`ci-health.ts:291-368`). This distinguishes a rollout/transient from a repeated break before involving auto-repair.

### 6. Repair promotion is guarded by positive evidence

The intended auto-heal path waits for two consecutive failures, cools down an anchor for seven days, works on one prioritized anchor, and bails on five or more simultaneous failures as likely wholesale redesign (`/Users/provi/Development/_projs/designer/scripts/auto-heal.ts:5-18,105-112`).

An LLM proposal must have confidence at least 0.7, use safe characters, avoid brittle structural selectors, differ from the current value, and match exactly one live element (`auto-heal.ts:684-837`). After patching, a full re-probe must contain the target anchor in a working state; missing artifacts, missing results, CDP failure, timeout, or a still-failing anchor causes a revert (`auto-heal.ts:839-973`). The resulting change is a human-review PR and is never auto-merged (`/Users/provi/Development/_projs/designer/.github/workflows/auto-heal.yml:3-19,144-181`).

The invariant is good: activity is not success; positive postcondition evidence is success.

## Disconfirming evidence and limits

### Auto-heal currently cannot patch the real registry

The patcher only recognizes inline `hasSelector(b, '<literal>')` anchors. Centralization changed those calls to `hasSelector(b, SEL.group.key)`, making every current real anchor unpatchable. The code documents nine days of falsely green no-op auto-heal before this was made loud (`auto-heal.ts:43-58`). Triage now emits structural blindness when work exists but nothing can express a patch (`auto-heal.ts:63-103`).

The current contract suite explicitly passes the test “today the real anchors are all unpatchable.” So Agentify should copy the guarded verification loop, but its repairer must modify the actual compatibility registry rather than probe source.

### The scheduled canary is active, not passive

The session phase enables a mutating chat-only canary (`ci-health.ts:483-506`; `ui-anchors.ts:228-258`). Some checks also open panels and make a bounded authenticated export request. Designer uses one dedicated Chrome profile and one persistent canary project. It does not establish that this posture is safe or permitted for ChatGPT.

Designer does not bypass Cloudflare; the controller waits briefly and then requires human intervention. It also does not implement account rotation, challenge evasion, rollout-cohort sampling, or a general request-budget model.

### It knows one observed cohort, not the globally latest frontend

The map says what one authenticated profile saw at a particular capture time. It cannot observe unassigned experiments, other locales, viewport variants, accounts, or future rollout cohorts. Daily probing reduces time-to-detection; it does not create global knowledge.

### Fail-closed behavior is capability-specific

Many controller actions have strong preconditions and postconditions, but a few reads intentionally degrade to empty data or tolerate imperfect completion. The architecture is disciplined, not uniformly fail-closed.

### Some probing remains stale or scattered

The manual `scripts/probe.ts` diagnostic still contains a few direct selectors instead of consuming the shared registry. This is a small but real counterexample to the “single source everywhere” claim.

## Comparison with Agentify today

Agentify's `selectors.json` is a flat collection of broad comma-OR selector families with no capture date, canonical/legacy distinction, or drift metadata (`/Users/provi/Development/_setup/agentify-desktop/selectors.json:1-21`). Its loader supports a shallow local override, which is useful operationally, but it does not report whether the override or an older branch won (`/Users/provi/Development/_setup/agentify-desktop/main.mjs:59-74`).

Agentify does have sophisticated semantic runtime heuristics for model and mode controls. It normalizes UI intent, rejects misleading labels, classifies picker state, and scores candidates by semantic evidence and composer proximity (`/Users/provi/Development/_setup/agentify-desktop/chatgpt-ui-primitives.mjs:45-105,112-211`). That is good adapter logic, but it is not an inspectable compatibility map or proactive drift signal.

The status endpoint currently reports browser/challenge state and prompt visibility, not capability-anchor health or which compatibility branches resolved (`main.mjs:660-674`). Controller tests mostly stub script-shape markers in `page.evaluate`, so they verify control flow but do not constitute a captured real-DOM compatibility corpus (`/Users/provi/Development/_setup/agentify-desktop/tests/chatgpt-controller.test.mjs:29-80`).

Git history shows the resulting feedback mode: repeated runtime failures are followed by targeted repairs to model selection, upload detection, stop controls, mode labels, sending, and attachment handling. Agentify learns, but predominantly after user-visible breakage.

## Recommended transfer

### Adopt directly

1. Create a typed ChatGPT compatibility registry grouped by capability and surface, with capture metadata.
2. Separate canonical selectors from ordered legacy branches; report legacy-only resolution as `degraded`.
3. Make the production resolver and health probes consume exactly the same registry and semantic primitives.
4. Define executable anchors for Agentify's load-bearing capabilities: prompt fill, submit acceptance, stream start, receipt-backed completion, attachment acceptance, model/mode confirmation, generated-image collection, and research export.
5. Keep anchor status (`ok/degraded/fail/skip`) separate from apparatus verdict (`ok/drift/incomplete`).
6. Persist sanitized per-capability evidence and streaks; alert on repeated failure and on a detector that did not actually execute.
7. Contract-test registry coverage so no selector or semantic dependency exists without an anchor or explicit exemption.

### Adapt for ChatGPT account risk

Begin with a passive census attached to ordinary user-initiated Agentify runs:

- record which canonical/legacy branches resolved;
- record stable, privacy-scrubbed DOM descriptors and postcondition outcomes;
- generate offline fixtures from explicitly sanitized evidence;
- aggregate drift by capability and observed rollout signature.

Treat any scheduled prompt-sending canary as a separate, explicitly authorized facility with a dedicated account/profile, low fixed cadence, strict action budget, immediate challenge stop, and no anti-detection behavior. A real Chrome profile can reduce technical friction; it does not make the automation authorized.

### Do not copy

- Do not equate “looks like a normal browser” with “won't be banned.”
- Do not auto-promote a selector because it uniquely matches one node.
- Do not patch the probe while leaving the runtime registry unchanged.
- Do not let missing evidence collapse into green.

## Proposed Agentify shape

```text
chatgpt-compatibility-map
  surfaces + rollout signature + capturedAt
  capabilities
    canonical evidence branches
    ordered legacy branches
    semantic postcondition

shared compatibility resolver
  -> ChatGPTController runtime actions
  -> passive census during user work
  -> authorized active canary (optional)

health evaluator
  anchor: ok | degraded | fail | skip
  apparatus: ok | drift | incomplete
  -> scrubbed artifact
  -> per-capability streak
  -> inbox/issue/diagnostic PR

candidate repair
  -> patch compatibility map
  -> validate fixture corpus
  -> authorized live re-probe
  -> human-reviewed PR only
```

## Bottom line

Designer is good because it closes the epistemic loop around an unstable dependency. Its most transferable contribution is not daily clicking or LLM selector generation; it is making the frontend contract declared, shared, executable, historized, and honest about unknown states. For Agentify, the safest first move is the same apparatus driven by passive evidence from normal user-initiated sessions, with active canaries kept optional and explicitly governed.
