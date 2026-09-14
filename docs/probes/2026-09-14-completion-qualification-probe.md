# Completion Qualification Live Probe

- **Date:** 2026-09-14
- **Status:** Qualification pipeline verified; new pre-existing defect found (capture-target fidelity)
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session
- **Build:** `fdce09e` (chatgpt-controller.mjs evidence qualification, http-api.mjs evidence gates, read-page provenance)

## Question

Does the build's completion-evidence pipeline qualify real ChatGPT output end-to-end — evidence source, artifact, receipt, run status — and does `/read-page` prove its target and reject contradictory selectors? Plan: `docs/plans/2026-09-14-001-fix-chatgpt-completion-provenance-plan.md`.

## Procedure

1. Confirmed no Electron instance was running (stale `state.json` from 2026-09-12); spawned the desktop app from the working tree at `fdce09e` exactly as `ensureDesktopRunning` does.
2. Sent three short real queries under the disposable key `probe-qualification-2026-09-14` ("What is 2+2? / 3+3? / 5+5? Answer with the number only."). The tab routed into the user's `agentify` GPT project (`/g/g-p-...-agentify/c/...`).
3. Read each run record (`/runs/get`) and the page (`/read-page`) after each reply.
4. Two-tab read-page probe: created a second keyed tab, read both by key, then issued a read with tab A's id plus tab B's key.

## Observations

Qualification pipeline — verified on all three runs:

- Every success carried controller completion evidence `assistant-node`, recorded in the run's `metadata.json` (`completionEvidence.source`).
- Receipts: kind `assistant-response`, sha256 over the written artifact, `status: success` only alongside them.
- Read-page provenance: key-only reads returned distinct `tabId`/`key`/`servedUrl` matching each tab's actual page; `servedUrl` equaled the run's conversation URL on the probe tab and `https://chatgpt.com/` on the fresh tab.
- Contradictory `tabId` A + `key` B returned HTTP 400 `selector_conflict` with `{tabId, key, tabKey}` and performed no navigation or read.

New defect (pre-existing, exposed by the probe, **not fixed here**) — the wait loop completes on the *previous* assistant reply:

- Run 1 (cold app): captured node text was page chrome — prompt echo, footer, `6`, `Pro` — with the actual answer `4` absent from the capture. Receipt-hashed artifact contained that chrome.
- Run 2 (warm): prompt "3+3?" → captured `'4'`, the previous reply. `count: 1` at capture.
- Run 3 (warm): prompt "5+5?" → captured `'6'`, again the previous reply. `count: 2` at capture.
- Mechanism: after send, the stop button marks `newResponseSeen`; the stop control disappears and the old node's text is stable, so the done condition (`stopGoneLongEnough` ≈ 800 ms + `stable` ≈ 1500 ms) fires before the new reply mounts (observed mount latency several seconds on this conversation). `assistantAdvanced`'s `txt !== preSendText` clause cannot guard this when the pre-send baseline differs from the settled old text (run 1's polluted capture) and `activeStop` alone establishes the new-response signal.
- Consequence: `status: success` with valid evidence and a receipt whose bytes are the previous turn's output. The evidence gate of plan 2026-09-14-001 cannot see this — structurally an assistant node existed and changed; the defect is turn identity, not finality.
- Likely fix direction (for its own plan): advance the wait's baseline by provider message id (the structured-recovery path already proves turns via `provider-tail` signatures), requiring the completing node's id to differ from the pre-send tail.

## Verdict

- R1/R2/R4 (qualification, receipt integrity) hold live on this build; the receipt's artifact-integrity role is unchanged.
- R5/R6 (read-page selector integrity, provenance) hold live.
- The `Pro thinking` transience claim remains deterministically tested but was not exercised live (probe scope chosen as normal queries; a live Extended Pro check would cost Pro quota and minutes).
- Capture-target fidelity on project-routed conversations is a separate open defect: file before trusting single-run captures on `/g/` routes.

Probe artifacts: runs `3e708212-6618-4764-bc86-ec8e4f7cc227`, `e5d730e0-f911-4e4e-8c69-3c8053a439d9`, `7eb75e8a-295c-4748-a5e3-73e0dcdee9e1` in `~/.agentify-desktop/runs/`; disposable tabs closed after the probe.
