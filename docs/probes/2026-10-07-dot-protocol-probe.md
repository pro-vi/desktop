# Dot query protocol probe

Status: local protocol checks passed; browser transport remains unbuilt.

The implementation is in the commit containing this report, based on
`c44287cf464f40608b87256ad5ff69ffbba598d6`. This report does not establish
live Dot support. No Dot message was sent.

## Exercised scope

The fixture ran a real MCP SDK client over stdio to `mcp-server.mjs`, then
through the real HTTP service, `TabManager`, run storage, artifact writing,
receipt generation, and run projections. Its controller supplied synthetic
binding and reply observations. The browser session factory was also synthetic.
This is protocol integration evidence, not desktop end-to-end evidence.

Environment: Node.js v24.14.0 on macOS. Electron 39.6.0 was installed but was
not launched by these checks. No dependency or lockfile changed.

## Results

| Check | Result |
|---|---|
| `npm test` | 964 passed; no failures |
| Dot-focused tests below | 21 passed; no failures |
| Syntax checks for changed application modules | Passed |
| `git diff --check` | Passed |
| Real MCP tool discovery and synchronous fixture exchange | Passed |
| Output-bearing get, wait, and completed retry | Reply appeared once; metadata retained binding and receipt |
| Completed retry | Returned saved output without another controller query |
| Ordinary Chat regression suite | Passed within `npm test`; no live Chat probe ran |

```sh
node --test --test-name-pattern='Dot|mcp Dot' \
  tests/http-api.test.mjs \
  tests/mcp-tool-profile-integration.test.mjs \
  tests/chatgpt-dot.test.mjs \
  tests/run-store.test.mjs
```

The HTTP fixture checked saved response bytes against the receipt hash. It
also exercised ordinary Chat publication as a positive control before relying
on Dot's absence of automatic whole-conversation publication.

## Failure paths

The protocol rejected caller-supplied observations, unsupported options,
unknown recipients, conflicting tab/key selectors, and Chat/Dot key reuse.
Ordinary completion evidence could not qualify a Dot reply. Structurally valid
Dot evidence could not qualify an ordinary Chat response. A submitted Dot run
could not finalize successfully without the existing completion receipt.

Two different keys targeting the same synthetic Dot conversation could not
interleave their queries. Competing submission acknowledgements retained the
first accepted user message identity and rejected the second.

Review rechecks held preparation and checkpoint writes while stopping through
both HTTP and the local server method. Stops before submission prevented
synthetic input. A stop during the accepted-message checkpoint retained the
submitted identity. Each case released its operation leases. The controller's
local Dot stop test performed no page evaluation or provider Stop click.

Injected run-file write failures produced these outcomes:

| Injected failure | Observed outcome |
|---|---|
| Intent checkpoint | Error with `not-submitted`; no synthetic input |
| Accepted-message checkpoint | Error with `unknown` |
| Accepted-message checkpoint plus error terminalization | Get and a pending wait returned 503 `run_status_unconfirmed`; list marked the stale status; disk retained `running/unknown` |

The double-write failure released leases and produced no unhandled rejection.
These observations concern the local protocol with a synthetic controller.

## Regression sensitivity

Defects were planted in isolated source copies. The unmodified baseline passed.
Seven additional variants were expected to fail, and all seven failed at the
intended assertions:

| Removed protection | Failing observation |
|---|---|
| Stop rechecks after preparation | Controller query started after the stop |
| Serialized acknowledgement transition | Second acknowledgement was accepted |
| Stored-run recipient validation | Malformed Dot data was accepted as ordinary data |
| Stored-key recipient validation | Malformed Dot affinity was accepted as ordinary data |
| Metadata-only Dot output projection | Reply appeared twice |
| Ordinary-query evidence-source restriction | Ordinary Chat accepted Dot evidence |
| Success receipt requirement | Dot success without a receipt was accepted |

An earlier sweep also observed the expected failures for unsupported request
fields, missing accepted-message identity, wrong reply author, wrong reply
association, provider Stop clicking, and missing conversation leases. No
mutation was applied to the working source tree.

## Review disposition and implementation choices

The scoped gate reviewed naming, boundary decoding, compatibility obligations,
unnecessary code, comments, invariants, failure paths, and performance. Findings
were repaired: malformed stored Dot fields no longer downgrade to Chat;
HTTP returns normalized reply evidence; get/wait/retry do not repeat reply
text in metadata; preparation honors stops; acknowledgement transitions are
serialized; failed detached terminal writes have an explicit observable error.
The unused recipient-comparison helper was removed. Targeted rechecks found no
remaining issue in those protocol paths.

Plan-silent choices were kept local:

- New Dot tabs start at `about:blank`. The future driver must validate and
  navigate the observed provider locator before admitting input.
- Invalid individual key records remain in the stored map. Updating another
  key must not erase them; their consumer rejects them when used.
- A failed terminal write does not invent a durable terminal state. The
  running service marks it unconfirmed and wakes waiters with an error.

The explicit-recipient decision changes contract and persistence boundaries
and qualifies for an ADR. The feature has not reached final delivery; that
decision remains in the active plan until the remaining provider work is
resolved. No accepted record claims that the browser contract is proven.

## Remaining work

The actual Dot route, stable ownership evidence, writable composer, accepted
user-turn identity, and completed reply association have not been observed.
Synthetic URLs and identifiers establish none of these provider facts.

`ChatGPTController` therefore rejects Dot queries with
`dot_binding_unconfirmed`. Safe browser reopening and unfinished-run recovery
are also unimplemented and reject explicitly. Completed fixture runs can
return their saved output, but no actual Dot send or continuation is proven.

The active plan remains
`docs/plans/2026-10-07-001-feat-dot-messaging-plan.md`. Its provider
characterization, guarded browser submission, real recovery, and live
acceptance remain open. Live provider probes require their own scoped consent
under `CLAUDE.md`; ordinary Chat consent does not cover Dot.

This local work was not pushed. There is no CI result for its commit. Under
the repository's exact-SHA verification contract, passing local tests does
not establish a CI-verified revision.
