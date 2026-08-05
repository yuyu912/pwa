"use strict";

const countValues = (records, selector) => {
  const counts = new Map();
  records.forEach((record) => selector(record).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh-CN"));
};

const top = (records, selector, limit = 5) => countValues(records, selector).slice(0, limit).map(([name, count]) => ({ name, count }));

const COLOR_FAMILIES = [
  ["黑", "黑色", "深黑"], ["白", "白色", "米白", "奶白"], ["灰", "灰色", "浅灰", "深灰"],
  ["红", "红色", "酒红", "粉", "粉色", "玫红"], ["蓝", "蓝色", "藏蓝", "天蓝", "牛仔蓝"],
  ["绿", "绿色", "墨绿", "军绿"], ["黄", "黄色", "姜黄", "橙", "橙色"],
  ["棕", "棕色", "咖色", "卡其", "驼色"], ["紫", "紫色", "香芋紫"]
];
const normalized = (value) => String(value || "").trim().toLowerCase();
const colorFamily = (value) => {
  const color = normalized(value);
  if (!color) return "";
  const family = COLOR_FAMILIES.find((values) => values.some((entry) => color.includes(entry)));
  return family ? family[0] : color;
};
const compatibleColor = (left, right) => !normalized(left) || !normalized(right) || colorFamily(left) === colorFamily(right);
const compatiblePattern = (left, right) => !normalized(left) || !normalized(right) || normalized(left) === normalized(right);

const buildOutfitCandidates = (detection, entries) => entries
  .filter((entry) => entry.item?.category === detection.category)
  .map((entry) => {
    const visualScore = Math.round(Number(entry.visualSimilarity || 0) * 100);
    if (visualScore < 70 || !compatibleColor(detection.color, entry.item.color) || !compatiblePattern(detection.pattern, entry.item.pattern)) return null;
    const detectionStyles = new Set(Array.isArray(detection.styles) ? detection.styles : []);
    const styleOverlap = (Array.isArray(entry.item.styles) ? entry.item.styles : []).some((style) => detectionStyles.has(style));
    const attributeScore = (normalized(detection.color) && normalized(entry.item.color) ? 10 : 5)
      + (normalized(detection.pattern) && normalized(entry.item.pattern) ? 5 : 2.5)
      + (styleOverlap ? 5 : 0);
    const score = Math.round(visualScore * 0.8 + attributeScore);
    return score >= 75 ? { ...entry, visualScore, score } : null;
  })
  .filter(Boolean)
  .sort((left, right) => right.score - left.score)
  .slice(0, 3);

const buildStyleProfile = (records) => {
  const confirmed = records.filter((record) => record.status === "confirmed");
  const items = confirmed.flatMap((record) => record.items || []);
  const combinations = confirmed.map((record) => [...new Set((record.items || []).map((item) => item.category).filter(Boolean))].sort().join("＋")).filter(Boolean);
  const itemCounts = new Map();
  items.forEach((item) => {
    const key = String(item.id || item.name || "");
    if (key) itemCounts.set(key, { id: item.id || "", name: item.name || "未命名衣物", count: (itemCounts.get(key)?.count || 0) + 1 });
  });
  const count = confirmed.length;
  const seasonName = (value) => {
    const month = new Date(value).getMonth() + 1;
    return month <= 2 || month === 12 ? "冬季" : month <= 5 ? "春季" : month <= 8 ? "夏季" : "秋季";
  };
  return {
    count,
    stage: count < 10 ? "insufficient" : count < 20 ? "forming" : "stable",
    stageText: count < 10 ? `再记录 ${10 - count} 套，开始形成风格` : count < 20 ? "个人风格正在形成" : "已形成稳定的事实型画像",
    colors: top(items, (item) => [item.color]),
    categories: top(items, (item) => [item.category]),
    styles: top(items, (item) => Array.isArray(item.styles) ? item.styles : []),
    scenes: top(confirmed, (record) => [record.scene]),
    seasons: top(confirmed, (record) => [seasonName(record.worn_at)]),
    combinations: top(combinations, (value) => [value]),
    frequentItems: [...itemCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5)
  };
};

const normalizeTrendSample = (sample) => ({
  source: sample.source,
  cityCode: sample.city_code,
  cityName: sample.city_name,
  publishedAt: sample.published_at,
  authorHash: sample.anonymous_author_hash,
  colors: Array.isArray(sample.colors) ? sample.colors : [],
  categories: Array.isArray(sample.categories) ? sample.categories : [],
  styles: Array.isArray(sample.styles) ? sample.styles : []
});

const buildCityTrend = (samples, cityCode, timestamp = Date.now(), minimumAuthors = 20) => {
  const normalized = samples.map(normalizeTrendSample).filter((sample) => sample.cityCode === cityCode && sample.authorHash);
  const selectRange = (days) => normalized.filter((sample) => Date.parse(sample.publishedAt) >= timestamp - days * 86400000);
  const authors = (rows) => new Set(rows.map((row) => row.authorHash)).size;
  let rows = selectRange(1);
  let range = "24h";
  if (authors(rows) < minimumAuthors) { rows = selectRange(7); range = "7d"; }
  const authorCount = authors(rows);
  if (authorCount < minimumAuthors) return { status: "insufficient", range, authorCount, minimumAuthors, colors: [], categories: [], styles: [] };
  return {
    status: "ready", range, authorCount, minimumAuthors,
    colors: top(rows, (row) => row.colors), categories: top(rows, (row) => row.categories), styles: top(rows, (row) => row.styles)
  };
};

module.exports = { buildCityTrend, buildOutfitCandidates, buildStyleProfile, normalizeTrendSample };
