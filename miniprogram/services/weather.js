const { areaList } = require("./area-data");

const STORAGE_KEY = "wardrobe_selected_region";
const WEATHER_OVERRIDE_KEY = "wardrobe_weather_override";
const LEVELS = ["province_list", "city_list", "county_list"];
const WEATHER_CONDITIONS = ["晴", "多云", "阴", "阵雨", "小雨", "中雨", "大雨", "雷雨", "雨夹雪", "雪", "雾霾", "大风"];
const MIN_TEMPERATURE = -30;
const MAX_TEMPERATURE = 50;

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

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function locationKey(location) {
  return location?.districtCode || location?.cityCode || location?.provinceCode || location?.fullName || location?.cityName || "";
}

function clampTemperature(value) {
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) return 20;
  return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, Math.round(temperature)));
}

function createWeatherOverride(location, condition, temperature, now = new Date()) {
  return {
    locationKey: locationKey(location),
    date: localDateKey(now),
    condition: WEATHER_CONDITIONS.includes(condition) ? condition : "晴",
    temperature: clampTemperature(temperature)
  };
}

function isWeatherOverrideValid(override, location, now = new Date()) {
  return Boolean(
    override &&
    override.locationKey &&
    override.locationKey === locationKey(location) &&
    override.date === localDateKey(now) &&
    WEATHER_CONDITIONS.includes(override.condition) &&
    Number.isFinite(Number(override.temperature))
  );
}

function loadWeatherOverride(location, now = new Date()) {
  const override = wx.getStorageSync(WEATHER_OVERRIDE_KEY) || null;
  if (isWeatherOverrideValid(override, location, now)) return override;
  if (override) wx.removeStorageSync(WEATHER_OVERRIDE_KEY);
  return null;
}

function saveWeatherOverride(location, condition, temperature) {
  const override = createWeatherOverride(location, condition, temperature);
  wx.setStorageSync(WEATHER_OVERRIDE_KEY, override);
  return override;
}

function clearWeatherOverride() { wx.removeStorageSync(WEATHER_OVERRIDE_KEY); }

function formatLiveWeather(value, location) {
  const temperature = Number(value.temperature);
  const suppliedLow = Number(value.low);
  const suppliedHigh = Number(value.high);
  const low = Number.isFinite(suppliedLow) ? suppliedLow : temperature;
  const high = Number.isFinite(suppliedHigh) ? suppliedHigh : temperature;
  const rangeLow = Math.min(low, high);
  const rangeHigh = Math.max(low, high);
  const temperatureSwing = Math.round(rangeHigh - rangeLow);
  const largeTemperatureSwing = temperatureSwing >= 8;
  const condition = value.condition || "未知";
  const rainy = /雨|雷|雪|冰雹/.test(condition);
  const windy = /大风|强风|狂风|台风/.test(condition);
  const hazy = /雾|霾/.test(condition);
  const cold = temperature <= 16;
  const hot = temperature >= 28;
  const baseTip = rainy
    ? "当前有降水，优先选择方便叠穿的衣物并留意防雨。"
    : windy
      ? "当前风力较强，建议准备轻外套并优先选择方便活动的衣物。"
      : hazy
        ? "当前有雾或霾，穿搭按温度选择，外出请同时留意能见度和空气质量。"
        : hot
          ? "当前气温偏高，优先选择轻薄透气的衣物。"
          : cold
            ? "当前气温偏凉，建议采用内搭加外套的方式。"
            : "当前体感较温和，可优先选择轻薄或适中厚度的衣物。";
  const swingTip = largeTemperatureSwing ? ` 当天预计${rangeLow}—${rangeHigh}℃，早晚温差${temperatureSwing}℃，建议选择可穿脱叠层。` : "";
  return {
    ...value,
    temperature,
    low: rangeLow,
    high: rangeHigh,
    temperatureSwing,
    largeTemperatureSwing,
    icon: /晴/.test(condition) ? "☀" : /雪/.test(condition) ? "❄" : rainy ? "☂" : "☁",
    tip: `${baseTip}${swingTip}`,
    // 15℃以下或明显风雨才强制外套；16—22℃交给整套保暖评分决定是否叠穿。
    needsOuterwear: rainy || windy || rangeLow <= 15,
    considerOuterwear: rangeLow <= 22 || largeTemperatureSwing,
    city: value.city || location.cityName,
    area: location.fullName
  };
}

