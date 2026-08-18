"use strict";

const ALLOWED_SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const ALLOWED_STYLES = ["韩系", "清新", "酷飒", "简约", "休闲", "通勤", "复古", "甜美", "运动", "街头", "优雅", "度假"];
const ALLOWED_CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];

const cleanText = (value, max = 200) => String(value || "").trim().slice(0, max);
const cleanList = (value, allowed = null, max = 4) => Array.isArray(value)
  ? [...new Set(value.map((entry) => cleanText(entry, 20)).filter((entry) => entry && (!allowed || allowed.includes(entry))))].slice(0, max)
  : [];

const cleanOutfitFacts = (value) => Array.isArray(value) ? value.slice(0, 4).map((item) => ({
  name: cleanText(item?.name, 40),
  category: ALLOWED_CATEGORIES.includes(item?.category) ? item.category : "",
  color: cleanText(item?.color, 20),
  reasons: cleanList(item?.reasons, null, 3)
})).filter((item) => item.name || item.category) : [];

const shouldFallbackToRules = (error = {}) => {
  const code = cleanText(error.code, 80).toLowerCase();
  const providerStatus = Number(error.providerStatus || error.providerStatusCode || error.statusCode || 0);
  if (code === "outfit_assistant_output_invalid") return true;
  if ([502, 503, 504].includes(providerStatus)) return true;
  return ["billing_maintenance", "vision_timeout", "vision_upstream_error"].includes(code);
};

function normalizePreferences(raw = {}, followupUsed = false, current = {}) {
  const mode = raw.mode === "new" || !Object.keys(current || {}).length ? "new" : "modify";
  const base = mode === "modify" ? current : {};
  const field = (camel, snake) => raw[camel] !== undefined ? raw[camel] : raw[snake] !== undefined ? raw[snake] : base[camel];
  const sceneValue = raw.scene !== undefined ? raw.scene : base.scene;
  const scene = ALLOWED_SCENES.includes(sceneValue) ? sceneValue : "休闲";
  const styles = cleanList(field("styles", "styles"), ALLOWED_STYLES, 3);
  const preferredCategories = cleanList(field("preferredCategories", "preferred_categories"), ALLOWED_CATEGORIES, 4);
  const excludedCategories = cleanList(field("excludedCategories", "excluded_categories"), ALLOWED_CATEGORIES, 4);
  const preferredColors = cleanList(field("preferredColors", "preferred_colors"), null, 4);
  const excludedColors = cleanList(field("excludedColors", "excluded_colors"), null, 4);
  const warmthValue = field("warmthPreference", "warmth_preference");
  const warmthPreference = ["warmer", "cooler", "normal"].includes(warmthValue) ? warmthValue : "normal";
  const needsClarification = !followupUsed && (raw.needsClarification ?? raw.needs_clarification) === true;
  const actionValue = raw.action;
  const action = ["recommend", "answer", "reroll"].includes(actionValue) ? actionValue : "recommend";
  return {
    mode, action,
    scene,
    styles,
    preferredCategories,
    excludedCategories,
    preferredColors,
    excludedColors,
    warmthPreference,
    needsClarification,
    question: needsClarification ? cleanText(raw.question, 60) || "今天主要是什么场合，想偏什么风格？" : "",
    summary: cleanText(raw.summary, 80) || `按${scene}场景从真实衣橱推荐`,
    reply: cleanText(raw.reply, 160)
  };
}

function outfitExplanation(input = {}, current = {}) {
  const facts = cleanOutfitFacts(input.currentOutfitFacts);
  if (!facts.length) return "我还没有可解释的最新搭配。你可以先告诉我场景、风格或想穿的品类。";
  const itemText = facts.map((item) => `${item.color || ""}${item.name || item.category}`).filter(Boolean).join("、");
  const reasons = [...new Set(facts.flatMap((item) => item.reasons || []))].slice(0, 3);
  return `这套用了${itemText}，${reasons.length ? `主要因为${reasons.join("；")}` : `优先满足${current.scene || "休闲"}场景并通过当前天气筛选`}。`;
}

