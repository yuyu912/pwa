import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/wardrobe-filter.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Number, String, Array });
const { filterWardrobe, countAdvancedFilters } = commonJsModule.exports;
const weatherSource = fs.readFileSync(new URL("../miniprogram/services/weather.js", import.meta.url), "utf8");
const weatherModule = { exports: {} };
vm.runInNewContext(weatherSource, {
  module: weatherModule,
  exports: weatherModule.exports,
  require: () => ({ areaList: { province_list: {}, city_list: {}, county_list: {} } })
});
const { colorRelationship, recommend } = weatherModule.exports;
const directiveSource = fs.readFileSync(new URL("../miniprogram/utils/outfit-directives.js", import.meta.url), "utf8");
const directiveModule = { exports: {} };
vm.runInNewContext(directiveSource, { module: directiveModule, exports: directiveModule.exports, String, Set, Array });
const { applyItemDirectives, settleItemSelection } = directiveModule.exports;
const capsuleSource = fs.readFileSync(new URL("../miniprogram/utils/capsule-plan.js", import.meta.url), "utf8");
const capsuleModule = { exports: {} };
vm.runInNewContext(capsuleSource, { module: capsuleModule, exports: capsuleModule.exports, Number, Array });
const { buildCapsulePlan } = capsuleModule.exports;
const canvasSource = fs.readFileSync(new URL("../miniprogram/utils/outfit-canvas.js", import.meta.url), "utf8");
const canvasModule = { exports: {} };
vm.runInNewContext(canvasSource, { module: canvasModule, exports: canvasModule.exports, Number, String, Array, Map, Math });
const canvas = canvasModule.exports;
const canvasMarkup = fs.readFileSync(new URL("../miniprogram/pages/outfit-canvas/index.wxml", import.meta.url), "utf8");
const wardrobeSource = fs.readFileSync(new URL("../miniprogram/pages/wardrobe/index.js", import.meta.url), "utf8");
const wardrobeMarkup = fs.readFileSync(new URL("../miniprogram/pages/wardrobe/index.wxml", import.meta.url), "utf8");
const wardrobeStyles = fs.readFileSync(new URL("../miniprogram/pages/wardrobe/index.wxss", import.meta.url), "utf8");
const addItemMarkup = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.wxml", import.meta.url), "utf8");
const candidateMarkup = fs.readFileSync(new URL("../miniprogram/pages/candidate/index.wxml", import.meta.url), "utf8");
const loginSource = fs.readFileSync(new URL("../miniprogram/pages/login/index.js", import.meta.url), "utf8");
const loginMarkup = fs.readFileSync(new URL("../miniprogram/pages/login/index.wxml", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../miniprogram/services/api.js", import.meta.url), "utf8");
const configSource = fs.readFileSync(new URL("../miniprogram/config.js", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../miniprogram/services/session.js", import.meta.url), "utf8");
const homeMarkup = fs.readFileSync(new URL("../miniprogram/pages/home/index.wxml", import.meta.url), "utf8");
const itemDetailMarkup = fs.readFileSync(new URL("../miniprogram/pages/item-detail/index.wxml", import.meta.url), "utf8");
const accountMarkup = fs.readFileSync(new URL("../miniprogram/pages/account/index.wxml", import.meta.url), "utf8");
const galleryMarkup = fs.readFileSync(new URL("../miniprogram/pages/outfit-gallery/index.wxml", import.meta.url), "utf8");
const todayOutfitMarkup = fs.readFileSync(new URL("../miniprogram/pages/today-outfit/index.wxml", import.meta.url), "utf8");
const todayOutfitSource = fs.readFileSync(new URL("../miniprogram/pages/today-outfit/index.js", import.meta.url), "utf8");
const weatherMarkup = fs.readFileSync(new URL("../miniprogram/pages/weather/index.wxml", import.meta.url), "utf8");
let wardrobePage;
vm.runInNewContext(wardrobeSource, {
  require: (specifier) => specifier.includes("wardrobe-filter") ? { filterWardrobe, countAdvancedFilters } : {},
  Page: (config) => { wardrobePage = config; },
  Date,
  Number,
  String,
  Array,
  Promise
});
const calendarSource = fs.readFileSync(new URL("../miniprogram/pages/wear-calendar/index.js", import.meta.url), "utf8");
const calendarMarkup = fs.readFileSync(new URL("../miniprogram/pages/wear-calendar/index.wxml", import.meta.url), "utf8");
const calendarStyles = fs.readFileSync(new URL("../miniprogram/pages/wear-calendar/index.wxss", import.meta.url), "utf8");
const historySource = fs.readFileSync(new URL("../miniprogram/utils/wear-history.js", import.meta.url), "utf8");
const historyModule = { exports: {} };
vm.runInNewContext(historySource, { module: historyModule, exports: historyModule.exports, Date, Number, String, Array, Map, Set, Object });
const history = historyModule.exports;
const weekSource = fs.readFileSync(new URL("../miniprogram/pages/wear-week/index.js", import.meta.url), "utf8");
const weekMarkup = fs.readFileSync(new URL("../miniprogram/pages/wear-week/index.wxml", import.meta.url), "utf8");
const outfitDetailSource = fs.readFileSync(new URL("../miniprogram/pages/outfit-detail/index.js", import.meta.url), "utf8");
const calendarModule = { exports: {} };
let calendarPage;
let calendarNavigation = "";
vm.runInNewContext(calendarSource, {
  module: calendarModule,
  exports: calendarModule.exports,
  require: (specifier) => specifier.includes("wear-history") ? history : {},
  Page: (config) => { calendarPage = config; },
  wx: { navigateTo: ({ url }) => { calendarNavigation = url; }, showToast: () => {} },
  Date,
  Number,
  String,
  Array,
  Map,
  Set
});
const { buildDaySummaries, buildHistorySummary, calendarDays, defaultSelectedKey, groupWearLogs, selectedDateCopy, weekRange, weekTitle } = history;
const items = [
  { id: "1", name: "白色针织上衣", category: "上衣", season: "春秋", thickness: "适中", material: "针织", styles: ["温柔"], scenes: ["通勤"], monthlyWearCount: 3, idleStatus: "active" },
  { id: "2", name: "蓝色牛仔裤", category: "裤子", season: "多季", thickness: "适中", material: "牛仔", styles: ["休闲"], scenes: ["旅行"], monthlyWearCount: 0, idleStatus: "considering" },
  { id: "3", name: "黑色风衣", category: "外套", season: "秋冬", thickness: "厚", material: "聚酯纤维", styles: ["通勤"], scenes: ["通勤"], monthlyWearCount: 1, idleStatus: "active" }
];

test("登录页支持用户名密码自由注册且不再要求邀请码", () => {
  assert.doesNotMatch(loginMarkup, /邀请码|inviteCode|用邀请注册/);
  assert.match(loginMarkup, /还没有账号？创建账号/);
  assert.match(loginMarkup, /创建你的私人衣橱账号/);
  assert.doesNotMatch(loginSource, /inviteCode|onInviteCode|请填写邀请码/);
  assert.match(loginSource, /api\.register\(\{ username, password \}\)/);
  assert.match(apiSource, /async function register\(\{ username, password \}\)/);
  assert.match(apiSource, /\/api\/auth\/register", "POST", \{ username, password \}/);
});

test("衣橱筛选可叠加关键词、品类、季节、厚薄和本月穿着状态", () => {
  const result = structuredClone(filterWardrobe(items, {
    keyword: "通勤",
    category: "上衣",
    season: "春秋",
    thickness: "适中",
    wearStatus: "本月穿过"
  }));
  assert.deepEqual(result.filteredItems.map((item) => item.id), ["1"]);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.monthlyWearTotal, 3);
});

test("衣橱品类筛选完整显示鞋子且允许自动换行", () => {
  assert.ok(wardrobePage.data.categories.includes("鞋子"));
  assert.match(wardrobeMarkup, /<view class="categories">/);
  assert.match(wardrobeStyles, /\.categories\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
});

test("本月未穿只返回月度穿着次数为0的真实衣物", () => {
  const result = structuredClone(filterWardrobe(items, { wearStatus: "本月未穿" }));
  assert.deepEqual(result.filteredItems.map((item) => item.id), ["2"]);
  assert.equal(result.monthlyWearTotal, 0);
});

test("筛选结果统计只累加当前符合条件的衣物", () => {
  const result = structuredClone(filterWardrobe(items, { thickness: "适中" }));
  assert.equal(result.matchedCount, 2);
  assert.equal(result.monthlyWearTotal, 3);
});

test("私人闲置筛选只区分本人标记的状态", () => {
  const idle = structuredClone(filterWardrobe(items, { idleStatus: "考虑闲置" }));
  const active = structuredClone(filterWardrobe(items, { idleStatus: "正常使用" }));
  assert.deepEqual(idle.filteredItems.map((item) => item.id), ["2"]);
  assert.deepEqual(active.filteredItems.map((item) => item.id), ["1", "3"]);
});

test("衣橱高级筛选默认收起并准确统计启用项", () => {
  assert.equal(wardrobePage.data.filtersOpen, false);
  assert.equal(countAdvancedFilters({ season: "春秋", thickness: "全部", wearStatus: "本月穿过", idleStatus: "全部" }), 2);
  assert.match(wardrobeMarkup, /bindtap="toggleFilters"/);
  assert.match(wardrobeMarkup, /wx:if="\{\{filtersOpen\}\}" class="advanced-filters"/);
});

test("收起或展开高级筛选不会清空已经选择的条件", () => {
  const context = {
    data: { ...wardrobePage.data, filtersOpen: false, activeSeason: "春秋", activeWearStatus: "本月穿过" },
    setData(patch) { Object.assign(this.data, patch); }
  };
  wardrobePage.toggleFilters.call(context);
  assert.equal(context.data.filtersOpen, true);
  assert.equal(context.data.activeSeason, "春秋");
  assert.equal(context.data.activeWearStatus, "本月穿过");
  wardrobePage.toggleFilters.call(context);
  assert.equal(context.data.filtersOpen, false);
  assert.equal(context.data.activeSeason, "春秋");
});

test("衣橱入口保留原跳转且移除错误模拟标签和大箭头", () => {
  assert.doesNotMatch(wardrobeMarkup, /模拟模式/);
  assert.match(wardrobeMarkup, /bindtap="openOutfitGallery"/);
  assert.match(wardrobeMarkup, /bindtap="openOutfitCanvas"/);
  assert.match(wardrobeSource, /pages\/outfit-canvas\/index\?mode=new/);
  assert.match(wardrobeMarkup, /bindtap="openIdleItems"/);
  assert.doesNotMatch(wardrobeMarkup, /(idle|canvas)-entry-arrow/);
});

test("购买前查重入口位于私人闲置清单下方并复用候选分析", () => {
  const idleIndex = wardrobeMarkup.indexOf('bindtap="openIdleItems"');
  const candidateIndex = wardrobeMarkup.indexOf('bindtap="openCandidate"');
  assert.ok(idleIndex >= 0 && candidateIndex > idleIndex);
  assert.match(wardrobeMarkup, /购买前拍照查重/);
  assert.match(wardrobeMarkup, /看看衣橱里有没有相似款/);
  assert.doesNotMatch(wardrobeMarkup, /演示候选新衣分析/);
  assert.match(wardrobeSource, /pages\/add-item\/index\?mode=candidate/);
  assert.match(addItemMarkup, /购买前衣物查重/);
  assert.match(addItemMarkup, /确认标签并查看查重结果/);
  assert.match(candidateMarkup, /购买前查重 · 标签已确认/);
});

const outfitWeather = { high: 24, needsOuterwear: false };
const outfitItems = [
  { id: "1", name: "休闲上衣", category: "上衣", season: "多季", thickness: "适中", scenes: ["休闲"] },
  { id: "2", name: "通勤上衣", category: "上衣", season: "多季", thickness: "适中", scenes: ["通勤"] },
  { id: "3", name: "休闲裤", category: "裤子", season: "多季", thickness: "适中", scenes: ["休闲"] },
  { id: "4", name: "通勤裙", category: "半身裙", season: "多季", thickness: "适中", scenes: ["通勤"] }
];

test("搭配生成优先选择符合用户场景的上装和下装", () => {
  const result = structuredClone(recommend(outfitItems, outfitWeather, "通勤"));
  assert.deepEqual(result.items.map((item) => item.id), ["2", "4"]);
  assert.equal(result.complete, true);
  assert.match(result.reason, /通勤场景/);
});

test("约会场景优先浪漫设计裙装而不是同色休闲裤装", () => {
  const result = structuredClone(recommend([
    { id: "casual-top", name: "蓝色上衣", category: "上衣", color: "蓝色", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["休闲"] },
    { id: "casual-pants", name: "浅蓝牛仔裤", category: "裤子", color: "浅蓝", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["休闲"] },
    { id: "date-dress", name: "花边收腰连衣裙", category: "连衣裙", color: "黄色", season: "多季", thickness: "适中", designDetails: ["花边", "收腰"], styles: ["优雅"], scenes: ["约会"] }
  ], outfitWeather, "约会"));
  assert.deepEqual(result.items.map((item) => item.id), ["date-dress"]);
  assert.match(result.reason, /先按约会场景选择衣物/);
});

test("用户明确要正式风格时不再沿用休闲场景的休闲组合", () => {
  const result = structuredClone(recommend([
    { id: "casual-top", name: "蓝色休闲上衣", category: "上衣", color: "蓝色", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["休闲"] },
    { id: "casual-pants", name: "浅蓝休闲裤", category: "裤子", color: "浅蓝", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["休闲"] },
    { id: "formal-top", name: "白色通勤衬衫", category: "上衣", color: "白色", season: "多季", thickness: "适中", formality: "正式", styles: ["通勤", "优雅"], scenes: ["通勤"] },
    { id: "formal-pants", name: "黑色正装长裤", category: "裤子", color: "黑色", season: "多季", thickness: "适中", formality: "正式", styles: ["通勤"], scenes: ["通勤"] }
  ], outfitWeather, "通勤", 0, { occasion: "商务会议", formalityPreference: "formal", styles: ["通勤", "优雅"] }));
  assert.deepEqual(result.items.map((item) => item.id), ["formal-top", "formal-pants"]);
  assert.match(result.reason, /通勤|优雅/);
});

test("正式场景没有足够正式衣物时报告缺口而不是用休闲款冒充", () => {
  const result = structuredClone(recommend([
    { id: "tee", name: "休闲T恤", category: "上衣", season: "多季", thickness: "适中", formality: "休闲", styles: ["休闲"], scenes: ["休闲"] },
    { id: "jeans", name: "休闲牛仔裤", category: "裤子", season: "多季", thickness: "适中", formality: "休闲", styles: ["休闲"], scenes: ["休闲"] }
  ], outfitWeather, "聚会", 0, { occasion: "正式活动", formalityPreference: "formal" }));
  assert.deepEqual(result.items, []);
  assert.match(result.missingText, /没有符合正式活动正式度/);
  assert.match(result.reason, /没有用休闲衣物冒充正式穿搭/);
});

test("正式组合逐件校验且不能用一件高分正装抵消休闲单品", () => {
  const result = structuredClone(recommend([
    { id: "formal-top", name: "正式西装上衣", category: "上衣", season: "多季", thickness: "适中", formality: "正式", styles: ["通勤"], scenes: ["通勤"] },
    { id: "casual-jeans", name: "休闲牛仔裤", category: "裤子", season: "多季", thickness: "适中", formality: "休闲", styles: ["休闲"], scenes: ["休闲"] }
  ], outfitWeather, "通勤", 0, { occasion: "商务会议", formalityPreference: "formal" }));
  assert.deepEqual(result.items, []);
  assert.match(result.missingText, /没有符合商务会议正式度/);
});

test("聚会半正式应跳过不合格裤装并主动推荐合格裙装", () => {
  const result = structuredClone(recommend([
    { id: "casual-top", name: "聚会休闲上衣", category: "上衣", season: "多季", thickness: "适中", formality: "休闲", styles: ["优雅"], scenes: ["聚会"] },
    { id: "casual-pants", name: "聚会休闲长裤", category: "裤子", season: "多季", thickness: "适中", formality: "休闲", styles: ["优雅"], scenes: ["聚会"] },
    { id: "formal-dress", name: "收腰连衣裙", category: "连衣裙", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["约会"] }
  ], { temperature: 25, low: 24, high: 26, condition: "晴" }, "聚会", 0, {
    occasion: "朋友聚会", formalityPreference: "semi_formal", styles: ["优雅"]
  }));
  assert.deepEqual(result.items.map((item) => item.id), ["formal-dress"]);
  assert.equal(result.complete, true);
  assert.doesNotMatch(result.missingText, /没有符合朋友聚会正式度/);
});

test("裙装软偏好不应挡掉正式度合格的裤装", () => {
  const result = structuredClone(recommend([
    { id: "casual-dress", name: "休闲连衣裙", category: "连衣裙", season: "多季", thickness: "适中", formality: "休闲", styles: ["优雅"], scenes: ["聚会"] },
    { id: "formal-top", name: "半正式衬衫", category: "上衣", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["聚会"] },
    { id: "formal-pants", name: "半正式长裤", category: "裤子", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["聚会"] }
  ], { temperature: 25, low: 24, high: 26, condition: "晴" }, "聚会", 0, {
    occasion: "朋友聚会", formalityPreference: "semi_formal", styles: ["优雅"], preferredCategories: ["连衣裙", "半身裙"]
  }));
  assert.deepEqual(result.items.map((item) => item.id), ["formal-top", "formal-pants"]);
  assert.equal(result.complete, true);
  assert.match(result.reason, /没有安全的连衣裙或半身裙组合/);
});

test("锁定衣物硬要求优先于想穿连衣裙软偏好", () => {
  const result = structuredClone(recommend([
    { id: "locked-top", name: "保留半正式衬衫", category: "上衣", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["聚会"] },
    { id: "formal-pants", name: "半正式长裤", category: "裤子", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["聚会"] },
    { id: "formal-dress", name: "半正式连衣裙", category: "连衣裙", season: "多季", thickness: "适中", formality: "半正式", styles: ["优雅"], scenes: ["聚会"] }
  ], { temperature: 25, low: 24, high: 26, condition: "晴" }, "聚会", 0, {
    occasion: "朋友聚会", formalityPreference: "semi_formal", preferredCategories: ["连衣裙"], lockedItemIds: ["locked-top"]
  }));
  assert.deepEqual(result.items.map((item) => item.id), ["locked-top", "formal-pants"]);
  assert.equal(result.complete, true);
});

test("徒步场景优先户外功能衣物但不把鞋子放进推荐", () => {
  const result = structuredClone(recommend([
    { id: "plain-top", name: "普通上衣", category: "上衣", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["运动"] },
    { id: "plain-pants", name: "普通长裤", category: "裤子", season: "多季", thickness: "适中", styles: ["休闲"], scenes: ["运动"] },
    { id: "hike-top", name: "速干上衣", category: "上衣", season: "多季", thickness: "适中", formality: "户外", functionTags: ["透气", "速干"], styles: ["运动"], scenes: ["运动"] },
    { id: "hike-pants", name: "弹力徒步裤", category: "裤子", season: "多季", thickness: "适中", formality: "户外", functionTags: ["弹力", "耐磨"], styles: ["运动"], scenes: ["运动"] },
    { id: "hike-shoes", name: "防滑徒步鞋", category: "鞋子", season: "多季", thickness: "适中", formality: "户外", functionTags: ["防水", "耐磨"], styles: ["运动"], scenes: ["运动"] }
  ], outfitWeather, "运动", 0, { occasion: "徒步登山", formalityPreference: "outdoor" }));
  assert.deepEqual(result.items.map((item) => item.id), ["hike-top", "hike-pants"]);
  assert.equal(result.items.some((item) => item.category === "鞋子"), false);
});

test("户外或运动场景没有鞋子时仍返回服装搭配", () => {
  const result = structuredClone(recommend([
    { id: "sport-top", name: "速干上衣", category: "上衣", season: "多季", thickness: "适中", formality: "运动", functionTags: ["透气", "速干"], scenes: ["运动"] },
    { id: "sport-pants", name: "弹力长裤", category: "裤子", season: "多季", thickness: "适中", formality: "运动", functionTags: ["弹力"], scenes: ["运动"] }
  ], outfitWeather, "运动", 0, { occasion: "跑步", formalityPreference: "athletic" }));
  assert.deepEqual(result.items.map((item) => item.id), ["sport-top", "sport-pants"]);
  assert.doesNotMatch(result.missingText, /鞋子/);
  assert.equal(result.complete, true);
});

test("水上运动不把鞋子设为完整穿搭硬门槛", () => {
  const result = structuredClone(recommend([
    { id: "swim-top", name: "速干防晒上衣", category: "上衣", season: "春夏", thickness: "薄", formality: "运动", functionTags: ["速干", "防晒"], styles: ["运动"], scenes: ["运动"] },
    { id: "swim-bottom", name: "弹力运动短裤", category: "裤子", season: "春夏", thickness: "薄", formality: "运动", functionTags: ["速干", "弹力"], styles: ["运动"], scenes: ["运动"] }
  ], { temperature: 27, low: 25, high: 29, condition: "晴" }, "运动", 0, { occasion: "水上运动", formalityPreference: "athletic" }));
  assert.deepEqual(result.items.map((item) => item.id), ["swim-top", "swim-bottom"]);
  assert.doesNotMatch(result.missingText, /鞋子/);
});

test("各场景先选择明确匹配的衣物组合再比较配色", () => {
  for (const scene of ["通勤", "旅行", "聚会", "运动", "休闲"]) {
    const result = structuredClone(recommend([
      { id: `${scene}-top`, name: `${scene}上衣`, category: "上衣", color: "红色", season: "多季", thickness: "适中", scenes: [scene] },
      { id: `${scene}-bottom`, name: `${scene}下装`, category: "裤子", color: "绿色", season: "多季", thickness: "适中", scenes: [scene] },
      { id: "other-top", name: "同色上衣", category: "上衣", color: "蓝色", season: "多季", thickness: "适中", scenes: ["约会"] },
      { id: "other-bottom", name: "同色裤子", category: "裤子", color: "浅蓝", season: "多季", thickness: "适中", scenes: ["约会"] }
    ], outfitWeather, scene));
    assert.deepEqual(result.items.map((item) => item.id), [`${scene}-top`, `${scene}-bottom`]);
  }
});

test("换一套会在同类可选衣物中轮换", () => {
  const first = structuredClone(recommend(outfitItems, outfitWeather, "休闲", 0));
  const second = structuredClone(recommend(outfitItems, outfitWeather, "休闲", 1));
  assert.notDeepEqual(second.items.map((item) => item.id), first.items.map((item) => item.id));
  assert.ok(second.outfitCount >= 2);
});

test("天气搭配换一套必须同时更换分体搭配的上衣和下装", () => {
  const weather = { temperature: 27, low: 22, high: 32, condition: "晴" };
  const wardrobe = [
    { id: "top-a", name: "休闲上衣A", category: "上衣", season: "春夏", thickness: "薄", scenes: ["休闲"] },
    { id: "bottom-a", name: "休闲长裤A", category: "裤子", season: "春夏", thickness: "薄", scenes: ["休闲"] },
    { id: "coat-a", name: "薄外套A", category: "外套", season: "春夏", thickness: "薄", scenes: ["休闲"] },
    { id: "coat-b", name: "薄外套B", category: "外套", season: "春夏", thickness: "薄", scenes: ["休闲"] },
    { id: "top-b", name: "备用上衣B", category: "上衣", season: "春夏", thickness: "薄", scenes: ["约会"] },
    { id: "bottom-b", name: "备用长裤B", category: "裤子", season: "春夏", thickness: "薄", scenes: ["约会"] }
  ];
  const first = structuredClone(recommend(wardrobe, weather, "休闲", 0));
  const coreIds = (result) => result.items.filter((item) => item.category !== "外套").map((item) => item.id).sort();
  const second = structuredClone(recommend(wardrobe, weather, "休闲", 0, {
    currentCoreItemIds: coreIds(first),
    excludedCoreKeys: [first.selectedCoreKey]
  }));
  assert.equal(first.complete, true);
  assert.equal(second.complete, true);
  assert.equal(coreIds(second).some((id) => coreIds(first).includes(id)), false);
});

test("天气搭配没有第二组完整不同核心衣物时不把单换上衣冒充换一套", () => {
  const result = structuredClone(recommend([
    { id: "top-a", name: "休闲上衣A", category: "上衣", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "top-b", name: "休闲上衣B", category: "上衣", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "only-bottom", name: "唯一安全下装", category: "裤子", season: "多季", thickness: "薄", scenes: ["休闲"] }
  ], { temperature: 25, low: 23, high: 27, condition: "晴" }, "休闲", 0));
  assert.equal(result.complete, true);
  assert.equal(result.alternativeCount, 0);
  assert.match(todayOutfitMarkup, /wx:if="\{\{recommendation\.alternativeCount > 0\}\}"[^>]*>换一套<\/button>/);
  assert.match(todayOutfitMarkup, /当前天气下暂无第二套完整不同搭配/);
});

test("天气搭配根据当前套装连续寻找未看过且整套不同的下一套", () => {
  const tops = Array.from({ length: 4 }, (_, index) => ({
    id: `rotation-top-${index}`,
    name: `轮换上衣${index}`,
    category: "上衣",
    season: "多季",
    thickness: "薄",
    scenes: ["休闲"]
  }));
  const bottoms = Array.from({ length: 4 }, (_, index) => ({
    id: `rotation-bottom-${index}`,
    name: `轮换下装${index}`,
    category: "裤子",
    season: "多季",
    thickness: "薄",
    scenes: ["休闲"]
  }));
  const wardrobe = [...tops, ...bottoms];
  const weather = { temperature: 25, low: 23, high: 27, condition: "晴" };
  const outfits = [structuredClone(recommend(wardrobe, weather, "休闲", 0))];
  const coreIds = (result) => result.items.map((item) => item.id).sort();
  const seen = new Set([outfits[0].selectedCoreKey]);
  for (let index = 0; index < 7; index += 1) {
    const current = outfits[outfits.length - 1];
    const next = structuredClone(recommend(wardrobe, weather, "休闲", 0, {
      currentCoreItemIds: coreIds(current),
      excludedCoreKeys: [...seen]
    }));
    assert.equal(coreIds(current).some((id) => coreIds(next).includes(id)), false);
    outfits.push(next);
    seen.add(next.selectedCoreKey);
  }
  assert.ok(seen.size > 3);
  assert.equal(new Set(outfits.map((result) => coreIds(result).join("|"))).size, outfits.length);
  assert.match(todayOutfitSource, /seenCoreKeys/);
  assert.match(todayOutfitSource, /currentCoreItemIds/);
});

test("天气页区分单件初筛数量和可轮换完整搭配数量", () => {
  assert.match(weatherMarkup, /单件天气初筛通过/);
  assert.match(weatherMarkup, /天气安全完整候选.*recommendation\.outfitCount.*套/);
  assert.match(weatherMarkup, /上装.*suitableBreakdown\.tops.*下装.*suitableBreakdown\.bottoms.*连衣裙.*suitableBreakdown\.dresses.*外套.*suitableBreakdown\.outerwear/);
  assert.doesNotMatch(weatherMarkup, /找到 \{\{recommendation\.suitableCount\}\} 件适合今天的衣物/);
});

test("今日穿搭优先颜色口诀协调且保留单一图案重点", () => {
  const items = [
    { id: "pink-top", name: "粉色格纹上衣", category: "上衣", color: "粉色", pattern: "格纹", season: "多季", thickness: "适中", scenes: ["通勤"] },
    { id: "green-bottom", name: "深绿长裤", category: "裤子", color: "深绿色", pattern: "纯色", season: "多季", thickness: "适中", scenes: ["通勤"] },
    { id: "orange-bottom", name: "橙色长裤", category: "裤子", color: "橙色", pattern: "纯色", season: "多季", thickness: "适中", scenes: ["通勤"] }
  ];
  const result = structuredClone(recommend(items, outfitWeather, "通勤"));
  assert.deepEqual(result.items.map((item) => item.id), ["pink-top", "green-bottom"]);
  assert.match(result.reason, /颜色口诀协调配色/);
  assert.match(result.reason, /图案单品搭配纯色/);
  assert.equal(colorRelationship("蓝色", "白色").reason, "颜色口诀协调配色");
});

test("20℃和21℃都允许薄款加外套参与整套保暖评分", () => {
  const items = [
    { id: "thin-top", name: "薄上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "thin-bottom", name: "薄长裤", category: "裤子", color: "黑色", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "mid-coat", name: "适中外套", category: "外套", color: "黑色", season: "多季", thickness: "适中", scenes: ["休闲"] }
  ];
  for (const temperature of [20, 21]) {
    const result = structuredClone(recommend(items, { temperature, high: temperature, condition: "晴" }, "休闲"));
    assert.deepEqual(result.items.map((item) => item.id), ["thin-top", "thin-bottom", "mid-coat"]);
  }
});

test("极端高温淘汰厚款但普通温度边界不一刀切", () => {
  const items = [
    { id: "thin", name: "薄上衣", category: "上衣", color: "白色", season: "春夏", thickness: "薄", scenes: ["休闲"] },
    { id: "thick", name: "厚上衣", category: "上衣", color: "白色", season: "多季", thickness: "厚", scenes: ["休闲"] },
    { id: "bottom", name: "薄长裤", category: "裤子", color: "黑色", season: "多季", thickness: "薄", scenes: ["休闲"] }
  ];
  const hot = structuredClone(recommend(items, { temperature: 31, high: 31, condition: "晴" }, "休闲"));
  assert.equal(hot.items.some((item) => item.id === "thick"), false);
  const mild = structuredClone(recommend(items, { temperature: 25, high: 25, condition: "晴" }, "休闲"));
  assert.ok(mild.outfitCount >= 1);
});

test("30℃允许适中短袖与适中下装组合但仍淘汰厚款", () => {
  const result = structuredClone(recommend([
    { id: "mid-short-top", name: "适中短袖", category: "上衣", season: "春夏", thickness: "适中", scenes: ["约会"] },
    { id: "mid-bottom", name: "适中下装", category: "裤子", season: "春夏", thickness: "适中", scenes: ["约会"] },
    { id: "thick-top", name: "厚上衣", category: "上衣", season: "多季", thickness: "厚", scenes: ["约会"] }
  ], { temperature: 30, low: 27, high: 31, condition: "多云" }, "约会"));
  assert.deepEqual(result.items.map((item) => item.id), ["mid-short-top", "mid-bottom"]);
  assert.equal(result.items.some((item) => item.id === "thick-top"), false);
  assert.equal(result.complete, true);
});

test("寒冷或风雨天气缺少外套时明确报告结构缺口", () => {
  const result = structuredClone(recommend([
    { id: "mid-top", name: "适中上衣", category: "上衣", season: "秋冬", thickness: "适中", scenes: ["通勤"] },
    { id: "mid-bottom", name: "适中长裤", category: "裤子", season: "秋冬", thickness: "适中", scenes: ["通勤"] }
  ], { temperature: 12, high: 12, condition: "晴" }, "通勤"));
  assert.ok(result.missing.includes("外套"));
  assert.deepEqual(result.items, []);
  assert.equal(result.complete, false);
});

test("天气框架先于裙装偏好，冬天不返回不安全的夏季薄裙", () => {
  const items = [
    { id: "summer-dress", name: "夏季薄裙", category: "连衣裙", season: "春夏", thickness: "薄", scenes: ["约会"] },
    { id: "winter-top", name: "冬季厚上衣", category: "上衣", season: "秋冬", thickness: "厚", scenes: ["约会"] },
    { id: "winter-pants", name: "冬季厚裤", category: "裤子", season: "秋冬", thickness: "厚", scenes: ["约会"] },
    { id: "winter-coat", name: "冬季厚外套", category: "外套", season: "秋冬", thickness: "厚", scenes: ["约会"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 5, low: 2, high: 7, condition: "晴" }, "约会", 0, {
    preferredCategories: ["连衣裙"]
  }));
  assert.equal(result.items.some((item) => item.id === "summer-dress"), false);
  assert.deepEqual(result.items.map((item) => item.id), ["winter-top", "winter-pants", "winter-coat"]);
  assert.equal(result.complete, true);
  assert.match(result.reason, /没有安全的连衣裙组合/);
});

test("凉冷天气允许薄裙与足够保暖的厚外套组成安全叠穿", () => {
  const result = structuredClone(recommend([
    { id: "summer-dress", name: "薄连衣裙", category: "连衣裙", season: "春夏", thickness: "薄", scenes: ["约会"] },
    { id: "thick-coat", name: "厚外套", category: "外套", season: "秋冬", thickness: "厚", scenes: ["约会"] }
  ], { temperature: 12, low: 12, high: 12, condition: "晴" }, "约会", 0, { preferredCategories: ["连衣裙"] }));
  assert.deepEqual(result.items.map((item) => item.id), ["summer-dress", "thick-coat"]);
  assert.equal(result.complete, true);
});

test("大温差天气优先可脱外套并分别适配白天和早晚", () => {
  const items = [
    { id: "thin-top", name: "薄上衣", category: "上衣", color: "白色", season: "春秋", thickness: "薄", scenes: ["通勤"] },
    { id: "thin-bottom", name: "薄长裤", category: "裤子", color: "黑色", season: "春秋", thickness: "薄", scenes: ["通勤"] },
    { id: "mid-coat", name: "适中外套", category: "外套", color: "黑色", season: "春秋", thickness: "适中", scenes: ["通勤"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 23, low: 15, high: 27, condition: "晴" }, "通勤"));
  assert.deepEqual(result.items.map((item) => item.id), ["thin-top", "thin-bottom", "mid-coat"]);
  assert.match(result.reason, /早晚温差12℃.*外套可穿脱调节/);
});

test("穿搭助手偏好只能软排序且明确排除品类会硬过滤", () => {
  const items = [
    { id: "sweet-top", name: "甜美粉色上衣", category: "上衣", color: "粉色", season: "多季", thickness: "薄", styles: ["甜美"], scenes: ["约会"] },
    { id: "plain-top", name: "简约白色上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", styles: ["简约"], scenes: ["约会"] },
    { id: "skirt", name: "半身裙", category: "半身裙", color: "白色", season: "多季", thickness: "薄", styles: ["甜美"], scenes: ["约会"] },
    { id: "pants", name: "长裤", category: "裤子", color: "米色", season: "多季", thickness: "薄", styles: ["甜美"], scenes: ["约会"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 25, low: 22, high: 27, condition: "晴" }, "约会", 0, {
    styles: ["甜美"], preferredColors: ["粉色"], excludedCategories: ["半身裙"]
  }));
  assert.deepEqual(result.items.map((item) => item.id), ["sweet-top", "pants"]);
  assert.equal(result.items.some((item) => item.category === "半身裙"), false);
  assert.match(result.reason, /甜美风格|喜欢的颜色/);
});

test("穿搭助手明确想穿裙子时优先天气安全的真实裙装", () => {
  const items = [
    { id: "date-dress", name: "隆重约会连衣裙", category: "连衣裙", color: "酒红色", season: "多季", thickness: "薄", styles: ["优雅"], scenes: ["约会"] },
    { id: "casual-top", name: "休闲上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", styles: ["休闲"], scenes: ["休闲"] },
    { id: "casual-pants", name: "休闲长裤", category: "裤子", color: "蓝色", season: "多季", thickness: "薄", styles: ["休闲"], scenes: ["休闲"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 25, low: 22, high: 27, condition: "晴" }, "约会", 0, {
    preferredCategories: ["连衣裙", "半身裙"], styles: ["优雅"]
  }));
  assert.deepEqual(result.items.map((item) => item.id), ["date-dress"]);
  assert.match(result.reason, /优先满足你想穿的连衣裙或半身裙/);
});

test("多轮反馈可以锁定一件真实衣物并排除另一件", () => {
  const items = [
    { id: "keep-top", name: "保留上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", scenes: ["约会"] },
    { id: "other-top", name: "其他上衣", category: "上衣", color: "粉色", season: "多季", thickness: "薄", scenes: ["约会"] },
    { id: "old-pants", name: "旧裤子", category: "裤子", color: "黑色", season: "多季", thickness: "薄", scenes: ["约会"] },
    { id: "new-pants", name: "新裤子", category: "裤子", color: "米色", season: "多季", thickness: "薄", scenes: ["约会"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 25, low: 22, high: 27, condition: "晴" }, "约会", 0, {
    lockedItemIds: ["keep-top"], excludedItemIds: ["old-pants"]
  }));
  assert.equal(result.items.some((item) => item.id === "keep-top"), true);
  assert.equal(result.items.some((item) => item.id === "old-pants"), false);
  assert.equal(result.items.some((item) => item.id === "new-pants"), true);
});

test("文字要求只换裤子时排除当前裤子并锁定其他衣物", () => {
  const currentItems = [
    { id: "keep-top", name: "短袖T恤", category: "上衣" },
    { id: "old-pants", name: "条纹系带阔腿裤", category: "裤子" },
    { id: "keep-coat", name: "黑色立领拉链外套", category: "外套" }
  ];
  for (const text of ["换一条裤子推荐", "有没有别的适合的裤子"]) {
    const result = applyItemDirectives(text, currentItems, [], []);
    assert.deepEqual([...result.excludedItemIds], ["old-pants"], text);
    assert.deepEqual([...result.lockedItemIds].sort(), ["keep-coat", "keep-top"], text);
    assert.deepEqual([...result.replacementCategories], ["裤子"], text);
  }
});

test("局部替换没有可用裤子时不得放弃锁定衣物返回另一套", () => {
  const items = [
    { id: "keep-top", name: "当前上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", scenes: ["运动"] },
    { id: "other-top", name: "其他上衣", category: "上衣", color: "粉色", season: "多季", thickness: "薄", scenes: ["运动"] },
    { id: "keep-coat", name: "当前外套", category: "外套", color: "黑色", season: "冬季", thickness: "厚", scenes: ["运动"] },
    { id: "old-pants", name: "当前裤子", category: "裤子", color: "蓝色", season: "多季", thickness: "薄", scenes: ["运动"] },
    { id: "other-pants", name: "其他裤子", category: "裤子", color: "黑色", season: "多季", thickness: "薄", scenes: ["运动"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 30, low: 28, high: 32, condition: "晴" }, "运动", 0, {
    lockedItemIds: ["keep-top", "keep-coat"], excludedItemIds: ["old-pants"]
  }));
  assert.deepEqual(result.items, []);
  assert.match(result.missingText, /保留当前其他衣物/);
});

test("局部换裤子会遍历第十三件以后的裤子并补回排名靠后的锁定衣物", () => {
  const casualTops = Array.from({ length: 12 }, (_, index) => ({
    id: `casual-top-${index}`,
    name: `休闲上衣${index}`,
    category: "上衣",
    season: "多季",
    thickness: "薄",
    formality: "休闲",
    scenes: ["聚会"]
  }));
  const casualPants = Array.from({ length: 12 }, (_, index) => ({
    id: `casual-pants-${index}`,
    name: `休闲裤${index}`,
    category: "裤子",
    season: "多季",
    thickness: "适中",
    formality: "休闲",
    scenes: ["聚会"]
  }));
  const casualCoats = Array.from({ length: 12 }, (_, index) => ({
    id: `casual-coat-${index}`,
    name: `休闲外套${index}`,
    category: "外套",
    season: "多季",
    thickness: "薄",
    formality: "休闲",
    scenes: ["聚会"]
  }));
  const items = [
    ...casualTops,
    { id: 901, name: "保留半正式上衣", category: "上衣", season: "多季", thickness: "薄", formality: "半正式", scenes: ["聚会"] },
    ...casualPants,
    { id: 301, name: "第十三条合适牛仔裤", category: "裤子", season: "多季", thickness: "适中", formality: "半正式", scenes: ["聚会"] },
    ...casualCoats,
    { id: 902, name: "保留半正式外套", category: "外套", season: "多季", thickness: "薄", formality: "半正式", scenes: ["聚会"] },
    { id: 300, name: "当前裤子", category: "裤子", season: "多季", thickness: "适中", formality: "半正式", scenes: ["聚会"] }
  ];
  const result = structuredClone(recommend(items, { temperature: 27, low: 22, high: 32, condition: "晴" }, "聚会", 0, {
    occasion: "朋友聚会",
    formalityPreference: "semi_formal",
    lockedItemIds: ["901", "902"],
    excludedItemIds: ["300"],
    replacementCategories: ["裤子"]
  }));
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => String(item.id)), ["901", "301", "902"]);
  assert.equal(result.replacementDiagnostics.candidateCount, 13);
  assert.equal(result.replacementDiagnostics.lockedSafeCount > 0, true);
});

test("局部换裤子失败会说明候选裤子在哪一层被筛掉", () => {
  const result = structuredClone(recommend([
    { id: "top", name: "保留上衣", category: "上衣", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "coat", name: "保留外套", category: "外套", season: "多季", thickness: "厚", scenes: ["休闲"] },
    { id: "old-pants", name: "当前裤子", category: "裤子", season: "多季", thickness: "薄", scenes: ["休闲"] },
    { id: "jeans-a", name: "牛仔裤A", category: "裤子", season: "多季", thickness: "适中", scenes: ["休闲"] },
    { id: "jeans-b", name: "牛仔裤B", category: "裤子", season: "多季", thickness: "适中", scenes: ["休闲"] }
  ], { temperature: 30, low: 28, high: 32, condition: "晴" }, "休闲", 0, {
    lockedItemIds: ["top", "coat"],
    excludedItemIds: ["old-pants"],
    replacementCategories: ["裤子"]
  }));
  assert.equal(result.complete, false);
  assert.equal(result.replacementDiagnostics.candidateCount, 2);
  assert.equal(result.replacementDiagnostics.suitableCount, 2);
  assert.match(result.reason, /2条未被排除的裤子/);
  assert.match(result.reason, /保留当前其他衣物/);
});

test("完整重选会清除局部锁定而换一套会排除当前整套", () => {
  const currentItems = [
    { id: "top", name: "当前上衣", category: "上衣" },
    { id: "pants", name: "当前裤子", category: "裤子" },
    { id: "coat", name: "当前外套", category: "外套" }
  ];
  const reset = applyItemDirectives("从衣柜里完整找出一套适合的衣服", currentItems, ["top", "coat"], ["pants"]);
  assert.equal(reset.selectionAction, "reset_selection");
  assert.deepEqual([...reset.lockedItemIds], []);
  assert.deepEqual([...reset.excludedItemIds], []);

  const reroll = applyItemDirectives("换一套看看", currentItems, ["top"], ["pants"]);
  assert.equal(reroll.selectionAction, "replace_all");
  assert.deepEqual([...reroll.lockedItemIds], []);
  assert.deepEqual([...reroll.excludedItemIds].sort(), ["coat", "pants", "top"]);
});

test("局部替换失败时回滚临时锁定并保留上一套成功搭配", () => {
  const stable = {
    currentItems: [{ id: "top" }, { id: "old-pants" }, { id: "coat" }],
    lockedItemIds: [],
    excludedItemIds: []
  };
  const pending = { lockedItemIds: ["top", "coat"], excludedItemIds: ["old-pants"] };
  const settled = settleItemSelection(stable, pending, [], false);
  assert.equal(settled.committed, false);
  assert.deepEqual([...settled.currentItems], stable.currentItems);
  assert.deepEqual([...settled.lockedItemIds], []);
  assert.deepEqual([...settled.excludedItemIds], []);
});

test("局部替换成功后才提交新衣物和对应锁定状态", () => {
  const stable = {
    currentItems: [{ id: "top" }, { id: "old-pants" }, { id: "coat" }],
    lockedItemIds: [],
    excludedItemIds: []
  };
  const pending = { lockedItemIds: ["top", "coat"], excludedItemIds: ["old-pants"] };
  const nextItems = [{ id: "top" }, { id: "new-pants" }, { id: "coat" }];
  const settled = settleItemSelection(stable, pending, nextItems, true);
  assert.equal(settled.committed, true);
  assert.deepEqual([...settled.currentItems], nextItems);
  assert.deepEqual([...settled.lockedItemIds], ["top", "coat"]);
  assert.deepEqual([...settled.excludedItemIds], ["old-pants"]);
});

test("局部替换失败后完整重选可以解除限制并恢复完整结果", () => {
  const items = [
    { id: "top", name: "当前上衣", category: "上衣", color: "白色", season: "多季", thickness: "薄", scenes: ["聚会"] },
    { id: "pants", name: "唯一裤子", category: "裤子", color: "蓝色", season: "多季", thickness: "薄", scenes: ["聚会"] }
  ];
  const weather = { temperature: 25, low: 22, high: 27, condition: "晴" };
  const first = structuredClone(recommend(items, weather, "聚会"));
  const stable = { currentItems: first.items, lockedItemIds: [], excludedItemIds: [] };
  assert.equal(first.complete, true);

  const replace = applyItemDirectives("换一条裤子", stable.currentItems, stable.lockedItemIds, stable.excludedItemIds);
  const failed = structuredClone(recommend(items, weather, "聚会", 0, replace));
  const rolledBack = settleItemSelection(stable, replace, failed.items, failed.complete);
  assert.equal(failed.complete, false);
  assert.equal(rolledBack.committed, false);
  assert.deepEqual([...rolledBack.currentItems].map((item) => item.id), ["top", "pants"]);

  const reset = applyItemDirectives("从衣柜里完整找出一套适合的衣服", rolledBack.currentItems, rolledBack.lockedItemIds, rolledBack.excludedItemIds);
  const recovered = structuredClone(recommend(items, weather, "聚会", 0, reset));
  const committed = settleItemSelection(rolledBack, reset, recovered.items, recovered.complete);
  assert.equal(committed.committed, true);
  assert.deepEqual([...committed.currentItems].map((item) => item.id), ["top", "pants"]);
});

test("缺少下装时不把单件上衣伪装成完整天气穿搭", () => {
  const result = structuredClone(recommend(outfitItems.slice(0, 2), outfitWeather, "通勤"));
  assert.deepEqual(result.items, []);
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes("下装或连衣裙"));
  assert.ok(result.missing.includes("符合当前天气框架的完整搭配"));
  assert.match(result.missingText, /下装或连衣裙/);
});

test("7 天胶囊按品类限额选择真实衣物并计算基础组合", () => {
  const capsuleItems = [
    ...Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, name: `上衣${index}`, category: "上衣", scenes: ["通勤"], wear_count: index })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, name: `下装${index}`, category: "裤子", scenes: ["通勤"], wear_count: index })),
    { id: "o1", name: "外套", category: "外套", scenes: ["通勤"], wear_count: 1 },
    { id: "s1", name: "鞋子", category: "鞋子", scenes: ["通勤"], wear_count: 1 }
  ];
  const result = structuredClone(buildCapsulePlan(capsuleItems, "通勤"));
  assert.equal(result.itemCount, 7);
  assert.equal(result.combinationCount, 6);
  assert.deepEqual(result.missing, []);
  assert.equal(result.items.filter((item) => item.category === "上衣").length, 3);
  assert.equal(result.items.filter((item) => item.category === "裤子").length, 2);
});

