# Program Design: Conversation Artifact Capture

Companion to `2026-08-08-001-fix-conversation-artifact-download-plan.md`.

## 0. Brief

Agentify will inventory file cards while it already walks ChatGPT's virtualized conversation, then download explicitly selected cards through the authenticated browser. The existing transcript result stays unchanged; a new exact sidecar reports provider-side files, and a separate MCP command performs local writes.

The browser remains the authentication authority. The rejected design was reconstructing ChatGPT's private download endpoint in Node, because that would couple Agentify to temporary URLs and account headers. Existing Electron and Chrome download interception remains the integration seam, with a new detailed outcome used by bounded conversation downloads and the old `waitForDownload` behavior retained for current callers.

Non-goals are transcript-schema changes, latest-response tool changes, parallel downloads, and a control-center UI. **Open:** Canvas document markup and export behavior are unknown; U5 probes them and does not claim support. **Assumed:** provider message IDs and card order remain stable during one exclusive scan; changed identity causes refusal rather than a best-effort filename match.

## 1. Types and Signatures

### `conversation-artifact-contract.mjs` — NEW

```js
+ export const CONVERSATION_ARTIFACT_CONTRACT_VERSION = 1;

+ export function createConversationArtifactKey({
+   providerConversationId,
+   providerMessageId,
+   occurrenceWithinMessage
+ });
+ // pre: caller supplies canonical provider IDs and a non-negative occurrence.
+ // post: deterministic opaque key; filename is not an input. // discharges O3
+ // errors: throws invalid_conversation_artifact_contract for malformed identity.
+ // hides: hash encoding and future provider-specific identity fields.

+ export function parseConversationArtifactDescriptor(unknownValue);
+ // pre: unknown provider-eval output.
+ // post: frozen exact descriptor with kind === 'file'. // discharges O1
+ // errors: rejects extra fields, unknown kind, malformed IDs, invalid names, or a contradictory artifactKey.
+ // hides: DOM selectors, local save paths, MIME classification, and download availability.

+ export function parseConversationArtifactInventory(unknownValue);
+ // pre: unknown scanner result.
+ // post: exact {status:'complete',items} or {status:'partial',reason,items}; keys are unique. // discharges O1, O4
+ // errors: rejects status/reason contradictions, duplicates, unknown fields, and malformed descriptors.
+ // hides: transcript completeness and the provider's total number of files outside observed boundaries.

+ export function parseConversationArtifactProvenance(unknownValue);
+ // pre: unknown metadata prepared for artifact-store registration.
+ // post: exact versioned, credential-free conversation/message identity. // discharges O1, O6
+ // errors: rejects unknown fields, URLs outside canonical ChatGPT conversations, or inconsistent artifact keys.
+ // hides: signed download URL, cookies, headers, sandbox path, raw DOM, and local artifact UUID.

+ export function parseConversationArtifactDownloadRequest(unknownValue);
+ // pre: unknown HTTP JSON after tab-selection fields are removed.
+ // post: unique artifactKeys plus bounded maxFiles, maxBytesPerFile, and timeoutMs.
+ // errors: rejects empty/malformed keys, too many keys, or bounds outside server limits.
+ // hides: tab resolution, output directory, click coordinates, and provider URLs.

+ export function parseConversationArtifactDownloadOutcome(unknownValue);
+ // pre: unknown final service result for one requested key.
+ // post: closed union on status: saved | not_found | unsupported | conversation_changed | download_failed | size_limit_exceeded. // discharges O1, O2
+ // errors: rejects extra fields, a missing saved artifact, or fields belonging to another variant.
+ // hides: browser-adapter event taxonomy and partial-file paths.

+ export function parseConversationArtifactDownloadBatch(unknownValue);
+ // pre: unknown service batch response.
+ // post: every requested key appears exactly once and counts derive from outcomes. // discharges O2
+ // errors: rejects duplicate/missing keys, invented aggregate success, or malformed outcomes.
+ // hides: execution order and retry policy.
```

Descriptor declaration:

```js
+ ConversationArtifactDescriptor = {
+   schemaVersion: 1,
+   artifactKey: string,
+   providerConversationId: string,
+   providerMessageId: string,
+   providerTurnIndex: integer,
+   occurrenceWithinMessage: integer,
+   name: string,
+   kind: 'file'
+ };
```

