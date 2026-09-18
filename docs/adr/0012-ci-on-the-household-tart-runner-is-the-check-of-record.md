# ADR 0012: CI on the Household Tart Runner Is the Check of Record

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Agentify Desktop maintainers and the 2026-09-18 build session; one ChatGPT Pro extended consult (run `a62da830`)
- **References:** `docs/gate/2026-09-18-ci-revival.md`, `docs/gate/2026-09-18-clean-environment-acceptance.md`, plan `2026-09-18-001`, `CLAUDE.md` "Canonical gate"

## Context

Nothing machine-enforced a green main: the inherited `ubuntu-latest` workflow had produced zero runs on any main push since 2026-05-18 (workflow active, Actions enabled, cause unnamed), and the discipline was "the agent remembers to run `npm test`".

## Decision

Every push to `main` runs the suite on the household Linux Tart VM (`[self-hosted, Linux, ARM64, tart]`, Node 24, `npm ci && npm test`). A revision is verified only by a green run for its exact SHA — missing, queued, canceled, or overdue evidence does not verify it, and work that depends on a push is not done until that run is green or the push is explicitly recorded unresolved. Triggers are push-to-main plus `workflow_dispatch` (the no-fire diagnostic path: dispatch works even when push delivery does not, separating trigger delivery from runner pickup). No `pull_request` trigger — a fork PR would run untrusted code on the shared household runner. No concurrency group — nothing to supersede without PRs, and a ref-keyed group replaces pending runs even with cancel-in-progress off; every SHA keeps its run.

## Rationale

Rejected: GitHub-hosted `ubuntu-latest` (the dead config — hosted minutes cost, delivery unproven over four months); PR-required branch protection (contradicts the direct-to-main solo model — the gate is post-push detection, stated honestly, not prevention); a git pre-push hook as enforcement (untracked, per-clone, invisible to other machines — documented as an optional convenience); an in-band missing-run watchdog (every runner shares the laptop, so it is blind to exactly the failure it would guard; deferred until a second host exists).

## Consequences

Positive: a red suite is machine-visible on main within minutes of a push; a planted defect is detected through the real path (receipt linked above); the first Linux runs caught two latent suite defects the dev Mac had never surfaced.

Negative: runs queue up to 24h while the laptop sleeps; the two visual-proof tests skip on display-less CI and keep their macOS-local venue (GUI CI lane deferred in `BACKLOG.md`).

## Revisit Triggers

- A second CI host exists (`nas/ROADMAP.md` Phase 6, the Mac Mini) — revisit the watchdog deferral and the queue-lag tolerance.
- GUI-test evidence is needed in CI — xvfb on `ci-linux` or a per-repo `ci-macos` lane (`BACKLOG.md` entry with the family precedent).
