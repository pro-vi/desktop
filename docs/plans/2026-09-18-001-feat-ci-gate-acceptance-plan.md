---
title: CI Gate, Probe Convention, Clean-Environment Acceptance
objective: A push to main is verified only by a green CI run for its exact SHA on the local Tart runners — the check of record, post-push detection rather than prevention; the oracle bank's remaining rows close with it.
type: feat
status: active
date: 2026-09-18
origin: /oracle rows O2/O3/O4 (re-ranked in conversation 2026-09-17/18: O3 full gap, O2 shrunk to convention + deferred runner, O4 folds as the acceptance ceremony)
---

# CI Gate, Probe Convention, Clean-Environment Acceptance

## Background

The re-ranked oracle bank (2026-09-18): O3 — nothing machine-enforces a green main; the discipline is "the agent remembers to run `npm test`", which a stale or careless session defeats. O2 — live probes are hand-rolled drivers each time (four bespoke drivers written in the 2026-09-17 session alone); the runner itself is deferred, but the procedure deserves one documented convention. O4 — the witnessed-red discipline is practiced (five stash-the-fix reds in recent sessions) but a clean-environment acceptance has never run as a ceremony.

Verified at planning time (2026-09-18, direct checks + one Explore map):

- `.github/workflows/ci.yml` exists but is dead: `runs-on: ubuntu-latest`, and **zero runs on any main push since 2026-05-18** (`gh run list --branch main`) despite Actions enabled (`{"enabled":true}`), the workflow state `active`, the file present in `origin/main`'s tree, and `pushed_at` current (2026-09-18). The two 2026-08-12 runs on `fix/*` branches failed after ~720h queued. Cause unknown from static evidence — only an executed push during the build settles it.
- This repo is a fork (`pro-vi/desktop` ← `agentify-sh/desktop`), direct-to-main solo workflow; PR-required branch protection would fight the owner's stated model (commits on main are the norm) — the gate is push-to-main CI plus local discipline, not mandatory PRs.
- The local Tart CI: Linux VM (Ubuntu 24.04 arm64, 5 runners) registered per-repo with labels `[self-hosted, Linux, ARM64, tart]`; **agentify-desktop has no runner registered** (`gh api .../actions/runners` → `[]`; `bootstrap/ci-runners/runners.json` lists only fract-ai, dota-market, philemon, bootstrap). Adding a repo = one row in `runners.json` + re-run `register-linux-runners.sh` (README "Adding a repo"); bootstrap's own commit conventions apply (release note in the same commit).
- Exemplar shape (dota-market `style-liveness.yml`, green as of 2026-09-13): `pull_request+push` to main, concurrency keyed by PR number/ref with `cancel-in-progress`, `actions/setup-node@v4` `node-version: '24'` `cache`, `timeout-minutes` (10–35 in family use), install then test. Node 24 via setup-node works on the Linux VM (system Node 22 also present).
- This repo's suite: `npm test` = `node --test tests/*.test.mjs`, 881 tests, ~2–10 min wall locally, no Electron launch (all stub-based; three test files import electron modules — installed by `npm ci`, linux-arm64 builds exist). Both `package-lock.json` **and** `pnpm-lock.yaml` are tracked with no `packageManager` field — the npm lock is the operative one (every script and this session's usage is npm); the pnpm lock is upstream residue.
- Queue caveats from the runbook: runners are outbound-only; jobs queue ≤24h when the laptop sleeps; host sleep produces a misleading "runner registration has been deleted" that self-heals via `Restart=always`.

Converged (2026-09-18) with one ChatGPT Pro extended consult (run `a62da830`, verdict `APPROVE-WITH-CONDITIONS`, confidence 0.92) plus two local checks it prompted:

- Head SHA of main reports **zero check-runs** and an empty `pending` combined status (`gh api .../commits/main/check-runs`) — the checks API confirms nothing executed for pushes.
- The `[skip ci]` push-suppression hypothesis is **refuted locally**: 0 of 121 commit subjects since 2026-05-01 match any skip-directive pattern.
- Adopted from the consult: `workflow_dispatch` trigger + dispatch-first no-fire diagnostics (rename is last resort); the exact-SHA verification contract (a revision is verified only by a green run of the designated job for that SHA; missing/queued/canceled/overdue is not verification) as a post-push receipt rule in the gate docs; dropping the unused `pull_request` trigger (fork PRs would run untrusted code on the shared household runner); no concurrency block (a ref-keyed group replaces *pending* runs even with cancel-in-progress off — with no PRs there is nothing to supersede, and every SHA keeps its run); U5 gains a CI-path planted-red via branch dispatch. Deferred with a named trigger: an independent missing-run watchdog — all five runners share this laptop, so an in-band watchdog is blind to exactly the failure it would guard; reopen when the second host exists (`nas/ROADMAP.md` Phase 6, Mac Mini).

