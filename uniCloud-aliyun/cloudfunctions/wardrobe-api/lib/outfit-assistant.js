"use strict";

const ALLOWED_SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const ALLOWED_STYLES = ["韩系", "清新", "酷飒", "简约", "休闲", "通勤", "复古", "甜美", "运动", "街头", "优雅", "度假"];
const ALLOWED_CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const ALLOWED_OCCASIONS = ["日常", "上课", "逛街", "通勤", "商务会议", "面试", "商务饭局", "约会", "婚礼宾客", "正式活动", "朋友聚会", "家庭聚会", "旅行观光", "城市漫步", "海边度假", "徒步登山", "露营", "跑步", "健身", "球类运动", "骑行", "滑雪", "水上运动", "毕业典礼", "演出观展", "亲子出行"];
const ALLOWED_FORMALITIES = ["casual", "smart_casual", "business", "semi_formal", "formal", "athletic", "outdoor"];
const OCCASION_SCENES = {
  "日常": "休闲", "上课": "休闲", "逛街": "休闲", "通勤": "通勤", "商务会议": "通勤", "面试": "通勤",
  "商务饭局": "聚会", "约会": "约会", "婚礼宾客": "聚会", "正式活动": "聚会", "朋友聚会": "聚会", "家庭聚会": "聚会",
  "旅行观光": "旅行", "城市漫步": "旅行", "海边度假": "旅行", "徒步登山": "运动", "露营": "运动", "跑步": "运动",
  "健身": "运动", "球类运动": "运动", "骑行": "运动", "滑雪": "运动", "水上运动": "运动", "毕业典礼": "聚会", "演出观展": "聚会", "亲子出行": "休闲"
};
const OCCASION_DEFAULT_FORMALITY = {
  "日常": "casual", "上课": "casual", "逛街": "smart_casual", "通勤": "smart_casual", "商务会议": "business", "面试": "business",
  "商务饭局": "business", "约会": "smart_casual", "婚礼宾客": "semi_formal", "正式活动": "formal", "朋友聚会": "smart_casual",
  "家庭聚会": "smart_casual", "旅行观光": "casual", "城市漫步": "casual", "海边度假": "casual", "徒步登山": "outdoor",
  "露营": "outdoor", "跑步": "athletic", "健身": "athletic", "球类运动": "athletic", "骑行": "outdoor", "滑雪": "outdoor", "水上运动": "athletic", "毕业典礼": "semi_formal",
  "演出观展": "smart_casual", "亲子出行": "casual"
};

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

