import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/wardrobe-report.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Set, Math });
const { buildWardrobeReport } = commonJsModule.exports;

test("衣橱报表只根据真实穿着记录计算高低频和品类分布", () => {
  const items = [
    { id: "1", name: "白色上衣", category: "上衣" },
    { id: "2", name: "蓝色牛仔裤", category: "裤子" },
    { id: "3", name: "黑色外套", category: "外套" }
  ];
  const logs = [
    { item: { id: "1", category: "上衣" } },
    { item: { id: "1", category: "上衣" } },
    { item: { id: "2", category: "裤子" } }
  ];
  const report = structuredClone(buildWardrobeReport(items, logs));
  assert.equal(report.totalCount, 3);
  assert.equal(report.distinctItemCount, 2);
  assert.deepEqual(report.highFrequency.map((item) => [item.id, item.count]), [["1", 2]]);
  assert.deepEqual(report.lowFrequency.map((item) => [item.id, item.count]), [["3", 0]]);
  assert.deepEqual(report.categories, [
    { name: "上衣", count: 2, percent: 67 },
    { name: "裤子", count: 1, percent: 33 }
  ]);
});

test("没有穿着记录时明确标记数据不足", () => {
  const report = structuredClone(buildWardrobeReport([{ id: "1", name: "白色上衣", category: "上衣" }], []));
  assert.equal(report.hasData, false);
  assert.equal(report.totalCount, 0);
  assert.equal(report.distinctItemCount, 0);
  assert.deepEqual(report.highFrequency, []);
  assert.deepEqual(report.categories, []);
});
