# Response mode verification

The three reported Pro-to-Thinking failures were false mode detections. Metadata
on each exact assistant message records `gpt-5-6-pro`, including its resolved
model. The old footer parser read the composer's `Medium` label as Thinking.
These observations do not establish that a Pro usage limit was reached.

## Revision and scope

Baseline: `b4c4d0e`. The table records the working-tree source used for the
live checks before the final gate repairs below.
Electron 39.6.0 and ChatGPT web observed on 2026-10-11 were used; ChatGPT did
not expose a web release version.

| Source | SHA-256 |
| --- | --- |
| `chatgpt-response-mode.mjs` | `fd32d3f5343253784850dcfd228f63c47b4f4f3ad71b832338c4bf2f5ed80a14` |
| `chatgpt-controller.mjs` | `a45ca7bbf4ac25aa277796a84fa7e33c1df2e817564b58b883656d492193598d` |
| `electron-browser-backend.mjs` | `c17e0f98d32508a052f1efd225550bed0574bb443e837e9d46c3401d0265d2b1` |
| `chrome-cdp-backend.mjs` | `794d4d4b995abf1bb7af0d3cef689bb2b628236f29af1230a2cf151448bfad23` |
| `http-api.mjs` | `49cdcd6fbdb0da899c595a8785b0385111b2975befd1de6f9c367377cc755ced` |

The initial phase loaded only existing conversations and sent no provider
prompts. Three new wiki-derived queries subsequently ran with scoped consent;
the live checks and their separate delivery failure are recorded below.

## Native observations

The production `ElectronPageAdapter.readResponseMode` method reloaded each
conversation and read its authenticated
`/backend-api/conversations/<conversation-id>` response. Each response was
HTTP 200. The payload's flat `messages` array supplied the exact saved answer ID;
conversation defaults and composer controls were not used as answer evidence.

| Previously failed answer | Message model | Resolved model | Interpreted mode |
| --- | --- | --- | --- |
| Original long answer | `gpt-5-6-pro` | `gpt-5-6-pro` | `extended-pro` |
| First short acceptance answer | `gpt-5-6-pro` | `gpt-5-6-pro` | `extended-pro` |
| Second short acceptance answer | `gpt-5-6-pro` | `gpt-5-6-pro` | `extended-pro` |

The production shared reader also returned Pro for the second short answer
through the real Chrome DevTools Protocol connection to Electron.

An initial native-adapter probe failed an assertion. Its cause was not
established. A rerun waited for application state readiness and supplied the
application's configured user agent; all three exact-answer checks passed.
That rerun confirms the native read, but does not identify the initial failure's
cause. All owned probe windows were closed; the default ChatGPT page remained.

## Result handling

`chatgpt-response-mode.mjs` accepts response metadata only for the exact
conversation and assistant message. It rejects duplicate IDs, other roles,
requested-only metadata, and mismatched conversations. An unrecognized model
or unavailable metadata leaves mode verification unverified.

`chatgpt-controller.mjs` reads actual response metadata after capturing a
qualified answer. A host deadline preserves the captured answer while preventing
new work on a tab whose native commands have not settled. It does not terminate
renderer evaluation for these native reads.

`http-api.mjs` saves the qualified answer before enforcing a confirmed mode
mismatch. The run returns `mode_intent_activation_failed`, keeps its
`outputManifest`, records the actual mode, and remains `error` without a success
completion receipt. Wait/get output can still return the saved answer.
Missing or unknown mode metadata produces an explicit mode-unverified label.

## Regression evidence and remaining acceptance

`npm test` passed: 1,018 tests, zero failures or skips. Regression coverage
includes exact message binding, Pro versus Thinking metadata, unavailable
metadata, delayed native command settlement, adapter listener cleanup, and
saved answer retrieval from a failed downgraded run. Removing the host deadline's
quarantine caused all four delayed-command cases to fail their intended checks.
`git diff --check` passed.

Native metadata reads and fresh public Pro query/wait/get/open checks passed.
A real provider quota downgrade has not been induced; its answer-retention
behavior is covered by controlled HTTP regression tests.

## Live wiki queries

Three new wiki-derived requests ran through `agentify_query` with explicit
`modeIntent: "extended-pro"`. Each was observed through `agentify_get_run` while
running, awaited through `agentify_wait_run`, reopened with `agentify_open_run`,
and checked again through its saved output. All three confirmed Pro before send
and returned exact-answer model and resolved-model metadata of `gpt-6-pro`.

