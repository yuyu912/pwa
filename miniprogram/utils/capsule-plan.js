const CATEGORY_RULES = [
  { key: "tops", categories: ["上衣", "T恤", "衬衫", "针织衫"], limit: 3 },
  { key: "bottoms", categories: ["裤子", "半身裙"], limit: 2 },
  { key: "dresses", categories: ["连衣裙"], limit: 1 },
  { key: "outerwear", categories: ["外套", "夹克", "风衣"], limit: 1 },
  { key: "shoes", categories: ["鞋子"], limit: 1 }
];

function wearCount(item) {
  return Number(item.wearCount ?? item.wear_count ?? 0);
}

function ranked(items, scene) {
  return items
    .map((item, index) => ({ item, index, sceneMatch: (item.scenes || []).includes(scene) }))
    .sort((left, right) => Number(right.sceneMatch) - Number(left.sceneMatch)
      || wearCount(left.item) - wearCount(right.item)
      || left.index - right.index)
    .map(({ item }) => item);
}

function rotate(items, offset) {
  if (!items.length) return [];
  const start = offset % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function reasonFor(item, scene) {
  const sceneReason = (item.scenes || []).includes(scene) ? `适合${scene}` : "补足胶囊结构";
  return `${sceneReason} · 累计穿着 ${wearCount(item)} 次，纳入本周轮换`;
}

function buildCapsulePlan(items, scene = "休闲", offset = 0) {
  const sorted = rotate(ranked(items, scene), offset);
  const groups = {};
  CATEGORY_RULES.forEach((rule) => {
    groups[rule.key] = sorted.filter((item) => rule.categories.includes(item.category)).slice(0, rule.limit);
  });
  const selected = CATEGORY_RULES.flatMap((rule) => groups[rule.key]).map((item) => ({
    ...item,
    capsuleReason: reasonFor(item, scene)
  }));
  const combinationCount = groups.dresses.length + (groups.tops.length * groups.bottoms.length);
  const missing = [];
  if (!groups.dresses.length && !groups.tops.length) missing.push("上装或连衣裙");
  if (!groups.dresses.length && !groups.bottoms.length) missing.push("下装或连衣裙");
  const optionalMissing = [];
  if (!groups.outerwear.length) optionalMissing.push("外套");
  if (!groups.shoes.length) optionalMissing.push("鞋子");
  return {
    scene,
    items: selected,
    itemCount: selected.length,
    combinationCount,
    coversSevenDays: combinationCount >= 7,
    missing,
    optionalMissing,
    sceneMatchedCount: selected.filter((item) => (item.scenes || []).includes(scene)).length
  };
}

module.exports = { buildCapsulePlan };