function applyWeatherOverride(weather, override) {
  if (!override) return { ...weather, isManual: false };
  const overridden = formatLiveWeather({
    ...weather,
    condition: override.condition,
    temperature: clampTemperature(override.temperature),
    low: clampTemperature(override.temperature),
    high: clampTemperature(override.temperature),
    dayCondition: override.condition,
    nightCondition: override.condition
  }, {
    cityName: weather.city,
    fullName: weather.area
  });
  return {
    ...overridden,
    isManual: true,
    liveCondition: weather.condition,
    liveTemperature: weather.temperature
  };
}

function effectiveWeather(value, location) {
  const liveWeather = formatLiveWeather(value, location);
  return applyWeatherOverride(liveWeather, loadWeatherOverride(location));
}

function temperatureOf(weather) {
  const value = Number(weather?.temperature ?? weather?.high);
  return Number.isFinite(value) ? value : 20;
}

function weatherTemperatureRange(weather) {
  const current = temperatureOf(weather);
  const suppliedLow = Number(weather?.low);
  const suppliedHigh = Number(weather?.high);
  const low = Number.isFinite(suppliedLow) ? suppliedLow : current;
  const high = Number.isFinite(suppliedHigh) ? suppliedHigh : current;
  return { low: Math.min(low, high), high: Math.max(low, high), swing: Math.abs(high - low) };
}

function isExtremeWeatherCompatible(item, weather) {
  const range = weatherTemperatureRange(weather);
  if (range.high >= 30 && item.thickness === "厚") return false;
  if (!item.season || item.season === "多季") return true;
  if (range.low >= 30) return item.season.includes("夏");
  // 寒冷天气是否可穿必须结合整套叠层判断，不能在单件阶段误删可作内层的薄衣。
  return true;
}

function isSeasonSuitable(item, weather) {
  if (!item.season || item.season === "多季") return true;
  const range = weatherTemperatureRange(weather);
  if (range.low >= 26) return item.season.includes("夏");
  if (range.high <= 15) return item.season.includes("冬") || item.season.includes("秋");
  return item.season.includes("春") || item.season.includes("秋");
}

function targetWarmthForTemperature(temperature) {
  // 30℃约为1.2，之后每降低5℃增加1级保暖需求；连续函数避免20/21℃突然跳档。
  return Math.max(1.2, Math.min(5.6, 1.2 + (30 - Number(temperature)) / 5));
}

function itemWarmth(item) {
  const base = item.thickness === "薄" ? 1 : item.thickness === "厚" ? 3 : item.thickness === "适中" ? 2 : 1.8;
  if (["外套", "夹克", "风衣"].includes(item.category)) return base * 1.2;
  if (["裤子", "半身裙"].includes(item.category)) return base * 0.35;
  if (item.category === "连衣裙") return base * 1.25;
  return base;
}

function combinationWarmth(items) {
  return items.reduce((sum, item) => sum + itemWarmth(item), 0);
}

function warmthWindow(temperature, preferences = {}) {
  const target = preferenceWarmthTarget(temperature, preferences);
  const lowerTolerance = temperature >= 24 ? 1 : temperature <= 10 ? 0.6 : 0.8;
  // 高温仍淘汰单件厚款，但“适中”标签同时覆盖短袖、薄牛仔等差异较大的衣物，组合上限需保留合理容差。
  const upperTolerance = temperature >= 28 ? 1.6 : temperature <= 10 ? 2.2 : 1.2;
  return { target, min: target - lowerTolerance, max: target + upperTolerance };
}

function combinationWeatherSafe(items, weather, preferences = {}) {
  if (!items.length) return false;
  const range = weatherTemperatureRange(weather);
  const outerwearItems = items.filter((item) => ["外套", "夹克", "风衣"].includes(item.category));
  const baseItems = items.filter((item) => !["外套", "夹克", "风衣"].includes(item.category));
  if (outerwearMode(weather) === "required" && !outerwearItems.length) return false;
  if (range.swing >= 8) {
    const warmWindow = warmthWindow(range.high, preferences);
    const coolWindow = warmthWindow(range.low, preferences);
    const warmPeriodWarmth = combinationWarmth(baseItems);
    const coolPeriodWarmth = combinationWarmth(items);
    if (warmPeriodWarmth < warmWindow.min || warmPeriodWarmth > warmWindow.max) return false;
    if (coolPeriodWarmth < coolWindow.min || coolPeriodWarmth > coolWindow.max) return false;
  } else {
    const currentWindow = warmthWindow(temperatureOf(weather), preferences);
    const warmth = combinationWarmth(items);
    if (warmth < currentWindow.min || warmth > currentWindow.max) return false;
  }
  if (range.high <= 9) {
    const summerThinDress = items.some((item) => item.category === "连衣裙" && item.thickness === "薄" && /春|夏/.test(String(item.season || "")));
    if (summerThinDress && !outerwearItems.some((item) => item.thickness === "厚")) return false;
  }
  return true;
}

