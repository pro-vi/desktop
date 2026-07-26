# Agentify ChatGPT Deep Research Path Currency

## Answer

Agentify's ChatGPT Deep Research path is partially current, not dead. The local implementation still has a real async `agentify_research` surface, Deep Research activation, long-running wait logic, Markdown export handling, nested report fallback, and passing controller tests. [source:manual:users-provi-development-setup-agentify-desktop-chatgpt-controller-mjs] [source:manual:users-provi-development-setup-agentify-desktop-selectors-json] [source:manual:users-provi-development-setup-agentify-desktop-tests-chatgpt-controller-test-mjs]

It is not fully up to date with ChatGPT's current naming and product surface. OpenAI's June 2026 release notes now describe `Pro Standard` and `Pro Extended`, and GPT-5.2 ChatGPT conversations moved forward to GPT-5.5. Agentify can probably still select `Pro Extended` because labels beginning with `Pro` map to `extended-pro`, but selectors, display text, docs, and one thinking-banner regex still preserve older `Extended Pro` assumptions. [source:web:help-openai-com-en-articles-6825453-chatgpt-release-notes] [source:manual:users-provi-development-setup-agentify-desktop-chatgpt-ui-primitives-mjs] [source:manual:users-provi-development-setup-agentify-desktop-chatgpt-controller-mjs] [source:manual:users-provi-development-setup-agentify-desktop-selectors-json]

Recommendation: do not spend effort on a full Deep Research rebuild while Extended Pro is reliable. Keep `agentify_research` as a best-effort specialized path, and only do a small hardening pass if you intend to keep it exposed: add `Pro Extended` wording in selectors/display/tests, update the thinking-banner regex, and run one live smoke test for activation/export. Deep Research still has unique report/download/citation affordances, but most day-to-day "deep dive" value people discuss is covered by strong Pro/extended reasoning. [source:web:help-openai-com-en-articles-10500283-deep-research-in-chatgpt] [source:reddit:1u80b7p] [source:reddit:1uj1tie] [source:reddit:1tkhp7a] [source:reddit:1ubsntk]

Community sentiment is mixed. In Reddit threads, some users say GPT-5.5/ChatGPT is strong for exploration, technical questions, and thorough deep research reports; other users complain about confusing plan limits, inconsistent quality, memory-overuse, hallucinations, or prefer Claude for some professional work. Treat this as sentiment only, not product truth. [source:reddit:1u80b7p] [source:reddit:1uj1tie] [source:reddit:1uhs7wg] [source:reddit:1tkhp7a] [source:reddit:1ubsntk] [source:reddit:1ulyll7]

## Claim ledger summary

| Claim | Status | Sources | Confidence |
|---|---|---|---|
| Deep Research still produces citation-bearing fullscreen reports and supports Markdown/Word/PDF downloads. | supported | web:help-openai-com-en-articles-10500283-deep-research-in-chatgpt | high |
| The ChatGPT model/mode surface changed recently to Pro Standard/Pro Extended, and GPT-5.2 ChatGPT conversations moved to GPT-5.5. | supported | web:help-openai-com-en-articles-6825453-chatgpt-release-notes | high |
| Agentify's Deep Research path is implemented and locally tested. | supported | manual local code/test source cards | high |
| Agentify has naming drift risk around older `Extended Pro` assumptions. | supported | OpenAI release notes plus local code source cards | medium |
| User sentiment is mixed but still shows demand for ChatGPT deep-dive/research workflows. | mixed | Reddit source cards | medium |
| Full rebuild is lower priority than a small hardening pass while Extended Pro is reliable. | supported synthesis | product docs, local code, sentiment | medium |

## Source log / reading list

- `web:help-openai-com-en-articles-10500283-deep-research-in-chatgpt` — OpenAI Help Center, current Deep Research output/download behavior.
- `web:help-openai-com-en-articles-6825453-chatgpt-release-notes` — OpenAI Help Center release notes, current naming/model-surface changes.
- `manual:users-provi-development-setup-agentify-desktop-chatgpt-controller-mjs` — local controller implementation evidence.
- `manual:users-provi-development-setup-agentify-desktop-chatgpt-ui-primitives-mjs` — local mode-label mapping evidence.
- `manual:users-provi-development-setup-agentify-desktop-selectors-json` — local selector evidence.
- `manual:users-provi-development-setup-agentify-desktop-tests-chatgpt-controller-test-mjs` — local test evidence.
- `reddit:1u80b7p`, `reddit:1uj1tie`, `reddit:1uhs7wg`, `reddit:1tkhp7a`, `reddit:1ubsntk`, `reddit:1ulyll7` — community sentiment threads.
- `hn:46966770`, `hn:45364393` — HN leads were fetched but had low discussion value for this decision.

## Coverage and omissions

Searched lanes: web, manual, reddit, hn_algolia. Reddit OAuth and HN Algolia probed healthy. The web lane is delegated in the CLI, so official OpenAI pages were browser-opened and manually ingested as capture artifacts after direct CLI acquisition returned HTTP 403. The manual lane was used for local repo evidence.

Omissions: I did not launch a real `agentify_research` run because that would spend ChatGPT Deep Research quota/time. I did run a non-invasive Agentify status check, which showed the default ChatGPT tab was not blocked and had a visible prompt. I also ran local controller tests.

## Unresolved questions

- Does the live ChatGPT web UI currently show a thinking/status banner that says only `Pro Extended` without `thinking`, `researching`, or another matched term?
- Does the live Deep Research report export menu still expose Markdown in the same reachable path for this account?

## Validation

Status: pass.
Validation artifact: `.research/runs/research-agentify-gpt-dr-2026-07-04/validation.json`
