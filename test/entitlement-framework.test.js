import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("套餐框架展示已确认价格和连续订阅折扣，但不伪装支付能力", () => {
  const page = read("../miniprogram/pages/plans/index.wxml");
  const api = read("../miniprogram/services/api.js");
  const cloud = read("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js");
  assert.match(cloud, /name: "周卡"[\s\S]*?price: 6\.9[\s\S]*?renewalPrice: 6\.21[\s\S]*?连续包周九折/);
  assert.match(cloud, /name: "月卡"[\s\S]*?price: 34\.9[\s\S]*?renewalPrice: 27\.92[\s\S]*?连续包月八折/);
  assert.match(cloud, /name: "年卡"[\s\S]*?price: 298[\s\S]*?renewalPrice: 208\.6[\s\S]*?连续包年七折/);
  assert.match(cloud, /WEEKLY_QUOTA = Object\.freeze\(\{ recognitionLimit: 6, hangerRemovalLimit: 1/);
  assert.match(cloud, /PAID_QUOTA = Object\.freeze\(\{ recognitionLimit: 40, hangerRemovalLimit: 10/);
  assert.match(page, /¥\{\{item\.price\}\}/);
  assert.match(page, /¥\{\{item\.renewalPrice\}\}/);
  assert.doesNotMatch(page, /价格待确认|折算周价|低总价|总付款最高/);
  assert.match(page, /支付与自动续费尚未接入/);
  assert.match(page, /支付功能准备中/);
  assert.doesNotMatch(api, /requestPayment|prepay_id|payment\/orders/);
  assert.match(page, /周卡额度 7 天有效；月卡 30 天有效；年卡每 30 天刷新/);
  assert.match(page, /不创建订单、不扣款、不自动续费/);
});

test("全局导航和我的页提供账户入口、真实权益与安全退出", () => {
  const tabBar = read("../miniprogram/custom-tab-bar/index.wxml");
  const accountScript = read("../miniprogram/pages/account/index.js");
  const accountPage = read("../miniprogram/pages/account/index.wxml");
  assert.match(tabBar, /\{\{item\.text\}\}/);
  assert.match(accountScript, /await api\.getEntitlement\(\)/);
  assert.match(accountScript, /openPlans\(\).*pages\/plans\/index/);
  assert.match(accountScript, /logout\(\)[\s\S]*?session\.clear\(\)[\s\S]*?pages\/login\/index/);
  assert.match(accountPage, /属性识别剩余/);
  assert.match(accountPage, /移除衣架剩余/);
  assert.match(accountPage, /查看 AI 权益套餐/);
  assert.match(accountPage, /退出登录/);
  assert.match(accountPage, /这不是退出登录/);
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
  assert.match(script, /属性识别剩余/);
  assert.match(page, /entitlement\.quotaText/);
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

test("新衣观望清单可从首页进入并只允许观望记录完成最终决定", () => {
  const app = read("../miniprogram/app.json");
  const home = read("../miniprogram/pages/home/index.wxml");
  const api = read("../miniprogram/services/api.js");
  const waitlist = read("../miniprogram/pages/candidate-waitlist/index.js");
  const candidate = read("../miniprogram/pages/candidate/index.wxml");
  assert.match(app, /pages\/candidate-waitlist\/index/);
  assert.match(home, /新衣观望清单/);
  assert.match(api, /listWaitingCandidates/);
  assert.match(waitlist, /api\.listWaitingCandidates\(\)/);
  assert.match(candidate, /wx:if="\{\{!reviewingWait\}\}"/);
});

test("隐私和提审文本覆盖衣架移除与AI权益使用记录", () => {
  const privacyPage = read("../miniprogram/pages/privacy/index.js");
  const privacyGuide = read("../WECHAT_PRIVACY_GUIDE_DRAFT.md");
  const reviewDraft = read("../WECHAT_REVIEW_SUBMISSION_DRAFT.md");
  assert.match(privacyPage, /主动点击“AI 移除衣架”/);
  assert.match(privacyPage, /AI 权益使用记录/);
  assert.match(privacyPage, /穿着打卡与星星流水/);
  assert.match(privacyPage, /观望起始时间/);
  assert.match(privacyPage, /不展示供应商密钥、内部单价、模型思考过程或管理员成本/);
  assert.match(privacyGuide, /用户可以选择原抠图或修复图/);
  assert.match(privacyGuide, /试用与权益剩余次数/);
  assert.match(reviewDraft, /可选 AI 移除衣架/);
  assert.match(reviewDraft, /2026-08-04-candidate-waitlist-v1/);
  assert.match(reviewDraft, /兑换功能当前未开放/);
  assert.doesNotMatch(reviewDraft, /2026-08-03-p1-listing-assistant-v2/);
});
