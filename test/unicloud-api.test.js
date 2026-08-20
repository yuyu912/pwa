import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import bcrypt from "bcryptjs";

const require = createRequire(import.meta.url);
const cloudModule = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js");
const cloudTest = cloudModule._test;
const inspiration = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/inspiration.js");
const outfitAssistant = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/outfit-assistant.js");

test("穿搭助手在模型格式异常时仍能从原话提取受控需求", () => {
  const preferences = outfitAssistant.inferPreferencesFromText({
    current: "我晚上要去约会，想穿温柔一点，不要裙子，我比较怕冷",
    previous: "",
    followupUsed: false
  });
  assert.equal(preferences.scene, "约会");
  assert.deepEqual(preferences.styles, ["甜美"]);
  assert.deepEqual(preferences.excludedCategories, ["半身裙", "连衣裙"]);
  assert.equal(preferences.warmthPreference, "warmer");
  assert.equal(preferences.needsClarification, false);
});

test("穿搭助手把想穿裙子保留为正向品类需求而不是继续追问", () => {
  const first = outfitAssistant.inferPreferencesFromText({ current: "推荐一个裙子", followupUsed: false });
  assert.deepEqual(first.preferredCategories, ["连衣裙", "半身裙"]);
  assert.equal(first.needsClarification, false);
  const followed = outfitAssistant.inferPreferencesFromText({ previous: "推荐一个裙子", current: "约会，想隆重一点", followupUsed: true });
  assert.equal(followed.scene, "约会");
  assert.deepEqual(followed.styles, ["优雅"]);
  assert.deepEqual(followed.preferredCategories, ["连衣裙", "半身裙"]);
});

test("穿搭助手多轮说不想穿裙子时清除旧裙装偏好", () => {
  const current = outfitAssistant.normalizePreferences({ mode: "new", scene: "约会", preferred_categories: ["连衣裙", "半身裙"] }, false);
  const changed = outfitAssistant.inferPreferencesFromText({
    current: "不想穿裙子，有没有别的推荐",
    recentMessages: [{ role: "user", content: "我想穿裙子" }],
    contextPreferences: current,
    followupUsed: true
  });
  assert.deepEqual(changed.excludedCategories, ["半身裙", "连衣裙"]);
  assert.deepEqual(changed.preferredCategories, []);
  assert.equal(changed.scene, "约会");
});

test("穿搭助手已有运动上下文时不因鞋子补充语重复追问", () => {
  const sport = outfitAssistant.inferPreferencesFromText({ current: "我想要运动风", followupUsed: false });
  const input = outfitAssistant.requestText(
    "不考虑鞋子",
    "我想要运动风",
    false,
    sport,
    [],
    [],
    [{ role: "user", content: "我想要运动风" }]
  );
  const result = outfitAssistant.reconcilePreferences(input, {
    mode: "modify",
    action: "recommend",
    needsClarification: true,
    question: "今天主要是什么场合，或者想要什么风格？"
  });
  assert.equal(result.scene, "运动");
  assert.deepEqual(result.styles, ["运动"]);
  assert.equal(result.formalityPreference, "athletic");
  assert.equal(result.needsClarification, false);
  assert.equal(result.question, "");
  assert.equal(outfitAssistant.ALLOWED_CATEGORIES.includes("鞋子"), false);
});

test("穿搭助手根据当前搭配事实回答有没有裤子并保留运动上下文", () => {
  const sport = outfitAssistant.inferPreferencesFromText({ current: "我晚上要去运动，给我推荐衣服", followupUsed: false });
  const facts = [
    { name: "短袖T恤", category: "上衣", color: "浅绿色", reasons: ["符合运动场景"] },
    { name: "条纹系带阔腿裤", category: "裤子", color: "浅灰蓝", reasons: ["符合运动场景"] },
    { name: "黑色立领拉链外套", category: "外套", color: "黑色", reasons: ["适合早晚温差"] }
  ];
  const input = outfitAssistant.requestText(
    "有没有裤子呢",
    "我晚上要去运动，给我推荐衣服",
    false,
    sport,
    facts.map((item) => item.category),
    facts,
    [{ role: "user", content: "我晚上要去运动，给我推荐衣服" }]
  );
  const result = outfitAssistant.reconcilePreferences(input, {
    mode: "modify",
    action: "recommend",
    needsClarification: true,
    question: "今天主要是什么场合，或者想要什么风格？"
  });
  assert.equal(result.action, "answer");
  assert.equal(result.scene, "运动");
  assert.equal(result.needsClarification, false);
  assert.equal(result.question, "");
  assert.match(result.reply, /有.*条纹系带阔腿裤/);
});

test("穿搭助手多轮反馈保留旧条件并只修改用户指出的部分", () => {
  const current = outfitAssistant.normalizePreferences({ mode: "new", scene: "约会", styles: ["优雅"], preferred_categories: ["连衣裙"], preferred_colors: ["白色"] }, false);
  const relaxed = outfitAssistant.inferPreferencesFromText({ current: "不要这么正式，轻松一点", contextPreferences: current, currentCategories: ["连衣裙"] });
  assert.equal(relaxed.mode, "modify");
  assert.equal(relaxed.scene, "约会");
  assert.deepEqual(relaxed.styles, ["休闲", "简约"]);
  assert.deepEqual(relaxed.preferredCategories, ["连衣裙"]);
  assert.deepEqual(relaxed.preferredColors, ["白色"]);
  const ambiguous = outfitAssistant.inferPreferencesFromText({ current: "这件不要", contextPreferences: relaxed, currentCategories: ["连衣裙"] });
  assert.equal(ambiguous.needsClarification, true);
  assert.match(ambiguous.question, /连衣裙.*换掉/);
});

test("穿搭助手以本轮正式要求覆盖历史休闲措辞", () => {
  const current = outfitAssistant.normalizePreferences({ mode: "new", scene: "休闲", styles: ["休闲"] }, false);
  const formal = outfitAssistant.inferPreferencesFromText({
    current: "我晚上是跟领导的饭局，要正式一点的穿搭",
    recentMessages: [{ role: "assistant", content: "已按休闲场景推荐" }],
    contextPreferences: current,
    followupUsed: true
  });
  assert.equal(formal.mode, "modify");
  assert.equal(formal.scene, "聚会");
  assert.equal(formal.occasion, "商务饭局");
  assert.equal(formal.formalityPreference, "semi_formal");
  assert.deepEqual(formal.styles, ["通勤", "优雅"]);
});

test("朋友聚会中的正式一点按上下文升一级而不是跳到最高正式", () => {
  const current = outfitAssistant.normalizePreferences({
    mode: "new", scene: "聚会", occasion: "朋友聚会", formality_preference: "smart_casual",
    preferred_categories: ["裤子"], excluded_categories: ["连衣裙"], preferred_colors: ["粉色"], warmth_preference: "warmer"
  }, false);
  const input = outfitAssistant.requestText("要正式一点的穿搭", "我晚上要去朋友聚会", false, current, [], [], []);
  const reconciled = outfitAssistant.reconcilePreferences(input, {
    mode: "modify", action: "recommend", scene: "通勤", occasion: "朋友聚会",
    formality_preference: "formal", styles: ["通勤", "优雅"],
    preferred_categories: ["连衣裙"], excluded_categories: [], preferred_colors: ["黑色"], warmth_preference: "normal"
  });
  assert.equal(reconciled.mode, "modify");
  assert.equal(reconciled.scene, "聚会");
  assert.equal(reconciled.occasion, "朋友聚会");
  assert.equal(reconciled.formalityPreference, "semi_formal");
  assert.deepEqual(reconciled.styles, ["优雅"]);
  assert.deepEqual(reconciled.preferredCategories, ["裤子"]);
  assert.deepEqual(reconciled.excludedCategories, ["连衣裙"]);
  assert.deepEqual(reconciled.preferredColors, ["粉色"]);
  assert.equal(reconciled.warmthPreference, "warmer");
  assert.equal(reconciled.needsClarification, false);
  const raisedAgain = outfitAssistant.inferPreferencesFromText({ current: "再正式一点", contextPreferences: reconciled });
  assert.equal(raisedAgain.formalityPreference, "formal");
  assert.equal(raisedAgain.occasion, "朋友聚会");
});

test("明确的高正式场合仍使用最高正式等级", () => {
  const formal = outfitAssistant.inferPreferencesFromText({ current: "参加正式晚宴，要非常正式" });
  assert.equal(formal.occasion, "正式活动");
  assert.equal(formal.formalityPreference, "formal");
  assert.deepEqual(formal.styles, ["优雅"]);
});

test("穿搭助手连续多轮保留正式偏好并叠加新限制", () => {
  const formal = outfitAssistant.inferPreferencesFromText({ current: "晚上见领导，想穿正式一点" });
  const dinner = outfitAssistant.inferPreferencesFromText({
    current: "一个饭局",
    contextPreferences: formal,
    recentMessages: [{ role: "user", content: "晚上见领导，想穿正式一点" }],
    followupUsed: true
  });
  const noDress = outfitAssistant.inferPreferencesFromText({
    current: "但是不要裙子",
    contextPreferences: dinner,
    recentMessages: [{ role: "user", content: "晚上见领导，想穿正式一点" }, { role: "user", content: "一个饭局" }],
    followupUsed: true
  });
  assert.equal(dinner.scene, "聚会");
  assert.equal(dinner.occasion, "商务饭局");
  assert.equal(dinner.formalityPreference, "semi_formal");
  assert.deepEqual(dinner.styles, ["通勤", "优雅"]);
  assert.equal(noDress.scene, "聚会");
  assert.deepEqual(noDress.styles, ["通勤", "优雅"]);
  assert.deepEqual(noDress.excludedCategories, ["半身裙", "连衣裙"]);
});

test("穿搭助手会复核格式正确但语义冲突的模型结果", () => {
  const input = outfitAssistant.requestText("参加朋友婚礼，但不要裙子", "", false, {}, [], [], []);
  const reconciled = outfitAssistant.reconcilePreferences(input, {
    mode: "new", action: "recommend", scene: "休闲", occasion: "日常",
    formality_preference: "casual", styles: ["休闲"], excluded_categories: []
  });
  assert.equal(reconciled.scene, "聚会");
  assert.equal(reconciled.occasion, "婚礼宾客");
  assert.equal(reconciled.formalityPreference, "semi_formal");
  assert.deepEqual(reconciled.excludedCategories, ["半身裙", "连衣裙"]);
});

test("模型在修改轮返回空数组时不得清空已确认上下文", () => {
  const current = outfitAssistant.normalizePreferences({
    mode: "new", scene: "聚会", styles: ["通勤", "优雅"], excluded_categories: ["连衣裙"]
  }, false);
  const merged = outfitAssistant.normalizePreferences({
    mode: "modify", action: "recommend", styles: [], excluded_categories: [], summary: "继续调整"
  }, true, current);
  assert.equal(merged.scene, "聚会");
  assert.deepEqual(merged.styles, ["通勤", "优雅"]);
  assert.deepEqual(merged.excludedCategories, ["连衣裙"]);
});

test("穿搭助手区分常见子场景、正式度和户外活动", () => {
  const cases = [
    ["见领导吃饭，要正式一点", "聚会", "商务饭局", "semi_formal"],
    ["参加朋友婚礼", "聚会", "婚礼宾客", "semi_formal"],
    ["明天有面试", "通勤", "面试", "business"],
    ["周末去徒步", "运动", "徒步登山", "outdoor"],
    ["露营而且晚上怕冷", "运动", "露营", "outdoor"],
    ["下班去跑步", "运动", "跑步", "athletic"],
    ["去海边度假", "旅行", "海边度假", "casual"],
    ["带孩子出去玩", "休闲", "亲子出行", "casual"],
    ["去看展", "聚会", "演出观展", "smart_casual"],
    ["周末去骑行", "运动", "骑行", "outdoor"],
    ["去雪场滑雪", "运动", "滑雪", "outdoor"]
  ];
  for (const [message, scene, occasion, formalityPreference] of cases) {
    const result = outfitAssistant.inferPreferencesFromText({ current: message });
    assert.equal(result.scene, scene, message);
    assert.equal(result.occasion, occasion, message);
    assert.equal(result.formalityPreference, formalityPreference, message);
  }
});

test("正式程度独立于大场景并在后续对话中保留", () => {
  const date = outfitAssistant.inferPreferencesFromText({ current: "约会，想穿正式一点" });
  const warmer = outfitAssistant.inferPreferencesFromText({ current: "晚上怕冷", contextPreferences: date, followupUsed: true });
  assert.equal(date.scene, "约会");
  assert.equal(date.occasion, "约会");
  assert.equal(date.formalityPreference, "semi_formal");
  assert.equal(warmer.scene, "约会");
  assert.equal(warmer.occasion, "约会");
  assert.equal(warmer.formalityPreference, "semi_formal");
  assert.equal(warmer.warmthPreference, "warmer");
});

test("穿搭助手能区分解释、换一套和继续修改", () => {
  const current = outfitAssistant.normalizePreferences({ mode: "new", scene: "约会", styles: ["优雅"], preferred_categories: ["连衣裙"] }, false);
  const explanation = outfitAssistant.inferPreferencesFromText({
    current: "为什么推荐这套？", contextPreferences: current,
    currentOutfitFacts: [{ name: "黑色连衣裙", category: "连衣裙", color: "黑色", reasons: ["符合约会场景", "当前天气可穿"] }]
  });
  assert.equal(explanation.action, "answer");
  assert.match(explanation.reply, /黑色连衣裙.*约会场景/);
  const reroll = outfitAssistant.inferPreferencesFromText({ current: "换一套看看", contextPreferences: current });
  assert.equal(reroll.action, "reroll");
  assert.equal(reroll.needsClarification, false);
  const casual = outfitAssistant.inferPreferencesFromText({ current: "不要这么正式，轻松一点", contextPreferences: current });
  assert.equal(casual.action, "recommend");
  assert.deepEqual(casual.styles, ["休闲", "简约"]);
});

test("完整重选保留场景偏好但退出上一轮衣物级限制", () => {
  const current = outfitAssistant.normalizePreferences({ mode: "new", scene: "聚会", styles: ["休闲"] }, false);
  const reset = outfitAssistant.inferPreferencesFromText({
    current: "从衣柜里完整找出一套适合的衣服",
    contextPreferences: current,
    currentOutfitFacts: [{ name: "当前裤子", category: "裤子" }]
  });
  assert.equal(reset.mode, "modify");
  assert.equal(reset.action, "reroll");
  assert.equal(reset.scene, "聚会");
  assert.deepEqual(reset.styles, ["休闲"]);
  assert.equal(reset.needsClarification, false);
});

test("穿搭助手只对临时上游故障启用本地降级", () => {
  assert.equal(outfitAssistant.shouldFallbackToRules({ code: "billing_maintenance", providerStatusCode: 503 }), true);
  assert.equal(outfitAssistant.shouldFallbackToRules({ code: "VISION_TIMEOUT", status: 504 }), true);
  assert.equal(outfitAssistant.shouldFallbackToRules({ code: "OUTFIT_ASSISTANT_OUTPUT_INVALID", status: 502 }), true);
  assert.equal(outfitAssistant.shouldFallbackToRules({ code: "VISION_UNAUTHORIZED", providerStatusCode: 401 }), false);
  assert.equal(outfitAssistant.shouldFallbackToRules({ code: "LYROUTER_CONFIG_INVALID", status: 500 }), false);
});

test("Qwen3.7 穿搭需求理解预留足够的完整 JSON 输出空间", () => {
  const request = cloudTest.buildOutfitAssistantRequestBody("只返回JSON", { model: "qwen/qwen3.7-plus" });
  assert.equal(request.max_completion_tokens, 900);
  assert.equal(request.response_format.type, "json_object");
  assert.equal(request.temperature, 0);
});
const pngAlpha = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/png-alpha.js");

test("穿搭需求只保留受控字段且最多追问一次", () => {
  const result = outfitAssistant.normalizePreferences({
    scene: "约会", styles: ["韩系", "甜美", "不存在"], preferred_categories: ["连衣裙", "帽子"], excluded_categories: ["半身裙", "帽子"],
    preferred_colors: ["粉色"], excluded_colors: ["黑色"], warmth_preference: "warmer", summary: "温柔约会"
  });
  assert.deepEqual(result.styles, ["韩系", "甜美"]);
  assert.deepEqual(result.excludedCategories, ["半身裙"]);
  assert.deepEqual(result.preferredCategories, ["连衣裙"]);
  assert.deepEqual(result.preferredColors, ["粉色"]);
  assert.equal(result.warmthPreference, "warmer");
  assert.equal(result.action, "recommend");
  assert.equal(outfitAssistant.normalizePreferences({ needsClarification: true }, false).needsClarification, true);
  assert.equal(outfitAssistant.normalizePreferences({ needsClarification: true }, true).needsClarification, false);
});

test("穿搭需求提示不包含衣橱数据并锁定结构化输出", () => {
  const prompt = outfitAssistant.promptForRequest(outfitAssistant.requestText("今天约会，不穿裙子", "", false));
  assert.match(prompt, /不选择或编造衣物/);
  assert.match(prompt, /excluded_categories/);
  assert.match(prompt, /preferred_categories/);
  assert.doesNotMatch(prompt, /衣物ID|完整衣橱/);
});

test("穿搭需求最近消息受控截断且进入上下文提示", () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `第${index}条${"很长".repeat(100)}` }));
  messages.push({ role: "system", content: "不得进入提示" });
  const input = outfitAssistant.requestText("换浅色裤子", "", true, {}, [], [], messages);
  assert.ok(input.recentMessages.length <= 10);
  assert.ok(input.recentMessages.reduce((sum, message) => sum + message.content.length, 0) <= 1000);
  assert.equal(input.recentMessages.some((message) => message.role === "system"), false);
  assert.match(outfitAssistant.promptForRequest(input), /最近对话/);
});

test("灵感页提供临时多轮消息流并保留截图、确认和私密历史", () => {
  const fs = require("node:fs");
  const js = fs.readFileSync(new URL("../miniprogram/pages/inspiration/index.js", import.meta.url), "utf8");
  const wxml = fs.readFileSync(new URL("../miniprogram/pages/inspiration/index.wxml", import.meta.url), "utf8");
  assert.match(js, /async startLink\(/);
  assert.match(js, /listInspirations/);
  assert.match(js, /confirmInspiration/);
  assert.match(js, /understandOutfitRequest/);
  assert.match(js, /recentMessages/);
  assert.match(js, /outfitDirectives\.applyItemDirectives/);
  assert.match(js, /replacementCategories/);
  assert.match(js, /replacementCategories: selection\.replacementCategories \|\| \[\]/);
  assert.match(js, /settleItemSelection/);
  assert.match(js, /rematchInspiration\(version, pendingSelection\)/);
  assert.match(js, /onHide\(\) \{ this\.clearConversation\(\); \}/);
  assert.match(js, /sessionVersion/);
  assert.match(wxml, /发需求或粘贴小红书链接/);
  assert.match(wxml, /bindtap="chooseScreenshot"/);
  assert.match(wxml, /私密历史/);
  assert.match(wxml, /穿搭助手/);
  assert.match(wxml, /catchtap="keepItem"/);
  assert.match(wxml, /catchtap="replaceItem"/);
  assert.match(wxml, /我理解的需求/);
  assert.match(wxml, /catchtap="relaxPreference"/);
});

test("公网 Demo 自动读取固定账号且不携带真实登录凭据或开放写操作", () => {
  const fs = require("node:fs");
  const demoSource = fs.readFileSync(new URL("../public/demo/app.js", import.meta.url), "utf8");
  const apiSource = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(demoSource, /\/api\/demo\/bootstrap/);
  assert.match(demoSource, /loadReadonlyAccount\(\)/);
  assert.match(demoSource, /renderWardrobe\(data\.items\)/);
  assert.match(demoSource, /只读演示已关闭上传、保存和修改操作/);
  assert.doesNotMatch(demoSource, /Authorization|Bearer|auth\/login|password|recoveryCode/);
  assert.match(apiSource, /path\.startsWith\("\/api\/demo\/"\) && method !== "GET"/);
  assert.match(apiSource, /公开演示只允许读取/);
  assert.match(apiSource, /!isPublicDemo && allowOrigin/);
  assert.doesNotMatch(apiSource, /DEMO_READONLY_PASSWORD|DEMO_READONLY_TOKEN/);
});

test("视觉供应商默认百炼，存在合并配置时选择 LYRouter", () => {
  const dashscope = cloudTest.visionProviderConfig({
    DASHSCOPE_API_KEY: "dashscope-test-key",
    QWEN_VL_MODEL: "qwen-test"
  });
  assert.equal(dashscope.provider, "dashscope");
  assert.equal(dashscope.model, "qwen-test");

  const lyrouter = cloudTest.visionProviderConfig({
    LYROUTER_CONFIG: JSON.stringify({
      baseUrl: "https://api.lyrouter.com/v1/",
      apiKey: "lyrouter-test-key",
      model: "qwen/qwen3.6-flash",
      inputYuanPerMillion: 1.2,
      outputYuanPerMillion: 7.2
    })
  });
  assert.equal(lyrouter.provider, "lyrouter");
  assert.equal(lyrouter.endpoint, "https://api.lyrouter.com/v1");
  assert.equal(lyrouter.model, "qwen/qwen3.6-flash");
});

test("LYRouter 视觉请求只发送标准 image_url，不携带百炼私有参数或密钥", () => {
  const config = cloudTest.visionProviderConfig({
    LYROUTER_CONFIG: JSON.stringify({
      apiKey: "must-not-leak",
      model: "qwen/qwen3.6-flash",
      inputYuanPerMillion: 1.2,
      outputYuanPerMillion: 7.2
    })
  });
  const body = cloudTest.buildVisionRequestBody("https://images.test/item.jpg", config);
  assert.equal(body.model, "qwen/qwen3.6-flash");
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.messages[0].content[0].max_pixels, undefined);
  assert.equal(body.messages[0].content[0].image_url.url, "https://images.test/item.jpg");
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
});

test("LYRouter 合并配置无效时安全停止且不回显原文", () => {
  assert.throws(
    () => cloudTest.visionProviderConfig({ LYROUTER_CONFIG: "{secret-value" }),
    (error) => error.code === "LYROUTER_CONFIG_INVALID" && !JSON.stringify(error).includes("secret-value")
  );
});

test("LYRouter 合并配置可承载百度凭证但视觉配置不回显百度密钥", () => {
  const env = {
    LYROUTER_CONFIG: JSON.stringify({
      apiKey: "lyrouter-key",
      model: "qwen/qwen3.6-flash",
      inputYuanPerMillion: 1.2,
      outputYuanPerMillion: 7.2,
      baiduApiKey: "baidu-api-key",
      baiduSecretKey: "baidu-secret-key"
    })
  };
  const config = cloudTest.visionProviderConfig(env);
  assert.deepEqual(cloudTest.baiduCredentials(env), { apiKey: "baidu-api-key", secretKey: "baidu-secret-key" });
  assert.equal(config.provider, "lyrouter");
  assert.equal(JSON.stringify(config).includes("baidu-api-key"), false);
  assert.equal(JSON.stringify(config).includes("baidu-secret-key"), false);
});

