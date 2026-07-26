# Agentify Local Code Capture

Captured: 2026-07-04 from `/Users/provi/Development/_setup/agentify-desktop`.

Relevant facts observed:

- `mcp-server.mjs` exposes `agentify_research` as an async ChatGPT Deep Research tool that returns a durable run id and instructs callers to poll `agentify_get_run` (`mcp-server.mjs` lines 134-165).
- `selectors.json` includes research activation selectors for research controls, `Deep Research` options, active Deep Research state, export/download buttons, and Markdown export options (`selectors.json` lines 14-20).
- `chatgpt-controller.mjs` activates research mode by opening the composer action for `deep_research`, then confirms active state from active selectors, research hints, prompt hints, or a latched post-click composer state (`chatgpt-controller.mjs` lines 3170-3315).
- `chatgpt-controller.mjs` waits for long-running research with a 60-minute minimum timeout/stability floor and extra research/search/source/clarifying thinking patterns (`chatgpt-controller.mjs` lines 3648-3686).
- `chatgpt-controller.mjs` attempts to open the report, click export/download, choose Markdown, handle nested Deep Research report documents, and return `exportedMarkdownPath` (`chatgpt-controller.mjs` lines 3333-3645).
- `chatgpt-ui-primitives.mjs` maps `Extended Pro` and any label starting with `Pro` to `extended-pro`, so `Pro Extended` can still be recognized in the model picker (`chatgpt-ui-primitives.mjs` lines 66-80).
- `chatgpt-controller.mjs` thinking-banner detection still explicitly matches `extended pro` but not `pro extended`, which is a plausible stale edge if the live status banner changed without another `thinking`/`researching` indicator (`chatgpt-controller.mjs` lines 2928-2940).
- `tests/chatgpt-controller.test.mjs` covers activation failure metadata, mutex behavior, Markdown export, opening the research report before export, nested Deep Research export controls, nested text fallback, and native download hook (`tests/chatgpt-controller.test.mjs` lines 2396-3118).

Verification:

- `node --test tests/chatgpt-controller.test.mjs` passed: 35 tests, 35 passed, 0 failed.
