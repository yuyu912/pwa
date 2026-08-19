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
  // 鞋子参与整套完整度与场景匹配，但不应被算作上半身保暖层。
  if (item.category === "鞋子") return 0;
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
const SCENE_PROFILES = {
  "约会": { styles: ["优雅", "甜美", "清新", "复古", "韩系"], details: ["荷叶边", "花边", "木耳边", "泡泡袖", "蕾丝", "蝴蝶结", "系带", "收腰", "束腰", "露肩", "一字肩", "娃娃领"], categories: ["连衣裙", "半身裙"] },
  "通勤": { styles: ["通勤", "简约", "优雅"], details: ["收腰", "束腰", "系带"], categories: ["衬衫", "针织衫", "裤子", "半身裙", "外套"] },
  "旅行": { styles: ["休闲", "简约", "度假", "运动"], details: [], categories: ["上衣", "T恤", "针织衫", "裤子", "外套"] },
  "聚会": { styles: ["优雅", "甜美", "酷飒", "复古", "街头"], details: ["荷叶边", "花边", "蕾丝", "镂空", "蝴蝶结", "收腰", "露肩", "一字肩"], categories: ["连衣裙", "半身裙", "外套"] },
  "运动": { styles: ["运动", "休闲"], details: [], categories: ["上衣", "T恤", "裤子", "外套", "鞋子"] },
  "休闲": { styles: ["休闲", "简约", "清新", "韩系"], details: [], categories: ["上衣", "T恤", "针织衫", "裤子", "半身裙"] }
};
const OCCASION_PROFILES = {
  "日常": { styles: ["休闲", "简约"], categories: ["上衣", "裤子"], functions: [] },
  "上课": { styles: ["休闲", "简约", "清新"], categories: ["上衣", "裤子"], functions: ["透气", "轻便"] },
  "逛街": { styles: ["清新", "韩系", "街头", "甜美"], categories: ["上衣", "裤子", "半身裙", "连衣裙"], functions: ["轻便"] },
  "通勤": { styles: ["通勤", "简约", "优雅"], categories: ["上衣", "裤子", "半身裙", "外套"], functions: [] },
  "商务会议": { styles: ["通勤", "简约", "优雅"], categories: ["上衣", "裤子", "半身裙", "外套", "连衣裙"], functions: [] },
  "面试": { styles: ["通勤", "简约", "优雅"], categories: ["上衣", "裤子", "半身裙", "外套", "连衣裙"], functions: [] },
  "商务饭局": { styles: ["优雅", "通勤", "简约"], categories: ["连衣裙", "上衣", "裤子", "半身裙", "外套"], functions: [] },
  "约会": { styles: ["优雅", "甜美", "清新", "复古", "韩系"], categories: ["连衣裙", "半身裙", "上衣", "裤子"], functions: [] },
  "婚礼宾客": { styles: ["优雅", "甜美", "复古"], categories: ["连衣裙", "半身裙", "上衣", "裤子"], functions: [] },
  "正式活动": { styles: ["优雅", "复古", "酷飒"], categories: ["连衣裙", "半身裙", "外套", "裤子"], functions: [] },
  "朋友聚会": { styles: ["甜美", "酷飒", "街头", "复古", "优雅"], categories: ["上衣", "裤子", "半身裙", "连衣裙"], functions: [] },
  "家庭聚会": { styles: ["清新", "简约", "优雅", "甜美"], categories: ["上衣", "裤子", "半身裙", "连衣裙"], functions: [] },
  "旅行观光": { styles: ["休闲", "简约", "度假"], categories: ["上衣", "裤子", "外套"], functions: ["轻便", "透气"] },
  "城市漫步": { styles: ["休闲", "街头", "清新"], categories: ["上衣", "裤子", "外套"], functions: ["轻便", "透气"] },
  "海边度假": { styles: ["度假", "清新", "甜美"], categories: ["连衣裙", "上衣", "裤子", "半身裙"], functions: ["透气", "轻便", "防晒"] },
  "徒步登山": { styles: ["运动", "休闲"], categories: ["上衣", "裤子", "外套", "鞋子"], functions: ["透气", "速干", "弹力", "防风", "防水", "耐磨"] },
  "露营": { styles: ["运动", "休闲", "度假"], categories: ["上衣", "裤子", "外套", "鞋子"], functions: ["防风", "防水", "保暖", "耐磨"] },
  "跑步": { styles: ["运动"], categories: ["上衣", "裤子", "鞋子"], functions: ["透气", "速干", "弹力", "轻便"] },
  "健身": { styles: ["运动"], categories: ["上衣", "裤子", "鞋子"], functions: ["透气", "速干", "弹力"] },
  "球类运动": { styles: ["运动"], categories: ["上衣", "裤子", "鞋子"], functions: ["透气", "速干", "弹力", "轻便"] },
  "骑行": { styles: ["运动", "休闲"], categories: ["上衣", "裤子", "外套", "鞋子"], functions: ["透气", "速干", "弹力", "防风", "轻便"] },
  "滑雪": { styles: ["运动"], categories: ["上衣", "裤子", "外套", "鞋子"], functions: ["防风", "防水", "保暖", "耐磨"] },
  "水上运动": { styles: ["运动", "度假"], categories: ["上衣", "裤子", "鞋子"], functions: ["速干", "弹力", "轻便", "防晒"] },
  "毕业典礼": { styles: ["优雅", "通勤", "简约"], categories: ["连衣裙", "上衣", "裤子", "半身裙", "外套"], functions: [] },
  "演出观展": { styles: ["优雅", "复古", "酷飒", "清新"], categories: ["连衣裙", "上衣", "裤子", "半身裙"], functions: [] },
  "亲子出行": { styles: ["休闲", "简约", "清新"], categories: ["上衣", "裤子", "外套"], functions: ["轻便", "透气", "弹力"] }
};
const FORMALITY_LEVELS = { "休闲": 0, "轻商务": 1, "商务": 2, "半正式": 3, "正式": 4 };
const SHOE_REQUIRED_OCCASIONS = new Set(["徒步登山", "露营", "跑步", "健身", "球类运动", "骑行", "滑雪", "水上运动"]);

