# MCP method happy paths

This matrix is the acceptance map for the public Agentify Desktop MCP surface at
`6e31b71`. `ALL_MCP_TOOL_NAMES` in `mcp-tool-profile.mjs` is the method authority.
The matrix contains 47 rows because the full profile currently exposes 47 methods.

A row passes only after the named public MCP method returns its expected observable
result through the real Electron service. Unit tests, a lower HTTP call, listing a
method in `tools/list`, or another method exercising the same lower layer do not pass
the row.

## Journeys

- **LIVE-QUERY** — three new ChatGPT Pro conversations derived from clean wiki notes;
  each run is accepted asynchronously, observed once while live, awaited to a
  receipt-backed response, reopened, and checked through its saved output.
- **LIVE-RESEARCH** — one ChatGPT Deep Research request derived from a wiki gap;
  await its durable report and inspect the exported result.
- **LIVE-CONVERSATION** — capture one LIVE-QUERY conversation, inventory a generated
  file card, download it by `artifactKey`, and compare the saved bytes.
- **LIVE-TRANSCRIPT** — track one owned LIVE-QUERY conversation, sync it, retrieve two
  citation-bearing pages, continue the same live source, sync again, and forget only
  the test source.
- **LIVE-MEDIA** — generate one small image in the configured image lane, download the
  latest image, save it through the generic artifact method, and inspect the paths.
- **LOCAL-BROWSER** — create one owned tab, navigate it, wait for readiness, show and
  hide it, read the page, inspect status, then close only that tab.
- **LOCAL-CONTEXT** — add one run-owned watch folder beside a decoy, scan a sentinel
  before and after mutation, open and remove only the target, and prove one owned
  bundle persists across restart before deleting it without changing a decoy bundle.
- **LOCAL-OPERATIONS** — act only on runs created by LIVE-QUERY: list, inspect, reopen,
  retry, archive, and confirm archive visibility.
- **LOCAL-ADMIN** — rotate the token and prove a fresh authenticated MCP call, then
  shut down and prove the next MCP call starts a new Electron server.
- **CONTROLLED-LIBRARY** — run the isolated Electron/real-ZIP library E2E plus the
  stdio MCP catalog-import composition. The catalog journey keeps the production
  grant, reader, blob, catalog, HTTP, and MCP layers active while replacing the
  native dialog and remote route verifier at their explicit contracts.

## Method matrix

