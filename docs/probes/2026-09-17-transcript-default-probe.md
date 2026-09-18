# Transcript-by-Default Live Probe

- **Date:** 2026-09-17 (evening PDT)
- **Status:** End-to-end verified — the chat is a queryable local file
- **Build:** `598e528` (resolveSource U1 `d2b44c6`, publisher U2 `014a444`, projection U3 `598e528`)
- **Plan:** `docs/plans/2026-09-17-003-feat-transcript-by-default-pointer-first-plan.md` (U4, consented)

## Procedure

Respawned the app at `598e528`; two numeric queries on the disposable key `probe-transcript-2026-09-17` ("4+4?", then "9−4?"); read each run's transcript block; selected each answer turn from the snapshot files by `providerMessageId` with jq; closed the tab.

## Observations

- **Run 1** `8e0925bf-…`: text `'8'`, `providerMessageId b31d70b0-…`; response carried `transcript: {state: "pending"}` (the real whole-conversation capture outlasts the 2s grace — the explicit state, no speculative path); the record settled to **ready** with a real snapshot file, `turnCount 2`, auto-tracked source `source-ca2f742b-…` minted with no caller knowledge.
- `jq -er --arg id … '.turns[] | select(.identity.providerMessageId == $id) | .text' <snapshot>` returned exactly **`'8'`**.
- **Run 2** `9a3e4ba6-…`: text `'5'`, id `d1a8c778-…`; resolved the **same** `liveSourceId` (idempotent by conversation), new content-addressed snapshot, `turnCount 4`, jq returned exactly **`'5'`**.

## Verdict

The user's ideal — the chat script as a queryable local file an agent reads like a transcript — holds live: every keyed query auto-tracks and publishes an anchored snapshot; the answer turn is addressable by provider message id through the local filesystem. Both plan falsifiers (missing pointer, snapshot without the turn) did not occur; no key rebinding.

Deterministic coverage: resolution idempotency and race (`tests/transcript-sync.test.mjs`), the publisher lifecycle incl. `answer_turn_absent` and pending visibility (`tests/http-api.test.mjs`), the one-projection fields through real stdio (`tests/mcp-tool-profile-integration.test.mjs`); full suite 881/881.
