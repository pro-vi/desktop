# Agentify Desktop

Agentify Desktop is a local-first control center for AI work: connect your real, logged-in AI subscriptions to your MCP-compatible CLI tools, all on your own machine.

### Why teams keep it open
- `🌐` **Real browser sessions, real accounts**: automate the web UIs you already use, without API-key migration.
- `🔌` **MCP-native integration**: works with Codex, Claude Code, OpenCode, and other MCP-capable clients.
- `🧵` **Parallel tabs for parallel work**: run multiple isolated workflows at once using stable tab keys.
- `📎` **Practical I/O support**: upload files, save generated images/files locally, and reattach them in later prompts.

## Supported sites
**Supported**
- `chatgpt.com`
- `perplexity.ai`
- `claude.ai`
- `aistudio.google.com`
- `gemini.google.com`
- `grok.com`

**Planned**
- Additional vendor profiles via `vendors.json` + selector overrides.

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Requirements
- Node.js 20+ (22 recommended)
- MCP-capable CLI (optional, for MCP): Codex, Claude Code, or OpenCode

## Quickstart (macOS/Linux)
Quickstart installs dependencies, auto-registers the MCP server for installed clients (Codex/Claude Code/OpenCode), and starts Agentify Desktop:

```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh
```

Debug-friendly: show newly-created tab windows by default:
```bash
./scripts/quickstart.sh --show-tabs
```

Foreground mode (logs to your terminal, Ctrl+C to stop):
```bash
./scripts/quickstart.sh --foreground
```

Choose MCP registration target explicitly:
```bash
./scripts/quickstart.sh --client auto     # default
./scripts/quickstart.sh --client codex
./scripts/quickstart.sh --client claude
./scripts/quickstart.sh --client opencode
./scripts/quickstart.sh --client all
./scripts/quickstart.sh --client none
```

## Manual install & run
```bash
npm i
npm run start
```

The Agentify Control Center opens. Use it to:
- Show/hide tabs (each tab is a separate window)
- Create tabs for ChatGPT, Perplexity, Claude, Google AI Studio, Gemini, and Grok
- Tune automation safety limits (governor)

Sign in to your target vendor in the tab window.

If your account uses SSO (Google/Microsoft/Apple), keep **Settings → Allow auth popups** enabled in the Control Center. ChatGPT login often opens provider auth in a popup, and blocking popups can prevent login from completing.

## Browser backend choice
Agentify Desktop now supports two browser backends:

- `electron` (default): embedded windows managed directly by Agentify.
- `chrome-cdp`: launches/attaches a real Chrome-family browser via the Chrome DevTools Protocol.

If Google/Microsoft/Apple SSO is fighting Electron, switch to **Settings → Browser backend → Chrome CDP**, save, then restart Agentify Desktop.

`chrome-cdp` notes:
- Uses a managed browser profile at `~/.agentify-desktop/chrome-user-data/`
- Default remote debugging port is `9222`
- Prefers your local Chrome install, but also works with Chromium / Brave / Edge
- Uses real browser login flows, which is the main reason to choose it

Profile options in the Control Center:
- `Agentify isolated profile` (default): safest and most predictable
- `Existing Chrome profile`: reuses your normal Chrome session/profile

If you choose `Existing Chrome profile`, fully quit regular Chrome first, then start Agentify Desktop. If Chrome is already using that profile, Agentify will fail fast with a hint instead of attaching to the wrong browser state.

## First Useful Workflow
This is the simplest real workflow to prove the product is doing something useful.

1. Start Agentify Desktop:
```bash
npm i
npm run start
```

2. In the Control Center:
- set `Browser backend` to `Chrome CDP`
- keep `Chrome profile mode` as `Agentify isolated profile`
- optionally set `Default ChatGPT project URL` for normal chats
- keep `Default ChatGPT mode intent` on `Extended Pro` for normal deep-reasoning chats
- set `Default image project URL` if image requests should always land on a separate Instant/Thinking project
- keep `Default image key` on its own tab namespace so image-mode UI state never bleeds into normal chat tabs
- click `Save`
- restart Agentify Desktop if you changed the backend

3. Click `Show default`, then sign in to ChatGPT in the browser window.

4. Register the MCP server in your CLI.

Codex:
```bash
codex mcp add agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs
```

Claude Code:
```bash
claude mcp add --transport stdio agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs
```

5. In your MCP client, run this exact workflow:

Prompt:
```text
Create or reuse an Agentify tab with key repo-triage.
Use ChatGPT to answer this:
"Summarize the architecture of this repo in 8 bullets, then list the top 3 risky areas to change first."
Return the answer and keep the tab key stable for follow-ups.
```

6. Follow up in the same tab:

Prompt:
```text
Use the existing Agentify tab key repo-triage.
Ask for a test plan for changing one of those risky areas.
Return the plan as a short checklist.
```