test("胶囊优先场景匹配和较少穿着的衣物", () => {
  const result = structuredClone(buildCapsulePlan([
    { id: "frequent", name: "高频通勤上衣", category: "上衣", scenes: ["通勤"], wear_count: 20 },
    { id: "low", name: "低频通勤上衣", category: "上衣", scenes: ["通勤"], wear_count: 1 },
    { id: "other", name: "休闲上衣", category: "上衣", scenes: ["休闲"], wear_count: 0 },
    { id: "bottom", name: "通勤裤", category: "裤子", scenes: ["通勤"], wear_count: 2 }
  ], "通勤"));
  assert.deepEqual(result.items.slice(0, 3).map((item) => item.id), ["low", "frequent", "other"]);
});

test("胶囊衣物不足时不伪造组合并说明结构缺口", () => {
  const result = structuredClone(buildCapsulePlan([
    { id: "top", name: "唯一上衣", category: "上衣", scenes: ["休闲"], wear_count: 0 }
  ], "休闲"));
  assert.equal(result.combinationCount, 0);
  assert.equal(result.coversSevenDays, false);
  assert.deepEqual(result.missing, ["下装或连衣裙"]);
});

test("保存搭配只提交衣物ID和安全布局，不提交签名图片", () => {
  const layers = [
    canvas.createLayer({ id: "top", name: "白衬衫", category: "上衣", imageUrl: "https://signed.test/top" }, 0, { width: 360, height: 600 }, "top-layer"),
    canvas.createLayer({ id: "bottom", name: "黑裤", category: "裤子", imageUrl: "https://signed.test/bottom" }, 1, { width: 360, height: 600 }, "bottom-layer")
  ];
  const payload = canvas.buildPlanPayload(layers, { width: 360, height: 600 });
  assert.deepEqual(structuredClone(payload.canvas), { width: 360, height: 600 });
  assert.deepEqual(payload.layers.map((layer) => layer.itemId), ["top", "bottom"]);
  assert.equal(JSON.stringify(payload).includes("signed.test"), false);
});

