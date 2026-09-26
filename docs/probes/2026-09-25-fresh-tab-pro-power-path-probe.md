# Fresh Tab Pro Power Path Probe

- **Date:** 2026-09-25 (evening PDT)
- **Status:** A fresh tab moved from Instant to Pro before send; the keyboard step moved the slider after the track click and the thumb drag did not. The run still failed after send on the separate, known reader defect
- **Surface:** ChatGPT web UI in Agentify Desktop's authenticated Electron session, `extended-pro` mode intent, new keyed tab
- **Build:** uncommitted working tree on `e5811cd` with the escalating power path, respawned via `agentify_shutdown` at 21:35 PDT with no run in flight
- **Consent:** the user approved this one probe: one `extended-pro` query on a new key, read the run record, record, close the tab

## Question

Runs `e28c5943-e2fa-424c-8649-a1071a8e7b27` and `9784c22e-89d7-470a-aedd-bb43f12b0ad5` failed before send with `clicked_mode_power (target=extended-pro; active=instant; Instant; menuOpen=true)`: on a new key the power slider stayed on Instant while the controller clicked the track at the Pro position for about 20 seconds. Queries into a conversation already on Pro were unaffected. Does the escalating power path (track click, then thumb drag, then keyboard, then fall back to the menu options) move a fresh tab to Pro?

## Procedure

1. Confirmed no run was in flight (no non-terminal run records), then ran `agentify_shutdown`; the next MCP call respawned Electron from the working tree.
2. `agentify_query` with key `probe-fresh-tab-pro-2026-09-25` (no prior tab), `modeIntent: extended-pro`, `fireAndForget: true`, prompt `Reply with the single word OK.`
3. Read `modeIntentProvenance` from the run record, waited for the run to finish, and closed the probe tab.

## Observations

- Run `508268fe-6c58-4b19-96cb-0c082972a597`, conversation `https://chatgpt.com/g/g-p-69c9d0b3c3b88191872d6b59cb5adfb8-agentify/c/6ab74ba5-7f90-83e8-9b1f-c471d3785ac3`.
- `modeIntentProvenance`: `confirmed: true`, `reason: mode_power_active`, `label: Pro`, `powerMin 0`, `powerMax 4`, `powerIndex 4`, `stage: before_send`.
- Attempts, in order:

| # | Time (UTC) | Action | Slider before the action |
|---|---|---|---|
| 1 | 04:35:44.980 | open the mode menu | – |
| 2 | 04:35:45.815 | click the track at the Pro position | Instant |
| 3 | 04:35:46.408 | drag the thumb to the Pro position | Instant |
| 4 | 04:35:47.131 | click the thumb, press `End` | Instant |

  Confirmation followed at 04:35:47.893, so the keyboard step moved the slider. The track click reproduced the original failure; the thumb drag did not help either.
- After send, the run failed at the hard deadline: "Response reconciliation timed out … page text changed after send from 6609 to 191 chars … (assistant nodes: 0)", `recovery.reason compatibility_drift`. The 6609 characters before send were the project landing page, not a conversation.
- `agentify_read_page` on the tab afterwards returned the whole conversation: "You said: Reply with the single word OK. / Worked for 8s / ChatGPT said: OK", with "Pro" in the page footer. ChatGPT answered in Pro in about 8 seconds; the reader did not recognise the turn. This is the known reader defect (BACKLOG lane "Migrate the conversation reader to the data-turn-key DOM"), not a mode-path failure.
- The probe tab was closed afterwards.

## Verdict

- The defect reproduces on a fresh tab: a track click does not move the slider off Instant.
- Setting the slider by keyboard works on this surface. The drag step is not shown to work here; it costs about 0.6 s before the keyboard step runs.
- An end-to-end `extended-pro` query on a new key still fails until the conversation reader is migrated; the answer is readable by hand or with `agentify_read_page`.
- This is one probe on one account. It does not show why the track click is ignored on a fresh tab but not in a conversation already on Pro.