function requiresShoes(preferences = {}) {
  return SHOE_REQUIRED_OCCASIONS.has(preferences.occasion)
    || ["athletic", "outdoor"].includes(preferences.formalityPreference);
}

function sceneProfileScore(item, scene) {
  const profile = SCENE_PROFILES[scene] || SCENE_PROFILES["休闲"];
  const styles = item.styles || [];
  const details = item.designDetails || item.design_details || [];
  let score = styles.filter((style) => profile.styles.includes(style)).length * 8;
  score += Math.min(12, details.filter((detail) => profile.details.includes(detail)).length * 6);
  if (profile.categories.includes(item.category)) score += 4;
  return score;
}

function occasionProfileScore(item, occasion) {
  const profile = OCCASION_PROFILES[occasion];
  if (!profile) return 0;
  const styles = item.styles || [];
  const functions = item.functionTags || item.function_tags || [];
  let score = styles.filter((style) => profile.styles.includes(style)).length * 7;
  if (profile.categories.includes(item.category)) score += 4;
  score += Math.min(12, functions.filter((tag) => profile.functions.includes(tag)).length * 4);
  return score;
}

function inferredFormalityLevel(item) {
  if (FORMALITY_LEVELS[item.formality] !== undefined) return FORMALITY_LEVELS[item.formality];
  const text = `${item.name || ""} ${(item.styles || []).join(" ")} ${item.category || ""}`;
  if (/礼服|正装|西装|西服|正式/.test(text)) return 4;
  if (/优雅/.test(text) && /连衣裙|半身裙|衬衫|外套/.test(text)) return 3;
  if (/通勤|衬衫|风衣/.test(text)) return 2;
  if (/简约|针织/.test(text)) return 1;
  if (/休闲|运动|街头|T恤|卫衣|牛仔/.test(text)) return 0;
  return 1;
}

function formalityMatch(item, preference) {
  const functions = item.functionTags || item.function_tags || [];
  const text = `${item.name || ""} ${(item.styles || []).join(" ")} ${item.formality || ""}`;
  if (preference === "athletic") return /运动|跑步|健身/.test(text) || functions.some((tag) => ["透气", "速干", "弹力"].includes(tag)) ? 2 : 0;
  if (preference === "outdoor") return /户外|登山|冲锋|运动/.test(text) || functions.some((tag) => ["防风", "防水", "耐磨", "速干"].includes(tag)) ? 2 : 0;
  const level = inferredFormalityLevel(item);
  const target = { casual: 0, smart_casual: 1, business: 2, semi_formal: 3, formal: 4 }[preference];
  if (target === undefined) return 0;
  if (preference === "casual") return level <= 1 ? 2 : level === 2 ? 1 : 0;
  return level >= target ? 2 : level === target - 1 ? 1 : 0;
}

function sceneSuitability(items, scene, preferences = {}) {
  const explicitMatches = items.filter((item) => (item.scenes || []).includes(scene)).length;
  const profileScore = items.reduce((total, item) => total + sceneProfileScore(item, scene) + occasionProfileScore(item, preferences.occasion), 0);
  const tier = explicitMatches === items.length ? 3 : explicitMatches > 0 ? 2 : profileScore > 0 ? 1 : 0;
  return { tier, explicitMatches, profileScore };
}

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
  const sceneFit = sceneSuitability(items, scene, preferences);
  let score = items.length ? Math.round(sceneFit.explicitMatches / items.length * 30) + sceneFit.profileScore : 0;
  const reasons = [];
  if (!sceneFit.explicitMatches && sceneFit.profileScore) reasons.push(`${scene}场景的风格与设计细节更匹配`);
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
  const formalityMatches = items.reduce((total, item) => total + formalityMatch(item, preferences.formalityPreference), 0);
  if (formalityMatches) { score += formalityMatches * 10; reasons.push(`符合${preferences.occasion || scene}需要的穿着正式度或功能取向`); }
  const occasionMatches = items.filter((item) => occasionProfileScore(item, preferences.occasion) > 0).length;
  return { score, reasons, sceneTier: sceneFit.tier, sceneMatches: sceneFit.explicitMatches, preferenceMatches: styleMatches + formalityMatches + occasionMatches, formalityMatches };
}

