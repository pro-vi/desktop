# Chat-only send verification

- Date: 2026-10-07 PDT
- Source: `59bc7eaf48cab9dc00d9593170ca7c813c2d2d59`, clean tree before verification; Electron respawned via `agentify_shutdown`
- Scope: three short Pro requests and one small image request
- Result: all four live requests completed in Chat; only the four owned probe tabs were closed

## Pro requests

The first fresh tab initially returned `chat_surface_switch_required` from the real readiness capture. The request selected Chat, confirmed Pro at slider index 4 on its five-position scale before send, and completed. All three requests reported `modeUsed: extended-pro`, confirmed mode provenance, complete prompt delivery, role-qualified answers and completion receipts. Saved answer bytes matched the receipt hashes.

| Run | Exact answer | Duration | Saved-answer SHA-256 |
|---|---|---:|---|
| `650f6474-312e-4db6-8bf2-331aab236ba6` | `CHAT_PRO_ONE` | 23.354 s | `41f06972121186474e11aef589a857c55c955f740df5fd5d702881e775031c29` |
| `89456d83-e423-4368-81c6-817b65b85f15` | `CHAT_PRO_TWO` | 32.523 s | `76618bcd022cb37a37b98072b96073f5456930833604b077b3303c52ba924b91` |
| `2fdf61dc-2855-40b4-9a26-6db19eb02a9c` | `CHAT_PRO_THREE` | 27.032 s | `9c4e6bd6c1caa72cd8674d3efc5cbb6cdce8b6aafef39ed489b2d56fd76efed1` |

## Image request

Prompt: `Generate one simple image: a small solid black square centered on a plain white background. No text.`

The image operation succeeded in Thinking mode. The served page subsequently returned `chat_surface_confirmed`. The downloaded PNG was decoded and visually inspected: one black square centered on a white background.

- Dimensions: 1254 × 1254
- PNG SHA-256: `1cde7c38da69119ed0c9889e06b7745aa807089e4361a5ef11c62c7a527376cb`

## Limits

These probes verify the tested account and provider surface at this time. They do not exercise live Deep Research, raw direct send, the reasoning opt-out, or deliberate mid-submission surface changes. Those rejection/interleaving paths have deterministic controller coverage. The requests are intentionally short; this does not remeasure long Pro thinking behavior. Publishing and exact-SHA CI remain separate from this runtime verification.
