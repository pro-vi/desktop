# Clean-environment acceptance (2026-09-18)

Two labeled calibration receipts for the new gate: the local ceremony proves a fresh checkout supports the canonical command in both directions; the CI-path red proves the enforcement surface itself detects a defect end-to-end.

## Checkout / test-runner calibration (local ceremony)

Fresh clone of `git@github.com:pro-vi/desktop.git` at `fda0312` into a temp dir (not named `desktop` — deliberately, after the checkout-name find below), cold `npm ci` (451 packages, ~18s), canonical command `npm test`.

1. **Green:** 881/881 pass, exit 0.
2. **Planted defect:** `tests/mcp-server-names.test.mjs:60` — the transcript-clause budget assertion's expected `3` changed to `2` (one-line inversion with a distinctive signature; never entered a main commit).
3. **Red:** exit 1, 880/881 — `AssertionError: query/wait/get each carry one transcript clause — 3 !== 2` at `tests/mcp-server-names.test.mjs:60`, exactly the expected signature.
4. **Revert + green:** defect reverted (working tree clean at `fda0312`), `npm test` → 881/881, exit 0. Removal confirmed by `git status` clean.

## Enforcement calibration (CI path)

The same class of defect planted on a throwaway branch (`probe/planted-red`, `b3f4cbc`), pushed, and dispatched:

- The branch push triggered **nothing** — correct by design (`on: push` is main-only); the run came from `gh workflow run ci.yml --ref probe/planted-red`.
- Run `35325365632` (`event: workflow_dispatch`, runner `ci-linux`): **failure**, failing step `Run npm test`, failure signature identical to the local red — `query/wait/get each carry one transcript clause — 3 !== 2`.
- Remote branch deleted after; `main` never carried the defect.

## Context

The clean-environment red was already witnessed once before the planted one, as a real find: the first fresh-clone suite run during the CI revival caught `mcp-lib`'s checkout-name assumption (a test that only passed when the clone's folder name contains `desktop`) — see `docs/gate/2026-09-18-ci-revival.md`. The planted defect is the controlled repetition proving the same detection on demand.
