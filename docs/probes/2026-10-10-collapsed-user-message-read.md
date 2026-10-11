# Collapsed user-message reading

The existing conversation's collapsed user turn caused a false missing-tail
warning and a clipped transcript. Expanding Show more exposed every prompt line.
The initial diagnosis required no new provider prompt. Four synthetic test
messages were subsequently sent with scoped consent.

## Revision and scope

Baseline: `45f4dcbc3b61a0341993dae8e2ecd738f09730d6`.
The corrected working-tree controller had SHA-256
`0729922b8744a20d092f55cade2ad1c3b21c260ec99992f490c6a45c477be2cb`.
The live page used Electron 39.6.0 and ChatGPT web observed on 2026-10-10;
the provider did not expose a release version.

The initial read-only phase executed the delivery method's source with only its private access
changed to a local callable function. Its page evaluations ran in the existing
authenticated conversation. Transcript checks called `captureConversation`
directly from the corrected controller. That phase verified the changed read paths without re-running a complete
query send or transcript-sync lifecycle. Subsequent live checks are below.

## Observations

| Observation | Result |
| --- | --- |
| Saved prompt | 81 lines, 10,898 characters |
| Original warning | 11 nonblank lines missing, positions 70–81 |
| Original transcript user turn | 10,238 characters |
| Collapsed DOM user node, including controls | 10,248 characters |
| Expanded DOM user node, including controls | 10,905 characters |
| Corrected delivery result | Checked, complete, zero missing lines |
| Corrected transcript captures | Both complete, two turns each |
| Recovered user text | 10,896 characters; all prompt letters and digits match |
| Repeated capture | Same user-text SHA-256 on both reads |

Each corrected check started with the user turn collapsed again. The original
saved run and immutable transcript snapshot were not rewritten.

## Regression checks

Tests execute the injected browser code against collapsed-message fixtures.
They cover successful expansion, a control that never expands, genuinely
missing text beyond the ten-line preview, and collapsed messages first
encountered while scrolling a virtualized conversation. A further regression
checks that expansion cannot erase an observed empty assistant part when the
layout change unmounts it; that capture must remain partial.

The initial five regression tests failed before implementation. The
expansion-triggered unmount test also failed before its correction. Each
failure was checked against its intended assertion. After the implementation, the focused controller checks
passed, including the existing actual-loss and rendering-tolerance checks.
The compatibility-map checks also passed.

The missing-line preview remains capped at ten lines. The first and last
missing line numbers describe positions in the original prompt, including
blank lines in the numbering. They do not imply that every intervening line
is missing.

`npm test` passed: 1,004 tests, zero failures or skips. The review found an
expansion/unmount race; preserving the pre-expansion observations closed it,
and independent invariant and failure-mode rechecks passed.

After reloading the application, `agentify_read_conversation` also returned
complete twice through MCP. Both saved transcripts had SHA-256
`69c8bc43d5a886a3a88add31162324f69946b15b7a2c8418f953abc7fb9afce0`.
The temporary inspection listener was removed and the owned read tab closed.
The long-prompt query and its continuation passed the full MCP send/wait path;
the two short fresh requests failed with a mode mismatch, as recorded below.

## Live send and continuation checks

Four synthetic Pro requests ran on the corrected controller after application
reload. The long request contained 81 lines and 15,560 characters, with its
required response marker on the last line.

| Run | Result | Delivery | Response |
| --- | --- | --- | --- |
| `8832b6e5-a5e1-4790-897e-04816cde6b32` | Success, Pro | Complete | `PROMPT_TAIL_ACCEPTED` |
| `3fe3e50f-0053-4c86-a6ef-e301edcb875b` | Error, mode mismatch | Not persisted | Page showed `PROMPT_SHORT_A` |
| `2f2353c3-e172-4e08-aa91-50bdd555cdca` | Error, mode mismatch | Not persisted | Page showed `PROMPT_SHORT_B` |
| `f091b7c7-9def-4dfe-bf1f-60828700e30a` | Success, Pro continuation | Complete | `PROMPT_CONTINUED` |

Both successful runs confirmed Pro before send, produced the exact expected
answer, and saved response bytes matching their completion-receipt hashes.
Their user turns contain every prompt letter and digit. The long conversation
advanced from two to four turns. Manual transcript sync completed before and
after continuation with different content hashes; two cursor-bound reads
returned separate whole turns with citations from one immutable snapshot.

### Mode mismatch still unresolved

Both short requests confirmed Pro before send, then failed with
`ChatGPT mode intent requested extended-pro, but the completed response reported thinking.`
Later read-only page captures ended in `Latest response` followed by `Medium`.
The footer parser is byte-identical to `origin/main` at `45f4dcbc`; executing
both copies on those captured page strings returns `thinking`, label `Medium`.
Mode inference happens before the new prompt-expansion read. These observations
do not establish which model generated the earlier answers or why the page
changed mode. This was unresolved at the time of this probe.

Read-only metadata checks on 2026-10-11 subsequently confirmed that each exact
short answer used `gpt-5-6-pro`. The footer inference was a false mode detection;
see [response-mode verification](2026-10-11-response-mode-metadata.md). Fresh
public mode checks subsequently passed. Overall query acceptance still fails
because a concurrent diagram request recorded an earlier prompt; the linked
response-mode probe records both results.

The general three-successful-Pro-requests acceptance condition did not pass.
The long-prompt delivery and transcript correction did pass. No extra provider
messages were sent to retry the mode failures.

The owned test source was forgotten through MCP after verification, and only
the three owned test tabs were closed. The provider conversations remain.
