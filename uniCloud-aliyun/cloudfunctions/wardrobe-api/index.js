"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const repository = require("./lib/database");
const cloud = require("./lib/cloud-services");
const aiBudget = require("./lib/ai-budget");
const inspiration = require("./lib/inspiration");
const weatherService = require("./lib/amap-weather");
const { buildCityTrend, buildOutfitCandidates, buildStyleProfile } = require("./lib/outfit-insights");

const now = () => new Date().toISOString();
// 每次关键云端修复更新构建号；健康检查可以确认服务空间实际运行的是哪一版代码。
const BUILD_ID = "2026-08-11-private-outfit-plans-v39";
const OUTFIT_VISION_MODEL = process.env.QWEN_VL_MODEL || "qwen3-vl-flash-2026-01-22";
const OUTFIT_IMAGE_EDIT_MODEL = "qwen-image-2.0-pro-2026-06-22";
const GARMENT_SEGMENTATION_MODEL = "SegmentCloth";
const PRODUCT_SEGMENTATION_MODEL = "SegmentCommodity";
const outfitParsingConfigured = () => Boolean(
  String(process.env.DASHSCOPE_API_KEY || "").trim()
  && String(process.env.DASHSCOPE_WORKSPACE_ID || "").trim()
);
const IMAGE_EDIT_INTERVAL_MS = 31000;
const IMAGE_EDIT_SLOT_ID = "dashscope-image-edit";
const shouldSkipOutfitCandidateMatching = (detection) => detection?.segmentationProvider === "aliyun_aitryon_parsing";
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_QUOTA = Object.freeze({ recognitionLimit: 20, hangerRemovalLimit: 5, windowType: "trial" });
const FREE_QUOTA = Object.freeze({ recognitionLimit: 3, hangerRemovalLimit: 1, windowType: "rolling_30_days" });
const PAID_QUOTA = Object.freeze({ recognitionLimit: 20, hangerRemovalLimit: 5, windowType: "rolling_30_days" });
const PLAN_CATALOG = Object.freeze([
  { id: "weekly", name: "周付体验", durationDays: 7, featured: true, price: 8.9, quota: PAID_QUOTA, purchaseEnabled: false },
  { id: "monthly", name: "月付会员", durationDays: 30, featured: false, price: 48.9, quota: PAID_QUOTA, purchaseEnabled: false },
  { id: "yearly", name: "年付会员", durationDays: 365, featured: false, price: 448.9, quota: PAID_QUOTA, purchaseEnabled: false }
]);
const cleanText = (value, max = 80) => String(value || "").trim().slice(0, max);
const newId = () => crypto.randomUUID();
const idempotentId = (scope, userId, key) => crypto.createHash("sha256").update(`${scope}:${userId}:${key}`).digest("hex");
const parseArray = (value) => {
  if (Array.isArray(value)) return value;
  try { return Array.isArray(JSON.parse(value || "[]")) ? JSON.parse(value || "[]") : []; }
  catch { return []; }
};
const sanitizeTags = (value, allowed = null, max = 4) => parseArray(value)
  .map((item) => cleanText(item, 20))
  .filter((item) => item && (!allowed || allowed.includes(item)))
  .slice(0, max);
const allowedCategories = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const allowedItemSources = ["single_item_upload", "outfit_supplement"];
const allowedScenes = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const allowedSeasons = ["春夏", "春秋", "秋冬", "多季"];
const allowedThicknesses = ["薄", "适中", "厚"];
const allowedIdleReasons = ["很少穿", "不合适", "重复", "风格变化", "其他"];
const allowedListingModes = ["sale", "rent"];
const allowedListingStatuses = ["draft", "listed", "delisted", "completed"];
const STAR_MONTHLY_LIMIT = 35;
const STAR_REWARD_CATALOG = Object.freeze([
  { id: "capsule_slot", name: "额外胶囊计划槽位", stars: 8, kind: "feature", exchangeEnabled: false },
  { id: "growth_badge", name: "月度成长徽章", stars: 10, kind: "feature", exchangeEnabled: false },
  { id: "outfit_summary", name: "个人穿搭总结卡", stars: 10, kind: "feature", exchangeEnabled: false },
  { id: "smart_entry", name: "AI 智能录入 1 次", stars: 20, kind: "ai", exchangeEnabled: false },
  { id: "hanger_removal", name: "AI 移除衣架 1 次", stars: 35, kind: "ai", exchangeEnabled: false }
]);
const budgetId = "global-ai-budget";
const VISION_EMBEDDING_MODEL = process.env.VISION_EMBEDDING_MODEL || "tongyi-embedding-vision-flash-2026-03-06";
const VISION_EMBEDDING_DIMENSION = Number(process.env.VISION_EMBEDDING_DIMENSION || 512);

const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const tagSimilarity = (candidate, item) => {
  const candidateScenes = sanitizeTags(candidate.scenes, allowedScenes);
  const matchedScenes = sanitizeTags(item.scenes, allowedScenes).filter((scene) => candidateScenes.includes(scene));
  const categoryScore = item.category === candidate.category ? 55 : 0;
  const colorScore = item.color && candidate.color && item.color === candidate.color ? 25 : 0;
  const sceneScore = matchedScenes.length * 10;
  const matchReasons = [];
  if (categoryScore) matchReasons.push(`同品类 +${categoryScore}`);
  if (colorScore) matchReasons.push(`同颜色 +${colorScore}`);
  if (sceneScore) matchReasons.push(`共同场景（${matchedScenes.join("、")}）+${sceneScore}`);
  return { score: Math.min(100, categoryScore + colorScore + sceneScore), matchReasons };
};

const embeddingRecordId = (userId, entityType, entityId, model) => crypto.createHash("sha256")
  .update(`${userId}:${entityType}:${entityId}:${model}`)
  .digest("hex");

const ensureImageEmbeddings = async (userId, targets) => {
  const stored = await repository.findMany("imageEmbeddings", { user_id: userId, model: VISION_EMBEDDING_MODEL });
  const byEntity = new Map(stored.map((row) => [`${row.entity_type}:${row.entity_id}`, row]));
  const missing = targets.filter((target) => {
    const row = byEntity.get(`${target.entityType}:${target.entityId}`);
    return !row || row.image_key !== target.imageKey || Number(row.dimension) !== VISION_EMBEDDING_DIMENSION;
  });
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const generated = await cloud.generateImageEmbeddings(batch.map((target) => target.imageKey));
    if (generated.model !== VISION_EMBEDDING_MODEL || generated.dimension !== VISION_EMBEDDING_DIMENSION) {
      throw Object.assign(new Error("视觉向量模型配置与返回结果不一致。"), { status: 502, code: "EMBEDDING_MODEL_MISMATCH" });
    }
    const inputTokens = Number(generated.usage?.input_tokens || generated.usage?.total_tokens || 0);
    const estimatedCostMicros = Number(generated.estimatedCostMicros || 0);
    for (let index = 0; index < batch.length; index += 1) {
      const target = batch[index];
      const record = {
        user_id: userId,
        entity_type: target.entityType,
        entity_id: target.entityId,
        image_key: target.imageKey,
        model: generated.model,
        dimension: generated.dimension,
        vector: generated.vectors[index],
        input_tokens: batch.length ? Math.ceil(inputTokens / batch.length) : 0,
        estimated_cost_micros: batch.length ? Math.ceil(estimatedCostMicros / batch.length) : 0,
        request_id: generated.requestId || "",
        created_at: now()
      };
      const key = `${target.entityType}:${target.entityId}`;
      const previous = byEntity.get(key);
      if (previous) await repository.update("imageEmbeddings", previous.id, record);
      else await repository.add("imageEmbeddings", record, embeddingRecordId(userId, target.entityType, target.entityId, generated.model));
      byEntity.set(key, { ...record, id: previous?.id || embeddingRecordId(userId, target.entityType, target.entityId, generated.model) });
    }
  }
  return byEntity;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const shanghaiDayKey = (value = Date.now()) => {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};
const shanghaiMinuteLabel = (value = Date.now()) => new Date((typeof value === "number" ? value : Date.parse(value)) + SHANGHAI_OFFSET_MS)
  .toISOString().slice(0, 16).replace("T", " ");
const shiftDayKey = (dayKey, offset) => new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
const starEventId = (userId, type, key) => crypto.createHash("sha256").update(`${userId}:${type}:${key}`).digest("hex");
const nextStarAccount = (account, dayKey, timestamp) => {
  const monthKey = dayKey.slice(0, 7);
  const sameMonth = account?.month_key === monthKey;
  const previousDay = shiftDayKey(dayKey, -1);
  const currentStreak = account?.last_checkin_day === previousDay ? Number(account.current_streak || 0) + 1 : 1;
  const monthEarned = sameMonth ? Number(account.month_earned || 0) : 0;
  const monthCheckinDays = sameMonth ? Number(account.month_checkin_days || 0) : 0;
  const remaining = Math.max(0, STAR_MONTHLY_LIMIT - monthEarned);
  const dailyPoints = Math.min(1, remaining);
  const bonusEligible = currentStreak >= 7 && currentStreak % 7 === 0 && account?.weekly_bonus_month !== monthKey;
  const bonusPoints = bonusEligible ? Math.min(3, Math.max(0, remaining - dailyPoints)) : 0;
  const awardedPoints = dailyPoints + bonusPoints;
  const balance = Number(account?.balance || 0) + awardedPoints;
  return {
    account: {
      user_id: account?.user_id || "",
      balance,
      total_earned: Number(account?.total_earned || 0) + awardedPoints,
      current_streak: currentStreak,
      longest_streak: Math.max(Number(account?.longest_streak || 0), currentStreak),
      last_checkin_day: dayKey,
      month_key: monthKey,
      month_checkin_days: monthCheckinDays + 1,
      month_earned: monthEarned + awardedPoints,
      weekly_bonus_month: bonusPoints ? monthKey : account?.weekly_bonus_month || "",
      created_at: account?.created_at || timestamp,
      updated_at: timestamp
    },
    dailyPoints,
    bonusPoints,
    awardedPoints
  };
};
const requiredEnv = (names) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw Object.assign(new Error(`云函数缺少配置：${missing.join(", ")}`), { status: 503 });
};

const requestHeaders = (event) => Object.fromEntries(
  Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
);

const parseBody = (event) => {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : String(event.body);
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("请求内容不是有效的 JSON。"), { status: 400 }); }
};

const corsHeaders = (event) => {
  const headers = requestHeaders(event);
  const origin = headers.origin || "";
  const allowed = String(process.env.ALLOWED_ORIGINS || "*").split(",").map((item) => item.trim()).filter(Boolean);
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : "";
  return {
    ...(allowOrigin ? { "access-control-allow-origin": allowOrigin } : {}),
    "access-control-allow-headers": "authorization, content-type, x-admin-token",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "600",
    "cache-control": "no-store"
  };
};

const response = (event, statusCode, body, extraHeaders = {}) => ({
  mpserverlessComposedResponse: true,
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(event), ...extraHeaders },
  body: statusCode === 204 ? "" : JSON.stringify(body)
});

const publicUser = (user) => ({ id: String(user.id), username: user.username, role: user.role === "admin" ? "admin" : "user" });
const entitlementSummary = (user, currentTime = Date.now()) => {
  const subscriptionEndsAt = Date.parse(user.subscription_ends_at || "");
  const trialEndsAt = Date.parse(user.trial_ends_at || "");
  const status = Number.isFinite(subscriptionEndsAt) && subscriptionEndsAt > currentTime
    ? "active"
    : Number.isFinite(trialEndsAt) && trialEndsAt > currentTime
      ? "trialing"
      : "expired";
  return {
    status,
    trialStartedAt: user.trial_started_at || null,
    trialEndsAt: user.trial_ends_at || null,
    subscriptionEndsAt: user.subscription_ends_at || null,
    serverTime: new Date(currentTime).toISOString(),
    purchaseEnabled: false
  };
};
const quotaWindow = (user, status, currentTime) => {
  if (status === "trialing") {
    return {
      policy: TRIAL_QUOTA,
      startsAt: Date.parse(user.trial_started_at || "") || currentTime,
      endsAt: Date.parse(user.trial_ends_at || "") || currentTime + TRIAL_DURATION_MS
    };
  }
  const rollingStart = currentTime - QUOTA_WINDOW_MS;
  const trialEndsAt = Date.parse(user.trial_ends_at || "");
  return {
    policy: status === "active" ? PAID_QUOTA : FREE_QUOTA,
    // 免费额度从试用结束后开始计算，试用期内已用次数不会挤占免费保底额度。
    startsAt: status === "expired" && Number.isFinite(trialEndsAt) ? Math.max(rollingStart, trialEndsAt) : rollingStart,
    endsAt: currentTime
  };
};
const quotaSummary = (user, tasks, currentTime = Date.now()) => {
  const entitlement = entitlementSummary(user, currentTime);
  const window = quotaWindow(user, entitlement.status, currentTime);
  const inWindow = tasks.filter((task) => {
    const createdAt = Date.parse(task.created_at || "");
    return Number.isFinite(createdAt) && createdAt >= window.startsAt && createdAt <= window.endsAt;
  });
  const recognitionUsed = inWindow.filter((task) => task.mode !== "inspiration" && task.status === "completed"
    && aiBudget.integer(task.prompt_tokens) + aiBudget.integer(task.completion_tokens) > 0).length;
  const hangerRemovalUsed = inWindow.filter((task) => Boolean(task.hanger_edit_key)).length;
  return {
    mode: entitlement.status === "trialing" ? "trial" : entitlement.status === "active" ? "paid" : "free",
    enforcement: "observe_only",
    windowType: window.policy.windowType,
    windowDays: window.policy.windowType === "rolling_30_days" ? 30 : 7,
    windowStartsAt: new Date(window.startsAt).toISOString(),
    windowEndsAt: new Date(window.endsAt).toISOString(),
    recognition: {
      limit: window.policy.recognitionLimit,
      used: recognitionUsed,
      remaining: Math.max(0, window.policy.recognitionLimit - recognitionUsed),
      exceeded: recognitionUsed >= window.policy.recognitionLimit
    },
    hangerRemoval: {
      limit: window.policy.hangerRemovalLimit,
      used: hangerRemovalUsed,
      remaining: Math.max(0, window.policy.hangerRemovalLimit - hangerRemovalUsed),
      exceeded: hangerRemovalUsed >= window.policy.hangerRemovalLimit
    },
    action: "当前仅统计和提醒，暂不限制功能"
  };
};
const entitlementWithQuota = async (user, currentTime = Date.now()) => {
  const entitlement = entitlementSummary(user, currentTime);
  const window = quotaWindow(user, entitlement.status, currentTime);
  const tasks = await repository.findMany("aiUsage", {
    user_id: String(user.id),
    created_at: repository.command().gte(new Date(window.startsAt).toISOString())
  }, { limit: 1000 });
  return { ...entitlement, quota: quotaSummary(user, tasks, currentTime) };
};
const newTrialFields = (startedAt = now()) => ({
  entitlement_initialized_at: startedAt,
  trial_started_at: startedAt,
  trial_ends_at: new Date(Date.parse(startedAt) + TRIAL_DURATION_MS).toISOString()
});
const ensureEntitlement = async (userId) => repository.withTransaction(async (tx) => {
  const user = await tx.getById("users", userId);
  if (!user) throw Object.assign(new Error("请先登录。"), { status: 401 });
  if (user.entitlement_initialized_at && user.trial_started_at && user.trial_ends_at) return user;
  const changes = newTrialFields();
  await tx.update("users", user.id, changes);
  return { ...user, ...changes };
});
const tokenFor = (user) => {
  requiredEnv(["JWT_SECRET"]);
  return jwt.sign(publicUser(user), process.env.JWT_SECRET, { expiresIn: "7d" });
};

const requireUser = (event) => {
  requiredEnv(["JWT_SECRET"]);
  const authorization = requestHeaders(event).authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("请先登录。"), { status: 401 });
  try { return jwt.verify(match[1], process.env.JWT_SECRET); }
  catch { throw Object.assign(new Error("登录状态已过期，请重新登录。"), { status: 401 }); }
};

const requireActiveUser = async (event) => {
  const claims = requireUser(event);
  const user = await repository.getById("users", claims.id);
  if (!user || user.status === "deletion_requested") {
    throw Object.assign(new Error("账号已停用，请联系处理账号删除申请。"), { status: 401 });
  }
  return user;
};
const requireCommunityAdmin = (user) => {
  if (user.role !== "admin") throw Object.assign(new Error("当前账号没有社区审核权限。"), { status: 403 });
};

const requireAdmin = (event) => {
  requiredEnv(["ADMIN_BOOTSTRAP_TOKEN"]);
  if (requestHeaders(event)["x-admin-token"] !== process.env.ADMIN_BOOTSTRAP_TOKEN) {
    throw Object.assign(new Error("管理员令牌无效。"), { status: 401 });
  }
};

const mapItem = (item) => ({
  ...item,
  id: String(item.id),
  styles: sanitizeTags(item.styles),
  scenes: sanitizeTags(item.scenes, allowedScenes),
  imageUrl: cloud.signedUrl(item.image_key, "GET", 3600)
});

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const sanitizeOutfitPlanLayout = (body = {}) => {
  const canvas = body.canvas && typeof body.canvas === "object" ? body.canvas : {};
  const seenItemIds = new Set();
  const layers = parseArray(body.layers).slice(0, 12).map((layer, index) => {
    const itemId = cleanText(layer?.itemId, 80);
    if (!itemId || seenItemIds.has(itemId)) return null;
    seenItemIds.add(itemId);
    return {
      key: cleanText(layer?.key, 100) || `${itemId}-${index}`,
      itemId,
      x: Math.round(clampNumber(layer?.x, 0, 2000, 0)),
      y: Math.round(clampNumber(layer?.y, 0, 3000, 0)),
      scale: Number(clampNumber(layer?.scale, 0.45, 2.2, 1).toFixed(2)),
      rotation: Math.round(clampNumber(layer?.rotation, -180, 180, 0)),
      z: index + 1
    };
  }).filter(Boolean);
  if (!layers.length) throw Object.assign(new Error("请先在画布中添加衣物。"), { status: 400 });
  return {
    canvas: {
      width: Math.round(clampNumber(canvas.width, 280, 2000, 320)),
      height: Math.round(clampNumber(canvas.height, 420, 3000, 520))
    },
    layers,
    itemIds: layers.map((layer) => layer.itemId)
  };
};

const requireOwnedOutfitPlan = async (id, userId) => {
  const plan = await repository.getById("outfitPlans", id);
  if (!plan || String(plan.user_id) !== String(userId)) throw Object.assign(new Error("搭配方案不存在。"), { status: 404 });
  return plan;
};
const isAvailableOutfitItem = (item, userId) => Boolean(item
  && String(item.user_id) === String(userId)
  && item.status === "active"
  && item.idle_status !== "considering");

const outfitPlanView = async (plan) => {
  const itemIds = [...new Set((Array.isArray(plan.item_ids) ? plan.item_ids : []).map(String))];
  const items = itemIds.length
    ? await repository.findMany("clothing", { user_id: String(plan.user_id), status: "active", _id: repository.command().in(itemIds) })
    : [];
  const byId = new Map(items.filter((item) => isAvailableOutfitItem(item, plan.user_id)).map((item) => [String(item.id), item]));
  return {
    id: String(plan.id),
    title: plan.title || "搭配方案",
    canvas: plan.canvas || { width: 320, height: 520 },
    layers: (Array.isArray(plan.layers) ? plan.layers : []).map((layer) => {
      const item = byId.get(String(layer.itemId));
      return item ? {
        ...layer,
        name: item.name || "未命名衣物",
        category: item.category || "",
        color: item.color || "",
        imageUrl: cloud.signedUrl(item.image_key, "GET", 3600)
      } : null;
    }).filter(Boolean),
    createdAt: plan.created_at,
    updatedAt: plan.updated_at
  };
};

