import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/wardrobe-filter.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Number, String, Array });
const { filterWardrobe } = commonJsModule.exports;
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