## Requirements

- **R1:** A push to `main` produces a CI run on the local Tart Linux runner that executes `npm ci && npm test`, and a red suite surfaces as a red run — the check of record.
- **R2:** The canonical gate is documented for agents (fast command, what blocks merge, suite profile, optional local pre-push hook) in `CLAUDE.md`.
- **R3:** The live-probe procedure has one documented convention (consent, skeleton, where exemplars live); the reusable probe runner is durably deferred, not silently dropped.
- **R4:** A clean-environment acceptance has run once: fresh clone → install → green → one planted defect → red → revert → green, recorded.

## Naming Ledger

Naming pass: no new or renamed architectural vocabulary. Reuses the family's existing tokens: `tart` runner labels, `npm test` as the canonical command, `docs/probes/` as the record home, `BACKLOG.md` defer lane per the cut-candidate discipline.

## Architecture Decision

**Approach:** Revive the existing dead workflow by retargeting it to the family pattern — `runs-on: [self-hosted, Linux, ARM64, tart]`, Node 24 with npm cache, `timeout-minutes: 30`, `npm ci && npm test` — preceded by registering this repo on the Linux Tart VM (bootstrap `runners.json` row + register script, bootstrap commit with its release-note convention). Triggers are `push` to `main` plus `workflow_dispatch` only: the unused `pull_request` trigger is dropped (fork PRs would execute untrusted code on the shared household runner), and `workflow_dispatch` arms U3's dispatch-first diagnostics (dispatch requires the trigger present on the default branch, which U2's commit provides). No concurrency block: with no PRs there is nothing to supersede, and a ref-keyed group replaces pending runs even with cancel-in-progress off — every SHA keeps its own run, which the verification contract below depends on. The delivery mystery (active workflow, zero runs) closes by executed evidence through a diagnostic ladder — SHA-scoped query, then dispatch, then (last resort, one change at a time) workflow-filename recreation. The gate's enforcement shape is push-to-main CI plus a documented post-push observation contract — explicitly not PR-required branch protection, which would fight this repo's direct-to-main solo model. The dual-lock ambiguity resolves by deleting the stale `pnpm-lock.yaml` in the same commit that owns the workflow.

**Rationale:** Consistency — every sibling repo runs this exact shape on these exact runners (green as of 2026-09-18); nothing new is invented. Rejected alternatives: GitHub-hosted `ubuntu-latest` (the current dead config — costs hosted minutes the household avoids by policy and, empirically, stopped delivering runs); macOS Tart VM for this repo (suite needs no GUI or Electron launch; the Linux VM has 5 shared runners vs per-repo macOS); a git pre-push hook as the enforcement (untracked, per-clone, invisible to other machines — documented as an optional convenience instead); mandatory-PR branch protection (contradicts the direct-to-main solo workflow); an in-band missing-run watchdog workflow (all runners share the laptop — it is blind to exactly the failure it would guard; deferred with a second-host reopen trigger); a ref-keyed concurrency group with conditional cancel (replaces pending runs — violates per-SHA verification).

**Trade-offs:** CI queues while the laptop sleeps (≤24h, then re-runnable) — acceptable for a solo local-first repo; the check of record can lag by hours. First Linux/arm64 execution of the suite is a live unknown until R1's run lands. The `pnpm-lock.yaml` deletion assumes it is upstream residue — verified at contact.

**Approval criteria:** a reviewer agrees that (a) push-to-main CI on the household Tart runners is the right enforcement for a direct-to-main solo repo, (b) registering the runner from the bootstrap side with its commit conventions is the correct cross-repo move, and (c) the probe runner's deferral gets a durable record rather than silent abandonment.

## Implementation Units

### U1. Register the repo on the Tart Linux runner (bootstrap side)

- **Goal:** A `[self-hosted, Linux, ARM64, tart]` job for this repo picks up within minutes of queuing.
- **Requirements:** R1
- **Dependencies:** None
- **Files:**
  - Modify (bootstrap repo): `bootstrap/ci-runners/runners.json` (one `linux` row: user + `pro-vi/desktop`), re-run `bootstrap/ci-runners/register-linux-runners.sh`
