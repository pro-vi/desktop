# Turn-Identity Gate Live Probe

- **Date:** 2026-09-17 (02:46–02:52 PDT)
- **Status:** Fix verified live on the race-critical path; run 1 reproduces the known cold-start residual (out of scope)
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session, project-routed conversation
- **Build:** `32b9241` (turn-identity gate in `chatgpt-controller.mjs`)
- **Plan:** `docs/plans/2026-09-17-001-fix-turn-identity-capture-race-plan.md` (U3, consented)

## Question

Does the wait loop now capture the answer to the prompt sent — never the previous turn's reply — on the same project-routed setup where the 2026-09-14 probe captured `'4'`/`'6'` for "3+3?"/"5+5?" (3/3 reproduction)?

## Procedure

1. App was running pre-fix code; killed by PID and respawned through `ensureDesktopRunning` at `32b9241` (fresh instance confirmed by new `serverId`, port 60038).
2. Two short real queries under the disposable key `probe-turn-identity-2026-09-17` ("3+3? / 5+5? Answer with the number only."), same tab, second query issued with the first reply mounted and stable — the exact race setup.
3. Read each run's result, run record, and receipt; hashed the written artifact; closed the tab.

## Observations

Run 1 `3a128d00-1b49-4445-871b-9c3dd3ebd555` (cold app):

- Captured node text is page chrome — prompt echo, `Worked for 9s`, footer, `6`, `Pro` — the known cold-start/first-capture residual (CLAUDE.md), **not turn identity**. The answer `6` is present in the capture; provider id `f1807071-2779-47ad-a87a-b43727eb8a2c`; evidence `assistant-node`.
- This run served as warm-up and seeded the conversation history for the race-critical run.

Run 2 `cfd845f4-ef90-46e7-b1af-ab24221e79be` (warm, previous reply `'6'` mounted and stable):

- **Captured text: `'10'`** — the current prompt's answer. On pre-fix code this exact setup captured `'6'` (2026-09-14 probe, run 3).
- Completing provider id `98d4f95f-6993-4925-9a19-d3b013f24645` **differs** from the pre-send tail id `f1807071-…` — the gate's live proof, visible in `meta.providerMessageId` (R3/R4: the identity basis is observable in the run record).
- Evidence `assistant-node`; run status `success`; receipt kind `assistant-response`, `responseSha256` = sha256 of the artifact bytes, and the artifact at `~/.agentify-desktop/artifacts/runs/probe-turn-identity-2026-09-17-cfd845f4-…/assistant_response.md` is exactly `10\n` (3 bytes) — the receipt backs precisely the correct answer's bytes.
- Disposable tab closed after the probe.

## Verdict

- The turn-identity race is closed live: the completing node is a node that did not exist at send time, and its capture is the current prompt's answer with a receipt over those bytes.
- Run 1 reconfirms the separate cold-start capture residual remains open (readiness, not turn identity) — unchanged by this fix and out of its scope.
- Deterministic coverage: `tests/chatgpt-controller.test.mjs` oracle pair (witnessed red on pre-fix HEAD, green at `32b9241`) plus the non-firing-table tests; full suite 870/870.

Probe artifacts: runs `3a128d00-…`, `cfd845f4-…` in `~/.agentify-desktop/runs/`; artifact above.
