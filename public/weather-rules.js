export function weatherKind(code) {
  const value = Number(code);
  if (value === 0) return "sunny";
  if (value >= 1 && value <= 3) return "partly";
  if (value === 45 || value === 48) return "fog";
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82)) return "rain";
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return "snow";
  if (value >= 95) return "thunder";
  return "partly";
}

export const weatherLabels = {
  sunny: "晴",
  partly: "多云",
  rain: "有雨",
  snow: "有雪",
  fog: "有雾",
  thunder: "雷雨",
};

const includesAny = (value, candidates) => candidates.some((candidate) => String(value || "").includes(candidate));
const categoryIs = (item, categories) => categories.includes(item.category);

function itemScore(item, context) {
  let score = 0;
  if (item.season === "四季" || context.seasons.includes(item.season)) score += 40;
  if (item.scenes?.includes("日常")) score += 15;
  if (context.hot && includesAny(item.material, ["棉", "亚麻", "雪纺"])) score += 12;
  if (context.cold && includesAny(item.material, ["针织", "羊毛", "呢"])) score += 12;
  if (context.wet && includesAny(item.material, ["麂皮", "真丝"])) score -= 25;
  score -= Math.min(20, Number(item.wearCount || 0) * 2);
  return score;
}

function choose(items, categories, context, excluded = []) {
  const excludedIds = new Set(excluded.map((item) => item.id));
  return items
    .filter((item) => categoryIs(item, categories) && !excludedIds.has(item.id))
    .sort((left, right) => itemScore(right, context) - itemScore(left, context))[0] || null;
}

export function buildOutfitRecommendation(items, weather) {
  const apparent = Number(weather.apparentTemperature);
  const wet = weather.kind === "rain" || weather.kind === "snow" || Number(weather.precipitationProbability) >= 50;
  const windy = Number(weather.windSpeed) >= 25;
  const context = {
    hot: apparent >= 27,
    cold: apparent <= 12,
    wet,
    windy,
    seasons: apparent <= 8 ? ["冬季"] : apparent <= 20 ? ["春秋"] : ["夏季"],
  };
  const normalized = items.filter((item) => item && item.id);
  if (!normalized.length) return { itemIds: [], items: [], missing: ["衣物"], reason: "衣橱还是空的，先录入衣物后再生成真实搭配。" };

  const dress = choose(normalized, ["连衣裙"], context);
  const top = choose(normalized, ["上衣"], context);
  const bottom = wet
    ? choose(normalized, ["裤子"], context, top ? [top] : [])
      || choose(normalized, ["半身裙"], context, top ? [top] : [])
    : choose(normalized, ["半身裙", "裤子"], context, top ? [top] : []);
  const useDress = Boolean(dress && (!top || !bottom || itemScore(dress, context) >= (itemScore(top, context) + itemScore(bottom, context)) / 2));
  const selected = useDress ? [dress] : [top, bottom].filter(Boolean);
  if (apparent < 18 || windy) {
    const outer = choose(normalized, ["外套"], context, selected);
    if (outer) selected.push(outer);
  }
  const shoes = choose(normalized, ["鞋子"], context, selected);
  if (shoes) selected.push(shoes);

  const missing = [];
  if (!useDress && !top) missing.push("上衣");
  if (!useDress && !bottom) missing.push("下装");
  if ((apparent < 18 || windy) && !selected.some((item) => item.category === "外套")) missing.push("外套");
  if (!shoes) missing.push("鞋子");

  const reasons = [];
  reasons.push(`体感 ${Math.round(apparent)}°C，优先选择${context.seasons.join("或")}衣物`);
  if (wet) reasons.push("有降水可能，优先裤装并避开不耐水材质");
  if (windy) reasons.push("风力偏大，建议增加外套");
  if (!wet && !windy) reasons.push("天气较平稳，优先轮换穿着次数较少的衣物");

  return {
    itemIds: selected.map((item) => item.id),
    items: selected,
    missing,
    reason: reasons.join("；"),
  };
}