test("紧凑 LYRouter 配置可在单变量长度限制内承载百度凭证", () => {
  const env = {
    LYROUTER_CONFIG: JSON.stringify({
      apiKey: "lyrouter-key",
      model: "qwen/qwen3.6-flash",
      inputYuanPerMillion: 1.2,
      outputYuanPerMillion: 7.2,
      bAk: "baidu-api-key",
      bSk: "baidu-secret-key"
    })
  };
  assert.deepEqual(cloudTest.baiduCredentials(env), { apiKey: "baidu-api-key", secretKey: "baidu-secret-key" });
});

test("视觉供应商 HTTP 错误映射保留状态证据且不泄露鉴权信息", () => {
  const cases = [[400, "VISION_BAD_REQUEST"], [401, "VISION_UNAUTHORIZED"], [429, "VISION_RATE_LIMITED"], [503, "VISION_UPSTREAM_ERROR"]];
  for (const [statusCode, code] of cases) {
    const error = cloudTest.visionHttpError({ statusCode, data: {} }, "lyrouter");
    assert.equal(error.code, code);
    assert.equal(error.providerStatusCode, statusCode);
    assert.equal(error.provider, "lyrouter");
    assert.equal(JSON.stringify(error).includes("Authorization"), false);
  }
  const timeout = cloudTest.decorateVisionRequestError(Object.assign(new Error("timeout"), { code: "QWEN_TIMEOUT", status: 504 }), "lyrouter");
  assert.equal(timeout.code, "VISION_TIMEOUT");
  assert.equal(timeout.provider, "lyrouter");
});

test("无人物多件衣物定位最多保留三件可靠结果", () => {
  const detections = structuredClone(cloudTest.normalizeFlatLayGarments({
    person_present: false,
    garments: [
      { category: "上衣", color: "白色", bbox_2d: [50, 40, 480, 450], confidence: 0.97 },
      { category: "裤子", color: "蓝色", bbox_2d: [500, 60, 950, 940], confidence: 0.95 },
      { category: "鞋子", color: "黑色", bbox_2d: [80, 700, 400, 960], confidence: 0.9 },
      { category: "外套", color: "灰色", bbox_2d: [100, 100, 800, 900], confidence: 0.8 }
    ]
  }));
  assert.equal(detections.length, 3);
  assert.deepEqual(detections.map((item) => item.category), ["上衣", "裤子", "鞋子"]);
  assert.deepEqual(detections.map((item) => item.detectionId), ["garment-0", "garment-1", "garment-2"]);
});

test("多件衣物定位拒绝人物照片和不足两件的结果", () => {
  assert.throws(() => cloudTest.normalizeFlatLayGarments({ person_present: true, garments: [] }), (error) => error.code === "MULTI_GARMENT_PERSON_PRESENT");
  assert.throws(() => cloudTest.normalizeFlatLayGarments({ person_present: false, garments: [
    { category: "裤子", bbox_2d: [50, 50, 950, 950], confidence: 0.99 }
  ] }), (error) => error.code === "MULTI_GARMENT_NOT_ENOUGH");
});

test("百度框选抠图只接受可靠主衣物框并换算像素坐标", () => {
  assert.deepEqual(structuredClone(cloudTest.normalizePrimaryGarmentBox({
    person_present: false, garment: { bbox_2d: [50, 100, 900, 950], confidence: 0.96 }
  })), [50, 100, 900, 950]);
  assert.throws(() => cloudTest.normalizePrimaryGarmentBox({ person_present: true, garment: null }), { code: "GARMENT_PERSON_PRESENT" });
  assert.throws(() => cloudTest.normalizePrimaryGarmentBox({ person_present: false, garment: { bbox_2d: [1, 1, 10, 10], confidence: 0.9 } }), { code: "GARMENT_BOX_INVALID" });
  const payload = cloudTest.baiduControlPayload(Buffer.from("image"), [100, 200, 900, 800], { width: 1000, height: 2000 });
  assert.deepEqual(structuredClone(payload.position), [[[100, 400], [901, 1602]]]);
  const edgePayload = cloudTest.baiduControlPayload(Buffer.from("image"), [0, 0, 999, 999], { width: 1000, height: 2000 });
  assert.deepEqual(structuredClone(edgePayload.position), [[[1, 1], [999, 1999]]]);
  assert.equal(payload.method, "control");
  assert.equal(payload.return_form, "rgba");
  assert.equal(payload.refine_mask, "true");
});

test("模型 JSON 解析忽略前后说明和无效花括号片段", () => {
  assert.deepEqual(structuredClone(cloudTest.parseModelJson('分析示例 {不是JSON}\\n```json\\n{"person_present":false,"garment":{"bbox_2d":[1,2,998,997],"confidence":0.96}}\\n```\\n说明 {结束}')), {
    person_present: false,
    garment: { bbox_2d: [1, 2, 998, 997], confidence: 0.96 }
  });
});

test("LYRouter 衣物定位为推理输出保留足够 JSON 空间", () => {
  const request = cloudTest.primaryGarmentBoxRequestBody("https://example.com/private-source.jpg", {
    provider: "lyrouter", model: "qwen/qwen3.6-flash"
  });
  assert.equal(request.max_completion_tokens, 800);
  assert.equal(request.response_format.type, "json_object");
});

test("LYRouter 属性和灵感识别为推理输出保留完整 JSON 空间", () => {
  const config = { provider: "lyrouter", model: "qwen/qwen3.6-flash" };
  assert.equal(cloudTest.buildRecognitionRequestBody("https://example.com/item.png", config).max_completion_tokens, 1200);
  assert.equal(cloudTest.buildInspirationRequestBody(["https://example.com/look.jpg"], config, "只返回JSON").max_completion_tokens, 1400);
});

test("灵感链接只接受小红书 HTTPS 单条地址", () => {
  assert.equal(inspiration.extractXiaohongshuUrl("复制打开 https://xhslink.com/a1B2C 分享"), "https://xhslink.com/a1B2C");
  assert.equal(inspiration.extractXiaohongshuUrl("夏天的白色连衣裙 http://xhslink.cn/o/5dr2g4e6GJT 复制后打开小红书"), "https://xhslink.cn/o/5dr2g4e6GJT");
  assert.throws(() => inspiration.extractXiaohongshuUrl("http://xhslink.com/a1B2C"));
  assert.throws(() => inspiration.extractXiaohongshuUrl("https://example.com/note"));
});

test("灵感公开读取拒绝本机和内网地址", () => {
  for (const address of ["127.0.0.1", "10.0.0.8", "100.64.0.1", "172.16.4.2", "192.168.1.5", "169.254.2.3", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "ff02::1"]) {
    assert.equal(inspiration.isPrivateAddress(address), true, address);
  }
  assert.equal(inspiration.isPrivateAddress("8.8.8.8"), false);
});

test("灵感图片按文件头接受 JPG PNG WebP 并拒绝伪装内容", () => {
  assert.equal(inspiration.detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(inspiration.detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(inspiration.detectImageMime(Buffer.from("RIFF1234WEBP", "ascii")), "image/webp");
  assert.equal(inspiration.detectImageMime(Buffer.from("<html>not an image</html>")), "");
});

test("灵感链接 DNS 固定连接兼容 Node 单地址和 all:true 回调", () => {
  const lookup = inspiration._test.pinnedLookup({ address: "8.8.8.8", family: 4 });
  lookup("example.test", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
  lookup("example.test", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
  });
});

test("灵感图片下载只在已验证公网地址之间容错", async () => {
  const calls = [];
  const result = await inspiration._test.withAddressFallback([
    { address: "8.8.8.8", family: 4 },
    { address: "1.1.1.1", family: 4 }
  ], async (address) => {
    calls.push(address.address);
    if (calls.length === 1) throw Object.assign(new Error("timeout"), { code: "INSPIRATION_PUBLIC_PAGE_TIMEOUT" });
    return "downloaded";
  });
  assert.equal(result, "downloaded");
  assert.deepEqual(calls, ["8.8.8.8", "1.1.1.1"]);

  let blockedCalls = 0;
  await assert.rejects(inspiration._test.withAddressFallback([
    { address: "8.8.8.8", family: 4 },
    { address: "1.1.1.1", family: 4 }
  ], async () => {
    blockedCalls += 1;
    throw Object.assign(new Error("blocked"), { code: "INSPIRATION_PUBLIC_PAGE_BLOCKED" });
  }), (error) => error.code === "INSPIRATION_PUBLIC_PAGE_BLOCKED");
  assert.equal(blockedCalls, 1);
});

test("公开元信息只读取标准字段且图片去重后最多三张", () => {
  const html = `<meta property="og:title" content="一周通勤穿搭">
    <meta property="og:image" content="https://ci.xiaohongshu.com/a.jpg">
    <script type="application/ld+json">{"author":{"name":"公开作者"},"image":["https://ci.xiaohongshu.com/a.jpg","https://sns-webpic-qc.xhscdn.com/b.webp","https://sns-webpic-qc.xhscdn.com/c.png","https://sns-webpic-qc.xhscdn.com/d.jpg"]}</script>`;
  const metadata = inspiration.parsePublicMetadata(html, "https://www.xiaohongshu.com/explore/1");
  assert.equal(metadata.title, "一周通勤穿搭");
  assert.equal(metadata.author, "公开作者");
  assert.equal(metadata.images.length, 3);
  assert.equal(new Set(metadata.images).size, 3);
});

test("公开元信息过滤小红书平台 Logo 且识别笔记错误页", () => {
  const html = `<meta property="og:title" content="公开笔记">
    <meta property="og:image" content="https://picasso-static.xiaohongshu.com/fe-platform/default.png">`;
  const metadata = inspiration.parsePublicMetadata(html, "https://www.xiaohongshu.com/explore/1");
  assert.equal(metadata.title, "公开笔记");
  assert.deepEqual(metadata.images, []);
  assert.equal(inspiration._test.isPublicErrorPage("", "https://www.xiaohongshu.com/404?error_code=300031"), true);
  assert.equal(inspiration._test.isPublicErrorPage("当前笔记暂时无法浏览", "https://www.xiaohongshu.com/explore/1"), true);
  assert.equal(inspiration._test.isPublicErrorPage("公开笔记正文", "https://www.xiaohongshu.com/explore/1"), false);
});

test("公开 INITIAL_STATE 只提取当前笔记图片且不执行尾随脚本", () => {
  delete globalThis.__inspirationUnsafeExecuted;
  const html = `<meta property="og:image" content="https://picasso-static.xiaohongshu.com/fe-platform/default.png">
    <script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":{"abc123":{"note":{"imageList":[
      {"urlDefault":"http://sns-webpic-qc.xhscdn.com/main.jpg","caption":"undefined"},
      {"urlPre":"https://sns-webpic-qc.xhscdn.com/second.webp"}
    ]}},"other456":{"note":{"imageList":[{"urlDefault":"https://sns-webpic-qc.xhscdn.com/other.jpg"}]}}}},"unused":undefined};globalThis.__inspirationUnsafeExecuted=true;</script>`;
  const metadata = inspiration.parsePublicMetadata(html, "https://www.xiaohongshu.com/explore/abc123");
  assert.deepEqual(metadata.images, [
    "https://sns-webpic-qc.xhscdn.com/main.jpg",
    "https://sns-webpic-qc.xhscdn.com/second.webp"
  ]);
  assert.equal(globalThis.__inspirationUnsafeExecuted, undefined);
  assert.equal(inspiration._test.parseInitialState(html).unused, null);
  assert.equal(inspiration._test.parseInitialState(html).note.noteDetailMap.abc123.note.imageList[0].caption, "undefined");
  assert.deepEqual(inspiration._test.initialStateImages(html, "https://www.xiaohongshu.com/explore/other999"), []);
  assert.equal(inspiration._test.normalizePublicImageUrl("http://example.com/not-allowed.jpg", "https://www.xiaohongshu.com"), "http://example.com/not-allowed.jpg");
});

test("公开 INITIAL_STATE 异常或超限时安全降级", () => {
  assert.equal(inspiration._test.parseInitialState("window.__INITIAL_STATE__={broken}"), null);
  assert.equal(inspiration._test.parseInitialState(`window.__INITIAL_STATE__={"padding":"${"x".repeat(513 * 1024)}"}`), null);
  assert.deepEqual(inspiration._test.initialStateImages("window.__INITIAL_STATE__={}", "https://www.xiaohongshu.com/explore/abc123"), []);
});

test("AI 灵感结果过滤越界槽位和人物品牌材质字段", () => {
  const result = inspiration.sanitizeOutfitAnalysis({
    mainImageIndex: 8,
    summary: "一套清爽通勤穿搭",
    bodyShape: "禁止保存",
    slots: [
      { slot: "top", category: "上衣", name: "白衬衫", color: "白色", season: "春秋", thickness: "适中", pattern: "纯色", design_details: ["木耳边", "短袖", "褶边"], styles: ["韩式简约", "通勤"], scenes: ["通勤"], brand: "禁止保存", material: "禁止保存" },
      { slot: "shoes", category: "鞋子", name: "鞋" },
      { slot: "top", category: "上衣", name: "重复上装" }
    ]
  });
  assert.equal(result.mainImageIndex, 2);
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].name, "白衬衫");
  assert.equal(result.slots[0].season, "春秋");
  assert.equal(result.slots[0].thickness, "适中");
  assert.deepEqual(result.slots[0].designDetails, ["木耳边", "荷叶边"]);
  assert.deepEqual(result.slots[0].styles, ["韩系", "通勤"]);
  assert.equal("brand" in result.slots[0], false);
  assert.equal("material" in result.slots[0], false);
});

test("灵感清洗兼容有限类别修饰、槽位别名和常见外层结构", () => {
  const decorated = inspiration.sanitizeOutfitAnalysis({
    garments: [{ slot: "dress", category: "白色无袖连衣裙", name: "亚麻小白裙", color: "白色" }]
  });
  assert.equal(decorated.slots[0].category, "连衣裙");
  assert.equal(decorated.slots[0].slot, "dress");
  const objectSlots = inspiration.sanitizeOutfitAnalysis({
    slots: { upper: { slot: "上装", category: "衬衫", name: "蓝色衬衫" }, lower: { slot: "lower", category: "阔腿裤" } }
  });
  assert.deepEqual(objectSlots.slots.map((slot) => [slot.slot, slot.category]), [["top", "上衣"], ["bottom", "裤子"]]);
  assert.throws(() => inspiration.sanitizeOutfitAnalysis({ outfit: [{ category: "裙装", name: "裙装" }] }), (error) => {
    assert.equal(error.code, "INSPIRATION_NO_OUTFIT");
    assert.equal(error.safeDiagnostic.source, "outfit_array");
    return true;
  });
});

test("灵感 AI 首次有效不重试，首次无效只重试一次并合并 Token", async () => {
  const response = (payload, usage) => ({
    statusCode: 200,
    data: { model: "qwen-test", usage, choices: [{ message: { content: JSON.stringify(payload) } }] }
  });
  let calls = 0;
  const firstSuccess = await cloudTest.analyzeInspirationWithRequester(["https://image.test/1.jpg"], { model: "qwen-test", sourceTitle: "白裙" }, async () => {
    calls += 1;
    return response({ slots: [{ slot: "dress", category: "连衣裙", name: "白裙" }] }, { prompt_tokens: 10, completion_tokens: 2 });
  });
  assert.equal(calls, 1);
  assert.equal(firstSuccess.retryCount, 0);

  calls = 0;
  const retried = await cloudTest.analyzeInspirationWithRequester(["https://image.test/1.jpg"], { model: "qwen-test", sourceTitle: "夏天的白色连衣裙穿搭" }, async (body) => {
    calls += 1;
    if (calls === 1) return response({ slots: [{ slot: "shoes", category: "鞋子" }] }, { input_tokens: 11, output_tokens: 3 });
    assert.match(body.messages[0].content[1].text, /公开标题仅作辅助背景/);
    return response({ slots: [{ slot: "dress", category: "白色连衣裙", name: "小白裙" }] }, { prompt_tokens: 13, completion_tokens: 5 });
  });
  assert.equal(calls, 2);
  assert.equal(retried.retryCount, 1);
  assert.deepEqual(retried.usage, { prompt_tokens: 24, completion_tokens: 8 });
  assert.equal(retried.result.slots[0].category, "连衣裙");
});

test("灵感 AI 第二次仍无有效槽位时返回不含原始内容的安全诊断", async () => {
  let calls = 0;
  await assert.rejects(
    cloudTest.analyzeInspirationWithRequester(["https://image.test/1.jpg"], { model: "qwen-test", sourceTitle: "标题" }, async () => {
      calls += 1;
      return { statusCode: 200, data: { usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ message: { content: JSON.stringify({ slots: [] }) } }] } };
    }),
    (error) => {
      assert.equal(error.code, "INSPIRATION_NO_OUTFIT");
      assert.equal(error.safeDiagnostic.retryCount, 1);
      assert.equal(JSON.stringify(error.safeDiagnostic).includes("标题"), false);
      assert.deepEqual(error.providerUsage, { prompt_tokens: 20, completion_tokens: 4 });
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("灵感 AI 第二次网络失败也只重试一次并保留首次用量", async () => {
  let calls = 0;
  await assert.rejects(
    cloudTest.analyzeInspirationWithRequester(["https://image.test/1.jpg"], { model: "qwen-test", sourceTitle: "标题" }, async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("timeout"), { code: "QWEN_TIMEOUT" });
      return { statusCode: 200, data: { usage: { prompt_tokens: 9, completion_tokens: 1 }, choices: [{ message: { content: JSON.stringify({ slots: [] }) } }] } };
    }),
    (error) => {
      assert.equal(error.code, "QWEN_TIMEOUT");
      assert.equal(error.safeDiagnostic.retryCount, 1);
      assert.deepEqual(error.providerUsage, { prompt_tokens: 9, completion_tokens: 1 });
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("衣橱匹配先筛季节薄厚再按风格色彩排序并生成建议", () => {
  const slot = { slot: "top", category: "上衣", name: "白色韩系上衣", color: "米白", season: "春秋", thickness: "适中", pattern: "纯色", styles: ["韩式简约", "清爽"], scenes: ["通勤"] };
  const items = [
    { id: "1", category: "上衣", color: "白色", season: "春秋", thickness: "适中", pattern: "纯色", styles: ["韩系", "清新"], scenes: ["通勤"] },
    { id: "2", category: "上衣", color: "浅蓝", season: "多季", thickness: "薄", pattern: "纯色", styles: ["清新"], scenes: [] },
    { id: "3", category: "上衣", color: "黑色", season: "春秋", thickness: "厚", pattern: "纯色", styles: ["酷飒"], scenes: [] },
    { id: "4", category: "上衣", color: "奶油", season: "秋冬", thickness: "厚", pattern: "纯色", styles: ["韩系"], scenes: [] },
    { id: "5", category: "裤子", color: "白色", season: "春秋", thickness: "适中", pattern: "纯色", styles: ["韩系"], scenes: ["通勤"] },
    { id: "6", category: "上衣", color: "灰色", season: "春秋", thickness: "适中", pattern: "条纹", styles: ["通勤"], scenes: [] }
  ];
  const result = inspiration.matchWardrobe([slot], items);
  assert.deepEqual(result.matches[0].candidates.map((entry) => entry.item.id), ["1", "2"]);
  assert.match(result.matches[0].candidates[0].suggestion, /春秋.*适中.*韩系/);
  assert.equal(result.matches[0].candidates.some((entry) => entry.item.id === "3"), false);
  assert.equal(result.matches[0].candidates.some((entry) => entry.item.id === "4"), false);
  assert.equal(result.matches[0].candidates.some((entry) => entry.item.id === "5"), false);
  assert.equal(result.matches[0].candidates.some((entry) => entry.item.id === "6"), false);
});

test("灵感缺少同色衣物时按颜色口诀协调换色并明确解释", () => {
  const slot = { slot: "top", category: "上衣", name: "蓝色韩系上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", styles: ["韩系"], scenes: ["休闲"] };
  const result = inspiration.matchWardrobe([slot], [
    { id: "white", name: "白色韩系上衣", category: "上衣", color: "白色", season: "春夏", thickness: "薄", pattern: "纯色", styles: ["韩系"], scenes: ["休闲"] },
    { id: "orange", name: "橙色韩系上衣", category: "上衣", color: "橙色", season: "春夏", thickness: "薄", pattern: "纯色", styles: ["韩系"], scenes: ["休闲"] }
  ]);
  assert.equal(result.matches[0].candidates[0].item.id, "white");
  assert.match(result.matches[0].candidates[0].suggestion, /缺少同色时采用协调换色/);
});

test("韩系参考没有严格候选时普通T恤只能标为协调替代", () => {
  const slot = { slot: "top", category: "上衣", name: "格纹荷叶边短袖上衣", evidence: "荷叶边、V领、收腰", color: "深蓝", season: "春夏", thickness: "薄", pattern: "格纹", styles: ["韩系", "甜美"], scenes: ["休闲"] };
  const result = inspiration.matchWardrobe([slot], [{
    id: "casual-tee", name: "蓝色上衣", category: "上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", styles: ["休闲"], scenes: ["休闲"]
  }]);
  assert.equal(result.matches[0].candidates.length, 1);
  assert.equal(result.matches[0].candidates[0].matchLevel, "coordinated_alternative");
  assert.match(result.matches[0].candidates[0].suggestion, /不能完整还原韩系、甜美风格/);
  assert.match(result.matches[0].advice, /没有找到高度还原/);
  assert.equal(result.matches[0].missing, false);
});

test("标签缺失的同品类衣物仍可作为诚实替代但不跨品类硬凑", () => {
  const slot = { slot: "bottom", category: "裤子", name: "酷飒长裤", season: "多季", thickness: "适中", styles: ["酷飒"] };
  const result = inspiration.matchWardrobe([slot], [
    { id: "sparse-pants", name: "黑色长裤", category: "裤子", color: "黑色", styles: [] },
    { id: "wrong-category", name: "黑色半身裙", category: "半身裙", color: "黑色", styles: ["酷飒"] }
  ]);
  assert.deepEqual(result.matches[0].candidates.map((entry) => entry.item.id), ["sparse-pants"]);
  assert.equal(result.matches[0].candidates[0].matchLabel, "协调替代");
  const missing = inspiration.matchWardrobe([slot], [{ id: "only-skirt", category: "半身裙" }]);
  assert.equal(missing.matches[0].missing, true);
  assert.match(missing.matches[0].advice, /不会拿其他品类硬凑/);
});

test("韩系花边格纹上衣拒绝只命中简约的中性条纹衬衫", () => {
  const slot = { slot: "top", category: "上衣", name: "格纹短袖上衣", evidence: "V领", color: "深蓝", season: "春夏", thickness: "薄", pattern: "格纹", designDetails: ["荷叶边", "收腰"], styles: ["韩系", "清新", "简约"], scenes: ["通勤"] };
  const items = [
    { id: "neutral-shirt", name: "条纹长袖衬衫", category: "上衣", color: "白色", season: "春夏", thickness: "薄", pattern: "条纹", styles: ["简约", "通勤"], scenes: ["通勤"] },
    { id: "korean-plain", name: "韩系短袖上衣", category: "上衣", color: "深蓝", season: "春夏", thickness: "薄", pattern: "格纹", styles: ["韩系", "简约"], scenes: ["通勤"] },
    { id: "korean-ruffle", name: "格纹短袖上衣", category: "上衣", color: "深蓝", season: "春夏", thickness: "薄", pattern: "格纹", designDetails: ["木耳边"], styles: ["韩系", "甜美"], scenes: ["通勤"] }
  ];
  const result = inspiration.matchWardrobe([slot], items);
  assert.deepEqual(result.matches[0].candidates.map((entry) => entry.item.id), ["korean-ruffle"]);
  assert.doesNotMatch(result.matches[0].candidates[0].suggestion, /中性色易搭配|互补色/);
});

test("结构化设计细节优先匹配同组细节，旧衣物仍回退名称", () => {
  const slot = { slot: "top", category: "上衣", name: "蓝色上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", designDetails: ["花边"], styles: ["韩系"], scenes: [] };
  const result = inspiration.matchWardrobe([slot], [
    { id: "confirmed-other", name: "荷叶边上衣", category: "上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", designDetails: ["泡泡袖"], styles: ["韩系"], scenes: [] },
    { id: "confirmed-same", name: "蓝色上衣", category: "上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", design_details: ["木耳边"], styles: ["韩系"], scenes: [] },
    { id: "legacy-name", name: "蓝色荷叶边上衣", category: "上衣", color: "蓝色", season: "春夏", thickness: "薄", pattern: "纯色", styles: ["韩系"], scenes: [] }
  ]);
  assert.deepEqual(result.matches[0].candidates.map((entry) => entry.item.id), ["confirmed-same", "legacy-name"]);
});

test("灵感重匹配保留指定衣物并排除当前不满意衣物", () => {
  const slot = { slot: "top", category: "上衣", name: "通勤上衣", color: "白色", season: "多季", thickness: "适中", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] };
  const items = [
    { id: "white", name: "白色衬衫", category: "上衣", color: "白色", season: "多季", thickness: "适中", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] },
    { id: "pink", name: "粉色衬衫", category: "上衣", color: "粉色", season: "多季", thickness: "适中", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] }
  ];
  const replaced = inspiration.matchWardrobe([slot], items, { excludedItemIds: ["white"], preferredColors: ["粉色"] });
  assert.equal(replaced.matches[0].candidates[0].item.id, "pink");
  const locked = inspiration.matchWardrobe([slot], items, { lockedItemIds: ["pink"] });
  assert.equal(locked.matches[0].candidates[0].item.id, "pink");
  assert.equal(locked.matches[0].matchMode, "locked");
  const changedCategory = inspiration.matchWardrobe([slot], [
    ...items,
    { id: "pants", name: "粉色长裤", category: "裤子", color: "粉色", season: "多季", thickness: "适中", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] }
  ], { excludedCategories: ["上衣"], preferredCategories: ["裤子"] });
  assert.equal(changedCategory.matches[0].candidates[0].item.id, "pants");
  const excludedWithoutReplacement = inspiration.matchWardrobe([slot], items, { excludedCategories: ["上衣"] });
  assert.equal(excludedWithoutReplacement.matches[0].matchMode, "excluded");
  assert.equal(excludedWithoutReplacement.matches[0].missing, true);
});

