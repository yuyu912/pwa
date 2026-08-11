import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/wardrobe-filter.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Number, String, Array });
const { filterWardrobe } = commonJsModule.exports;
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
const calendarSource = fs.readFileSync(new URL("../miniprogram/pages/wear-calendar/index.js", import.meta.url), "utf8");
const calendarMarkup = fs.readFileSync(new URL("../miniprogram/pages/wear-calendar/index.wxml", import.meta.url), "utf8");
const outfitDetailSource = fs.readFileSync(new URL("../miniprogram/pages/outfit-detail/index.js", import.meta.url), "utf8");
const calendarModule = { exports: {} };
vm.runInNewContext(calendarSource, { module: calendarModule, exports: calendarModule.exports, require: () => ({}), Page: () => {}, Date, Number, String, Array, Map, Set });
const { groupWearLogs } = calendarModule.exports;
const items = [
  { id: "1", name: "白色针织上衣", category: "上衣", season: "春秋", thickness: "适中", material: "针织", styles: ["温柔"], scenes: ["通勤"], monthlyWearCount: 3, idleStatus: "active" },
  { id: "2", name: "蓝色牛仔裤", category: "裤子", season: "多季", thickness: "适中", material: "牛仔", styles: ["休闲"], scenes: ["旅行"], monthlyWearCount: 0, idleStatus: "considering" },
  { id: "3", name: "黑色风衣", category: "外套", season: "秋冬", thickness: "厚", material: "聚酯纤维", styles: ["通勤"], scenes: ["通勤"], monthlyWearCount: 1, idleStatus: "active" }
];

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