function inferPreferencesFromText(input = {}) {
  const text = `${cleanText(input.previous, 300)} ${cleanText(input.current, 300)}`.trim();
  const includesAny = (words) => words.some((word) => text.includes(word));
  const sceneRules = [
    ["通勤", ["通勤", "上班", "开会", "面试"]], ["约会", ["约会"]],
    ["旅行", ["旅行", "旅游", "出游"]], ["聚会", ["聚会", "派对", "宴会"]],
    ["运动", ["运动", "健身", "跑步"]], ["休闲", ["上课", "逛街", "散步", "日常", "休闲"]]
  ];
  const sceneMatch = sceneRules.find(([, words]) => includesAny(words));
  const current = input.contextPreferences || {};
  const asksWhy = includesAny(["为什么", "为什么推荐", "推荐理由", "怎么搭", "合适吗"]);
  const asksReroll = includesAny(["换一套", "再来一套", "下一套", "换个搭配"]);
  const isNew = !Object.keys(current).length || includesAny(["重新推荐", "重新搭配", "换个场合", "另一套需求"]);
  const styles = ALLOWED_STYLES.filter((style) => text.includes(style)).slice(0, 3);
  if (text.includes("温柔") && !styles.includes("甜美")) styles.push("甜美");
  if (includesAny(["隆重", "精致", "有气质"]) && !styles.includes("优雅")) styles.push("优雅");
  if (includesAny(["清爽", "清新自然"]) && !styles.includes("清新")) styles.push("清新");
  if (includesAny(["不要这么正式", "别太正式", "轻松一点", "随意一点"])) styles.splice(0, styles.length, "休闲", "简约");
  const excludedCategories = [];
  [["半身裙", ["不要裙子", "不穿裙子", "不要半身裙"]], ["连衣裙", ["不要裙子", "不穿裙子", "不要连衣裙"]],
    ["裤子", ["不要裤子", "不穿裤子"]], ["外套", ["不要外套", "不穿外套"]], ["鞋子", ["不要鞋", "不换鞋"]]
  ].forEach(([category, words]) => { if (includesAny(words)) excludedCategories.push(category); });
  const preferredCategories = [];
  if (!excludedCategories.includes("连衣裙") && text.includes("连衣裙")) preferredCategories.push("连衣裙");
  else if (!excludedCategories.includes("半身裙") && !excludedCategories.includes("连衣裙") && includesAny(["裙子", "裙装", "穿裙"])) preferredCategories.push("连衣裙", "半身裙");
  if (!excludedCategories.includes("裤子") && includesAny(["想穿裤", "要裤子", "推荐裤子", "裤装"])) preferredCategories.push("裤子");
  if (!excludedCategories.includes("上衣") && includesAny(["想穿上衣", "要上衣", "推荐上衣"])) preferredCategories.push("上衣");
  const colorWords = ["黑色", "白色", "米色", "灰色", "红色", "粉色", "黄色", "绿色", "蓝色", "紫色", "棕色", "咖啡色", "酒红色", "卡其色"];
  const excludedColors = colorWords.filter((color) => includesAny([`不要${color}`, `不穿${color}`, `避开${color}`])).slice(0, 4);
  const preferredColors = colorWords.filter((color) => text.includes(color) && !excludedColors.includes(color)).slice(0, 4);
  const warmthPreference = includesAny(["怕冷", "暖和", "保暖", "穿厚点"]) ? "warmer"
    : includesAny(["怕热", "凉快", "清凉", "穿薄点"]) ? "cooler" : "normal";
  const hasConstraint = Boolean(sceneMatch || styles.length || preferredCategories.length || excludedCategories.length || preferredColors.length || excludedColors.length || warmthPreference !== "normal");
  const scene = sceneMatch ? sceneMatch[0] : "休闲";
  const action = asksWhy ? "answer" : asksReroll ? "reroll" : "recommend";
  const needsClarification = action === "recommend" && !input.followupUsed && !hasConstraint;
  const clarificationQuestion = /这件|这个|它/.test(input.current || "") && input.currentCategories?.length
    ? `你想调整${input.currentCategories.join("、")}中的哪一件？也可以直接点衣物下方的“换掉”。`
    : "今天主要是什么场合，或者想要什么风格？";
  return normalizePreferences({
    mode: isNew ? "new" : "modify", action, scene: sceneMatch ? scene : undefined,
    styles: styles.length ? styles : undefined,
    preferredCategories: preferredCategories.length ? preferredCategories : undefined,
    excludedCategories: excludedCategories.length ? [...new Set([...(current.excludedCategories || []), ...excludedCategories])] : undefined,
    preferredColors: preferredColors.length ? preferredColors : undefined,
    excludedColors: excludedColors.length ? [...new Set([...(current.excludedColors || []), ...excludedColors])] : undefined,
    warmthPreference: warmthPreference !== "normal" ? warmthPreference : undefined, needsClarification,
    question: needsClarification ? clarificationQuestion : "",
    summary: `${isNew ? "已理解你的需求" : "已按你的意见调整"}：${sceneMatch ? scene : current.scene || "休闲"}${styles.length ? `、${styles.join("、")}` : ""}`,
    reply: asksWhy ? outfitExplanation(input, current) : asksReroll ? "可以，我保留刚才的条件，换一套真实衣橱搭配。" : ""
  }, input.followupUsed, current);
}