const inspirationView = async (record, includeMatches = false) => {
  const view = {
    id: String(record.id),
    sourceType: record.source_type,
    platform: record.platform,
    sourceUrl: record.source_url || "",
    sourceTitle: record.source_title || "",
    sourceAuthor: record.source_author || "",
    status: record.status,
    detectedOutfit: record.detected_outfit || null,
    confirmedSlots: Array.isArray(record.confirmed_slots) ? record.confirmed_slots : [],
    summary: record.summary || "",
    errorCode: record.error_code || "",
    screenshotUrl: record.saved_image_key ? cloud.signedUrl(record.saved_image_key, "GET", 3600) : "",
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
  if (!includeMatches || record.status !== "ready") return view;
  const items = await repository.findMany("clothing", { user_id: String(record.user_id), status: "active" }, { orderBy: "created_at", order: "desc", limit: 500 });
  const result = inspiration.matchWardrobe(view.confirmedSlots, items);
  view.matches = result.matches.map((group) => ({
    ...group,
    candidates: group.candidates.map((candidate) => ({
      score: candidate.score,
      reasons: candidate.reasons,
      item: mapItem(candidate.item)
    }))
  }));
  view.missing = result.missing;
  return view;
};

const requireOwnedInspiration = async (id, userId) => {
  const record = await repository.getById("inspirations", id);
  if (!record || String(record.user_id) !== String(userId)) throw Object.assign(new Error("灵感记录不存在。"), { status: 404 });
  return record;
};
const publicOutfitDetection = (detection) => ({
  detectionId: detection.detectionId,
  slot: detection.slot,
  category: detection.category,
  color: detection.color || "",
  pattern: detection.pattern || "",
  styles: sanitizeTags(detection.styles),
  structure: detection.structure || "",
  structureFacts: detection.structureFacts || {},
  isComposite: detection.isComposite === true,
  confidence: Number(detection.confidence || 0),
  processingStatus: detection.processingStatus || "cropped",
  processingError: detection.processingError || "",
  processingStage: detection.processingStage || "",
  retryable: detection.retryable === true,
  retryAfterMs: Math.max(0, Number(detection.retryAfterMs || 0)),
  failureKind: detection.failureKind || "",
  imageOrigin: detection.imageOrigin || "",
  visiblePixelPreservationScore: detection.visiblePixelPreservationScore == null ? null : Number(detection.visiblePixelPreservationScore),
  occlusionRatio: detection.occlusionRatio == null ? null : Number(detection.occlusionRatio),
  completenessStatus: detection.completenessStatus || (detection.processingStatus === "failed" ? "needs_single_item_photo" : "ready"),
  completenessNote: detection.completenessNote || "",
  repairMode: detection.repairMode || "",
  displayMode: detection.displayMode || "",
  displayPaddingRatio: detection.displayPaddingRatio == null ? null : Number(detection.displayPaddingRatio),
  referenceRequired: detection.referenceRequired === true,
  segmentationStatus: detection.segmentationStatus || "pending",
  fidelityScore: detection.fidelityScore == null ? null : Number(detection.fidelityScore),
  fidelityStatus: detection.fidelityStatus || "pending",
  correctionAvailable: detection.processingStatus === "failed" && detection.correctionAttempted !== true && Boolean(detection.correctionSeedKey),
  imageUrl: detection.selectedImageKey ? cloud.signedUrl(detection.selectedImageKey, "GET", 3600) : "",
  topMatches: (Array.isArray(detection.topMatches) ? detection.topMatches : []).map((match) => ({
    id: String(match.id), name: match.name, category: match.category, color: match.color,
    similarity: match.similarity, visualSimilarity: match.visualSimilarity,
    imageUrl: match.imageKey ? cloud.signedUrl(match.imageKey, "GET", 3600) : match.imageUrl || ""
  }))
});

const acquireImageEditSlot = async (currentTime = Date.now()) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await repository.withTransaction(async (tx) => {
        const current = await tx.getById("aiProviderSlots", IMAGE_EDIT_SLOT_ID);
        const nextAllowedAt = Date.parse(current?.next_allowed_at || "") || 0;
        if (nextAllowedAt > currentTime) return { acquired: false, retryAfterMs: Math.max(1000, nextAllowedAt - currentTime) };
        const timestamp = new Date(currentTime).toISOString();
        const changes = {
          provider: "dashscope",
          model: OUTFIT_IMAGE_EDIT_MODEL,
          next_allowed_at: new Date(currentTime + IMAGE_EDIT_INTERVAL_MS).toISOString(),
          updated_at: timestamp
        };
        if (current) await tx.update("aiProviderSlots", IMAGE_EDIT_SLOT_ID, changes);
        else await tx.add("aiProviderSlots", changes, IMAGE_EDIT_SLOT_ID);
        return { acquired: true, retryAfterMs: 0 };
      });
    } catch (error) {
      if (attempt === 0 && String(error?.code || "").toLowerCase().includes("duplicate")) continue;
      throw error;
    }
  }
  return { acquired: false, retryAfterMs: IMAGE_EDIT_INTERVAL_MS };
};
const mapCandidate = (candidate) => ({
  ...candidate,
  id: String(candidate.id),
  styles: sanitizeTags(candidate.styles),
  scenes: sanitizeTags(candidate.scenes, allowedScenes),
  imageUrl: cloud.signedUrl(candidate.image_key, "GET", 3600)
});
const candidateWaitSummary = (candidate, currentTime = Date.now()) => {
  const waitStartedAt = candidate.wait_started_at || candidate.decision_at || candidate.created_at;
  const elapsed = Math.max(0, currentTime - Date.parse(waitStartedAt || ""));
  const waitDays = Number.isFinite(elapsed) ? Math.floor(elapsed / DAY_MS) : 0;
  return {
    waitStartedAt,
    waitDays,
    daysRemaining: Math.max(0, 7 - waitDays),
    coolingOffComplete: waitDays >= 7
  };
};
const mapWaitingCandidate = (candidate, currentTime = Date.now()) => ({
  ...mapCandidate(candidate),
  ...candidateWaitSummary(candidate, currentTime)
});
const communityAlias = (userId) => `衣橱用户${crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 4).toUpperCase()}`;
const communityLikeId = (postId, userId) => crypto.createHash("sha256").update(`${postId}:${userId}`).digest("hex");
const communityItems = (post) => (post.items || []).map((item) => ({
  id: String(item.id),
  name: cleanText(item.name, 40),
  category: cleanText(item.category, 20),
  color: cleanText(item.color, 20),
  imageUrl: cloud.signedUrl(item.image_key, "GET", 3600)
}));
const communityPostView = (post, userId, likedPostIds = new Set()) => ({
  id: String(post.id),
  authorAlias: post.author_alias,
  scene: post.scene,
  note: post.note || "",
  status: post.status,
  likeCount: Number(post.like_count || 0),
  liked: likedPostIds.has(String(post.id)),
  isMine: String(post.user_id) === String(userId),
  createdAt: post.created_at,
  publishedAt: post.published_at || "",
  items: communityItems(post)
});
const shanghaiWeekStart = () => {
  const local = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() - day + 1);
  return new Date(`${local.toISOString().slice(0, 10)}T00:00:00.000+08:00`).toISOString();
};
const communityPostList = async (userId, scope = "feed") => {
  const where = scope === "mine" ? { user_id: userId } : { status: "approved" };
  const posts = await repository.findMany("communityPosts", where, { orderBy: scope === "mine" ? "created_at" : "published_at", order: "desc", limit: 50 });
  if (!posts.length) return [];
  const postIds = posts.map((post) => String(post.id));
  const likes = await repository.findMany("communityLikes", { user_id: userId, post_id: repository.command().in(postIds) });
  const likedPostIds = new Set(likes.map((like) => String(like.post_id)));
  return posts.map((post) => communityPostView(post, userId, likedPostIds));
};
const communityRanking = async (userId) => {
  const posts = await repository.findMany("communityPosts", {
    status: "approved",
    published_at: repository.command().gte(shanghaiWeekStart())
  }, { limit: 200 });
  const bestByAuthor = new Map();
  posts.sort((left, right) => Number(right.like_count || 0) - Number(left.like_count || 0) || String(left.published_at).localeCompare(String(right.published_at)));
  for (const post of posts) if (!bestByAuthor.has(String(post.user_id))) bestByAuthor.set(String(post.user_id), post);
  const ranked = [...bestByAuthor.values()].slice(0, 20);
  const likes = ranked.length ? await repository.findMany("communityLikes", { user_id: userId, post_id: repository.command().in(ranked.map((post) => String(post.id))) }) : [];
  const likedPostIds = new Set(likes.map((like) => String(like.post_id)));
  return ranked.map((post, index) => ({ rank: index + 1, ...communityPostView(post, userId, likedPostIds) }));
};
const outfitTokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const outfitToken = () => crypto.randomBytes(24).toString("base64url");
const outfitExpiresAt = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const requestIsOpen = (request) => request && request.status === "open" && Date.parse(request.expires_at) > Date.now();
const requestItems = (request) => (request.items || []).map((item) => ({
  id: String(item.id),
  name: item.name,
  category: item.category,
  color: item.color || "",
  imageUrl: cloud.signedUrl(item.image_key, "GET", 600)
}));
const publicOutfitRequest = (request, extra = {}) => ({
  id: String(request.id),
  question: request.question,
  status: requestIsOpen(request) ? "open" : request.status === "open" ? "expired" : request.status,
  createdAt: request.created_at,
  expiresAt: request.expires_at,
  participantCount: (request.participant_user_ids || []).length,
  participantLimit: 5,
  items: requestItems(request),
  ...extra
});
const validOutfitVerdict = (value) => ["like", "neutral", "dislike"].includes(value);
const invalidComment = (value) => /(?:https?:\/\/|www\.|微信号|加我|博彩|贷款)/i.test(value);

const ensureBudget = async () => {
  const limits = aiBudget.limitsFromEnv();
  let budget = await repository.getById("aiBudget", budgetId);
  if (budget) return budget;
  try {
    await repository.add("aiBudget", {
      spent_micros: 0,
      reserved_micros: 0,
      successful_tasks: 0,
      total_limit_micros: limits.totalMicros,
      task_limit: limits.taskLimit,
      updated_at: now()
    }, budgetId);
  } catch (error) {
    if (!String(error?.code || "").toLowerCase().includes("duplicate")) throw error;
  }
  return repository.getById("aiBudget", budgetId);
};

const budgetSummary = async () => aiBudget.publicSummary(await ensureBudget());

// 在调用任何付费 AI 前，用事务预留本任务最多 0.05 元；并发上传也不能突破项目总预算。
const reserveTaskBudget = async (taskId, userId, requestedMicros = null) => {
  await ensureBudget();
  const limits = aiBudget.limitsFromEnv();
  return repository.withTransaction(async (tx) => {
    const task = await tx.getById("aiUsage", taskId);
    if (!task || task.user_id !== userId) throw Object.assign(new Error("AI 任务不存在或已失效。"), { status: 404 });
    if (task.status === "completed") return { task, reservationMicros: 0, completed: true };
    if (task.reserved_micros > 0) return { task, reservationMicros: task.reserved_micros, completed: false };
    const budget = await tx.getById("aiBudget", budgetId);
    const spent = aiBudget.integer(budget.spent_micros);
    const reserved = aiBudget.integer(budget.reserved_micros);
    const successful = aiBudget.integer(budget.successful_tasks);
    const taskRemaining = requestedMicros == null ? limits.taskReservationMicros : aiBudget.integer(requestedMicros);
    if (!taskRemaining || spent + reserved + taskRemaining > limits.totalMicros || successful >= limits.taskLimit) {
      throw Object.assign(new Error("AI 测试额度已用完，可以继续手动录入。"), { status: 429, code: "AI_BUDGET_EXHAUSTED" });
    }
    await tx.update("aiBudget", budgetId, {
      reserved_micros: reserved + taskRemaining,
      updated_at: now()
    });
    await tx.update("aiUsage", task.id, {
      reserved_micros: taskRemaining,
      status: task.cutout_key ? "recognizing" : "processing",
      updated_at: now()
    });
    return { task: { ...task, reserved_micros: taskRemaining }, reservationMicros: taskRemaining, completed: false };
  });
};

// 任务结束后按已发生的抠图次数和 Token 实际结算，释放未使用预留；失败也会保留已发生费用。
const settleTaskBudget = async (taskId, userId, options) => {
  await ensureBudget();
  const limits = aiBudget.limitsFromEnv();
  return repository.withTransaction(async (tx) => {
    const task = await tx.getById("aiUsage", taskId);
    if (!task || task.user_id !== userId) throw Object.assign(new Error("AI 任务不存在或已失效。"), { status: 404 });
    const budget = await tx.getById("aiBudget", budgetId);
    const reservation = aiBudget.integer(task.reserved_micros);
    const charged = Math.min(reservation, aiBudget.integer(options.chargeMicros));
    const alreadyCompleted = task.status === "completed";
    const nextBudget = {
      reserved_micros: Math.max(0, aiBudget.integer(budget.reserved_micros) - reservation),
      spent_micros: Math.min(limits.totalMicros, aiBudget.integer(budget.spent_micros) + charged),
      successful_tasks: aiBudget.integer(budget.successful_tasks) + (options.success && !alreadyCompleted ? 1 : 0),
      updated_at: now()
    };
    await tx.update("aiBudget", budgetId, nextBudget);
    await tx.update("aiUsage", task.id, {
      reserved_micros: 0,
      cost_micros: aiBudget.integer(task.cost_micros) + charged,
      status: options.status,
      stage: options.stage || task.stage,
      error_code: options.errorCode || "",
      error_message: cleanText(options.errorMessage, 200),
      prompt_tokens: aiBudget.integer(task.prompt_tokens) + aiBudget.integer(options.usage?.prompt_tokens),
      completion_tokens: aiBudget.integer(task.completion_tokens) + aiBudget.integer(options.usage?.completion_tokens),
      // uniCloud update 会把普通嵌套对象合并为点路径；旧失败任务的 result 为 null 时会报错。
      // command.set 明确替换整个 result，使旧任务可以安全重试并写入新的识别结果。
      result: repository.command().set(options.result || task.result || null),
      updated_at: now()
    });
    return aiBudget.publicSummary({ ...budget, ...nextBudget }, limits);
  });
};

const handleRegister = async (body) => {
  const inviteCode = cleanText(body.inviteCode, 40);
  const username = cleanText(body.username, 30);
  const password = String(body.password || "");
  if (!inviteCode || !/^[\w\u4e00-\u9fa5-]{2,30}$/.test(username) || password.length < 8) {
    throw Object.assign(new Error("邀请码、用户名或密码格式不符合要求。"), { status: 400 });
  }
  const invite = await repository.findOne("invites", { code: inviteCode });
  if (!invite || invite.used_by) throw Object.assign(new Error("邀请码无效或已被使用。"), { status: 400 });
  if (await repository.findOne("users", { username })) throw Object.assign(new Error("该用户名已被使用。"), { status: 409 });

  const recoveryCode = crypto.randomBytes(6).toString("hex").toUpperCase();
  const user = {
    id: newId(),
    username,
    password_hash: await bcrypt.hash(password, 12),
    recovery_hash: await bcrypt.hash(recoveryCode, 12),
    created_at: now(),
    ...newTrialFields()
  };
  await repository.withTransaction(async (tx) => {
    const lockedInvite = await tx.getById("invites", invite.id);
    if (!lockedInvite || lockedInvite.used_by) throw Object.assign(new Error("邀请码无效或已被使用。"), { status: 400 });
    await tx.add("users", {
      username: user.username,
      password_hash: user.password_hash,
      recovery_hash: user.recovery_hash,
      created_at: user.created_at,
      entitlement_initialized_at: user.entitlement_initialized_at,
      trial_started_at: user.trial_started_at,
      trial_ends_at: user.trial_ends_at
    }, user.id);
    await tx.update("invites", lockedInvite.id, { used_by: user.id, used_at: now() });
  });
  return { user: publicUser(user), recoveryCode, token: tokenFor(user) };
};

// 分享令牌只保存哈希值；即使数据库被导出，也不能直接拼出可访问的分享链接。
const findOutfitRequestByToken = async (token) => {
  const safeToken = cleanText(token, 160);
  if (!safeToken || safeToken.length < 20) throw Object.assign(new Error("分享链接无效。"), { status: 400 });
  const request = await repository.findOne("outfitRequests", { token_hash: outfitTokenHash(safeToken) });
  if (!request) throw Object.assign(new Error("分享请求不存在或链接已失效。"), { status: 404 });
  return request;
};

const joinOutfitRequest = async (requestId, userId) => repository.withTransaction(async (tx) => {
  const request = await tx.getById("outfitRequests", requestId);
  if (!request) throw Object.assign(new Error("分享请求不存在。"), { status: 404 });
  if (!requestIsOpen(request)) {
    if (request.status === "open") await tx.update("outfitRequests", request.id, { status: "expired" });
    throw Object.assign(new Error("这次搭配请求已结束。"), { status: 410 });
  }
  if (request.owner_user_id === userId) return request;
  const participants = (request.participant_user_ids || []).map(String);
  if (!participants.includes(userId)) {
    if (participants.length >= 5) throw Object.assign(new Error("这次搭配请求已满 5 人。"), { status: 409 });
    participants.push(userId);
    await tx.update("outfitRequests", request.id, { participant_user_ids: participants });
    return { ...request, participant_user_ids: participants };
  }
  return request;
});

const handleOutfitGuestRegister = async (body) => {
  const request = await findOutfitRequestByToken(body.token);
  const username = cleanText(body.username, 30);
  const password = String(body.password || "");
  if (!/^[\w\u4e00-\u9fa5-]{2,30}$/.test(username) || password.length < 8) {
    throw Object.assign(new Error("用户名或密码格式不符合要求。"), { status: 400 });
  }
  if (await repository.findOne("users", { username })) throw Object.assign(new Error("该用户名已被使用。"), { status: 409 });
  const recoveryCode = crypto.randomBytes(6).toString("hex").toUpperCase();
  const user = {
    id: newId(), username, password_hash: await bcrypt.hash(password, 12),
    recovery_hash: await bcrypt.hash(recoveryCode, 12), created_at: now(), status: "active", ...newTrialFields()
  };
  await repository.withTransaction(async (tx) => {
    const lockedRequest = await tx.getById("outfitRequests", request.id);
    if (!requestIsOpen(lockedRequest)) throw Object.assign(new Error("这次搭配请求已结束。"), { status: 410 });
    const participants = (lockedRequest.participant_user_ids || []).map(String);
    if (participants.length >= 5) throw Object.assign(new Error("这次搭配请求已满 5 人。"), { status: 409 });
    await tx.add("users", {
      username: user.username, password_hash: user.password_hash, recovery_hash: user.recovery_hash,
      created_at: user.created_at, status: "active", entitlement_initialized_at: user.entitlement_initialized_at,
      trial_started_at: user.trial_started_at, trial_ends_at: user.trial_ends_at
    }, user.id);
    await tx.update("outfitRequests", lockedRequest.id, { participant_user_ids: [...participants, user.id] });
  });
  return { user: publicUser(user), recoveryCode, token: tokenFor(user) };
};

