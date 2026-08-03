import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/batch-upload.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Array, Date });
const { createBatch, updateBatchItem, nextBatchIndex, batchSummary } = commonJsModule.exports;

test("批量选图最多创建9个独立任务", () => {
  const batch = structuredClone(createBatch(Array.from({ length: 12 }, (_, index) => `image-${index}.jpg`)));
  assert.equal(batch.length, 9);
  assert.equal(new Set(batch.map((item) => item.id)).size, 9);
  assert.ok(batch.every((item) => item.status === "pending" && !item.taskId && !item.draftId));
});

test("已保存和已跳过的项目不会被重复处理", () => {
  let batch = structuredClone(createBatch(["1.jpg", "2.jpg", "3.jpg"]));
  batch = structuredClone(updateBatchItem(batch, 0, { status: "saved", taskId: "task-1" }));
  batch = structuredClone(updateBatchItem(batch, 1, { status: "skipped" }));
  assert.equal(nextBatchIndex(batch, -1), 2);
  assert.deepEqual(structuredClone(batchSummary(batch)), { total: 3, saved: 1, skipped: 1 });
});

test("更新当前项不会改动其他图片的幂等任务", () => {
  const original = structuredClone(createBatch(["1.jpg", "2.jpg"]));
  const updated = structuredClone(updateBatchItem(original, 0, { status: "recognizing", taskId: "task-1" }));
  assert.equal(updated[0].taskId, "task-1");
  assert.equal(updated[1].taskId, "");
  assert.equal(updated[1].status, "pending");
});

test("添加衣物页保持顺序处理、逐件确认和失败跳过入口", () => {
  const script = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.js", import.meta.url), "utf8");
  const template = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.wxml", import.meta.url), "utf8");
  assert.match(script, /count: this\.data\.entryMode === "candidate" \? 1 : 9/);
  assert.match(script, /for \(let index = 0; index < batchItems\.length; index \+= 1\)/);
  assert.match(script, /await this\.compressFile/);
  assert.match(script, /nextBatchIndex\(this\.data\.batchItems, this\.data\.batchIndex\)/);
  assert.match(script, /if \(this\.data\.stage === "saving"\) return/);
  assert.match(script, /let upload = this\.data\.manualUpload/);
  assert.match(script, /if \(!this\.data\.manualUploaded\)/);
  assert.match(script, /taskId: upload\.taskId/);
  assert.match(template, /当前件确认入库后才会进入下一件/);
  assert.match(template, /bindtap="skipBatchItem"/);
});
