# ADR 0005: Pin Only the ChatGPT Intelligence Axis

- **Status:** Accepted
- **Date:** 2026-08-03
- **Deciders:** Agentify Desktop maintainers and the 2026-08-03 triage session

## Context

ChatGPT's selector has two independent axes. Intelligence offers Instant, Medium, High, Extra High, and Pro. Generation, in a submenu, offers GPT-5.6 Sol, GPT-5.5, GPT-5.3, and o3. Pro is an intelligence level, not a generation, and a selection is one choice on each axis.

Agentify models both as a single token. `CHATGPT_MODEL_INTENTS` accepts only `gpt-5.5-pro` and `gpt-5.4-pro`, whose `-pro` suffix is a fossil of an earlier UI that welded Pro onto the generation name. GPT-5.4 is no longer in the picker at all, so neither accepted value names anything a user can now select.

`modeIntent` still works. The `mode-model` capability reports `degraded` with reason code `legacy-branch` and a degraded streak of 12 against a failure streak of 0, which by the classification at `chatgpt-controller.mjs:525` means the postcondition passed while the selector resolved through a fallback branch. Pro is therefore still being selected and verified.

The generation axis is only needed to deliberately run an *older* generation. The picker already defaults to the newest one, and `/second-opinion`, the main consumer of this transport, never passes `modelIntent`. Mirroring the submenu would mean tracking labels, traversal, and metadata for a UI that reshuffles, in exchange for a capability that is two clicks away by hand.

`modelIntent` was also unsafe rather than merely stale. `#applyModelIntentImpl` returned `{ active: true }` both when no generation was requested and when one was requested under a name that does not normalize — which is every current label. The caller reads that result only to build provenance and never gates the send on it, so a query went out on whatever generation the tab already had while emitting a `model_intent_confirmed` event, and the `result.active === true` postcondition agreed.

## Decision

Do not track or mirror the generation axis.

Pin only the intelligence axis, through `modeIntent`. Where a specific generation matters, select it by hand in the picker and leave `modelIntent` unset.

Keep `modelIntent` narrow and make it fail closed. A supplied intent that cannot be honored throws `model_intent_unsupported` before the composer is touched, carrying the raw request and the supported list, rather than reporting a pin that never happened (commit `b371f85`). Requesting nothing still activates nothing and says so.

## Consequences

Positive:

- No fragile mirror of a reshuffling provider UI, and no metadata to re-derive each time the picker changes.
- A successful run is now evidence the requested pin was applied, so provenance and the `mode-model` postcondition stop agreeing with a false success.
- The capability actually depended on — Pro through `modeIntent` — stays covered and verified.

Negative:

- Callers cannot select a generation programmatically at all. A paired old-versus-new comparison must be driven by hand.
- The two accepted values are stale and will read as wrong to anyone comparing them against the live picker; the code names generations that no longer exist as such.
- Callers passing a current generation name now receive an error where they previously received a silent no-op. This is intended — those runs were never applying the pin — but it is a behavior change for any caller that was passing one without checking.

## Revisit Triggers

- `mode-model` stops resolving through the legacy branch and begins failing. `extended-pro` is the capability actually relied on, and losing it would justify the picker work this ADR declines.
- A real need appears to run an older generation unattended, such as a paired old-versus-new comparison or reproducing a past result.
- ChatGPT exposes a stable programmatic model selector, removing the need to mirror UI labels.

## References

- `chatgpt-mode-intent.mjs` — `CHATGPT_MODEL_INTENTS`, `normalizeChatGptModelIntent`
- `chatgpt-ui-primitives.mjs` — `CHATGPT_MODEL_INTENT_META`
- `chatgpt-controller.mjs` — `#applyModelIntentImpl`, and the capability status classification at line 525
- Commit `b371f85` — reject an unsupported model intent instead of reporting success
- `/agentify` skill release note v0.7.174 in `~/Development/_setup/bootstrap/CHANGELOG.md`
- `docs/adr/0004-use-passive-chatgpt-compatibility-observation.md`
