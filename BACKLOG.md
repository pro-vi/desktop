# Backlog

Deferred work with reopen triggers. Each entry names the plan it came from and the observation that should reopen it — a deferral is a decision with a tripwire, not a drop.

## Deferred

- **Reusable consent-gated live-probe runner** (`scripts/live-probe.mjs`) — origin: plan `2026-09-18-001` (CI gate, probe convention, clean-environment acceptance). One driver for live provider probes (consent gate, respawn, exercise, verify, record, close tab) instead of a hand-rolled driver per probe; four were hand-rolled in the 2026-09-17 session alone. Reopen trigger: the next hand-rolled probe driver prompts a tally of the recurring mechanics (consent, lifecycle, timeout, cleanup, receipt) — reopen when estimated recurring savings exceed the runner's build + maintenance cost, not only when one future driver exceeds the whole build.
- **Independent missing-run watchdog** — origin: plan `2026-09-18-001`. A scheduled workflow alerting when a pushed SHA has no CI run, independent of `ci.yml` itself. Reopen trigger: a second CI host exists (`nas/ROADMAP.md` Phase 6, the Mac Mini) — until then every runner shares this laptop, so an in-band watchdog is blind to exactly the failure it would guard.
- **GUI CI lane for the visual-proof tests** — origin: plan `2026-09-18-001` (surfaced when the first Linux run went red). The two `transcript-library-visual-proof` tests launch a real Electron renderer and skip on display-less Linux CI; their venue is local macOS runs. Reopen trigger: a visual-proof change whose evidence needs CI (or a regression that escaped local runs) — then either an xvfb lane on `ci-linux` (apt: `xvfb` + electron's shared libs) or a per-repo runner on `ci-macos` (the family precedent: fract-ai's desktop E2E jobs).
