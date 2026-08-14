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
const { recommend } = weatherModule.exports;
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
const addItemMarkup = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.wxml", import.meta.url), "utf8");
const candidateMarkup = fs.readFileSync(new URL("../miniprogram/pages/candidate/index.wxml", import.meta.url), "utf8");
const loginSource = fs.readFileSync(new URL("../miniprogram/pages/login/index.js", import.meta.url), "utf8");
const loginMarkup = fs.readFileSync(new URL("../miniprogram/pages/login/index.wxml", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../miniprogram/services/api.js", import.meta.url), "utf8");
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
  assert.match(result.reason, /适合通勤/);
});

test("换一套会在同类可选衣物中轮换", () => {
  const result = structuredClone(recommend(outfitItems, outfitWeather, "休闲", 1));
  assert.deepEqual(result.items.map((item) => item.id), ["2", "4"]);
});

test("缺少下装时返回真实单品并给出缺失提示", () => {
  const result = structuredClone(recommend(outfitItems.slice(0, 2), outfitWeather, "通勤"));
  assert.deepEqual(result.items.map((item) => item.id), ["2"]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ["下装或连衣裙"]);
  assert.equal(result.missingText, "下装或连衣裙");
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

test("穿搭日历保留报表和成长入口并移除入口大箭头", () => {
  assert.match(calendarMarkup, /bindtap="openReport"/);
  assert.match(calendarMarkup, /bindtap="openRewards"/);
  assert.match(calendarMarkup, /class="calendar-shortcuts"/);
  assert.doesNotMatch(calendarMarkup, /class="row-arrow"/);
});
