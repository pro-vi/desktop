# ADR 0013: Close Idle Provider Tabs; Throttling Does Not Reach Hidden Windows

- **Status:** Accepted
- **Date:** 2026-09-23
- **Deciders:** the maintainer, who selected "Close idle tabs, build now" from four options on 2026-09-23, and the 2026-09-23 session
- **References:** `726df2e`; `closeIdleTabs()` in `http-api.mjs`; `TabManager.idleTabIds()` and `TabManager.touchTab()` in `tab-manager.mjs`; ADR 0009 (leases)

## Context

Every new key opens a hidden provider window (`show: false`) that stays open until a caller closes it. Callers mint a new key per call and almost never close one (`/tabs/close` was called 4 times from 2026-09-15 to 2026-09-23). A process up for 2.5 days therefore held about 19 tabs, one renderer each at 470–920 MB. On 2026-09-23, with the display off and no run in flight, its GPU helper was the top process in macOS's power log, and its launch group drew about 7 W of GPU.

A local Electron 39.6 test measured the frame rate of a page that counts `requestAnimationFrame` callbacks for 5 seconds, in a hidden `BrowserWindow`:

| Window state | Background throttling | `visibilityState` | frames/s |
|---|---|---|---|
| never shown | off | visible | 121–131 |
| never shown | on | visible | 120–124 |
| shown, then `hide()` | on | visible | 128 |
| shown, then `minimize()` | on | hidden | 0 (timers 1–2/s) |
| shown, then `minimize()` | off | visible | 120 |

## Decision

Close any unprotected, non-default tab after 15 minutes unused, unless it has an active query, its window is on screen or minimized, or it is asking for attention. A sweep runs every minute. It holds the tab's `key:` and `tab:` leases while closing, so a concurrent request gets `tab_busy` rather than losing its tab mid-call. Idle time counts from the release of the tab's last lease.

`setBackgroundThrottling(false)` in `electron-browser-backend.mjs` stays. Agentify's hide action minimizes, and the last row of the table shows that throttling off is what keeps a minimized tab rendering during a run.

## Rationale

- **Throttle while idle:** rejected. The table shows throttling has no effect on a hidden window.
- **Pool windows per provider under a lease:** not taken. It moves conversation continuity from per-key tabs to leases, which is a larger change.
- **Quit when idle:** not taken, because every call after a quiet period would pay a cold start. It is the fallback, recorded in `BACKLOG.md`.
- **Closing keeps continuity.** A key's conversation URL is persisted (`persistKeyMeta()`), so the next request for that key opens a new tab on the same thread, as it does after a restart.

## Consequences

Positive:

- Idle cost falls to the default tab plus tabs used in the last 15 minutes, for memory as well as GPU.

Negative:

- A `tabId` taken from an older result returns `tab_not_found` once its tab has been idle for 15 minutes; callers address follow-ups by `key`.
- A request that arrives during the millisecond close window gets `tab_busy`.
- A follow-up after 15 minutes pays a page load.

## Revisit Triggers

- The power log shows Agentify's GPU helper on top again while few tabs are open: take the quit-when-idle fallback.
- An Electron upgrade makes throttling reach hidden windows (re-run the frame-rate test): throttling becomes an option again.
- A caller needs a `tabId` to stay valid across long gaps.

## References

- Tests: "idle sweep closes unused tabs but not the default tab or one whose key is leased" and "a finished query marks its tab used" (`tests/http-api.test.mjs`); "idleTabIds lists only unused tabs that nobody is looking at" (`tests/tab-manager.test.mjs`).
- `CLAUDE.md`, Ops gotchas: the idle-close bullet.