test("导出按当前画布比例换算位置、缩放和衣物尺寸", () => {
  const rect = canvas.exportLayerRect({ x: 36, y: 60, scale: 1.5 }, { width: 360, height: 600 }, { width: 1080, height: 1800 }, { width: 190, height: 230 });
  assert.deepEqual(structuredClone(rect), { x: 108, y: 180, width: 855, height: 1035 });
});

test("搭配画布提供保存、记到日历、导出和私人方案入口", () => {
  assert.match(canvasMarkup, /bindtap="savePlan"/);
  assert.match(canvasMarkup, /bindtap="openWearForm"/);
  assert.match(canvasMarkup, /bindtap="exportImage"/);
  assert.match(canvasMarkup, /我的搭配方案/);
});

test("穿搭日历把同一套的多件衣物合并展示，单件记录保持独立", () => {
  const groups = structuredClone(groupWearLogs([
    { id: "l1", outfitRecordId: "o1", outfitTitle: "通勤搭配", wornAt: "2026-08-11T04:00:00.000Z", dateKey: "2026-08-11", timeText: "12:00", item: { id: "1", name: "上衣" } },
    { id: "l2", outfitRecordId: "o1", outfitTitle: "通勤搭配", wornAt: "2026-08-11T04:00:00.000Z", dateKey: "2026-08-11", timeText: "12:00", item: { id: "2", name: "裤子" } },
    { id: "l3", outfitRecordId: "", wornAt: "2026-08-11T05:00:00.000Z", dateKey: "2026-08-11", timeText: "13:00", item: { id: "3", name: "外套" } }
  ]));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, "通勤搭配");
  assert.deepEqual(groups[0].items.map((item) => item.id), ["1", "2"]);
  assert.deepEqual(groups[1].items.map((item) => item.id), ["3"]);
});

