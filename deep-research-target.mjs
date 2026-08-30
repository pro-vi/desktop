export const DEEP_RESEARCH_IFRAME_SELECTOR =
  'iframe[title="internal://deep-research"][src*="connector-openai-deep-research.web-sandbox.oaiusercontent.com"]';

const DEEP_RESEARCH_TARGET_URL_RE =
  /connector-openai-deep-research\.web-sandbox\.oaiusercontent\.com/i;

export function selectDeepResearchTargetForPage(
  targetInfos,
  { frameTargetIds = new Set(), parentTargetId = null } = {}
) {
  const matchingTargets = (Array.isArray(targetInfos) ? targetInfos : []).filter((target) =>
    DEEP_RESEARCH_TARGET_URL_RE.test(String(target?.url || ''))
  );
  return matchingTargets.find((target) =>
    frameTargetIds.has(String(target?.targetId || '').trim())
  ) || matchingTargets.find((target) =>
    String(target?.parentId || '').trim() === String(parentTargetId || '').trim()
  ) || (matchingTargets.length === 1 ? matchingTargets[0] : null);
}