| Request | Run | Actual model | Saved bytes | Response SHA-256 | Delivery |
| --- | --- | --- | ---: | --- | --- |
| Rival explanations | `bc6b0f54-cff1-4121-b471-f63787493d4f` | `gpt-6-pro` | 8261 | `0cfb530d9b4714991fd53d734211c6a00c5f3872335112bd1eba9f3b4cac0d57` | Complete intended prompt |
| Interaction latency | `7e8d6107-722d-47d8-acf2-4f81cd497e8d` | `gpt-6-pro` | 7866 | `80c0bebd87f2b6157db54636ad4614db5d7bba53d94c0dff12d6762b68ea55dc` | Complete intended prompt |
| Diagram request | `c6dfd17e-a7d9-4b3c-88c2-2b9f46e98a30` | `gpt-6-pro` | 8180 | `60fe6adc6cbf925847a89aa84937b103f801d44e24785f3a3600ce5b6f168825` | Wrong earlier prompt recorded |

Saved bytes matched each completion receipt's hash, and public get/wait output
matched those bytes. Each reopened tab served the run's recorded conversation.
The three owned tabs were closed after verification; the normal app remained
running without a temporary entry or debugging flags. No retry request was sent.

### Wrong prompt during concurrent requests

The diagram run retained the intended diagram prompt in its logical request and
materialized replay. Its immutable transcript instead recorded the first
rival-explanations prompt without that prompt's final paragraph: 1,661 characters
rather than the intended 2,217. Every nonblank line of the intended diagram prompt
was reported missing. The saved answer discusses rival explanations, not diagrams.
The other two user turns match their intended prompts.

The replacement occurred somewhere between the saved replay payload and the
recorded provider user turn. The responsible component has not been isolated.
This happened while the requests ran concurrently; that observation does not
establish concurrency as its cause. The public query checklist remains failing
for this delivery defect even though the response-mode checks passed.

### Wait connection limitation

One connector wait returned an error without structured run metadata while that
run still reported generating. Fresh stdio MCP waits returned successful terminal
metadata for all three requests without resending them. The connector error's
cause was not isolated; it did not establish a provider failure.

## Final gate repairs

The gate reproduced a stalled conversation-URL read after answer capture and a
separate API result inconsistency after a rejected URL lookup. The controller
now carries the conversation URL captured with the qualified answer. Metadata
verification and query output saving use that context without another URL read.

The API derives actual mode and degradation claims only from metadata that
passes exact-answer binding. Saved manifests, terminal run labels, and public
query metadata use that same validated result; a rejected binding cannot restore
raw earlier mode claims. Public unknown-mode notices therefore agree with the
saved verification state.

The unused footer-parser import was removed. The earlier probe's stale pending
statement was corrected. No historical run or artifact reader was removed.

Regression checks failed before these repairs at the intended answer-return and
mode-reporting assertions, then passed after implementation. The targeted
mode, metadata, recovery, deadline, and adapter checks passed: 72 tests.
The original live evidence remains associated with the earlier hashes above;
these gate repairs have not consumed additional provider requests.

| Final repaired source | SHA-256 |
| --- | --- |
| `chatgpt-controller.mjs` | `c43c02b29139de959be1e06902d73e20d138b57a1b4adf1d10e1cd3e52bcf6af` |
| `http-api.mjs` | `804d94945f62d5aa110ccf297720aeaa9f5189026fe01b45bed8cbb5ef4da551` |

The final local `npm test` run passed: 1,022 tests, zero failures or skips.
The invariant and failure-mode reviewers rechecked the repaired dependencies
with independent probes and found no remaining issue in those scopes. The
separate wrong-prompt defect still prevents overall query acceptance.

## Composer replacement — 2026-10-12

Checked with Electron 39.6.0 on the ChatGPT page observed on 2026-10-12. The page build identifier was not captured. The production controller changed from base `66eaac2`; the controller source digest is `b0ccb0eb18cf3515b02d2dcc7702d20ca4049ef6ce574e527470ff48f20c6587`.