const cleanRecentMessages = (value) => {
  if (!Array.isArray(value)) return [];
  let total = 0;
  return value.slice(-10).map((message) => {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "";
    const content = cleanText(message?.content ?? message?.text, 160);
    if (!role || !content || total >= 1000) return null;
    const remaining = Math.max(0, 1000 - total);
    const safeContent = content.slice(0, remaining);
    total += safeContent.length;
    return safeContent ? { role, content: safeContent } : null;
  }).filter(Boolean);
};

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
  const field = (camel, snake) => {
    const incoming = raw[camel] !== undefined ? raw[camel] : raw[snake];
    // 多轮修改中，模型用空数组表示“本轮没提到”时保留旧状态，避免把已经确认的偏好误清空。
    if (mode === "modify" && Array.isArray(incoming) && !incoming.length) return base[camel];
    return incoming !== undefined ? incoming : base[camel];
  };
  const sceneValue = raw.scene !== undefined ? raw.scene : base.scene;
  const scene = ALLOWED_SCENES.includes(sceneValue) ? sceneValue : "休闲";
  const occasionValue = raw.occasion !== undefined ? raw.occasion : base.occasion;
  const occasion = ALLOWED_OCCASIONS.includes(occasionValue) ? occasionValue : "";
  const formalityValue = raw.formalityPreference !== undefined ? raw.formalityPreference : raw.formality_preference !== undefined ? raw.formality_preference : base.formalityPreference;
  const formalityPreference = ALLOWED_FORMALITIES.includes(formalityValue) ? formalityValue : "smart_casual";
  const styles = cleanList(field("styles", "styles"), ALLOWED_STYLES, 3);
  const excludedCategories = cleanList(field("excludedCategories", "excluded_categories"), ALLOWED_CATEGORIES, 4);
  const preferredCategories = cleanList(field("preferredCategories", "preferred_categories"), ALLOWED_CATEGORIES, 4)
    .filter((category) => !excludedCategories.includes(category));
  const excludedColors = cleanList(field("excludedColors", "excluded_colors"), null, 4);
  const preferredColors = cleanList(field("preferredColors", "preferred_colors"), null, 4)
    .filter((color) => !excludedColors.includes(color));
  const warmthValue = field("warmthPreference", "warmth_preference");
  const warmthPreference = ["warmer", "cooler", "normal"].includes(warmthValue) ? warmthValue : "normal";
  const needsClarification = !followupUsed && (raw.needsClarification ?? raw.needs_clarification) === true;
  const actionValue = raw.action;
  const action = ["recommend", "answer", "reroll"].includes(actionValue) ? actionValue : "recommend";
  return {
    mode, action,
    scene,
    occasion,
    formalityPreference,
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
  const recent = cleanRecentMessages(input.recentMessages).map((message) => message.content).join(" ");
  const currentText = cleanText(input.current, 300);
  const text = `${recent} ${cleanText(input.previous, 300)} ${currentText}`.trim();
  // 状态已经单独传入 contextPreferences，本轮修改必须以用户当前这句话为准，避免旧消息里的“休闲”等词覆盖新要求。
  // 旧的两步输入如果还没有结构化状态，才允许用上一句补全本句没有重复的条件。
  const constraintText = Object.keys(input.contextPreferences || {}).length ? currentText : text;
  const includesAny = (words) => words.some((word) => constraintText.includes(word));
  const occasionRules = [
    ["商务饭局", ["商务饭局", "领导饭局", "客户饭局", "商务宴请", "见客户吃饭"]],
    ["商务会议", ["商务会议", "见领导", "见客户", "开会", "汇报", "答辩"]],
    ["面试", ["面试", "招聘会"]], ["婚礼宾客", ["婚礼", "婚宴"]],
    ["毕业典礼", ["毕业典礼", "毕业仪式"]], ["正式活动", ["正式晚宴", "颁奖", "典礼", "年会晚宴", "黑领结"]],
    ["约会", ["约会", "见对象"]], ["家庭聚会", ["家庭聚会", "家宴", "见家长"]],
    ["朋友聚会", ["朋友聚会", "聚餐", "饭局", "派对", "宴会", "年会"]],
    ["海边度假", ["海边", "沙滩", "海岛", "度假"]], ["徒步登山", ["徒步", "登山", "爬山", "户外运动"]],
    ["露营", ["露营", "野营"]], ["跑步", ["跑步", "慢跑", "马拉松"]], ["健身", ["健身", "瑜伽", "普拉提"]],
    ["球类运动", ["打球", "篮球", "足球", "羽毛球", "网球", "乒乓球"]], ["骑行", ["骑行", "骑车", "自行车"]],
    ["滑雪", ["滑雪", "雪场"]], ["水上运动", ["游泳", "冲浪", "桨板", "潜水"]], ["旅行观光", ["旅行", "旅游", "出游", "观光"]],
    ["城市漫步", ["citywalk", "城市漫步"]], ["演出观展", ["看展", "观展", "音乐会", "看演出", "看话剧"]],
    ["亲子出行", ["亲子", "带孩子", "遛娃"]], ["上课", ["上课", "上学", "校园"]], ["逛街", ["逛街", "购物"]],
    ["通勤", ["通勤", "上班"]], ["日常", ["日常", "散步", "在家", "休闲"]]
  ];
  const businessMeal = includesAny(["领导", "客户", "商务"]) && includesAny(["吃饭", "饭局", "宴请", "聚餐"]);
  const occasionMatch = businessMeal ? ["商务饭局", []] : occasionRules.find(([, words]) => includesAny(words));
  const sceneRules = [
    ["通勤", ["通勤", "上班", "开会", "面试", "领导", "商务"]], ["约会", ["约会"]],
    ["旅行", ["旅行", "旅游", "出游"]], ["聚会", ["聚会", "派对", "宴会", "饭局"]],
    ["运动", ["运动", "健身", "跑步"]], ["休闲", ["上课", "逛街", "散步", "日常", "休闲"]]
  ];
  const sceneMatch = occasionMatch ? [OCCASION_SCENES[occasionMatch[0]], []] : sceneRules.find(([, words]) => includesAny(words));
  const current = input.contextPreferences || {};
  const asksWhy = includesAny(["为什么", "为什么推荐", "推荐理由", "怎么搭", "合适吗"]);
  const asksReroll = includesAny(["换一套", "再来一套", "下一套", "换个搭配"]);
  const isNew = !Object.keys(current).length || includesAny(["重新推荐", "重新搭配", "换个场合", "另一套需求"]);
  const styles = ALLOWED_STYLES.filter((style) => constraintText.includes(style)).slice(0, 3);
  if (constraintText.includes("温柔") && !styles.includes("甜美")) styles.push("甜美");
  if (includesAny(["隆重", "精致", "有气质"]) && !styles.includes("优雅")) styles.push("优雅");
  if (includesAny(["正式", "得体", "稳重"]) && !includesAny(["不要这么正式", "别太正式"])) {
    if (!styles.includes("通勤")) styles.push("通勤");
    if (!styles.includes("优雅")) styles.push("优雅");
  }
  if (includesAny(["清爽", "清新自然"]) && !styles.includes("清新")) styles.push("清新");
  if (includesAny(["不要这么正式", "别太正式", "轻松一点", "随意一点"])) styles.splice(0, styles.length, "休闲", "简约");
  const explicitFormality = includesAny(["不要这么正式", "别太正式", "轻松一点", "随意一点"]) ? "casual"
    : includesAny(["黑领结", "非常正式", "隆重正式"]) ? "formal"
      : includesAny(["半正式", "鸡尾酒会"]) ? "semi_formal"
        : includesAny(["正式", "得体", "稳重"]) ? "formal"
          : includesAny(["商务", "职业", "专业感"]) ? "business"
            : includesAny(["户外", "徒步", "登山", "露营"]) ? "outdoor"
              : includesAny(["运动", "跑步", "健身", "打球"]) ? "athletic" : "";
  const formalityPreference = explicitFormality || (!Object.keys(current).length && occasionMatch ? OCCASION_DEFAULT_FORMALITY[occasionMatch[0]] : "");
  const excludedCategories = [];
  [["半身裙", ["不要裙子", "不穿裙子", "不想穿裙子", "不想要裙子", "别推荐裙子", "不要半身裙"]], ["连衣裙", ["不要裙子", "不穿裙子", "不想穿裙子", "不想要裙子", "别推荐裙子", "不要连衣裙"]],
    ["裤子", ["不要裤子", "不穿裤子"]], ["外套", ["不要外套", "不穿外套"]], ["鞋子", ["不要鞋", "不换鞋"]]
  ].forEach(([category, words]) => { if (includesAny(words)) excludedCategories.push(category); });
  const preferredCategories = [];
  if (!excludedCategories.includes("连衣裙") && constraintText.includes("连衣裙")) preferredCategories.push("连衣裙");
  else if (!excludedCategories.includes("半身裙") && !excludedCategories.includes("连衣裙") && includesAny(["裙子", "裙装", "穿裙"])) preferredCategories.push("连衣裙", "半身裙");
  if (!excludedCategories.includes("裤子") && includesAny(["想穿裤", "要裤子", "推荐裤子", "裤装"])) preferredCategories.push("裤子");
  if (!excludedCategories.includes("上衣") && includesAny(["想穿上衣", "要上衣", "推荐上衣"])) preferredCategories.push("上衣");
  const colorWords = ["黑色", "白色", "米色", "灰色", "红色", "粉色", "黄色", "绿色", "蓝色", "紫色", "棕色", "咖啡色", "酒红色", "卡其色"];
  const excludedColors = colorWords.filter((color) => includesAny([`不要${color}`, `不穿${color}`, `避开${color}`])).slice(0, 4);
  const preferredColors = colorWords.filter((color) => constraintText.includes(color) && !excludedColors.includes(color)).slice(0, 4);
  const warmthPreference = includesAny(["怕冷", "暖和", "保暖", "穿厚点"]) ? "warmer"
    : includesAny(["怕热", "凉快", "清凉", "穿薄点"]) ? "cooler" : "normal";
  const hasConstraint = Boolean(sceneMatch || occasionMatch || formalityPreference || styles.length || preferredCategories.length || excludedCategories.length || preferredColors.length || excludedColors.length || warmthPreference !== "normal");
  const scene = sceneMatch ? sceneMatch[0] : "休闲";
  const action = asksWhy ? "answer" : asksReroll ? "reroll" : "recommend";
  const needsClarification = action === "recommend" && !input.followupUsed && !hasConstraint;
  const clarificationQuestion = /这件|这个|它/.test(input.current || "") && input.currentCategories?.length
    ? `你想调整${input.currentCategories.join("、")}中的哪一件？也可以直接点衣物下方的“换掉”。`
    : "今天主要是什么场合，或者想要什么风格？";
  return normalizePreferences({
    mode: isNew ? "new" : "modify", action, scene: sceneMatch ? scene : undefined,
    occasion: occasionMatch ? occasionMatch[0] : undefined,
    formalityPreference: formalityPreference || undefined,
    styles: styles.length ? styles : undefined,
    preferredCategories: preferredCategories.length ? preferredCategories : undefined,
    excludedCategories: excludedCategories.length ? [...new Set([...(current.excludedCategories || []), ...excludedCategories])] : undefined,
    preferredColors: preferredColors.length ? preferredColors : undefined,
    excludedColors: excludedColors.length ? [...new Set([...(current.excludedColors || []), ...excludedColors])] : undefined,
    warmthPreference: warmthPreference !== "normal" ? warmthPreference : undefined, needsClarification,
    question: needsClarification ? clarificationQuestion : "",
    summary: `${isNew ? "已理解你的需求" : "已按你的意见调整"}：${occasionMatch?.[0] || current.occasion || (sceneMatch ? scene : current.scene) || "休闲"}${styles.length ? `、${styles.join("、")}` : ""}`,
    reply: asksWhy ? outfitExplanation(input, current) : asksReroll ? "可以，我保留刚才的条件，换一套真实衣橱搭配。" : ""
  }, input.followupUsed, current);
}