const handleMigration = async (payload) => {
  const tables = payload?.tables || {};
  const expected = { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0 };
  for (const [name, expectedCount] of Object.entries(expected)) {
    if (!Array.isArray(tables[name]) || tables[name].length !== expectedCount) {
      throw Object.assign(new Error(`迁移数据 ${name} 数量应为 ${expectedCount}。`), { status: 400 });
    }
  }
  const targetNames = { users: "users", invites: "invites", clothing_items: "clothing", wear_logs: "wearLogs", candidates: "candidates", image_drafts: "drafts" };
  for (const name of Object.values(targetNames)) {
    if (await repository.count(name)) throw Object.assign(new Error(`迁移已停止：云端 ${name} 不是空表。`), { status: 409 });
  }
  const userIds = new Set(tables.users.map((row) => String(row.id)));
  const itemIds = new Set(tables.clothing_items.map((row) => String(row.id)));
  if (tables.wear_logs.some((row) => !userIds.has(String(row.user_id)) || !itemIds.has(String(row.item_id)))) {
    throw Object.assign(new Error("迁移数据存在孤立穿着记录。"), { status: 400 });
  }

  await repository.withTransaction(async (tx) => {
    for (const row of tables.users) await tx.add("users", {
      username: row.username,
      role: row.role === "admin" ? "admin" : "user",
      password_hash: row.password_hash,
      recovery_hash: row.recovery_hash,
      created_at: row.created_at
    }, row.id);
    for (const row of tables.invites) await tx.add("invites", {
      code: row.code,
      used_by: row.used_by == null ? null : String(row.used_by),
      used_at: row.used_at || null,
      created_at: row.created_at
    }, row.id);
    for (const row of tables.clothing_items) await tx.add("clothing", {
      user_id: String(row.user_id),
      image_key: row.image_key,
      name: row.name,
      category: row.category,
      color: row.color || "",
      // 旧数据迁移也必须保留完整衣物属性，否则小程序详情只能显示场景而无法恢复材质等信息。
      season: row.season || "",
      thickness: row.thickness || "",
      pattern: row.pattern || "",
      material: row.material || "",
      styles: sanitizeTags(row.styles),
      scenes: sanitizeTags(row.scenes, allowedScenes),
      price: row.price == null ? null : Number(row.price),
      wear_count: Number(row.wear_count || 0),
      status: row.status || "active",
      idle_status: row.idle_status === "considering" ? "considering" : "active",
      idle_reason: allowedIdleReasons.includes(row.idle_reason) ? row.idle_reason : "",
      idle_note: cleanText(row.idle_note, 100),
      idle_marked_at: row.idle_marked_at || "",
      created_at: row.created_at,
      source_hash: row.source_hash || null,
      ...(row.source_hash ? { source_hash_key: `${row.user_id}:${row.source_hash}` } : {}),
      search_entity_id: row.search_entity_id || null
    }, row.id);
    for (const row of tables.wear_logs) await tx.add("wearLogs", {
      user_id: String(row.user_id),
      item_id: String(row.item_id),
      scene: row.scene || "",
      comfort: row.comfort || "",
      note: row.note || "",
      worn_at: row.worn_at
    }, row.id);
    for (const row of tables.candidates) await tx.add("candidates", {
      user_id: String(row.user_id),
      image_key: row.image_key,
      name: row.name,
      category: row.category,
      color: row.color || "",
      styles: sanitizeTags(row.styles),
      scenes: sanitizeTags(row.scenes, allowedScenes),
      price: row.price == null ? null : Number(row.price),
      decision: row.decision || null,
      analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null,
      created_at: row.created_at
    }, row.id);
  });
  return { migrated: expected, image_drafts: 0, orphanWearLogs: 0 };
};

const verifyData = async () => {
  const counts = {
    users: await repository.count("users"),
    invites: await repository.count("invites"),
    clothing_items: await repository.count("clothing"),
    wear_logs: await repository.count("wearLogs"),
    candidates: await repository.count("candidates"),
    image_drafts: await repository.count("drafts")
  };
  const items = new Set((await repository.findMany("clothing")).map((item) => String(item.id)));
  const wearLogs = await repository.findMany("wearLogs");
  const orphanWearLogs = wearLogs.filter((log) => !items.has(String(log.item_id))).length;
  return { counts, orphanWearLogs };
};

const taskProgress = (task, overrides = {}) => ({
  taskId: String(task.id),
  status: overrides.status || task.status,
  stage: overrides.stage || task.stage,
  providerName: overrides.providerName || null,
  modelName: overrides.modelName || null,
  actionText: overrides.actionText || ""
});

const ownedAiTask = async (taskId, userId, options = {}) => {
  const task = await repository.getById("aiUsage", taskId);
  if (!task || task.user_id !== userId || (task.mode === "manual" && options.allowManual !== true)) {
    throw Object.assign(new Error("AI 任务不存在或已失效。"), { status: 404 });
  }
  return task;
};

const taskImageState = (task) => ({
  originalCutoutUrl: task.cutout_key ? cloud.signedUrl(task.cutout_key, "GET", 3600) : null,
  hangerEditUrl: task.hanger_edit_key ? cloud.signedUrl(task.hanger_edit_key, "GET", 3600) : null,
  selectedImage: task.selected_image_key === task.hanger_edit_key && task.hanger_edit_key ? "hanger_edit" : "original"
});

// 抠图和模型识别分开结算：用户完成抠图后即使离开页面，也不会长期占用预算预留。
const processMattingTask = async (taskId, userId) => {
  let task = await ownedAiTask(taskId, userId, { allowManual: true });
  if (task.cutout_key) {
    return {
      ...taskProgress(task, {
        status: task.status === "completed" ? "completed" : "matting_completed",
        stage: task.mode === "manual" ? "awaiting_manual_fields" : task.status === "completed" ? "awaiting_confirmation" : "awaiting_recognition",
        providerName: "腾讯数据万象",
        modelName: "商品抠图",
        actionText: "已完成衣物背景去除"
      }),
      cutoutUrl: cloud.signedUrl(task.selected_image_key || task.cutout_key, "GET", 3600),
      ...taskImageState(task)
    };
  }
  await reserveTaskBudget(taskId, userId);
  task = await ownedAiTask(taskId, userId, { allowManual: true });
  let failedStage = "read_source";
  let cutoutKey = null;
  let mattingProviderCalls = 0;
  let mattingModelName = "商品抠图";
  let settled = false;
  try {
    if (!task.source_key?.startsWith(`uploads/${userId}/`)) {
      throw Object.assign(new Error("上传凭据无效，请重新选择图片。"), { status: 400 });
    }
    const sourceHash = await cloud.sourceHash(task.source_key);
    const exact = task.mode !== "candidate"
      ? await repository.findOne("clothing", { source_hash_key: `${userId}:${sourceHash}` })
      : null;
    if (exact) {
      throw Object.assign(new Error("这张衣物图片已经录入过。"), {
        status: 409,
        duplicate: { type: "blocked", item: mapItem(exact), score: 100 }
      });
    }
    failedStage = "goods_matting";
    const extraction = await cloud.extractGarment(task.source_key);
    cutoutKey = typeof extraction === "string" ? extraction : extraction.cutoutKey;
    mattingProviderCalls = typeof extraction === "string" ? 1 : Math.max(1, aiBudget.integer(extraction.providerCallCount));
    mattingModelName = typeof extraction === "string" ? "商品抠图" : extraction.modelName;
    await repository.update("aiUsage", task.id, {
      cutout_key: cutoutKey,
      source_hash: sourceHash,
      matting_calls: aiBudget.integer(task.matting_calls) + mattingProviderCalls,
      updated_at: now()
    });
    await settleTaskBudget(task.id, userId, {
      chargeMicros: aiBudget.limitsFromEnv().mattingCostMicros * mattingProviderCalls,
      status: "matting_completed",
      stage: task.mode === "manual" ? "awaiting_manual_fields" : "awaiting_recognition",
      success: false
    });
    settled = true;
    return {
      ...taskProgress(task, {
        status: "matting_completed",
        stage: task.mode === "manual" ? "awaiting_manual_fields" : "awaiting_recognition",
        providerName: "腾讯数据万象",
        modelName: mattingModelName,
        actionText: "已完成衣物背景去除"
      }),
      cutoutUrl: cloud.signedUrl(cutoutKey, "GET", 3600),
      ...taskImageState({ ...task, cutout_key: cutoutKey })
    };
  } catch (error) {
    error.aiTaskStage = failedStage;
    if (!settled) {
      const completedCalls = Math.max(mattingProviderCalls, aiBudget.integer(error?.providerCallCount));
      if (completedCalls) {
        await repository.update("aiUsage", task.id, {
          matting_calls: aiBudget.integer(task.matting_calls) + completedCalls,
          updated_at: now()
        }).catch(() => {});
      }
      await settleTaskBudget(task.id, userId, {
        chargeMicros: aiBudget.limitsFromEnv().mattingCostMicros * completedCalls,
        status: "failed_retryable",
        stage: "matting_failed",
        errorCode: String(error?.code || "MATTING_FAILED"),
        errorMessage: error.message,
        success: false
      }).catch(() => {});
    }
    throw error;
  } finally {
    // 只有已经得到透明图时才删除原图；读取或抠图失败时保留原图供同一 taskId 重试。
    if (cutoutKey && task.source_key) await cloud.deleteObject(task.source_key).catch(() => {});
  }
};

const processHangerEdit = async (taskId, userId) => {
  let task = await ownedAiTask(taskId, userId, { allowManual: true });
  if (!task.cutout_key) throw Object.assign(new Error("请先完成衣物抠图。"), { status: 409 });
  if (task.status === "completed") throw Object.assign(new Error("标签已生成，不能再替换本次识别图片。"), { status: 409 });
  if (task.hanger_edit_key) {
    return {
      ...taskProgress(task, {
        status: "hanger_edit_ready",
        stage: "awaiting_image_choice",
        providerName: "阿里云百炼",
        modelName: task.hanger_edit_model || "qwen-image-2.0",
        actionText: "衣架移除预览已生成，等待你选择"
      }),
      ...taskImageState(task)
    };
  }
  if (task.hanger_edit_status === "processing") {
    throw Object.assign(new Error("AI 正在生成衣架移除预览，请勿重复点击。"), { status: 409, code: "HANGER_EDIT_PROCESSING" });
  }
  const limits = aiBudget.limitsFromEnv();
  const maximumCharge = limits.imageEditCostMicros + limits.mattingCostMicros * 2;
  await reserveTaskBudget(taskId, userId, maximumCharge);
  const claim = await repository.withTransaction(async (tx) => {
    const current = await tx.getById("aiUsage", taskId);
    if (!current || current.user_id !== userId) throw Object.assign(new Error("AI 任务不存在或已失效。"), { status: 404 });
    if (current.hanger_edit_key) return { replay: true, task: current };
    if (current.hanger_edit_status === "processing") {
      throw Object.assign(new Error("AI 正在生成衣架移除预览，请勿重复点击。"), { status: 409, code: "HANGER_EDIT_PROCESSING" });
    }
    await tx.update("aiUsage", current.id, {
      hanger_edit_status: "processing",
      stage: "qwen_image_edit",
      updated_at: now()
    });
    return { replay: false, task: { ...current, hanger_edit_status: "processing", stage: "qwen_image_edit" } };
  });
  if (claim.replay) {
    return {
      ...taskProgress(claim.task, { status: "hanger_edit_ready", stage: "awaiting_image_choice", providerName: "阿里云百炼", modelName: claim.task.hanger_edit_model || "qwen-image-2.0", actionText: "衣架移除预览已生成，等待你选择" }),
      ...taskImageState(claim.task)
    };
  }
  task = claim.task;
  let settled = false;
  try {
    const edited = await cloud.removeHanger(task.cutout_key);
    const imageEditCalls = Math.max(1, aiBudget.integer(edited.imageEditCalls));
    const postMattingCalls = aiBudget.integer(edited.postMattingCalls);
    const chargeMicros = limits.imageEditCostMicros * imageEditCalls + limits.mattingCostMicros * postMattingCalls;
    await repository.update("aiUsage", task.id, {
      hanger_edit_key: edited.imageKey,
      hanger_edit_status: "ready",
      hanger_edit_calls: aiBudget.integer(task.hanger_edit_calls) + imageEditCalls,
      hanger_edit_model: edited.model,
      matting_calls: aiBudget.integer(task.matting_calls) + postMattingCalls,
      updated_at: now()
    });
    await settleTaskBudget(task.id, userId, {
      chargeMicros,
      status: "matting_completed",
      stage: "awaiting_image_choice",
      success: false
    });
    settled = true;
    const updated = await ownedAiTask(taskId, userId, { allowManual: true });
    return {
      ...taskProgress(updated, {
        status: "hanger_edit_ready",
        stage: "awaiting_image_choice",
        providerName: "阿里云百炼",
        modelName: edited.model,
        actionText: "衣架移除预览已生成，等待你选择"
      }),
      ...taskImageState(updated)
    };
  } catch (error) {
    error.aiTaskStage = "qwen_image_edit";
    const imageEditCalls = aiBudget.integer(error?.imageEditCallCount);
    const postMattingCalls = aiBudget.integer(error?.providerCallCount);
    await repository.update("aiUsage", task.id, {
      hanger_edit_status: "failed",
      hanger_edit_calls: aiBudget.integer(task.hanger_edit_calls) + imageEditCalls,
      matting_calls: aiBudget.integer(task.matting_calls) + postMattingCalls,
      updated_at: now()
    }).catch(() => {});
    if (!settled) {
      await settleTaskBudget(task.id, userId, {
        chargeMicros: limits.imageEditCostMicros * imageEditCalls + limits.mattingCostMicros * postMattingCalls,
        status: "matting_completed",
        stage: "hanger_edit_failed",
        errorCode: String(error?.code || "HANGER_EDIT_FAILED"),
        errorMessage: error.message,
        success: false
      }).catch(() => {});
    }
    throw error;
  }
};

const selectTaskImage = async (taskId, userId, choice) => {
  const task = await ownedAiTask(taskId, userId, { allowManual: true });
  if (!task.cutout_key) throw Object.assign(new Error("请先完成衣物抠图。"), { status: 409 });
  if (task.status === "completed") throw Object.assign(new Error("标签已生成，不能再替换本次识别图片。"), { status: 409 });
  const imageKey = choice === "hanger_edit" ? task.hanger_edit_key : task.cutout_key;
  if (!imageKey) throw Object.assign(new Error("衣架移除预览尚未生成。"), { status: 409 });
  await repository.update("aiUsage", task.id, { selected_image_key: imageKey, updated_at: now() });
  return {
    ...taskProgress(task, {
      status: "image_selected",
      stage: task.mode === "manual" ? "awaiting_manual_fields" : "awaiting_recognition",
      providerName: "衣橱关系",
      modelName: choice === "hanger_edit" ? task.hanger_edit_model || "qwen-image-2.0" : "原始抠图",
      actionText: choice === "hanger_edit" ? "已选择衣架移除图" : "已保留原始抠图"
    }),
    selectedImage: choice === "hanger_edit" ? "hanger_edit" : "original",
    cutoutUrl: cloud.signedUrl(imageKey, "GET", 3600)
  };
};

const processRecognitionStep = async (taskId, userId) => {
  let task = await ownedAiTask(taskId, userId);
  if (!task.cutout_key && task.status !== "completed") {
    throw Object.assign(new Error("请先完成商品抠图。"), { status: 409 });
  }
  const reservation = await reserveTaskBudget(taskId, userId);
  if (reservation.completed) {
    return {
      ...reservation.task.result,
      ...taskProgress(reservation.task, {
        status: "completed",
        stage: "awaiting_confirmation",
        providerName: "阿里云百炼",
        modelName: reservation.task.model || "qwen3-vl-plus",
        actionText: "已生成待确认的衣物候选标签"
      }),
      cutoutUrl: cloud.signedUrl(reservation.task.cutout_key, "GET", 3600),
      budget: await budgetSummary()
    };
  }
  task = await ownedAiTask(taskId, userId);
  let settled = false;
  try {
    const recognitionKey = task.selected_image_key || task.cutout_key;
    await repository.update("aiUsage", task.id, {
      recognition_attempts: aiBudget.integer(task.recognition_attempts) + 1,
      status: "recognizing",
      stage: "qwen_recognition",
      updated_at: now()
    });
    const recognition = await cloud.recognizeImage(recognitionKey);
    const chargeMicros = aiBudget.estimateQwenCostMicros(recognition.usage);
    if (!recognition.valid) {
      await settleTaskBudget(task.id, userId, {
        chargeMicros,
        status: "failed_retryable",
        stage: "recognition_rejected",
        errorCode: "GARMENT_NOT_ISOLATED",
        errorMessage: recognition.reason,
        usage: recognition.usage,
        success: false
      });
      settled = true;
      throw Object.assign(new Error(`未能只保留一件衣物：${recognition.reason}。请改用平铺或挂拍照片。`), { status: 422 });
    }
    const draftId = newId();
    await repository.add("drafts", {
      user_id: userId,
      image_key: recognitionKey,
      source_hash: task.source_hash,
      similarity: [],
      item_id: null,
      ai_task_id: task.id,
      created_at: now()
    }, draftId);
    const result = {
      taskId: task.id,
      draftId,
      cutoutUrl: cloud.signedUrl(recognitionKey, "GET", 3600),
      tags: recognition.tags,
      warning: null,
      duplicate: null,
      provider: recognition.provider,
      model: recognition.model
    };
    const budget = await settleTaskBudget(task.id, userId, {
      chargeMicros,
      status: "completed",
      stage: "awaiting_confirmation",
      usage: recognition.usage,
      result,
      success: true
    });
    settled = true;
    return {
      ...result,
      ...taskProgress(task, {
        status: "completed",
        stage: "awaiting_confirmation",
        providerName: "阿里云百炼",
        modelName: recognition.model,
        actionText: "已生成待确认的衣物候选标签"
      }),
      budget
    };
  } catch (error) {
    error.aiTaskStage = "qwen_recognition";
    if (!settled) {
      const providerUsage = error?.providerUsage || {};
      await settleTaskBudget(task.id, userId, {
        chargeMicros: aiBudget.estimateQwenCostMicros(providerUsage),
        status: "failed_retryable",
        stage: "recognition_failed",
        errorCode: String(error?.code || "RECOGNITION_FAILED"),
        errorMessage: error.message,
        usage: providerUsage,
        success: false
      }).catch(() => {});
    }
    throw error;
  }
};

// 旧接口继续串行执行两个新步骤，兼容尚未更新的小程序客户端。
const processRecognitionTask = async (taskId, userId) => {
  await processMattingTask(taskId, userId);
  return processRecognitionStep(taskId, userId);
};

