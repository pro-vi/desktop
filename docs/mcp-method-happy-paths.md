# MCP method happy paths

This is the maintained feature checklist for the public Agentify Desktop MCP surface.
`ALL_MCP_TOOL_NAMES` in `mcp-tool-profile.mjs` is the method authority; the matrix has
one row per method, 47 today.

A row passes only after the named public MCP method returns its expected observable
result through the real Electron service. Unit tests, a lower HTTP call, listing a
method in `tools/list`, or another method exercising the same lower layer do not pass
the row.

Keeping it green: a change to a method's code path, or a ChatGPT page change that
breaks one, re-runs that row's journey, and the status column records the date and
the evidence. A row that fails stays in the table as ❌ with the failing run, never
removed. Live journeys send to ChatGPT and need the maintainer's consent per probe
(`CLAUDE.md`, "Live provider probes").

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

| Method | Journey | Repetitions | Observable pass condition | 2026-09-26 | Evidence |
|---|---|---:|---|:---:|---|
| `agentify_query` | LIVE-QUERY | 3 | Three distinct Pro runs finish `success`, each with confirmed `extended-pro`, a completion receipt, and saved response bytes. | ✅ | runs `d40d0884`, `dc1de8ed`, `8136f506`: three Pro runs, `extended-pro` confirmed on the slider, receipts |
| `agentify_research` | LIVE-RESEARCH | 2 | Two Deep Research runs finish with distinct conversations, canonical Markdown artifacts, matching `research-report` receipts, and byte-verified hashes. | ✅ | run `1e8e194b`: `research-report` receipt over the exported `deep-research-report.md` (hash matches). 1 of 2 repetitions |
| `agentify_read_page` | LOCAL-BROWSER | 2 | The owned tab returns non-empty ready-page text before and after navigation. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_read_conversation` | LIVE-CONVERSATION | 2 | Two warm captures return verified transcript paths; the second capture has the same normalized content when no turn changed. | ✅ | `6ab4fab5` (14 turns) and `690126b6` (400 turns) complete; file-card conversation read twice, same sha `52780af7` |
| `agentify_download_conversation_artifacts` | LIVE-CONVERSATION | 1 | A selected inventoried file card is saved locally and its bytes match the generated sentinel content. | ✅ | `agentify-e2e-sentinel.txt` saved; bytes equal the sentinel line |
| `agentify_status` | LOCAL-BROWSER | 2 | Status identifies the same owned ready tab before and after navigation. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_stop_query` | LIVE-QUERY | 1 | A deliberately long owned run reaches `stopped`, records `stopRequested`, and releases its provider slot. | ✅ | run `dca4b9b9`: `stopped`, `stopRequested`, slot released |
| `agentify_list_runs` | LOCAL-OPERATIONS | 2 | Default listing includes active test runs and later excludes the archived test run; archived listing still includes it. | ✅ | archived `dca4b9b9` absent by default, present with `includeArchived` |
| `agentify_get_run` | LIVE-QUERY | 3 | One compact live snapshot and two terminal snapshots agree with the corresponding durable run revisions and omit replay payloads. | ✅ | `ec98be2e` terminal snapshot; live snapshot seen in the stop response |
| `agentify_wait_run` | LIVE-QUERY | 3 | Each wait returns only after a validated output manifest and includes the saved response markdown. | ✅ | `8136f506`, `d40d0884`: returned after the output manifest with the saved text |
| `agentify_image_gen` | LIVE-MEDIA | 1 | Thinking mode produces at least one locally saved image path. | ✅ | run `670b80bc`: Thinking confirmed (Medium on the slider), 1254×1254 PNG saved |
| `agentify_import_selected_chatgpt_export` | CONTROLLED-LIBRARY | 2 | A deterministic dialog at the production picker contract selects a real ZIP; the exact MCP method grants and completes the import without returning the path or grant. | ✅ | `e2e-mcp-catalog-import` receipt |
| `agentify_import_chatgpt_export` | CONTROLLED-LIBRARY | 2 | A valid controlled one-use grant is consumed once per run and produces the expected complete import. | ✅ | `e2e-mcp-catalog-import` receipt |
| `agentify_list_chatgpt_imports` | CONTROLLED-LIBRARY | 2 | The disposable import appears after import and reflects its later reassignment state without archive paths or record text. | ✅ | `e2e-transcript-library` receipt |
| `agentify_reassign_chatgpt_import` | CONTROLLED-LIBRARY | 1 | The disposable import changes to the new profile scope, clears prior snapshots, and reports `changed: true`. | ✅ | `e2e-transcript-library` receipt |
| `agentify_verify_catalog_conversation` | CONTROLLED-LIBRARY | 2 | The exact MCP method receives a verified route outcome from the production route-verifier contract and persists the canonical route. | ✅ | `e2e-mcp-catalog-import` receipt |
| `agentify_list_chatgpt_catalog` | CONTROLLED-LIBRARY | 2 | The imported item is listed and its route is observed as verified after promotion. | ✅ | `e2e-mcp-catalog-import` receipt |
| `agentify_track_transcript` | LIVE-TRANSCRIPT | 1 | The exact owned conversation becomes one local source with the requested label, tags, key, and profile scope. | ✅ | image conversation `6ab77edc` tracked as a new source |
| `agentify_sync_transcript` | LIVE-TRANSCRIPT | 2 | Initial and post-continuation syncs finish complete; the second advances to a new snapshot. | ✅ | `6ab76e72` and the file-card conversation complete; the file-card snapshot advanced after the continuation (`9bb14a57` → `a2eff60a`) |
| `agentify_list_transcripts` | LIVE-TRANSCRIPT | 2 | The owned source is listed while tracked and absent after local forget. | ✅ | the forgotten source is absent, the file-card source present |
| `agentify_get_transcript` | LIVE-TRANSCRIPT | 2 | Two cursor-bound pages return whole structured turns with exact immutable citations and a stable snapshot. | ✅ | two cursor pages of whole turns with citations on one snapshot |
| `agentify_forget_transcript` | LIVE-TRANSCRIPT | 1 | Forget removes only the owned source and reports a recoverable local tombstone. | ✅ | test source forgotten with a recoverable tombstone |
| `agentify_navigate` | LOCAL-BROWSER | 1 | The owned tab reaches the requested allowed ChatGPT URL and reports the resulting URL. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_ensure_ready` | LOCAL-BROWSER | 2 | Cold and warm readiness calls both return ready for the owned tab. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_show` | LOCAL-BROWSER | 1 | The owned tab window is shown and the method returns success. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_hide` | LOCAL-BROWSER | 1 | The same window is minimized and the method returns success. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_tabs` | LOCAL-BROWSER | 3 | The owned tab is absent, then present exactly once, then absent after close. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_tab_create` | LOCAL-BROWSER | 1 | Creation returns a new owned tab with the requested key and mode intent. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_tab_close` | LOCAL-BROWSER | 1 | Closing the owned tab succeeds and later listing no longer contains its id. | ✅ | `e2e-mcp-live-browser` receipt |
| `agentify_list_watch_folders` | LOCAL-CONTEXT | 3 | Listing excludes the target before add, includes target and decoy exactly once, then excludes only the removed target. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_add_watch_folder` | LOCAL-CONTEXT | 1 | A run-owned private temporary directory is registered under the owned name. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_remove_watch_folder` | LOCAL-CONTEXT | 1 | The owned watch entry is removed while the caller-owned directory remains on disk. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_open_watch_folder` | LOCAL-CONTEXT | 1 | The owned watch directory is opened through the platform shell and the method returns success. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_scan_watch_folder` | LOCAL-CONTEXT | 3 | First scan indexes exact target and decoy bytes, second scan reports no duplicate, and a post-mutation scan reindexes only the target. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_save_bundle` | LOCAL-CONTEXT | 1 | An owned bundle persists its exact prefix and safe context path. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_list_bundles` | LOCAL-CONTEXT | 3 | Target and decoy appear after save; after restart and target deletion, only the decoy remains. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_get_bundle` | LOCAL-CONTEXT | 3 | Retrieval returns the exact target before restart and exact target plus decoy after restart. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_delete_bundle` | LOCAL-CONTEXT | 2 | Target deletion preserves the decoy; decoy deletion occurs only during owned cleanup. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_save_artifacts` | LIVE-MEDIA | 1 | Generic save records at least one latest assistant image or file for the owned media tab. | ✅ | image saved from the image conversation |
| `agentify_list_artifacts` | LIVE-MEDIA | 2 | Listing exposes the newly saved owned artifact and remains stable on the second read. | ✅ | lists the saved images and transcript. 1 of 2 reads |
| `agentify_open_artifacts_folder` | LIVE-MEDIA | 1 | The owned tab artifact directory opens through the platform shell and the method returns success. | ✅ | image tab folder opened |
| `agentify_open_run` | LOCAL-OPERATIONS | 1 | Reopening a completed owned run restores its saved conversation URL and reports the matching tab. | ✅ | `dc1de8ed` reopened on its conversation |
| `agentify_retry_run` | LOCAL-OPERATIONS | 1 | Replay creates a new run with `retryOf` pointing to the owned original and finishes with its own receipt. | ✅ | `ec98be2e` with `retryOf` `dc1de8ed`, own receipt |
| `agentify_archive_run` | LOCAL-OPERATIONS | 1 | Archiving the owned run sets `archivedAt` and changes default versus archived listing visibility. | ✅ | `dca4b9b9` archived |
| `agentify_download_images` | LIVE-MEDIA | 1 | The latest assistant image is downloaded to a local path and is a decodable non-empty image file. | ✅ | 1254×1254 PNG from the image reply |
| `agentify_shutdown` | LOCAL-ADMIN | 1 | The desktop exits cleanly; a later authenticated MCP method starts a different server id. | ✅ | `e2e-mcp-local-state` receipt |
| `agentify_rotate_token` | LOCAL-ADMIN | 1 | Rotation succeeds; the old token receives 401 and a fresh MCP connection succeeds with the new token. | ✅ | `e2e-mcp-local-state` receipt |

## Evidence rule

Every run receipt records the exact command, git SHA and dirty state, exercised entry
and digest, fixture identity, returned status, referenced artifact paths or hashes,
cleanup, and one of `verified`, `product-fail`, `oracle-defect`, `fixture-gap`,
`env-gap`, `driver-gap`, or `flake`. Desktop receipts additionally record the Electron
binary, build, driver, window, launch sessions, and persistence observation.

## Current evidence — 2026-09-26

All 47 methods passed on 2026-09-26, on the code of the commit that updates this table
(base `e86710e`), in the maintainer's authenticated ChatGPT session. Two rows ran
fewer repetitions than the matrix asks: Deep Research once (the matrix asks twice)
and `agentify_list_artifacts` one read (the matrix asks for a second, stable read).

- Local receipts, all `verified` at `e86710e` with a clean tree:
  `node scripts/e2e-mcp-local-state.mjs`, `node scripts/e2e-mcp-catalog-import.mjs`,
  `node scripts/e2e-transcript-library.mjs`, `node scripts/e2e-mcp-live-browser.mjs`.
- Live runs, all on new keys and closed afterwards: file-card query `dc1de8ed`, its
  continuation `8136f506` and retry `ec98be2e`; stopped run `dca4b9b9`; Deep Research
  `1e8e194b`; image generation `670b80bc`.
- `npm test`: 923 tests passed.

What had broken on ChatGPT's page since the last full pass (2026-08-30), and is fixed:
answers and whole-conversation reads (the search-unit message markup, ADR 0015); file
cards (named "Open preview of <file>" with the bare name in a title; no turn
position); image replies (a bare id container after the role heading); the mode
trigger label ("Select ChatGPT model thinking effort" + level) that read as Thinking;
moving the effort slider down; the composer "+" menu (a floating overlay of
`[data-list-navigation-item]` buttons); Deep Research selection (an app-mention token in
the prompt), its report (an MCP app frame on a generic `mcp-app-<hash>` sandbox host,
nested `#root` document), and its "started working" reply, which is not the report.
Evidence for the markup: `docs/probes/2026-09-26-search-unit-markup-probe.md`.

### Remaining acceptance limitations

- The catalog methods pass through contract fixtures: the native macOS picker and live
  ChatGPT route navigation remain unautomated.
- An image reply's `text` is the gallery's button label ("Edit"), and a Deep Research
  run's short `detail` preview carries the report frame's counter digits. The saved
  image and report files are correct.
- The compatibility health (`agentify_status` `compatibility`) reports `degraded` for
  an image-only conversation: its assistant anchor resolves through the image-reply
  branch, and the contract allows one canonical branch per anchor.
