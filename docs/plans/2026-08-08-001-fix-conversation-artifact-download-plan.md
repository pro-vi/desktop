---
title: Conversation Artifact Capture
objective: Agentify reports and retrieves files attached anywhere in a ChatGPT conversation without opening a native Save dialog.
type: fix
status: active
date: 2026-08-08
origin: standalone conversation and live probe of https://chatgpt.com/c/6a759b6a-7b5c-83e8-b94e-9cb65ff2de27
---

## Background

The supplied conversation contains three file cards:

- `jing_atlas_product_spec.md`
- `jing_atlas_source_manifest.yaml`
- `jing_atlas_phase_plan.yaml`

Each card uses a named open button plus a sibling `button[aria-label="Download file"]`. The current scanner only searches anchors in the latest assistant response, so it reports none of them. A manual probe clicked a download button without first installing Agentify's Electron download listener; macOS therefore opened a native Save dialog. The dialog was cancelled and no file was saved.

Agentify already has the required authenticated download seam in both browser backends. Electron listens for `will-download` and assigns a destination with `setSavePath`; Chrome configures CDP download behavior. Existing research export code establishes the required order: arm `page.waitForDownload`, click, then await completion.

ChatGPT Canvas documents were not present in the supplied conversation. Canvas support remains probe-gated and is not part of the file-support claim.

## Requirements

- **R1** — report file attachments from every assistant turn, including virtualized earlier turns.
- **R2** — download through ChatGPT's authenticated browser session without opening a Save dialog.
- **R3** — preserve the existing transcript contract and the meaning of transcript `complete`.
- **R4** — return one explicit outcome per requested file; partial failure must not hide successful files.
- **R5** — validate and register saved files without persisting credentials or signed URLs.
- **R6** — apply file-count and byte limits to batch downloads.
- **R7** — claim Canvas support only after a live Canvas-document probe establishes its provider contract.

## Naming Ledger

| Role / meaning | Existing repo term | Chosen name | Owner / placement | Status | GR6 sibling disposition |
|---|---|---|---|---|---|
| Provider-side output attached to a conversation | artifact | `conversation artifact` | `conversation-artifact-contract.mjs` | new specialization | Existing artifact remains the generic local category |
| Exact description of one observed provider output | none | `ConversationArtifactDescriptor` | contract module | new | Distinct from a saved artifact record |
| Stable selection identity independent of filename | none | `artifactKey` | contract module | new | Local artifact-store UUID remains unchanged |
| Result of scanning the whole conversation | none | `artifactInventory` | read-conversation response | new | Transcript `complete` remains separate |
| Terminal result for one requested download | none | `ConversationArtifactDownloadOutcome` | contract module | new | Existing latest-response download shape remains unchanged |
| Provenance attached to a saved local file | loose `meta` | `ConversationArtifactProvenance` | exact parser before artifact-store writes | new | Generic artifact metadata remains available |
| Full-conversation mutation command | `agentify_save_artifacts` | `agentify_download_conversation_artifacts` | MCP server | new | Existing tool retains latest-response semantics |
| Provider compatibility anchor for file cards | broad `file` capability | `conversation-artifact-file-card` | compatibility map | new | Research-export capability remains unchanged |

## Architecture Decision

**Approach:** Add a typed artifact inventory beside the existing transcript result, then expose a separate download command that rescans the conversation and downloads selected files through the authenticated browser.

The virtualized transcript scanner collects file-card descriptors while each assistant turn is mounted. It publishes them as a sidecar rather than inserting them into transcript turns. Downloading is an explicit mutation: confirm the conversation, remount the owning turn, match the full `artifactKey`, arm `page.waitForDownload`, click the exact card, await and validate the saved file, then register it with credential-free provenance.

**Rejected approach:** Calling ChatGPT's private download endpoint from Node. That route depends on browser authentication, account headers, temporary signed URLs, and provider internals. It would move authentication material across a boundary where Agentify does not need it.

**Consequences:** Reads remain free of filesystem writes. Downloads are sequential inside one exclusive tab operation. Transcript storage, hashes, and schema version remain unchanged. The first contract version contains only `kind: "file"`; Canvas is added only after R7 passes.

**Approval criteria:** Accept an additive read-response sidecar, a separate core MCP mutation, sequential authenticated downloads, and no Canvas claim in the first implementation.

## Program Obligations

