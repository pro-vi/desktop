# Full text attachment query

A complete attachment query reproduced the generic renderer failure when its
filename contained `run`. Identical file bytes under a neutral filename passed
on the same runtime. The Send code mistook the file-card button for a native
form submitter. Native submitter checks now reject that control; the original
filename subsequently passed a complete public MCP query.

## Executed sources

The failing and filename-control queries used the unchanged normal runtime
from `2ad1ec363486fcb0d170173c9500a38d0785deb6`, whose runtime sources also
match parent `a1888154d858e1f4cab7f4d3157776a2cbccd6f5`.

The repaired query used that parent plus the working patch committed with this
record. Its controller SHA-256 was
`3778e904cade80ad92e4baa746214ca49a61155b2a33b5f00b8bd7a77ce934e6`.
Sources were pinned across the idle-gated restart and query. The unpackaged
application used Electron 39.6.0; public stdio MCP used SDK 1.26.0. The complete
ChatGPT web build was not recorded.

## Reproduction and cause

The approved recovered candidate was 21,593 bytes. Each query requested Instant
mode with a prompt asking only for `ATTACHMENT_OK`, without quoting file contents.

| Condition | Result |
|---|---|
| Recovered candidate with its original filename | Generic renderer error after 20,135 ms; requested mode confirmed; no completion receipt |
| Identical bytes renamed without `run`, same runtime | Success; expected confirmation; no app restart |
| Original filename after the repair and restart | Success after 48,808 ms; confirmed mode; complete prompt delivery; saved-response receipt |

The shared Send selector includes a case-insensitive title match for `run`.
An attachment-card button can match it; `review-run2.txt` is a synthetic example.
Before the repair, `#clickSendImpl` passed the first visible enabled match to
`form.requestSubmit` without checking its native type or form owner. A real
Electron renderer reproduced the native exception:

> TypeError: Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.

The [HTML form contract](https://html.spec.whatwg.org/multipage/forms.html#dom-form-requestsubmit)
requires an explicit submitter to be a submit button associated with that form.
The repair checks native `localName`, `type` and `form` properties at all three
selections, including reselection immediately before submission. Implicit submit
buttons remain eligible. JavaScript-only Send controls retain pointer and
focused keyboard dispatch. The unqualified secondary DOM click was removed:
a delayed JavaScript Send acknowledgement could otherwise lead it to the file
card even after native submission was correctly skipped.

## Verification

- Eight regression cases failed on the old native-selection logic. They cover
  submit buttons, implicit defaults, submit/image inputs, JavaScript Send,
  foreign form ownership, changed types and secondary native submission.
- Removing each new selection guard in isolated copies caused the expected
  failures: seven for initial selection, seven for primary submission and one
  for secondary submission. The original controller also failed both native
  Electron cases with the native TypeError.
- A ninth regression failed specifically on the secondary file-card click,
  then passed after its removal. Independent review restored that click only
  in memory and observed the same failure. The final focused cases pass.
- [Native controller fixture](../../scripts/e2e-native-submit.mjs): both native
  submit and JavaScript Send pass with zero file-card clicks. All HTTP(S) is
  intercepted, the owned Electron child exits and its profile is removed.
  This is controller contract proof, not full-application E2E.
- Final local `npm test`: 1,121 passed, zero failed, zero skipped.
- The repaired live public MCP query completed with a 14-byte saved response
  matching its completion receipt SHA-256:
  `cda2b1b37a251ca2686aabb3a8307437c40d201535f5da21272e9e9ea1bdaa79`.
  The materialized attachment retained the original basename and exact approved
  candidate bytes. The automatic transcript reached `ready`, with two turns
  containing the prompt and expected response. Its user text omits the file
  name; attachment identity was checked from the materialized input.
- Runtime active/in-flight counts, provider slots and durable running records
  were empty before the shared-app restart. The owned query tab was closed and
  independently verified absent. Normal operation remained running afterward.

An earlier approved 29-byte harmless-file query also succeeded in 29,859 ms,
with complete prompt delivery and a matching 11-byte saved-response receipt.
Its upload capture observed file creation 200, PUT 201, file-resource POST 200
and conversation POST 200. That small-file success did not exercise the
filename condition. Likewise, twelve earlier controlled cases stopped before
Send and therefore did not cover the throwing operation.

## Limits

The current filename-triggered failure is reproduced and repaired. The exact
historical file byte identity, provider page state and executing runtime remain
unproved; the original native stack was not retained. The unchecked selection
also exists in the reported source revision
`c1f2fffb6f6f6339baaacb028d6a17bbea545fb4`, but source presence alone does not
prove that revision was executing during the old failures.

One repaired Instant query does not satisfy the method map's three-run Pro
journey, prove model use of the file contents, or verify every caller of the
shared Send code. Research, image-generation and public retry journeys were
not repeated. A separate earlier partial conversation read lost its reason
in the probe helper; later complete reads do not explain it.