function buildCombinations(tops, bottoms, dresses, outerwear, shoes, weather, scene, preferences = {}) {
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
  const completeCombinations = requiresShoes(preferences)
    ? combinations.flatMap((items) => shoes.map((shoe) => [...items, shoe]))
    : combinations;
  const weatherSafe = completeCombinations.filter((items) => combinationWeatherSafe(items, weather, preferences));
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
  const scored = (locked.length ? locked : preferredPool).map((items) => ({ items, ...scoreCombination(items, scene, weather, preferences) }));
  // 用户本轮明确提出的风格比旧场景标签更具体；有匹配衣物时，先满足该反馈，再比较场景和天气内的协调分。
  return scored.sort((left, right) => right.preferenceMatches - left.preferenceMatches || right.sceneTier - left.sceneTier || right.sceneMatches - left.sceneMatches || right.score - left.score || left.items.map((item) => item.id).join("|").localeCompare(right.items.map((item) => item.id).join("|")))
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
  const shoes = ranked.filter((item) => item.category === "鞋子").slice(0, 12);
  const missing = [];
  if (!dresses.length && (!tops.length || !bottoms.length)) {
    if (!tops.length && !bottoms.length) missing.push("适合当前温度的衣物");
    if (!tops.length) missing.push("上装或连衣裙");
    if (!bottoms.length) missing.push("下装或连衣裙");
  }
  if (outerwearMode(weather) === "required" && !outerwear.length) missing.push("外套");
  if (requiresShoes(preferences) && !shoes.length) missing.push(`适合${preferences.occasion || scene}的鞋子`);
  const combinations = buildCombinations(tops, bottoms, dresses, outerwear, shoes, weather, scene, preferences);
  const selected = combinations.length ? combinations[offset % combinations.length] : null;
  const occasionText = preferences.occasion || `${scene}场景`;
  const selectedCandidateItems = selected?.items || [];
  const strictFormality = ["business", "semi_formal", "formal"].includes(preferences.formalityPreference);
  const formalityGap = strictFormality && selectedCandidateItems.length && Number(selected?.formalityMatches || 0) < selectedCandidateItems.length;
  const selectedItems = formalityGap ? [] : selectedCandidateItems;
  const sceneMatchedCount = selected?.sceneMatches || 0;
  const coordinationReasons = selected?.reasons.filter((reason) => !["颜色关系较弱", "多件图案视觉重点较多", "核心风格缺少呼应"].includes(reason)).slice(0, 3) || [];
  const preferredCategories = preferences.preferredCategories || [];
  const preferredCategoryMatched = selectedItems.some((item) => preferredCategories.includes(item.category));
  if (preferredCategoryMatched) coordinationReasons.unshift(`优先满足你想穿的${preferredCategories.join("或")}`);
  else if (preferredCategories.length && combinations.length) missing.push(`当前天气下没有安全的${preferredCategories.join("或")}组合`);
  if (formalityGap) missing.push(`衣橱里没有符合${occasionText}正式度的完整搭配`);
  if (!selected) missing.push("符合当前天气框架的完整搭配");
  return {
    items: selectedItems,
    outfitCount: combinations.length,
    suitableCount: suitable.length,
    missing,
    // WXML 不能直接调用 Array.join，提前生成展示文本，避免只出现空的“还缺什么”卡片。
    missingText: missing.join("、"),
    complete: missing.length === 0 && Boolean(selected),
    reason: formalityGap
      ? `当前衣橱没有同时符合${occasionText}正式度和天气条件的完整组合，因此没有用休闲衣物冒充正式穿搭。`
      : selected
      ? `${sceneMatchedCount === selectedItems.length ? `先按${occasionText}选择衣物，再通过天气安全筛选` : `衣橱没有整套明确标注为${occasionText}的衣物，已结合现有场景、正式度、风格和功能标签选择接近款并通过天气安全筛选`}${coordinationReasons.length ? `；${coordinationReasons.join("；")}` : ""}。`
      : requiresShoes(preferences) && !shoes.length
        ? `服装部分会继续按${occasionText}和天气筛选，但衣橱里还没有鞋子，因此暂不把它称为完整穿搭。请先在衣橱录入鞋子。`
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