test("穿搭日历在日期格汇总当天全部不重复衣物且不限制鞋包配饰", () => {
  const clothes = [
    { id: "top", name: "上衣", imageUrl: "top.png" },
    { id: "pants", name: "裤子", imageUrl: "pants.png" },
    { id: "shoes", name: "鞋子", imageUrl: "shoes.png" },
    { id: "bag", name: "包包", imageUrl: "bag.png" },
    { id: "hat", name: "帽子", imageUrl: "hat.png" },
    { id: "scarf", name: "围巾", imageUrl: "scarf.png" }
  ];
  const summaries = structuredClone(buildDaySummaries([
    { id: "outfit:1", dateKey: "2026-08-13", items: clothes.slice(0, 5) },
    { id: "outfit:2", dateKey: "2026-08-13", items: [clothes[0], clothes[5]] }
  ]));
  assert.equal(summaries["2026-08-13"].count, 2);
  assert.deepEqual(summaries["2026-08-13"].previewItems.map((item) => item.id), ["top", "pants", "shoes", "bag", "hat", "scarf"]);
  const days = structuredClone(calendarDays(2026, 7, "2026-08-13", summaries));
  const selected = days.find((day) => day.key === "2026-08-13");
  assert.equal(selected.previewClass, "preview-many");
  assert.equal(selected.previewItems.length, 6);
});

