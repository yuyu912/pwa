const { areaList } = require("./area-data");

const STORAGE_KEY = "wardrobe_selected_region";
const LEVELS = ["province_list", "city_list", "county_list"];

function entries(level) {
  return Object.keys(areaList[level]).map((code) => ({ code, name: areaList[level][code] }));
}

function getName(code) {
  return areaList.province_list[code] || areaList.city_list[code] || areaList.county_list[code] || "";
}

function getParentCodes(code) {
  const provinceCode = `${code.slice(0, 2)}0000`;
  const cityCode = `${code.slice(0, 4)}00`;
  return { provinceCode, cityCode };
}

function getPath(code) {
  const { provinceCode, cityCode } = getParentCodes(code);
  if (code.endsWith("0000")) return [{ code, name: getName(code) }];
  if (code.endsWith("00")) return [{ code: provinceCode, name: getName(provinceCode) }, { code, name: getName(code) }];
  return [
    { code: provinceCode, name: getName(provinceCode) },
    { code: cityCode, name: getName(cityCode) || getName(provinceCode) },
    { code, name: getName(code) }
  ];
}

function provinces(keyword = "") {
  return entries(LEVELS[0]).filter((item) => item.name.includes(keyword));
}

function cities(provinceCode, keyword = "") {
  if (!provinceCode) return [];
  return entries(LEVELS[1]).filter((item) => item.code.slice(0, 2) === provinceCode.slice(0, 2) && item.name.includes(keyword));
}

function districts(cityCode, keyword = "") {
  if (!cityCode) return [];
  return entries(LEVELS[2]).filter((item) => item.code.slice(0, 4) === cityCode.slice(0, 4) && item.name.includes(keyword));
}

function search(keyword) {
  const term = keyword.trim();
  if (!term) return [];
  return LEVELS.flatMap((level) => entries(level).map((item) => ({ ...item, level }))).filter((item) => item.name.includes(term)).slice(0, 30).map((item) => ({ ...item, path: getPath(item.code).map((part) => part.name).join(" · ") }));
}

function loadLocation() { return wx.getStorageSync(STORAGE_KEY) || null; }
function saveLocation(location) { wx.setStorageSync(STORAGE_KEY, location); }

function formatLiveWeather(value, location) {
  const temperature = Number(value.temperature);
  const condition = value.condition || "未知";
  const rainy = /雨|雷|雪|冰雹/.test(condition);
  const cold = temperature <= 16;
  const hot = temperature >= 28;
  return {
    ...value,
    temperature,
    low: temperature,
    high: temperature,
    icon: /晴/.test(condition) ? "☀" : /雪/.test(condition) ? "❄" : rainy ? "☂" : "☁",
    tip: rainy
      ? "当前有降水，优先选择方便叠穿的衣物并留意防雨。"
      : hot
        ? "当前气温偏高，优先选择轻薄透气的衣物。"
        : cold
          ? "当前气温偏凉，建议采用内搭加外套的方式。"
          : "当前体感较温和，可优先选择轻薄或适中厚度的衣物。",
    needsOuterwear: rainy || temperature <= 20,
    city: value.city || location.cityName,
    area: location.fullName
  };
}

function isSeasonSuitable(item, weather) {
  if (!item.season || item.season === "多季") return true;
  if (weather.high >= 28) return item.season.includes("夏");
  if (weather.high <= 16) return item.season.includes("冬") || item.season.includes("秋");
  return item.season.includes("春") || item.season.includes("秋");
}

function isThicknessSuitable(item, weather) {
  if (weather.high >= 28) return item.thickness === "薄";
  if (weather.high <= 16) return item.thickness === "厚" || item.thickness === "适中";
  return item.thickness !== "厚";
}

function sceneFirst(items, scene) {
  return items
    .map((item, index) => ({ item, index, matchesScene: (item.scenes || []).includes(scene) }))
    .sort((left, right) => Number(right.matchesScene) - Number(left.matchesScene) || left.index - right.index)
    .map(({ item }) => item);
}

function pick(items, offset) {
  return items.length ? items[offset % items.length] : null;
}

function recommend(items, weather, scene = "休闲", offset = 0) {
  const suitable = items.filter((item) => isSeasonSuitable(item, weather) && isThicknessSuitable(item, weather));
  const ranked = sceneFirst(suitable, scene);
  const dresses = ranked.filter((item) => item.category === "连衣裙");
  const tops = ranked.filter((item) => ["上衣", "T恤", "衬衫", "针织衫"].includes(item.category));
  const bottoms = ranked.filter((item) => ["裤子", "半身裙"].includes(item.category));
  const outerwear = ranked.filter((item) => ["外套", "夹克", "风衣"].includes(item.category));
  const dress = pick(dresses, offset);
  const base = dress ? [dress] : [pick(tops, offset), pick(bottoms, offset)].filter(Boolean);
  const outerwearItem = pick(outerwear, offset);
  if (weather.needsOuterwear && outerwearItem) base.push(outerwearItem);
  const missing = [];
  if (!base.length) missing.push("适合当前温度的衣物");
  if (!dresses.length && !tops.length) missing.push("上装或连衣裙");
  if (!dresses.length && !bottoms.length) missing.push("下装或连衣裙");
  if (weather.needsOuterwear && !outerwear.length) missing.push("轻外套");
  const sceneMatchedCount = base.filter((item) => (item.scenes || []).includes(scene)).length;
  return {
    items: base,
    suitableCount: suitable.length,
    missing,
    complete: missing.length === 0,
    reason: sceneMatchedCount
      ? `优先选择了适合${scene}、且符合当前实时温度的衣物。`
      : `暂未找到标注为${scene}的合适衣物，已按当前实时温度推荐。`
  };
}

module.exports = { provinces, cities, districts, search, getPath, loadLocation, saveLocation, formatLiveWeather, recommend };
