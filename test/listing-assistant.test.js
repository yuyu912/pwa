import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../miniprogram/utils/listing-assistant.js", import.meta.url), "utf8");
const commonJsModule = { exports: {} };
vm.runInNewContext(source, { module: commonJsModule, exports: commonJsModule.exports, Number, String, Math });
const { generateListing, validateListingForm } = commonJsModule.exports;

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

test("价格留空显示待议而不是零元", () => {
  assert.match(generateListing(item, { mode: "sale", condition: "九成新", delivery: "快递", salePrice: "" }).content, /转卖价格：¥待议/);
  assert.match(generateListing(item, { mode: "rent", condition: "九成新", delivery: "快递", dailyRent: "", deposit: "", minDays: 1 }).content, /日租金：¥待议；押金：¥待议/);
});

test("客户端在请求云端前校验必填项、金额、租期和链接", () => {
  assert.equal(validateListingForm({ mode: "sale", condition: "", delivery: "快递" }), "请填写成色说明。");
  assert.match(validateListingForm({ mode: "sale", condition: "九成新", delivery: "快递", salePrice: "-1" }), /转卖价格/);
  assert.match(validateListingForm({ mode: "rent", condition: "九成新", delivery: "快递", minDays: "1.5" }), /最短租期/);
  assert.match(validateListingForm({ mode: "sale", condition: "九成新", delivery: "快递", url: "xianyu-item" }), /http/);
  assert.equal(validateListingForm({ mode: "sale", condition: "九成新", delivery: "快递", salePrice: "", url: "" }), "");
});

test("生成按钮提供可见反馈并滚动到结果", () => {
  const page = fs.readFileSync(new URL("../miniprogram/pages/listing-assistant/index.js", import.meta.url), "utf8");
  const template = fs.readFileSync(new URL("../miniprogram/pages/listing-assistant/index.wxml", import.meta.url), "utf8");
  assert.match(page, /wx\.showToast\(\{ title: "文案已更新"/);
  assert.match(page, /wx\.pageScrollTo\(\{ selector: "\.result-card"/);
  assert.match(template, /class="error action-feedback"/);
});

test("云端发布记录只接受本人闲置衣物并校验链接", () => {
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(backend, /item\.user_id !== userId/);
  assert.match(backend, /item\.idle_status \|\| "active"\) !== "considering"/);
  assert.match(backend, /\^https\?:\\\/\\\/\[\^\\s\]\+\$/);
});

test("读取单件衣物不再先下载整份衣橱", () => {
  const client = fs.readFileSync(new URL("../miniprogram/services/api.js", import.meta.url), "utf8");
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(client, /request\(`\/api\/items\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(backend, /if \(method === "GET"\) return response\(event, 200, mapItem\(item\)\)/);
});

test("闲置清单优先使用衣物最近穿着汇总字段", () => {
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(backend, /item\.last_worn_at \? null : await repository\.findOne\("wearLogs"/);
  assert.match(backend, /last_worn_at: wornAt/);
});

test("穿着日历一次批量读取相关衣物", () => {
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(backend, /_id: repository\.command\(\)\.in\(itemIds\)/);
  assert.doesNotMatch(backend, /itemIds\.map\(async \(id\).*getById\("clothing"/s);
});

test("好友帮搭只批量读取用户选中的衣物", () => {
  const backend = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(backend, /status: "active", _id: repository\.command\(\)\.in\(itemIds\)/);
  assert.match(backend, /const ownedById = new Map/);
});