- **O1:** Descriptor, inventory, provenance, and download outcomes have exact parsers in one versioned authority.
- **O2:** Download outcomes are a closed discriminated union, exhaustively handled by HTTP and MCP consumers.
- **O3:** `artifactKey` derives from conversation identity, provider message identity, and occurrence within that message. Filename is not identity.
- **O4:** Transcript completeness and inventory completeness remain independent axes.
- **O5:** The download primitive enforces byte limits in Electron and Chrome and deletes rejected partial files.
- **O6:** Artifact indexes and MCP output never contain signed URLs, cookies, authorization headers, sandbox paths, or raw DOM HTML.

## High-Level Technical Design

```text
agentify_read_conversation
  -> HTTP read operation and exclusive tab lease
  -> virtualized scanner
       -> existing transcript projection and contract
       -> exact artifactInventory sidecar

agentify_download_conversation_artifacts
  -> exact request parser
  -> conversation navigation and exclusive tab lease
  -> for each artifactKey, sequentially
       -> mount owning assistant turn
       -> match message + occurrence + observed name
       -> arm waitForDownload with byte limit
       -> click exact download control
       -> await browser-authenticated completion
       -> validate path, file type, size, and name
       -> register with safe provenance
  -> closed per-item outcome list
```

Directional read-response shape:

```js
{
  // Existing transcript fields remain unchanged.
  complete,
  reason,
  text,
  transcript,
  artifactInventory: {
    status: "complete" | "partial",
    reason: null | string,
    items: [{
      artifactKey,
      providerMessageId,
      providerTurnIndex,
      occurrenceWithinMessage,
      name,
      kind: "file"
    }]
  }
}
```

### Representation authority

| Concept | Authority | Other representations |
|---|---|---|
| Transcript | Existing `transcript-contract.mjs` | Legacy text response and stored transcript projections |
| Conversation artifact | New exact contract module | DOM observations, HTTP JSON, MCP structured output |
| Browser download | Existing `page.waitForDownload` contract | Electron and Chrome lifecycle-specific implementations |
| Saved file | Existing artifact store | Conversation provenance stored as parsed metadata |
| Provider markup | Compatibility map | Live DOM and test fixtures |

## Multi-item Download Contract

| State or action | Required behavior and locking test |
|---|---|
| Supported item found | Return `saved`; create a validated file and artifact record; expose no provider URL; serialize concurrent work through the tab lease. Test: `selected file downloads and registers`. |
| Requested key absent after full rescan | Return `not_found`; create no file or record; allow siblings to continue. Test: `missing artifact returns not_found`. |
| Unsupported kind | Return `unsupported`; perform no click or write; allow siblings to continue. Test: `unsupported item does not block supported siblings`. |
| Timeout or provider failure | Return `download_failed`; remove partial output; register nothing; clean up listeners. Test: `timed-out download leaves no artifact`. |
| Byte limit exceeded | Return `size_limit_exceeded`; cancel and remove partial output; allow siblings to continue. Test: `oversized download is cancelled and not registered`. |
| Interrupted after earlier successes | Preserve completed files and records. A retry starts a new attempt and may use a collision suffix. Test: `retry after interruption preserves prior registered files`. |
| Conversation changes during rescan | Return `conversation_changed`; click nothing unmatched; preserve completed siblings. Test: `rescan rejects changed conversation`. |
| Empty selection | Return an empty outcome list without clicks or filesystem writes. Test: `empty selection performs no downloads`. |

Invariants:

- An outcome is `saved` iff its validated file has a corresponding artifact-store record.
- Registration occurs only after complete download and filesystem validation.
- Every returned requested key has exactly one terminal outcome.
- A failed item never changes a sibling's outcome.
- Signed provider URLs are absent from persisted and returned representations.
- A click occurs only while its matching download listener is active.
- `artifactInventory.status` is not derived from transcript `complete`.

## Implementation Units

### U1. Conversation file inventory sidecar

- **Goal:** Report file cards from every observed assistant turn without changing stored transcript semantics.
- **Requirements:** R1, R3
- **Dependencies:** None
- **Files:**
  - Create: `conversation-artifact-contract.mjs`
  - Modify: `chatgpt-controller.mjs`, `http-api.mjs`, `mcp-server.mjs`, `chatgpt-compatibility.json`
  - Test: `tests/chatgpt-controller.test.mjs`, `tests/http-api.test.mjs`, `tests/mcp-tool-profile-integration.test.mjs`
- **Approach:** Extract file-card observations in every accepted virtualized window. Deduplicate by provider message and occurrence, exact-parse them, and attach the inventory only to the live read projection.
- **Patterns to follow:** `chatgpt-controller.mjs:1191`, `transcript-contract.mjs:191`, `chatgpt-controller.mjs:2564`.
- **Test scenarios:** Three files across turns produce three ordered keys; repeated windows deduplicate; duplicate filenames remain distinct; an empty conversation has a complete empty inventory; malformed rows make inventory partial; transcript and inventory statuses vary independently.
- **Verification:** The supplied conversation reports all three filenames while legacy transcript fields and hashes remain unchanged.
- **Rollback:** Remove the additive response field and contract module; no stored data migration exists.
- **Runtime evidence:** Live DOM inspection established three button-based cards and their owning message. Earlier-turn virtualization is unverified until tested with an unmounted artifact-bearing turn.
- **Checkpoint:** pause — call `agentify_read_conversation` on the supplied chat and inspect the inventory.