function outerwearMode(weather) {
  const range = weatherTemperatureRange(weather);
  const hazardous = /雨|雷|雪|冰雹|大风|强风|狂风|台风/.test(String(weather?.condition || ""));
  if (hazardous || range.low <= 15) return "required";
  if (range.low <= 22 || range.swing >= 8) return "optional";
  return "none";
}

function sceneFirst(items, scene) {
  return items
    .map((item, index) => ({ item, index, matchesScene: (item.scenes || []).includes(scene) }))
    .sort((left, right) => Number(right.matchesScene) - Number(left.matchesScene) || left.index - right.index)
    .map(({ item }) => item);
}

const COLOR_RULES = {
  green: ["black", "white", "beige", "brown", "purple"],
  darkGreen: ["purple", "black", "yellow", "blueGreen", "khaki"],
  yellow: ["black", "blue", "purple", "brown", "white"],
  pink: ["darkGreen", "white", "beige", "burgundy", "blue"],
  red: ["black", "brown", "beige", "gray", "blue"],
  blue: ["white", "pink", "green", "gray", "brown"],
  lightBlue: ["white", "pink", "green", "gray", "brown"],
  brown: ["white", "beige", "black", "red", "pink"],
  purple: ["lightBlue", "pink", "white", "black", "brown"]
};
const NEUTRAL_COLORS = new Set(["black", "white", "beige", "gray", "brown", "khaki"]);
const CORE_STYLES = new Set(["韩系", "清新", "酷飒", "复古", "甜美", "街头", "优雅", "度假"]);

function colorKey(value) {
  const color = String(value || "").toLowerCase();
  if (!color) return "";
  if (/深绿|墨绿|森林绿/.test(color)) return "darkGreen";
  if (/蓝绿|青绿|薄荷/.test(color)) return "blueGreen";
  if (/浅蓝|天蓝|雾蓝/.test(color)) return "lightBlue";
  if (/酒红|勃艮第/.test(color)) return "burgundy";
  if (/米白|奶油|象牙|米色/.test(color)) return "beige";
  if (/卡其/.test(color)) return "khaki";
  if (/咖啡|咖色|棕|驼/.test(color)) return "brown";
  if (/粉|玫红/.test(color)) return "pink";
  if (/紫/.test(color)) return "purple";
  if (/绿/.test(color)) return "green";
  if (/黄|金/.test(color)) return "yellow";
  if (/蓝|牛仔/.test(color)) return "blue";
  if (/红/.test(color)) return "red";
  if (/黑|炭灰/.test(color)) return "black";
  if (/灰|银/.test(color)) return "gray";
  if (/白/.test(color)) return "white";
  return color;
}

function broadColorKey(key) {
  if (["lightBlue", "blue", "blueGreen"].includes(key)) return "blue";
  if (["green", "darkGreen"].includes(key)) return "green";
  if (["red", "burgundy", "pink"].includes(key)) return "red";
  if (["beige", "brown", "khaki"].includes(key)) return "earth";
  return key;
}

function colorRelationship(anchorColor, partnerColor) {
  const anchor = colorKey(anchorColor);
  const partner = colorKey(partnerColor);
  if (!anchor || !partner) return { score: 0, reason: "" };
  if (anchor === partner) return { score: 30, reason: "同色呼应" };
  if (broadColorKey(anchor) === broadColorKey(partner)) return { score: 26, reason: "同色系深浅有层次" };
  if ((COLOR_RULES[anchor] || []).includes(partner)) return { score: 22, reason: "颜色口诀协调配色" };
  if (NEUTRAL_COLORS.has(anchor) || NEUTRAL_COLORS.has(partner)) return { score: 16, reason: "中性色稳定协调" };
  return { score: -10, reason: "颜色关系较弱" };
}

function patternKey(value) {
  const pattern = String(value || "");
  if (!pattern || /纯色|无图案/.test(pattern)) return "solid";
  if (/格纹|格子|棋盘/.test(pattern)) return "plaid";
  if (/条纹|条子/.test(pattern)) return "stripe";
  if (/波点|圆点/.test(pattern)) return "dot";
  if (/碎花|花卉|印花/.test(pattern)) return "floral";
  return "pattern";
}

function sharedCoreStyles(items) {
  const styleLists = items.map((item) => (item.styles || []).filter((style) => CORE_STYLES.has(style))).filter((styles) => styles.length);
  if (styleLists.length < 2) return [];
  return styleLists[0].filter((style) => styleLists.slice(1).some((styles) => styles.includes(style)));
}

