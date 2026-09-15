# Token-Cost Paths — Agent-Driven Usage

Tracks where calling agents' tokens go when they drive Agentify, with measured
baselines and one section per improvement path. Update the measurements after
material changes; the counter (`/usage`, live since `cc9331d`, 2026-09-15) plus
the run store provide the data without transcripts.

## How to re-measure

```bash
# Per-route call counts, errors, cumulative response bytes (live counter)
TOKEN=$(cat ~/.agentify-desktop/token.txt)
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.agentify-desktop/state.json'))['port'])")
curl -s "http://127.0.0.1:$PORT/usage" -H "authorization: Bearer $TOKEN" | python3 -m json.tool

# Prompt/output size distribution from durable run records
python3 -c "
import json, glob, os, statistics
runs = [json.load(open(p)) for p in glob.glob(os.path.expanduser('~/.agentify-desktop/runs/*.json'))]
pl = sorted(len((r.get('materializedReplay') or {}).get('prompt') or '') for r in runs if (r.get('materializedReplay') or {}).get('prompt'))
ol = sorted(os.path.getsize(r['outputManifest']['responsePath']) for r in runs if (r.get('outputManifest') or {}).get('responsePath') and os.path.exists(r['outputManifest']['responsePath']))
print('prompts n/median/p90/max:', len(pl), pl[len(pl)//2], pl[int(len(pl)*.9)], pl[-1])
print('outputs n/median/p90/max:', len(ol), ol[len(ol)//2], ol[int(len(ol)*.9)], ol[-1])"
```

## Baseline (2026-09-15, n=1,832 runs)

- 96% of runs arrive via MCP (`source: 'mcp'`) — agents are the user base.
- Prompts: median 2,660 chars, p90 58,616, max 279,183. ChatGPT packing budget caps at 110,000 chars (`contextBudgetForVendor`).
- Outputs: median 6,049 bytes, p90 23,195, max 73,726 (n=657 with artifacts still on disk).
- Retries: 6 of 1,832 — orchestration is not the cost; payload defaults are.

## Cost paths

| Path | Mechanism | Est. cost |
|---|---|---|
| P-SESSION | 49 MCP tool schemas + descriptions load into every session before any call (~29k description chars alone) | ~7–15k tokens/session |
| P-PROMPT | Caller-packed context sent through `agentify_query` | ~0.7k median, ~15k p90 per query |
| P-INLINE-OUTPUT | `agentify_wait_run`/`agentify_get_run` return saved response text by default (`includeOutputText` true, `maxOutputChars` 200,000) | ~1.5k median, ~6k p90, up to ~50k per call |
| P-SYNC-DUP | Sync `agentify_query` ships full text in `content[0].text` and `structuredContent.text`, plus `codeBlocks` repeating code already in the text | 0–1 extra copy per sync query (client-dependent; unverified for Claude Code) |
| P-READ-PAGE | `agentify_read_page` default `maxChars` 200,000 — full page text inline | up to ~50k per call |
| P-WAIT-NOISE | `runStatusText` embeds `responseDebug` and `recovery` JSON on every wait result | ~0.1k per call |

## Improvement paths

Each path below is one unit of work. Status moves proposed → agreed → shipped
(landed commit named here) or dropped (reason named). `docs/token-cost-paths.md`
is the tracker; implementation commits reference their L-id.

### L1 — Cap inline output by default (wait_run)

- Change: `agentify_wait_run` defaults `maxOutputChars` to 2,000 — a preview
  with the existing truncation marker plus artifact path and hash; full text via
  explicit `maxOutputChars` (opt-up through the existing parameter).
  `includeOutputText` keeps its default-true semantics. `agentify_get_run`
  already defaults to no inline text; unchanged. Decided in
  `docs/plans/2026-09-15-001-feat-token-cost-lever-defaults-plan.md` (preview
  default chosen over flipping `includeOutputText` to false — callers keep the
  wait-returns-the-answer contract).
- Addresses: P-INLINE-OUTPUT. Saves ~1.5k typical, ~50k worst-case per call.
- Risk: callers that parsed the unbounded inline text must opt up or read the
  artifact path every result already carries; provenance is intact.
- Status: planned (`docs/plans/2026-09-15-001`, U1).

### L2 — Stop double-shipping the sync query result

- Change: full text in exactly one of `content`/`structuredContent`; drop
  `codeBlocks` from the structured copy when the text already contains them.
- Addresses: P-SYNC-DUP. Saves 0–1 response copy per sync query.
- Risk: depends on which field the client ingests — verify against the real
  client before claiming the saving; changing both fields at once is the safe
  form (text in `content`, metadata-only `structuredContent`).
- Status: proposed (presented 2026-09-15; client ingestion unverified).

### L3 — Run sessions on the core tool profile

- Change: attach agent sessions with `--tool-profile core` (11 tools) instead of
  the full set (49).
- Addresses: P-SESSION. Saves ~5–10k tokens per session.
- Risk: sessions needing library/context/operations tools must switch profiles
  explicitly. Owner: bootstrap MCP wiring, not this repo.
- Status: proposed (presented 2026-09-15; lives in bootstrap config).

### L4 — Lower the read_page default ceiling

- Change: `agentify_read_page` default `maxChars` 200,000 → 20,000, explicit
  opt-up unchanged.
- Addresses: P-READ-PAGE. Saves up to ~30k per unbounded read.
- Risk: callers wanting full pages must pass `maxChars`; the HTTP default stays
  200k for non-MCP consumers unless changed with it.
- Status: proposed (presented 2026-09-15).

### L5 — Trim wait-result debug noise

- Change: `runStatusText` includes `responseDebug`/`recovery` only on
  timeout/error results, not successful waits.
- Addresses: P-WAIT-NOISE. Saves ~0.1k per wait.
- Risk: post-mortem readers must pull diagnostics from the run record (already
  persisted) instead of the wait text.
- Status: proposed (presented 2026-09-15).

## Open questions

- Prompt-side policy (P-PROMPT, the largest per-query cost at p90): agents
  self-pack large contexts; the packing budget in `contextBudgetForVendor` is
  the knob, but lowering it changes workflow behavior, not just defaults.
  Caller-side decision, not taken yet.

## Measurement loop

The usage counter starts from the first instance running `cc9331d` or later;
it does not backfill. After each shipped L-id, compare `/usage` per-route
`responseBytes` trends and the run-store output distribution against this
baseline before/after the change date.