Final outcome declaration:

```js
+ ConversationArtifactDownloadOutcome =
+   | { status: 'saved', artifactKey, artifact }
+   | { status: 'not_found', artifactKey }
+   | { status: 'unsupported', artifactKey, kind }
+   | { status: 'conversation_changed', artifactKey }
+   | { status: 'download_failed', artifactKey, reason }
+   | { status: 'size_limit_exceeded', artifactKey, maxBytes };
```

### `chatgpt-controller.mjs` — MODIFIED

```js
+ async #captureConversationBundle({ maxCaptureBytes, includeLegacyDiagnostic = false });
+ // pre: controller owns a canonical ChatGPT conversation or returns compatibility evidence.
+ // post: returns {captureWindow, artifactInventory, legacyDiagnosticReason?}; each result is exact-parsed independently. // discharges O4
+ // errors: capture deadline becomes partial results; unexpected adapter errors propagate.
+ // hides: virtualized-window stitching, selector resolution, and DOM evaluation.

~ async #captureConversationWindows(...) -> replaced by #captureConversationBundle(...);

~ async captureConversation({ maxCaptureBytes = 4 * 1024 * 1024 });
  // post: projects only bundle.captureWindow into the unchanged transcript contract.

~ async readConversationText({ maxChars = 200_000 });
  // post: preserves every legacy field and adds exact artifactInventory.
  // errors: transcript and artifact failures remain separate partial axes.
  // hides: stored transcript schemas and artifact-download behavior.

+ async downloadConversationArtifacts({
+   artifactKeys,
+   maxFiles,
+   maxBytesPerFile,
+   timeoutMs,
+   outDir
+ });
+ // pre: caller owns exclusive tab execution, has prepared the canonical conversation, and supplies an artifact-store-owned outDir.
+ // post: processes keys sequentially; returns one exact controller outcome per key; completed candidates contain no provider URL. // discharges O2, O3, O6
+ // errors: route instability becomes conversation_changed; per-item provider failures become typed outcomes; inability to begin the operation throws.
+ // hides: scrolling, coordinates, browser event source, and artifact-store registration.
```

Controller-only completed candidate:

```js
+ { status: 'downloaded', artifactKey, filePath, originalName, mime, provenance }
```

It is not an MCP or persisted shape. HTTP converts it to `saved` only after registration.

### `electron-browser-backend.mjs` and `chrome-cdp-backend.mjs` — MODIFIED

```js
+ async waitForDownloadOutcome({ timeoutMs = 15_000, outDir, maxBytes = null });
+ // pre: caller invokes before the UI action and owns sequential use for this page.
+ // post: returns exactly one terminal outcome; non-completed outcomes leave no partial file. // discharges O5
+ // errors: adapter setup errors become {status:'unavailable'}; lifecycle endings are typed outcomes, not throws.
+ // hides: Electron DownloadItem events, CDP GUIDs, collision reservation, and provider URL shape.

~ async waitForDownload({ timeoutMs = 15_000, outDir });
  // post: legacy projection over waitForDownloadOutcome: completed -> existing object; every other status -> null.
  // hides: byte limiting, which remains opt-in through the detailed method.
```

Detailed browser outcome:

```js
+ BrowserDownloadOutcome =
+   | { status: 'completed', path, name, mime, source }
+   | { status: 'timeout' }
+   | { status: 'cancelled' }
+   | { status: 'interrupted' }
+   | { status: 'size_limit_exceeded', maxBytes }
+   | { status: 'unavailable' };
```

`source` is transient compatibility data. `downloadConversationArtifacts` must discard it before returning. Existing callers of `waitForDownload` keep their current shape.

### `http-api.mjs` — MODIFIED

```js
+ async function registerConversationArtifactOutcome({
+   stateDir,
+   tabs,
+   tabId,
+   outDir,
+   controllerOutcome
+ });
+ // pre: controllerOutcome is exact-parsed and outDir is the service-owned artifact directory.
+ // post: downloaded -> saved only after filesystem validation and registration with source:null; failures pass through unchanged. // discharges O2, O6
+ // errors: invalid downloaded files become download_failed for that key; siblings are unaffected.
+ // hides: artifact index format and path-validation implementation.

+ POST /conversation-artifacts/download
+ // pre: body passes exact request parsing; chatUrl is parsed before tab creation.
+ // post: uses read-conversation's request/tab scopes and runExclusive; returns exact batch response.
+ // errors: 4xx for invalid request/route ownership; 501 for unsupported controller; per-file failures stay in 200 response outcomes.
+ // hides: local output directory and browser session credentials.
```

