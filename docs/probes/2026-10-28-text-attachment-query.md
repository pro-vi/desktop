# Full text attachment query

The current attachment query completed successfully. The historical generic
renderer exception remains unexplained; this probe does not establish its cause
or claim a repair.

## Scope

Executed revision: `2ad1ec363486fcb0d170173c9500a38d0785deb6`, with production
runtime files matching that commit. The unpackaged application used Electron
39.6.0 and public stdio MCP through SDK 1.26.0. The complete ChatGPT web build
was not recorded.

Explicit scoped consent authorized one full query with one 29-byte text file
containing `Harmless attachment fixture.` followed by a newline. The file's
SHA-256 was
`9d80765ced8e88f871ea3b722da1a49d177a2d4ec45d4b3a876c64c2ebc50085`.
The prompt asked for `FIXTURE_OK` if the attachment contained that sentence.
The query requested Instant mode. No private historical attachment was sent.

## Observations

- One public `agentify_query` call created one durable run, followed through
  public `agentify_wait_run` without resubmission.
- The run completed `success` in 29,859 ms, with confirmed mode activation,
  complete prompt delivery and a completion receipt.
- Its materialized replay contained one attachment. Network capture observed
  HTTP 200 for file creation, a subsequent PUT returning 201, a file-resource
  POST returning 200, and a conversation POST returning 200.
- The saved 11-byte reply matched the requested `FIXTURE_OK` result. Its
  SHA-256 matched the completion receipt:
  `18b69e27a965f158900f6773fbca25ef7783699f3d9e29711bc55c213c77ebc5`.
- No renderer exception was observed. The network record contains request
  methods, route categories, relative timings and statuses, with no request
  bodies, headers or provider file identifiers.
- Both runtime activity and durable running records were empty before each
  shared-app restart. The owned tab was closed and later verified absent.
  Ordinary launch was restored; its process was alive, the capture process had
  exited, and the temporary inspection port refused connections.

## Limits

This verifies one current Instant attachment query. It does not satisfy the
method matrix's three-run Pro journey or establish large-file provider
processing. The expected reply alone does not prove how the model used the
attachment. Automatic transcript capture was still pending in the saved run;
transcript completion was not part of this result.

Both historical failed runs had confirmed their requested modes before the
generic renderer failure, so mode activation was not their throwing operation.
The later operation and native exception were not retained. The original
provider page state and exact executing application revision remain unknown.

Separately, twelve controlled native pre-Send cases passed using the reported
revision `c1f2fffb6f6f6339baaacb028d6a17bbea545fb4` and the current revision:
three mode settings and two file-input arrangements for each revision. All
received the reconstructed historical input with matching local size and
digest, staged the prompt, and stopped before Send. Every HTTP(S) request was
intercepted. Those fixtures do not reproduce the historical provider page, and
full byte identity with the original attachment remains unproved.