That proves the core loop:
- keep a persistent logged-in web session
- call it from Codex / Claude Code over MCP
- reuse the same tab/session across multiple requests

### Continue a supplied ChatGPT conversation

Use `chatUrl` when a coding agent should continue an existing ChatGPT conversation without routing the reply into Agentify's default ChatGPT project:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "chatUrl": "https://chatgpt.com/share/CONVERSATION_ID",
    "prompt": "Continue from this context and produce the implementation plan."
  }
}
```

`chatUrl` accepts an owned `https://chatgpt.com/c/...` conversation or a `https://chatgpt.com/share/...` snapshot. It is mutually exclusive with `projectUrl` and takes precedence over saved/default project routing. When replying to a shared snapshot, ChatGPT creates a private copy in the signed-in account; Agentify captures that new `/c/...` URL and binds follow-ups to it. If no key is supplied, Agentify derives an isolated stable key from the URL instead of reusing the default project tab.

For the built-in coding orchestrator, pass the source thread separately from the local code workspace:

```bash
npm run orchestrator -- --key external-chat --chat-url https://chatgpt.com/share/CONVERSATION_ID
```

`--chat-url` changes only the browser conversation. Codex still runs in the workspace configured for that key (or the detected current workspace when none has been configured).

### First artifact workflow
This is the fastest way to prove the image/file pipeline is useful.

1. Generate something in a stable tab:

Prompt:
```text
Use tab key sprite-lab.
Generate a simple 2D pixel-art robot sprite on a transparent background.
Give me 3 variations.
```

2. Save the latest generated outputs to disk:

```json
{
  "tool": "agentify_save_artifacts",
  "arguments": {
    "key": "sprite-lab",
    "mode": "images",
    "maxImages": 3
  }
}
```

The response includes local file paths. You can immediately reuse one of them in the next step.

3. Reattach one of the returned paths to generate and save a variation in one call:

```json
{
  "tool": "agentify_image_gen",
  "arguments": {
    "key": "sprite-lab",
    "prompt": "Take the attached sprite and create a damaged version with one broken eye and darker metal.",
    "attachments": [
      "/ABS/PATH/FROM/PREVIOUS/STEP/sprite.png"
    ],
    "maxImages": 3
  }
}
```

agentify_image_gen uploads every attachment before sending the image prompt, then saves the generated images automatically and returns their local paths. Relative attachment paths are resolved from the MCP server's working directory.

4. If you want the folder in Finder/Explorer:

```json
{
  "tool": "agentify_open_artifacts_folder",
  "arguments": {
    "key": "sprite-lab"
  }
}
```

That proves the artifact loop:
- generate in a real web session
- save locally without manual browser downloads
- reuse the saved file path in the next MCP prompt

If your normal ChatGPT workflow uses a Pro-only project, keep image generation on a separate key or project. `agentify_query`, `agentify_image_gen`, and `agentify_tab_create` accept a ChatGPT `modeIntent` (`extended-pro`, `thinking`, or `instant`) as a first-class routing hint. These stable API names map to ChatGPT's current picker labels: `extended-pro` selects **Pro Extended** and `thinking` selects **Medium**. Normal ChatGPT keys use their explicit/saved/default Agentify project URL for text requests. Image-generation calls honor the dedicated image key/project path without overwriting normal keyed chat routing. `agentify_query` also accepts an explicit per-query `modelIntent` (`gpt-5.5-pro` or `gpt-5.4-pro`) for paired Pro checks; the controller opens the picker, traverses `Configure...` / legacy model controls when present, and fails closed before sending if it cannot confirm the requested generation. Any other value — including a generation the picker offers but Agentify has no metadata for — is rejected before sending rather than dropped, so a run that succeeds is evidence the pin was applied. If ChatGPT later reports a different mode in the completed response footer, the run fails instead of silently returning a downgraded result. `modelIntent` is intentionally not accepted by `agentify_tab_create` or image-generation requests so generation pins never become sticky project/key defaults.

For `fireAndForget` calls, record the returned `runId`. `agentify_get_run` is a non-blocking snapshot. Use `agentify_wait_run` when the caller should block until the run is genuinely terminal, or spawn the standalone waiter:

```bash
npm run wait-run -- <runId>
```

The waiter exits `0` only for receipt-backed success, after the response artifact has been written, read back, hashed, and registered. It exits `2` for provider/error failure, `3` for an explicit stop, and `4` when an app restart interrupted observation. `--timeout-ms N` applies only to that waiter and never cancels or changes the provider run.

The response observation timeout is soft for service-owned queries: the run remains `running` in `reconciling_response` while Agentify continues listening in the original provider tab. Completed query responses are persisted under the run's `outputManifest` and proven by `completionReceipt`. Electron restart does not yet reattach that browser observer; live survivors are marked `interrupted` rather than falsely failed or successful.

