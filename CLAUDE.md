# Agentify Desktop — Local Patches

## Dev loop: reloading code changes

Two long-lived processes, neither hot-reloads. Know which one owns the file you changed.

| What changed | How to reload |
|---|---|
| Electron-side (`chatgpt-controller.mjs`, `http-api.mjs`, `main.mjs`, `tab-manager.mjs`, `selectors.json`, etc.) | `agentify_shutdown` — next MCP tool call auto-respawns Electron |
| MCP server (`mcp-server.mjs`, `mcp-lib.mjs`) | `/mcp` in Claude Code → restart the agentify-desktop server |

### Why

```
Claude Code session
  └─ node mcp-server.mjs        ← stdio child process, lives with the session
       └─ spawns electron main.mjs  ← detached process, survives MCP restarts
```

- **MCP server**: thin HTTP proxy. Loads code once at spawn. Changing the file on disk doesn't affect the running process.
- **Electron app**: loads all controller/API/backend code via ES `import` at startup. Spawned on-demand by `ensureDesktopRunning()`, detached from MCP server.
- No bundling — all pure `.mjs` loaded directly from disk.
- ~95% of changes are Electron-side, so `agentify_shutdown` covers most cases.

Changes to an MCP tool schema (for example, adding `chatUrl` to `agentify_query` or `agentify_read_conversation`) require both reloads: restart the MCP server so the client sees the new tool schema, then run `agentify_shutdown` so Electron reloads the HTTP routing/controller implementation.

### Do not trust the first call after `agentify_shutdown` — largely fixed 2026-09-17

The respawned Electron needs a few seconds before its pages finish hydrating, and historically nothing blocked a capture until they were. Observed 2026-08-03: an `agentify_read_conversation` issued ~3s after tab creation returned `messageCount: 0` while `agentify_status` showed the right conversation URL and `readiness` recorded `fail` / `anchor-postcondition-failed`; observed again 2026-09-17 (probe run 1): the first query after spawn captured whole-section chrome (prompt echo + timing + footer + answer) as the assistant node text.

As of `0d80911` (plan `2026-09-17-002`) both shapes are gated at the capture surfaces and verified live on the first post-spawn calls (`docs/probes/2026-09-17-cold-start-capture-probe.md`): the capture bundle waits (bounded ~10s) for the first role-bearing message on canonical conversations, and the wait loop completes only on a role-qualified assistant node (`meta.nodeBasis`) — never on a hydrating broad container — with no completion channel firing while a stop control is visible. Readiness itself still proves only the composer (by design: send paths must not block on transcript hydration).

Residual advice: a cold capture can still take longer (the bounded wait) and unqualified pages run to their existing timeout/recovery instead of completing on a container — if a first result looks wrong, check `meta.nodeBasis` and the run's `responseDebug` before suspecting your change, and prefer a warm run for evidence you intend to report.

## Transcript by default (2026-09-17)

Every successful keyed text query on a canonical conversation auto-tracks a Transcript Library source (idempotent by conversation identity) and publishes a whole-conversation snapshot after finalize, detached from the response. The run record's `outputManifest.transcript` carries the lifecycle — `pending` at finalize, `ready` only when the committed snapshot verifiably contains the run's answer turn (`meta.providerMessageId`), `failed`/`not_applicable` with explicit reasons otherwise; stranded pendings reconcile at startup. The snapshot is a local JSON file (`~/.agentify-desktop/transcript-library/blobs/snapshot/…`) — agents read/grep it directly; `transcript=`/`turn=` lines ride wait/get results. Blocking paths grace-wait ≤2s; a `pending` after that settles in the record shortly.

## Tool usage counter

Every authenticated HTTP response is counted per route (calls, errors, cumulative response bytes) and persisted to `<stateDir>/tool-usage.json`. `/health`, OPTIONS, 401/403, and `/usage` itself are excluded. Read it without transcripts:

```bash
TOKEN=$(cat ~/.agentify-desktop/token.txt)
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.agentify-desktop/state.json'))['port'])")
curl -s "http://127.0.0.1:$PORT/usage" -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

Counts start from the instance's first run on a build that has the counter (2026-09-15); they do not backfill history. Query/research output sizes additionally live in each run record under `~/.agentify-desktop/runs/`.

## Canonical gate (2026-09-18)

`npm test` is the fast local command — the full stub-based suite, no Electron launch, minutes. The check of record is the Tart CI run: every push to `main` fires `.github/workflows/ci.yml` on the household Linux VM (`[self-hosted, Linux, ARM64, tart]`, Node 24, `npm ci && npm test`, 30-min timeout). Jobs queue up to 24h while the laptop sleeps — a queued run is not a missing one.

**Verification contract:** a revision is verified only by a successful CI run for its exact SHA; missing, queued, canceled, or overdue evidence does not verify it. After pushing to `main`, work that depends on the push is not done until the run for that SHA is green (`gh run list -R pro-vi/desktop --branch main`, or the SHA-scoped `actions/runs?head_sha=` API) or the push is explicitly recorded as unresolved. `workflow_dispatch` is also armed — `gh workflow run ci.yml -R pro-vi/desktop --ref main` — and doubles as the diagnostic path when a push does not seem to fire (dispatch works even when push delivery does not, separating trigger delivery from runner pickup).

Optional local pre-push convenience (documented, never auto-installed): `npm test && git push`. The workflow has no `pull_request` trigger on purpose (a fork PR would run untrusted code on the shared household runner) and no concurrency group on purpose (nothing to supersede without PRs; every SHA keeps its own run).

## Live provider probes

Probes against the real ChatGPT surface need explicit scoped consent from the user for that probe before anything is sent. Follow the exemplar skeleton under `docs/probes/` (respawn via `agentify_shutdown` → exercise one bounded behavior → verify against the run record → record under `docs/probes/YYYY-MM-DD-<name>.md` → close the tab). A reusable consent-gated probe runner is deferred in `BACKLOG.md` with a reopen trigger, not silently dropped.

## Chat location vs coding workspace

- `chatUrl`, `projectUrl`, and the persisted keyed ChatGPT location control the browser thread only.
- `orchestrator/workspaces.json` controls the filesystem directory where Codex runs.
- Never derive or replace a coding workspace from a ChatGPT URL.
- A `/share/...` URL is a source snapshot. Only the resulting validated `/c/...` URL becomes durable conversation affinity after the first successful reply.

## GPT Pro Extended Thinking Fix (in progress)

`agentify_query` returns after ~5 seconds during GPT Pro's "Extended Pro" thinking mode instead of waiting for the full response (~20 min). Three compounding bugs in `chatgpt-controller.mjs`:

### Root cause

1. **`sendEnabled` defaults to `true` when send button not found** (line 729). During Pro thinking, the send button is hidden — but the code treats "not found" as "enabled", so the done condition fires.

2. **No thinking state detection**. The code has zero awareness of GPT Pro's thinking UI. The "Pro thinking" banner text is stable, so the stability check passes immediately.

3. **`generating` only checks stop button selector**. Pro thinking may use a different stop/cancel control that doesn't match `selectors.stopButton`. With `generating = false` and `sendEnabled = true`, the done condition triggers.

### Patches applied

Two stages:

**Stage 1 — wait-loop thinking awareness** (`#waitForAssistantStable` in `chatgpt-controller.mjs`):

- `sendEnabled` default changed from `true` to `false` when send button not found
- Added `sendFound` boolean to distinguish "found and enabled" from "not found"
- Added `isThinking` regex detection over UI chrome outside the assistant node: `/\bpro thinking\b|\bthinking\.\.\.\b|\bextended pro\b|\breasoning\b/i`
- `generating` true when: (stop visible + send not enabled), thinking detected, or (stop visible + send missing)
- Missing send button alone does NOT block completion — only when paired with stop button or thinking
- Added `sendReady` flag: accepts completion when send missing but no stop/thinking evidence
- Fallback done path guarded with `!snap?.isThinking`
- Timeout floor raised to 25 min (`Math.max(timeoutMs, 25 * 60_000)`)

**Stage 2 — final-output qualification** (2026-09-14, `8a4f65e` + `7e8654e`; ADR 0007): Stage 1 still let a stabilized `Pro thinking` label inside the assistant node, a changed Deep Research planning panel, or a progress-only recovered tail become receipt-backed success. The controller now emits completion evidence with a closed source set (`assistant-node`, `image-output`, `deep-research-report`, `structured-recovery`); HTTP writes no artifact/receipt/success without it. Exact progress-only labels stay transient (`isProgressOnlyAssistantText`), Deep Research needs its native `research completed in` marker, and `/read-page` returns provenance (`tabId`, `key`, `servedUrl`) and rejects a contradictory `tabId`+`key` pair with 400 `selector_conflict`.

### Spike test results

- [x] Verify that normal (non-Pro) ChatGPT queries still complete correctly — **PASS** (got "4" for "2+2")
- [x] Regression found & fixed: initial patch treated missing send button as generating, blocking all normal queries
- [x] Test with a real GPT Pro extended thinking query — **PASS** (waited ~7min, "Thought for 6m 52s", returned full response)
- [x] `sendVisible: false` after Pro completion is expected — `sendReady` fallback handles it correctly
- [x] Stage 2 deterministic coverage: controller 177/177, http-api 157/157, full repo `npm test` 862/862 (2026-09-14)
- [x] Live probe (2026-09-14, `docs/probes/2026-09-14-completion-qualification-probe.md`): qualification pipeline, receipt, and read-page provenance verified live at `fdce09e`. **New pre-existing defect found, not yet fixed:** on project-routed conversations the wait loop can complete on the *previous* assistant reply (captured `'4'`/`'6'` for 3+3/5+5 prompts) — turn-identity race, not a finality failure; needs its own plan (provider-message-id baseline in the wait loop). `Pro thinking` transience live check still not run (deterministic tests only).
- [ ] If working, open PR upstream at agentify-sh/desktop
- [ ] Consider adding `isThinking` to the response metadata so callers know thinking is in progress
- For long queries, submit with `fireAndForget`, then call `agentify_wait_run` or spawn `npm run wait-run -- <runId>`. The waiter succeeds only after receipt-backed output completion; its deadline does not mutate the run.
