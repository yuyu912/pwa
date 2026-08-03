import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("私人闲置管理只包含手动标记、恢复和本人清单", async () => {
  const [api, detailScript, detailTemplate, idleScript, idleTemplate, schema] = await Promise.all([
    read("../miniprogram/services/api.js"),
    read("../miniprogram/pages/item-detail/index.js"),
    read("../miniprogram/pages/item-detail/index.wxml"),
    read("../miniprogram/pages/idle-items/index.js"),
    read("../miniprogram/pages/idle-items/index.wxml"),
    read("../uniCloud-aliyun/database/wr_clothing_items.schema.json")
  ]);
  assert.match(api, /markItemIdle/);
  assert.match(api, /restoreIdleItem/);
  assert.match(api, /listIdleItems/);
  assert.match(detailScript, /IDLE_REASONS/);
  assert.match(detailScript, /api\.markItemIdle/);
  assert.match(detailScript, /api\.restoreIdleItem/);
  assert.match(detailTemplate, /仅你可见/);
  assert.match(detailTemplate, /maxlength="100"/);
  assert.match(idleScript, /api\.listIdleItems/);
  assert.match(idleTemplate, /不会公开、交换、出租/);
  assert.match(idleTemplate, /最近穿着/);
  for (const field of ["idle_status", "idle_reason", "idle_note", "idle_marked_at"]) assert.match(schema, new RegExp(field));
});