test("灵感确认页展示季节厚薄设计细节受控风格与匹配建议", () => {
  const js = require("node:fs").readFileSync(new URL("../miniprogram/pages/inspiration/index.js", import.meta.url), "utf8");
  const wxml = require("node:fs").readFileSync(new URL("../miniprogram/pages/inspiration/index.wxml", import.meta.url), "utf8");
  assert.match(js, /season: slot\.season/);
  assert.match(js, /thickness: slot\.thickness/);
  assert.match(js, /designDetails: splitTags\(slot\.designDetailsText, 6\)/);
  assert.match(wxml, />季节</);
  assert.match(wxml, />厚薄</);
  assert.match(wxml, />设计细节</);
  assert.match(wxml, /group\.advice/);
  assert.match(wxml, /group\.selected\.matchLabel/);
  assert.match(wxml, /group\.selected\.reasonsText/);
});

test("衣物录入详情和两个 Schema 贯通可选设计细节字段", () => {
  const fs = require("node:fs");
  const addJs = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.js", import.meta.url), "utf8");
  const addWxml = fs.readFileSync(new URL("../miniprogram/pages/add-item/index.wxml", import.meta.url), "utf8");
  const detailJs = fs.readFileSync(new URL("../miniprogram/pages/item-detail/index.js", import.meta.url), "utf8");
  const cloudServices = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js", import.meta.url), "utf8");
  const clothingSchema = JSON.parse(fs.readFileSync(new URL("../uniCloud-aliyun/database/wr_clothing_items.schema.json", import.meta.url), "utf8"));
  const candidateSchema = JSON.parse(fs.readFileSync(new URL("../uniCloud-aliyun/database/wr_candidates.schema.json", import.meta.url), "utf8"));
  assert.match(addJs, /designDetails: listFromText\(form\.designDetailsText, 6\)/);
  assert.match(addWxml, /data-field="designDetailsText"/);
  assert.match(detailJs, /designDetails: listFromText\(form\.designDetailsText, 6\)/);
  assert.match(cloudServices, /design_details只能从荷叶边/);
  assert.equal(clothingSchema.properties.design_details.arrayType, "string");
  assert.equal(candidateSchema.properties.design_details.arrayType, "string");
  assert.equal(clothingSchema.required.includes("design_details"), false);
  assert.equal(candidateSchema.required.includes("design_details"), false);
});

test("整套衣物完整度区分完整、局部遮挡和需要单件补拍", () => {
  assert.equal(cloudTest.outfitCompleteness({
    category: "裤子", structureFacts: { riseAndWaistband: "高腰腰头" },
    occlusions: [], segmentationStatus: "ready", processingStatus: "cropped"
  }).completenessStatus, "ready");
  assert.equal(cloudTest.outfitCompleteness({
    category: "裤子", structureFacts: { riseAndWaistband: "" },
    occlusions: [{ type: "上衣遮挡裤腰" }], segmentationStatus: "ready", processingStatus: "cropped"
  }).completenessStatus, "partial_visible");
  assert.equal(cloudTest.outfitCompleteness({
    category: "裤子", structureFacts: {}, occlusions: [],
    segmentationStatus: "failed", processingStatus: "failed", processingError: "轮廓不清"
  }).completenessStatus, "needs_single_item_photo");
});

test("局部可见衣物只按真实可见像素验收", () => {
  const verdict = {
    sameGarment: true, colorMatch: true, patternMatch: true,
    noPersonResidue: true, clearTransparentContour: true,
    visibleStructurePreserved: true, shapeMatch: false,
    fixedDetailsMatch: false, fidelityScore: 95
  };
  assert.equal(cloudTest.sourceMaskAccepted(verdict, { category: "裤子" }, 100, true), true);
  assert.equal(cloudTest.sourceMaskAccepted(verdict, { category: "裤子" }, 100, false), false);
});

test("百炼原像素抠图不因隐藏结构或综合分数被二次判退", () => {
  const verdict = {
    sameGarment: true, colorMatch: true, patternMatch: true,
    noPersonResidue: true, clearTransparentContour: true,
    visibleStructurePreserved: true, shapeMatch: false,
    fixedDetailsMatch: false, waistbandMatch: false, fidelityScore: 85
  };
  const parsed = {
    category: "裤子", segmentationProvider: "aliyun_aitryon_parsing",
    segmentationStatus: "ready", completenessStatus: "ready", cutoutKey: "parsed.png"
  };
  assert.equal(cloudTest.sourceMaskAccepted(verdict, parsed, 100, false), true);
  assert.equal(cloudTest.usesParsedSourceDisplay(parsed), true);
  assert.equal(cloudModule.requiresOutfitImageEdit(parsed), false);
});

test("生产图片分割请求一次同时提取上衣和下装", () => {
  assert.equal(cloudTest.outfitParsingType({ slot: "top" }), "upper");
  assert.equal(cloudTest.outfitParsingType({ slot: "bottom" }), "lower");
  assert.deepEqual(cloudTest.buildOutfitParsingRequestBody("https://images.test/person.jpg", ["upper", "lower"]), {
    model: "aitryon-parsing-v1",
    input: { image_url: "https://images.test/person.jpg" },
    parameters: { clothes_type: ["upper", "lower"] }
  });
});
const garmentMask = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/garment-mask.js");
const garmentMaskTest = garmentMask._test;

test("衣橱展示画布保持原像素并将衣物居中放入正方形透明画布", () => {
  const width = 8;
  const height = 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = 255;
    rgba[index * 4 + 1] = 255;
    rgba[index * 4 + 2] = 255;
  }
  for (let y = 1; y <= 2; y += 1) for (let x = 2; x <= 5; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 80 + x;
    rgba[offset + 1] = 120 + y;
    rgba[offset + 2] = 160;
    rgba[offset + 3] = 255;
  }
  const result = garmentMask.buildWardrobeDisplayCanvas(garmentMaskTest.encodePng(width, height, rgba));
  assert.equal(result.width, result.height);
  assert.equal(result.displayMode, "square_centered_source_pixels");
  assert.equal(result.visiblePixelPreservationScore, 100);
  const output = garmentMaskTest.decodePng(result.buffer);
  const visible = [];
  for (let index = 0; index < output.width * output.height; index += 1) {
    if (output.data[index * 4 + 3] >= 16) visible.push([output.data[index * 4], output.data[index * 4 + 1], output.data[index * 4 + 2], output.data[index * 4 + 3]]);
  }
  assert.equal(visible.length, 8);
  assert.deepEqual(visible[0], [82, 121, 160, 255]);
  assert.deepEqual(visible.at(-1), [85, 122, 160, 255]);
  for (let index = 0; index < output.width * output.height; index += 1) {
    const offset = index * 4;
    if (output.data[offset + 3] === 0) assert.deepEqual([...output.data.subarray(offset, offset + 4)], [0, 0, 0, 0]);
  }
});

test("主体贴边但透明面积正常时可通过补透明留白恢复质量检查", () => {
  const width = 20;
  const height = 20;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 2; y < height; y += 1) for (let x = 5; x <= 14; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 90;
    rgba[offset + 1] = 110;
    rgba[offset + 2] = 130;
    rgba[offset + 3] = 255;
  }
  const touching = garmentMaskTest.encodePng(width, height, rgba);
  const before = cloudTest.assessMattingQuality(touching);
  assert.equal(before.accepted, false);
  assert.ok(before.transparentRatio >= 0.08 && before.transparentRatio <= 0.95);
  assert.ok(before.transparentBorderRatio < 0.98);
  const reframed = garmentMask.buildWardrobeDisplayCanvas(touching);
  assert.equal(reframed.visiblePixelPreservationScore, 100);
  assert.equal(cloudTest.assessMattingQuality(reframed.buffer).accepted, true);
  const recovered = cloudTest.recoverBorderTouchingMatting(touching, before);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.quality.accepted, true);
});

test("裤脚下存在明显孤立背景块时不得通过补透明留白", () => {
  const width = 24;
  const height = 24;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 2; y < height; y += 1) for (let x = 6; x <= 17; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 90;
    rgba[offset + 1] = 110;
    rgba[offset + 2] = 130;
    rgba[offset + 3] = 255;
  }
  for (let y = 18; y <= 21; y += 1) for (let x = 19; x <= 22; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 190;
    rgba[offset + 1] = 185;
    rgba[offset + 2] = 175;
    rgba[offset + 3] = 255;
  }
  const contaminated = garmentMaskTest.encodePng(width, height, rgba);
  const quality = cloudTest.assessMattingQuality(contaminated);
  assert.equal(quality.accepted, false);
  assert.ok(quality.secondaryForegroundRatio > 0.01);
  assert.equal(cloudTest.recoverBorderTouchingMatting(contaminated, quality).recovered, false);
  const reframed = garmentMask.buildWardrobeDisplayCanvas(contaminated);
  assert.equal(cloudTest.assessMattingQuality(reframed.buffer).accepted, false);
});

test("人工预览模式只拦截无透明背景或主体几乎消失的严重结果", () => {
  const build = (width, height, visible) => {
    const rgba = Buffer.alloc(width * height * 4);
    for (const [x, y] of visible) rgba[(y * width + x) * 4 + 3] = 255;
    return garmentMaskTest.encodePng(width, height, rgba);
  };
  const reviewable = [];
  for (let y = 2; y < 18; y += 1) for (let x = 4; x < 16; x += 1) reviewable.push([x, y]);
  assert.equal(pngAlpha.assessBasicMattingQuality(build(20, 20, reviewable)).accepted, true);
  const almostOpaque = [];
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) if (!(x === 0 && y === 0)) almostOpaque.push([x, y]);
  assert.equal(pngAlpha.assessBasicMattingQuality(build(20, 20, almostOpaque)).accepted, false);
  assert.equal(pngAlpha.assessBasicMattingQuality(build(20, 20, [[10, 10]])).accepted, false);
});

test("腾讯抠图 PNG 通过前置解码后不再交给规则不同的解析器", () => {
  const width = 20;
  const height = 20;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 2; y < height; y += 1) for (let x = 5; x <= 14; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 90;
    rgba[offset + 1] = 110;
    rgba[offset + 2] = 130;
    rgba[offset + 3] = 255;
  }
  const encoded = garmentMaskTest.encodePng(width, height, rgba);
  const providerPng = encoded.subarray(0, encoded.length - 12);
  const checked = cloudTest.assessMattingQuality(providerPng);
  assert.equal(checked.accepted, false);
  assert.ok(checked.transparentRatio >= 0.08 && checked.transparentRatio <= 0.95);
  assert.throws(() => garmentMask.buildWardrobeDisplayCanvas(providerPng), { code: "GARMENT_MASK_INVALID" });
  const reframed = garmentMask.buildWardrobeDisplayCanvas(providerPng, 0.12, { useValidatedRgbaDecoder: true });
  assert.equal(reframed.visiblePixelPreservationScore, 100);
  assert.equal(cloudTest.assessMattingQuality(reframed.buffer).accepted, true);
});

test("矩形人物裁剪不得伪装成清晰衣物轮廓", () => {
  const rectangular = Buffer.alloc(20 * 20 * 4, 170);
  for (let index = 3; index < rectangular.length; index += 4) rectangular[index] = 255;
  const rejected = garmentMask.assessGarmentContourQuality(garmentMaskTest.encodePng(20, 20, rectangular));
  assert.equal(rejected.accepted, false);
  assert.match(rejected.failureReason, /矩形人物裁剪/);

  const garment = Buffer.alloc(20 * 20 * 4);
  for (let y = 4; y <= 16; y += 1) for (let x = 6; x <= 13; x += 1) garment[(y * 20 + x) * 4 + 3] = 255;
  for (let y = 6; y <= 10; y += 1) for (let x = 3; x <= 16; x += 1) garment[(y * 20 + x) * 4 + 3] = 255;
  const accepted = garmentMask.assessGarmentContourQuality(garmentMaskTest.encodePng(20, 20, garment));
  assert.equal(accepted.accepted, true);
});

test("人物服饰类别按单层、组合上装和裤装映射", () => {
  assert.deepEqual(cloudTest.clothingClassesForDetection({ category: "上衣", isComposite: false }), ["tops"]);
  assert.deepEqual(cloudTest.clothingClassesForDetection({ category: "上衣", isComposite: true }), ["tops", "coat"]);
  assert.deepEqual(cloudTest.clothingClassesForDetection({ category: "裤子" }), ["pants"]);
  assert.deepEqual(cloudTest.clothingClassesForDetection({ category: "连衣裙" }), ["tops", "skirt"]);
});

test("SegmentCloth 类别地址兼容直接 Map 和 SDK key 包装格式", () => {
  const topsUrl = "https://example.com/tops.png?token=a";
  const pantsUrl = "https://example.com/pants.png?token=b";
  assert.deepEqual(cloudTest.normalizeSegmentClothClassUrls({ tops: topsUrl, pants: pantsUrl }), { tops: topsUrl, pants: pantsUrl });
  assert.deepEqual(
    cloudTest.normalizeSegmentClothClassUrls({ key: `{'tops':${topsUrl},'pants':${pantsUrl}}` }),
    { tops: topsUrl, pants: pantsUrl }
  );
});

test("VIAPI 临时 OSS 上传使用真实主机、Content-Length 和完整 multipart 表单", async () => {
  const https = require("node:https");
  const originalRequest = https.request;
  let capturedOptions;
  let capturedBody;
  https.request = (options, callback) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.end = (body) => {
      capturedBody = Buffer.from(body);
      const response = new EventEmitter();
      response.statusCode = 201;
      callback(response);
      queueMicrotask(() => response.emit("end"));
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };
  try {
    await cloudTest.postAuthorizedOssObject("temporary-bucket", {
      host: "temporary-bucket.oss-cn-shanghai.aliyuncs.com",
      OSSAccessKeyId: "temporary-id",
      policy: "encoded-policy",
      Signature: "temporary-signature",
      key: "inputs/test.jpg",
      success_action_status: "201",
      file: { filename: "inputs/test.jpg", contentType: "image/jpeg", content: Readable.from(Buffer.from("image-bytes")) }
    });
  } finally {
    https.request = originalRequest;
  }
  assert.equal(capturedOptions.hostname, "temporary-bucket.oss-cn-shanghai.aliyuncs.com");
  assert.equal(capturedOptions.headers["Content-Length"], capturedBody.length);
  const multipart = capturedBody.toString("utf8");
  assert.match(multipart, /name="OSSAccessKeyId"\r\n\r\ntemporary-id/);
  assert.match(multipart, /name="Signature"\r\n\r\ntemporary-signature/);
  assert.match(multipart, /filename="inputs\/test.jpg"/);
  assert.match(multipart, /image-bytes/);
  assert.doesNotMatch(multipart, /name="host"/);
});