| Method | Journey | Repetitions | Observable pass condition |
|---|---|---:|---|
| `agentify_query` | LIVE-QUERY | 3 | Three distinct Pro runs finish `success`, each with confirmed `extended-pro`, a completion receipt, and saved response bytes. |
| `agentify_research` | LIVE-RESEARCH | 2 | Two Deep Research runs finish with distinct conversations, canonical Markdown artifacts, matching `research-report` receipts, and byte-verified hashes. |
| `agentify_read_page` | LOCAL-BROWSER | 2 | The owned tab returns non-empty ready-page text before and after navigation. |
| `agentify_read_conversation` | LIVE-CONVERSATION | 2 | Two warm captures return verified transcript paths; the second capture has the same normalized content when no turn changed. |
| `agentify_download_conversation_artifacts` | LIVE-CONVERSATION | 1 | A selected inventoried file card is saved locally and its bytes match the generated sentinel content. |
| `agentify_status` | LOCAL-BROWSER | 2 | Status identifies the same owned ready tab before and after navigation. |
| `agentify_stop_query` | LIVE-QUERY | 1 | A deliberately long owned run reaches `stopped`, records `stopRequested`, and releases its provider slot. |
| `agentify_list_runs` | LOCAL-OPERATIONS | 2 | Default listing includes active test runs and later excludes the archived test run; archived listing still includes it. |
| `agentify_get_run` | LIVE-QUERY | 3 | One compact live snapshot and two terminal snapshots agree with the corresponding durable run revisions and omit replay payloads. |
| `agentify_wait_run` | LIVE-QUERY | 3 | Each wait returns only after a validated output manifest and includes the saved response markdown. |
| `agentify_image_gen` | LIVE-MEDIA | 1 | Thinking mode produces at least one locally saved image path. |
| `agentify_import_selected_chatgpt_export` | CONTROLLED-LIBRARY | 2 | A deterministic dialog at the production picker contract selects a real ZIP; the exact MCP method grants and completes the import without returning the path or grant. |
| `agentify_import_chatgpt_export` | CONTROLLED-LIBRARY | 2 | A valid controlled one-use grant is consumed once per run and produces the expected complete import. |
| `agentify_list_chatgpt_imports` | CONTROLLED-LIBRARY | 2 | The disposable import appears after import and reflects its later reassignment state without archive paths or record text. |
| `agentify_reassign_chatgpt_import` | CONTROLLED-LIBRARY | 1 | The disposable import changes to the new profile scope, clears prior snapshots, and reports `changed: true`. |
| `agentify_verify_catalog_conversation` | CONTROLLED-LIBRARY | 2 | The exact MCP method receives a verified route outcome from the production route-verifier contract and persists the canonical route. |
| `agentify_list_chatgpt_catalog` | CONTROLLED-LIBRARY | 2 | The imported item is listed and its route is observed as verified after promotion. |
| `agentify_track_transcript` | LIVE-TRANSCRIPT | 1 | The exact owned conversation becomes one local source with the requested label, tags, key, and profile scope. |
| `agentify_sync_transcript` | LIVE-TRANSCRIPT | 2 | Initial and post-continuation syncs finish complete; the second advances to a new snapshot. |
| `agentify_list_transcripts` | LIVE-TRANSCRIPT | 2 | The owned source is listed while tracked and absent after local forget. |
| `agentify_get_transcript` | LIVE-TRANSCRIPT | 2 | Two cursor-bound pages return whole structured turns with exact immutable citations and a stable snapshot. |
| `agentify_forget_transcript` | LIVE-TRANSCRIPT | 1 | Forget removes only the owned source and reports a recoverable local tombstone. |
| `agentify_navigate` | LOCAL-BROWSER | 1 | The owned tab reaches the requested allowed ChatGPT URL and reports the resulting URL. |
| `agentify_ensure_ready` | LOCAL-BROWSER | 2 | Cold and warm readiness calls both return ready for the owned tab. |
| `agentify_show` | LOCAL-BROWSER | 1 | The owned tab window is shown and the method returns success. |
| `agentify_hide` | LOCAL-BROWSER | 1 | The same window is minimized and the method returns success. |
| `agentify_tabs` | LOCAL-BROWSER | 3 | The owned tab is absent, then present exactly once, then absent after close. |
| `agentify_tab_create` | LOCAL-BROWSER | 1 | Creation returns a new owned tab with the requested key and mode intent. |
| `agentify_tab_close` | LOCAL-BROWSER | 1 | Closing the owned tab succeeds and later listing no longer contains its id. |
| `agentify_list_watch_folders` | LOCAL-CONTEXT | 3 | Listing excludes the target before add, includes target and decoy exactly once, then excludes only the removed target. |
| `agentify_add_watch_folder` | LOCAL-CONTEXT | 1 | A run-owned private temporary directory is registered under the owned name. |
| `agentify_remove_watch_folder` | LOCAL-CONTEXT | 1 | The owned watch entry is removed while the caller-owned directory remains on disk. |
| `agentify_open_watch_folder` | LOCAL-CONTEXT | 1 | The owned watch directory is opened through the platform shell and the method returns success. |
| `agentify_scan_watch_folder` | LOCAL-CONTEXT | 3 | First scan indexes exact target and decoy bytes, second scan reports no duplicate, and a post-mutation scan reindexes only the target. |
| `agentify_save_bundle` | LOCAL-CONTEXT | 1 | An owned bundle persists its exact prefix and safe context path. |
| `agentify_list_bundles` | LOCAL-CONTEXT | 3 | Target and decoy appear after save; after restart and target deletion, only the decoy remains. |
| `agentify_get_bundle` | LOCAL-CONTEXT | 3 | Retrieval returns the exact target before restart and exact target plus decoy after restart. |
| `agentify_delete_bundle` | LOCAL-CONTEXT | 2 | Target deletion preserves the decoy; decoy deletion occurs only during owned cleanup. |
| `agentify_save_artifacts` | LIVE-MEDIA | 1 | Generic save records at least one latest assistant image or file for the owned media tab. |
| `agentify_list_artifacts` | LIVE-MEDIA | 2 | Listing exposes the newly saved owned artifact and remains stable on the second read. |
| `agentify_open_artifacts_folder` | LIVE-MEDIA | 1 | The owned tab artifact directory opens through the platform shell and the method returns success. |
| `agentify_open_run` | LOCAL-OPERATIONS | 1 | Reopening a completed owned run restores its saved conversation URL and reports the matching tab. |
| `agentify_retry_run` | LOCAL-OPERATIONS | 1 | Replay creates a new run with `retryOf` pointing to the owned original and finishes with its own receipt. |
| `agentify_archive_run` | LOCAL-OPERATIONS | 1 | Archiving the owned run sets `archivedAt` and changes default versus archived listing visibility. |
| `agentify_download_images` | LIVE-MEDIA | 1 | The latest assistant image is downloaded to a local path and is a decodable non-empty image file. |
| `agentify_shutdown` | LOCAL-ADMIN | 1 | The desktop exits cleanly; a later authenticated MCP method starts a different server id. |
| `agentify_rotate_token` | LOCAL-ADMIN | 1 | Rotation succeeds; the old token receives 401 and a fresh MCP connection succeeds with the new token. |

## Evidence rule

Every run receipt records the exact command, git SHA and dirty state, exercised entry
and digest, fixture identity, returned status, referenced artifact paths or hashes,
cleanup, and one of `verified`, `product-fail`, `oracle-defect`, `fixture-gap`,
`env-gap`, `driver-gap`, or `flake`. Desktop receipts additionally record the Electron
binary, build, driver, window, launch sessions, and persistence observation.

## Current evidence — 2026-08-30

All 47 methods have at least one successful public-boundary execution. The strongest
local receipts are:

- `node scripts/e2e-transcript-library.mjs` — `transcript-library-local-recovery-v0`,
  four Electron launches, three stdio MCP launches, real ZIP bytes, crash/relaunch,
  screenshots, private-mode checks, and owned-state cleanup;
- `node scripts/e2e-mcp-local-state.mjs` — `mcp-local-state-v1`, watch mutation,
  decoy preservation, bundle relaunch, token rotation, shutdown/restart, and cleanup;
- `node scripts/e2e-mcp-live-browser.mjs` — `mcp-live-browser-v1`, authenticated
  owned-tab create/ready/read/navigate/show/hide/close with no provider text persisted;
- `node scripts/e2e-mcp-catalog-import.mjs` — `mcp-catalog-import-v1`, repeated
  real-ZIP selected and direct imports plus exact route promotion through stdio MCP;
- Deep Research runs `b3398fa7-8e64-4c53-9d0a-d753360fde26` and
  `11d71f18-62cf-4f3c-a217-f4d26a252e14` — distinct conversations and canonical
  `response.md` artifacts with matching `research-report` receipt hashes;
- `npm test` — 849 tests passed after the lifecycle, waiter, input, and Deep Research
  compatibility changes.

### Repeated query path

The main query path completed repeatedly with distinct work:

- run `5543ea82-0fca-4cc1-abee-d56236dbbe2d` — Pro adversarial review;
- run `33731abe-71ad-4c4d-bcfe-b18347e5089c` — Pro E2E-oracle review;
- run `a99f7c94-f244-49f2-87a1-c306e19406c9` — downloadable file-card fixture;
- run `ed678728-6776-46d0-8d51-b66304770585` — Pro lifecycle review that found
  legacy receipt and partial stop-evidence defects;
- run `9390d431-b4ea-422f-abe6-bca6bcadb8f3` — Pro appeal that found normalized
  discriminator gaps;
- run `c43d42b3-28c3-4a55-b003-fe272aa87000` — final narrow Pro appeal;
- retry run `ee8f70e4-5819-45fa-91ed-7c1dbd9978a2` — successful public
  `agentify_retry_run` replay of the final appeal, with `retryOf` pointing to the
  source run, a later `capturedAt`, and distinct artifact ids and paths.

These runs also exercised compact snapshots, caller-only wait timeouts, receipt-backed
wait completion, conversation capture, queued stop, transcript continuation, run
opening/listing/archive, artifact listing/opening, and exact file-card download. One
false success on Pro progress chrome was reproduced and fixed before later runs were
accepted.

### Successful method set (47)

`agentify_query`, `agentify_research`, `agentify_read_page`, `agentify_read_conversation`,
`agentify_download_conversation_artifacts`, `agentify_status`, `agentify_stop_query`,
`agentify_list_runs`, `agentify_get_run`, `agentify_wait_run`, `agentify_image_gen`,
`agentify_import_selected_chatgpt_export`, `agentify_import_chatgpt_export`,
`agentify_list_chatgpt_imports`, `agentify_reassign_chatgpt_import`,
`agentify_verify_catalog_conversation`, `agentify_list_chatgpt_catalog`,
`agentify_track_transcript`,
`agentify_sync_transcript`, `agentify_list_transcripts`, `agentify_get_transcript`,
`agentify_forget_transcript`, `agentify_navigate`, `agentify_ensure_ready`,
`agentify_show`, `agentify_hide`, `agentify_tabs`, `agentify_tab_create`,
`agentify_tab_close`, `agentify_list_watch_folders`, `agentify_add_watch_folder`,
`agentify_remove_watch_folder`, `agentify_open_watch_folder`,
`agentify_scan_watch_folder`, `agentify_save_bundle`, `agentify_list_bundles`,
`agentify_get_bundle`, `agentify_delete_bundle`, `agentify_save_artifacts`,
`agentify_list_artifacts`, `agentify_open_artifacts_folder`, `agentify_open_run`,
`agentify_archive_run`, `agentify_retry_run`, `agentify_download_images`,
`agentify_shutdown`, and `agentify_rotate_token`.

### Deep Research happy path

The stalled runs had completed reports. Agentify was blind to them because both
browser backends matched `connector_openai_deep_research...`, while the current child
target hostname is `connector-openai-deep-research...`. The target also reports no
`parentId` when several report tabs are open, so the fixed backends bind the current
page's iframe owner `frameId` to the matching target id before using legacy fallbacks.

Short Deep Research results currently render as sourced assistant turns without a
provider-native Markdown download control. Agentify stores the canonical result as
`response.md`; the `research-report` receipt binds that Markdown artifact, its hash,
and the conversation URL. The full diagnosis is retained in
`docs/plans/2026-08-30-002-fix-deep-research-activation-follow-up.md`.

### Remaining acceptance limitations

The catalog methods have successful public-boundary contract-fixture runs, but the
native macOS picker and live ChatGPT route navigation remain unautomated. The Computer
Use bridge still fails before app inspection with `process is not defined`. These are
limitations of the evidence, not incomplete MCP happy paths.
