# Deep Research completion follow-up

Status: resolved on 2026-08-30.

## Problem

The public `agentify_research` method activated and submitted through the current
ChatGPT UI, but completed reports were not visible to Agentify.

Current runtime evidence on 2026-08-30:

- Electron CDP inspection showed that a mouse-down event needs the pressed-button
  bitmask, after which `composer-plus-btn` opens the current menu;
- the current menu is `.popover[aria-busy="false"]`; its Deep Research row uses
  `data-composer-plugin-impression-id="connector_openai_deep_research"` and a
  focusable `[data-fill][tabindex="0"]` child;
- selection creates an inline composer pill identified by
  `data-id="plugin:connector_openai_deep_research"`, which Agentify now preserves
  while appending the prompt;
- live CDP inspection proved the report existed and was marked “Research completed”;
- both backends matched an underscore hostname,
  `connector_openai_deep_research.web-sandbox.oaiusercontent.com`, while the actual
  target uses hyphens: `connector-openai-deep-research.web-sandbox.oaiusercontent.com`;
- multiple report targets have no `parentId`, but the current page's iframe owner
  exposes a `frameId` equal to the correct target id;
- the fixed backends select by this exact frame/target identity before legacy
  parent/count fallbacks;
- the local Computer Use bridge failed before app inspection with
  `process is not defined`; Electron CDP supplied the UI evidence instead.

## Affected invariant

When Deep Research is available in the signed-in ChatGPT session, Agentify must select
it through an observed current control, preserve the inline selection through send,
observe a changed stable nested report, export Markdown, and register a matching
`research-report` receipt. Conversation creation alone is not completion.

## Root cause

The reports were complete at the provider. Agentify's child-target hostname matcher
used underscores instead of the observed hyphens. After that was fixed, two open
report tabs exposed a second defect: both iframe targets lacked parent metadata, so a
global “only matching target” fallback became ambiguous. DOM `frameId` supplies the
exact ownership relation.

## Evidence obtained

1. Electron CDP captured the open composer menu, Deep Research item, inline pill,
   completed report, actual child hostname, and iframe-owner `frameId`.
2. Electron and Chrome regression tests fail on the hyphenated hostname and on two
   parentless targets, then pass with exact frame binding.
3. Runs `b3398fa7-8e64-4c53-9d0a-d753360fde26` and
   `11d71f18-62cf-4f3c-a217-f4d26a252e14` both completed with distinct
   `research-report` receipts whose hashes match the saved Markdown bytes.

## Acceptance tests

1. Controller fixtures preserve the inline pill, exclude composer mode labels from
   thinking state, and accept only changed stable nested report text after observed
   generation.
2. Activation fails closed when the observed menu item or inline pill is absent.
3. A live canary creates a conversation, finishes a primary-source request, stores
   canonical Markdown, and returns a receipt-backed `research-report`.
4. A second request repeats the path without selector changes. Passed.

## Temporary containment

No temporary containment remains. Short reports may have no provider-native download
control, so canonical `response.md` is the durable Markdown authority.

## Merge impact

NON-BLOCK. The current `agentify_research` happy path has two live successes.
