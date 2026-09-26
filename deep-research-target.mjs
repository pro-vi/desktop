// Deep Research renders its report in a sandboxed app frame. The earlier frame
// was titled internal://deep-research on connector-openai-deep-research's
// sandbox host; the current one (observed 2026-09-26) is an MCP app frame
// titled "Deep research" on a generic mcp-app-<hash> sandbox host, with the
// report in a nested same-origin #root document.
export const DEEP_RESEARCH_IFRAME_SELECTOR = [
  'iframe[title="internal://deep-research"][src*="connector-openai-deep-research.web-sandbox.oaiusercontent.com"]',
  '[data-mcp-app-frame] iframe[title="Deep research" i]'
].join(', ');

const DEEP_RESEARCH_TARGET_URL_RE =
  /connector-openai-deep-research\.web-sandbox\.oaiusercontent\.com/i;

const MCP_APP_TARGET_URL_RE = /^https:\/\/mcp-app-[a-z0-9]+\.web-sandbox\.oaiusercontent\.com\//i;

export function selectDeepResearchTargetForPage(
  targetInfos,
  { frameTargetIds = new Set(), parentTargetId = null } = {}
) {
  const targets = Array.isArray(targetInfos) ? targetInfos : [];
  // A frame bound from a Deep Research iframe on the page is authoritative;
  // the last one bound is the newest report in the conversation. The generic
  // app sandbox host serves every app, so it is accepted only through this
  // binding, never by host name alone.
  const boundIds = [...frameTargetIds].map((id) => String(id || '').trim()).reverse();
  for (const id of boundIds) {
    const bound = targets.find((target) =>
      String(target?.targetId || '').trim() === id &&
      (DEEP_RESEARCH_TARGET_URL_RE.test(String(target?.url || '')) || MCP_APP_TARGET_URL_RE.test(String(target?.url || '')))
    );
    if (bound) return bound;
  }
  const matchingTargets = targets.filter((target) =>
    DEEP_RESEARCH_TARGET_URL_RE.test(String(target?.url || ''))
  );
  return matchingTargets.find((target) =>
    String(target?.parentId || '').trim() === String(parentTargetId || '').trim()
  ) || (matchingTargets.length === 1 ? matchingTargets[0] : null);
}
