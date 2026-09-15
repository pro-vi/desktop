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

### Do not trust the first call after `agentify_shutdown`

The respawned Electron needs a few seconds before a page is capturable, and nothing blocks a read until it is. Observed 2026-08-03: an `agentify_read_conversation` issued ~3s after tab creation returned `messageCount: 0` while `agentify_status` showed the tab already sitting on the right conversation URL and `readiness` recorded `fail` / `anchor-postcondition-failed`. The identical call on the warm app returned all six messages. Navigation had succeeded; only the capture was early.

This matters because the reload step above is exactly what you do before verifying a change, so a cold-start empty result reads as "my change is broken" when it is not. `readConversationText` has no readiness gate of its own, and `prepareChatEntry`'s readiness wait did not block here. Re-run the call once the app is warm before concluding anything, and prefer a warm run for any evidence you intend to report.

## Tool usage counter

Every authenticated HTTP response is counted per route (calls, errors, cumulative response bytes) and persisted to `<stateDir>/tool-usage.json`. `/health`, OPTIONS, 401/403, and `/usage` itself are excluded. Read it without transcripts:

```bash
TOKEN=$(cat ~/.agentify-desktop/token.txt)
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.agentify-desktop/state.json'))['port'])")
curl -s "http://127.0.0.1:$PORT/usage" -H "authorization: Bearer $TOKEN" | python3 -m json.tool
```

Counts start from the instance's first run on a build that has the counter (2026-09-15); they do not backfill history. Query/research output sizes additionally live in each run record under `~/.agentify-desktop/runs/`.

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