### U2. Bounded native download primitive

- **Goal:** Make both browser backends cancel downloads above the allowed size while preserving cleanup and path safety.
- **Requirements:** R2, R6
- **Dependencies:** None
- **Files:**
  - Modify: `electron-browser-backend.mjs`, `chrome-cdp-backend.mjs`
  - Test: `tests/electron-browser-backend.test.mjs`, `tests/chrome-cdp-backend.test.mjs`
- **Approach:** Extend `waitForDownload` with an explicit byte limit and typed terminal result. Electron uses `DownloadItem` progress and cancellation; Chrome uses CDP progress. Both delete partial files after timeout, cancellation, or excess size.
- **Patterns to follow:** `electron-browser-backend.mjs:274`, `chrome-cdp-backend.mjs:532`.
- **Test scenarios:** Below-limit and exact-limit files save; oversized and timed-out files cancel and leave no partial output; both adapters pass the same contract cases.
- **Verification:** Both backends satisfy the same success, timeout, size-limit, cleanup, and collision behavior.
- **Runtime evidence:** Existing tests prove normal download seams. Size cancellation is unverified until executed in both backends.
- **Checkpoint:** auto — shared backend download-contract tests pass.

### U3. Full-conversation file download command

- **Goal:** Download selected conversation files without a Save dialog and register every successful file.
- **Requirements:** R2, R4, R5, R6
- **Dependencies:** U1, U2
- **Files:**
  - Modify: `conversation-artifact-contract.mjs`, `chatgpt-controller.mjs`, `http-api.mjs`, `mcp-server.mjs`, `mcp-tool-profile.mjs`, `artifact-store.mjs`
  - Test: `tests/chatgpt-controller.test.mjs`, `tests/http-api.test.mjs`, `tests/mcp-server-names.test.mjs`, `tests/mcp-tool-profile-integration.test.mjs`
- **Approach:** Add `/conversation-artifacts/download` and core-profile `agentify_download_conversation_artifacts`. Reuse read-conversation URL resolution, operation scopes, and exclusive execution. Process selected keys sequentially with listener-before-click ordering.
- **Patterns to follow:** `chatgpt-controller.mjs:5917`, `http-api.mjs:730`, `http-api.mjs:4391`.
- **Test scenarios:** All three supplied files save; one key among duplicate filenames clicks only its occurrence; one missing, timed-out, or oversized item does not hide siblings; changed conversation and name mismatch are rejected; listing retains safe provenance without signed URLs.
- **Verification:** Each requested key has one terminal outcome; successful files appear in the artifact list; failed files do not.
- **Rollback:** Remove the additive tool and route. Already registered files remain valid ordinary artifacts.
- **Runtime evidence:** Research export executes listener-before-click. Full-conversation remount-and-click remains unverified until live rehearsal.
- **Checkpoint:** pause — download the supplied three files and inspect outcomes and artifact records.

### U4. Native-dialog regression proof and documentation

- **Goal:** Prove Electron suppresses the Save dialog and document the read/download split.
- **Requirements:** R2, R3, R5
- **Dependencies:** U3
- **Files:**
  - Modify: `README.md`
  - Test: `tests/chatgpt-controller.test.mjs`, `tests/http-api.test.mjs`, `tests/mcp-tool-profile-integration.test.mjs`
- **Approach:** Lock listener-before-click ordering, restart Electron and MCP, then rehearse the supplied chat. Document transcript and inventory completeness separately.
- **Patterns to follow:** project cold-start retry guidance in `CLAUDE.md`; MCP profile docs in `README.md:601`.
- **Test scenarios:** Listener installs before click; supplied chat downloads without Save UI; selector drift makes inventory partial only; no temporary provider credentials reach index or MCP output.
- **Verification:** A live Electron download reaches the artifact store without displaying a Save dialog; the core MCP profile advertises both tools.
- **Runtime evidence:** Unverified until the app and MCP server restart and the supplied chat downloads live.
- **Checkpoint:** pause — observe the live Electron download and confirm no Save dialog appears.

### U5. Canvas-document contract probe

