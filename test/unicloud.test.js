import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js");

test("uniCloud HTTP 请求可解析普通和 base64 JSON", () => {
  assert.deepEqual(_test.parseBody({ body: '{"name":"衣服"}', isBase64Encoded: false }), { name: "衣服" });
  assert.deepEqual(_test.parseBody({ body: Buffer.from('{"ok":true}').toString("base64"), isBase64Encoded: true }), { ok: true });
});

test("uniCloud 标签清洗限制数量和允许场景", () => {
  assert.deepEqual(_test.sanitizeTags('["休闲","未知","通勤","旅行","运动"]', ["休闲", "通勤", "旅行"], 3), ["休闲", "通勤", "旅行"]);
  assert.deepEqual(_test.sanitizeTags("not-json"), []);
});

test("uniCloud 文本清洗会去空格并限制长度", () => {
  assert.equal(_test.cleanText("  连帽卫衣  ", 3), "连帽卫");
});
