const CAPSULE_TARGETS = {
  上衣: 3,
  裤子: 2,
  半身裙: 1,
  外套: 1,
  连衣裙: 1,
  鞋子: 2,
};

const asList = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
const overlaps = (left, right) => left.some((value) => right.includes(value));
const seasonMatches = (left, right) => left === "四季" || right === "四季" || left === right;
const sceneMatches = (candidate, item) => {
  const candidateScenes = asList(candidate.scenes);
  const itemScenes = asList(item.scenes);
  return candidateScenes.length > 0 && itemScenes.length > 0 && overlaps(candidateScenes, itemScenes);
};
const colorFamily = (value) => String(value || "").split("（")[0];

function partnerScore(candidate, item) {
  let score = 0;
  const candidateColor = colorFamily(candidate.color);
  const itemColor = colorFamily(item.color);
  if (candidateColor === "中性色" || itemColor === "中性色") score += 20;
  else if (candidateColor && candidateColor === itemColor) score += 15;
  else score += 8;
  if (overlaps(asList(candidate.styles), asList(item.styles))) score += 12;
  score -= Math.min(10, Number(item.wearCount || 0));
  return score;
}

function baseCombinations(items, category) {
  const tops = items.filter((item) => item.category === "上衣");
  const bottoms = items.filter((item) => ["裤子", "半身裙"].includes(item.category));
  const dresses = items.filter((item) => item.category === "连衣裙");
  if (category === "上衣") return bottoms.map((item) => [item]);
  if (["裤子", "半身裙"].includes(category)) return tops.map((item) => [item]);
  if (category === "连衣裙") return items.filter((item) => ["外套", "鞋子"].includes(item.category)).map((item) => [item]);
  if (["外套", "鞋子"].includes(category)) {
    return [
      ...dresses.map((item) => [item]),
      ...tops.flatMap((top) => bottoms.map((bottom) => [top, bottom])),
    ];
  }
  return [];
}

function compatibleCombination(candidate, combination) {
  return combination.every((item) => seasonMatches(candidate.season, item.season) && sceneMatches(candidate, item));
}

function missingPartners(candidate, items, compatible) {
  const hasCompatible = (category) => compatible.some((outfit) => outfit.some((item) => item.category === category));
  if (candidate.category === "上衣") return compatible.length ? [] : ["下装"];
  if (["裤子", "半身裙"].includes(candidate.category)) return compatible.length ? [] : ["上衣"];
  if (candidate.category === "连衣裙") {
    return ["外套", "鞋子"].filter((category) => items.some((item) => item.category === category) && !hasCompatible(category));
  }
  if (["外套", "鞋子"].includes(candidate.category)) return compatible.length ? [] : ["上衣＋下装或连衣裙"];
  return [];
}

export function buildPurchaseAnalysis(candidate, items, similarities, options = {}) {
  const similarityAvailable = options.similarityAvailable !== false;
  const closet = items.filter((item) => item?.id);
  const rankedSimilarities = (similarityAvailable ? similarities : [])
    .filter(({ item, score }) => item?.id && Number.isFinite(score))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  const maxSimilarity = similarityAvailable ? rankedSimilarities[0]?.score || 0 : null;
  const conflictLevel = !similarityAvailable
    ? "相似度未计算"
    : maxSimilarity >= .85 ? "几乎同款" : maxSimilarity >= .6 ? "存在相似款" : "无明显同款";

  const structural = baseCombinations(closet, candidate.category);
  const compatible = structural
    .filter((combination) => compatibleCombination(candidate, combination))
    .sort((left, right) => {
      const leftScore = left.reduce((sum, item) => sum + partnerScore(candidate, item), 0);
      const rightScore = right.reduce((sum, item) => sum + partnerScore(candidate, item), 0);
      return rightScore - leftScore;
    });
  const matchRate = structural.length ? compatible.length / structural.length : 0;
  const outfits = compatible.slice(0, 3).map((itemsInOutfit) => [candidate, ...itemsInOutfit]);
  const missing = missingPartners(candidate, closet, compatible);

  const counts = Object.fromEntries(Object.keys(CAPSULE_TARGETS).map((category) => [
    category,
    closet.filter((item) => item.category === category).length,
  ]));
  const fillsGap = (counts[candidate.category] || 0) < (CAPSULE_TARGETS[candidate.category] || 0);
  const nextGap = Object.entries(CAPSULE_TARGETS)
    .map(([category, target]) => ({ category, deficit: Math.max(0, target - (counts[category] || 0)), target }))
    .filter(({ deficit }) => deficit > 0)
    .sort((left, right) => (right.deficit / right.target) - (left.deficit / left.target))[0]?.category || "暂无明显品类缺口";

  const coveredScenes = new Set(asList(candidate.scenes));
  compatible.flat().forEach((item) => asList(item.scenes).forEach((scene) => coveredScenes.add(scene)));
  const sceneCoverage = Math.min(1, coveredScenes.size / 4);
  const gapScore = fillsGap ? 1 : .35;
  const ruleScore = similarityAvailable
    ? Math.round((Math.max(0, 1 - maxSimilarity) * .25 + matchRate * .35 + sceneCoverage * .2 + gapScore * .2) * 100)
    : Math.round((matchRate * .45 + sceneCoverage * .25 + gapScore * .3) * 100);
  const verdict = similarityAvailable && maxSimilarity >= .85
    ? "不建议购买"
    : ruleScore >= 70 && compatible.length > 0
      ? "推荐购买"
      : (similarityAvailable && maxSimilarity >= .6) || ruleScore < 50
        ? "暂时观望"
        : "建议试穿";

  return {
    maxSimilarity,
    similarityAvailable,
    conflictLevel,
    topSimilarities: rankedSimilarities,
    structuralCount: structural.length,
    compatibleCount: compatible.length,
    matchRate,
    outfits,
    missing,
    fillsGap,
    nextGap,
    coveredScenes: [...coveredScenes],
    ruleScore,
    verdict,
  };
}

export { CAPSULE_TARGETS };
