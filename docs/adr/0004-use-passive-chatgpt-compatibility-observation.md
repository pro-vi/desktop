# ADR 0004: Use Passive ChatGPT Compatibility Observation

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Agentify Desktop maintainers and architecture/build session

## Context

Agentify depends on a changing ChatGPT web UI. A selector file alone could not say which branch production actually exercised, whether the user-visible capability completed, how much of the local rollout cohort remained unknown, or whether the measuring apparatus itself failed. A parallel scanner or scheduled canary would exercise a different path, add account actions, and risk bypassing the existing governor.

Current OpenAI Terms of Use prohibit automatically or programmatically extracting data or output and prohibit circumventing restrictions, rate limits, protective measures, or safety mitigations. The terms also allow suspension or termination for breaches or risky use. Compatibility instrumentation therefore cannot be presented as an account-safety or compliance mechanism.

## Decision

Use one checked-in, versioned `chatgpt-compatibility.json` contract and one ordered production resolver. Observe compatibility only inside ordinary user-requested ChatGPT operations. Persist a bounded, recursively scrubbed event union and report only this installation's observed cohort, coverage, staleness, apparatus verdict, and per-capability summary.

Keep mechanism evidence separate from terminal authority. Dispatch acknowledgement and operation predicates may terminate at the controller boundary. Query and research require their service-owned completion receipt; images require registered saved artifacts. Missing or malformed evidence stays incomplete, and a new map starts unobserved.

Project the same closed status schema through authenticated `/status`, `agentify_status`, IPC state, both preload mirrors, and the Control Center. Keep public `/health` shallow. Unknown wire variants render incompatible rather than green.

Do not add an Active canary, background scanner, automatic selector generation, automatic repair/promotion, challenge retry, account rotation, or protective-measure bypass. Contract maintenance remains a manual edit, fixture proof, test run, desktop/MCP restart, and later observation from an operation the user already intended.

## Consequences

Positive:

- Runtime action and compatibility evidence share one ordered resolver.
- Drift claims are limited to exercised capabilities and the observed cohort.
- Receipt/artifact truth, provider isolation, privacy, and the existing governor remain authoritative.
- Cold, degraded, drift, stale, incomplete, and incompatible states stay visible across every status surface.

Negative:

- Passive coverage cannot establish the globally latest ChatGPT UI or predict an unseen rollout.
- Unexercised capabilities remain unknown, possibly for long periods.
- Operators must restart both long-lived processes after contract or schema changes.
- The design does not guarantee compliance, ban immunity, uninterrupted access, or account safety.

## Revisit Triggers

- OpenAI provides a supported interface for the required consumer-account operations.
- Current terms, usage policies, or product constraints materially change.
- Exercised user-reported breakages repeatedly lack a same-or-earlier compatibility signal.
- A future active probe receives explicit product and account-risk authorization.

## References

- `chatgpt-compatibility.json`
- `chatgpt-compatibility.mjs`
- `compatibility-store.mjs`
- `docs/adr/0002-use-service-owned-runs-and-receipt-backed-completion.md`
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/), effective January 1, 2026
- [OpenAI account deactivation guidance](https://help.openai.com/en/articles/10562188)
