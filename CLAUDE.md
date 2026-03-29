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

## GPT Pro Extended Thinking Fix (in progress)

`agentify_query` returns after ~5 seconds during GPT Pro's "Extended Pro" thinking mode instead of waiting for the full response (~20 min). Three compounding bugs in `chatgpt-controller.mjs`:

### Root cause

1. **`sendEnabled` defaults to `true` when send button not found** (line 729). During Pro thinking, the send button is hidden — but the code treats "not found" as "enabled", so the done condition fires.

2. **No thinking state detection**. The code has zero awareness of GPT Pro's thinking UI. The "Pro thinking" banner text is stable, so the stability check passes immediately.

3. **`generating` only checks stop button selector**. Pro thinking may use a different stop/cancel control that doesn't match `selectors.stopButton`. With `generating = false` and `sendEnabled = true`, the done condition triggers.

### Patches applied (2 commits)

File: `chatgpt-controller.mjs`, method `#waitForAssistantStable`:

- `sendEnabled` default changed from `true` to `false` when send button not found
- Added `sendFound` boolean to distinguish "found and enabled" from "not found"
- Added `isThinking` regex detection: `/\bpro thinking\b|\bthinking\.\.\.\b|\bextended pro\b|\breasoning\b/i`
- `generating` true when: (stop visible + send not enabled), thinking detected, or (stop visible + send missing)
- Missing send button alone does NOT block completion — only when paired with stop button or thinking
- Added `sendReady` flag: accepts completion when send missing but no stop/thinking evidence
- Fallback done path guarded with `!snap?.isThinking`
- Timeout floor raised to 25 min (`Math.max(timeoutMs, 25 * 60_000)`)

### Spike test results

- [x] Verify that normal (non-Pro) ChatGPT queries still complete correctly — **PASS** (got "4" for "2+2")
- [x] Regression found & fixed: initial patch treated missing send button as generating, blocking all normal queries
- [ ] Test with a real GPT Pro extended thinking query
- [ ] Verify other vendors (Claude.ai, Gemini, etc.) aren't affected
- [ ] If working, open PR upstream at agentify-sh/desktop
- [ ] Consider adding `isThinking` to the response metadata so callers know thinking is in progress