An inherited draft could extend above the viewport. On the base controller, a composer click at (436, -177) removed editor focus after Pro selection. Clearing and insertion then left the inherited text in place. Send accepted that nonempty text. A matching native reproduction captured the inherited prompt in the request body; the original reported run did not record its focus events.

The controller now clips the click to the viewport, resolves and focuses the current editor after pointer input, and checks the ordinary replacement path's staged text before Send. Textarea values retain exact text after line-ending normalization. Rich editor text folds rendered whitespace while preserving ordered words and punctuation. Focus or staging failures return HTTP 409 without a success receipt. Inline research selection retains its existing insertion path.

### Verification

- The original regression cases failed on the base controller and pass after the repair. The repository suite passed 1,033 tests. The affected prompt cases passed again after removing an unused test-fixture option.
- Native checks cover an inherited draft followed by Pro selection, and prompt entry overlapping across two windows.
- Each captured request containing prompt text requested Pro and contained the intended replacement prompt exactly after removing the automatic Markdown wrapper around a known URL.
- Owned-window POSTs were intercepted at the Fetch request stage and failed locally. Failure commands were acknowledged and corresponding network failures were observed. A local server control showed the blocker prevented delivery while its unblocked control reached the server.
- The successful runs started with an empty default composer. The probe now refuses every nonempty default draft; controlled checks cover unknown content and content matching earlier probes. Owned test drafts were cleared and owned windows closed.
- Execution-time records identify the loaded controller class, native driver, Electron binary, fixture digest, and source files. Those source files remained unchanged throughout each run.

### Evidence limits

These native checks exercise the real controller and Electron input against ChatGPT. Full public MCP response completion and retry remain unverified after this repair. No new provider answer was generated, and provider billing was not independently measured. The network error did not match the probe's literal blocked-error flag; explicit failure acknowledgments and subsequent failure events support the interception claim.

## Native editing and immediate restart — 2026-10-12

Checked with Electron 39.6.0 from base `66e3cf3`. The patched source digests are `a8b42efbc3c3ad77e989ddc665014d880f7d2d10b8a36c9acbefcc7b43dac32c` for `electron-browser-backend.mjs` and `65296cd1f18ae71412d457f254c59e05b5b0552ee4dbaeacd7f720c43210648f` for `mcp-lib.mjs`.

On an owned native textarea, synthetic Command+A did not select the draft and Shift+Return did not insert a newline. The production controller rejected the resulting text with `prompt_staging_failed` before Send. The Electron adapter now uses the native select-all command for the platform shortcut and native newline insertion for a focused textarea. Rich text editors retain their Shift+Return key events.

An immediate relaunch also failed after public shutdown: the old Electron process still held its single-instance lock, the newly launched process failed to acquire it and exited successfully, and the launcher waited on stale state until its deadline. The launcher now retries after the process it spawned exits normally before the API is ready. It checks for a healthy server before each launch attempt. A live launcher is not duplicated and a launcher that exits with an error is not repeatedly spawned. Retained PIDs are not used as ownership proof. Connection validation and startup share one deadline.

### Verification

- Regression checks cover normal launcher exit, an unresponsive live launcher, a failed launcher, a stale PID belonging to another process, and health-check cancellation. The native editing regressions failed on the base source and pass on the patched source. The repository suite and targeted launcher checks passed.
- The actual production controller staged both a 22-character multiline prompt and a 680-character multiline prompt through the native Electron adapter. Exact textarea values matched without trimming. Owned rich-editor fixtures preserved text and their newline handlers. No editing method was replaced by the probe. Send was intercepted at the local controller boundary.
- A fresh public stdio MCP process exercised shutdown followed immediately by status twice. In both cases the old process was alive when shutdown returned. Status succeeded after 7,878 ms and 6,376 ms, respectively, with different process and server identities. Observed launchers exited normally before each successful replacement launch. The probe inserted no process-exit wait. The final app returned a visible, unblocked composer after public ensure-ready.
- No provider prompts were sent by these editing and restart checks. The normal desktop entry remains running. Existing MCP clients load the changed launcher after their MCP server process restarts.

### Evidence limits

The editing checks use owned local textarea and rich-editor fixtures. They prove native staging, not a fresh ChatGPT answer on this revision. Earlier public Pro retry and Thinking query checks ran on `66e3cf3` before these adapter and launcher changes. The older connector wait failure's original error content was not retained, so its cause remains unknown.