test("VIAPI RPC v2 使用固定排序与查询签名，不依赖 x-acs 请求头", async () => {
  const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const previousSecurityToken = process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
  const previousDedicatedId = process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  const previousDedicatedSecret = process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "testid";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "testsecret";
  delete process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
  try {
    assert.equal(cloudTest.viapiPercentEncode("a b!*'()"), "a%20b%21%2A%27%28%29");
    assert.deepEqual(cloudTest.flattenViapiQuery({ ClothClass: ["tops", "coat"], OutMode: 1, Empty: null }), {
      "ClothClass.1": "tops",
      "ClothClass.2": "coat",
      OutMode: "1"
    });
    const requestInfo = cloudTest.buildViapiRpcV2Request("SegmentCloth", {
      ImageURL: "https://example.test/a b.jpg",
      "ClothClass.1": "tops"
    }, { timestamp: "2026-08-07T00:00:00Z", nonce: "fixed" });
    assert.equal(requestInfo.signature, "TwIkhe3Ya8wFfTwx9T9UecsKEso=");
    assert.match(requestInfo.path, /Action=SegmentCloth/);
    assert.match(requestInfo.path, /AccessKeyId=testid/);
    assert.match(requestInfo.path, /SignatureMethod=HMAC-SHA1/);
    assert.match(requestInfo.path, /Signature=TwIkhe3Ya8wFfTwx9T9UecsKEso%3D/);
    process.env.ALIBABA_CLOUD_SECURITY_TOKEN = "test-security-token";
    const authorizationInfo = cloudTest.buildViapiRpcV2Request("AuthorizeFileUpload", {
      Product: "imageseg",
      RegionId: "cn-shanghai"
    }, {
      hostname: "openplatform.aliyuncs.com",
      method: "GET",
      version: "2019-12-19",
      timestamp: "2026-08-07T00:00:00Z",
      nonce: "fixed"
    });
    assert.equal(authorizationInfo.hostname, "openplatform.aliyuncs.com");
    assert.equal(authorizationInfo.method, "GET");
    assert.match(authorizationInfo.path, /Action=AuthorizeFileUpload/);
    assert.match(authorizationInfo.path, /Version=2019-12-19/);
    assert.match(authorizationInfo.path, /SecurityToken=test-security-token/);
    assert.match(authorizationInfo.stringToSign, /^GET&%2F&/);
    process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = "dedicated-id";
    process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = "dedicated-secret";
    const dedicatedInfo = cloudTest.buildViapiRpcV2Request("SegmentCloth", { ImageURL: "https://example.test/a.jpg" }, {
      timestamp: "2026-08-07T00:00:00Z",
      nonce: "dedicated"
    });
    assert.match(dedicatedInfo.path, /AccessKeyId=dedicated-id/);
    assert.doesNotMatch(dedicatedInfo.path, /SecurityToken=/);
    delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
    delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
    delete process.env.ALIBABA_CLOUD_SECURITY_TOKEN;

    const https = require("node:https");
    const originalRequest = https.request;
    let capturedOptions;
    https.request = (options, callback) => {
      capturedOptions = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        queueMicrotask(() => {
          response.emit("data", Buffer.from('{"RequestId":"provider-test","Data":{}}'));
          response.emit("end");
        });
      };
      request.destroy = (error) => request.emit("error", error);
      return request;
    };
    try {
      const response = await cloudTest.viapiRpcV2Request("SegmentCloth", { "ClothClass.1": "tops", ImageURL: "https://example.test/a.jpg" }, { timestamp: "2026-08-07T00:00:00Z", nonce: "fixed", stage: "服饰类别分割" });
      assert.equal(response.body.RequestId, "provider-test");
    } finally {
      https.request = originalRequest;
    }
    assert.equal(capturedOptions.hostname, "imageseg.cn-shanghai.aliyuncs.com");
    assert.equal(capturedOptions.headers["Content-Length"], 0);
    assert.ok(!Object.keys(capturedOptions.headers).some((name) => name.toLowerCase().startsWith("x-acs-")));
  } finally {
    if (previousId === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousId;
    if (previousSecret === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousSecret;
    if (previousSecurityToken === undefined) delete process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
    else process.env.ALIBABA_CLOUD_SECURITY_TOKEN = previousSecurityToken;
    if (previousDedicatedId === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = previousDedicatedId;
    if (previousDedicatedSecret === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = previousDedicatedSecret;
  }
});

test("VIAPI RPC v2 Advance 全链路不再调用 SDK ACS3 文件授权", async () => {
  const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const previousSecurityToken = process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
  const previousDedicatedId = process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  const previousDedicatedSecret = process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "testid";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "testsecret";
  process.env.ALIBABA_CLOUD_SECURITY_TOKEN = "test-security-token";
  const https = require("node:https");
  const originalRequest = https.request;
  const calls = [];
  const responses = [
    {
      status: 200,
      body: JSON.stringify({
        RequestId: "authorize-request",
        Bucket: "temporary-bucket",
        Endpoint: "oss-cn-shanghai.aliyuncs.com",
        ObjectKey: "inputs/test.jpg",
        AccessKeyId: "temporary-id",
        EncodedPolicy: "temporary-policy",
        Signature: "temporary-signature"
      })
    },
    { status: 201, body: "" },
    { status: 200, body: '{"RequestId":"segment-request","Data":{"Elements":[{"ImageURL":"https://example.test/mask.png"}]}}' }
  ];
  https.request = (options, callback) => {
    const current = responses.shift();
    calls.push(options);
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = current.status;
      callback(response);
      queueMicrotask(() => {
        if (current.body) response.emit("data", Buffer.from(current.body));
        response.emit("end");
      });
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };
  try {
    const ImagesegClient = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/node_modules/@alicloud/imageseg20191230");
    const client = cloudTest.getGarmentSegmentationDiagnosticClient();
    await client.segmentClothAdvance(new ImagesegClient.SegmentClothAdvanceRequest({
      imageURLObject: Readable.from(Buffer.from("image-bytes")),
      clothClass: ["tops"],
      outMode: 1,
      returnForm: "mask"
    }), { autoretry: false });
    assert.deepEqual(calls.map((item) => [item.hostname, item.method]), [
      ["openplatform.aliyuncs.com", "GET"],
      ["temporary-bucket.oss-cn-shanghai.aliyuncs.com", "POST"],
      ["imageseg.cn-shanghai.aliyuncs.com", "POST"]
    ]);
    assert.ok(calls.filter((item) => item.hostname !== "temporary-bucket.oss-cn-shanghai.aliyuncs.com")
      .every((item) => !Object.keys(item.headers).some((name) => name.toLowerCase().startsWith("x-acs-"))));
    assert.match(calls[2].path, /ImageURL=http%3A%2F%2Ftemporary-bucket\.oss-cn-shanghai\.aliyuncs\.com%2Finputs%2Ftest\.jpg/);
    assert.match(calls[0].path, /SecurityToken=test-security-token/);
    assert.match(calls[2].path, /SecurityToken=test-security-token/);
  } finally {
    https.request = originalRequest;
    if (previousId === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousId;
    if (previousSecret === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousSecret;
    if (previousSecurityToken === undefined) delete process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
    else process.env.ALIBABA_CLOUD_SECURITY_TOKEN = previousSecurityToken;
    if (previousDedicatedId === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = previousDedicatedId;
    if (previousDedicatedSecret === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = previousDedicatedSecret;
  }
});

test("VIAPI RPC v2 将供应商失败映射为可定位的中文阶段", async () => {
  const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const previousDedicatedId = process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  const previousDedicatedSecret = process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "testid";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "testsecret";
  const https = require("node:https");
  const originalRequest = https.request;
  const responses = [
    { status: 403, body: '{"Code":"Forbidden","RequestId":"request-403"}' },
    { status: 429, body: '{"Code":"Throttling","RequestId":"request-429"}' },
    { status: 500, body: '{"Code":"InternalError","RequestId":"request-500"}' },
    { status: 200, body: "not-json" }
  ];
  https.request = (_options, callback) => {
    const current = responses.shift();
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = current.status;
      callback(response);
      queueMicrotask(() => { response.emit("data", Buffer.from(current.body)); response.emit("end"); });
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };
  try {
    for (const [code, status, requestId] of [["Forbidden", 403, "request-403"], ["Throttling", 429, "request-429"], ["InternalError", 500, "request-500"]]) {
      await assert.rejects(
        cloudTest.viapiRpcV2Request("SegmentCloth", { ImageURL: "https://example.test/a.jpg" }, { stage: "服饰类别分割" }),
        (error) => error.code === code && error.providerStatus === status && error.providerRequestId === requestId && error.segmentationStage === "服饰类别分割"
      );
    }
    await assert.rejects(
      cloudTest.viapiRpcV2Request("SegmentCloth", { ImageURL: "https://example.test/a.jpg" }, { stage: "服饰类别分割" }),
      (error) => error.code === "VIAPI_INVALID_JSON" && error.segmentationStage === "服饰类别分割"
    );
  } finally {
    https.request = originalRequest;
    if (previousId === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousId;
    if (previousSecret === undefined) delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    else process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousSecret;
    if (previousDedicatedId === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = previousDedicatedId;
    if (previousDedicatedSecret === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
    else process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = previousDedicatedSecret;
  }
});

test("原像素蒙版裁剪保留全部可见像素并只修补低纹理小孔洞", () => {
  const width = 20;
  const height = 20;
  const rgba = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = 210; rgba[offset + 1] = 205; rgba[offset + 2] = 195; rgba[offset + 3] = 255;
      const foreground = x >= 4 && x <= 15 && y >= 4 && y <= 15 && !(x === 9 && y === 9);
      const value = foreground ? 255 : 0;
      mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
    }
  }
  const result = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "纯色圆领上衣", structureFacts: {} }
  );
  assert.equal(result.visiblePixelPreservationScore, 100);
  assert.equal(result.repairedPixelCount, 1);
  assert.equal(result.unsafeReason, "");
  const output = garmentMaskTest.decodePng(result.buffer);
  assert.ok(output.data.some((value, index) => index % 4 === 3 && value === 255));
});

test("中等纹理小孔洞只生成修补蒙版，候选覆盖后原始可见像素仍为100%", () => {
  const width = 32;
  const height = 32;
  const rgba = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const stripe = x % 2 === 0 ? 70 : 170;
      rgba[offset] = stripe; rgba[offset + 1] = 110; rgba[offset + 2] = 145; rgba[offset + 3] = 255;
      const foreground = x >= 5 && x <= 26 && y >= 5 && y <= 26 && !(x === 15 && y === 16);
      const value = foreground ? 255 : 0;
      mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
    }
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "条纹长袖上衣", structureFacts: { sleeveLength: "wrist_long" } }
  );
  assert.equal(cutout.repairMode, "image_edit_small_internal_hole");
  assert.ok(cutout.repairMaskBuffer);
  assert.equal(cutout.visiblePixelPreservationScore, 100);

  const candidate = garmentMaskTest.decodePng(cutout.buffer);
  for (let index = 0; index < candidate.width * candidate.height; index += 1) {
    const offset = index * 4;
    candidate.data[offset] = 240;
    candidate.data[offset + 1] = 30;
    candidate.data[offset + 2] = 30;
    candidate.data[offset + 3] = 255;
  }
  const repaired = garmentMask.applyRepairCandidate(
    cutout.buffer,
    garmentMaskTest.encodePng(candidate.width, candidate.height, candidate.data),
    cutout.repairMaskBuffer
  );
  assert.equal(repaired.visiblePixelPreservationScore, 100);
  assert.ok(repaired.repairedPixelCount > 0);
});

test("明确字幕遮挡可修补裤腿但不得填充两腿之间的自然空隙", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = 25; rgba[offset + 1] = 25; rgba[offset + 2] = 28; rgba[offset + 3] = 255;
      const onLeg = (x >= 8 && x <= 17) || (x >= 22 && x <= 31);
      const subtitleGap = y === 20;
      const value = onLeg && y >= 5 && y <= 34 && !subtitleGap ? 255 : 0;
      mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
    }
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "裤子", structure: "纯色直筒裤", structureFacts: {}, occlusions: [{ type: "字幕", bbox: [0, 475, 999, 550] }] }
  );
  assert.equal(cutout.unsafeReason, "");
  assert.ok(cutout.repairedPixelCount > 0 || cutout.generatedPixelCount > 0);
  const output = garmentMaskTest.decodePng(cutout.buffer);
  const centerColumn = Math.floor(output.width / 2);
  const centerPixels = [];
  for (let y = 0; y < output.height; y += 1) centerPixels.push(output.data[(y * output.width + centerColumn) * 4 + 3]);
  assert.ok(centerPixels.some((alpha) => alpha === 0));
});

test("裤脚像素偶然闭合时仍不得把纵向裤腿间隙当作内部破洞", () => {
  const width = 50;
  const height = 60;
  const rgba = Buffer.alloc(width * height * 4, 80);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const insidePants = x >= 10 && x <= 39 && y >= 5 && y <= 54;
    const legGap = x >= 23 && x <= 26 && y >= 18 && y <= 49;
    const value = insidePants && !legGap ? 255 : 0;
    mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "裤子", structure: "阔腿长裤", structureFacts: { legShape: "阔腿" }, occlusions: [] }
  );
  assert.equal(cutout.unsafeReason, "");
  assert.equal(cutout.generatedPixelCount, 0);
  assert.equal(cutout.repairedPixelCount, 0);
});

test("没有明确遮挡框时外部连通缺口不得交给AI猜测", () => {
  const width = 30;
  const height = 30;
  const rgba = Buffer.alloc(width * height * 4, 160);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const visible = x >= 5 && x <= 24 && y >= 5 && y <= 24 && !(x >= 13 && x <= 16 && y <= 15);
    const value = visible ? 255 : 0;
    mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "纯色上衣", structureFacts: {}, occlusions: [] }
  );
  assert.equal(cutout.generatedPixelCount, 0);
  assert.equal(cutout.repairedPixelCount, 0);
});

test("皮肤遮挡蒙版先移除手部像素再生成局部修补区", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);
  const garment = Buffer.alloc(width * height * 4);
  const skin = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const hand = x >= 17 && x <= 22 && y >= 18 && y <= 21;
    rgba[offset] = hand ? 220 : 70; rgba[offset + 1] = hand ? 160 : 105; rgba[offset + 2] = hand ? 130 : 145; rgba[offset + 3] = 255;
    const clothingValue = x >= 7 && x <= 32 && y >= 5 && y <= 34 ? 255 : 0;
    garment[offset] = clothingValue; garment[offset + 1] = clothingValue; garment[offset + 2] = clothingValue; garment[offset + 3] = 255;
    const skinValue = hand ? 255 : 0;
    skin[offset] = skinValue; skin[offset + 1] = skinValue; skin[offset + 2] = skinValue; skin[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, garment)],
    [0, 0, width, height],
    { category: "裤子", structure: "浅蓝长裤", structureFacts: {}, occlusions: [{ type: "手", bbox: [400, 400, 600, 600] }] },
    [garmentMaskTest.encodePng(width, height, skin)]
  );
  assert.equal(cutout.repairMode, "image_edit_small_internal_hole");
  assert.ok(cutout.generatedPixelCount > 0);
  const output = garmentMaskTest.decodePng(cutout.buffer);
  let visibleSkinPixels = 0;
  for (let offset = 0; offset < output.data.length; offset += 4) {
    if (output.data[offset] === 220 && output.data[offset + 1] === 160 && output.data[offset + 3] >= 16) visibleSkinPixels += 1;
  }
  assert.equal(visibleSkinPixels, 0);
});

test("明确手部遮住裤腰外轮廓时只修补皮肤蒙版覆盖的小区域", () => {
  const width = 50;
  const height = 50;
  const rgba = Buffer.alloc(width * height * 4);
  const garment = Buffer.alloc(width * height * 4);
  const skin = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    const hand = x >= 21 && x <= 28 && y >= 8 && y <= 13;
    rgba[offset] = hand ? 220 : 75; rgba[offset + 1] = hand ? 160 : 115; rgba[offset + 2] = hand ? 130 : 155; rgba[offset + 3] = 255;
    const pants = x >= 10 && x <= 39 && y >= 10 && y <= 43 && !hand;
    const pantsValue = pants ? 255 : 0;
    garment[offset] = pantsValue; garment[offset + 1] = pantsValue; garment[offset + 2] = pantsValue; garment[offset + 3] = 255;
    const skinValue = hand ? 255 : 0;
    skin[offset] = skinValue; skin[offset + 1] = skinValue; skin[offset + 2] = skinValue; skin[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, garment)],
    [0, 0, width, height],
    { category: "裤子", structure: "高腰长裤", structureFacts: { riseAndWaistband: "高腰" }, occlusions: [{ type: "手", bbox: [380, 120, 620, 320] }] },
    [garmentMaskTest.encodePng(width, height, skin)]
  );
  assert.equal(cutout.repairMode, "image_edit_small_internal_hole");
  assert.ok(cutout.generatedPixelCount > 0);
  assert.equal(cutout.visiblePixelPreservationScore, 100);
});

test("两块已明确遮挡可在单块不超过10.5%时合计修补至18%", () => {
  const width = 60;
  const height = 60;
  const rgba = Buffer.alloc(width * height * 4, 90);
  const garment = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const firstOcclusion = y >= 20 && y <= 23;
    const secondOcclusion = y >= 36 && y <= 39;
    const pants = x >= 10 && x <= 49 && y >= 5 && y <= 54 && !firstOcclusion && !secondOcclusion;
    const pantsValue = pants ? 255 : 0;
    garment[offset] = pantsValue; garment[offset + 1] = pantsValue; garment[offset + 2] = pantsValue; garment[offset + 3] = 255;
  }
  const occlusions = [{ type: "字幕", bbox: [167, 333, 816, 383] }, { type: "文字", bbox: [167, 600, 816, 650] }];
  const source = garmentMaskTest.encodePng(width, height, rgba);
  const cutout = garmentMask.buildGarmentCutout(
    source,
    [garmentMaskTest.encodePng(width, height, garment)],
    [0, 0, width, height],
    { category: "裤子", structure: "高腰长裤", structureFacts: { riseAndWaistband: "高腰" }, occlusions },
    [garmentMask.buildOcclusionBoxMask(width, height, occlusions, /字幕|文字/)]
  );
  assert.equal(cutout.repairMode, "image_edit_small_internal_hole", cutout.unsafeReason);
  assert.ok(cutout.occlusionRatio > 0.12 && cutout.occlusionRatio <= 0.18);
  assert.equal(cutout.visiblePixelPreservationScore, 100);
});

test("单个精确人体遮挡的多块缺口可在单块不超过10.5%时合计修补至15%", () => {
  const width = 60;
  const height = 60;
  const rgba = Buffer.alloc(width * height * 4, 100);
  const garment = Buffer.alloc(width * height * 4);
  const hair = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const firstStrand = x >= 15 && x <= 34 && y >= 18 && y <= 24;
    const secondStrand = x >= 25 && x <= 44 && y >= 34 && y <= 40;
    const occluded = firstStrand || secondStrand;
    const clothing = x >= 10 && x <= 49 && y >= 5 && y <= 54 && !occluded;
    const clothingValue = clothing ? 255 : 0;
    garment[offset] = clothingValue; garment[offset + 1] = clothingValue; garment[offset + 2] = clothingValue; garment[offset + 3] = 255;
    const hairValue = occluded ? 255 : 0;
    hair[offset] = hairValue; hair[offset + 1] = hairValue; hair[offset + 2] = hairValue; hair[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, garment)],
    [0, 0, width, height],
    { category: "上衣", structure: "长袖上衣", structureFacts: {}, occlusions: [{ type: "头发", bbox: [200, 300, 800, 700] }] },
    [garmentMaskTest.encodePng(width, height, hair)]
  );
  assert.equal(cutout.repairMode, "image_edit_small_internal_hole", cutout.unsafeReason);
  assert.ok(cutout.occlusionRatio > 0.12 && cutout.occlusionRatio <= 0.15);
  assert.equal(cutout.visiblePixelPreservationScore, 100);
});

test("单个明确遮挡块超过10.5%时仍必须拒绝", () => {
  const width = 100;
  const height = 100;
  const rgba = Buffer.alloc(width * height * 4, 120);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const occluded = x >= 10 && x <= 89 && y >= 45 && y <= 53;
    const clothing = x >= 10 && x <= 89 && y >= 10 && y <= 89 && !occluded;
    const value = clothing ? 255 : 0;
    mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
  }
  const occlusions = [{ type: "字幕", bbox: [100, 450, 900, 540] }];
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "纯色上衣", structureFacts: {}, occlusions },
    [garmentMask.buildOcclusionBoxMask(width, height, occlusions, /字幕|文字/)]
  );
  assert.equal(cutout.repairMode, "rejected");
  assert.match(cutout.unsafeReason, /10\.5%/);
});

test("字幕和包带框可生成同尺寸粗遮挡蒙版且框外保持透明", () => {
  const buffer = garmentMask.buildOcclusionBoxMask(20, 10, [
    { type: "字幕", bbox: [200, 200, 400, 400] },
    { type: "头发", bbox: [600, 200, 800, 400] }
  ], /字幕|文字|包|包带|配饰/);
  const mask = garmentMaskTest.decodePng(buffer);
  assert.equal(mask.data[(3 * mask.width + 6) * 4 + 3], 255);
  assert.equal(mask.data[(3 * mask.width + 14) * 4 + 3], 0);
});

test("领口和下摆附近的孔洞不得交给生成模型猜测", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4, 180);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset + 3] = 255;
      const foreground = x >= 5 && x <= 34 && y >= 5 && y <= 34 && !(x === 20 && y === 7);
      const value = foreground ? 255 : 0;
      mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
    }
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "圆领长袖上衣", structureFacts: { outerNeckline: "圆领" } }
  );
  assert.match(cutout.unsafeReason, /领口|关键结构/);
  assert.equal(cutout.repairMode, "rejected");
});

test("关键结构附近不超过0.05%的分割锯齿可确定性修复", () => {
  const width = 100;
  const height = 100;
  const rgba = Buffer.alloc(width * height * 4, 180);
  const mask = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    rgba[offset + 3] = 255;
    const foreground = x >= 10 && x <= 89 && y >= 10 && y <= 89 && !(x === 50 && y === 11);
    const value = foreground ? 255 : 0;
    mask[offset] = value; mask[offset + 1] = value; mask[offset + 2] = value; mask[offset + 3] = 255;
  }
  const cutout = garmentMask.buildGarmentCutout(
    garmentMaskTest.encodePng(width, height, rgba),
    [garmentMaskTest.encodePng(width, height, mask)],
    [0, 0, width, height],
    { category: "上衣", structure: "圆领上衣", structureFacts: { outerNeckline: "圆领" } }
  );
  assert.equal(cutout.unsafeReason, "");
  assert.equal(cutout.repairMode, "deterministic_small_internal_hole");
  assert.equal(cutout.visiblePixelPreservationScore, 100);
});

test("衣橱商品展示提示词引用原图、原像素与可选遮挡蒙版并锁定固定设计", () => {
  const request = cloudTest.buildWardrobeProductRequestBody(
    "https://example.com/crop.jpg",
    "https://example.com/cutout.png",
    "https://example.com/mask.png",
    { sourceFingerprint: "b".repeat(64), slot: "top", category: "上衣", color: "米白", structure: "长袖双层系带上衣", structureFacts: { sleeveLength: "wrist_long", necklineRelation: "flush" } },
    "qwen-image-2.0-pro-2026-06-22"
  );
  assert.equal(request.input.messages[0].content.filter((item) => item.image).length, 3);
  assert.equal(request.parameters.n, 2);
  assert.equal(request.parameters.prompt_extend, false);
  assert.match(request.input.messages[0].content.at(-1).text, /完整、平整、居中的单件上衣商品展示图/);
  assert.match(request.input.messages[0].content.at(-1).text, /不得标准化成基础款/);
  assert.match(request.input.messages[0].content.at(-1).text, /袖长必须到手腕/);
  assert.equal(request.parameters.seed, cloudTest.deterministicSeed({ sourceFingerprint: "b".repeat(64), slot: "top", category: "上衣", color: "米白", structure: "长袖双层系带上衣", structureFacts: { sleeveLength: "wrist_long", necklineRelation: "flush" } }, "wardrobe-product"));
});

test("原像素蒙版使用独立准入规则，不再要求穿着图和平铺图向量相似度", () => {
  const detection = { category: "上衣", isComposite: true };
  const accepted = {
    sameGarment: true, colorMatch: true, patternMatch: true, shapeMatch: true, fixedDetailsMatch: true,
    noPersonResidue: true, clearTransparentContour: true, visibleStructurePreserved: true, layersMatch: true,
    sleeveLengthMatch: true, necklineHeightMatch: true, layerCoverageMatch: true, fidelityScore: 96
  };
  assert.equal(cloudTest.sourceMaskAccepted(accepted, detection, 100), true);
  assert.equal(cloudTest.sourceMaskAccepted({ ...accepted, noPersonResidue: false }, detection, 100), false);
  assert.equal(cloudTest.sourceMaskAccepted(accepted, detection, 99.99), false);
  assert.match(cloudTest.userFacingVerificationReason("fixedDetailsMatch、noPersonResidue"), /固定细节一致性、无人物残留/);
});

test("原像素蒙版即使总分98也必须通过透明轮廓清晰度", () => {
  const detection = { category: "上衣", isComposite: false };
  const verdict = {
    sameGarment: true, colorMatch: true, patternMatch: true, shapeMatch: true,
    fixedDetailsMatch: true, noPersonResidue: true, clearTransparentContour: false,
    visibleStructurePreserved: true, sleeveLengthMatch: true,
    necklineHeightMatch: true, layerCoverageMatch: true, fidelityScore: 98
  };
  assert.equal(cloudTest.sourceMaskAccepted(verdict, detection, 100), false);
  assert.match(cloudTest.userFacingVerificationReason("clearTransparentContour"), /透明轮廓清晰度/);
});

