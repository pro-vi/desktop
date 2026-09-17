# Cold-Start Capture Probe

- **Date:** 2026-09-17 (late morning PDT)
- **Status:** Both cold-start shapes closed live on the first calls after spawn
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session, project-routed conversation
- **Build:** `0d80911` (role-qualified nodes U1 `29fcfdd`, first-message wait U2 `e73a5b0`, stop-visibility guard U3 `0d80911`)
- **Plan:** `docs/plans/2026-09-17-002-fix-cold-start-capture-residual-plan.md` (U4, consented)

## Question

Do the first read and the first query after a cold spawn capture real page state — the two conditions that produced the known failures (2026-08-03: `messageCount: 0` ~3s after tab creation; 2026-09-17 morning: chrome-polluted node text on the first query)?

## Procedure

1. Verified traffic quiet (last wait call 05:35), killed the app by PID, respawned via `ensureDesktopRunning` at `0d80911`.
2. Immediately (first call after respawn): `POST /read-conversation` with the turn-identity probe conversation's `chatUrl` (a `/g/` project conversation, 4 turns).
3. Immediately after: one numeric query (`7+3?`) on the disposable key `probe-coldstart-2026-09-17`.
4. Read the run record and artifact; closed the tab.

## Observations

- **Immediate cold read: `complete: true`, `messageCount: 4`, no capture reason** — the exact 2026-08-03 scenario (which returned `messageCount: 0`) now captures every message on the first call.
- **Immediate cold query: captured text exactly `'10'`, `nodeBasis: role-qualified`, provider id `9bb277bf-…`, evidence `assistant-node`** — under identical cold conditions the morning probe captured the whole-section chrome (prompt echo + timing + footer). Run `64c5e9a2-2358-424b-8152-3bdd2dd0ae8e`; artifact is `10\n` (3 bytes), receipt sha matches.
- Disposable tab closed after the probe.

## Verdict

- Both cold-start shapes are closed on the first post-spawn calls: the capture bundle waited for the first message (shape a), and the wait loop completed on the role-qualified node, never the hydrating container (shape b).
- Deterministic coverage: U1's oracle (witnessed red on pre-fix code capturing the probe's exact chrome text), U2's three first-message-wait scenarios, U3's stop-visibility oracle (which also exposed and fixed the fallback branch completing on stable text while a stop was visible).
- CLAUDE.md's cold-start warning updated to reflect what is now guaranteed.

Probe artifacts: run `64c5e9a2-…` and transcript artifact `~/.agentify-desktop/artifacts/default-…/conversation-transcript-9bf23cd5-….md`.
