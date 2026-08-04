import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("套餐框架展示已确认价格，但不包含支付或自动续费入口", () => {
  const page = read("../miniprogram/pages/plans/index.wxml");
  const api = read("../miniprogram/services/api.js");
  assert.match(page, /¥\{\{item\.price\}\}/);
  assert.doesNotMatch(page, /价格待确认|折算周价|低总价|总付款最高/);
  assert.match(page, /不会发起支付，也不会自动续费/);
  assert.match(page, /购买功能准备中/);
  assert.doesNotMatch(api, /requestPayment|prepay_id|payment\/orders/);
});

test("衣物识别前端按真实供应商分阶段调用", () => {
  const script = read("../miniprogram/pages/add-item/index.js");
  const page = read("../miniprogram/pages/add-item/index.wxml");
  assert.match(script, /await api\.mattingItem\(upload\.taskId\)/);
  assert.match(script, /showMattingReview\(matting\)/);
  assert.match(script, /await api\.removeHanger\(this\.data\.taskId\)/);
  assert.match(script, /await api\.selectTaskImage\(this\.data\.taskId, this\.data\.selectedImage\)/);
  assert.match(script, /await api\.recognizeLabels\(this\.data\.taskId\)/);
  assert.match(script, /mode: "manual"/);
  assert.match(script, /originalCutoutUrl = matting\.originalCutoutUrl \|\| matting\.cutoutUrl/);
  assert.match(script, /typeof wx\.chooseMedia === "function"/);
  assert.match(script, /wx\.chooseImage\(/);
  assert.match(script, /mediaType: \["image"\]/);
  assert.match(script, /腾讯数据万象/);
  assert.match(script, /通义千问 VL/);
  assert.match(script, /先调用商品抠图；检测到复杂背景残留时自动追加 1 次通用抠图，不消耗大模型 Token/);
  assert.match(script, /消耗大模型 Token，用于理解衣物图像/);
  assert.match(page, /基础抠图和手动录入长期保留/);
  assert.match(page, /仅抠图，手动填写/);
  assert.match(page, /AI 移除衣架（可选）/);
  assert.match(page, /使用当前图片并继续识别/);
  assert.doesNotMatch(page, /按件 AI 测试额度/);
  assert.match(page, /不展示密钥、内部成本或模型思考过程/);
});

test("首页到期提示每个小程序会话最多自动显示一次", () => {
  const home = read("../miniprogram/pages/home/index.js");
  const app = read("../miniprogram/app.js");
  assert.match(app, /entitlementPromptShown: false/);
  assert.match(home, /!app\.globalData\.entitlementPromptShown/);
  assert.match(home, /app\.globalData\.entitlementPromptShown = true/);
});