const aiUsageSummary = async (query) => {
  const endAt = query.end ? new Date(query.end) : new Date();
  const startAt = query.start ? new Date(query.start) : new Date(endAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || startAt >= endAt) {
    throw Object.assign(new Error("请提供有效的统计起止时间。"), { status: 400 });
  }
  const rowLimit = 1000;
  const createdRange = repository.command().gte(startAt.toISOString()).and(repository.command().lt(endAt.toISOString()));
  const tasks = await repository.findMany("aiUsage", { created_at: createdRange }, { orderBy: "created_at", order: "asc", limit: rowLimit });
  const users = await repository.findMany("users", {}, { limit: rowLimit });
  const trialByUser = new Map(users.map((user) => [String(user.id), {
    start: Date.parse(user.trial_started_at || ""),
    end: Date.parse(user.trial_ends_at || "")
  }]));
  const byModel = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let mattingCalls = 0;
  let imageEditCalls = 0;
  let mattingCostMicros = 0;
  let imageEditCostMicros = 0;
  let costMicros = 0;
  let successfulCostMicros = 0;
  let successfulTasks = 0;
  let failedTasks = 0;
  let retryCount = 0;
  let trialTasks = 0;
  tasks.forEach((task) => {
    const model = cleanText(task.model, 80) || "unknown";
    const prompt = aiBudget.integer(task.prompt_tokens);
    const completion = aiBudget.integer(task.completion_tokens);
    const cost = aiBudget.integer(task.cost_micros);
    const mattings = aiBudget.integer(task.matting_calls);
    const edits = aiBudget.integer(task.hanger_edit_calls);
    const attempts = aiBudget.integer(task.recognition_attempts);
    const successful = task.status === "completed";
    promptTokens += prompt;
    completionTokens += completion;
    costMicros += cost;
    successfulCostMicros += successful ? cost : 0;
    mattingCalls += mattings;
    imageEditCalls += edits;
    mattingCostMicros += mattings * aiBudget.limitsFromEnv().mattingCostMicros;
    imageEditCostMicros += edits * aiBudget.limitsFromEnv().imageEditCostMicros;
    successfulTasks += successful ? 1 : 0;
    failedTasks += task.status === "failed_retryable" ? 1 : 0;
    retryCount += Math.max(0, attempts - 1);
    const trial = trialByUser.get(String(task.user_id));
    const createdAt = Date.parse(task.created_at || "");
    if (trial && Number.isFinite(createdAt) && createdAt >= trial.start && createdAt < trial.end) trialTasks += 1;
    const entry = byModel[model] || { tasks: 0, promptTokens: 0, completionTokens: 0, costYuan: 0 };
    entry.tasks += 1;
    entry.promptTokens += prompt;
    entry.completionTokens += completion;
    entry.costYuan = Number(((entry.costYuan * 1_000_000 + cost) / 1_000_000).toFixed(4));
    byModel[model] = entry;
  });
  return {
    start: startAt.toISOString(),
    end: endAt.toISOString(),
    taskCount: tasks.length,
    successfulTasks,
    failedTasks,
    retryCount,
    mattingCalls,
    imageEditCalls,
    mattingCostYuan: Number((mattingCostMicros / 1_000_000).toFixed(4)),
    imageEditCostYuan: Number((imageEditCostMicros / 1_000_000).toFixed(4)),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costYuan: Number((costMicros / 1_000_000).toFixed(4)),
    averageSuccessfulTaskCostYuan: successfulTasks ? Number((successfulCostMicros / successfulTasks / 1_000_000).toFixed(4)) : 0,
    trialUserCount: users.filter((user) => user.trial_started_at).length,
    trialTasks,
    subscriptions: { weekly: 0, monthly: 0, yearly: 0 },
    revenueYuan: null,
    grossMarginYuan: null,
    byModel,
    partial: tasks.length >= rowLimit || users.length >= rowLimit,
    rowLimit
  };
};

const awardDailyCheckin = async (tx, userId, timestamp) => {
  const dayKey = shanghaiDayKey(timestamp);
  const dailyEventId = starEventId(userId, "daily_checkin", dayKey);
  const existingEvent = await tx.getById("starEvents", dailyEventId);
  const account = await tx.getById("starAccounts", userId);
  if (existingEvent) {
    return { awardedPoints: 0, balance: Number(account?.balance || 0), duplicateDay: true };
  }
  const decision = nextStarAccount(account, dayKey, timestamp);
  decision.account.user_id = userId;
  await tx.add("starEvents", {
    user_id: userId,
    type: "daily_checkin",
    day_key: dayKey,
    month_key: dayKey.slice(0, 7),
    points: decision.dailyPoints,
    balance_after: Number(account?.balance || 0) + decision.dailyPoints,
    created_at: timestamp
  }, dailyEventId);
  if (decision.bonusPoints) {
    await tx.add("starEvents", {
      user_id: userId,
      type: "seven_day_bonus",
      day_key: dayKey,
      month_key: dayKey.slice(0, 7),
      points: decision.bonusPoints,
      balance_after: decision.account.balance,
      created_at: timestamp
    }, starEventId(userId, "seven_day_bonus", dayKey.slice(0, 7)));
  }
  if (account) await tx.update("starAccounts", userId, decision.account);
  else await tx.add("starAccounts", decision.account, userId);
  return { awardedPoints: decision.awardedPoints, balance: decision.account.balance, duplicateDay: false };
};

const starSummary = async (userId, currentTime = Date.now()) => {
  const account = await repository.getById("starAccounts", userId);
  const events = await repository.findMany("starEvents", { user_id: userId }, { orderBy: "created_at", order: "desc", limit: 50 });
  const today = shanghaiDayKey(currentTime);
  const activeStreak = account && [today, shiftDayKey(today, -1)].includes(account.last_checkin_day)
    ? Number(account.current_streak || 0)
    : 0;
  const eventLabels = { daily_checkin: "当天首次记录穿着", seven_day_bonus: "连续 7 天奖励", redemption: "兑换权益" };
  const totalEarned = Number(account?.total_earned || 0);
  return {
    balance: Number(account?.balance || 0),
    totalEarned,
    currentStreak: activeStreak,
    longestStreak: Number(account?.longest_streak || 0),
    monthCheckinDays: account?.month_key === today.slice(0, 7) ? Number(account.month_checkin_days || 0) : 0,
    monthEarned: account?.month_key === today.slice(0, 7) ? Number(account.month_earned || 0) : 0,
    monthlyLimit: STAR_MONTHLY_LIMIT,
    badges: [
      { id: "first", name: "衣橱起步", unlocked: totalEarned >= 1, note: "完成首次真实穿着记录" },
      { id: "seven", name: "七日坚持", unlocked: Number(account?.longest_streak || 0) >= 7, note: "连续记录 7 天" },
      { id: "thirty", name: "成长记录者", unlocked: totalEarned >= 30, note: "累计获得 30 颗星" }
    ],
    rewards: STAR_REWARD_CATALOG,
    exchangeEnabled: false,
    events: events.map((event) => ({
      id: String(event.id),
      type: event.type,
      label: eventLabels[event.type] || "星星变动",
      points: Number(event.points || 0),
      balanceAfter: Number(event.balance_after || 0),
      dayKey: event.day_key,
      createdAt: event.created_at
    }))
  };
};

const adminStarSummary = async (query) => {
  const start = String(query.start || "1970-01-01T00:00:00.000Z");
  const end = String(query.end || now());
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw Object.assign(new Error("请提供有效的星星统计时间范围。"), { status: 400 });
  }
  const range = repository.command().gte(start).and(repository.command().lt(end));
  const events = await repository.findMany("starEvents", { created_at: range }, { orderBy: "created_at", order: "desc", limit: 5000 });
  const issuedEvents = events.filter((event) => Number(event.points || 0) > 0);
  const totalIssued = issuedEvents.reduce((total, event) => total + Number(event.points || 0), 0);
  const theoreticalMaxAiCostYuan = totalIssued * (0.25 / 35);
  return {
    start,
    end,
    activeUsers: new Set(issuedEvents.map((event) => String(event.user_id))).size,
    checkinEvents: issuedEvents.filter((event) => event.type === "daily_checkin").length,
    sevenDayBonuses: issuedEvents.filter((event) => event.type === "seven_day_bonus").length,
    totalIssued,
    redemptionEvents: events.filter((event) => event.type === "redemption").length,
    theoreticalMaxAiCostYuan: Number(theoreticalMaxAiCostYuan.toFixed(2)),
    exchangeEnabled: false,
    partial: events.length >= 5000,
    rowLimit: 5000
  };
};