- **Approach:** Follow the README "Adding a repo" section exactly; mint the registration token via `gh api -X POST repos/pro-vi/desktop/actions/runners/registration-token`; commit the `runners.json` change in bootstrap with its mandatory release note in the same commit (bootstrap `CLAUDE.md` convention — read it before committing there).
- **Patterns to follow:** existing `linux` rows in `runners.json`; the README's procedure verbatim.
- **Test scenarios:** none — infrastructure registration (the exercised check is U3's green run).
- **Verification:** `gh api repos/pro-vi/desktop/actions/runners` lists the new runner `online`.
- **Checkpoint:** auto — the runner reports online via the API.
- **Runtime evidence:** `unverified — the register script's ssh path into the VM runs during this unit; the API listing is the evidence.`

### U2. Retarget and own the workflow

- **Goal:** `ci.yml` targets the Tart Linux runner with the family shape and this repo owns its lockfile story.
- **Requirements:** R1
- **Dependencies:** U1
- **Files:**
  - Modify: `.github/workflows/ci.yml`
  - Delete: `pnpm-lock.yaml` (if verified stale — see Verify at contact)
- **Approach:** `on: push` (branches: `[main]`) + `workflow_dispatch`; no concurrency block (every SHA keeps its run — nothing to supersede without PRs); `runs-on: [self-hosted, Linux, ARM64, tart]`; `actions/setup-node@v4` node `'24'` `cache: npm`; `npm ci`; `npm test`; `timeout-minutes: 30`.
- **Patterns to follow:** `dota-market/.github/workflows/style-liveness.yml` (step shape), `fract-ai/.github/workflows/ci.yml` (runner labels, timeout, setup-node shape — its concurrency conditional deliberately not copied; see Architecture Decision).
- **Test scenarios:** none — YAML config (exercised by U3).
- **Verification:** the committed workflow matches the family shape; no dual-lock ambiguity remains.
- **Checkpoint:** auto — file committed; the run is U3's evidence.
- **Runtime evidence:** omit — static config whose runtime proof is U3.

### U3. The firing probe — a push that must run

- **Goal:** A push to `main` fires the workflow and goes green on the Tart runner; the delivery question closes with executed evidence, diagnostically separated (push path vs dispatch path vs runner pickup).
- **Requirements:** R1, R4
- **Dependencies:** U2
- **Files:**
  - Create: `docs/gate/2026-09-18-ci-revival.md` (the record: what fired, timings, the diagnostic ladder's outcomes — distinguishing "delivery observed working now" from "historical cause identified", which may honestly remain unnamed)
- **Approach:** Push a trivial docs commit from the normal agent session — the probe must exercise the same push path agents use, not a special developer flow. Then observe, in order:
  1. **SHA-scoped evidence:** `gh run list` and `gh api 'repos/pro-vi/desktop/actions/runs?head_sha=<sha>'` plus check-runs for the SHA. A run that exists but is *queued* is its own outcome (self-hosted queue may legally wait ≤24h on laptop sleep) — bounded observation, then branch: still queued → record and stop, do not conflate with no-fire.
  2. **No run for the SHA → dispatch the same file:** `gh workflow run ci.yml --ref main` (requires U2's `workflow_dispatch` on the default branch), then watch the *resulting run*, not merely command acceptance.
  3. **Interpret the dispatch-vs-push matrix:** dispatch fires but push doesn't → push-specific suppression; delivery remains unproven — record diagnostics and stop. Dispatch errors or creates no observable run → preserve the exact error; resolve eligibility/permissions/validity before touching workflow identity. Job executes and fails → diagnose the phase (setup / install / tests); fix within plan scope or record-and-stop (the gate is not accepted on a red baseline).
  4. **Only then, one identity change at a time:** recreate the workflow under a new filename, push, re-observe. Still nothing → stop with diagnostics gathered.
  Any apparent recovery must end with a **normal push** producing a run for its exact SHA — a green dispatch alone is not acceptance.
- **Patterns to follow:** the sibling repos' run histories as the "what normal looks like" reference.
- **Test scenarios:**
  - *Happy path:* run appears within ~1 min (an observation target, not proof a later run cannot appear), green within `timeout-minutes`.
  - *Queued path:* run exists, stays queued past the bounded wait → record and stop.
  - *Dispatch-vs-push matrix:* the four interpretations above.
  - *Red path:* job fails → phase diagnosis, fix or record-and-stop.
- **Verification:** a green run on `main` for the probe push's exact SHA exists in `gh run list`, linked in the gate record.
- **Checkpoint:** auto — terminal green run observed via `gh` (bounded wait, queue caveat documented); red-without-diagnosis, queued-past-bound, or no-fire-after-recreate → stop.
- **Runtime evidence:** `unverified — this unit IS the executed evidence.`

### U4. Canonical gate + probe convention in CLAUDE.md; runner durably deferred

- **Goal:** Agents read one section and know the fast command, the check of record, the probe procedure, and the deferred runner's home.
- **Requirements:** R2, R3
- **Dependencies:** U3
- **Files:**
  - Modify: `CLAUDE.md` (gate section)
  - Create: `BACKLOG.md` (defer lane: probe runner, `origin: 2026-09-18-001`)
- **Approach:** Gate section: `npm test` (~881 tests, minutes, no Electron launch) is the fast local command; the Tart CI run on main is the check of record, stated with its verification contract — *a revision is verified only by a successful run of the designated test job for that exact SHA; missing, queued, canceled, or overdue evidence does not verify it* — plus the post-push receipt rule: after any push to `main`, work that depends on it is not done until the run for that SHA is green or the push is explicitly recorded as unresolved. Optional local pre-push hook one-liner documented, never auto-installed. Probe convention: live provider probes need scoped consent, follow the `docs/probes/` exemplar skeleton (respawn → exercise → verify → record → close tab), and record under `docs/probes/`. The reusable runner lives in `BACKLOG.md`'s defer lane with its reopen trigger: the next hand-rolled probe driver prompts a tally of the recurring mechanics (consent, lifecycle, timeout, cleanup, receipt) — reopen when estimated recurring savings exceed the runner's build + maintenance cost, not only when one future driver exceeds the whole build.
- **Patterns to follow:** the existing CLAUDE.md section voice (tables, terse, incident-grounded).
- **Test scenarios:** none — documentation (its check is U5 reading it cold).
- **Verification:** sections present; `BACKLOG.md` lane exists with origin and trigger.
- **Checkpoint:** auto — written.
- **Runtime evidence:** omit — documentation.

### U5. Clean-environment acceptance (the oracle ramp's terminal ceremony)

- **Goal:** From a fresh clone, the gate proves both directions — green on the current tree, red on one planted defect, green again after revert — with the red witnessed both locally and through the real CI path.
- **Requirements:** R4
- **Dependencies:** U3
- **Files:**
  - Create: `docs/gate/2026-09-18-clean-environment-acceptance.md` (two labeled calibration receipts: checkout/test-runner calibration for the local ceremony; enforcement calibration for the CI-path red)
- **Approach:** Two phases. **Local (checkout/test-runner calibration):** clone origin/main to a temp dir; `npm ci`; `npm test` → green. Plant one defect (invert one assertion in a leaf test, chosen for a distinctive failure signature); `npm test` → red with that signature and a nonzero exit; revert; green. **CI-path (enforcement calibration):** plant the same class of defect on a temp branch, push the branch, `gh workflow run ci.yml --ref <branch>` (U2's dispatch trigger), observe the red run and its failure signature through the real runner path, delete the branch. The defect never lands on `main`; neither planted defect enters a main commit.
- **Patterns to follow:** the /oracle calibration-receipt discipline (defect, command, expected + observed signature, removal confirmation).
- **Test scenarios:**
  - *Happy path:* local green → planted red with the named signature → green; branch-dispatch red observed through CI.
  - *Edge:* the temp clone's `npm ci` fails (env drift) — that itself is a finding; record and stop.
- **Verification:** both receipts name the defect, the observed red signature, the green rerun / branch removal, and the removal confirmation.
- **Checkpoint:** auto — receipts complete.
- **Runtime evidence:** `unverified — the ceremony runs in this unit; the receipts are the evidence.`

## Scope Boundaries

- No PR-required branch protection — direct-to-main stays the workflow; CI is the check of record, and its guarantee is honestly scoped as post-push detection (the exact-SHA receipt rule), not prevention.
- No `pull_request` trigger — fork PRs would run untrusted code on the shared household self-hosted runner; revisit only if this repo adopts PRs, and then only with fork-run approval policies decided first.
- No macOS Tart lane, no E2E/GUI CI, no coverage tooling — the suite is stub-based and Linux-sufficient; revisit only if a future test needs a real Electron launch.
- No workflow changes to sibling repos; the bootstrap change is exactly one `runners.json` row plus its register-script run.
- The probe runner is deferred (U4's BACKLOG lane), not built.

### Deferred to Follow-Up Work

- Reusable consent-gated live-probe runner (`scripts/live-probe.mjs`) → `BACKLOG.md` defer lane, `origin: 2026-09-18-001`; reopen trigger: recurring-mechanics tally (see U4) exceeds build + maintenance cost.
- Independent missing-run watchdog (a scheduled workflow alerting when a pushed SHA has no run) → `BACKLOG.md` defer lane, `origin: 2026-09-18-001`; reopen trigger: a second CI host exists (`nas/ROADMAP.md` Phase 6) — until then every runner shares this laptop, so an in-band watchdog is blind to exactly the failure it would guard.

## System-Wide Impact

- **Interaction graph:** every future `main` push (and PR, if ever opened) triggers a Tart job; the Linux VM gains one repo among its shared five runners.
- **Error propagation:** a red suite is now publicly visible on the repo within minutes-to-hours (queue-lagged when the laptop sleeps); nothing auto-reverts.
- **State lifecycle risks:** none in-repo; the bootstrap `runners.json` state gains a row (reversible by removing it).
- **API surface parity:** none — no product code changes.
- **Integration coverage:** U3 is the end-to-end integration check (push → runner → suite → verdict).
- **Unchanged invariants:** everything in the product; this plan touches CI config, docs, and one bootstrap infra row.

## Build Execution Contract

- **Closed decisions:** Tart Linux labels `[self-hosted, Linux, ARM64, tart]`; Node 24 + npm cache; `npm ci` + `npm test`; triggers = `push` to `main` + `workflow_dispatch`, no `pull_request`, no concurrency block; `timeout-minutes: 30`; push-to-main CI (no PR requirement) with the exact-SHA verification contract documented in U4; `pnpm-lock.yaml` deleted as upstream residue; probe runner and missing-run watchdog deferred to BACKLOG with named reopen triggers; U3's no-fire ladder is query → dispatch → (last resort) filename recreate, and a green dispatch alone never satisfies U3; U5 carries both receipts (local + CI-path red).
- **Builder autonomy:** the trivial probe commit's content; gate-section wording; the planted defect's choice (distinctive signature required); receipt phrasing.
- **Verify at contact:** `pnpm-lock.yaml` is actually stale (diff its dep set against `package-lock.json`; if it is NOT stale or something references it, keep it and note the ambiguity instead); the three electron-importing test files only import (grep for spawn/launch — if any launches Electron, surface before relying on Linux CI); bootstrap's release-note format (read `bootstrap/CLAUDE.md` before committing there).
- **Stop conditions:** U3's no-fire persists after the workflow-filename recreate (delivery is GitHub-side — report diagnostics); or the suite is red on Linux/arm64 for an environmental cause that cannot be fixed within this plan (record, revert the workflow to a documenting stub, surface).
- **Authority boundaries:** none beyond ordinary — pushes to this repo and the bootstrap commit are established session work; the registration token comes from the authenticated `gh`.
- **Expected gate map:** U1 → runner `online` in the API; U2 → workflow committed; U3 → terminal green run on main (or the named branch actions); U4 → sections + lane exist; U5 → four-field receipt. End → no product-code changes, so no full-suite rerun obligation beyond U5's own clean-clone green.
- **Human inventory:** none — every contribution is deterministic and within builder authority (the only live-ish action, the probe push, is ordinary push work to this repo).

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Suite red on Linux/arm64 (never run there) | U3's branch action: phase diagnosis (setup/install/tests); timeout generous; stop-and-record rather than force — no red baseline accepted |
| Push events still not delivering (the May mystery) | U3's ladder: SHA-scoped query → dispatch same file → (last resort, one change at a time) filename recreate; queued ≠ no-fire; green dispatch alone never satisfies U3 — a normal push must produce the run |
| Push fails silently *after* the gate works (nobody observes the red) | Exact-SHA receipt rule in U4's gate docs (post-push work isn't done until green or explicitly unresolved); independent watchdog deferred with a second-host trigger — honesty about scope, not a silent claim |
| Laptop asleep → runs queue ≤24h | Documented family behavior; queued is its own bounded-observation outcome; solo repo tolerance |
| Deleting `pnpm-lock.yaml` breaks an unknown consumer | Verify-at-contact check; keep-and-note fallback |
| Bootstrap commit misses its release-note convention | Read `bootstrap/CLAUDE.md` first (named in Verify at contact) |
