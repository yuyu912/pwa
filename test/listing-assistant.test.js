import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/listing-assistant.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Number, String, Math });
const { generateListing } = commonJsModule.exports;

const item = { name: "奶油白针织开衫", category: "外套", color: "奶油白", material: "针织" };

test("转卖文案使用本人确认的衣物字段和售价", () => {
  const result = generateListing(item, { mode: "sale", salePrice: "99", condition: "九成新", delivery: "快递", note: "不退换" });
  assert.match(result.title, /闲置转卖/);
  assert.match(result.content, /转卖价格：¥99/);
  assert.match(result.content, /九成新/);
});

test("出租文案包含日租金、押金和最短租期", () => {
  const result = generateListing(item, { mode: "rent", dailyRent: "10", deposit: "100", minDays: "3", delivery: "当面交付" });
  assert.match(result.title, /出租/);
  assert.match(result.content, /日租金：¥10/);
  assert.match(result.content, /押金：¥100/);
  assert.match(result.content, /最短租期：3 天/);
});

test("云端发布记录只接受本人闲置衣物并校验链接", () => {
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(backend, /item\.user_id !== userId/);
  assert.match(backend, /item\.idle_status \|\| "active"\) !== "considering"/);
  assert.match(backend, /\^https\?:\\\/\\\/\[\^\\s\]\+\$/);
});