### First codebase stuffing workflow
Use this when you want to hand a repo or folder tree to the model without manually copy/pasting files.

1. Ask Agentify to pack a folder into the next query:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Summarize this codebase in 8 bullets and list the top 3 risky files to change first.",
    "contextPaths": [
      "/ABS/PATH/TO/YOUR/REPO"
    ]
  }
}
```

2. Inspect the returned `packedContextSummary` in the tool result.

It tells you, at a glance:
- which roots were scanned
- how many files were scanned
- which text files were inlined
- which files were auto-attached
- which files were skipped and why

3. If the first pass is too large or too small, tighten the budget explicitly:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Focus only on the rendering pipeline and state management.",
    "contextPaths": [
      "/ABS/PATH/TO/YOUR/REPO"
    ],
    "maxContextChars": 60000,
    "maxContextFiles": 40,
    "maxContextChunkChars": 4000,
    "maxContextChunksPerFile": 2,
    "maxContextInlineFiles": 12,
    "maxContextAttachments": 6
  }
}
```

4. Reuse the same tab key for follow-ups:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Now give me a safe refactor plan for the top risky file."
  }
}
```

That proves the codebase loop:
- point Agentify at a folder
- let it inline text files and auto-attach binaries/images
- inspect what it included vs skipped
- keep the same live session for follow-up questions

### Watch-folder ingestion workflow
Use this when you want a dead-simple local drop zone.

1. Open the default inbox folder:

```json
{
  "tool": "agentify_open_watch_folder",
  "arguments": {}
}
```

2. Drop files into that folder from Finder/Explorer or another local tool.

3. Agentify will index them automatically. If you want to force it immediately:

```json
{
  "tool": "agentify_scan_watch_folder",
  "arguments": {}
}
```

4. List the ingested files and reuse their paths:

```json
{
  "tool": "agentify_list_artifacts",
  "arguments": {
    "limit": 20
  }
}
```

Then pass one of the returned `path` values into the next `attachments` array.

You can also add your own watched folders:

```json
{
  "tool": "agentify_add_watch_folder",
  "arguments": {
    "name": "sprites",
    "folderPath": "/ABS/PATH/TO/sprites"
  }
}
```

List them:

```json
{
  "tool": "agentify_list_watch_folders",
  "arguments": {}
}
```

Remove one later:

```json
{
  "tool": "agentify_remove_watch_folder",
  "arguments": {
    "name": "sprites"
  }
}
```

### Reusable context bundle workflow
Use this when you keep sending the same codebase roots, screenshots, and instruction prefix.

1. Save a bundle once:

```json
{
  "tool": "agentify_save_bundle",
  "arguments": {
    "name": "repo-review",
    "promptPrefix": "You are reviewing this repository for safe incremental changes. Be concrete and concise.",
    "contextPaths": [
      "/ABS/PATH/TO/repo/src",
      "/ABS/PATH/TO/repo/package.json"
    ],
    "attachments": [
      "/ABS/PATH/TO/repo/docs/architecture.png"
    ]
  }
}
```

2. Reuse it later in a normal query:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review-chatgpt",
    "bundleName": "repo-review",
    "prompt": "Find the riskiest auth-related change points and propose the smallest safe refactor plan."
  }
}
```

3. If needed, add extra one-off context on top of the bundle:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review-chatgpt",
    "bundleName": "repo-review",
    "promptPrefix": "Prioritize fixes we can ship today.",
    "contextPaths": [
      "/ABS/PATH/TO/repo/new-module"
    ],
    "prompt": "Update the plan with the new module included."
  }
}
```

Good next workflow:
- create separate keys like `cmp-chatgpt`, `cmp-claude`, `cmp-gemini`
- send the same architecture prompt to each
- compare answers before making changes

Optional overrides:
```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npm run start
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9333 npm run start
AGENTIFY_DESKTOP_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run start
```

Equivalent CLI flags:
```bash
npm run start -- --browser-backend chrome-cdp
npm run start -- --chrome-debug-port 9333
npm run start -- --chrome-binary "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Transcript Library V0

Transcript Library keeps exact ChatGPT conversations as private local evidence. The normal workflow is to ask an MCP-connected coding agent to track, sync, list, retrieve, cite, continue, verify, forget, or import an exact conversation. The Control Center remains an optional fallback for the same ZIP picker, content-free status, and recovery actions. Both live capture and import produce immutable snapshots: saved captures that are never edited in place. ZIP import is optional and is not required for live tracking, retrieval, continuation, or local forgetting.

### Setup and identity

1. Start Agentify Desktop and sign in to ChatGPT in the browser profile you intend to use.
2. Give that signed-in account a stable **profile scope** such as `chatgpt-personal`. This is a local name you choose, not an account ID discovered from ChatGPT. Reuse it for the same account and do not reuse it for a different account.
3. If you restrict MCP tools, enable both the normal query tools and the library tools:

```bash
node mcp-server.mjs --tool-profile core,library
```

A conversation's identity is the profile scope plus its exact ChatGPT conversation ID. Titles, dates, sidebar position, and similar text never identify or merge conversations.

### Primary workflow: talk to a coding agent

Open the conversation in an existing keyed ChatGPT tab. Then ask your coding agent, for example: “Track the ChatGPT conversation open on key `thread-key` under profile scope `chatgpt-personal`, sync it once, and retrieve the first 20 turns with citations.” The underlying tool sequence is:

```text
agentify_track_transcript({ label: "Local label", tags: [], key: "thread-key", profileScopeId: "chatgpt-personal" })
agentify_sync_transcript({ sourceId: "SOURCE_ID_FROM_TRACK" })
agentify_get_transcript({ identity: IDENTITY_FROM_TRACK, limit: 20 })
```

Tracking records the exact live route; it does not capture in the background. Syncing performs one requested capture. Only a complete capture can become the latest snapshot, so a partial or failed attempt leaves the last complete snapshot unchanged. `agentify_list_transcripts` shows source and attempt status without returning transcript text, local labels, or routes.

Retrieval returns whole structured turns, rendered text, and a citation for each turn. A citation contains the exact conversation identity, snapshot hash, and turn ID. For the next page, pass both the returned `snapshot` and `cursor` (the next-page token) back to `agentify_get_transcript`; a token from another snapshot is rejected. Local paths stay hidden unless the authenticated caller explicitly sets `includePaths: true`.

A page from a tracked live source also returns `liveSourceId`, `sourceKey`, and `conversationUrl`. You can ask the agent to continue that exact live-bound conversation. The underlying call is:

```text
agentify_query({ liveSourceId: LIVE_SOURCE_ID, key: SOURCE_KEY, chatUrl: CONVERSATION_URL, prompt: "Continue from here." })
```

When `liveSourceId` is present, use only that exact `liveSourceId` + `key` + canonical `chatUrl` binding. Do not also send `tabId`, `model`, `vendorId`, `projectUrl`, `imageGeneration`, or a `?tabId=` selector. After Agentify observes and records a completed reply, it waits for the same transcript sync before returning. Imported-only conversations do not return live continuation fields.

### Import and direct route verification

Download your ChatGPT export yourself; Agentify does not request it, follow export emails, or download it for you. ZIP history import is optional. Ask your coding agent to import the export under the profile scope you choose. The agent uses this sequence:

1. `agentify_import_selected_chatgpt_export` opens Agentify Desktop's native picker. You select one ZIP.
2. Agentify creates and immediately consumes a one-use grant inside the local MCP/HTTP call chain. The agent receives neither the path nor the grant.
3. The agent reports complete, partial, rejected, or cancelled status and can inspect recovery state with `agentify_list_chatgpt_imports`.

The Control Center's **Transcript Library** card remains an optional fallback for the same picker, import status, and recovery actions.

`agentify_list_chatgpt_imports` returns at most the 100 most recently updated content-free summaries and marks the result when less recently updated imports were omitted. It excludes archive paths, archive hashes, account hints, raw records, transcript text, and per-record identities.

The picker creates a short-lived, one-use file grant. The import API accepts that grant ID, never an arbitrary archive path. Raw archive records are staged before catalog entries become visible. Archives above 20,000 conversation records or above 10,000 catalog-only problems are rejected as unsafe. These are separate limits: a worst-shape 20,000-record import fits an otherwise empty V0 catalog, and the store atomically reserves its conservative final metadata size against the catalog already on disk before making the import visible. That reservation survives interruption and restart until the import reaches a terminal result. The problem ceiling separately bounds the returned partial outcome. If an export contains an ambiguous branch or unsupported message content, that record remains catalog-only instead of becoming a made-up transcript.

Exports may carry an optional account hint. V0 currently has no stable browser-side hint to compare, so scope assignment remains an explicit human confirmation; Agentify never invents an account ID. Imported snapshot ordering uses the durable local import time, not an untrusted provider timestamp from the archive.

Re-importing the same archive under the same scope resumes from its saved position and does not duplicate identities or snapshots. If you assigned the archive to the wrong scope, ask the agent to call `agentify_reassign_chatgpt_import` with explicit confirmation, then re-select the same ZIP so snapshots can be rebuilt under the new scope. The fallback Control Center provides the same confirmed action.