test("穿搭日历以大日期格展示衣物并提供轻量点击动效", () => {
  assert.match(calendarMarkup, /item\.previewItems/);
  assert.match(calendarMarkup, /!item\.hasOutfit/);
  assert.match(calendarMarkup, /lazy-load="\{\{true\}\}"/);
  assert.match(calendarMarkup, /item\.count > 1/);
  assert.match(calendarStyles, /\.calendar-day \{[^}]*height: 116rpx;/);
  assert.match(calendarStyles, /\.preview-many \{ grid-template-columns: repeat\(3, 1fr\); \}/);
  assert.match(calendarStyles, /@keyframes day-select-pop/);
  assert.match(calendarStyles, /@keyframes garment-arrive/);
});

test("穿搭日历标题跟随选中日期且历史空月份默认选择一号", () => {
  assert.deepEqual(structuredClone(selectedDateCopy("2026-08-14", new Date(2026, 7, 14))), {
    title: "今天",
    subtitle: "周五 · 2026年8月14日"
  });
  assert.equal(selectedDateCopy("2026-08-13", new Date(2026, 7, 14)).title, "8月13日");
  assert.equal(defaultSelectedKey(2026, 6, [], new Date(2026, 7, 14)), "2026-07-01");
  assert.equal(defaultSelectedKey(2026, 7, [], new Date(2026, 7, 14)), "2026-08-14");
});