### `mcp-server.mjs` and `mcp-tool-profile.mjs` — MODIFIED

```js
~ agentify_read_conversation output
  // post: text content is unchanged; structuredContent adds artifactInventory.
  // hides: provider selectors and download capability.

+ agentify_download_conversation_artifacts({
+   model?, tabId?, key?, chatUrl?, artifactKeys, maxFiles?, maxBytesPerFile?, timeoutMs?
+ });
+ // pre: artifactKeys come from an inventory returned for the target conversation.
+ // post: structuredContent is the exact batch; text is a credential-free summary.
+ // errors: request-level failure sets MCP isError; mixed per-item outcomes remain inspectable structured data.
+ // hides: local credential state, provider URLs, and native browser events.

~ CORE_TOOLS includes 'agentify_download_conversation_artifacts';
```

### Composition root

```js
~ createHttpApi(...)
  // production bindings:
  // - tabs supplies the existing ChatGPTController
  // - ChatGPTController.page supplies ElectronPageAdapter or ChromeCdpPage
  // - HTTP owns ensureArtifactsDir + registerArtifact
  // - MCP binds the new tool to POST /conversation-artifacts/download
```

No new dependency or provider credential binding is introduced.

## 2. Call Stacks

### Read conversation

```text
agentify_read_conversation handler
  requestJson POST /read-conversation
    parseChatGptEntryTarget -> 4xx invalid_chat_url
    reserve request operation scope
    resolveTab
    reserve tab operation scope -> 409 tab_busy
    controller.runExclusive
      controller.prepareChatEntry(chatUrl)
      controller.readConversationText(maxChars)
        #captureConversationBundle(maxCaptureBytes)
          beginNavigationGuard
          #scan virtualized windows
            parse transcript turn observations
            parse conversation artifact observations
          parseConversationCaptureWindow
          parseConversationArtifactInventory
        projectLegacyConversationWindowText(captureWindow)
        attach artifactInventory
    send unchanged text fields plus artifactInventory
```

### Download selected conversation files

```text
agentify_download_conversation_artifacts handler
  requestJson POST /conversation-artifacts/download
    parseConversationArtifactDownloadRequest -> 4xx invalid contract
    parseChatGptEntryTarget -> 4xx invalid_chat_url
    reserve request operation scope
    resolveTab
    reserve tab operation scope -> 409 tab_busy
    controller.runExclusive
      controller.prepareChatEntry(chatUrl)
      ensureArtifactsDir
      controller.downloadConversationArtifacts
        for each artifactKey sequentially
          rescan/mount owning message
          guard canonical conversation stable -> conversation_changed
          guard exact artifactKey found -> not_found
          page.waitForDownloadOutcome(...)  // listener becomes active here
          click exact mounted Download file control
          await detailed outcome
          discard source
          verify descriptor name against suggested name -> download_failed:name_mismatch
      for each controller outcome
        registerConversationArtifactOutcome
          parseConversationArtifactProvenance
          assertArtifactFileReady
          assertWithin artifact outDir
          registerArtifact(source:null)
          map downloaded -> saved
      parseConversationArtifactDownloadBatch
    return structured outcomes
```

### Bounded Electron download

```text
ElectronPageAdapter.waitForDownloadOutcome
  install session will-download listener
  caller clicks provider control
  on will-download for owning webContents
    reserve destination
    item.setSavePath
    observe received bytes
      guard received > maxBytes -> cancel + remove partial -> size_limit_exceeded
    on done completed -> completed
    on done otherwise -> cancelled/interrupted
  timeout -> cancel active item + remove partial -> timeout
  always remove listeners
```

Chrome follows the same contract with `Browser.downloadWillBegin`, `Browser.downloadProgress`, and `Browser.cancelDownload`.

## 3. File-tree Diff