- **Goal:** Establish whether ChatGPT Canvas documents can use the same inventory and authenticated-download lifecycle.
- **Requirements:** R7
- **Dependencies:** U4
- **Files:**
  - Create: `docs/probes/chatgpt-canvas-artifacts.md`
  - Test: provider fixture location chosen from observed markup
- **Approach:** Obtain an authorized conversation containing a real ChatGPT Canvas document. Record public accessibility markup, message association, open/export controls, authenticated request sequence, and native-download behavior. React private fields are diagnostic only and cannot become an implementation dependency.
- **Patterns to follow:** live file-card probe and compatibility fixtures.
- **Test scenarios:** Stable export control; multiple export formats; editor-only export or no stable control.
- **Verification:** Evidence either supports a separate Canvas implementation blueprint or records a concrete unsupported reason.
- **Runtime evidence:** Unverified — the supplied conversation contains no Canvas document.
- **Checkpoint:** pause — review captured Canvas evidence before planning an adapter.

## Scope Boundaries

- Do not change transcript schema version 1, normalized hashes, or stored raw-turn shapes.
- Do not extend `agentify_save_artifacts`; it keeps latest-assistant semantics.
- Do not call private ChatGPT download endpoints from Node.
- Do not persist signed URLs, authentication headers, cookies, sandbox paths, or provider HTML.
- Do not download as a side effect of `agentify_read_conversation`.
- Do not parallelize downloads within one tab.
- Do not identify artifacts by filename.
- Do not claim Canvas support before U5 passes.

### Deferred to Follow-Up Work

- Canvas retrieval implementation after U5 establishes the provider contract.
- Control-center download UI.
- Transcript-library artifact persistence.
- Shared filename sanitization only if backend equivalence cannot be locked by tests.

## System-Wide Impact

- **Interaction graph:** MCP → HTTP operation scope → controller scanner → browser adapter → filesystem validation → artifact store.
- **Error propagation:** Provider/backend failures are typed per-item outcomes. Request-level errors remain for malformed input, invalid ownership, or inability to start.
- **State lifecycle:** Registration follows completion and validation. Partial output is deleted. Earlier successful siblings survive later failures.
- **API parity:** The new download tool belongs in the core MCP profile.
- **Concurrency:** Existing tab leases and `runExclusive` remain authoritative. One download waiter is active per tab.
- **Compatibility:** Artifact selector drift marks inventory partial without changing transcript completeness.
- **Security:** The browser session remains the authentication authority; provenance is credential-free.
- **Unchanged invariants:** Transcript reads and persistence, research export, latest-response saving, artifact IDs, and browser ownership retain their meanings.

## Risks and Dependencies

| Risk | Mitigation |
|---|---|
| Provider markup changes | Dedicated compatibility capability, fixture, and partial-inventory reason |
| Virtualization hides earlier cards | Inventory during the full scan; remount before clicking |
| Duplicate filename selects wrong card | Match conversation, message, occurrence, and observed name |
| Save dialog appears | Arm and verify `waitForDownload` before every click |
| Oversized or stalled output remains | Backend cancellation, cleanup, and registration after validation |
| Signed URL leaks | Exact provenance parser plus negative index/MCP tests |
| Completeness axes are confused | Separate contracts and combination tests |
| Canvas differs from file cards | Hard probe gate; no guessed adapter |
| Cold restart yields empty read | Apply the documented warm retry before interpreting evidence |

## Disconfirming Evidence

Revise the design if an earlier-turn card lacks stable message identity, an armed Electron listener still allows the Save dialog, the click starts outside the adapter's observable session, the downloaded file cannot be correlated safely, size cancellation leaves partial output, or later use requires persisting a signed URL. Canvas work stops independently if its export lifecycle is incompatible with sequential card downloads.

## Bug Trace and Confidence Cross-check

| Bug or requirement | Contract clause | Expected behavior | Match |
|---|---|---|---|
| Three button-based cards are absent from reads | U1 inventories cards during each scan window | All three names appear in the sidecar | Yes |
| Manual click opens Save dialog | Listener-active-before-click invariant | Electron chooses the destination without native UI | Yes; live proof pending |
| Private endpoint needs browser credentials | Browser session owns authentication | No Node credential forwarding | Yes |
| Earlier cards can unmount | Inventory during scan; remount before click | Earlier cards remain addressable | Yes; runtime proof pending |
| Equal filenames are ambiguous | `artifactKey` excludes filename as identity | Correct occurrence is selected | Yes |
| One failure could hide successes | Per-item terminal union | Successful siblings remain visible and registered | Yes |
| Transcript `complete` could overclaim | Independent inventory status | Coverage axes remain separate | Yes |
| Canvas was not observed | U5 hard gate | No Canvas support claim | Yes |