test("月度最爱按次数排序并在并列时选择最近穿过的衣物", () => {
  const summary = structuredClone(buildHistorySummary([
    { id: "g1", wornAt: "2026-08-03T02:00:00.000Z", items: [{ id: "coat", name: "外套", imageUrl: "coat.png" }] },
    { id: "g2", wornAt: "2026-08-09T02:00:00.000Z", items: [{ id: "bag", name: "包包", imageUrl: "bag.png" }] }
  ], "month"));
  assert.deepEqual(summary.items.map((item) => item.id), ["bag", "coat"]);
  assert.equal(summary.favorite.id, "bag");
  assert.equal(summary.totalCount, 2);
  assert.equal(summary.distinctItemCount, 2);
});

test("日期第一次点击只选中，第二次点击同一有记录日期进入周页", () => {
  calendarNavigation = "";
  const groups = [{ id: "outfit:o1", dateKey: "2026-08-13", wornAt: "2026-08-13T02:00:00.000Z", items: [{ id: "top", imageUrl: "top.png" }] }];
  const context = {
    data: { year: 2026, month: 7, selectedKey: "2026-08-14", lastTappedKey: "", groups },
    setData(update) { Object.assign(this.data, structuredClone(update)); }
  };
  const event = { currentTarget: { dataset: { key: "2026-08-13" } } };
  calendarPage.selectDay.call(context, event);
  assert.equal(context.data.selectedKey, "2026-08-13");
  assert.equal(calendarNavigation, "");
  calendarPage.selectDay.call(context, event);
  assert.equal(calendarNavigation, "/pages/wear-week/index?date=2026-08-13");
});