function requestText(message, previousMessage = "", followupUsed = false, contextPreferences = {}, currentCategories = [], currentOutfitFacts = [], recentMessages = []) {
  const current = cleanText(message, 300);
  const previous = cleanText(previousMessage, 300);
  if (!current) throw Object.assign(new Error("请先告诉我今天想怎么穿。"), { status: 400, code: "OUTFIT_REQUEST_EMPTY" });
  return {
    current, previous, followupUsed: Boolean(followupUsed),
    contextPreferences: contextPreferences && Object.keys(contextPreferences).length
      ? normalizePreferences({ ...contextPreferences, mode: "new", needsClarification: false }, true)
      : {},
    currentCategories: cleanList(currentCategories, ALLOWED_CATEGORIES, 6),
    currentOutfitFacts: cleanOutfitFacts(currentOutfitFacts),
    recentMessages: cleanRecentMessages(recentMessages)
  };
}

function promptForRequest(input) {
  return `你是穿搭对话状态解析器，不选择或编造衣物。只返回JSON：{mode,action,scene,occasion,formality_preference,styles,preferred_categories,excluded_categories,preferred_colors,excluded_colors,warmth_preference,needsClarification,question,summary,reply}。action只能为recommend、answer、reroll：修改需求用recommend；询问当前搭配原因或是否合适用answer；只要求换一套且不改条件用reroll。answer时只能依据“当前搭配事实”回答，reply不超过80字，不得补充事实中没有的衣物、材质、品牌或效果；recommend和reroll可用一句自然话确认用户修改。mode只能为new或modify：用户明确重新开始才用new；对上一套提出更休闲、更正式、换品类、不要某颜色、太冷太热等意见必须用modify，并在当前状态基础上返回修改后的完整状态。scene是兼容用大场景，只能为休闲、通勤、约会、旅行、聚会、运动之一。occasion是具体场景，只能从${ALLOWED_OCCASIONS.join("、")}中选一个；“正式”是正式程度，不等于通勤，领导饭局应为商务饭局/聚会，婚礼应为婚礼宾客/聚会，徒步露营应归户外。formality_preference只能为casual、smart_casual、business、semi_formal、formal、athletic、outdoor之一。styles只能从韩系、清新、酷飒、简约、休闲、通勤、复古、甜美、运动、街头、优雅、度假中选最多3项；“不要这么正式”应删除优雅/通勤并改为休闲或简约。preferred_categories和excluded_categories只能从上衣、裤子、半身裙、外套、连衣裙、鞋子中选；用户说裙子或裙装但未细分时返回连衣裙和半身裙。颜色使用简短中文；warmth_preference只能为warmer、cooler、normal。无法确定“这件”指哪件时才追问；其他已明确任一条件时不要机械追问。最近对话：${JSON.stringify(input.recentMessages || [])}；当前受控状态：${JSON.stringify(input.contextPreferences || {})}；当前搭配事实：${JSON.stringify(input.currentOutfitFacts || [])}；首次输入：${input.previous || "无"}；本次输入：${input.current}；followupUsed=${input.followupUsed}`;
}

module.exports = { ALLOWED_CATEGORIES, ALLOWED_FORMALITIES, ALLOWED_OCCASIONS, ALLOWED_SCENES, ALLOWED_STYLES, cleanRecentMessages, inferPreferencesFromText, normalizePreferences, promptForRequest, requestText, shouldFallbackToRules };
