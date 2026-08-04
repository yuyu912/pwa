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
});