function preferenceWarmthTarget(temperature, preferences = {}) {
  const adjustment = preferences.warmthPreference === "warmer" ? 0.7 : preferences.warmthPreference === "cooler" ? -0.7 : 0;
  return targetWarmthForTemperature(temperature) + adjustment;
}

function scoreCombination(items, scene, weather, preferences = {}) {
  const sceneMatches = items.filter((item) => (item.scenes || []).includes(scene)).length;
  let score = items.length ? Math.round(sceneMatches / items.length * 30) : 0;
  const reasons = [];
  const range = weatherTemperatureRange(weather);
  const outerwearItems = items.filter((item) => ["外套", "夹克", "风衣"].includes(item.category));
  if (range.swing >= 8) {
    const warmPeriodItems = items.filter((item) => !["外套", "夹克", "风衣"].includes(item.category));
    const warmGap = combinationWarmth(warmPeriodItems) - preferenceWarmthTarget(range.high, preferences);
    const coolGap = combinationWarmth(items) - preferenceWarmthTarget(range.low, preferences);
    score += Math.max(-20, Math.round(40 - (Math.abs(warmGap) + Math.abs(coolGap)) * 8));
    if (outerwearItems.length) { score += 10; reasons.push(`早晚温差${range.swing}℃，外套可穿脱调节`); }
    else score -= 10;
  } else {
    const warmthGap = combinationWarmth(items) - preferenceWarmthTarget(temperatureOf(weather), preferences);
    score += Math.max(-20, Math.round(40 - Math.abs(warmthGap) * 14));
    if (Math.abs(warmthGap) <= 0.55) reasons.push("整套保暖度贴合当前气温");
  }
  const seasonMatches = items.filter((item) => isSeasonSuitable(item, weather)).length;
  score += items.length ? Math.round(seasonMatches / items.length * 10) : 0;
  const coreStyles = sharedCoreStyles(items);
  if (coreStyles.length) { score += 18; reasons.push(`${coreStyles.slice(0, 2).join("、")}风格呼应`); }
  const styledItems = items.filter((item) => (item.styles || []).some((style) => CORE_STYLES.has(style)));
  if (styledItems.length > 1 && !coreStyles.length) { score -= 14; reasons.push("核心风格缺少呼应"); }
  const patterned = items.filter((item) => patternKey(item.pattern) !== "solid");
  if (patterned.length === 1 && items.length > 1) { score += 12; reasons.push("图案单品搭配纯色更有重点"); }
  else if (patterned.length > 1) { score -= 16; reasons.push("多件图案视觉重点较多"); }
  const detailed = items.filter((item) => Array.isArray(item.designDetails || item.design_details) && (item.designDetails || item.design_details).length);
  if (detailed.length === 1 && items.length > 1) { score += 8; reasons.push("保留一个设计重点"); }
  else if (detailed.length > 1) score -= 8;
  for (let index = 0; index < items.length - 1; index += 1) {
    const relation = colorRelationship(items[index].color, items[index + 1].color);
    score += relation.score;
    if (relation.reason && !reasons.includes(relation.reason)) reasons.push(relation.reason);
  }
  const requestedStyles = Array.isArray(preferences.styles) ? preferences.styles : [];
  const styleMatches = items.filter((item) => (item.styles || []).some((style) => requestedStyles.includes(style))).length;
  if (requestedStyles.length && styleMatches) { score += styleMatches * 12; reasons.push(`呼应你想要的${requestedStyles.join("、")}风格`); }
  const preferredColors = (preferences.preferredColors || []).map(colorKey);
  const preferredMatches = items.filter((item) => preferredColors.includes(colorKey(item.color))).length;
  if (preferredMatches) { score += preferredMatches * 10; reasons.push("优先使用你喜欢的颜色"); }
  return { score, reasons };
}