const route = async (event) => {
  const method = String(event.httpMethod || "GET").toUpperCase();
  const path = String(event.path || "/").replace(/\/+$/, "") || "/";
  const query = event.queryStringParameters || {};
  const body = ["POST", "PUT", "PATCH"].includes(method) ? parseBody(event) : {};

  if (method === "OPTIONS") return response(event, 204, null);
  if (method === "GET" && path === "/api/health") {
    // 新构建只有在私人搭配集合也可访问时才报告 database=ready。
    await Promise.all([repository.count("users"), repository.count("outfitPlans")]);
    const parsingEnabled = outfitParsingConfigured();
    return response(event, 200, {
      ok: true, service: "wardrobe", database: "ready", buildId: BUILD_ID,
      models: {
        outfitVision: OUTFIT_VISION_MODEL,
        outfitImageEdit: OUTFIT_IMAGE_EDIT_MODEL,
        garmentSegmentation: parsingEnabled ? "aitryon-parsing-v1" : GARMENT_SEGMENTATION_MODEL,
        productSegmentation: PRODUCT_SEGMENTATION_MODEL
      },
      garmentSegmentation: {
        provider: parsingEnabled ? "aliyun-bailian" : "aliyun-viapi",
        enabled: parsingEnabled || cloud._test.garmentSegmentationConfigured()
      },
      outfitParsing: { enabled: parsingEnabled, region: "cn-beijing" },
      inspiration: { enabled: true, platform: "xiaohongshu", mode: "private_observe_only" },
      outfitPlans: { enabled: true, mode: "private" },
      garmentSegmentationDiagnostic: {
        enabled: true,
        transport: "native_rpc_v2",
        fileAuthorizationTransport: "native_rpc_v2",
        credentialMode: cloud._test.viapiCredentialMode(),
        productionEnabled: false
      },
      imageEditIntervalMs: IMAGE_EDIT_INTERVAL_MS
    });
  }

  if (method === "POST" && path === "/api/auth/register") {
    return response(event, 201, await handleRegister(body));
  }
  if (method === "POST" && path === "/api/auth/login") {
    const user = await repository.findOne("users", { username: cleanText(body.username, 30) });
    if (!user || user.status === "deletion_requested" || !(await bcrypt.compare(String(body.password || ""), user.password_hash))) {
      throw Object.assign(new Error("用户名或密码不正确。"), { status: 401 });
    }
    const entitledUser = await ensureEntitlement(user.id);
    return response(event, 200, { user: publicUser(entitledUser), token: tokenFor(entitledUser) });
  }
  if (method === "POST" && path === "/api/auth/recover") {
    const user = await repository.findOne("users", { username: cleanText(body.username, 30) });
    const password = String(body.newPassword || "");
    if (!user || password.length < 8 || !(await bcrypt.compare(String(body.recoveryCode || ""), user.recovery_hash))) {
      throw Object.assign(new Error("恢复码或新密码不正确。"), { status: 400 });
    }
    await repository.update("users", user.id, { password_hash: await bcrypt.hash(password, 12) });
    const entitledUser = await ensureEntitlement(user.id);
    return response(event, 200, { user: publicUser(entitledUser), token: tokenFor(entitledUser) });
  }
  if (method === "POST" && path === "/api/auth/logout") return response(event, 204, null);
  if (method === "GET" && path === "/api/auth/me") {
    const activeUser = await requireActiveUser(event);
    return response(event, 200, { user: publicUser(await ensureEntitlement(activeUser.id)) });
  }
  if (method === "POST" && path === "/api/auth/outfit-guest-register") {
    return response(event, 201, await handleOutfitGuestRegister(body));
  }

  if (method === "POST" && path === "/api/admin/invites") {
    requireAdmin(event);
    const code = cleanText(body.code, 40) || crypto.randomBytes(5).toString("hex").toUpperCase();
    if (await repository.findOne("invites", { code })) throw Object.assign(new Error("邀请码已存在。"), { status: 409 });
    await repository.add("invites", { code, used_by: null, used_at: null, created_at: now() }, newId());
    return response(event, 201, { code });
  }
  if (method === "POST" && path === "/api/admin/migrate") {
    requireAdmin(event);
    return response(event, 201, await handleMigration(body));
  }
  if (method === "GET" && path === "/api/admin/verify") {
    requireAdmin(event);
    return response(event, 200, await verifyData());
  }
  if (method === "GET" && path === "/api/admin/ai-usage-summary") {
    requireAdmin(event);
    return response(event, 200, await aiUsageSummary(query));
  }
  if (method === "GET" && path === "/api/admin/star-summary") {
    requireAdmin(event);
    return response(event, 200, await adminStarSummary(query));
  }
  const adminCommunityMatch = path.match(/^\/api\/admin\/community\/posts\/([^/]+)$/);
  if (method === "PATCH" && adminCommunityMatch) {
    requireAdmin(event);
    const post = await repository.getById("communityPosts", decodeURIComponent(adminCommunityMatch[1]));
    if (!post) throw Object.assign(new Error("社区作品不存在。"), { status: 404 });
    const status = cleanText(body.status, 20);
    if (!["approved", "rejected", "removed"].includes(status)) throw Object.assign(new Error("审核状态无效。"), { status: 400 });
    await repository.update("communityPosts", post.id, {
      status,
      moderation_note: cleanText(body.note, 100),
      published_at: status === "approved" ? post.published_at || now() : post.published_at || "",
      updated_at: now()
    });
    return response(event, 200, { ok: true, status });
  }

  const user = await requireActiveUser(event);
  const userId = String(user.id);

  if (method === "GET" && path === "/api/outfit-plans") {
    const plans = await repository.findMany("outfitPlans", { user_id: userId }, { orderBy: "updated_at", order: "desc", limit: 100 });
    return response(event, 200, await Promise.all(plans.map(outfitPlanView)));
  }

  if (method === "POST" && path === "/api/outfit-plans") {
    const idempotencyKey = cleanText(body.idempotencyKey, 80);
    if (!idempotencyKey) throw Object.assign(new Error("缺少保存搭配的幂等标识。"), { status: 400 });
    const planId = idempotentId("outfit-plan", userId, idempotencyKey);
    const existing = await repository.getById("outfitPlans", planId);
    if (existing) return response(event, 200, await outfitPlanView(existing));
    const layout = sanitizeOutfitPlanLayout(body);
    for (const itemId of layout.itemIds) {
      const item = await repository.getById("clothing", itemId);
      if (!isAvailableOutfitItem(item, userId)) throw Object.assign(new Error("搭配中有衣物已移出当前衣橱，请刷新后重试。"), { status: 400 });
    }
    const timestamp = now();
    const planDocument = {
      user_id: userId,
      idempotency_key: idempotencyKey,
      title: `搭配方案 ${shanghaiMinuteLabel(timestamp)}`,
      canvas: layout.canvas,
      layers: layout.layers,
      item_ids: layout.itemIds,
      created_at: timestamp,
      updated_at: timestamp
    };
    try { await repository.add("outfitPlans", planDocument, planId); }
    catch (error) {
      const collided = await repository.getById("outfitPlans", planId);
      if (collided && String(collided.user_id) === userId) return response(event, 200, await outfitPlanView(collided));
      throw error;
    }
    return response(event, 201, await outfitPlanView(await repository.getById("outfitPlans", planId)));
  }

  const outfitPlanWearMatch = path.match(/^\/api\/outfit-plans\/([^/]+)\/wear$/);
  if (method === "POST" && outfitPlanWearMatch) {
    const plan = await requireOwnedOutfitPlan(decodeURIComponent(outfitPlanWearMatch[1]), userId);
    const idempotencyKey = cleanText(body.idempotencyKey, 80);
    if (!idempotencyKey) throw Object.assign(new Error("缺少穿搭记录幂等标识。"), { status: 400 });
    const recordId = idempotentId("manual-outfit-wear", userId, idempotencyKey);
    const existing = await repository.getById("outfitRecords", recordId);
    if (existing) return response(event, 200, { recordId: String(existing.id), recordedCount: (existing.items || []).length, duplicate: true });
    const date = cleanText(body.date, 10);
    const wornTimestamp = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T12:00:00+08:00`) : NaN;
    const wornAt = Number.isFinite(wornTimestamp) ? new Date(wornTimestamp).toISOString() : "";
    if (!wornAt || new Date(wornTimestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) !== date || date > shanghaiDayKey()) {
      throw Object.assign(new Error("请选择有效的穿着日期。"), { status: 400 });
    }
    const scene = allowedScenes.includes(body.scene) ? body.scene : "";
    const note = cleanText(body.note, 200);
    const itemIds = [...new Set((Array.isArray(plan.item_ids) ? plan.item_ids : []).map(String))];
    const items = [];
    for (const itemId of itemIds) {
      const item = await repository.getById("clothing", itemId);
      if (isAvailableOutfitItem(item, userId)) items.push(item);
    }
    if (!items.length) throw Object.assign(new Error("这套搭配中的衣物已不在当前衣橱。"), { status: 400 });
    const snapshots = items.map((item) => ({ id: String(item.id), name: item.name || "未命名衣物", category: item.category || "", color: item.color || "", styles: sanitizeTags(item.styles) }));
    let reward;
    try {
      reward = await repository.withTransaction(async (tx) => {
        await tx.add("outfitRecords", {
          user_id: userId,
          plan_id: String(plan.id),
          idempotency_key: idempotencyKey,
          source_type: "manual_plan",
          title: plan.title || "搭配方案",
          items: snapshots,
          layout: { canvas: plan.canvas, layers: plan.layers },
          scene,
          note,
          status: "confirmed",
          worn_at: wornAt,
          created_at: now()
        }, recordId);
        for (const item of items) {
          await tx.add("wearLogs", { user_id: userId, item_id: String(item.id), outfit_record_id: recordId, scene, comfort: "", note, worn_at: wornAt }, newId());
          await tx.update("clothing", item.id, { wear_count: repository.command().inc(1), last_worn_at: wornAt });
        }
        return date === shanghaiDayKey() ? awardDailyCheckin(tx, userId, wornAt) : { awardedPoints: 0, historical: true };
      });
    } catch (error) {
      const collided = await repository.getById("outfitRecords", recordId);
      if (collided && String(collided.user_id) === userId) return response(event, 200, { recordId, recordedCount: (collided.items || []).length, duplicate: true });
      throw error;
    }
    return response(event, 201, { recordId, recordedCount: items.length, duplicate: false, reward });
  }

  const outfitPlanMatch = path.match(/^\/api\/outfit-plans\/([^/]+)$/);
  if (method === "PUT" && outfitPlanMatch) {
    const plan = await requireOwnedOutfitPlan(decodeURIComponent(outfitPlanMatch[1]), userId);
    const layout = sanitizeOutfitPlanLayout(body);
    for (const itemId of layout.itemIds) {
      const item = await repository.getById("clothing", itemId);
      if (!isAvailableOutfitItem(item, userId)) throw Object.assign(new Error("搭配中有衣物已移出当前衣橱，请刷新后重试。"), { status: 400 });
    }
    await repository.update("outfitPlans", plan.id, { canvas: layout.canvas, layers: layout.layers, item_ids: layout.itemIds, updated_at: now() });
    return response(event, 200, await outfitPlanView(await repository.getById("outfitPlans", plan.id)));
  }
  if (method === "DELETE" && outfitPlanMatch) {
    const plan = await requireOwnedOutfitPlan(decodeURIComponent(outfitPlanMatch[1]), userId);
    await repository.remove("outfitPlans", plan.id);
    return response(event, 204, null);
  }

  if (method === "POST" && path === "/api/inspirations") {
    const sourceType = body.sourceType === "user_screenshot" ? "user_screenshot" : "xiaohongshu_link";
    const idempotencyKey = cleanText(body.idempotencyKey, 80);
    if (!idempotencyKey) throw Object.assign(new Error("缺少灵感任务幂等标识。"), { status: 400 });
    const existing = await repository.findOne("inspirations", { user_id: userId, idempotency_key: idempotencyKey });
    if (existing) return response(event, 200, await inspirationView(existing, existing.status === "ready"));

    const recordId = newId();
    const createdAt = now();
    let sourceUrl = "";
    const screenshotMimeType = cleanText(body.mimeType, 40).toLowerCase();
    if (sourceType === "user_screenshot" && !["image/jpeg", "image/png", "image/webp"].includes(screenshotMimeType)) {
      throw Object.assign(new Error("截图仅支持 JPG、PNG 或 WebP。"), { status: 400 });
    }
    if (sourceType === "xiaohongshu_link") sourceUrl = inspiration.extractXiaohongshuUrl(body.shareText || body.sourceUrl);
    await repository.add("inspirations", {
      user_id: userId,
      idempotency_key: idempotencyKey,
      source_type: sourceType,
      platform: "xiaohongshu",
      source_url: sourceUrl,
      source_title: "",
      source_author: "",
      saved_image_key: "",
      temporary_image_keys: [],
      temporary_deleted_at: "",
      status: sourceType === "xiaohongshu_link" ? "resolving" : "screenshot_required",
      detected_outfit: {},
      confirmed_slots: [],
      summary: "",
      error_code: "",
      created_at: createdAt,
      updated_at: createdAt
    }, recordId);
    if (sourceType === "user_screenshot") {
      const upload = cloud.createInspirationUpload(userId, recordId, screenshotMimeType);
      await repository.update("inspirations", recordId, { saved_image_key: upload.sourceKey, updated_at: now() });
      return response(event, 201, { record: await inspirationView(await repository.getById("inspirations", recordId)), upload });
    }

    const resolved = await inspiration.resolveXiaohongshuPublicContent(sourceUrl);
    if (resolved.screenshotRequired) {
      await repository.update("inspirations", recordId, {
        source_url: resolved.sourceUrl || sourceUrl,
        source_title: resolved.title || "",
        source_author: resolved.author || "",
        status: "screenshot_required",
        error_code: resolved.errorCode,
        updated_at: now()
      });
    } else {
      const temporaryKeys = await cloud.storeTemporaryInspirationImages(userId, recordId, resolved.images);
      try {
        await repository.update("inspirations", recordId, {
          source_url: resolved.sourceUrl || sourceUrl,
          source_title: resolved.title || "",
          source_author: resolved.author || "",
          temporary_image_keys: temporaryKeys,
          status: "ready_to_analyze",
          error_code: "",
          updated_at: now()
        });
      } catch (error) {
        await Promise.all(temporaryKeys.map((key) => cloud.deleteObject(key).catch(() => {})));
        throw error;
      }
    }
    return response(event, 201, await inspirationView(await repository.getById("inspirations", recordId)));
  }

  if (method === "GET" && path === "/api/inspirations") {
    const records = await repository.findMany("inspirations", { user_id: userId }, { orderBy: "updated_at", order: "desc", limit: 50 });
    return response(event, 200, { records: await Promise.all(records.map((record) => inspirationView(record))) });
  }

  const inspirationMatch = path.match(/^\/api\/inspirations\/([^/]+)$/);
  if (method === "GET" && inspirationMatch) {
    const record = await requireOwnedInspiration(decodeURIComponent(inspirationMatch[1]), userId);
    return response(event, 200, await inspirationView(record, true));
  }

  const inspirationScreenshotMatch = path.match(/^\/api\/inspirations\/([^/]+)\/screenshot\/presign$/);
  if (method === "POST" && inspirationScreenshotMatch) {
    const record = await requireOwnedInspiration(decodeURIComponent(inspirationScreenshotMatch[1]), userId);
    const mimeType = cleanText(body.mimeType, 40).toLowerCase();
    const size = Number(body.size || 0);
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || size < 1 || size > 5 * 1024 * 1024) {
      throw Object.assign(new Error("请上传不超过 5MB 的 JPG、PNG 或 WebP 截图。"), { status: 400 });
    }
    const upload = cloud.createInspirationUpload(userId, record.id, mimeType);
    await repository.update("inspirations", record.id, {
      saved_image_key: upload.sourceKey,
      status: "ready_to_analyze",
      error_code: "",
      updated_at: now()
    });
    return response(event, 200, upload);
  }

  const inspirationAnalyzeMatch = path.match(/^\/api\/inspirations\/([^/]+)\/analyze$/);
  if (method === "POST" && inspirationAnalyzeMatch) {
    const record = await requireOwnedInspiration(decodeURIComponent(inspirationAnalyzeMatch[1]), userId);
    if (["awaiting_confirmation", "ready"].includes(record.status) && record.detected_outfit?.slots?.length) {
      return response(event, 200, await inspirationView(record, record.status === "ready"));
    }
    const temporaryKeys = Array.isArray(record.temporary_image_keys) ? record.temporary_image_keys.filter(Boolean).slice(0, 3) : [];
    const imageKeys = temporaryKeys.length ? temporaryKeys : record.saved_image_key ? [record.saved_image_key] : [];
    if (!imageKeys.length) throw Object.assign(new Error("请先上传截图再识别。"), { status: 409, code: "INSPIRATION_SCREENSHOT_REQUIRED" });
    const firstImage = await cloud.readObject(imageKeys[0]);
    if (firstImage.length > 5 * 1024 * 1024) throw Object.assign(new Error("灵感图片不能超过 5MB。"), { status: 400 });
    if (!inspiration.detectImageMime(firstImage)) throw Object.assign(new Error("灵感图片仅支持 JPG、PNG 或 WebP。"), { status: 400, code: "INSPIRATION_IMAGE_TYPE_INVALID" });

    const taskId = `inspiration-${record.id}`;
    let task = await repository.getById("aiUsage", taskId);
    if (!task) {
      await repository.add("aiUsage", {
        user_id: userId,
        idempotency_key: taskId,
        source_key: imageKeys[0],
        mode: "inspiration",
        provider: "dashscope",
        model: process.env.QWEN_VL_MODEL || OUTFIT_VISION_MODEL,
        status: "pending",
        stage: "inspiration_analysis",
        reserved_micros: 0,
        cost_micros: 0,
        matting_calls: 0,
        recognition_attempts: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        result: null,
        error_code: "",
        error_message: "",
        created_at: now(),
        updated_at: now()
      }, taskId);
      task = await repository.getById("aiUsage", taskId);
    }
    let reserved = false;
    try {
      const reservation = await reserveTaskBudget(taskId, userId);
      reserved = !reservation.completed;
      await repository.update("inspirations", record.id, { status: "analyzing", error_code: "", updated_at: now() });
      const analyzed = reservation.completed && task.result?.analysis
        ? { result: task.result.analysis, usage: {}, provider: task.provider, model: task.model }
        : await cloud.analyzeInspirationImages(imageKeys, { sourceTitle: record.source_title || "" });
      if (!reservation.completed) {
        await settleTaskBudget(taskId, userId, {
          chargeMicros: aiBudget.estimateQwenCostMicros(analyzed.usage),
          success: true,
          status: "completed",
          stage: "inspiration_analysis",
          usage: analyzed.usage,
          result: { analysis: analyzed.result }
        });
      }
      await repository.update("inspirations", record.id, {
        detected_outfit: analyzed.result,
        summary: analyzed.result.summary,
        status: "awaiting_confirmation",
        temporary_image_keys: [],
        temporary_deleted_at: temporaryKeys.length ? now() : record.temporary_deleted_at || "",
        error_code: "",
        updated_at: now()
      });
      return response(event, 200, await inspirationView(await repository.getById("inspirations", record.id)));
    } catch (error) {
      if (reserved) {
        await settleTaskBudget(taskId, userId, {
          chargeMicros: aiBudget.estimateQwenCostMicros(error.providerUsage || {}),
          success: false,
          status: "failed",
          stage: "inspiration_analysis",
          usage: error.providerUsage || {},
          errorCode: error.code || "INSPIRATION_AI_FAILED",
          errorMessage: error.message,
          result: error.safeDiagnostic ? { diagnostic: error.safeDiagnostic } : null
        }).catch(() => {});
      }
      const fallbackEligible = error.code === "INSPIRATION_NO_OUTFIT" || error.safeDiagnostic?.retryCount === 1;
      const fallbackStatus = fallbackEligible && temporaryKeys.length ? "screenshot_required" : "failed";
      await repository.update("inspirations", record.id, {
        status: fallbackStatus,
        temporary_image_keys: [],
        temporary_deleted_at: temporaryKeys.length ? now() : record.temporary_deleted_at || "",
        error_code: cleanText(error.code, 80) || "INSPIRATION_AI_FAILED",
        updated_at: now()
      });
      if (fallbackEligible) return response(event, 200, await inspirationView(await repository.getById("inspirations", record.id)));
      throw error;
    } finally {
      await Promise.all(temporaryKeys.map((key) => cloud.deleteObject(key).catch(() => {})));
    }
  }

  const inspirationConfirmMatch = path.match(/^\/api\/inspirations\/([^/]+)\/confirm$/);
  if (method === "PATCH" && inspirationConfirmMatch) {
    const record = await requireOwnedInspiration(decodeURIComponent(inspirationConfirmMatch[1]), userId);
    const confirmed = inspiration.sanitizeOutfitAnalysis({
      mainImageIndex: record.detected_outfit?.mainImageIndex || 0,
      summary: body.summary || record.summary,
      slots: body.slots
    });
    await repository.update("inspirations", record.id, {
      confirmed_slots: confirmed.slots,
      summary: confirmed.summary,
      status: "ready",
      error_code: "",
      updated_at: now()
    });
    return response(event, 200, await inspirationView(await repository.getById("inspirations", record.id), true));
  }

  if (method === "DELETE" && inspirationMatch) {
    const record = await requireOwnedInspiration(decodeURIComponent(inspirationMatch[1]), userId);
    const keys = [record.saved_image_key, ...(Array.isArray(record.temporary_image_keys) ? record.temporary_image_keys : [])].filter(Boolean);
    await Promise.all(keys.map((key) => cloud.deleteObject(key).catch(() => {})));
    await repository.remove("inspirations", record.id);
    return response(event, 204, null);
  }

  if (method === "GET" && path === "/api/community/admin/review") {
    requireCommunityAdmin(user);
    const posts = await repository.findMany("communityPosts", { status: "pending" }, { orderBy: "created_at", order: "asc", limit: 100 });
    const reports = await repository.findMany("complaints", { category: "社区举报", status: "pending" }, { orderBy: "created_at", order: "asc", limit: 100 });
    const targetIds = [...new Set(reports.map((report) => String(report.target_id || "")).filter(Boolean))];
    const targetPosts = targetIds.length ? await repository.findMany("communityPosts", { _id: repository.command().in(targetIds) }) : [];
    const postsById = new Map(targetPosts.map((post) => [String(post.id), post]));
    return response(event, 200, {
      posts: posts.map((post) => communityPostView(post, userId)),
      reports: reports.map((report) => ({
        id: String(report.id),
        reason: report.reason || report.detail,
        createdAt: report.created_at,
        post: postsById.has(String(report.target_id)) ? communityPostView(postsById.get(String(report.target_id)), userId) : null
      }))
    });
  }
  const communityAdminPostMatch = path.match(/^\/api\/community\/admin\/posts\/([^/]+)$/);
  if (method === "PATCH" && communityAdminPostMatch) {
    requireCommunityAdmin(user);
    const post = await repository.getById("communityPosts", decodeURIComponent(communityAdminPostMatch[1]));
    if (!post || post.status !== "pending") throw Object.assign(new Error("待审核作品不存在。"), { status: 404 });
    const status = body.status === "approved" ? "approved" : body.status === "rejected" ? "rejected" : "";
    if (!status) throw Object.assign(new Error("审核结果无效。"), { status: 400 });
    await repository.update("communityPosts", post.id, {
      status,
      moderation_note: cleanText(body.note, 100),
      published_at: status === "approved" ? now() : "",
      updated_at: now()
    });
    return response(event, 200, { ok: true, status });
  }
  const communityAdminReportMatch = path.match(/^\/api\/community\/admin\/reports\/([^/]+)$/);
  if (method === "PATCH" && communityAdminReportMatch) {
    requireCommunityAdmin(user);
    const report = await repository.getById("complaints", decodeURIComponent(communityAdminReportMatch[1]));
    if (!report || report.category !== "社区举报" || report.status !== "pending") throw Object.assign(new Error("待处理举报不存在。"), { status: 404 });
    const action = body.action === "remove_post" ? "remove_post" : body.action === "dismiss" ? "dismiss" : "";
    if (!action) throw Object.assign(new Error("举报处理方式无效。"), { status: 400 });
    if (action === "remove_post" && report.target_id) {
      const targetPost = await repository.getById("communityPosts", report.target_id);
      if (targetPost) await repository.update("communityPosts", targetPost.id, { status: "removed", moderation_note: "举报处理下架", updated_at: now() });
    }
    await repository.update("complaints", report.id, { status: "resolved", resolution: action, updated_at: now() });
    return response(event, 200, { ok: true, action });
  }

  if (method === "GET" && path === "/api/ai-budget") {
    return response(event, 200, await budgetSummary());
  }
  if (method === "GET" && path === "/api/entitlements/me") {
    return response(event, 200, await entitlementWithQuota(await ensureEntitlement(userId)));
  }
  if (method === "GET" && path === "/api/plans") {
    return response(event, 200, {
      purchaseEnabled: false,
      plans: PLAN_CATALOG
    });
  }
  if (method === "GET" && path === "/api/rewards/me") {
    return response(event, 200, await starSummary(userId));
  }
  if (method === "GET" && path === "/api/community/posts") {
    const scope = query.scope === "mine" ? "mine" : "feed";
    return response(event, 200, { posts: await communityPostList(userId, scope), limit: 50 });
  }
  if (method === "GET" && path === "/api/community/ranking") {
    return response(event, 200, { weekStart: shanghaiWeekStart(), posts: await communityRanking(userId) });
  }
  if (method === "POST" && path === "/api/community/posts") {
    const itemIds = [...new Set((body.itemIds || []).map(String))].slice(0, 5);
    if (itemIds.length < 2) throw Object.assign(new Error("请选择 2–5 件衣物组成穿搭。"), { status: 400 });
    const scene = cleanText(body.scene, 10);
    if (!allowedScenes.includes(scene)) throw Object.assign(new Error("请选择有效场景。"), { status: 400 });
    const note = cleanText(body.note, 31);
    if (note.length > 30) throw Object.assign(new Error("搭配心得最多 30 个字。"), { status: 400 });
    if (invalidComment(note)) throw Object.assign(new Error("搭配心得不能包含链接或联系方式。"), { status: 400 });
    const ownedItems = await repository.findMany("clothing", { user_id: userId, status: "active", _id: repository.command().in(itemIds) });
    if (ownedItems.length !== itemIds.length) throw Object.assign(new Error("只能发布本人仍在衣橱中的衣物。"), { status: 403 });
    const byId = new Map(ownedItems.map((item) => [String(item.id), item]));
    const postId = newId();
    const timestamp = now();
    await repository.add("communityPosts", {
      user_id: userId,
      author_alias: communityAlias(userId),
      items: itemIds.map((id) => {
        const item = byId.get(id);
        return { id, name: item.name, category: item.category, color: item.color || "", image_key: item.image_key };
      }),
      scene,
      note,
      status: "pending",
      like_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
      published_at: ""
    }, postId);
    return response(event, 201, { post: communityPostView(await repository.getById("communityPosts", postId), userId), moderation: "manual_pending" });
  }
  const communityPostMatch = path.match(/^\/api\/community\/posts\/([^/]+)$/);
  if (method === "DELETE" && communityPostMatch) {
    const post = await repository.getById("communityPosts", decodeURIComponent(communityPostMatch[1]));
    if (!post || String(post.user_id) !== userId) throw Object.assign(new Error("社区作品不存在。"), { status: 404 });
    await repository.update("communityPosts", post.id, { status: "removed", updated_at: now() });
    return response(event, 200, { ok: true });
  }
  const communityLikeMatch = path.match(/^\/api\/community\/posts\/([^/]+)\/like$/);
  if (method === "PUT" && communityLikeMatch) {
    const postId = decodeURIComponent(communityLikeMatch[1]);
    const action = body.action === "unlike" ? "unlike" : "like";
    const post = await repository.getById("communityPosts", postId);
    if (!post || post.status !== "approved") throw Object.assign(new Error("该作品暂不可点赞。"), { status: 404 });
    if (String(post.user_id) === userId) throw Object.assign(new Error("不能给自己的作品点赞。"), { status: 400 });
    const likeId = communityLikeId(postId, userId);
    const result = await repository.withTransaction(async (tx) => {
      const existing = await tx.getById("communityLikes", likeId);
      if (action === "like" && !existing) {
        await tx.add("communityLikes", { post_id: postId, user_id: userId, created_at: now() }, likeId);
        await tx.update("communityPosts", postId, { like_count: repository.command().inc(1), updated_at: now() });
        return true;
      }
      if (action === "unlike" && existing) {
        await tx.remove("communityLikes", likeId);
        await tx.update("communityPosts", postId, { like_count: repository.command().inc(-1), updated_at: now() });
        return false;
      }
      return Boolean(existing);
    });
    const updated = await repository.getById("communityPosts", postId);
    return response(event, 200, { liked: result, likeCount: Math.max(0, Number(updated.like_count || 0)) });
  }
  const communityReportMatch = path.match(/^\/api\/community\/posts\/([^/]+)\/report$/);
  if (method === "POST" && communityReportMatch) {
    const postId = decodeURIComponent(communityReportMatch[1]);
    const post = await repository.getById("communityPosts", postId);
    if (!post || post.status !== "approved") throw Object.assign(new Error("该作品不存在。"), { status: 404 });
    if (String(post.user_id) === userId) throw Object.assign(new Error("不能举报自己的作品。"), { status: 400 });
    const reason = cleanText(body.reason, 40);
    if (!reason) throw Object.assign(new Error("请选择举报原因。"), { status: 400 });
    const reportId = communityLikeId(`report:${postId}`, userId);
    if (await repository.getById("complaints", reportId)) return response(event, 200, { ok: true, duplicate: true });
    const timestamp = now();
    await repository.add("complaints", { user_id: userId, category: "社区举报", detail: `作品 ${postId}：${reason}`, contact: "", target_type: "community_post", target_id: postId, reason, status: "pending", created_at: timestamp, updated_at: timestamp }, reportId);
    return response(event, 201, { ok: true });
  }
  if (method === "GET" && path === "/api/weather") {
    const adcode = String(query.adcode || "").trim();
    if (!/^\d{6}$/.test(adcode)) throw Object.assign(new Error("请选择有效的省、市或区县。"), { status: 400 });
    return response(event, 200, await weatherService.getLiveWeather(adcode));
  }

  if (method === "POST" && path === "/api/auth/delete-request") {
    // 用户截图约定保存到单条删除或账号删除为止，因此灵感记录和关联对象在停用账号前立即清理。
    const records = await repository.findMany("inspirations", { user_id: userId }, { limit: 1000 });
    for (const record of records) {
      const keys = [record.saved_image_key, ...(Array.isArray(record.temporary_image_keys) ? record.temporary_image_keys : [])].filter(Boolean);
      await Promise.all(keys.map((key) => cloud.deleteObject(key)));
      await repository.remove("inspirations", record.id);
    }
    // 其他关联数据仍沿用现有最长 30 天的人工核验与删除处理窗口。
    await repository.update("users", userId, { status: "deletion_requested", deletion_requested_at: now() });
    return response(event, 202, { ok: true, message: "账号已停用并进入删除队列。" });
  }

  if (method === "POST" && path === "/api/complaints") {
    const category = cleanText(body.category, 20);
    const detail = cleanText(body.detail, 500);
    const allowedComplaintCategories = ["功能问题", "隐私与数据", "不当内容", "其他"];
    if (!allowedComplaintCategories.includes(category) || detail.length < 5) {
      throw Object.assign(new Error("请选择投诉类型，并填写至少 5 个字的说明。"), { status: 400 });
    }
    const id = newId();
    await repository.add("complaints", {
      user_id: userId,
      category,
      detail,
      contact: cleanText(body.contact, 80),
      status: "submitted",
      created_at: now(),
      updated_at: now()
    }, id);
    return response(event, 201, { id, status: "submitted", message: "投诉已提交。" });
  }

  if (method === "POST" && path === "/api/outfit-requests") {
    const itemIds = [...new Set(parseArray(body.itemIds).map((id) => cleanText(id, 80)).filter(Boolean))];
    const question = cleanText(body.question, 200);
    if (itemIds.length < 1 || itemIds.length > 5 || !question) {
      throw Object.assign(new Error("请选择 1 至 5 件衣物，并填写搭配问题。"), { status: 400 });
    }
    const ownedItems = await repository.findMany("clothing", { user_id: userId, status: "active", _id: repository.command().in(itemIds) });
    const ownedById = new Map(ownedItems.map((item) => [String(item.id), item]));
    const selected = itemIds.map((id) => ownedById.get(id));
    if (selected.some((item) => !item)) throw Object.assign(new Error("只能分享自己衣橱中仍有效的衣物。"), { status: 403 });
    const rawToken = outfitToken();
    const requestId = newId();
    const createdAt = now();
    await repository.add("outfitRequests", {
      owner_user_id: userId,
      items: selected.map((item) => ({ id: String(item.id), name: item.name, category: item.category, color: item.color || "", image_key: item.image_key })),
      question,
      token_hash: outfitTokenHash(rawToken),
      status: "open",
      participant_user_ids: [],
      responded_user_ids: [],
      created_at: createdAt,
      expires_at: outfitExpiresAt(),
      closed_at: null
    }, requestId);
    return response(event, 201, { ...publicOutfitRequest(await repository.getById("outfitRequests", requestId)), token: rawToken });
  }

  const outfitRequestByTokenMatch = path.match(/^\/api\/outfit-requests\/([^/]+)$/);
  if (method === "GET" && outfitRequestByTokenMatch) {
    const request = await findOutfitRequestByToken(decodeURIComponent(outfitRequestByTokenMatch[1]));
    const joined = request.owner_user_id === userId ? request : await joinOutfitRequest(request.id, userId);
    const ownResponse = request.owner_user_id === userId ? null : await repository.findOne("outfitResponses", { request_id: request.id, user_id: userId });
    return response(event, 200, publicOutfitRequest(joined, { isOwner: joined.owner_user_id === userId, ownResponse: ownResponse ? {
      verdict: ownResponse.verdict, comment: ownResponse.comment, reported: Boolean(ownResponse.reported)
    } : null }));
  }

  const outfitResponseMatch = path.match(/^\/api\/outfit-requests\/([^/]+)\/responses$/);
  if (method === "POST" && outfitResponseMatch) {
    const request = await findOutfitRequestByToken(decodeURIComponent(outfitResponseMatch[1]));
    if (request.owner_user_id === userId) throw Object.assign(new Error("发起人不能给自己的搭配请求回复。"), { status: 403 });
    const verdict = cleanText(body.verdict, 20);
    const comment = cleanText(body.comment, 200);
    if (!validOutfitVerdict(verdict) || !comment || invalidComment(comment)) {
      throw Object.assign(new Error("请选择建议并填写不超过 200 字的正常短评。"), { status: 400 });
    }
    await joinOutfitRequest(request.id, userId);
    await repository.withTransaction(async (tx) => {
      const locked = await tx.getById("outfitRequests", request.id);
      if (!requestIsOpen(locked) || !(locked.participant_user_ids || []).map(String).includes(userId)) {
        throw Object.assign(new Error("这次搭配请求已结束或你没有访问权限。"), { status: 403 });
      }
      const replied = (locked.responded_user_ids || []).map(String);
      if (replied.includes(userId)) throw Object.assign(new Error("你已经回复过，可修改原回复。"), { status: 409 });
      await tx.add("outfitResponses", {
        request_id: locked.id, user_id: userId, verdict, comment, reported: false, hidden: false,
        report_reason: "", created_at: now(), updated_at: now()
      }, newId());
      await tx.update("outfitRequests", locked.id, { responded_user_ids: [...replied, userId] });
    });
    return response(event, 201, { ok: true });
  }

  const outfitResponseUpdateMatch = path.match(/^\/api\/outfit-requests\/([^/]+)\/responses\/me$/);
  if (method === "PATCH" && outfitResponseUpdateMatch) {
    const request = await findOutfitRequestByToken(decodeURIComponent(outfitResponseUpdateMatch[1]));
    if (!requestIsOpen(request) || request.owner_user_id === userId || !(request.participant_user_ids || []).map(String).includes(userId)) {
      throw Object.assign(new Error("这次搭配请求已结束或你没有访问权限。"), { status: 403 });
    }
    const verdict = cleanText(body.verdict, 20);
    const comment = cleanText(body.comment, 200);
    if (!validOutfitVerdict(verdict) || !comment || invalidComment(comment)) throw Object.assign(new Error("请填写有效的建议和短评。"), { status: 400 });
    const existing = await repository.findOne("outfitResponses", { request_id: request.id, user_id: userId });
    if (!existing) throw Object.assign(new Error("尚未提交回复。"), { status: 404 });
    if (existing.reported) throw Object.assign(new Error("该回复正在处理举报，暂不能修改。"), { status: 409 });
    await repository.update("outfitResponses", existing.id, { verdict, comment, updated_at: now() });
    return response(event, 200, { ok: true });
  }

  const outfitCloseMatch = path.match(/^\/api\/outfit-requests\/([^/]+)\/close$/);
  if (method === "POST" && outfitCloseMatch) {
    const request = await repository.getById("outfitRequests", decodeURIComponent(outfitCloseMatch[1]));
    if (!request || request.owner_user_id !== userId) throw Object.assign(new Error("未找到可关闭的搭配请求。"), { status: 404 });
    if (request.status !== "open") return response(event, 200, { ok: true, status: request.status });
    await repository.update("outfitRequests", request.id, { status: "closed", closed_at: now() });
    return response(event, 200, { ok: true, status: "closed" });
  }

  const outfitResultsMatch = path.match(/^\/api\/outfit-requests\/([^/]+)\/results$/);
  if (method === "GET" && outfitResultsMatch) {
    const request = await repository.getById("outfitRequests", decodeURIComponent(outfitResultsMatch[1]));
    if (!request || request.owner_user_id !== userId) throw Object.assign(new Error("未找到搭配请求。"), { status: 404 });
    const responses = await repository.findMany("outfitResponses", { request_id: request.id }, { orderBy: "created_at", order: "asc" });
    const summary = { like: 0, neutral: 0, dislike: 0 };
    responses.forEach((item) => { if (summary[item.verdict] !== undefined) summary[item.verdict] += 1; });
    return response(event, 200, { request: publicOutfitRequest(request, { isOwner: true }), summary, responses: responses.map((item) => ({
      id: String(item.id), verdict: item.verdict, comment: item.comment, reported: Boolean(item.reported), hidden: Boolean(item.hidden), createdAt: item.created_at
    })) });
  }

  const outfitReportMatch = path.match(/^\/api\/outfit-responses\/([^/]+)\/report$/);
  if (method === "POST" && outfitReportMatch) {
    const reply = await repository.getById("outfitResponses", decodeURIComponent(outfitReportMatch[1]));
    const request = reply ? await repository.getById("outfitRequests", reply.request_id) : null;
    const allowed = request && (request.owner_user_id === userId || (request.participant_user_ids || []).map(String).includes(userId));
    if (!reply || !allowed || reply.user_id === userId) throw Object.assign(new Error("无权举报该回复。"), { status: 403 });
    await repository.update("outfitResponses", reply.id, { reported: true, hidden: true, report_reason: cleanText(body.reason, 200), updated_at: now() });
    return response(event, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/outfit-captures/presign") {
    const mimeType = cleanText(body.mimeType, 40).toLowerCase();
    const size = Number(body.size || 0);
    if (!["image/jpeg", "image/png"].includes(mimeType) || size < 1 || size > 5 * 1024 * 1024) throw Object.assign(new Error("请选择不超过 5MB 的 JPG 或 PNG 全身照。"), { status: 400 });
    const expired = await repository.findMany("outfitCaptures", {
      user_id: userId,
      status: repository.command().in(["uploaded", "analyzed", "failed"]),
      expires_at: repository.command().lt(now())
    }, { limit: 20 });
    for (const task of expired) {
      try {
        if (!task.deleted_at) await cloud.deleteObject(task.source_key);
        const temporaryKeys = new Set((task.detections || []).flatMap((item) => [item.cropKey, item.cutoutKey, item.repairMaskKey, item.flatLayKey, item.selectedImageKey, item.correctionSeedKey]).filter(Boolean));
        await Promise.all([...temporaryKeys].map((key) => cloud.deleteObject(key).catch(() => {})));
        await repository.update("outfitCaptures", task.id, { status: "expired", deleted_at: now(), updated_at: now() });
      } catch {}
    }
    const captureId = newId();
    const upload = cloud.createUpload(userId, mimeType, `outfit-${captureId}`);
    const timestamp = now();
    await repository.add("outfitCaptures", { user_id: userId, source_key: upload.sourceKey, status: "uploaded", detections: [], expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), deleted_at: "", error_code: "", created_at: timestamp, updated_at: timestamp }, captureId);
    return response(event, 201, { captureId, uploadUrl: upload.uploadUrl, expiresIn: upload.expiresIn });
  }

  const segmentationDiagnosticMatch = path.match(/^\/api\/admin\/outfit-captures\/([^/]+)\/segmentation-diagnostic$/);
  if (method === "POST" && segmentationDiagnosticMatch) {
    if (user.role !== "admin") throw Object.assign(new Error("当前账号没有服饰分割诊断权限。"), { status: 403 });
    const capture = await repository.getById("outfitCaptures", decodeURIComponent(segmentationDiagnosticMatch[1]));
    if (!capture || capture.user_id !== userId) throw Object.assign(new Error("未找到穿搭识别任务。"), { status: 404 });
    if (Date.parse(capture.expires_at) <= Date.now()) throw Object.assign(new Error("照片任务已过期，请重新上传。"), { status: 410 });
    if (capture.status !== "uploaded") throw Object.assign(new Error("诊断任务必须使用尚未分析的新上传照片。"), { status: 409 });
    await repository.update("outfitCaptures", capture.id, { status: "analyzing", updated_at: now() });
    let temporaryDetections = [];
    try {
      const analyzed = await cloud.analyzeOutfit(capture.source_key, userId, capture.id);
      temporaryDetections = analyzed.detections;
      const segmented = await cloud.segmentOutfitGarments(capture.source_key, analyzed.detections, userId, capture.id, { transport: "native_rpc_v2" });
      const detections = segmented.map((detection) => ({ ...detection, topMatches: [] }));
      temporaryDetections = detections;
      await cloud.deleteObject(capture.source_key);
      const deletedAt = now();
      await repository.update("outfitCaptures", capture.id, { status: "analyzed", detections, deleted_at: deletedAt, updated_at: deletedAt });
      return response(event, 200, {
        captureId: capture.id,
        diagnostic: true,
        transport: "native_rpc_v2",
        originalDeleted: true,
        detections: detections.map((detection) => ({
          ...publicOutfitDetection(detection),
          cutoutUrl: detection.cutoutKey ? cloud.signedUrl(detection.cutoutKey, "GET", 600) : ""
        }))
      });
    } catch (error) {
      const temporaryKeys = new Set(temporaryDetections.flatMap((item) => [item.cropKey, item.cutoutKey, item.repairMaskKey, item.flatLayKey, item.selectedImageKey, item.correctionSeedKey]).filter(Boolean));
      await Promise.all([...temporaryKeys].map((key) => cloud.deleteObject(key).catch(() => {})));
      let deletedAt = "";
      try { await cloud.deleteObject(capture.source_key); deletedAt = now(); } catch {}
      await repository.update("outfitCaptures", capture.id, { status: "failed", deleted_at: deletedAt, error_code: deletedAt ? cleanText(error.code, 80) : "SOURCE_DELETE_FAILED", updated_at: now() });
      if (!deletedAt) throw Object.assign(new Error("诊断失败，且人物原图清理未完成，请联系管理员处理。"), { status: 503, code: "SOURCE_DELETE_FAILED" });
      throw error;
    }
  }

  const captureAnalyzeMatch = path.match(/^\/api\/outfit-captures\/([^/]+)\/analyze$/);
  if (method === "POST" && captureAnalyzeMatch) {
    const capture = await repository.getById("outfitCaptures", decodeURIComponent(captureAnalyzeMatch[1]));
    if (!capture || capture.user_id !== userId) throw Object.assign(new Error("未找到穿搭识别任务。"), { status: 404 });
    if (Date.parse(capture.expires_at) <= Date.now()) throw Object.assign(new Error("照片任务已过期，请重新拍摄。"), { status: 410 });
    if (capture.status === "analyzed") return response(event, 200, { captureId: capture.id, detections: (capture.detections || []).map(publicOutfitDetection), originalDeleted: Boolean(capture.deleted_at) });
    await repository.update("outfitCaptures", capture.id, { status: "analyzing", updated_at: now() });
    let temporaryDetections = [];
    try {
      const analyzed = await cloud.analyzeOutfit(capture.source_key, userId, capture.id);
      temporaryDetections = analyzed.detections;
      const segmented = await cloud.segmentOutfitGarments(capture.source_key, analyzed.detections, userId, capture.id);
      const detections = segmented.map((detection) => ({ ...detection, topMatches: [] }));
      temporaryDetections = detections;
      await cloud.deleteObject(capture.source_key);
      const deletedAt = now();
      await repository.update("outfitCaptures", capture.id, { status: "analyzed", detections, deleted_at: deletedAt, updated_at: deletedAt });
      return response(event, 200, { captureId: capture.id, detections: detections.map(publicOutfitDetection), originalDeleted: true });
    } catch (error) {
      const temporaryKeys = new Set(temporaryDetections.flatMap((item) => [item.cropKey, item.cutoutKey, item.repairMaskKey, item.flatLayKey, item.selectedImageKey, item.correctionSeedKey]).filter(Boolean));
      await Promise.all([...temporaryKeys].map((key) => cloud.deleteObject(key).catch(() => {})));
      let deletedAt = "";
      try { await cloud.deleteObject(capture.source_key); deletedAt = now(); } catch {}
      await repository.update("outfitCaptures", capture.id, { status: "failed", deleted_at: deletedAt, error_code: deletedAt ? cleanText(error.code, 80) : "SOURCE_DELETE_FAILED", updated_at: now() });
      if (!deletedAt) throw Object.assign(new Error("识别失败，且人物原图清理未完成，请联系管理员处理。"), { status: 503, code: "SOURCE_DELETE_FAILED" });
      throw error;
    }
  }

  const prepareDetectionMatch = path.match(/^\/api\/outfit-captures\/([^/]+)\/detections\/([^/]+)\/prepare$/);
  if (method === "POST" && prepareDetectionMatch) {
    const captureId = decodeURIComponent(prepareDetectionMatch[1]);
    const detectionId = decodeURIComponent(prepareDetectionMatch[2]);
    let capture = await repository.getById("outfitCaptures", captureId);
    if (!capture || capture.user_id !== userId) throw Object.assign(new Error("未找到穿搭任务。"), { status: 404 });
    const detection = (capture.detections || []).find((item) => item.detectionId === detectionId);
    if (!detection) throw Object.assign(new Error("未找到待处理衣物。"), { status: 404 });
    if (["ready", "fallback"].includes(detection.processingStatus)) return response(event, 200, publicOutfitDetection(detection));
    if (detection.processingStatus === "processing") throw Object.assign(new Error("这件衣物正在处理中。"), { status: 409 });
    if (cloud.requiresOutfitImageEdit(detection)) {
      const slot = await acquireImageEditSlot();
      if (!slot.acquired) {
        return response(event, 200, {
          ...publicOutfitDetection(detection),
          processingStatus: "queued",
          processingStage: "wardrobe_product",
          processingError: "正在排队整理衣橱商品展示图。",
          retryable: true,
          retryAfterMs: slot.retryAfterMs,
          failureKind: "provider_queue"
        });
      }
    }
    await repository.withTransaction(async (tx) => {
      const locked = await tx.getById("outfitCaptures", captureId);
      const detections = [...(locked.detections || [])];
      const index = detections.findIndex((item) => item.detectionId === detectionId);
      if (index < 0) throw Object.assign(new Error("待处理衣物已失效。"), { status: 409 });
      detections[index] = {
        ...detections[index],
        processingStatus: "processing",
        processingStage: "wardrobe_product",
        processingError: ""
      };
      await tx.update("outfitCaptures", captureId, { detections, updated_at: now() });
    });
    try {
      const prepared = await cloud.prepareOutfitDetection(detection);
      if (prepared.processingStatus === "failed" || !prepared.selectedImageKey) {
        await repository.withTransaction(async (tx) => {
          const locked = await tx.getById("outfitCaptures", captureId);
          const detections = [...(locked.detections || [])];
          const index = detections.findIndex((item) => item.detectionId === detectionId);
          if (index < 0) throw Object.assign(new Error("待处理衣物已失效。"), { status: 409 });
          detections[index] = { ...detections[index], ...prepared, topMatches: [] };
          await tx.update("outfitCaptures", captureId, { detections, updated_at: now() });
        });
        capture = await repository.getById("outfitCaptures", captureId);
        return response(event, 200, publicOutfitDetection((capture.detections || []).find((item) => item.detectionId === detectionId)));
      }
      let topMatches = [];
      if (!shouldSkipOutfitCandidateMatching(detection)) {
        const clothing = await repository.findMany("clothing", { user_id: userId, status: "active" }, { orderBy: "created_at", order: "desc", limit: 100 });
        const embeddings = clothing.length ? await ensureImageEmbeddings(userId, clothing.map((item) => ({ entityType: "clothing", entityId: item.id, imageKey: item.image_key }))) : new Map();
        const queryEmbedding = await cloud.generateImageEmbeddings([prepared.selectedImageKey]);
        topMatches = buildOutfitCandidates(detection, clothing.map((item) => ({ item, visualSimilarity: cosineSimilarity(queryEmbedding.vectors[0], embeddings.get(`clothing:${item.id}`)?.vector) }))).map((entry) => ({
          id: String(entry.item.id), name: entry.item.name || "未命名衣物", category: entry.item.category || "", color: entry.item.color || "",
          imageKey: entry.item.image_key, similarity: entry.score, visualSimilarity: entry.visualScore
        }));
      }
      await repository.withTransaction(async (tx) => {
        const locked = await tx.getById("outfitCaptures", captureId);
        const detections = [...(locked.detections || [])];
        const index = detections.findIndex((item) => item.detectionId === detectionId);
        if (index < 0) throw Object.assign(new Error("待处理衣物已失效。"), { status: 409 });
        detections[index] = { ...detections[index], ...prepared, topMatches };
        await tx.update("outfitCaptures", captureId, { detections, updated_at: now() });
      });
      capture = await repository.getById("outfitCaptures", captureId);
      return response(event, 200, publicOutfitDetection((capture.detections || []).find((item) => item.detectionId === detectionId)));
    } catch (error) {
      await repository.withTransaction(async (tx) => {
        const locked = await tx.getById("outfitCaptures", captureId);
        const detections = [...(locked.detections || [])];
        const index = detections.findIndex((item) => item.detectionId === detectionId);
        if (index >= 0) detections[index] = { ...detections[index], processingStatus: "failed", processingError: cleanText(error.message, 120), selectedImageKey: "" };
        await tx.update("outfitCaptures", captureId, { detections, updated_at: now() });
      });
      throw error;
    }
  }

  const captureCancelMatch = path.match(/^\/api\/outfit-captures\/([^/]+)$/);
  if (method === "DELETE" && captureCancelMatch) {
    const capture = await repository.getById("outfitCaptures", decodeURIComponent(captureCancelMatch[1]));
    if (!capture || capture.user_id !== userId) throw Object.assign(new Error("未找到穿搭识别任务。"), { status: 404 });
    if (!capture.deleted_at) await cloud.deleteObject(capture.source_key);
    const temporaryKeys = new Set((capture.detections || []).flatMap((item) => [item.cropKey, item.cutoutKey, item.repairMaskKey, item.flatLayKey, item.selectedImageKey, item.correctionSeedKey]).filter(Boolean));
    await Promise.all([...temporaryKeys].map((key) => cloud.deleteObject(key).catch(() => {})));
    await repository.update("outfitCaptures", capture.id, { status: "cancelled", deleted_at: capture.deleted_at || now(), updated_at: now() });
    return response(event, 200, { ok: true, originalDeleted: true });
  }

  const captureConfirmMatch = path.match(/^\/api\/outfit-captures\/([^/]+)\/confirm$/);
  if (method === "POST" && captureConfirmMatch) {
    const capture = await repository.getById("outfitCaptures", decodeURIComponent(captureConfirmMatch[1]));
    if (!capture || capture.user_id !== userId) throw Object.assign(new Error("未找到穿搭任务。"), { status: 404 });
    if (capture.status === "confirmed" && capture.result) return response(event, 200, capture.result);
    if (capture.status !== "analyzed" || !capture.deleted_at) throw Object.assign(new Error("穿搭任务不可确认或原图尚未删除。"), { status: 409 });
    const chosenIds = [...new Set(parseArray(body.itemIds).map(String).filter(Boolean))].slice(0, 5);
    const selectedDetectionIndexes = new Set(parseArray(body.detectionSelections).filter((entry) => Number.isInteger(Number(entry?.detectionIndex)) && chosenIds.includes(String(entry?.itemId))).map((entry) => Number(entry.detectionIndex)));
    const skippedDetectionIndexes = new Set(parseArray(body.skipDetectionIndexes).map(Number).filter(Number.isInteger));
    const newDetections = (capture.detections || []).filter((item, index) => !selectedDetectionIndexes.has(index) && !skippedDetectionIndexes.has(index) && ["ready", "fallback"].includes(item.processingStatus) && item.selectedImageKey);
    const pendingDetections = (capture.detections || []).filter((item, index) => !selectedDetectionIndexes.has(index) && !skippedDetectionIndexes.has(index) && !newDetections.includes(item)).map((item) => ({ slot: item.slot, category: item.category, color: item.color, pattern: item.pattern || "", styles: item.styles || [], status: "pending", processing_status: item.processingStatus || "failed", processing_error: item.processingError || "" }));
    const chosen = chosenIds.length ? await repository.findMany("clothing", { user_id: userId, status: "active", _id: repository.command().in(chosenIds) }) : [];
    if (!chosen.length && !newDetections.length) throw Object.assign(new Error("没有可以保存的今日衣物。"), { status: 400 });
    const activeCount = await repository.count("clothing", { user_id: userId, status: "active" });
    if (activeCount + newDetections.length > 100) throw Object.assign(new Error(`衣橱剩余容量不足，请将至少 ${activeCount + newDetections.length - 100} 件改为已有衣物。`), { status: 429 });
    const wornAt = now();
    const recordId = newId();
    const newItems = newDetections.map((detection) => ({
      id: newId(), user_id: userId, image_key: detection.selectedImageKey,
      name: `${detection.color || ""}${detection.category || "衣物"}` || "今日衣物",
      category: detection.category, color: detection.color || "", season: "", thickness: "", pattern: detection.pattern || "", material: "",
      styles: sanitizeTags(detection.styles), scenes: allowedScenes.includes(body.scene) ? [body.scene] : [], price: null,
      wear_count: 1, last_worn_at: wornAt, status: "active", idle_status: "active", source_hash: null, search_entity_id: null,
      source_type: "outfit_capture", source_capture_id: capture.id, image_origin: detection.imageOrigin,
      image_fidelity_score: detection.fidelityScore,
      image_generation_status: detection.completenessStatus === "partial_visible" ? "partial_visible" : detection.fidelityStatus,
      created_at: wornAt
    }));
    const snapshots = [
      ...chosen.map((item) => ({ id: String(item.id), name: item.name || "未命名衣物", category: item.category || "", color: item.color || "", styles: sanitizeTags(item.styles) })),
      ...newItems.map((item) => ({ id: item.id, name: item.name, category: item.category, color: item.color, styles: item.styles }))
    ];
    const result = { recordId, confirmedCount: snapshots.length, createdCount: newItems.length, reusedCount: chosen.length, pendingCount: pendingDetections.length };
    await repository.withTransaction(async (tx) => {
      for (const item of newItems) {
        const { id, ...document } = item;
        await tx.add("clothing", document, id);
      }
      await tx.add("outfitRecords", { user_id: userId, capture_id: capture.id, items: snapshots, scene: allowedScenes.includes(body.scene) ? body.scene : "", weather: { city: cleanText(body.weather?.city, 40), condition: cleanText(body.weather?.condition, 20), temperature: Number(body.weather?.temperature) || null }, status: "confirmed", worn_at: wornAt, created_at: wornAt }, recordId);
      for (const item of [...chosen, ...newItems]) {
        await tx.add("wearLogs", { user_id: userId, item_id: String(item.id), outfit_record_id: recordId, scene: allowedScenes.includes(body.scene) ? body.scene : "", comfort: "", note: "今日穿搭确认", worn_at: wornAt }, newId());
        if (!newItems.some((created) => created.id === item.id)) await tx.update("clothing", item.id, { wear_count: repository.command().inc(1), last_worn_at: wornAt });
      }
      await tx.update("outfitCaptures", capture.id, { status: "confirmed", pending_detections: pendingDetections, result, updated_at: wornAt });
    });
    const cleanupKeys = new Set();
    (capture.detections || []).forEach((item, index) => {
      const keep = newDetections.includes(item) ? item.selectedImageKey : "";
      [item.cropKey, item.cutoutKey, item.repairMaskKey, item.flatLayKey, item.correctionSeedKey].filter((key) => key && key !== keep).forEach((key) => cleanupKeys.add(key));
      if ((selectedDetectionIndexes.has(index) || skippedDetectionIndexes.has(index)) && item.selectedImageKey) cleanupKeys.add(item.selectedImageKey);
    });
    await Promise.all([...cleanupKeys].map((key) => cloud.deleteObject(key).catch(() => {})));
    return response(event, 201, result);
  }

  if (method === "GET" && path === "/api/style-profile") {
    const records = await repository.findMany("outfitRecords", { user_id: userId, status: "confirmed" }, { orderBy: "worn_at", order: "desc", limit: 500 });
    return response(event, 200, buildStyleProfile(records));
  }

  if (method === "GET" && path === "/api/city-trends") {
    const cityCode = cleanText(query.cityCode, 20);
    if (!cityCode) throw Object.assign(new Error("请先手动选择城市。"), { status: 400 });
    const samples = await repository.findMany("trendSamples", { city_code: cityCode }, { orderBy: "published_at", order: "desc", limit: 1000 });
    return response(event, 200, { cityCode, sourceLabel: samples.some((sample) => sample.source === "xiaohongshu_partner") ? "小红书合作授权数据" : "自有社区与授权演示样本", ...buildCityTrend(samples, cityCode) });
  }

  // 幂等键让用户重复点击或网络重发返回原任务，不会创建第二个上传任务或重复扣费。
  if (method === "POST" && path === "/api/uploads/presign") {
    const mimeType = cleanText(body.mimeType, 40).toLowerCase();
    const size = Number(body.size || 0);
    if (!["image/jpeg", "image/png"].includes(mimeType) || size < 1 || size > 2 * 1024 * 1024) {
      throw Object.assign(new Error("请上传压缩后不超过 2MB 的 JPG 或 PNG 衣物图片。"), { status: 400 });
    }
    const mode = body.mode === "manual" ? "manual" : body.mode === "candidate" ? "candidate" : "closet";
    const idempotencyKey = cleanText(body.idempotencyKey, 80);
    if (!idempotencyKey) throw Object.assign(new Error("缺少上传幂等标识，请重新选择图片。"), { status: 400 });
    const existing = await repository.findOne("aiUsage", { user_id: userId, idempotency_key: idempotencyKey });
    if (existing) {
      return response(event, 200, {
        taskId: existing.id,
        sourceKey: existing.source_key,
        uploadUrl: cloud.signedUrl(existing.source_key, "PUT", 300),
        expiresIn: 300
      });
    }
    const taskId = newId();
    const upload = cloud.createUpload(userId, mimeType, taskId);
    await repository.add("aiUsage", {
      user_id: userId,
      idempotency_key: idempotencyKey,
      source_key: upload.sourceKey,
      cutout_key: null,
      selected_image_key: null,
      hanger_edit_key: null,
      hanger_edit_status: "not_requested",
      hanger_edit_calls: 0,
      hanger_edit_model: "",
      source_hash: null,
      mode,
      provider: mode === "manual" ? "none" : "dashscope",
      model: mode === "manual" ? "" : process.env.QWEN_VL_MODEL || "qwen3-vl-plus",
      status: "upload_pending",
      stage: "upload",
      reserved_micros: 0,
      cost_micros: 0,
      matting_calls: 0,
      recognition_attempts: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      result: null,
      error_code: "",
      error_message: "",
      created_at: now(),
      updated_at: now()
    }, taskId);
    return response(event, 201, upload);
  }

  if (method === "POST" && path === "/api/recognize") {
    const taskId = cleanText(body.taskId, 80);
    return response(event, 201, await processRecognitionTask(taskId, userId));
  }

  const mattingMatch = path.match(/^\/api\/tasks\/([^/]+)\/matting$/);
  if (method === "POST" && mattingMatch) {
    return response(event, 200, await processMattingTask(decodeURIComponent(mattingMatch[1]), userId));
  }

  const recognitionMatch = path.match(/^\/api\/tasks\/([^/]+)\/recognition$/);
  if (method === "POST" && recognitionMatch) {
    return response(event, 200, await processRecognitionStep(decodeURIComponent(recognitionMatch[1]), userId));
  }

  const hangerEditMatch = path.match(/^\/api\/tasks\/([^/]+)\/hanger-removal$/);
  if (method === "POST" && hangerEditMatch) {
    return response(event, 200, await processHangerEdit(decodeURIComponent(hangerEditMatch[1]), userId));
  }

  const imageSelectionMatch = path.match(/^\/api\/tasks\/([^/]+)\/image-selection$/);
  if (method === "POST" && imageSelectionMatch) {
    return response(event, 200, await selectTaskImage(
      decodeURIComponent(imageSelectionMatch[1]),
      userId,
      body.choice === "hanger_edit" ? "hanger_edit" : "original"
    ));
  }

  const retryMatch = path.match(/^\/api\/tasks\/([^/]+)\/retry$/);
  if (method === "POST" && retryMatch) {
    return response(event, 200, await processRecognitionTask(decodeURIComponent(retryMatch[1]), userId));
  }

  if (method === "GET" && path === "/api/items") {
    // 衣橱、天气推荐和新衣分析只读取有效衣物；软删除记录仍留在数据库中，避免误删后无法追溯。
    const items = await repository.findMany("clothing", { user_id: userId, status: "active" }, { orderBy: "created_at", order: "desc" });
    return response(event, 200, items.map(mapItem));
  }

  if (method === "GET" && path === "/api/wear-logs") {
    const start = String(query.start || "");
    const end = String(query.end || "");
    const startTime = Date.parse(start);
    const endTime = Date.parse(end);
    if (!start || !end || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || endTime - startTime > 32 * 24 * 60 * 60 * 1000) {
      throw Object.assign(new Error("请提供有效的月份时间范围。"), { status: 400 });
    }
    // 由客户端传入本地月份对应的 UTC 起止时间，避免月初月末因时区被分到错误日期。
    const range = repository.command().gte(start).and(repository.command().lt(end));
    const logs = await repository.findMany("wearLogs", { user_id: userId, worn_at: range }, { orderBy: "worn_at", order: "asc", limit: 500 });
    const itemIds = [...new Set(logs.map((log) => String(log.item_id)))];
    // 一次读取本月记录涉及的衣物，避免按衣物数量逐条 getById 消耗数据库读额度。
    const relatedItems = itemIds.length
      ? await repository.findMany("clothing", { user_id: userId, _id: repository.command().in(itemIds) })
      : [];
    const outfitRecordIds = [...new Set(logs.map((log) => String(log.outfit_record_id || "")).filter(Boolean))];
    const outfitRecords = outfitRecordIds.length
      ? await repository.findMany("outfitRecords", { user_id: userId, _id: repository.command().in(outfitRecordIds) })
      : [];
    const outfitRecordsById = new Map(outfitRecords.map((record) => [String(record.id), record]));
    const itemsById = new Map(relatedItems.map((item) => [String(item.id), item]));
    return response(event, 200, logs.map((log) => {
      const item = itemsById.get(String(log.item_id));
      const outfitRecordId = String(log.outfit_record_id || "");
      const outfitRecord = outfitRecordsById.get(outfitRecordId);
      return {
        id: String(log.id),
        outfitRecordId,
        outfitTitle: outfitRecord?.title || (outfitRecordId ? "一套穿搭" : ""),
        wornAt: log.worn_at,
        scene: log.scene || "",
        comfort: log.comfort || "",
        note: log.note || "",
        item: item ? {
          id: String(item.id),
          name: item.name || "未命名衣物",
          category: item.category || "",
          color: item.color || "",
          active: item.status === "active",
          imageUrl: cloud.signedUrl(item.image_key, "GET", 3600)
        } : null
      };
    }));
  }

  // 基础录入只调用商品抠图，不调用通义千问；最终优先保存透明图。
  if (method === "POST" && path === "/api/items/manual") {
    if (await repository.count("clothing", { user_id: userId, status: "active" }) >= 100) {
      throw Object.assign(new Error("单个测试账号最多保存 100 件衣物。"), { status: 429 });
    }
    const task = await repository.getById("aiUsage", cleanText(body.taskId, 80));
    if (!task || task.user_id !== userId || task.mode !== "manual" || !task.source_key?.startsWith(`uploads/${userId}/`)) {
      throw Object.assign(new Error("手动录入图片已失效，请重新选择。"), { status: 400 });
    }
    if (!task.cutout_key) throw Object.assign(new Error("请先完成衣物抠图。"), { status: 409 });
    if (task.result?.itemId) return response(event, 200, mapItem(await repository.getById("clothing", task.result.itemId)));
    const category = cleanText(body.category, 30);
    if (!allowedCategories.includes(category)) throw Object.assign(new Error("请选择衣物品类。"), { status: 400 });
    const hash = task.source_hash;
    if (!hash) throw Object.assign(new Error("衣物图片校验结果已失效，请重新抠图。"), { status: 409 });
    const exact = await repository.findOne("clothing", { source_hash_key: `${userId}:${hash}` });
    if (exact) throw Object.assign(new Error("这张衣物图片已经录入过。"), { status: 409 });
    const itemId = newId();
    const savedItemId = await repository.withTransaction(async (tx) => {
      const lockedTask = await tx.getById("aiUsage", task.id);
      if (!lockedTask || lockedTask.user_id !== userId) throw Object.assign(new Error("手动录入图片已失效。"), { status: 409 });
      if (lockedTask.result?.itemId) return lockedTask.result.itemId;
      await tx.add("clothing", {
        user_id: userId,
        image_key: lockedTask.selected_image_key || lockedTask.cutout_key,
        name: cleanText(body.name, 80) || "未命名衣物",
        category,
        color: cleanText(body.color, 30),
        season: allowedSeasons.includes(body.season) ? body.season : "",
        thickness: allowedThicknesses.includes(body.thickness) ? body.thickness : "",
        pattern: cleanText(body.pattern, 30),
        material: cleanText(body.material, 30),
        styles: sanitizeTags(body.styles),
        scenes: sanitizeTags(body.scenes, allowedScenes),
        price: body.price === "" || body.price == null ? null : Number(body.price),
        wear_count: 0,
        status: "active",
        idle_status: "active",
        source_hash: hash,
        source_hash_key: `${userId}:${hash}`,
        search_entity_id: null,
        source_type: allowedItemSources.includes(body.sourceType) ? body.sourceType : "single_item_upload",
        created_at: now()
      }, itemId);
      await tx.update("aiUsage", task.id, {
        status: "manual_completed",
        stage: "saved",
        result: { itemId },
        updated_at: now()
      });
      return itemId;
    });
    return response(event, savedItemId === itemId ? 201 : 200, mapItem(await repository.getById("clothing", savedItemId)));
  }

  // 用户确认候选字段后才把透明主图写入正式衣橱；草稿已保存时直接返回旧结果以避免重复入库。
  if (method === "POST" && path === "/api/items") {
    if (await repository.count("clothing", { user_id: userId, status: "active" }) >= 100) {
      throw Object.assign(new Error("单个测试账号最多保存 100 件衣物。"), { status: 429 });
    }
    let draft = body.draftId ? await repository.getById("drafts", body.draftId) : null;
    if (draft && draft.user_id !== userId) draft = null;
    if (!draft) draft = await repository.findOne("drafts", { user_id: userId, item_id: null }, { orderBy: "created_at", order: "desc" });
    if (!draft) throw Object.assign(new Error("未找到刚才的识别结果，请重新识别后再保存。"), { status: 400 });
    if (draft.item_id) return response(event, 200, mapItem(await repository.getById("clothing", draft.item_id)));
    const category = cleanText(body.category, 30);
    if (!allowedCategories.includes(category)) throw Object.assign(new Error("请选择衣物品类。"), { status: 400 });
    const itemId = newId();
    const itemData = {
      user_id: userId,
      image_key: draft.image_key,
      name: cleanText(body.name, 80) || "未命名衣物",
      category,
      color: cleanText(body.color, 30),
      season: allowedSeasons.includes(body.season) ? body.season : "",
      thickness: allowedThicknesses.includes(body.thickness) ? body.thickness : "",
      pattern: cleanText(body.pattern, 30),
      material: cleanText(body.material, 30),
      styles: sanitizeTags(body.styles),
      scenes: sanitizeTags(body.scenes, allowedScenes),
      price: body.price === "" || body.price == null ? null : Number(body.price),
      wear_count: 0,
      status: "active",
      idle_status: "active",
      source_hash: draft.source_hash || null,
      ...(draft.source_hash ? { source_hash_key: `${userId}:${draft.source_hash}` } : {}),
      search_entity_id: null,
      source_type: allowedItemSources.includes(body.sourceType) ? body.sourceType : "single_item_upload",
      created_at: now()
    };
    const saved = await repository.withTransaction(async (tx) => {
      const lockedDraft = await tx.getById("drafts", draft.id);
      if (!lockedDraft || lockedDraft.user_id !== userId) throw Object.assign(new Error("识别草稿已失效，请重新识别。"), { status: 409 });
      if (lockedDraft.item_id) return { itemId: lockedDraft.item_id, alreadySaved: true };
      await tx.add("clothing", itemData, itemId);
      await tx.update("drafts", lockedDraft.id, { item_id: itemId });
      return { itemId, alreadySaved: false };
    });
    if (saved.alreadySaved) return response(event, 200, mapItem(await repository.getById("clothing", saved.itemId)));
    return response(event, 201, mapItem(await repository.getById("clothing", itemId)));
  }

  if (method === "GET" && path === "/api/idle-items") {
    const items = await repository.findMany("clothing", { user_id: userId, status: "active", idle_status: "considering" }, { orderBy: "idle_marked_at", order: "desc" });
    const rows = await Promise.all(items.map(async (item) => {
      // 新记录直接使用衣物上的汇总字段；旧数据缺字段时才查询一次穿着历史以保持兼容。
      const lastWear = item.last_worn_at ? null : await repository.findOne("wearLogs", { user_id: userId, item_id: String(item.id) }, { orderBy: "worn_at", order: "desc" });
      return {
        ...mapItem(item),
        idleStatus: "considering",
        idleReason: item.idle_reason || "",
        idleNote: item.idle_note || "",
        idleMarkedAt: item.idle_marked_at || "",
        lastWornAt: item.last_worn_at || lastWear?.worn_at || ""
      };
    }));
    return response(event, 200, rows);
  }

  const idleMatch = path.match(/^\/api\/items\/([^/]+)\/idle$/);
  if (idleMatch && (method === "POST" || method === "DELETE")) {
    const itemId = decodeURIComponent(idleMatch[1]);
    const item = await repository.getById("clothing", itemId);
    if (!item || item.user_id !== userId || item.status !== "active") {
      throw Object.assign(new Error("未找到衣物。"), { status: 404 });
    }
    if (method === "DELETE") {
      await repository.update("clothing", itemId, { idle_status: "active", idle_reason: "", idle_note: "", idle_marked_at: "" });
      return response(event, 200, mapItem(await repository.getById("clothing", itemId)));
    }
    const reason = cleanText(body.reason, 20);
    if (!allowedIdleReasons.includes(reason)) {
      throw Object.assign(new Error("请选择闲置原因。"), { status: 400 });
    }
    const lastWear = item.last_worn_at ? null : await repository.findOne("wearLogs", { user_id: userId, item_id: itemId }, { orderBy: "worn_at", order: "desc" });
    await repository.update("clothing", itemId, {
      idle_status: "considering",
      idle_reason: reason,
      idle_note: cleanText(body.note, 100),
      idle_marked_at: now(),
      last_worn_at: item.last_worn_at || lastWear?.worn_at || ""
    });
    return response(event, 200, mapItem(await repository.getById("clothing", itemId)));
  }

  const listingMatch = path.match(/^\/api\/items\/([^/]+)\/listing$/);
  if (listingMatch && method === "PUT") {
    const itemId = decodeURIComponent(listingMatch[1]);
    const item = await repository.getById("clothing", itemId);
    if (!item || item.user_id !== userId || item.status !== "active") {
      throw Object.assign(new Error("未找到衣物。"), { status: 404 });
    }
    if ((item.idle_status || "active") !== "considering") {
      throw Object.assign(new Error("请先把衣物加入私人闲置清单。"), { status: 409 });
    }
    const mode = cleanText(body.mode, 10);
    const status = cleanText(body.status, 20);
    const condition = cleanText(body.condition, 80);
    const delivery = cleanText(body.delivery, 50);
    if (!allowedListingModes.includes(mode)) throw Object.assign(new Error("请选择转卖或出租。"), { status: 400 });
    if (!allowedListingStatuses.includes(status)) throw Object.assign(new Error("请选择有效的发布状态。"), { status: 400 });
    if (!condition || !delivery) throw Object.assign(new Error("请填写成色说明和交付方式。"), { status: 400 });
    const optionalMoney = (value, label) => {
      if (value === "" || value == null) return null;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1000000) throw Object.assign(new Error(`${label}格式不正确。`), { status: 400 });
      return number;
    };
    const minDays = Math.floor(Number(body.minDays || 1));
    if (mode === "rent" && (!Number.isFinite(minDays) || minDays < 1 || minDays > 365)) {
      throw Object.assign(new Error("最短租期应为 1 至 365 天。"), { status: 400 });
    }
    const url = cleanText(body.url, 500);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw Object.assign(new Error("商品链接必须以 http:// 或 https:// 开头。"), { status: 400 });
    await repository.update("clothing", itemId, {
      listing_mode: mode,
      listing_condition: condition,
      listing_sale_price: mode === "sale" ? optionalMoney(body.salePrice, "转卖价格") : null,
      listing_daily_rent: mode === "rent" ? optionalMoney(body.dailyRent, "日租金") : null,
      listing_deposit: mode === "rent" ? optionalMoney(body.deposit, "押金") : null,
      listing_min_days: mode === "rent" ? minDays : 1,
      listing_delivery: delivery,
      listing_note: cleanText(body.note, 200),
      listing_platform: cleanText(body.platform, 30) || "闲鱼",
      listing_url: url,
      listing_status: status,
      listing_updated_at: now()
    });
    return response(event, 200, mapItem(await repository.getById("clothing", itemId)));
  }

  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && (method === "GET" || method === "PATCH" || method === "DELETE")) {
    const itemId = decodeURIComponent(itemMatch[1]);
    const item = await repository.getById("clothing", itemId);
    if (!item || item.user_id !== userId || item.status !== "active") {
      throw Object.assign(new Error("未找到衣物。"), { status: 404 });
    }
    // 详情页只读取这一件本人衣物，避免为查一个 id 下载整份衣橱并消耗额外 RU。
    if (method === "GET") return response(event, 200, mapItem(item));
    if (method === "DELETE") {
      // 这里只做软删除，不删除 COS 图片与穿着记录；后续如需恢复仍有数据基础。
      await repository.update("clothing", itemId, { status: "inactive" });
      // 分享快照不再暴露已移出衣橱的衣物；若一条请求已无可分享衣物则自动关闭。
      const requests = await repository.findMany("outfitRequests", { owner_user_id: userId, status: "open" });
      await Promise.all(requests.filter((request) => (request.items || []).some((shared) => String(shared.id) === itemId)).map(async (request) => {
        const remaining = (request.items || []).filter((shared) => String(shared.id) !== itemId);
        await repository.update("outfitRequests", request.id, remaining.length
          ? { items: remaining }
          : { items: [], status: "closed", closed_at: now() });
      }));
      return response(event, 200, { ok: true, itemId });
    }
    const category = cleanText(body.category, 30);
    if (!allowedCategories.includes(category)) throw Object.assign(new Error("请选择衣物品类。"), { status: 400 });
    const price = body.price === "" || body.price == null ? null : Number(body.price);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      throw Object.assign(new Error("购入价格格式不正确。"), { status: 400 });
    }
    // 只开放用户可确认字段；图片、归属、穿着次数和哈希不能由客户端修改。
    await repository.update("clothing", itemId, {
      name: cleanText(body.name, 80) || "未命名衣物",
      category,
      color: cleanText(body.color, 30),
      season: allowedSeasons.includes(body.season) ? body.season : "",
      thickness: allowedThicknesses.includes(body.thickness) ? body.thickness : "",
      pattern: cleanText(body.pattern, 30),
      material: cleanText(body.material, 30),
      styles: sanitizeTags(body.styles),
      scenes: sanitizeTags(body.scenes, allowedScenes),
      price
    });
    return response(event, 200, mapItem(await repository.getById("clothing", itemId)));
  }

  const wearMatch = path.match(/^\/api\/items\/([^/]+)\/wear-logs$/);
  if (method === "GET" && wearMatch) {
    const itemId = decodeURIComponent(wearMatch[1]);
    const item = await repository.getById("clothing", itemId);
    if (!item || item.user_id !== userId || item.status !== "active") throw Object.assign(new Error("未找到衣物。"), { status: 404 });
    // 历史记录只返回当前用户当前衣物的数据，并限制最近 50 条，避免详情页一次拉取无限数据。
    const logs = await repository.findMany("wearLogs", { user_id: userId, item_id: itemId }, {
      orderBy: "worn_at",
      order: "desc",
      limit: 50
    });
    return response(event, 200, logs.map((log) => ({
      id: String(log.id),
      scene: log.scene || "",
      comfort: log.comfort || "",
      note: log.note || "",
      wornAt: log.worn_at
    })));
  }
  if (method === "POST" && wearMatch) {
    const itemId = decodeURIComponent(wearMatch[1]);
    const wornAt = now();
    const reward = await repository.withTransaction(async (tx) => {
      const item = await tx.getById("clothing", itemId);
      if (!item || item.user_id !== userId || item.status !== "active") throw Object.assign(new Error("未找到衣物。"), { status: 404 });
      await tx.add("wearLogs", {
        user_id: userId,
        item_id: itemId,
        scene: cleanText(body.scene, 30),
        comfort: cleanText(body.comfort, 30),
        note: cleanText(body.note, 200),
        worn_at: wornAt
      }, newId());
      await tx.update("clothing", itemId, { wear_count: repository.command().inc(1), last_worn_at: wornAt });
      return awardDailyCheckin(tx, userId, wornAt);
    });
    return response(event, 201, { ok: true, reward });
  }

  if (method === "GET" && path === "/api/candidates") {
    if (query.decision !== "wait") throw Object.assign(new Error("候选新衣筛选条件无效。"), { status: 400 });
    const candidates = await repository.findMany("candidates", { user_id: userId, decision: "wait" }, {
      orderBy: "wait_started_at",
      order: "asc",
      limit: 100
    });
    return response(event, 200, candidates.map((candidate) => mapWaitingCandidate(candidate)));
  }

  if (method === "POST" && path === "/api/candidates") {
    const draft = body.draftId ? await repository.getById("drafts", body.draftId) : null;
    if (!draft || draft.user_id !== userId) throw Object.assign(new Error("未找到候选新衣识别结果，请重新识别。"), { status: 400 });
    const category = cleanText(body.category, 30);
    if (!allowedCategories.includes(category)) throw Object.assign(new Error("请选择候选新衣品类。"), { status: 400 });
    const candidateId = newId();
    await repository.withTransaction(async (tx) => {
      const lockedDraft = await tx.getById("drafts", draft.id);
      if (!lockedDraft || lockedDraft.user_id !== userId) throw Object.assign(new Error("候选新衣识别结果已失效。"), { status: 409 });
      await tx.add("candidates", {
        user_id: userId,
        image_key: lockedDraft.image_key,
        name: cleanText(body.name, 80) || "候选新衣",
        category,
        color: cleanText(body.color, 30),
        season: allowedSeasons.includes(body.season) ? body.season : "",
        thickness: allowedThicknesses.includes(body.thickness) ? body.thickness : "",
        pattern: cleanText(body.pattern, 30),
        material: cleanText(body.material, 30),
        styles: sanitizeTags(body.styles),
        scenes: sanitizeTags(body.scenes, allowedScenes),
        price: body.price === "" || body.price == null ? null : Number(body.price),
        decision: null,
        analysis: null,
        created_at: now()
      }, candidateId);
      await tx.remove("drafts", lockedDraft.id);
    });
    return response(event, 201, mapCandidate(await repository.getById("candidates", candidateId)));
  }

  const candidateMatch = path.match(/^\/api\/candidates\/([^/]+)$/);
  if (method === "GET" && candidateMatch) {
    const candidate = await repository.getById("candidates", decodeURIComponent(candidateMatch[1]));
    if (!candidate || candidate.user_id !== userId) throw Object.assign(new Error("未找到候选新衣。"), { status: 404 });
    return response(event, 200, mapCandidate(candidate));
  }

  const analyzeMatch = path.match(/^\/api\/candidates\/([^/]+)\/analyze$/);
  if (method === "POST" && analyzeMatch) {
    const candidate = await repository.getById("candidates", decodeURIComponent(analyzeMatch[1]));
    if (!candidate || candidate.user_id !== userId) throw Object.assign(new Error("未找到候选新衣。"), { status: 404 });
    const existing = await repository.findMany("clothing", { user_id: userId, status: "active" });
    let analysisMode = "visual_hybrid";
    let fallbackReason = "";
    let embeddings = null;
    try {
      embeddings = await ensureImageEmbeddings(userId, [
        { entityType: "candidate", entityId: candidate.id, imageKey: candidate.image_key },
        ...existing.map((item) => ({ entityType: "clothing", entityId: item.id, imageKey: item.image_key }))
      ]);
    } catch (error) {
      analysisMode = "tag_fallback";
      fallbackReason = "视觉服务暂不可用，本次已自动改用用户确认标签。";
    }
    const candidateVector = embeddings?.get(`candidate:${candidate.id}`)?.vector;
    const similar = existing.map((item) => {
      const tags = tagSimilarity(candidate, item);
      const cosine = cosineSimilarity(candidateVector, embeddings?.get(`clothing:${item.id}`)?.vector);
      const visualScore = cosine == null ? null : Math.round(Math.max(0, Math.min(1, cosine)) * 100);
      const score = visualScore == null ? tags.score : Math.round(visualScore * 0.7 + tags.score * 0.3);
      const matchReasons = visualScore == null ? tags.matchReasons : [`视觉相似 ${visualScore} 分`, ...tags.matchReasons];
      return {
        ...mapItem(item),
        score,
        visualScore,
        tagScore: tags.score,
        matchReasons,
        matchSummary: matchReasons.join("；") || "未达到相似阈值"
      };
    }).filter((item) => item.score >= 55).sort((a, b) => b.score - a.score).slice(0, 5);
    const candidateScenes = sanitizeTags(candidate.scenes, allowedScenes);
    const compatible = existing.filter((item) => item.category !== candidate.category && sanitizeTags(item.scenes, allowedScenes).some((scene) => candidateScenes.includes(scene))).slice(0, 6).map(mapItem);
    const lowFrequencySimilar = similar.filter((item) => Number(item.wear_count || 0) < 3).length;
    const highestSimilarity = similar[0]?.score || 0;
    // 一件衣物达到 85 分即视为高度重复，不能因为只有一件而被误判成“补缺型”。
    const conclusion = highestSimilarity >= 85 ? "高度重复，不建议购买" : lowFrequencySimilar >= 2 ? "重复风险较高，建议谨慎" : compatible.length >= 5 ? "值得考虑" : compatible.length >= 2 ? "建议谨慎" : "补缺型";
    const analysis = {
      conclusion,
      similar,
      compatible,
      analysisMode,
      fallbackReason,
      reasons: [
        analysisMode === "visual_hybrid" ? `最高混合相似度 ${highestSimilarity} 分（视觉 70% + 标签 30%）` : `最高标签相似度 ${highestSimilarity} 分（85 分及以上视为高度重复）`,
        `可与 ${compatible.length} 件已有衣物形成候选搭配`,
        lowFrequencySimilar ? `发现 ${lowFrequencySimilar} 件低频相似旧衣` : "未发现低频相似旧衣",
        analysisMode === "visual_hybrid" ? "视觉相似仅用于本人衣橱重复风险，不代表品牌、货号或电商同款鉴定" : fallbackReason
      ],
      needsTryOn: ["版型是否舒适", "坐下和走动是否受限", "是否能搭配现有鞋子"]
    };
    // 分析报告按当前衣橱实时计算；图片向量按图片与模型版本缓存，穿着记录变化不会重复调用模型。
    // 报告不写回候选记录，避免旧的 null analysis 在数据库中触发对象字段创建问题。
    return response(event, 200, analysis);
  }

  const decisionMatch = path.match(/^\/api\/candidates\/([^/]+)\/decision$/);
  if (method === "POST" && decisionMatch) {
    const decision = ["purchased", "wait", "declined"].includes(body.decision) ? body.decision : null;
    if (!decision) throw Object.assign(new Error("购买决定无效。"), { status: 400 });
    if (decision === "purchased" && await repository.count("clothing", { user_id: userId, status: "active" }) >= 100) {
      throw Object.assign(new Error("单个测试账号最多保存 100 件衣物。"), { status: 429 });
    }
    const candidateId = decodeURIComponent(decisionMatch[1]);
    const decisionAt = now();
    await repository.withTransaction(async (tx) => {
      const candidate = await tx.getById("candidates", candidateId);
      if (!candidate || candidate.user_id !== userId) throw Object.assign(new Error("购买决定无效。"), { status: 400 });
      if (["purchased", "declined"].includes(candidate.decision)) {
        throw Object.assign(new Error("这件候选新衣已经完成最终决定。"), { status: 409 });
      }
      if (candidate.decision === "wait" && decision === "wait") {
        throw Object.assign(new Error("这件候选新衣已经在观望清单中。"), { status: 409 });
      }
      const changes = { decision, decision_at: decisionAt };
      // “先观望”是中间状态；首次进入时固定起点，之后复盘不会重置 7 天计时。
      if (decision === "wait" && !candidate.wait_started_at) changes.wait_started_at = decisionAt;
      await tx.update("candidates", candidate.id, changes);
      if (decision === "purchased") await tx.add("clothing", {
        user_id: userId,
        image_key: candidate.image_key,
        name: candidate.name,
        category: candidate.category,
        color: candidate.color || "",
        season: candidate.season || "",
        thickness: candidate.thickness || "",
        pattern: candidate.pattern || "",
        material: candidate.material || "",
        styles: sanitizeTags(candidate.styles),
        scenes: sanitizeTags(candidate.scenes, allowedScenes),
        price: candidate.price == null ? null : Number(candidate.price),
        wear_count: 0,
        status: "active",
        idle_status: "active",
        source_hash: null,
        search_entity_id: null,
        created_at: now()
      }, newId());
    });
    return response(event, 200, { ok: true, addedToWardrobe: decision === "purchased" });
  }

  throw Object.assign(new Error("接口不存在。"), { status: 404 });
};

exports.main = async (event) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    return await route(event);
  } catch (error) {
    console.error("[request-error]", JSON.stringify({
      requestId,
      code: String(error?.code || ""),
      status: Number(error?.status || 0),
      name: String(error?.name || "Error"),
      aiTaskStage: String(error?.aiTaskStage || ""),
      providerStatus: Number(error?.providerStatus || error?.providerStatusCode || error?.statusCode || 0),
      providerRequestId: cleanText(error?.providerRequestId, 120)
    }));
    const duplicate = String(error?.code || "").toLowerCase().includes("duplicate");
    const status = duplicate ? 409 : Number(error?.status || 500);
    const providerCode = cleanText(error?.code, 80) || null;
    const providerStatus = Number(error?.providerStatus || error?.providerStatusCode || error?.statusCode || 0) || null;
    return response(event, status, {
      error: status < 500 ? error.message : "服务器暂时无法完成该操作，请稍后重试。",
      requestId,
      // 仅返回错误代码、HTTP 状态和阶段；这些值不含密钥、图片地址或供应商完整响应。
      // 测试期需要它们区分 Key、地域、模型权限与参数错误，避免让用户反复盲改配置。
      aiTaskStage: String(error?.aiTaskStage || "") || null,
      providerCode,
      providerStatus,
      providerRequestId: cleanText(error?.providerRequestId, 120) || null,
      // 错误说明经过长度限制，只用于测试期判断网络、TLS 或供应商错误；不含请求体和密钥。
      providerMessage: cleanText(error?.message, 120) || null,
      buildId: BUILD_ID
    });
  }
};

exports._test = { acquireImageEditSlot, candidateWaitSummary, cleanText, cosineSimilarity, entitlementSummary, nextStarAccount, parseArray, parseBody, quotaSummary, sanitizeTags, shanghaiDayKey, shiftDayKey, shouldSkipOutfitCandidateMatching, tagSimilarity };
