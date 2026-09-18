# CI revival — the gate of record on the Tart runner (2026-09-18)

## What fired

The retargeted workflow (pushed as `2f71b85`) produced run `35322293080` **two seconds after the push** (`event: push`), and the head SHA's check-run count went 0 → 1. Push delivery works on the retargeted workflow; the `workflow_dispatch` diagnostic path was never needed.

**The four-month delivery question** — zero runs on any main push since 2026-05-18 despite an active workflow, enabled Actions, and the file present in the tree — closes as *delivery observed working now*; the historical cause is not identified. Partial context only: the account's hosted-runner billing block (~2026-08-18, see `bootstrap/ci-runners/README.md`) explains the two Aug fix/* runs queuing ~720h, but the May gap predates it and is left unnamed rather than guessed. The `[skip ci]` family of push suppressants is refuted locally: 0 of 121 commit subjects since 2026-05-01 match any skip directive.

## The two reds — latent suite defects the gate caught on first contact elsewhere

**Run `35322293080`** (`2f71b85`, ~6.8 min): three tests depending on the host having a browser.

- `chrome-cdp-backend`'s reconnect case stubs fetch and WebSocket but let `start()` resolve and spawn a *real* Chrome — present on the dev Mac, absent on headless Linux. Made hermetic with `executablePath: '/usr/bin/true'` (the constructor's own injection point; `/usr/bin/true` exists on both platforms — `/bin/true` does not exist on macOS).
- The two `transcript-library-visual-proof` tests launch a real Electron renderer and need a display server. They now skip with a stated reason when Linux has no `DISPLAY` and keep running on GUI hosts (macOS local runs); a GUI CI lane is deferred in `BACKLOG.md`.

**Run `35323487178`** (`ea14e05`, ~3.2 min): two checkout-name/timing assumptions.

- `mcp-lib`'s electron-resolution test asserted the spawned path contains a `desktop` path segment — true only when the checkout folder is named that way (`agentify-desktop` locally, `_work/desktop/desktop` on the runner); a clone anywhere else fails deterministically (reproduced in a fresh clone). Now asserts the exact module-relative binary and entry paths, and that they do not come from cwd.
- `compatibility-store`'s serialization test waited a fixed 20 `setImmediate` turns for a write that travels through a real-ENOENT load and the serialization queue — too few under parallel-test fs contention on the runner. Now waits on a real 2-second deadline.

## Green

Run `35324560985` (`fda0312`, started 08:28:38Z, completed 08:32:53Z): **success** on runner `ci-linux` — the first Linux/arm64 execution of the suite (881 tests, 2 display-gated skips).

## Run index

| run | pushed SHA | result | wall | what it proved |
|---|---|---|---|---|
| `35322293080` | `2f71b85` | failure | ~6.8 min | push fires in 2s; GUI-host dependencies |
| `35323487178` | `ea14e05` | failure | ~3.2 min | checkout-name + wait-loop assumptions |
| `35324560985` | `fda0312` | **success** | ~4.3 min | the gate of record, green for its exact SHA |