test("分析阶段先完成服饰分割再删除人物原图，prepare 使用原像素参照生成商品展示且不回退人物裁剪", () => {
  const apiSource = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  const cloudSource = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js", import.meta.url), "utf8");
  const analyzeRoute = apiSource.match(/const captureAnalyzeMatch[\s\S]*?const prepareDetectionMatch/)?.[0] || "";
  const prepareBody = cloudSource.match(/const prepareOutfitDetection = async \(detection\) => \{([\s\S]*?)\n\};/)?.[1] || "";
  assert.match(analyzeRoute, /segmentOutfitGarments\(capture\.source_key, analyzed\.detections/);
  assert.ok(analyzeRoute.indexOf("segmentOutfitGarments") < analyzeRoute.indexOf("deleteObject(capture.source_key)"));
  assert.match(prepareBody, /prepareWardrobeProductDisplay\(detection\)/);
  assert.doesNotMatch(prepareBody, /selectedImageKey: detection\.cropKey/);
  assert.match(apiSource, /visiblePixelPreservationScore/);
  assert.match(apiSource, /segmentationStatus/);
  assert.match(cloudSource, /\["ready", "repair_pending"\][\s\S]*?prepareWardrobeProductDisplay\(detection\)/);
  assert.match(cloudSource, /segmentCommodity/);
  assert.match(cloudSource, /for \(const clothClass of classes\)/);
  assert.match(cloudSource, /SegmentClothAdvanceRequest/);
  assert.match(cloudSource, /segmentCommodityAdvance/);
  assert.doesNotMatch(cloudSource, /SegmentClothRequest\(\{\s*imageURL: source\.url/);
  assert.match(cloudSource, /clothClass: \[clothClass\]/);
  assert.match(cloudSource, /buildGarmentCutout\(\s*source\.buffer,/);
  assert.match(apiSource, /item\.repairMaskKey/);
});

test("同图同阶段使用固定 seed，纠错轮使用不同 seed", () => {
  const detection = { sourceFingerprint: "a".repeat(64), slot: "top", category: "上衣" };
  assert.equal(cloudTest.deterministicSeed(detection, "initial"), cloudTest.deterministicSeed(detection, "initial"));
  assert.notEqual(cloudTest.deterministicSeed(detection, "initial"), cloudTest.deterministicSeed(detection, "correction"));
  const body = cloudTest.buildFlatLayRequestBody("https://example.com/source.jpg", detection, "qwen-image-2.0-pro-2026-06-22");
  assert.equal(body.parameters.seed, cloudTest.deterministicSeed(detection, "initial"));
  assert.equal(body.parameters.prompt_extend, false);
});

test("只有限流和明确推理内部错误允许自动重试", () => {
  assert.equal(cloudTest.retryableFlatLayError({ providerStatusCode: 429 }), true);
  assert.equal(cloudTest.retryableFlatLayError({ code: "InternalError.Algo" }), true);
  assert.equal(cloudTest.retryableFlatLayError({ code: "IMAGE_EDIT_TIMEOUT", status: 504 }), false);
  assert.equal(cloudTest.retryableFlatLayError({ providerStatusCode: 401 }), false);
});

test("结构事实规范组合上装和复杂裤装", () => {
  const detections = cloudTest.normalizeOutfitDetections({ detections: [{
    slot: "top", category: "上衣", color: "米白", pattern: "纯色", styles: ["系带"], structure: "长袖固定双层上装",
    structure_facts: { layer_mode: "fixed_combined", sleeve_length: "wrist_long", neckline_relation: "flush", closure_and_ties: "胸前系带" },
    is_composite: true, bbox_2d: [1, 2, 300, 400], confidence: 0.9
  }, {
    slot: "bottom", category: "裤子", color: "浅蓝", pattern: "纯色", styles: ["水洗"], structure: "高腰牛仔裤有双前袋与前中缝",
    structure_facts: { rise_and_waistband: "高腰宽腰头", pocket_layout: "左右双前袋", front_seam: "连续前中缝", leg_shape: "阔腿" },
    is_composite: false, bbox_2d: [1, 400, 300, 900], confidence: 0.9
  }] });
  assert.equal(detections[0].structureFacts.layerMode, "fixed_combined");
  assert.equal(detections[0].structureFacts.sleeveLength, "wrist_long");
  assert.equal(detections[0].structureFacts.necklineRelation, "flush");
  assert.equal(detections[1].structureFacts.pocketLayout, "左右双前袋");
  assert.equal(cloudTest.usesFaithfulPresentation(detections[1]), true);
});

test("英文颜色图案统一为中文并驱动浅色背景", () => {
  const [top, bottom] = cloudTest.normalizeOutfitDetections({ detections: [{
    slot: "top", category: "上衣", color: "white", pattern: "solid", styles: ["基础款"], structure: "普通白色长袖上衣",
    structure_facts: { layer_mode: "single", sleeve_length: "wrist_long" }, is_composite: false, bbox_2d: [1, 2, 300, 400], confidence: 0.9
  }, {
    slot: "bottom", category: "裤子", color: "light_blue", pattern: "solid", styles: [], structure: "浅蓝牛仔裤",
    structure_facts: {}, is_composite: false, bbox_2d: [1, 400, 300, 900], confidence: 0.9
  }] });
  assert.equal(top.color, "白色");
  assert.equal(top.pattern, "纯色");
  assert.equal(bottom.color, "浅蓝");
  assert.equal(cloudTest.usesContrastingUpperBackground(top), true);
  assert.match(cloudTest.buildFlatLayRequestBody("https://example.com/source.jpg", top, "qwen-image-2.0-pro").input.messages[0].content[1].text, /#4B5563/);
});

test("识别提示不把透明上衣下的贴身打底误当核心内搭", () => {
  const source = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js", import.meta.url), "utf8");
  assert.match(source, /薄纱、半透明或透视上衣下仅为遮挡身体而穿的贴身打底/);
  assert.match(source, /不得把透过面料看到的身体、裤腰或阴影误写成独立内搭/);
});

test("百度抠图压缩大图并使用30秒窗口且腾讯回退拒绝明显第二主体", () => {
  const source = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js", import.meta.url), "utf8");
  assert.match(source, /imageMogr2\/auto-orient\/thumbnail\/2400x2400>\/format\/jpg\/quality\/88/);
  assert.match(source, /image\.length > 4 \* 1024 \* 1024/);
  assert.match(source, /imageSizeFromBuffer\(image\)/);
  assert.match(source, /百度框选抠图响应超时，请稍后重试。", 30000\)/);
  assert.match(source, /quality\.secondaryForegroundRatio > 0\.01/);
  assert.match(source, /fallbackReasonCode = cleanText\(baiduError\?\.code, 80\)/);
});

test("固定组合结构字段可纠正冲突布尔值且普通分层不合并", () => {
  const fixed = cloudTest.normalizeOutfitDetections({ upper_body_mode: "single", detections: [{
    slot: "top", category: "上衣", color: "米白", pattern: "纯色", styles: [], structure: "长袖固定组合上装",
    structure_facts: { layer_mode: "fixed_combined", sleeve_length: "wrist_long" }, is_composite: false, bbox_2d: [1, 2, 300, 400], confidence: 0.9
  }] })[0];
  assert.equal(fixed.isComposite, true);
  assert.equal(fixed.structureFacts.layerMode, "fixed_combined");
  assert.equal(cloudTest.correctionAvailable({ ...fixed, correctionSeedKey: "cutouts/rejected.png", correctionAttempted: false }), true);

  const separate = cloudTest.normalizeOutfitDetections({ upper_body_mode: "separate", detections: [{
    slot: "top", category: "上衣", color: "白色", pattern: "纯色", styles: [], structure: "可独立替换的内搭",
    structure_facts: { layer_mode: "separate", sleeve_length: "short" }, is_composite: false, bbox_2d: [1, 2, 300, 400], confidence: 0.9
  }] })[0];
  assert.equal(separate.isComposite, false);
});

test("裤装固定结构任一不匹配时即使98分也拒绝", () => {
  const detection = { category: "裤子", isComposite: false };
  const accepted = {
    sameGarment: true, colorMatch: true, patternMatch: true, shapeMatch: true, fixedDetailsMatch: true,
    layersMatch: true, waistbandMatch: true, pocketLayoutMatch: true, seamMatch: true, legShapeMatch: true, hemMatch: true,
    fidelityScore: 98
  };
  for (const key of ["waistbandMatch", "pocketLayoutMatch", "seamMatch", "legShapeMatch", "hemMatch"]) {
    assert.equal(cloudTest.flatLayAccepted(0.95, { ...accepted, [key]: false }, detection), false);
  }
  assert.equal(cloudTest.flatLayAccepted(0.95, accepted, detection), true);
});

test("组合上装第一轮失败后只允许一次双图纠错", () => {
  const detection = {
    category: "上衣", color: "米白", pattern: "纯色", styles: ["多层"], structure: "长袖外层与近领系带内层",
    isComposite: true, correctionSeedKey: "cutouts/rejected.png", correctionReason: "长袖被缩短，内层领口过低", correctionAttempted: false
  };
  assert.equal(cloudTest.correctionAvailable(detection), true);
  assert.equal(cloudTest.correctionAvailable({ ...detection, correctionAttempted: true }), false);
  assert.equal(cloudTest.correctionAvailable({ ...detection, isComposite: false }), false);
  const body = cloudTest.buildCorrectiveFlatLayRequestBody("https://example.com/source.jpg", "https://example.com/rejected.png", detection, detection.correctionReason, "qwen-image-2.0-pro");
  assert.equal(body.input.messages[0].content.filter((item) => item.image).length, 2);
  assert.equal(body.parameters.n, 2);
  assert.match(body.input.messages[0].content[2].text, /不得拆成两件/);
  assert.match(body.input.messages[0].content[2].text, /长袖被缩短，内层领口过低/);
});

test("整套兼容服务仍将核验原因转为中文并保留分割字段", () => {
  assert.equal(cloudTest.userFacingVerificationReason("necklineHeightMatch 与 layerCoverageMatch 不通过"), "领口高度一致性 与 层次覆盖一致性 不通过");
  const apiSource = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
  assert.match(apiSource, /segmentationStatus:/);
  assert.match(apiSource, /visiblePixelPreservationScore:/);
});

test("复杂浅色上装使用保真候选、适配画布和高对比留白背景", () => {
  const asymmetricTop = {
    category: "上衣", color: "浅灰白", pattern: "纯色", styles: ["露肩", "不对称"],
    structure: "左肩固定露肩开口，长袖且下摆不对称", isComposite: false
  };
  const asymmetricBody = cloudTest.buildFlatLayRequestBody("https://example.com/source.jpg", asymmetricTop, "qwen-image-2.0-pro");
  const asymmetricPrompt = asymmetricBody.input.messages[0].content[1].text;
  assert.equal(cloudTest.usesFaithfulPresentation(asymmetricTop), true);
  assert.equal(asymmetricBody.parameters.n, 3);
  assert.equal(asymmetricBody.parameters.size, "1536*1536");
  assert.match(asymmetricPrompt, /不得美化、改款/);

  const layeredTop = {
    category: "上衣", color: "米白与浅灰白", pattern: "纯色", styles: ["多层", "系带"],
    structure: "米白长袖开衫覆盖浅灰白系带内层", isComposite: true
  };
  const layeredBody = cloudTest.buildFlatLayRequestBody("https://example.com/source.jpg", layeredTop, "qwen-image-2.0-pro");
  const layeredPrompt = layeredBody.input.messages[0].content[1].text;
  assert.equal(cloudTest.usesContrastingUpperBackground(layeredTop), true);
  assert.equal(layeredBody.parameters.n, 3);
  assert.equal(layeredBody.parameters.size, "1536*1536");
  assert.match(layeredPrompt, /#4B5563/);
  assert.match(layeredPrompt, /至少约12%/);
  assert.match(layeredPrompt, /内外层共同构成同一件衣物/);
  assert.doesNotMatch(layeredPrompt, /抽绳与腰头/);

  const batwingTop = { ...layeredTop, structure: "固定组合蝙蝠袖上装", structureFacts: { sleeveShape: "蝙蝠袖" } };
  assert.equal(cloudTest.flatLaySize(batwingTop), "1536*1024");
});

test("普通上衣不扩大保真路径且复杂上装继续严格拒绝改款", () => {
  const ordinaryTop = {
    category: "上衣", color: "黑色", pattern: "纯色", styles: ["基础款"],
    structure: "普通圆领短袖上衣", isComposite: false
  };
  const body = cloudTest.buildFlatLayRequestBody("https://example.com/source.jpg", ordinaryTop, "qwen-image-2.0-pro");
  assert.equal(cloudTest.usesFaithfulPresentation(ordinaryTop), false);
  assert.equal(cloudTest.usesContrastingUpperBackground(ordinaryTop), false);
  assert.equal(body.parameters.n, 2);
  assert.equal(body.parameters.size, "1024*1024");
  assert.match(body.input.messages[0].content[1].text, /使用纯白色背景/);

  const compositeTop = { category: "上衣", isComposite: true };
  const otherwiseAccepted = {
    sameGarment: true, colorMatch: true, patternMatch: true, shapeMatch: true, fixedDetailsMatch: true,
    layersMatch: true, sleeveLengthMatch: true, necklineHeightMatch: true, layerCoverageMatch: true, fidelityScore: 98
  };
  assert.equal(cloudTest.flatLayAccepted(0.95, { ...otherwiseAccepted, fixedDetailsMatch: false }, compositeTop), false);
  assert.equal(cloudTest.flatLayAccepted(0.95, { ...otherwiseAccepted, layersMatch: false }, compositeTop), false);
  assert.equal(cloudTest.flatLayAccepted(0.95, { ...otherwiseAccepted, sleeveLengthMatch: false }, compositeTop), false);
  assert.equal(cloudTest.flatLayAccepted(0.95, { ...otherwiseAccepted, necklineHeightMatch: false }, compositeTop), false);
  assert.equal(cloudTest.flatLayAccepted(0.95, { ...otherwiseAccepted, layerCoverageMatch: false }, compositeTop), false);
  assert.equal(cloudTest.flatLayAccepted(0.95, otherwiseAccepted, compositeTop), true);
  const verifierPrompt = require("node:fs").readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js", import.meta.url), "utf8");
  assert.match(verifierPrompt, /图1长袖而图2露出明显前臂必须为 false/);
  assert.match(verifierPrompt, /图1内外领口几乎平齐而图2变成低领或吊带必须为 false/);
});

test("平铺抠图失败保留可区分的质量原因", () => {
  assert.equal(cloudTest.mattingFailureReason([{ transparentRatio: 0.04, transparentBorderRatio: 0.5 }]), "平铺候选透明背景面积不足。");
  assert.equal(cloudTest.mattingFailureReason([{ transparentRatio: 0.97, transparentBorderRatio: 1 }]), "平铺候选衣物主体过小或被过度去除。");
  assert.equal(cloudTest.mattingFailureReason([{ transparentRatio: 0.4, transparentBorderRatio: 0.9 }]), "平铺候选画布边缘仍有不透明像素。");
  assert.equal(cloudTest.mattingFailureKind([{ transparentRatio: 0.04, transparentBorderRatio: 0.5 }]), "matting_transparency_low");
  assert.equal(cloudTest.mattingFailureKind([{ transparentRatio: 0.97, transparentBorderRatio: 1 }]), "matting_subject_too_small");
  assert.equal(cloudTest.mattingFailureKind([{ transparentRatio: 0.4, transparentBorderRatio: 0.9 }]), "matting_border_opaque");
  assert.equal(cloudTest.mattingFailureReason([]), "平铺图边缘抠图未通过质量检查。");
});

const createMemoryDatabase = () => {
  let state = new Map();
  const cloneState = () => new Map([...state].map(([name, documents]) => [
    name,
    new Map([...documents].map(([id, document]) => [id, structuredClone(document)]))
  ]));
  const command = {
    in: (values) => ({ operation: "in", values }),
    inc: (value) => ({ operation: "inc", value }),
    remove: () => ({ operation: "remove" }),
    set: (value) => ({ operation: "set", value }),
    gte: (value) => ({ operation: "gte", value, and(other) { return { operation: "and", conditions: [this, other] }; } }),
    lt: (value) => ({ operation: "lt", value })
  };
  const matches = (document, where) => Object.entries(where || {}).every(([field, expected]) => {
    if (expected?.operation === "in") return expected.values.includes(document[field]);
    if (expected?.operation === "gte") return document[field] >= expected.value;
    if (expected?.operation === "lt") return document[field] < expected.value;
    if (expected?.operation === "and") return expected.conditions.every((condition) => matches({ value: document[field] }, { value: condition }));
    return document[field] === expected;
  });
  const collectionFor = (store, name, transactionMode = false) => {
    if (!store.has(name)) store.set(name, new Map());
    const documents = store.get(name);
    const query = { where: {}, orderField: null, order: "asc", limit: null };
    const api = {
      where(where) { query.where = where; return api; },
      orderBy(field, order) { query.orderField = field; query.order = order; return api; },
      limit(limit) { query.limit = limit; return api; },
      async get() {
        let values = [...documents.values()].filter((document) => matches(document, query.where)).map((document) => structuredClone(document));
        if (query.orderField) values.sort((a, b) => String(a[query.orderField]).localeCompare(String(b[query.orderField])) * (query.order === "desc" ? -1 : 1));
        if (query.limit) values = values.slice(0, query.limit);
        return { data: values };
      },
      async count() {
        return { total: [...documents.values()].filter((document) => matches(document, query.where)).length };
      },
      async add(document) {
        const id = String(document._id);
        if (documents.has(id)) throw Object.assign(new Error("duplicate _id"), { code: "duplicate" });
        documents.set(id, structuredClone(document));
        return { id };
      },
      doc(id) {
        const documentId = String(id);
        return {
          async get() {
            const document = documents.get(documentId);
            return { data: transactionMode ? (document ? structuredClone(document) : null) : (document ? [structuredClone(document)] : []) };
          },
          async update(changes) {
            const document = documents.get(documentId);
            if (!document) return { updated: 0 };
            for (const [field, value] of Object.entries(changes)) {
              if (value?.operation === "remove") {
                delete document[field];
                continue;
              }
              document[field] = value?.operation === "inc"
                ? Number(document[field] || 0) + value.value
                : value?.operation === "set"
                  ? structuredClone(value.value)
                  : structuredClone(value);
            }
            return { updated: 1 };
          },
          async remove() {
            return { deleted: documents.delete(documentId) ? 1 : 0 };
          }
        };
      }
    };
    return api;
  };
  return {
    command,
    collection: (name) => collectionFor(state, name),
    async startTransaction() {
      const draft = cloneState();
      return {
        collection: (name) => collectionFor(draft, name, true),
        async commit() { state = draft; },
        async rollback() {}
      };
    }
  };
};

const makeEvent = (path, method = "GET", body = null, headers = {}) => {
  const url = new URL(path, "https://wardrobe.test");
  return {
  path: url.pathname,
  httpMethod: method,
  headers,
  queryStringParameters: Object.fromEntries(url.searchParams),
  body: body == null ? "" : JSON.stringify(body),
  isBase64Encoded: false
  };
};
const readResponse = (result) => ({ status: result.statusCode, body: result.body ? JSON.parse(result.body) : null });

test("uniCloud 云函数可迁移、登录、读取衣橱并事务记录穿着", async () => {
  const memoryDatabase = createMemoryDatabase();
  globalThis.uniCloud = {
    database: () => memoryDatabase,
    httpclient: { request: async () => { throw new Error("本测试不应访问外部网络"); } }
  };
  process.env.JWT_SECRET = "test-jwt-secret-at-least-32-characters";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "test-admin-token";
  process.env.COS_SECRET_ID = "test-secret-id";
  process.env.COS_SECRET_KEY = "test-secret-key";
  process.env.COS_BUCKET = "wardrobe-test-1234567890";
  process.env.COS_REGION = "ap-guangzhou";
  process.env.VITA_API_KEY = "test-vita";
  process.env.TIIA_GROUP_ID = "wardrobe_items";
  process.env.TIIA_REGION = "ap-guangzhou";

  const cloudServices = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js");
  cloudServices.createUpload = (userId, mimeType, taskId) => ({
    taskId,
    sourceKey: `uploads/${userId}/${taskId}.${mimeType === "image/png" ? "png" : "jpg"}`,
    uploadUrl: `https://upload.test/${taskId}`,
    expiresIn: 300
  });
  cloudServices.signedUrl = (key) => `https://images.test/${encodeURIComponent(key)}`;
  cloudServices.sourceHash = async () => "b".repeat(64);
  let mattingCallCount = 0;
  cloudServices.extractGarment = async () => {
    mattingCallCount += 1;
    return { cutoutKey: "cutouts/new-item.png", modelName: "商品抠图", providerCallCount: 1 };
  };
  cloudServices.detectFlatLayGarments = async () => ({
    detections: [
      { detectionId: "garment-0", category: "上衣", color: "白色", bbox: [40, 40, 480, 460], confidence: 0.97 },
      { detectionId: "garment-1", category: "裤子", color: "蓝色", bbox: [500, 60, 960, 950], confidence: 0.96 }
    ],
    usage: { prompt_tokens: 30, completion_tokens: 10 },
    model: "qwen-test"
  });
  cloudServices.createFlatLayGarmentCrops = async (_sourceKey, userId, parentTaskId, detections) => detections.map((item) => ({
    ...item,
    cropKey: `multi-garment-crops/${userId}/${parentTaskId}-${item.detectionId}.jpg`,
    contentType: "image/jpeg"
  }));
  let hangerEditCallCount = 0;
  cloudServices.removeHanger = async () => {
    hangerEditCallCount += 1;
    return { imageKey: "cutouts/new-item-no-hanger.png", model: "qwen-image-2.0", imageEditCalls: 1, postMattingCalls: 0 };
  };
  let recognitionCallCount = 0;
  let lastRecognitionKey = "";
  cloudServices.recognizeImage = async (key) => {
    recognitionCallCount += 1;
    lastRecognitionKey = key;
    return ({
    valid: true,
    reason: "",
    tags: {
      name: "浅紫针织上衣",
      category: "上衣",
      color: "浅紫",
      season: "春夏",
      thickness: "薄",
      pattern: "纯色",
      material: "针织感",
      designDetails: ["荷叶边"],
      styles: ["温柔"],
      scenes: ["休闲"],
      needsConfirmation: ["请确认材质"]
    },
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    provider: "dashscope",
    model: "qwen3-vl-plus"
    });
  };
  let embeddingShouldFail = false;
  let embeddingCallCount = 0;
  cloudServices.generateImageEmbeddings = async (keys) => {
    embeddingCallCount += 1;
    if (embeddingShouldFail) throw Object.assign(new Error("test embedding unavailable"), { status: 502 });
    return ({
    model: "tongyi-embedding-vision-flash-2026-03-06",
    dimension: 512,
    vectors: keys.map((key) => {
      const vector = Array(512).fill(0);
      vector[key.includes("candidate") || key.includes("new-item") || key.includes("item-1") ? 0 : 1] = 1;
      return vector;
    }),
    usage: { input_tokens: keys.length * 402 },
    estimatedCostMicros: keys.length * 61,
      requestId: "test-embedding-request"
    });
  };
  const deletedCloudKeys = [];
  cloudServices.deleteObject = async (key) => { deletedCloudKeys.push(key); };
  cloudServices.createInspirationUpload = (userId, recordId, mimeType) => ({
    sourceKey: `inspirations/${userId}/${recordId}/source.${mimeType === "image/png" ? "png" : "jpg"}`,
    uploadUrl: "https://cos.test/inspiration-upload",
    expiresIn: 300
  });
  cloudServices.readObject = async () => Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const successfulInspirationAnalysis = async () => ({
    result: {
      mainImageIndex: 0,
      summary: "白色通勤上装",
      slots: [{ slot: "top", category: "上衣", name: "白色通勤上装", color: "白色", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"], confidence: 92, evidence: "画面可见" }]
    },
    usage: { prompt_tokens: 120, completion_tokens: 40 },
    provider: "dashscope",
    model: "qwen-test"
  });
  cloudServices.analyzeInspirationImages = successfulInspirationAnalysis;
  let outfitAssistantCalls = 0;
  cloudServices.understandOutfitRequest = async (prompt) => {
    outfitAssistantCalls += 1;
    if (String(prompt).includes("触发临时维护")) throw Object.assign(new Error("穿搭需求理解暂时不可用"), {
      code: "billing_maintenance", providerStatusCode: 503, provider: "lyrouter"
    });
    return {
      result: { scene: "约会", styles: ["韩系"], excluded_categories: ["半身裙"], preferred_colors: ["粉色"], warmth_preference: "normal", needsClarification: false, summary: "韩系裤装约会" },
      usage: { prompt_tokens: 35, completion_tokens: 20 }, provider: "dashscope", model: "qwen-test"
    };
  };

  const { main, _test } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js");
  const fixedNow = Date.parse("2026-08-03T00:00:00.000Z");
  assert.equal(_test.entitlementSummary({ trial_ends_at: "2026-08-02T23:59:59.999Z" }, fixedNow).status, "expired");
  assert.equal(_test.entitlementSummary({ trial_ends_at: "2026-08-10T00:00:00.000Z" }, fixedNow).status, "trialing");
  assert.equal(_test.entitlementSummary({ trial_ends_at: "2026-08-02T00:00:00.000Z", subscription_ends_at: "2026-09-01T00:00:00.000Z" }, fixedNow).status, "active");
  const trialQuota = _test.quotaSummary({ trial_started_at: "2026-08-01T00:00:00.000Z", trial_ends_at: "2026-08-08T00:00:00.000Z" }, [
    { status: "completed", prompt_tokens: 10, completion_tokens: 5, hanger_edit_key: "edit.png", created_at: "2026-08-02T00:00:00.000Z" },
    { mode: "inspiration", status: "completed", prompt_tokens: 100, completion_tokens: 50, created_at: "2026-08-02T00:30:00.000Z" },
    { status: "failed_retryable", prompt_tokens: 10, completion_tokens: 0, created_at: "2026-08-02T01:00:00.000Z" }
  ], fixedNow);
  assert.equal(trialQuota.mode, "trial");
  assert.equal(trialQuota.recognition.used, 1);
  assert.equal(trialQuota.recognition.remaining, 19);
  assert.equal(trialQuota.hangerRemoval.remaining, 4);
  assert.equal(trialQuota.enforcement, "observe_only");
  const multiQuota = _test.quotaSummary({ trial_started_at: "2026-08-01T00:00:00.000Z", trial_ends_at: "2026-08-08T00:00:00.000Z" }, [
    { mode: "multi_detection", status: "completed", stage: "multi_review", prompt_tokens: 30, completion_tokens: 10, created_at: "2026-08-02T00:00:00.000Z" },
    { mode: "multi_item", status: "completed", stage: "awaiting_confirmation", prompt_tokens: 30, completion_tokens: 10, created_at: "2026-08-02T00:01:00.000Z" },
    { mode: "multi_item", status: "completed", stage: "saved", prompt_tokens: 30, completion_tokens: 10, created_at: "2026-08-02T00:02:00.000Z" }
  ], fixedNow);
  assert.equal(multiQuota.recognition.used, 1);
  const assistantQuota = _test.quotaSummary({ trial_started_at: "2026-08-01T00:00:00.000Z", trial_ends_at: "2026-08-08T00:00:00.000Z" }, [
    { mode: "outfit_assistant", status: "completed", prompt_tokens: 30, completion_tokens: 10, created_at: "2026-08-02T00:00:00.000Z" }
  ], fixedNow);
  assert.equal(assistantQuota.recognition.used, 0);
  assert.equal(_test.shanghaiDayKey("2026-08-03T16:30:00.000Z"), "2026-08-04");
  const seventhDayReward = _test.nextStarAccount({
    user_id: "user-1", balance: 6, total_earned: 6, current_streak: 6, longest_streak: 6,
    last_checkin_day: "2026-08-06", month_key: "2026-08", month_checkin_days: 6,
    month_earned: 6, weekly_bonus_month: "", created_at: "2026-08-01T00:00:00.000Z"
  }, "2026-08-07", "2026-08-07T00:00:00.000Z");
  assert.equal(seventhDayReward.dailyPoints, 1);
  assert.equal(seventhDayReward.bonusPoints, 3);
  assert.equal(seventhDayReward.account.balance, 10);
  assert.equal(seventhDayReward.account.current_streak, 7);
  const eighthDayReward = _test.nextStarAccount(seventhDayReward.account, "2026-08-08", "2026-08-08T00:00:00.000Z");
  assert.equal(eighthDayReward.dailyPoints, 1);
  assert.equal(eighthDayReward.bonusPoints, 0);
  const cappedReward = _test.nextStarAccount({
    user_id: "user-1", balance: 34, total_earned: 34, current_streak: 6, longest_streak: 6,
    last_checkin_day: "2026-08-06", month_key: "2026-08", month_checkin_days: 31,
    month_earned: 34, weekly_bonus_month: "", created_at: "2026-08-01T00:00:00.000Z"
  }, "2026-08-07", "2026-08-07T00:00:00.000Z");
  assert.equal(cappedReward.awardedPoints, 1);
  assert.equal(cappedReward.account.month_earned, 35);
  const coolingOff = _test.candidateWaitSummary(
    { wait_started_at: "2026-08-01T00:00:00.000Z" },
    Date.parse("2026-08-08T00:00:00.000Z")
  );
  assert.equal(coolingOff.waitDays, 7);
  assert.equal(coolingOff.daysRemaining, 0);
  assert.equal(coolingOff.coolingOffComplete, true);
  const freeQuota = _test.quotaSummary({ trial_ends_at: "2026-07-20T00:00:00.000Z" }, [], fixedNow);
  assert.equal(freeQuota.mode, "free");
  assert.equal(freeQuota.recognition.limit, 3);
  assert.equal(freeQuota.hangerRemoval.limit, 1);
  const previousDedicatedId = process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  const previousDedicatedSecret = process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  const previousDashscopeKey = process.env.DASHSCOPE_API_KEY;
  const previousWorkspaceId = process.env.DASHSCOPE_WORKSPACE_ID;
  process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = "health-dedicated-id";
  process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = "health-dedicated-secret";
  process.env.DASHSCOPE_API_KEY = "health-dashscope-key";
  process.env.DASHSCOPE_WORKSPACE_ID = "health-workspace-id";
  const health = readResponse(await main(makeEvent("/api/health")));
  if (previousDedicatedId === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_ID;
  else process.env.WARDROBE_VIAPI_ACCESS_KEY_ID = previousDedicatedId;
  if (previousDedicatedSecret === undefined) delete process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET;
  else process.env.WARDROBE_VIAPI_ACCESS_KEY_SECRET = previousDedicatedSecret;
  if (previousDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = previousDashscopeKey;
  if (previousWorkspaceId === undefined) delete process.env.DASHSCOPE_WORKSPACE_ID;
  else process.env.DASHSCOPE_WORKSPACE_ID = previousWorkspaceId;
  assert.equal(health.status, 200);
  assert.equal(health.body.buildId, "2026-08-20-relative-formality-agent-v87");
  assert.deepEqual(health.body.outfitPlans, { enabled: true, mode: "private" });
  assert.deepEqual(health.body.multiGarment, { enabled: true, maxItems: 3, personPhotos: false });
  assert.equal(health.body.models.garmentSegmentation, "aitryon-parsing-v1");
  assert.equal(health.body.models.productSegmentation, "BaiduControlMatting");
  assert.equal(health.body.models.productSegmentationFallback, "SegmentCommodity");
  assert.equal(health.body.garmentSegmentation.provider, "aliyun-bailian");
  assert.deepEqual(health.body.outfitParsing, { enabled: true, region: "cn-beijing" });
  assert.deepEqual(health.body.garmentSegmentationDiagnostic, {
    enabled: true,
    transport: "native_rpc_v2",
    fileAuthorizationTransport: "native_rpc_v2",
    credentialMode: "dedicated_ram",
    productionEnabled: false
  });
  assert.equal(health.body.models.outfitVision, "qwen3-vl-flash-2026-01-22");
  assert.equal(health.body.models.outfitImageEdit, "qwen-image-2.0-pro-2026-06-22");
  const firstSlot = await _test.acquireImageEditSlot(fixedNow);
  const queuedSlot = await _test.acquireImageEditSlot(fixedNow + 1000);
  const nextSlot = await _test.acquireImageEditSlot(fixedNow + 31000);
  assert.equal(firstSlot.acquired, true);
  assert.equal(queuedSlot.acquired, false);
  assert.equal(queuedSlot.retryAfterMs, 30000);
  assert.equal(nextSlot.acquired, true);
  const passwordHash = await bcrypt.hash("password123", 4);
  const tables = {
    users: [{ id: 1, username: "tester", role: "admin", password_hash: passwordHash, recovery_hash: passwordHash, created_at: "2026-01-01T00:00:00.000Z" }],
    invites: [{ id: 1, code: "USED", used_by: 1, used_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" }],
    clothing_items: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      user_id: 1,
      image_key: `cutouts/item-${index + 1}.png`,
      name: `衣物${index + 1}`,
      category: "上衣",
      color: "灰色",
      season: index === 0 ? "春秋" : null,
      thickness: index === 0 ? "适中" : null,
      pattern: index === 0 ? "纯色" : null,
      material: index === 0 ? "棉混纺" : null,
      styles: '["简约"]',
      scenes: '["休闲"]',
      price: null,
      wear_count: index === 0 ? 6 : 0,
      status: "active",
      created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      source_hash: index === 0 ? "a".repeat(64) : index === 1 ? "z".repeat(64) : null,
      search_entity_id: index === 0 ? "u1_i1" : null
    })),
    wear_logs: Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      user_id: 1,
      item_id: 1,
      scene: "日常",
      comfort: "舒适",
      note: "",
      worn_at: `2026-02-0${index + 1}T00:00:00.000Z`
    })),
    candidates: []
  };

  const migration = readResponse(await main(makeEvent("/api/admin/migrate", "POST", { tables }, { "x-admin-token": "test-admin-token" })));
  assert.equal(migration.status, 201);
  assert.deepEqual(migration.body.migrated, { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0 });

  const login = readResponse(await main(makeEvent("/api/auth/login", "POST", { username: "tester", password: "password123" })));
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal(login.body.user.role, "admin");

  const weakRegistration = readResponse(await main(makeEvent("/api/auth/register", "POST", {
    username: "new-member", password: "short"
  })));
  assert.equal(weakRegistration.status, 400);
  assert.match(weakRegistration.body.error, /用户名或密码格式/);
  const openRegistration = readResponse(await main(makeEvent("/api/auth/register", "POST", {
    username: "new-member", password: "password123"
  })));
  assert.equal(openRegistration.status, 201);
  assert.equal(openRegistration.body.user.username, "new-member");
  assert.match(openRegistration.body.recoveryCode, /^[A-F0-9]{12}$/);
  const duplicateRegistration = readResponse(await main(makeEvent("/api/auth/register", "POST", {
    username: "new-member", password: "password123"
  })));
  assert.equal(duplicateRegistration.status, 409);
  const registeredLogin = readResponse(await main(makeEvent("/api/auth/login", "POST", {
    username: "new-member", password: "password123"
  })));
  assert.equal(registeredLogin.status, 200);

  const authorization = { authorization: `Bearer ${login.body.token}` };
  const diagnosticMember = readResponse(await main(makeEvent("/api/auth/register", "POST", { username: "diagnostic-member", password: "password123" })));
  const memberAuthorization = { authorization: `Bearer ${diagnosticMember.body.token}` };
  const memberUpload = readResponse(await main(makeEvent("/api/outfit-captures/presign", "POST", { mimeType: "image/jpeg", size: 500000 }, memberAuthorization)));
  const forbiddenDiagnostic = readResponse(await main(makeEvent(`/api/admin/outfit-captures/${memberUpload.body.captureId}/segmentation-diagnostic`, "POST", {}, memberAuthorization)));
  assert.equal(forbiddenDiagnostic.status, 403);
  assert.match(forbiddenDiagnostic.body.error, /没有服饰分割诊断权限/);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-captures/${memberUpload.body.captureId}`, "DELETE", null, memberAuthorization))).status, 200);
  process.env.AMAP_WEATHER_KEY = "test-amap-key";
  globalThis.uniCloud.httpclient.request = async (_url, options) => ({
    status: 200,
    data: options.data.extensions === "all"
      ? { status: "1", forecasts: [{ province: "广东", city: "深圳市", adcode: "440305", reporttime: "2026-08-04 11:00:00", casts: [{ date: "2026-08-04", dayweather: "多云", nightweather: "晴", daytemp: "31", nighttemp: "22", daypower: "3", nightpower: "2" }] }] }
      : { status: "1", lives: [{ province: "广东", city: "深圳市", adcode: "440305", weather: "多云", temperature: "27", humidity: "72", winddirection: "东南", windpower: "3", reporttime: "2026-08-04 12:00:00" }] }
  });
  const weather = readResponse(await main(makeEvent("/api/weather?adcode=440305", "GET", null, authorization)));
  assert.equal(weather.status, 200);
  assert.equal(weather.body.temperature, 27);
  assert.equal(weather.body.condition, "多云");
  assert.equal(weather.body.low, 22);
  assert.equal(weather.body.high, 31);
  const invalidWeather = readResponse(await main(makeEvent("/api/weather?adcode=bad", "GET", null, authorization)));
  assert.equal(invalidWeather.status, 400);
  const firstEntitlement = readResponse(await main(makeEvent("/api/entitlements/me", "GET", null, authorization)));
  const repeatedEntitlement = readResponse(await main(makeEvent("/api/entitlements/me", "GET", null, authorization)));
  assert.equal(firstEntitlement.status, 200);
  assert.equal(firstEntitlement.body.status, "trialing");
  assert.equal(firstEntitlement.body.quota.recognition.limit, 20);
  assert.equal(firstEntitlement.body.quota.hangerRemoval.limit, 5);
  assert.equal(firstEntitlement.body.quota.enforcement, "observe_only");
  assert.equal(Date.parse(firstEntitlement.body.trialEndsAt) - Date.parse(firstEntitlement.body.trialStartedAt), 7 * 24 * 60 * 60 * 1000);
  assert.equal(repeatedEntitlement.body.trialStartedAt, firstEntitlement.body.trialStartedAt);
  assert.equal(repeatedEntitlement.body.trialEndsAt, firstEntitlement.body.trialEndsAt);
  const plans = readResponse(await main(makeEvent("/api/plans", "GET", null, authorization)));
  assert.equal(plans.status, 200);
  assert.equal(plans.body.purchaseEnabled, false);
  assert.equal(plans.body.pricingRule, undefined);
  assert.deepEqual(plans.body.plans.map((plan) => plan.id), ["weekly", "monthly", "yearly"]);
  assert.deepEqual(plans.body.plans.map((plan) => plan.price), [6.9, 34.9, 298]);
  assert.deepEqual(plans.body.plans.map((plan) => plan.renewalPrice), [6.21, 27.92, 208.6]);
  assert.deepEqual(plans.body.plans.map((plan) => plan.renewalDiscount), [0.9, 0.8, 0.7]);
  assert.ok(plans.body.plans.every((plan) => plan.purchaseEnabled === false));
  assert.deepEqual(plans.body.plans.map((plan) => [plan.quota.recognitionLimit, plan.quota.hangerRemovalLimit]), [[6, 1], [40, 10], [40, 10]]);
  const budget = readResponse(await main(makeEvent("/api/ai-budget", "GET", null, authorization)));
  assert.equal(budget.status, 200);
  assert.equal(budget.body.remainingTasks, 1000);
  assert.equal(budget.body.remainingYuan, 50);
  const assistantResult = readResponse(await main(makeEvent("/api/outfit-assistant/understand", "POST", {
    message: "今天约会，想穿韩系，不要裙子", followupUsed: false, idempotencyKey: "assistant-test-1"
  }, authorization)));
  assert.equal(assistantResult.status, 200);
  assert.equal(assistantResult.body.preferences.scene, "约会");
  assert.deepEqual(assistantResult.body.preferences.styles, ["韩系"]);
  assert.deepEqual(assistantResult.body.preferences.excludedCategories, ["半身裙", "连衣裙"]);
  assert.equal(outfitAssistantCalls, 1);
  const assistantReplay = readResponse(await main(makeEvent("/api/outfit-assistant/understand", "POST", {
    message: "重复发送不会重复调用", followupUsed: false, idempotencyKey: "assistant-test-1"
  }, authorization)));
  assert.equal(assistantReplay.status, 200);
  assert.equal(outfitAssistantCalls, 1);
  const assistantFallback = readResponse(await main(makeEvent("/api/outfit-assistant/understand", "POST", {
    message: "触发临时维护，约会想穿裙子", followupUsed: false, idempotencyKey: "assistant-test-503"
  }, authorization)));
  assert.equal(assistantFallback.status, 200);
  assert.equal(assistantFallback.body.fallback, "controlled_text_rules");
  assert.equal(assistantFallback.body.fallbackReason, "billing_maintenance");
  assert.deepEqual(assistantFallback.body.preferences.preferredCategories, ["连衣裙", "半身裙"]);
  const multiUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg", size: 500000, mode: "multi_detection", idempotencyKey: "test-multi-detection"
  }, authorization)));
  assert.equal(multiUpload.status, 201);
  const multiDetection = readResponse(await main(makeEvent(`/api/tasks/${multiUpload.body.taskId}/multi-garments`, "POST", {}, authorization)));
  assert.equal(multiDetection.status, 200);
  assert.deepEqual(multiDetection.body.detections.map((item) => item.category), ["上衣", "裤子"]);
  const multiSplit = readResponse(await main(makeEvent(`/api/tasks/${multiUpload.body.taskId}/multi-garments/selection`, "POST", {
    detectionIds: multiDetection.body.detections.map((item) => item.detectionId)
  }, authorization)));
  assert.equal(multiSplit.status, 200);
  assert.equal(multiSplit.body.items.length, 2);
  assert.equal(new Set(multiSplit.body.items.map((item) => item.taskId)).size, 2);
  assert.ok(multiSplit.body.items.every((item) => item.cropUrl.includes("multi-garment-crops")));
  const repeatedMultiSplit = readResponse(await main(makeEvent(`/api/tasks/${multiUpload.body.taskId}/multi-garments/selection`, "POST", {
    detectionIds: multiDetection.body.detections.map((item) => item.detectionId)
  }, authorization)));
  assert.deepEqual(repeatedMultiSplit.body.items.map((item) => item.taskId), multiSplit.body.items.map((item) => item.taskId));
  const budgetAfterMultiDetection = readResponse(await main(makeEvent("/api/ai-budget", "GET", null, authorization)));

  const outfitEvents = [];
  cloudServices.analyzeOutfit = async () => {
    outfitEvents.push("analyze");
    return { detections: [{
      detectionId: "d-0", slot: "top", category: "上衣", color: "黑色", pattern: "纯色", styles: [],
      structure: "黑色长袖上衣", structureFacts: { layerMode: "single", sleeveLength: "wrist_long" },
      isComposite: false, confidence: 0.99, bbox: [100, 100, 800, 700], cropKey: "outfit-crops/test-top.jpg",
      cutoutKey: "", flatLayKey: "", selectedImageKey: "", imageOrigin: "", fidelityScore: null,
      fidelityStatus: "pending", processingStatus: "cropped", processingError: ""
    }] };
  };
  const segmentationTransports = [];
  cloudServices.segmentOutfitGarments = async (_sourceKey, detections, _userId, _captureId, options = {}) => {
    outfitEvents.push("segment");
    segmentationTransports.push(options.transport || "production_default");
    return detections.map((detection) => ({
      ...detection,
      cutoutKey: "outfit-segmented/test-top.png",
      imageOrigin: "source_garment_mask",
      visiblePixelPreservationScore: 100,
      occlusionRatio: 0,
      segmentationStatus: "ready",
      segmentationProvider: "aliyun_aitryon_parsing"
    }));
  };
  cloudServices.prepareOutfitDetection = async (detection) => ({
    cutoutKey: detection.cutoutKey,
    flatLayKey: "",
    selectedImageKey: detection.cutoutKey,
    imageOrigin: "generated_wardrobe_display",
    visiblePixelPreservationScore: 100,
    occlusionRatio: 0,
    segmentationStatus: "accepted",
    fidelityScore: 98,
    fidelityStatus: "accepted",
    processingStatus: "ready",
    processingError: "",
    retryable: false,
    retryAfterMs: 0,
    failureKind: ""
  });
  cloudServices.requiresOutfitImageEdit = () => false;
  const previousDeleteObject = cloudServices.deleteObject;
  const deletedOutfitKeys = [];
  cloudServices.deleteObject = async (key) => {
    outfitEvents.push(`delete:${key}`);
    deletedOutfitKeys.push(key);
  };
  const outfitUpload = readResponse(await main(makeEvent("/api/outfit-captures/presign", "POST", { mimeType: "image/jpeg", size: 500000 }, authorization)));
  assert.equal(outfitUpload.status, 201);
  const outfitAnalyzed = readResponse(await main(makeEvent(`/api/outfit-captures/${outfitUpload.body.captureId}/analyze`, "POST", {}, authorization)));
  assert.equal(outfitAnalyzed.status, 200);
  assert.equal(outfitAnalyzed.body.originalDeleted, true);
  assert.equal(outfitAnalyzed.body.detections[0].segmentationStatus, "ready");
  assert.equal(outfitAnalyzed.body.detections[0].visiblePixelPreservationScore, 100);
  assert.equal(segmentationTransports[0], "production_default");
  assert.deepEqual(outfitEvents.slice(0, 3).map((entry) => entry.startsWith("delete:") ? "delete" : entry), ["analyze", "segment", "delete"]);
  const embeddingCallsBeforeOutfitPrepare = embeddingCallCount;
  const outfitPrepared = readResponse(await main(makeEvent(`/api/outfit-captures/${outfitUpload.body.captureId}/detections/d-0/prepare`, "POST", {}, authorization)));
  assert.equal(outfitPrepared.status, 200);
  assert.equal(outfitPrepared.body.processingStatus, "ready");
  assert.equal(outfitPrepared.body.imageOrigin, "generated_wardrobe_display");
  assert.equal(outfitPrepared.body.topMatches.length, 0);
  assert.equal(embeddingCallCount, embeddingCallsBeforeOutfitPrepare);
  const outfitCancelled = readResponse(await main(makeEvent(`/api/outfit-captures/${outfitUpload.body.captureId}`, "DELETE", null, authorization)));
  assert.equal(outfitCancelled.status, 200);
  assert.ok(deletedOutfitKeys.includes("outfit-crops/test-top.jpg"));
  assert.ok(deletedOutfitKeys.includes("outfit-segmented/test-top.png"));
  const diagnosticUpload = readResponse(await main(makeEvent("/api/outfit-captures/presign", "POST", { mimeType: "image/jpeg", size: 500000 }, authorization)));
  const diagnostic = readResponse(await main(makeEvent(`/api/admin/outfit-captures/${diagnosticUpload.body.captureId}/segmentation-diagnostic`, "POST", {}, authorization)));
  assert.equal(diagnostic.status, 200);
  assert.equal(diagnostic.body.transport, "native_rpc_v2");
  assert.equal(diagnostic.body.originalDeleted, true);
  assert.match(diagnostic.body.detections[0].cutoutUrl, /^https:\/\/images\.test\//);
  assert.equal(segmentationTransports.at(-1), "native_rpc_v2");
  const diagnosticCancelled = readResponse(await main(makeEvent(`/api/outfit-captures/${diagnosticUpload.body.captureId}`, "DELETE", null, authorization)));
  assert.equal(diagnosticCancelled.status, 200);
  cloudServices.deleteObject = previousDeleteObject;

  const items = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(items.status, 200);
  assert.equal(items.body.length, 5);
  assert.match(items.body[0].imageUrl, /^https:\/\//);
  // 列表接口必须把确认后的完整属性交给小程序，展示层不能只收到场景标签。
  const migratedItem = items.body.find((item) => item.id === "1");
  assert.equal(migratedItem.season, "春秋");
  assert.equal(migratedItem.thickness, "适中");
  assert.equal(migratedItem.pattern, "纯色");
  assert.equal(migratedItem.material, "棉混纺");
  assert.deepEqual(migratedItem.styles, ["简约"]);
  assert.deepEqual(migratedItem.scenes, ["休闲"]);

  const communityPost = readResponse(await main(makeEvent("/api/community/posts", "POST", {
    itemIds: ["1", "2"], scene: "通勤", note: "用已有衣物搭出轻松通勤感"
  }, authorization)));
  assert.equal(communityPost.status, 201);
  assert.equal(communityPost.body.post.status, "pending");
  assert.equal(communityPost.body.post.items.length, 2);
  const emptyCommunityFeed = readResponse(await main(makeEvent("/api/community/posts", "GET", null, authorization)));
  assert.equal(emptyCommunityFeed.body.posts.length, 0);
  const ownCommunityPosts = readResponse(await main(makeEvent("/api/community/posts?scope=mine", "GET", null, authorization)));
  assert.equal(ownCommunityPosts.body.posts[0].status, "pending");
  const approvedCommunityPost = readResponse(await main(makeEvent(`/api/community/admin/posts/${communityPost.body.post.id}`, "PATCH", {
    status: "approved"
  }, authorization)));
  assert.equal(approvedCommunityPost.status, 200);
  const selfLike = readResponse(await main(makeEvent(`/api/community/posts/${communityPost.body.post.id}/like`, "PUT", { action: "like" }, authorization)));
  assert.equal(selfLike.status, 400);

  // 好友帮搭必须是登录后的点对点分享：令牌本身不返回完整衣橱，受邀新用户注册后只加入本次请求。
  const unauthenticatedRequest = readResponse(await main(makeEvent("/api/outfit-requests/not-a-real-token", "GET")));
  assert.equal(unauthenticatedRequest.status, 401);
  const outfitRequest = readResponse(await main(makeEvent("/api/outfit-requests", "POST", {
    itemIds: ["1"], question: "这件上衣适合周末见朋友吗？"
  }, authorization)));
  assert.equal(outfitRequest.status, 201);
  assert.ok(outfitRequest.body.token.length >= 20);
  assert.equal(outfitRequest.body.items[0].name, "衣物1");
  const guestRegistration = readResponse(await main(makeEvent("/api/auth/outfit-guest-register", "POST", {
    token: outfitRequest.body.token, username: "friend-one", password: "password123"
  })));
  assert.equal(guestRegistration.status, 201);
  const friendAuthorization = { authorization: `Bearer ${guestRegistration.body.token}` };
  const friendCannotReviewCommunity = readResponse(await main(makeEvent("/api/community/admin/review", "GET", null, friendAuthorization)));
  assert.equal(friendCannotReviewCommunity.status, 403);
  const friendLike = readResponse(await main(makeEvent(`/api/community/posts/${communityPost.body.post.id}/like`, "PUT", { action: "like" }, friendAuthorization)));
  assert.equal(friendLike.status, 200);
  assert.equal(friendLike.body.likeCount, 1);
  const repeatedFriendLike = readResponse(await main(makeEvent(`/api/community/posts/${communityPost.body.post.id}/like`, "PUT", { action: "like" }, friendAuthorization)));
  assert.equal(repeatedFriendLike.body.likeCount, 1);
  const communityReport = readResponse(await main(makeEvent(`/api/community/posts/${communityPost.body.post.id}/report`, "POST", { reason: "不当内容" }, friendAuthorization)));
  assert.equal(communityReport.status, 201);
  const communityReview = readResponse(await main(makeEvent("/api/community/admin/review", "GET", null, authorization)));
  assert.equal(communityReview.status, 200);
  assert.equal(communityReview.body.reports.length, 1);
  assert.equal(communityReview.body.reports[0].post.id, communityPost.body.post.id);
  const resolvedCommunityReport = readResponse(await main(makeEvent(`/api/community/admin/reports/${communityReview.body.reports[0].id}`, "PATCH", { action: "dismiss" }, authorization)));
  assert.equal(resolvedCommunityReport.status, 200);
  const sharedView = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}`, "GET", null, friendAuthorization)));
  assert.equal(sharedView.status, 200);
  assert.equal(sharedView.body.items.length, 1);
  assert.equal(sharedView.body.items[0].price, undefined);
  const friendReply = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}/responses`, "POST", {
    verdict: "like", comment: "颜色很适合周末，搭配浅色鞋子会更轻松。"
  }, friendAuthorization)));
  assert.equal(friendReply.status, 201);
  const ownerResults = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(ownerResults.status, 200);
  assert.equal(ownerResults.body.summary.like, 1);
  const report = readResponse(await main(makeEvent(`/api/outfit-responses/${ownerResults.body.responses[0].id}/report`, "POST", { reason: "测试举报" }, authorization)));
  assert.equal(report.status, 200);
  const reportedResults = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(reportedResults.body.responses[0].hidden, true);
  const closedRequest = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/close`, "POST", {}, authorization)));
  assert.equal(closedRequest.status, 200);
  const replyAfterClose = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}/responses/me`, "PATCH", {
    verdict: "neutral", comment: "关闭后不能再修改。"
  }, friendAuthorization)));
  assert.equal(replyAfterClose.status, 403);

  const deletionRequest = readResponse(await main(makeEvent("/api/outfit-requests", "POST", {
    itemIds: ["2"], question: "移出衣橱后应关闭分享。"
  }, authorization)));
  assert.equal(deletionRequest.status, 201);
  const deletedSharedItem = readResponse(await main(makeEvent("/api/items/2", "DELETE", {}, authorization)));
  assert.equal(deletedSharedItem.status, 200);
  const deletedStoredItem = await memoryDatabase.collection("wr_clothing_items").doc("2").get();
  assert.equal(deletedStoredItem.data[0].source_hash, "z".repeat(64));
  assert.equal(deletedStoredItem.data[0].source_hash_key, undefined);
  await memoryDatabase.collection("wr_clothing_items").doc("2").update({ source_hash_key: `1:${"z".repeat(64)}` });
  assert.equal(await _test.findActiveClothingBySourceHash("1", "z".repeat(64)), null);
  const repairedDeletedItem = await memoryDatabase.collection("wr_clothing_items").doc("2").get();
  assert.equal(repairedDeletedItem.data[0].source_hash_key, undefined);
  assert.equal((await _test.findActiveClothingBySourceHash("1", "a".repeat(64))).id, "1");
  const closedAfterItemDelete = readResponse(await main(makeEvent(`/api/outfit-requests/${deletionRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(closedAfterItemDelete.body.request.status, "closed");

  const wear = readResponse(await main(makeEvent("/api/items/1/wear-logs", "POST", { scene: "日常", comfort: "舒适" }, authorization)));
  assert.equal(wear.status, 201);
  assert.equal(wear.body.reward.awardedPoints, 1);
  assert.equal(wear.body.reward.balance, 1);

  const firstRewardSummary = readResponse(await main(makeEvent("/api/rewards/me", "GET", null, authorization)));
  assert.equal(firstRewardSummary.status, 200);
  assert.equal(firstRewardSummary.body.balance, 1);
  assert.equal(firstRewardSummary.body.monthCheckinDays, 1);
  assert.equal(firstRewardSummary.body.events[0].type, "daily_checkin");
  assert.equal(firstRewardSummary.body.exchangeEnabled, false);
  assert.ok(firstRewardSummary.body.rewards.every((reward) => reward.exchangeEnabled === false));

  const wearHistory = readResponse(await main(makeEvent("/api/items/1/wear-logs", "GET", null, authorization)));
  assert.equal(wearHistory.status, 200);
  assert.equal(wearHistory.body.length, 7);
  assert.equal(wearHistory.body[0].scene, "日常");
  assert.equal(wearHistory.body[0].comfort, "舒适");
  assert.match(wearHistory.body[0].wornAt, /^\d{4}-\d{2}-\d{2}T/);

  const februaryCalendar = readResponse(await main(makeEvent(
    "/api/wear-logs?start=2026-02-01T00%3A00%3A00.000Z&end=2026-03-01T00%3A00%3A00.000Z",
    "GET",
    null,
    authorization
  )));
  assert.equal(februaryCalendar.status, 200);
  assert.equal(februaryCalendar.body.length, 6);
  assert.equal(februaryCalendar.body[0].item.name, "衣物1");
  assert.equal(februaryCalendar.body[0].item.active, true);

  const invalidCalendarRange = readResponse(await main(makeEvent("/api/wear-logs?start=bad&end=also-bad", "GET", null, authorization)));
  assert.equal(invalidCalendarRange.status, 400);

  const updatedItems = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(updatedItems.body.find((item) => item.id === "1").wear_count, 7);

  const sameDayWear = readResponse(await main(makeEvent("/api/items/1/wear-logs", "POST", { scene: "休闲", comfort: "舒适" }, authorization)));
  assert.equal(sameDayWear.status, 201);
  assert.equal(sameDayWear.body.reward.awardedPoints, 0);
  assert.equal(sameDayWear.body.reward.duplicateDay, true);
  const sameDayRewardSummary = readResponse(await main(makeEvent("/api/rewards/me", "GET", null, authorization)));
  assert.equal(sameDayRewardSummary.body.balance, 1);
  assert.equal(sameDayRewardSummary.body.monthCheckinDays, 1);
  const starAdminSummary = readResponse(await main(makeEvent("/api/admin/star-summary?start=2026-01-01T00:00:00.000Z&end=2030-01-01T00:00:00.000Z", "GET", null, { "x-admin-token": "test-admin-token" })));
  assert.equal(starAdminSummary.status, 200);
  assert.equal(starAdminSummary.body.activeUsers, 1);
  assert.equal(starAdminSummary.body.checkinEvents, 1);
  assert.equal(starAdminSummary.body.totalIssued, 1);
  assert.equal(starAdminSummary.body.redemptionEvents, 0);
  assert.equal(starAdminSummary.body.exchangeEnabled, false);
  const ordinaryUserCannotReadStarCosts = readResponse(await main(makeEvent("/api/admin/star-summary", "GET", null, authorization)));
  assert.equal(ordinaryUserCannotReadStarCosts.status, 401);

  const markedIdle = readResponse(await main(makeEvent("/api/items/1/idle", "POST", { reason: "很少穿", note: "先放进私人清单观察。" }, authorization)));
  assert.equal(markedIdle.status, 200);
  assert.equal(markedIdle.body.idle_status, "considering");
  const idleItems = readResponse(await main(makeEvent("/api/idle-items", "GET", null, authorization)));
  assert.equal(idleItems.status, 200);
  assert.equal(idleItems.body.length, 1);
  assert.equal(idleItems.body[0].idleReason, "很少穿");
  assert.equal(idleItems.body[0].idleNote, "先放进私人清单观察。");
  assert.match(idleItems.body[0].lastWornAt, /^\d{4}-\d{2}-\d{2}T/);
  const singleItem = readResponse(await main(makeEvent("/api/items/1", "GET", null, authorization)));
  assert.equal(singleItem.status, 200);
  assert.equal(singleItem.body.id, "1");
  const friendCannotReadItem = readResponse(await main(makeEvent("/api/items/1", "GET", null, friendAuthorization)));
  assert.equal(friendCannotReadItem.status, 404);
  const savedListing = readResponse(await main(makeEvent("/api/items/1/listing", "PUT", {
    mode: "rent", condition: "九成新", dailyRent: 10, deposit: 100, minDays: 2,
    delivery: "同城当面交付", note: "请爱惜衣物", platform: "闲鱼", url: "https://example.com/item/1", status: "listed"
  }, authorization)));
  assert.equal(savedListing.status, 200);
  assert.equal(savedListing.body.listing_mode, "rent");
  assert.equal(savedListing.body.listing_daily_rent, 10);
  assert.equal(savedListing.body.listing_status, "listed");
  const friendCannotMarkIdle = readResponse(await main(makeEvent("/api/items/1/idle", "POST", { reason: "重复" }, friendAuthorization)));
  assert.equal(friendCannotMarkIdle.status, 404);
  const invalidIdleReason = readResponse(await main(makeEvent("/api/items/1/idle", "POST", { reason: "自动判定" }, authorization)));
  assert.equal(invalidIdleReason.status, 400);
  const restoredIdle = readResponse(await main(makeEvent("/api/items/1/idle", "DELETE", null, authorization)));
  assert.equal(restoredIdle.status, 200);
  assert.equal(restoredIdle.body.idle_status, "active");

  const planPayload = {
    idempotencyKey: "outfit-plan-create-1",
    canvas: { width: 360, height: 600 },
    layers: [
      { key: "top-layer", itemId: "1", x: 30, y: 40, scale: 1.1, rotation: 0, z: 1, imageUrl: "https://expired.test/one" },
      { key: "bottom-layer", itemId: "3", x: 50, y: 260, scale: 1, rotation: 0, z: 2 }
    ]
  };
  const createdPlan = readResponse(await main(makeEvent("/api/outfit-plans", "POST", planPayload, authorization)));
  assert.equal(createdPlan.status, 201);
  assert.equal(createdPlan.body.layers.length, 2);
  assert.equal(JSON.stringify(createdPlan.body).includes("expired.test"), false);
  assert.match(createdPlan.body.layers[0].imageUrl, /^https:\/\/images\.test\//);
  const repeatedPlan = readResponse(await main(makeEvent("/api/outfit-plans", "POST", planPayload, authorization)));
  assert.equal(repeatedPlan.status, 200);
  assert.equal(repeatedPlan.body.id, createdPlan.body.id);
  const updatedPlan = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "PUT", {
    ...planPayload, layers: planPayload.layers.map((layer, index) => index === 0 ? { ...layer, x: 88 } : layer)
  }, authorization)));
  assert.equal(updatedPlan.status, 200);
  assert.equal(updatedPlan.body.layers[0].x, 88);
  const renamedPlan = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "PATCH", { title: " 周一通勤 " }, authorization)));
  assert.equal(renamedPlan.status, 200);
  assert.equal(renamedPlan.body.title, "周一通勤");
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "PATCH", { title: "   " }, authorization))).status, 400);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "PATCH", { title: "一".repeat(31) }, authorization))).status, 400);
  const copyPayload = { idempotencyKey: "outfit-plan-copy-1" };
  const copiedPlan = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}/copy`, "POST", copyPayload, authorization)));
  assert.equal(copiedPlan.status, 201);
  assert.notEqual(copiedPlan.body.id, createdPlan.body.id);
  assert.equal(copiedPlan.body.title, "周一通勤 副本");
  assert.deepEqual(copiedPlan.body.canvas, renamedPlan.body.canvas);
  assert.deepEqual(copiedPlan.body.layers, renamedPlan.body.layers);
  const repeatedCopy = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}/copy`, "POST", copyPayload, authorization)));
  assert.equal(repeatedCopy.status, 200);
  assert.equal(repeatedCopy.body.id, copiedPlan.body.id);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}/copy`, "POST", copyPayload, memberAuthorization))).status, 404);
  const memberPlans = readResponse(await main(makeEvent("/api/outfit-plans", "GET", null, memberAuthorization)));
  assert.deepEqual(memberPlans.body, []);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "DELETE", null, memberAuthorization))).status, 404);

  const wornPayload = { date: "2026-08-11", scene: "通勤", note: "按保存方案实际穿着", idempotencyKey: "outfit-plan-wear-1" };
  const wearCountBeforePlan = readResponse(await main(makeEvent("/api/items/1", "GET", null, authorization))).body.wear_count;
  const wornPlan = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}/wear`, "POST", wornPayload, authorization)));
  assert.equal(wornPlan.status, 201);
  assert.equal(wornPlan.body.recordedCount, 2);
  const repeatedWear = readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}/wear`, "POST", wornPayload, authorization)));
  assert.equal(repeatedWear.status, 200);
  assert.equal(repeatedWear.body.recordId, wornPlan.body.recordId);
  assert.equal(repeatedWear.body.duplicate, true);
  assert.equal(readResponse(await main(makeEvent("/api/items/1", "GET", null, authorization))).body.wear_count, wearCountBeforePlan + 1);
  const augustCalendar = readResponse(await main(makeEvent(
    "/api/wear-logs?start=2026-08-01T00%3A00%3A00.000Z&end=2026-09-01T00%3A00%3A00.000Z",
    "GET", null, authorization
  )));
  const savedOutfitLogs = augustCalendar.body.filter((log) => log.outfitRecordId === wornPlan.body.recordId);
  assert.equal(savedOutfitLogs.length, 2);
  assert.ok(savedOutfitLogs.every((log) => log.outfitTitle === renamedPlan.body.title));
  const wornRecord = readResponse(await main(makeEvent(`/api/outfit-records/${wornPlan.body.recordId}`, "GET", null, authorization)));
  assert.equal(wornRecord.status, 200);
  assert.equal(wornRecord.body.title, renamedPlan.body.title);
  assert.equal(wornRecord.body.scene, wornPayload.scene);
  assert.equal(wornRecord.body.note, wornPayload.note);
  assert.equal(wornRecord.body.items.length, 2);
  assert.equal(wornRecord.body.layers.length, 2);
  assert.match(wornRecord.body.layers[0].imageUrl, /^https:\/\/images\.test\//);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-records/${wornPlan.body.recordId}`, "GET", null, memberAuthorization))).status, 404);
  assert.equal(readResponse(await main(makeEvent(`/api/outfit-plans/${createdPlan.body.id}`, "DELETE", null, authorization))).status, 204);
  const calendarAfterPlanDelete = readResponse(await main(makeEvent(
    "/api/wear-logs?start=2026-08-01T00%3A00%3A00.000Z&end=2026-09-01T00%3A00%3A00.000Z",
    "GET", null, authorization
  )));
  assert.equal(calendarAfterPlanDelete.body.filter((log) => log.outfitRecordId === wornPlan.body.recordId).length, 2);
  const wornRecordAfterPlanDelete = readResponse(await main(makeEvent(`/api/outfit-records/${wornPlan.body.recordId}`, "GET", null, authorization)));
  assert.equal(wornRecordAfterPlanDelete.status, 200);
  assert.equal(wornRecordAfterPlanDelete.body.layers.length, 2);

  const upload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "closet",
    idempotencyKey: "test-upload-1"
  }, authorization)));
  assert.equal(upload.status, 201);

  const recognitionBeforeMatting = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/recognition`, "POST", {}, authorization)));
  assert.equal(recognitionBeforeMatting.status, 409);
  const budgetAfterRejectedOrder = readResponse(await main(makeEvent("/api/ai-budget", "GET", null, authorization)));
  assert.equal(budgetAfterRejectedOrder.body.remainingYuan, budgetAfterMultiDetection.body.remainingYuan);

  const matting = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/matting`, "POST", {}, authorization)));
  assert.equal(matting.status, 200);
  assert.equal(matting.body.providerName, "腾讯数据万象");
  assert.equal(matting.body.stage, "awaiting_recognition");
  const repeatedMatting = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/matting`, "POST", {}, authorization)));
  assert.equal(repeatedMatting.status, 200);
  assert.equal(mattingCallCount, 1);
  const hangerEdit = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/hanger-removal`, "POST", {}, authorization)));
  assert.equal(hangerEdit.status, 200);
  assert.equal(hangerEdit.body.modelName, "qwen-image-2.0");
  assert.equal(hangerEdit.body.selectedImage, "original");
  assert.match(hangerEdit.body.hangerEditUrl, /no-hanger/);
  const repeatedHangerEdit = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/hanger-removal`, "POST", {}, authorization)));
  assert.equal(repeatedHangerEdit.status, 200);
  assert.equal(hangerEditCallCount, 1);
  const selectedEdit = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/image-selection`, "POST", { choice: "hanger_edit" }, authorization)));
  assert.equal(selectedEdit.status, 200);
  assert.equal(selectedEdit.body.selectedImage, "hanger_edit");
  const recognition = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/recognition`, "POST", {}, authorization)));
  assert.equal(recognition.status, 200);
  assert.equal(recognition.body.tags.category, "上衣");
  assert.equal(recognition.body.tags.season, "春夏");
  assert.deepEqual(recognition.body.tags.designDetails, ["荷叶边"]);
  assert.equal(recognition.body.budget.successfulTasks, budgetAfterMultiDetection.body.successfulTasks + 1);
  assert.equal(recognition.body.providerName, "阿里云百炼");
  assert.equal(recognition.body.modelName, "qwen3-vl-plus");
  assert.equal(lastRecognitionKey, "cutouts/new-item-no-hanger.png");
  const quotaAfterRecognition = readResponse(await main(makeEvent("/api/entitlements/me", "GET", null, authorization)));
  assert.equal(quotaAfterRecognition.body.quota.recognition.used, 1);
  assert.equal(quotaAfterRecognition.body.quota.hangerRemoval.used, 1);

  const replay = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/recognition`, "POST", {}, authorization)));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.draftId, recognition.body.draftId);
  assert.equal(replay.body.budget.successfulTasks, recognition.body.budget.successfulTasks);
  const otherUserCannotReadTask = readResponse(await main(makeEvent(`/api/tasks/${upload.body.taskId}/matting`, "POST", {}, friendAuthorization)));
  assert.equal(otherUserCannotReadTask.status, 404);

  // 测试环境只暴露安全阶段、错误码、HTTP 状态和请求号，绝不返回密钥或供应商完整响应。
  cloudServices.sourceHash = async () => {
    throw Object.assign(new Error("fixture access denied"), { code: "AccessDenied", statusCode: 403 });
  };
  const failedUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "closet",
    idempotencyKey: "test-upload-access-denied"
  }, authorization)));
  const failedRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: failedUpload.body.taskId
  }, authorization)));
  assert.equal(failedRecognition.status, 500);
  assert.equal(failedRecognition.body.aiTaskStage, "read_source");
  assert.equal(failedRecognition.body.providerCode, "AccessDenied");
  assert.equal(failedRecognition.body.providerStatus, 403);
  assert.equal(failedRecognition.body.providerMessage, "fixture access denied");
  assert.equal(failedRecognition.body.buildId, "2026-08-20-relative-formality-agent-v87");
  assert.match(failedRecognition.body.requestId, /^[a-f0-9]{8}$/);
  cloudServices.sourceHash = async () => "c".repeat(64);
  const retriedRecognition = readResponse(await main(makeEvent(`/api/tasks/${failedUpload.body.taskId}/retry`, "POST", {}, authorization)));
  assert.equal(retriedRecognition.status, 200);
  assert.equal(retriedRecognition.body.tags.category, "上衣");
  assert.equal(retriedRecognition.body.provider, "dashscope");

  const successfulExtractGarment = cloudServices.extractGarment;
  const recognitionCallsBeforeQualityFailure = recognitionCallCount;
  cloudServices.extractGarment = async () => {
    mattingCallCount += 1;
    throw Object.assign(new Error("背景去除不完整，请换一张衣物边缘更清楚、四周留有空间的图片。"), {
      status: 422,
      code: "MATTING_QUALITY_LOW",
      providerCallCount: 2
    });
  };
  const lowQualityUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "closet",
    idempotencyKey: "test-low-matting-quality"
  }, authorization)));
  const lowQualityMatting = readResponse(await main(makeEvent(`/api/tasks/${lowQualityUpload.body.taskId}/matting`, "POST", {}, authorization)));
  assert.equal(lowQualityMatting.status, 422);
  assert.equal(lowQualityMatting.body.providerCode, "MATTING_QUALITY_LOW");
  assert.equal(recognitionCallCount, recognitionCallsBeforeQualityFailure);
  cloudServices.extractGarment = successfulExtractGarment;

  const usageSummary = readResponse(await main(makeEvent("/api/admin/ai-usage-summary?start=2026-01-01T00:00:00.000Z&end=2030-01-01T00:00:00.000Z", "GET", null, { "x-admin-token": "test-admin-token" })));
  assert.equal(usageSummary.status, 200);
  assert.ok(usageSummary.body.promptTokens >= 2000);
  assert.ok(usageSummary.body.completionTokens >= 400);
  assert.ok(usageSummary.body.mattingCalls >= 4);
  assert.equal(usageSummary.body.imageEditCalls, 1);
  assert.equal(usageSummary.body.imageEditCostYuan, 0.2);
  assert.equal(usageSummary.body.revenueYuan, null);
  assert.equal(usageSummary.body.grossMarginYuan, null);
  const ordinaryUserCannotReadUsage = readResponse(await main(makeEvent("/api/admin/ai-usage-summary", "GET", null, authorization)));
  assert.equal(ordinaryUserCannotReadUsage.status, 401);

  const saved = readResponse(await main(makeEvent("/api/items", "POST", {
    draftId: recognition.body.draftId,
    sourceType: "outfit_supplement",
    name: "用户确认后的上衣",
    category: "上衣",
    color: "浅紫",
    season: "春夏",
    thickness: "薄",
    pattern: "纯色",
    material: "棉混纺",
    designDetails: ["荷叶边", "短袖"],
    styles: ["温柔"],
    scenes: ["休闲"]
  }, authorization)));
  assert.equal(saved.status, 201);
  assert.equal(saved.body.name, "用户确认后的上衣");
  assert.equal(saved.body.material, "棉混纺");
  assert.deepEqual(saved.body.designDetails, ["荷叶边"]);
  assert.equal(saved.body.source_type, "outfit_supplement");

  cloudServices.sourceHash = async () => "d".repeat(64);
  const manualUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "manual",
    idempotencyKey: "test-manual-matting-1"
  }, authorization)));
  const recognitionCallsBeforeManual = recognitionCallCount;
  const manualMatting = readResponse(await main(makeEvent(`/api/tasks/${manualUpload.body.taskId}/matting`, "POST", {}, authorization)));
  assert.equal(manualMatting.status, 200);
  assert.equal(manualMatting.body.stage, "awaiting_manual_fields");
  assert.match(manualMatting.body.cutoutUrl, /cutouts/);
  assert.equal(recognitionCallCount, recognitionCallsBeforeManual);
  const manualSaved = readResponse(await main(makeEvent("/api/items/manual", "POST", {
    taskId: manualUpload.body.taskId,
    sourceType: "single_item_upload",
    name: "基础抠图手动上衣",
    category: "上衣",
    color: "白色"
  }, authorization)));
  assert.equal(manualSaved.status, 201);
  assert.match(manualSaved.body.imageUrl, /cutouts/);
  assert.equal(manualSaved.body.source_type, "single_item_upload");
  assert.equal(recognitionCallCount, recognitionCallsBeforeManual);

  const candidateUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "candidate",
    idempotencyKey: "test-candidate-upload-1"
  }, authorization)));
  const candidateRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: candidateUpload.body.taskId
  }, authorization)));
  assert.equal(candidateRecognition.status, 201);

  const candidateCreated = readResponse(await main(makeEvent("/api/candidates", "POST", {
    draftId: candidateRecognition.body.draftId,
    name: "候选浅紫衬衫",
    category: "上衣",
    color: "浅紫",
    season: "春夏",
    thickness: "薄",
    pattern: "纯色",
    material: "棉混纺",
    designDetails: ["木耳边", "不存在细节"],
    styles: ["温柔"],
    scenes: ["休闲"],
    price: 199
  }, authorization)));
  assert.equal(candidateCreated.status, 201);
  assert.equal(candidateCreated.body.material, "棉混纺");
  assert.deepEqual(candidateCreated.body.designDetails, ["木耳边"]);
  assert.match(candidateCreated.body.imageUrl, /^https:\/\//);

  const candidateRead = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}`, "GET", null, authorization)));
  assert.equal(candidateRead.status, 200);
  assert.equal(candidateRead.body.name, "候选浅紫衬衫");

  const candidateAnalysis = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}/analyze`, "POST", {}, authorization)));
  assert.equal(candidateAnalysis.status, 200);
  assert.ok(Array.isArray(candidateAnalysis.body.similar));
  assert.ok(Array.isArray(candidateAnalysis.body.compatible));
  assert.equal(candidateAnalysis.body.analysisMode, "visual_hybrid");
  assert.equal(candidateAnalysis.body.similar[0].visualScore, 100);
  assert.match(candidateAnalysis.body.reasons[0], /视觉 70%/);
  assert.match(candidateAnalysis.body.reasons[3], /不代表品牌、货号或电商同款鉴定/);

  // 单件达到高标签重复阈值时，必须明确不建议购买，不能因“只有一件”误判为补缺型。
  const duplicateUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "candidate",
    idempotencyKey: "test-candidate-upload-duplicate"
  }, authorization)));
  assert.equal(duplicateUpload.status, 201);
  const duplicateRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: duplicateUpload.body.taskId
  }, authorization)));
  assert.equal(duplicateRecognition.status, 201);
  const duplicateCandidate = readResponse(await main(makeEvent("/api/candidates", "POST", {
    draftId: duplicateRecognition.body.draftId,
    name: "重复候选上衣",
    category: "上衣",
    color: "灰色",
    scenes: ["休闲"]
  }, authorization)));
  assert.equal(duplicateCandidate.status, 201);
  embeddingShouldFail = true;
  const duplicateAnalysis = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/analyze`, "POST", {}, authorization)));
  assert.equal(duplicateAnalysis.status, 200);
  assert.equal(duplicateAnalysis.body.conclusion, "高度重复，不建议购买");
  assert.equal(duplicateAnalysis.body.analysisMode, "tag_fallback");
  assert.match(duplicateAnalysis.body.fallbackReason, /自动改用用户确认标签/);
  assert.equal(duplicateAnalysis.body.similar[0].score, 90);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /同品类 \+55/);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /同颜色 \+25/);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /共同场景（休闲）\+10/);

  const waitDecision = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/decision`, "POST", {
    decision: "wait"
  }, authorization)));
  assert.equal(waitDecision.status, 200);
  assert.equal(waitDecision.body.addedToWardrobe, false);

  const waitingCandidates = readResponse(await main(makeEvent("/api/candidates?decision=wait", "GET", null, authorization)));
  assert.equal(waitingCandidates.status, 200);
  assert.equal(waitingCandidates.body.length, 1);
  assert.equal(waitingCandidates.body[0].id, duplicateCandidate.body.id);
  assert.equal(waitingCandidates.body[0].waitDays, 0);
  assert.equal(waitingCandidates.body[0].daysRemaining, 7);
  assert.equal(waitingCandidates.body[0].coolingOffComplete, false);

  // 观望只是一种中间状态：再次打开会按当前衣橱重算，并可完成最终购买决定。
  const waitReanalysis = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/analyze`, "POST", {}, authorization)));
  assert.equal(waitReanalysis.status, 200);
  assert.equal(waitReanalysis.body.conclusion, "高度重复，不建议购买");
  const waitPurchase = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/decision`, "POST", {
    decision: "purchased"
  }, authorization)));
  assert.equal(waitPurchase.status, 200);
  assert.equal(waitPurchase.body.addedToWardrobe, true);
  const repeatedWaitPurchase = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/decision`, "POST", {
    decision: "purchased"
  }, authorization)));
  assert.equal(repeatedWaitPurchase.status, 409);
  const waitingAfterDecision = readResponse(await main(makeEvent("/api/candidates?decision=wait", "GET", null, authorization)));
  assert.equal(waitingAfterDecision.status, 200);
  assert.equal(waitingAfterDecision.body.length, 0);

  const candidateDecision = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}/decision`, "POST", {
    decision: "purchased"
  }, authorization)));
  assert.equal(candidateDecision.status, 200);
  assert.equal(candidateDecision.body.addedToWardrobe, true);

  const afterPurchase = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(afterPurchase.body.filter((item) => item.name === "重复候选上衣").length, 1);
  const purchasedItem = afterPurchase.body.find((item) => item.name === "候选浅紫衬衫");
  assert.equal(purchasedItem.material, "棉混纺");
  assert.equal(purchasedItem.season, "春夏");
  assert.deepEqual(purchasedItem.designDetails, ["木耳边"]);

  // 编辑只能改变用户确认字段，不能覆盖图片、归属或穿着次数。
  const updatedItem = readResponse(await main(makeEvent(`/api/items/${purchasedItem.id}`, "PATCH", {
    name: "修改后的浅紫衬衫",
    category: "上衣",
    color: "浅紫",
    season: "春秋",
    thickness: "适中",
    pattern: "纯色",
    material: "棉混纺",
    designDetails: ["泡泡袖", "公主袖"],
    formality: "商务",
    functionTags: ["透气", "弹力", "伪造标签"],
    styles: ["通勤"],
    scenes: ["通勤", "休闲"],
    price: 188
  }, authorization)));
  assert.equal(updatedItem.status, 200);
  assert.equal(updatedItem.body.name, "修改后的浅紫衬衫");
  assert.deepEqual(updatedItem.body.designDetails, ["泡泡袖"]);
  assert.equal(updatedItem.body.formality, "商务");
  assert.deepEqual(updatedItem.body.functionTags, ["透气", "弹力"]);
  assert.equal(updatedItem.body.image_key, purchasedItem.image_key);
  assert.equal(updatedItem.body.wear_count, purchasedItem.wear_count);

  // 删除采用软删除：列表立即排除，数据库记录和穿着历史仍可保留。
  const deletedItem = readResponse(await main(makeEvent(`/api/items/${purchasedItem.id}`, "DELETE", {}, authorization)));
  assert.equal(deletedItem.status, 200);
  const itemsAfterDelete = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(itemsAfterDelete.body.some((item) => item.id === purchasedItem.id), false);
  const deletedStoredResult = await memoryDatabase.collection("wr_clothing_items").doc(purchasedItem.id).get();
  assert.equal(deletedStoredResult.data[0].status, "inactive");

  // 私密灵感截图经过确认后只匹配本人当前衣橱；历史可重开并删除。
  const inspirationCreated = readResponse(await main(makeEvent("/api/inspirations", "POST", {
    sourceType: "user_screenshot",
    mimeType: "image/jpeg",
    idempotencyKey: "inspiration-test-1"
  }, authorization)));
  assert.equal(inspirationCreated.status, 201);
  assert.equal(inspirationCreated.body.record.status, "screenshot_required");
  const inspirationId = inspirationCreated.body.record.id;
  const inspirationAnalyzed = readResponse(await main(makeEvent(`/api/inspirations/${inspirationId}/analyze`, "POST", {}, authorization)));
  assert.equal(inspirationAnalyzed.status, 200);
  assert.equal(inspirationAnalyzed.body.status, "awaiting_confirmation");
  const inspirationConfirmed = readResponse(await main(makeEvent(`/api/inspirations/${inspirationId}/confirm`, "PATCH", {
    summary: "确认后的白色通勤上装",
    slots: [{ slot: "top", category: "上衣", name: "白色通勤上装", color: "白色", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] }]
  }, authorization)));
  assert.equal(inspirationConfirmed.status, 200);
  assert.equal(inspirationConfirmed.body.status, "ready");
  assert.equal(inspirationConfirmed.body.matches[0].candidates.every((candidate) => candidate.item.category === "上衣"), true);
  const inspirationHistory = readResponse(await main(makeEvent("/api/inspirations", "GET", null, authorization)));
  assert.equal(inspirationHistory.body.records.length, 1);
  const inspirationReopened = readResponse(await main(makeEvent(`/api/inspirations/${inspirationId}`, "GET", null, authorization)));
  assert.equal(inspirationReopened.body.status, "ready");
  assert.equal(Array.isArray(inspirationReopened.body.matches), true);
  const firstInspirationCandidateId = inspirationReopened.body.matches[0].candidates[0]?.item.id;
  const inspirationRematched = readResponse(await main(makeEvent(`/api/inspirations/${inspirationId}/rematch`, "POST", {
    preferences: { preferredColors: ["浅紫色"], styles: ["通勤"] },
    excludedItemIds: firstInspirationCandidateId ? [firstInspirationCandidateId] : [],
    lockedItemIds: []
  }, authorization)));
  assert.equal(inspirationRematched.status, 200);
  assert.equal(inspirationRematched.body.status, "ready");
  assert.equal(inspirationRematched.body.matches[0].candidates.some((candidate) => candidate.item.id === firstInspirationCandidateId), false);
  const inspirationDeleted = readResponse(await main(makeEvent(`/api/inspirations/${inspirationId}`, "DELETE", {}, authorization)));
  assert.equal(inspirationDeleted.status, 204);
  const inspirationHistoryAfterDelete = readResponse(await main(makeEvent("/api/inspirations", "GET", null, authorization)));
  assert.equal(inspirationHistoryAfterDelete.body.records.length, 0);

  // 平台图两次都无法形成槽位时转截图兜底；用户截图则提示更换截图，两者都正常返回记录。
  const timestamp = "2026-08-10T00:00:00.000Z";
  await memoryDatabase.collection("wr_inspiration_records").add({
    _id: "inspiration-link-fallback",
    user_id: String(login.body.user.id),
    idempotency_key: "inspiration-link-fallback",
    source_type: "xiaohongshu_link",
    platform: "xiaohongshu",
    source_url: "https://xhslink.cn/o/test",
    source_title: "夏天的白色连衣裙穿搭",
    source_author: "公开作者",
    saved_image_key: "",
    temporary_image_keys: ["inspiration-temporary/user/link/0.jpg"],
    temporary_deleted_at: "",
    status: "ready_to_analyze",
    detected_outfit: {},
    confirmed_slots: [],
    summary: "",
    error_code: "",
    created_at: timestamp,
    updated_at: timestamp
  });
  cloudServices.analyzeInspirationImages = async () => {
    throw Object.assign(new Error("没有识别到可确认的主要穿搭。"), {
      code: "INSPIRATION_NO_OUTFIT",
      status: 422,
      providerUsage: { prompt_tokens: 20, completion_tokens: 4 },
      safeDiagnostic: { retryCount: 1, first: { rawSlotCount: 1 }, second: { rawSlotCount: 0 } }
    });
  };
  const linkFallback = readResponse(await main(makeEvent("/api/inspirations/inspiration-link-fallback/analyze", "POST", {}, authorization)));
  assert.equal(linkFallback.status, 200);
  assert.equal(linkFallback.body.status, "screenshot_required");
  assert.equal(deletedCloudKeys.includes("inspiration-temporary/user/link/0.jpg"), true);

  const screenshotFallbackCreated = readResponse(await main(makeEvent("/api/inspirations", "POST", {
    sourceType: "user_screenshot", mimeType: "image/jpeg", idempotencyKey: "screenshot-no-outfit"
  }, authorization)));
  const screenshotFallback = readResponse(await main(makeEvent(`/api/inspirations/${screenshotFallbackCreated.body.record.id}/analyze`, "POST", {}, authorization)));
  assert.equal(screenshotFallback.status, 200);
  assert.equal(screenshotFallback.body.status, "failed");
  cloudServices.analyzeInspirationImages = successfulInspirationAnalysis;

  // 投诉必须登录、限制类型和长度，并由云函数写入只读集合。
  const unauthenticatedComplaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "功能问题", detail: "无法正常使用好友帮搭。"
  })));
  assert.equal(unauthenticatedComplaint.status, 401);
  const invalidComplaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "未知类型", detail: "短"
  }, authorization)));
  assert.equal(invalidComplaint.status, 400);
  const complaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "功能问题", detail: "无法正常使用好友帮搭。", contact: "test@example.com"
  }, authorization)));
  assert.equal(complaint.status, 201);
  assert.equal(complaint.body.status, "submitted");

  const inspirationBeforeAccountDeletion = readResponse(await main(makeEvent("/api/inspirations", "POST", {
    sourceType: "user_screenshot", mimeType: "image/jpeg", idempotencyKey: "delete-with-account"
  }, authorization)));
  assert.equal(inspirationBeforeAccountDeletion.status, 201);

  // 面试 Demo 只通过服务端绑定用户读取数据，不返回 JWT，也不接受任何写请求。
  process.env.DEMO_READONLY_USER_ID = String(login.body.user.id);
  const demoBootstrap = readResponse(await main(makeEvent(
    "/api/demo/bootstrap?start=2026-08-01T00%3A00%3A00.000Z&end=2026-09-01T00%3A00%3A00.000Z"
  )));
  assert.equal(demoBootstrap.status, 200);
  assert.equal(demoBootstrap.body.readonly, true);
  assert.equal(demoBootstrap.body.user.username, "tester");
  assert.equal(Array.isArray(demoBootstrap.body.items), true);
  assert.equal(Array.isArray(demoBootstrap.body.outfitPlans), true);
  assert.equal(Array.isArray(demoBootstrap.body.wearLogs), true);
  assert.equal("token" in demoBootstrap.body, false);
  const demoWrite = readResponse(await main(makeEvent("/api/demo/bootstrap", "POST", {})));
  assert.equal(demoWrite.status, 405);
  const demoSession = readResponse(await main(makeEvent("/api/demo/session", "GET")));
  assert.equal(demoSession.status, 200);
  assert.equal(demoSession.body.user.demoSession, true);
  assert.equal(typeof demoSession.body.token, "string");
  const demoAuthorization = { authorization: `Bearer ${demoSession.body.token}` };
  const demoAssistant = readResponse(await main(makeEvent("/api/outfit-assistant/understand", "POST", {
    message: "约会想穿得休闲一点", recentMessages: [{ role: "user", content: "明天见朋友" }],
    followupUsed: false, idempotencyKey: "scoped-demo-chat"
  }, demoAuthorization)));
  assert.equal(demoAssistant.status, 200);
  assert.equal(demoAssistant.body.preferences.scene, "约会");
  const demoInspiration = readResponse(await main(makeEvent("/api/inspirations", "POST", {
    sourceType: "user_screenshot", mimeType: "image/jpeg", idempotencyKey: "scoped-demo-inspiration"
  }, demoAuthorization)));
  assert.equal(demoInspiration.status, 201);
  await memoryDatabase.collection("wr_inspiration_records").doc(demoInspiration.body.record.id).update({
    status: "ready",
    confirmed_slots: [{ slot: "top", category: "上衣", name: "通勤上衣", color: "白色", season: "多季", thickness: "适中", pattern: "纯色", styles: ["通勤"], scenes: ["通勤"] }]
  });
  const demoRematch = readResponse(await main(makeEvent(`/api/inspirations/${demoInspiration.body.record.id}/rematch`, "POST", {
    preferences: { styles: ["通勤"] }, lockedItemIds: [], excludedItemIds: []
  }, demoAuthorization)));
  assert.equal(demoRematch.status, 200);
  assert.equal(Array.isArray(demoRematch.body.matches), true);
  const blockedDemoDeletion = readResponse(await main(makeEvent("/api/auth/delete-request", "POST", {}, demoAuthorization)));
  assert.equal(blockedDemoDeletion.status, 403);
  delete process.env.DEMO_READONLY_USER_ID;
  const previousLyrouterConfig = process.env.LYROUTER_CONFIG;
  process.env.LYROUTER_CONFIG = JSON.stringify({ du: "tester" });
  const mergedConfigDemo = readResponse(await main(makeEvent(
    "/api/demo/bootstrap?start=2026-08-01T00%3A00%3A00.000Z&end=2026-09-01T00%3A00%3A00.000Z"
  )));
  assert.equal(mergedConfigDemo.status, 200);
  assert.equal(mergedConfigDemo.body.user.username, "tester");
  if (previousLyrouterConfig === undefined) delete process.env.LYROUTER_CONFIG;
  else process.env.LYROUTER_CONFIG = previousLyrouterConfig;

  // 注销后旧 JWT 也必须立即失效，不能只阻止下一次登录。
  const accountDeletion = readResponse(await main(makeEvent("/api/auth/delete-request", "POST", {}, authorization)));
  assert.equal(accountDeletion.status, 202);
  const inspirationsAfterAccountDeletion = await memoryDatabase.collection("wr_inspiration_records").where({ user_id: String(login.body.user.id) }).get();
  assert.equal(inspirationsAfterAccountDeletion.data.length, 0);
  const accessAfterDeletion = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(accessAfterDeletion.status, 401);
  const loginAfterDeletion = readResponse(await main(makeEvent("/api/auth/login", "POST", {
    username: "tester", password: "password123"
  })));
  assert.equal(loginAfterDeletion.status, 401);
});