Personal-export acceptance is currently deferred until a user has an export ready. Automated MCP contract tests prove that the selected-import tool requests the authenticated Electron grant endpoint and immediately consumes the returned one-use grant without exposing it. The controlled real ZIP fixture uses a deterministic dialog adapter, a real subprocess crash point, and the production private filesystem, reader, blob store, catalog store, and import service; hostile real ZIP bytes exercise production reader/service rejection. Real Electron, HTTP, and MCP entry points then list and retrieve the recovered catalog. The native OS panel itself remains part of the deferred user-selected export rehearsal because a background test process cannot perform the required foreground file choice. The optional Control Center fallback is tested separately for content-free import and recovery states, while exact route outcomes are covered at the controller/service seams. This evidence does not claim that a personal ChatGPT export, native file choice, or imported route has been exercised live.

Imported routes start unverified and cannot be used for navigation. Ask the agent to call `agentify_verify_catalog_conversation` with a verification tab key; the Control Center button is an optional fallback. Agentify navigates directly to the claimed conversation and promotes the route only when the served ChatGPT conversation ID matches exactly. Not-found, forbidden, foreign-profile, login, challenge, and transport results are observations or failures; none means the provider conversation was deleted.

Use `agentify_list_chatgpt_catalog` for the normal paginated catalog workflow. The optional Control Center fallback shows only the first 100 rows for a scope. A partial import can be resumed but not discarded in V0. Verification tabs are ordinary Agentify tabs: they appear in the main tab list and can be shown or hidden there.

### Private storage, forgetting, and recovery

Library data lives under `~/.agentify-desktop/transcript-library/`, or under `$AGENTIFY_DESKTOP_STATE_DIR/transcript-library/` when that override is set. On POSIX systems, Agentify creates private `0700` directories (only the owner can enter them) and `0600` files (only the owner can read or write them). V0 storage is local plaintext, not encrypted storage. Raw export records and normalized snapshots are not written to normal logs or error responses.

`agentify_forget_transcript({ sourceId, confirm: true })` removes one tracked source from the active list and keeps a local deletion tombstone. The returned recovery location is a logical identifier only; V0 has no restore UI/API and no physical `local-trash` directory. It never deletes or edits the ChatGPT conversation. V0 does not garbage-collect shared immutable blobs, so forgetting a source is not a promise that every referenced local byte was erased.

On Electron startup, an unfinished live capture becomes `interrupted` without advancing its prior latest snapshot. An unfinished import becomes a visible partial import with a resume position. Recovery is best-effort per store: if one library store cannot recover, Agentify still starts and unrelated tabs and queries remain usable while that library section reports unavailable. Catalogs created before the V2 capacity reservation load in place; re-select the same archive so the full preflight can reserve space before a suspended legacy import resumes. A legacy import above the current 20,000-record safety ceiling keeps its committed identities and snapshots as read-only history: an existing complete import stays complete, while any other state becomes partial. Startup can recognize an oversized import only when more than 20,000 records were already committed; a shorter prefix becomes read-only after re-selecting the exact same archive proves its full size. `agentify_list_chatgpt_imports` reports read-only and suspended import state without archive paths or record contents. The optional Control Center fallback labels read-only history and offers neither Resume nor Reassign. Selecting a completed archive again is also safe.

The normal coding-agent workflow inspects source state with `agentify_list_transcripts` and import state with `agentify_list_chatgpt_imports`. The optional Control Center fallback disables source-row actions while a source is syncing or disabled. Restart Electron to recover a stale syncing attempt. The confirmed HTTP/MCP forget operation remains valid for a disabled source.

Electron and the MCP server are separate long-lived processes and neither hot-reloads:

| What changed | Reload owner |
|---|---|
| Electron/library implementation, HTTP routes, controller, preload, or Control Center | Run `agentify_shutdown` so the next MCP call respawns Electron, or quit and restart Agentify Desktop. |
| `mcp-server.mjs`, MCP tool schemas, or tool-profile membership | Restart the Agentify MCP connection in the client. |
| A tool schema and its Electron implementation | Do both reloads. |

### V0 boundary and account risk

V0 is manual and agent-led: exact live tracking and sync, immutable paginated retrieval with citations, continuation into an existing live-bound thread, human-selected export import and recovery, direct route verification, and confirmed local source forgetting happen through coding-agent tools. The native picker still requires the human to choose the ZIP. The Control Center remains a supported optional fallback.

Deferred work is explicit. U8 sidebar reconciliation is not present: there is no sidebar discovery, scan, backfill, resurfacing logic, or deletion inference. U5 periodic provider synchronization is not present: there are no timed or background transcript captures. When it is open, the optional Control Center fallback receives content-free local change notifications after durable library mutations so import progress and changes made through HTTP or MCP become visible; those notifications never navigate to ChatGPT or start a sync. Export-request automation, embeddings, psychological classification, and audio-file archiving are also outside V0.