function buildCombinations(tops, bottoms, dresses, outerwear, weather, scene, preferences = {}) {
  const bases = dresses.map((dress) => [dress]);
  tops.forEach((top) => bottoms.forEach((bottom) => bases.push([top, bottom])));
  const combinations = [];
  const mode = outerwearMode(weather);
  bases.forEach((base) => {
    if (mode === "required") outerwear.forEach((item) => combinations.push([...base, item]));
    else if (mode === "optional") {
      combinations.push(base);
      outerwear.forEach((item) => combinations.push([...base, item]));
    } else combinations.push(base);
  });
  const weatherSafe = combinations.filter((items) => combinationWeatherSafe(items, weather, preferences));
  const preferredCategories = new Set(preferences.preferredCategories || []);
  const preferred = preferredCategories.size
    ? weatherSafe.filter((items) => items.some((item) => preferredCategories.has(item.category)))
    : [];
  const preferredPool = preferred.length ? preferred : weatherSafe;
  const lockedItemIds = new Set(preferences.lockedItemIds || []);
  const locked = lockedItemIds.size
    ? preferredPool.filter((items) => [...lockedItemIds].every((id) => items.some((item) => item.id === id)))
    : [];
  // 锁定单品和目标品类都只在天气安全组合内生效；目标无安全候选时才降级。
  return (locked.length ? locked : preferredPool).map((items) => ({ items, ...scoreCombination(items, scene, weather, preferences) }))
    .sort((left, right) => right.score - left.score || left.items.map((item) => item.id).join("|").localeCompare(right.items.map((item) => item.id).join("|")))
    .slice(0, 3);
}

function recommend(items, weather, scene = "休闲", offset = 0, preferences = {}) {
  // 先建立天气安全候选，再在安全框架内处理场景、风格、颜色和用户偏好。
  const excludedCategories = new Set(preferences.excludedCategories || []);
  const excludedColors = new Set((preferences.excludedColors || []).map(colorKey));
  const excludedItemIds = new Set(preferences.excludedItemIds || []);
  const suitable = items.filter((item) => isExtremeWeatherCompatible(item, weather)
    && !excludedCategories.has(item.category)
    && !excludedItemIds.has(item.id)
    && !excludedColors.has(colorKey(item.color)));
  const ranked = sceneFirst(suitable, scene);
  const dresses = ranked.filter((item) => item.category === "连衣裙").slice(0, 12);
  const tops = ranked.filter((item) => ["上衣", "T恤", "衬衫", "针织衫"].includes(item.category)).slice(0, 12);
  const bottoms = ranked.filter((item) => ["裤子", "半身裙"].includes(item.category)).slice(0, 12);
  const outerwear = ranked.filter((item) => ["外套", "夹克", "风衣"].includes(item.category)).slice(0, 12);
  const missing = [];
  if (!dresses.length && (!tops.length || !bottoms.length)) {
    if (!tops.length && !bottoms.length) missing.push("适合当前温度的衣物");
    if (!tops.length) missing.push("上装或连衣裙");
    if (!bottoms.length) missing.push("下装或连衣裙");
  }
  if (outerwearMode(weather) === "required" && !outerwear.length) missing.push("外套");
  const combinations = buildCombinations(tops, bottoms, dresses, outerwear, weather, scene, preferences);
  const selected = combinations.length ? combinations[offset % combinations.length] : null;
  const selectedItems = selected?.items || [];
  const sceneMatchedCount = selectedItems.filter((item) => (item.scenes || []).includes(scene)).length;
  const coordinationReasons = selected?.reasons.filter((reason) => !["颜色关系较弱", "多件图案视觉重点较多", "核心风格缺少呼应"].includes(reason)).slice(0, 3) || [];
  const preferredCategories = preferences.preferredCategories || [];
  const preferredCategoryMatched = selectedItems.some((item) => preferredCategories.includes(item.category));
  if (preferredCategoryMatched) coordinationReasons.unshift(`优先满足你想穿的${preferredCategories.join("或")}`);
  else if (preferredCategories.length && combinations.length) missing.push(`当前天气下没有安全的${preferredCategories.join("或")}组合`);
  if (!selected) missing.push("符合当前天气框架的完整搭配");
  return {
    items: selectedItems,
    outfitCount: combinations.length,
    suitableCount: suitable.length,
    missing,
    // WXML 不能直接调用 Array.join，提前生成展示文本，避免只出现空的“还缺什么”卡片。
    missingText: missing.join("、"),
    complete: missing.length === 0 && Boolean(selected),
    reason: selected
      ? `${sceneMatchedCount ? `先通过天气安全筛选，再选择了适合${scene}的衣物` : `先通过天气安全筛选，再按${scene}需求排序`}${coordinationReasons.length ? `；${coordinationReasons.join("；")}` : ""}。`
      : `当前衣橱没有通过今日温度、温差和风雨条件的完整组合，未返回不安全的替代穿搭。`
  };
}

module.exports = {
  WEATHER_CONDITIONS,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  provinces,
  cities,
  districts,
  search,
  getPath,
  loadLocation,
  saveLocation,
  createWeatherOverride,
  isWeatherOverrideValid,
  loadWeatherOverride,
  saveWeatherOverride,
  clearWeatherOverride,
  formatLiveWeather,
  applyWeatherOverride,
  effectiveWeather,
  colorRelationship,
  combinationWeatherSafe,
  recommend
};
