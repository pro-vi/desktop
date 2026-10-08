# Dot messaging local gate

The local messaging implementation is reviewable. Actual personal Dot producer,
getter, timeline, and acknowledgement behavior remains unverified; no provider
message was sent by this build.

## Scope and reviewers

The initial gate reviewed the complete unpublished range `c44287c..1094f6f`,
including its earlier protocol and browser-probe commits. Eight independent
reviewers began with fresh contexts: naming, casting, legacy, overbuild,
comment, invariance, failure-mode, and perf. Affected rechecks reused those
independent reviewer contexts through the repaired source at `1ae43f8`.
Root independently exercised the final tab-creation persistence boundary.

The scope is mixed: request/storage representation, provider boundaries,
compatibility, module ownership, and caller-driven observation cost. No new
package or compatibility alias was added.

## Findings and disposition

| Lens | Finding | Disposition |
|---|---|---|
| Naming | Inspection names hid native submission authority. | Both executors use `runDotPageOperation`; inspection stays read-only. |
| Casting | Missing older-history metadata was treated as complete coverage. | Empty-position reads require an explicit null history boundary. |
| Legacy | Old unshipped Dot query/binding/reply formats had no compatibility obligation. | Replaced directly; ordinary Chat contracts retained. |
| Overbuild | Unused cursor import, unreachable Dot query projection, unused run-ID override. | Removed; recovery now carries a genuinely used expected binding. |
| Comment | No misplaced changed comments. | Clear. |
| Invariance | Retry lost durable binding after key persistence failed. | Retry/reopen validate the run binding before effects. |
| Invariance | HTTP accepted messages after its wait deadline. | Deadline checked before batch acceptance; cursor retained. |
| Invariance | Ordinary operations could repair a live Dot key into Chat. | Existing live and saved recipient identities reject before effects or writes. |
| Failure-mode | Failed writes after input omitted the recovery handle. | HTTP/MCP preserve run ID and durable unknown/submitted checkpoint. |
| Perf | Loaded timeline metadata is captured repeatedly. | Measurement gap retained; no provider regression established. |

Additional real-boundary checks reject the current `dot-talk` operation marker
when its recipient was lost, retain exact opaque cursor encodings on empty
reads, reject late responses even when timer delivery is blocked, and preserve
both delivery-state meanings after final persistence failure.

Owned tests put the actual controller, HTTP service, filesystem storage, and
stdio client into these failure states. Planted defects produced their intended
red cases and were removed before restored checks. The gate does not infer
provider frequency or support from those synthetic mechanisms.

## Remaining evidence limits

Native membership checks use Set; scanning and bounded-batch validation are
O(N + U), with at most 32 extra metadata scans. N is loaded messages and U is
pending sends. Each empty wait still transfers loaded timeline metadata twice,
with a 200 ms steady poll interval plus capture time. Actual N, payload size,
and capture cost remain unmeasured. This is a proposed profiling question, not
a release-blocking regression claim.

The scripted transport fixture exercises public MCP through real HTTP/storage
with an owned provider evaluator. A separate real Electron DOM fixture exercises
the production page adapter. These establish mechanism integration; direct
controller calls and fixture-only pages do not establish whole-app/provider E2E.
The desktop/provider journey remains held for the separately scoped live step.
No live authenticated session was restarted or closed by the local fixtures.

The revised plan remains active. Final exact-head tests and the stamped fixture
receipt are emitted by the build handoff; exact-SHA CI remains a publication
requirement. The architecture decision is recorded in
[ADR 0016](../adr/0016-separate-dot-delivery-from-message-observation.md).