test("周范围固定为周日到周六并支持跨月跨年", () => {
  const crossMonth = structuredClone(weekRange("2026-03-31"));
  assert.equal(crossMonth.days[0].key, "2026-03-29");
  assert.equal(crossMonth.days[6].key, "2026-04-04");
  assert.deepEqual(structuredClone(weekTitle(weekRange("2026-03-31"))), { title: "3月29日—4月4日", yearText: "2026" });
  const crossYear = structuredClone(weekRange("2026-01-01"));
  assert.equal(crossYear.days[0].key, "2025-12-28");
  assert.equal(crossYear.days[6].key, "2026-01-03");
});

test("月页和周页展示全部衣物、最爱卡及周页路由", () => {
  const app = JSON.parse(fs.readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8"));
  assert.match(calendarMarkup, /monthlyItems/);
  assert.match(calendarMarkup, /MONTHLY FAVORITE/);
  assert.match(calendarSource, /lastTappedKey === key/);
  assert.match(weekMarkup, /weeklyItems/);
  assert.match(weekMarkup, /WEEKLY FAVORITE/);
  assert.match(weekSource, /history\.weekRange/);
  assert.ok(app.pages.includes("pages/wear-week/index"));
});

test("穿搭日历整卡打开穿着快照，单件点击仍进入衣物详情", () => {
  assert.match(calendarMarkup, /data-record-id="\{\{item\.outfitRecordId\}\}"/);
  assert.match(calendarMarkup, /bindtap="openOutfit"/);
  assert.match(calendarMarkup, /catchtap="openItem"/);
  assert.match(calendarSource, /pages\/outfit-detail\/index\?recordId=/);
  assert.match(calendarSource, /setStorageSync\(WEAR_RECORD_PREVIEW_KEY/);
  assert.match(outfitDetailSource, /api\.getOutfitRecord\(this\.recordId\)/);
  assert.match(outfitDetailSource, /getStorageSync\(WEAR_RECORD_PREVIEW_KEY\)/);
  assert.match(outfitDetailSource, /createLayer\(item, index, canvas/);
});

test("穿搭日历不再展示报表和成长入口", () => {
  assert.doesNotMatch(calendarMarkup, /bindtap="openReport"/);
  assert.doesNotMatch(calendarMarkup, /bindtap="openRewards"/);
  assert.doesNotMatch(calendarMarkup, /本月衣橱报表|星星与成长/);
});

test("体验版恢复正式账号模式并保留可回退的 Demo 基础设施", () => {
  assert.match(configSource, /DEMO_READONLY:\s*false/);
  assert.match(sessionSource, /config\.DEMO_READONLY/);
  assert.match(apiSource, /\/api\/demo\/bootstrap/);
  assert.match(apiSource, /\/api\/demo\/session/);
  assert.match(homeMarkup, /<view class="add-row"><button bindtap="toAdd"/);
  assert.doesNotMatch(homeMarkup, /wx:if="\{\{!demoReadonly\}\}"[^>]*><button bindtap="toAdd"/);
  const inspirationMarkup = fs.readFileSync(new URL("../miniprogram/pages/inspiration/index.wxml", import.meta.url), "utf8");
  assert.match(inspirationMarkup, /bindtap="sendMessage"/);
  assert.match(inspirationMarkup, /bindtap="chooseScreenshot"/);
  assert.match(wardrobeMarkup, /wx:if="\{\{!demoReadonly\}\}" class="shortcut-card canvas-shortcut"/);
  assert.match(wardrobeMarkup, /wx:if="\{\{!demoReadonly\}\}" class="idle-entry"/);
  assert.match(wardrobeMarkup, /wx:if="\{\{!demoReadonly\}\}" class="candidate-entry"/);
  assert.match(itemDetailMarkup, /wx:if="\{\{!demoReadonly\}\}" class="management-actions"/);
  assert.match(itemDetailMarkup, /wx:if="\{\{message\}\}" class="message">\{\{message\}\}<\/text>[\s\S]*bindtap="saveEdit"/);
  assert.match(itemDetailMarkup, /wx:if="\{\{!demoReadonly\}\}" class="card section idle-section"/);
  assert.match(itemDetailMarkup, /正式度/);
  assert.match(itemDetailMarkup, /功能标签/);
  assert.match(addItemMarkup, /bindchange="onFormalityChange"/);
  assert.match(addItemMarkup, /functionTagsText/);
  assert.match(accountMarkup, /wx:if="\{\{!demoReadonly\}\}" class="card entitlement-card"/);
  assert.match(accountMarkup, /wx:if="\{\{!demoReadonly\}\}" class="logout-button"/);
  assert.match(galleryMarkup, /wx:if="\{\{!demoReadonly\}\}" class="create-button"/);
});

test("小程序页面不再残留旧紫色主题值", () => {
  const root = new URL("../miniprogram/", import.meta.url);
  const styleSource = fs.readdirSync(root, { recursive: true })
    .filter((name) => /\.(?:wxss|wxml)$/.test(String(name)))
    .map((name) => fs.readFileSync(new URL(String(name).replaceAll("\\", "/"), root), "utf8"))
    .join("\n");
  assert.doesNotMatch(styleSource, /#(?:9b87c1|a98abc|a98abe|8062a3|927db6|eee7f5|f8f4ff|fbf7ff|f5effa|d7c6e2|876b98|b298c2|a08caf|856fa0|9278aa)\b/i);
  assert.doesNotMatch(styleSource, /rgba\((?:161,\s*140,\s*190|155,\s*135,\s*19[23]|157,\s*136,\s*188|143,\s*119,\s*171)/i);
  assert.match(styleSource, /#bd7381/i);
  assert.match(styleSource, /#f1dfe2/i);
});
