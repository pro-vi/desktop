# Refused project routing

- Date: 2026-10-14 PDT
- Source: `c1f2fff` plus the readiness, location and stop checks committed with this record, as they stood before the pre-commit review moved the URL-id helpers into `chatgpt-location.mjs` and limited them to chatgpt.com URLs; Electron respawned after the last code change before the probe
- Scope: page loads against a project the signed-in account can no longer open, page loads against one it can, and one short Pro request through the configured default project
- Result: the refused project fails readiness in under a second with `project_unavailable`; the Pro request completed inside the default project

## Symptom

Every Pro request routed to the configured default project stayed in `navigating_to_project` with no terminal state. The project page showed only `Loading project`. Earlier requests to the same project had completed for weeks, but in standalone conversations rather than inside the project.

## Cause

ChatGPT answers the project's own `GET /backend-api/gizmos/<project id>` request with HTTP 403 for the signed-in account. The browser profile's HTTP cache holds 200 responses for that project through late August and 403 or 404 responses from mid-September on. Until the evening of 2026-10-13 the page fell through to the home composer, so runs succeeded outside the project; from then on it stayed on `Loading project` and never rendered a composer.

While a run waited, the readiness loop marked the tab as needing attention, and one run's tab ended on an unrelated existing conversation. Readiness passed on that conversation's composer and the prompt was sent there, two minutes after a stop had been requested for the run. How the tab moved was not observed.

## Live checks

Page loads only; nothing was sent:

| Page | Readiness result | Time |
|---|---|---:|
| Refused project | `project_unavailable`, status 403 | 0.8 s |
| Accessible project | composer ready, `projectAccess.status` 200 | 0.9 s |

Before the change, the same refused page returned `timeout_waiting_for_prompt` only when a 30 s readiness bound ran out.

## Pro request

Prompt: `Reply with exactly this line and nothing else: AGENTIFY_DEFAULT_PROJECT_OK`, `modeIntent: extended-pro`, no `projectUrl`, so routing came from the default project setting.

| Run | Exact answer | Duration | Saved-answer SHA-256 |
|---|---|---:|---|
| `18cf9f47-a2b3-433f-9d9c-82d81e0b962f` | `AGENTIFY_DEFAULT_PROJECT_OK` | 22.159 s | `59936a32b321640e6f0e919e9ba8cdc40009e2f1da05620c75b8fbb465240cb4` |

The run record shows a `project-conversation` location inside the default project, Pro confirmed before send at slider index 4, `modeUsed: extended-pro` from response metadata, complete prompt delivery, a completion receipt whose hash matches the saved bytes, and a `ready` transcript snapshot. The probe tab was closed.

## Limits

This verifies one account and provider surface at this time. The location check runs when the page becomes ready, not at the moment of submit; a tab moved while the prompt is being typed is not covered. The run that was sent after its stop request ran on an Electron build from 2026-10-06, so this record does not show why that build never reached its readiness deadline.