Transcript capture and route verification use the logged-in provider UI only when you request the operation. Agentify does not bypass login, challenges, rate limits, or other protective measures, and it cannot guarantee account safety. Review the account-risk boundary under [ChatGPT compatibility status](#chatgpt-compatibility-status) before using browser automation.

Filesystem confinement rejects path escapes and pre-existing symlinks. V0 trusts the owning OS user; it does not defend against another process running as that same user racing files inside the owner-only state directory.

## Connect from MCP clients
Quickstart can register MCP automatically, but manual commands are below if you prefer explicit setup.

### Codex
From the repo root:
```bash
codex mcp add agentify-desktop -- node mcp-server.mjs [--show-tabs]
```

From anywhere (absolute path):
```bash
codex mcp add agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs [--show-tabs]
```

Confirm registration:
```bash
codex mcp list
```

### Claude Code
From the repo root:
```bash
claude mcp add --transport stdio agentify-desktop -- node mcp-server.mjs [--show-tabs]
```

From anywhere (absolute path):
```bash
claude mcp add --transport stdio agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs [--show-tabs]
```

Confirm registration:
```bash
claude mcp list
```

### OpenCode
OpenCode can be configured in `~/.config/opencode/opencode.json`:
```json
{
  "mcp": {
    "agentify-desktop": {
      "type": "local",
      "command": ["node", "/ABS/PATH/TO/desktop/mcp-server.mjs"],
      "enabled": true
    }
  }
}
```

`./scripts/quickstart.sh --client opencode` (or `--client all`) writes/updates this entry automatically.

Confirm registration:
```bash
opencode mcp list
```

If you already had your client open, restart it (or start a new session) so it reloads MCP server config.

### MCP tool profiles

Agentify exposes the complete 46-tool surface by default for compatibility. Transcript Library conversations need the core and library profiles:

```bash
node mcp-server.mjs --tool-profile core,library
```

Profiles compose with commas:

```bash
node mcp-server.mjs --tool-profile core,library,browser
AGENTIFY_MCP_TOOL_PROFILE=core,library,context node mcp-server.mjs
```

Available profiles:

- `core`: query, research, durable wait/snapshots, stop/status, page reading, and image generation.
- `library`: native-picker ChatGPT export import, bounded import/recovery status, confirmed scope reassignment, catalog listing and route verification, plus transcript track, sync, retrieval, and local forgetting.
- `browser`: navigation, readiness, window visibility, and tab controls.
- `context`: watch folders, bundles, and artifact management.
- `operations`: listing, opening, retrying, and archiving durable runs.
- `media`: image generation/download and artifact access.
- `admin`: shutdown and bearer-token rotation.
- `full`: every tool; the compatibility default.

Profile selection happens when the MCP server starts. Restart the MCP connection after changing it so the client refreshes `tools/list`.

## Developer workflows (natural language)
Use plain requests in your MCP client. You usually do not need to call tool IDs directly.

1. **Plan in ChatGPT Pro or Gemini Deep Think, then execute in phases.**
Prompt:
"Open a Gemini tab with key `plan-auth-v2`, ask Deep Think for a migration plan from session cookies to JWT in this repo, and return a 10-step checklist with risk and rollback per step."
Follow-up:
"Now use key `plan-auth-v2` and generate step 1 implementation only, including tests."

2. **Prompt all vendors and compare output quality before coding.**
Prompt:
"Create tabs for keys `cmp-chatgpt`, `cmp-claude`, `cmp-gemini`, and `cmp-perplexity`. Send the same architecture prompt to each. Then compare responses in a table by correctness, operational risk, implementation complexity, and testability."

3. **Run incident triage with attached evidence.**
Prompt:
"Open key `incident-prod-api`, send `./incident/error.log` and `./incident/dashboard.png`, and produce: likely root cause, 30-minute hotfix plan, rollback, and validation checklist."

Use explicit tool calls (`agentify_query`, `agentify_read_page`, `agentify_read_conversation`, etc.) when you need deterministic/reproducible runs or when debugging tool selection.

## How to use (practical)
- **Use ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok normally (manual):** write a plan/spec in the UI, then in your MCP client call `agentify_read_page` to pull the visible page text into your workflow. For a complete long ChatGPT thread, call `agentify_read_conversation`; it scrolls through virtualized turns, saves the complete rendered capture as a private local artifact, and returns `transcriptPath`, `totalChars`, SHA-256, capture status, and a bounded inline preview. Read the file at `transcriptPath` when the preview is shortened. Pass `chatUrl` to read a specific conversation — Agentify navigates there and captures without sending anything, so reading a thread never adds a turn to it.
- **Download files attached anywhere in a ChatGPT conversation:** call `agentify_read_conversation`, select `artifactKey` values from its separate `artifactInventory`, then pass those keys and the same `chatUrl` to `agentify_download_conversation_artifacts`. Agentify clicks the exact authenticated file cards without opening a native Save dialog, applies per-file time and size limits, registers validated local files, and returns one terminal outcome per key. Transcript completeness and artifact-inventory completeness remain separate; do not treat a complete transcript as proof that the file inventory is complete.
  Canvas editor documents are not file cards and are not supported by this workflow. Keep them unsupported until a live Canvas surface can be probed and given its own explicit contract.
- **Drive ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok from your MCP client:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Parallel jobs:** create/ensure a tab per project with `agentify_tab_create(key: ...)`, then use that `key` for `agentify_query`, `agentify_read_page`, and `agentify_download_images`.
- **Upload files:** pass local paths via `attachments` to `agentify_query` or `agentify_image_gen` (best-effort; depends on the site UI).
- **Generate/save/reuse artifacts:** use `agentify_image_gen` with optional reference attachments to generate and save images in one call. For general prompts, call `agentify_query`, then `agentify_save_artifacts` or `agentify_download_images`; reuse returned paths in the next `attachments` array.
- **Open the artifact folder quickly:** call `agentify_open_artifacts_folder` or click `Artifacts` in the Control Center.
- **Use local inbox/watch folders:** call `agentify_open_watch_folder`, `agentify_add_watch_folder`, or manage them in the Control Center. Each watched folder has a one-click open button in the UI.
- **Stuff folder context into a prompt:** pass `contextPaths` to `agentify_query`. Agentify will inline chunked text files into the prompt and auto-attach small binary/image files when useful.
- **Tune large-context packing when needed:** `agentify_query` also accepts `maxContextChars`, `maxContextFiles`, `maxContextFileChars`, `maxContextChunkChars`, `maxContextChunksPerFile`, `maxContextInlineFiles`, and `maxContextAttachments`.
- **Vendor-aware context budgets:** packed context defaults are tuned by the target vendor/tab so large folder stuffing is less aggressive on narrower UIs and more generous where it makes sense.
- **Long and stuck runs:** a caller's `agentify_wait_run.timeoutMs` only stops that wait. It does not stop the run. Agentify may continue through `reconciling_response`, but the service now has its own hard deadline; terminal reconciliation errors include content-free `responseDebug` and release the provider slot. A caller wait timeout returns the latest run snapshot with `waitTimedOut: true`. For manual break-glass control, `agentify_status` includes `activeQuery` / `runtime.activeQueries`, `agentify_stop_query` requests a stop, and the Control Center shows a `Stop` button on tabs with a running job.
- **Reuse project context without rebuilding it every time:** save a named bundle with `agentify_save_bundle`, then pass `bundleName` to `agentify_query`.

## Real-world prompt example
Example `agentify_query` input:
```json
{
  "key": "incident-triage-prod-api",
  "promptPrefix": "Prefer precise shell commands and call out risky assumptions.",
  "prompt": "You are my senior incident engineer. I attached a production error log and a screenshot from our monitoring dashboard.\\n\\nGoal: produce a high-confidence triage summary and a safe hotfix plan I can execute in 30 minutes.\\n\\nRequirements:\\n1) Identify the most likely root cause with evidence from the log lines.\\n2) List top 3 hypotheses and how to falsify each quickly.\\n3) Give a step-by-step hotfix plan with exact commands.\\n4) Include rollback steps and post-fix validation checks.\\n5) Keep response concise and actionable.\\n\\nReturn format:\\n- Root cause\\n- Evidence\\n- 30-minute hotfix plan\\n- Rollback\\n- Validation checklist",
  "attachments": [
    "./incident/error.log",
    "./incident/dashboard.png"
  ],
  "contextPaths": [
    "./src",
    "./package.json"
  ],
  "timeoutMs": 600000
}
```

## What's new
- First-class multi-vendor tab support now includes Perplexity, Claude, Google AI Studio, Gemini, and Grok.
- Control Center reliability and UX were hardened (state/refresh wiring, tab actions, compact controls, clearer field guidance).
- Local API hardening includes strict invalid JSON handling, key/vendor mismatch protection, and safer tab-key recovery.
- Desktop runtime hardening includes Control Center sandboxing plus dependency security updates.

## Governor (anti-spam)
Agentify Desktop includes a built-in governor to reduce accidental high-rate automation:
- Limits concurrent in-flight queries
- Limits queries per minute (token bucket)
- Enforces minimum gaps between queries (per tab + globally)

You can adjust these limits in the Control Center after acknowledging the disclaimer.

## ChatGPT compatibility status

Agentify observes its declared ChatGPT UI contract only while carrying out an operation you requested. The Control Center, authenticated `/status`, and `agentify_status` report the **observed cohort** for this installation: map hash, exercised coverage, staleness, apparatus health, and capability results. Unobserved, stale, and incomplete are not healthy. This is not a claim that the map represents the globally latest ChatGPT UI.

The observer is passive: it adds no prompt, navigation, export, retry, background scan, or account action. An **Active canary** and automated selector repair are intentionally deferred. Receipt-backed query/research completion and saved artifacts remain authoritative; a DOM match alone cannot certify completion.

### Updating the ChatGPT UI contract

1. Edit `chatgpt-compatibility.json`. Keep canonical branches first, legacy branches explicit, and every capability dependency anchored or exempted. Do not edit `selectors.json` as a second ChatGPT authority.
2. Update the relevant checked-in fixture under `tests/fixtures/chatgpt-compatibility/`, then run the map, resolver, policy, terminal, and status compatibility tests. A fixture proves resolver semantics; it does not prove current production coverage.
3. Restart both Agentify Desktop and the MCP server. They are separate long-lived processes and do not hot-reload the contract or status schema.
4. Exercise only the ordinary operation you already intended to perform. Inspect compatibility status afterward. A new map starts unobserved; a legacy/operator-override branch is degraded until the checked-in canonical contract is deliberately updated and reviewed.
5. Keep repair manual. Never promote an observed selector automatically, and never use a compatibility check to bypass a login, challenge, rate limit, access restriction, or protective measure.

Account-risk boundary: this project does not guarantee account safety or immunity from suspension. OpenAI's current Terms of Use prohibit automatically or programmatically extracting data or output and prohibit circumventing restrictions or protective measures; they also permit suspension or termination for policy breaches or risky use. Review the current [Terms of Use](https://openai.com/policies/terms-of-use/) and [account deactivation guidance](https://help.openai.com/en/articles/10562188) before operating browser automation. Passive compatibility observation reduces extra traffic; it does not make automation compliant or ban-safe.

## Not Supported Right Now
The experimental orchestrator / single-chat emulator is intentionally hidden from the desktop UI and is not supported right now.
The supported product surface is the local browser-control + MCP workflow described above.

## Limitations / robustness notes
- **ChatGPT UI changes:** follow the structured contract workflow above. `~/.agentify-desktop/selectors.override.json` remains a visible degraded legacy branch, not a silent repair or second authority.
- **Perplexity selectors:** Perplexity support is best-effort and may require selector overrides in `~/.agentify-desktop/selectors.override.json` if UI changes.
- **Gemini selectors:** Gemini support is best-effort and may require selector overrides in `~/.agentify-desktop/selectors.override.json` if UI changes.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image-only transcript turns:** transcript capture never invents text from image pixels or changing image metadata. An otherwise structurally valid mapped message with no text makes sync partial (`conversation_message_text_unavailable`), so it cannot create or advance a complete tracked snapshot. Malformed, duplicate, or reordered provider structure still reports compatibility drift, and so does a fully served conversation of four or more messages in which none produced any text — that pattern means text extraction stopped matching ChatGPT's markup, not that the thread is entirely images.
- **Missing opening turn:** when the transcript scroll quiets at the top of the served thread and that first turn is an assistant turn, the capture is partial with reason `conversation_leading_turn_missing` (`leading_turn_missing` through `agentify_read_conversation`). The top boundary is still reported as proven, because it was — retrying the scroll will not produce turn 1. Recover such a conversation through the ChatGPT export import instead. This condition does not distinguish a thread that genuinely opens with an assistant turn from one whose opening prompt the provider withheld.
- **Image downloads:** prefers `<img>` elements in the latest assistant message; some UI modes may render images via nonstandard elements.
- **Parallelism model:** “tabs” are separate windows; they can run in parallel without stealing focus unless a human check is required.
- **Security knobs:** default is loopback-only + bearer token; token rotation and shutdown are supported via MCP tools.

## Login troubleshooting (Google SSO)
- Symptom: login shows “This browser or app may not be secure” or the flow never completes.
- Check 1: In Control Center, enable `Allow auth popups (needed for Google/Microsoft/Apple SSO)`.
- Check 2: Retry login from a fresh ChatGPT tab (`Create tab` → `ChatGPT` → `Show`).
- Check 3: If your provider asks for WebAuthn/security key prompts, complete/cancel once and continue; some providers require that step before password/passkey fallback.
- Check 4: Switch to the `chrome-cdp` backend and restart. This uses a real Chrome-family browser and avoids the embedded Electron auth path entirely.

## Build installers (unsigned)
```bash
npm run dist
```
Artifacts land in `dist/`. Source `npm run start` and `npm run dist` require development dependencies; the packaged application embeds Electron.

## Security and data
- Control API binds to `127.0.0.1` on an ephemeral port by default.
- Auth uses a local bearer token stored under `~/.agentify-desktop/`.
- Electron session data (cookies/local storage) is stored under `~/.agentify-desktop/electron-user-data/`.

See `SECURITY.md`.

## Trademarks
Forks/derivatives may not use Agentify branding. See `TRADEMARKS.md`.