```text
NEW       conversation-artifact-contract.mjs                         U1/U3 exact authority
MODIFIED  chatgpt-controller.mjs                                     U1/U3 scan and download orchestration
MODIFIED  chatgpt-compatibility.json                                 U1 file-card compatibility capability
MODIFIED  electron-browser-backend.mjs                               U2 detailed bounded outcome
MODIFIED  chrome-cdp-backend.mjs                                     U2 detailed bounded outcome
MODIFIED  http-api.mjs                                               U1/U3 read projection, route, registration
MODIFIED  mcp-server.mjs                                             U1/U3 public read and download contracts
MODIFIED  mcp-tool-profile.mjs                                       U3 core-profile parity
MODIFIED  README.md                                                  U4 user contract
NEW       docs/probes/chatgpt-canvas-artifacts.md                     U5 only after a live sample exists
MODIFIED  tests/chatgpt-controller.test.mjs                           U1/U3 controller contracts
MODIFIED  tests/electron-browser-backend.test.mjs                     U2 Electron lifecycle
MODIFIED  tests/chrome-cdp-backend.test.mjs                           U2 Chrome lifecycle
MODIFIED  tests/http-api.test.mjs                                     U1/U3 route and registration
MODIFIED  tests/mcp-server-names.test.mjs                             U3 public tool list
MODIFIED  tests/mcp-tool-profile-integration.test.mjs                 U1/U3 MCP profile and schema
CONTEXT   transcript-contract.mjs                                    read, not modified
CONTEXT   artifact-store.mjs                                         generic store reused, not modified
```

The program design narrows the blueprint's tentative `artifact-store.mjs` modification: exact conversation provenance is validated before the existing generic store, so the store does not need a schema change.

## 4. Seams and Enabling Points

| Seam | Enabling point | Test double or proof | Contracts proved |
|---|---|---|---|
| DOM artifact extraction | `#captureConversationBundle` requests the compatibility capability | evaluated DOM fixture in controller tests | descriptor exactness, independent inventory status, deduplication |
| Browser download lifecycle | controller calls `waitForDownloadOutcome` before the click | mock page records call/click order; backend event fakes | listener-before-click, timeout, byte limit, cleanup |
| Electron native suppression | Electron session `will-download` handler calls `setSavePath` | Electron backend unit fake plus live e2e | no Save dialog, owning-webContents filter |
| Chrome download control | CDP `Browser.setDownloadBehavior` and events | CDP client fake | completion, cancellation, partial cleanup |
| Conversation route ownership | existing `prepareChatEntry`, navigation guard, and operation scopes | HTTP/controller route doubles | changed conversation refuses clicks |
| Local artifact registration | HTTP calls existing validation and registration after controller success | temporary artifact directory | saved iff validated record exists; source is null |
| MCP projection | static tool registration posts to the new route | requestJson test double and served-schema integration | exact input/output and core-profile presence |
| Canvas provider contract | U5 live authorized conversation | none — live probe | whether a future Canvas adapter is admissible |

## 5. Build Order

1. **U1** — deps: none — establishes an exact file inventory sidecar while preserving every legacy transcript field. **Checkpoint:** pause — call `agentify_read_conversation` on the supplied chat and inspect the inventory.
2. **U2** — deps: none — establishes a compatible detailed download outcome with byte-limit and cleanup behavior in both backends. **Checkpoint:** auto — shared backend download-contract tests pass.
3. **U3** — deps: U1, U2 — establishes selected full-conversation file retrieval, secure registration, per-item outcomes, and core MCP exposure. **Checkpoint:** pause — download the supplied three files and inspect outcomes and artifact records.
4. **U4** — deps: U3 — establishes live Electron evidence that no Save dialog appears and documents the public contract. **Checkpoint:** pause — observe the live Electron download and confirm no Save dialog appears.
5. **U5** — deps: U4 — establishes evidence, not support, for the separate Canvas route. **Checkpoint:** pause — review captured Canvas evidence before planning an adapter.

Obligation discharge: O1 → contract parsers; O2 → closed final/batch outcomes; O3 → key constructor and controller matching; O4 → bundle with independent parsers; O5 → detailed backend outcome; O6 → provenance parser, controller source discard, and `source:null` registration.