function requestText(message, previousMessage = "", followupUsed = false, contextPreferences = {}, currentCategories = [], currentOutfitFacts = []) {
  const current = cleanText(message, 300);
  const previous = cleanText(previousMessage, 300);
  if (!current) throw Object.assign(new Error("请先告诉我今天想怎么穿。"), { status: 400, code: "OUTFIT_REQUEST_EMPTY" });
  return {
    current, previous, followupUsed: Boolean(followupUsed),
    contextPreferences: contextPreferences && Object.keys(contextPreferences).length
      ? normalizePreferences({ ...contextPreferences, mode: "new", needsClarification: false }, true)
      : {},
    currentCategories: cleanList(currentCategories, ALLOWED_CATEGORIES, 6),
    currentOutfitFacts: cleanOutfitFacts(currentOutfitFacts)
  };
}

function promptForRequest(input) {
  return `你是穿搭对话状态解析器，不选择或编造衣物。只返回JSON：{mode,action,scene,styles,preferred_categories,excluded_categories,preferred_colors,excluded_colors,warmth_preference,needsClarification,question,summary,reply}。action只能为recommend、answer、reroll：修改需求用recommend；询问当前搭配原因或是否合适用answer；只要求换一套且不改条件用reroll。answer时只能依据“当前搭配事实”回答，reply不超过80字，不得补充事实中没有的衣物、材质、品牌或效果；recommend和reroll可用一句自然话确认用户修改。mode只能为new或modify：用户明确重新开始才用new；对上一套提出更休闲、更正式、换品类、不要某颜色、太冷太热等意见必须用modify，并在当前状态基础上返回修改后的完整状态。scene只能为休闲、通勤、约会、旅行、聚会、运动之一；styles只能从韩系、清新、酷飒、简约、休闲、通勤、复古、甜美、运动、街头、优雅、度假中选最多3项；“不要这么正式”应删除优雅/通勤并改为休闲或简约。preferred_categories和excluded_categories只能从上衣、裤子、半身裙、外套、连衣裙、鞋子中选；用户说裙子或裙装但未细分时返回连衣裙和半身裙。颜色使用简短中文；warmth_preference只能为warmer、cooler、normal。无法确定“这件”指哪件时才追问；其他已明确任一条件时不要机械追问。当前受控状态：${JSON.stringify(input.contextPreferences || {})}；当前搭配事实：${JSON.stringify(input.currentOutfitFacts || [])}；首次输入：${input.previous || "无"}；本次输入：${input.current}；followupUsed=${input.followupUsed}`;
}

module.exports = { ALLOWED_CATEGORIES, ALLOWED_SCENES, ALLOWED_STYLES, inferPreferencesFromText, normalizePreferences, promptForRequest, requestText, shouldFallbackToRules };
