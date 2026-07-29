"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const repository = require("./lib/database");
const cloud = require("./lib/cloud-services");

const now = () => new Date().toISOString();
const cleanText = (value, max = 80) => String(value || "").trim().slice(0, max);
const newId = () => crypto.randomUUID();
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
const allowedScenes = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

const publicUser = (user) => ({ id: String(user.id), username: user.username });
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

const findSimilarItems = async (userId, imageKey) => {
  const search = await cloud.searchImage(imageKey);
  const entityIds = (search.ImageInfos || []).map((image) => image.EntityId).filter(Boolean);
  if (!entityIds.length) return [];
  const items = await repository.findMany("clothing", {
    user_id: String(userId),
    search_entity_id: repository.command().in(entityIds)
  });
  return (search.ImageInfos || []).map((image) => {
    const item = items.find((candidate) => candidate.search_entity_id === image.EntityId);
    return item ? { ...mapItem(item), score: Number(image.Score || 0) } : null;
  }).filter(Boolean);
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
    created_at: now()
  };
  await repository.withTransaction(async (tx) => {
    const lockedInvite = await tx.getById("invites", invite.id);
    if (!lockedInvite || lockedInvite.used_by) throw Object.assign(new Error("邀请码无效或已被使用。"), { status: 400 });
    await tx.add("users", {
      username: user.username,
      password_hash: user.password_hash,
      recovery_hash: user.recovery_hash,
      created_at: user.created_at
    }, user.id);
    await tx.update("invites", lockedInvite.id, { used_by: user.id, used_at: now() });
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
      styles: sanitizeTags(row.styles),
      scenes: sanitizeTags(row.scenes, allowedScenes),
      price: row.price == null ? null : Number(row.price),
      wear_count: Number(row.wear_count || 0),
      status: row.status || "active",
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

const route = async (event) => {
  const method = String(event.httpMethod || "GET").toUpperCase();
  const path = String(event.path || "/").replace(/\/+$/, "") || "/";
  const body = ["POST", "PUT", "PATCH"].includes(method) ? parseBody(event) : {};

  if (method === "OPTIONS") return response(event, 204, null);
  if (method === "GET" && path === "/api/health") {
    await repository.count("users");
    return response(event, 200, { ok: true, service: "wardrobe", database: "ready" });
  }

  if (method === "POST" && path === "/api/auth/register") {
    return response(event, 201, await handleRegister(body));
  }
  if (method === "POST" && path === "/api/auth/login") {
    const user = await repository.findOne("users", { username: cleanText(body.username, 30) });
    if (!user || !(await bcrypt.compare(String(body.password || ""), user.password_hash))) {
      throw Object.assign(new Error("用户名或密码不正确。"), { status: 401 });
    }
    return response(event, 200, { user: publicUser(user), token: tokenFor(user) });
  }
  if (method === "POST" && path === "/api/auth/recover") {
    const user = await repository.findOne("users", { username: cleanText(body.username, 30) });
    const password = String(body.newPassword || "");
    if (!user || password.length < 8 || !(await bcrypt.compare(String(body.recoveryCode || ""), user.recovery_hash))) {
      throw Object.assign(new Error("恢复码或新密码不正确。"), { status: 400 });
    }
    await repository.update("users", user.id, { password_hash: await bcrypt.hash(password, 12) });
    return response(event, 200, { user: publicUser(user), token: tokenFor(user) });
  }
  if (method === "POST" && path === "/api/auth/logout") return response(event, 204, null);
  if (method === "GET" && path === "/api/auth/me") return response(event, 200, { user: publicUser(requireUser(event)) });

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

  const user = requireUser(event);
  const userId = String(user.id);

  if (method === "POST" && path === "/api/uploads/presign") {
    const mimeType = cleanText(body.mimeType, 40).toLowerCase();
    const size = Number(body.size || 0);
    if (!["image/jpeg", "image/png"].includes(mimeType) || size < 1 || size > 10 * 1024 * 1024) {
      throw Object.assign(new Error("请上传不超过 10MB 的 JPG 或 PNG 衣物图片。"), { status: 400 });
    }
    return response(event, 201, cloud.createUpload(userId, mimeType));
  }

  if (method === "POST" && path === "/api/recognize") {
    const sourceKey = cleanText(body.sourceKey, 300);
    if (!sourceKey.startsWith(`uploads/${userId}/`)) throw Object.assign(new Error("上传凭据无效，请重新选择图片。"), { status: 400 });
    const isClosetEntry = body.mode !== "candidate";
    let cutoutKey = null;
    let keepCutout = false;
    try {
      const hash = await cloud.sourceHash(sourceKey);
      const exact = isClosetEntry ? await repository.findOne("clothing", { source_hash_key: `${userId}:${hash}` }) : null;
      if (exact) return response(event, 409, { error: "这张衣物图片已经录入过。", duplicate: { type: "blocked", item: mapItem(exact), score: 100 } });
      cutoutKey = await cloud.extractGarment(sourceKey);
      const recognition = await cloud.recognizeImage(cutoutKey);
      if (!recognition.valid) return response(event, 422, { error: `未能只保留一件衣物：${recognition.reason}。请改用平铺或挂拍照片。` });

      let similar = [];
      let warning = null;
      if (isClosetEntry) {
        try { similar = await findSimilarItems(userId, cutoutKey); }
        catch (error) {
          console.warn("[similarity-search]", JSON.stringify({ code: String(error?.code || ""), status: Number(error?.status || 0) }));
          warning = "衣物标签已识别，但不同背景重复提醒暂时不可用。";
        }
      }
      const blocked = similar.find((item) => item.score >= 90);
      if (blocked) return response(event, 409, { error: `这件衣物与“${blocked.name}”高度相似，已阻止重复录入。`, duplicate: { type: "blocked", item: blocked, score: blocked.score } });

      const draftId = newId();
      await repository.add("drafts", {
        user_id: userId,
        image_key: cutoutKey,
        source_hash: hash,
        similarity: similar,
        item_id: null,
        created_at: now()
      }, draftId);
      keepCutout = true;
      return response(event, 201, {
        draftId,
        tags: recognition.tags,
        warning,
        duplicate: similar[0] ? { type: "warning", item: similar[0], score: similar[0].score } : null
      });
    } finally {
      await cloud.deleteObject(sourceKey).catch(() => {});
      if (cutoutKey && !keepCutout) await cloud.deleteObject(cutoutKey).catch(() => {});
    }
  }

  if (method === "GET" && path === "/api/items") {
    const items = await repository.findMany("clothing", { user_id: userId }, { orderBy: "created_at", order: "desc" });
    return response(event, 200, items.map(mapItem));
  }

  if (method === "POST" && path === "/api/items") {
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
      styles: sanitizeTags(body.styles),
      scenes: sanitizeTags(body.scenes, allowedScenes),
      price: body.price === "" || body.price == null ? null : Number(body.price),
      wear_count: 0,
      status: "active",
      source_hash: draft.source_hash || null,
      ...(draft.source_hash ? { source_hash_key: `${userId}:${draft.source_hash}` } : {}),
      search_entity_id: null,
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
    let warning = null;
    try {
      const entityId = await cloud.indexImage(userId, itemId, itemData.image_key);
      await repository.update("clothing", itemId, { search_entity_id: entityId });
    } catch (error) {
      console.warn("[item-index]", JSON.stringify({ code: String(error?.code || ""), status: Number(error?.status || 0) }));
      warning = "衣物已保存，但相似衣物检索暂时不可用；同件不同背景的重复提醒会稍后补齐。";
    }
    return response(event, 201, { ...mapItem(await repository.getById("clothing", itemId)), warning });
  }

  const wearMatch = path.match(/^\/api\/items\/([^/]+)\/wear-logs$/);
  if (method === "POST" && wearMatch) {
    const itemId = decodeURIComponent(wearMatch[1]);
    await repository.withTransaction(async (tx) => {
      const item = await tx.getById("clothing", itemId);
      if (!item || item.user_id !== userId) throw Object.assign(new Error("未找到衣物。"), { status: 404 });
      await tx.add("wearLogs", {
        user_id: userId,
        item_id: itemId,
        scene: cleanText(body.scene, 30),
        comfort: cleanText(body.comfort, 30),
        note: cleanText(body.note, 200),
        worn_at: now()
      }, newId());
      await tx.update("clothing", itemId, { wear_count: repository.command().inc(1) });
    });
    return response(event, 201, { ok: true });
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
        styles: sanitizeTags(body.styles),
        scenes: sanitizeTags(body.scenes, allowedScenes),
        price: body.price === "" || body.price == null ? null : Number(body.price),
        decision: null,
        analysis: null,
        created_at: now()
      }, candidateId);
      await tx.remove("drafts", lockedDraft.id);
    });
    return response(event, 201, { id: candidateId });
  }

  const analyzeMatch = path.match(/^\/api\/candidates\/([^/]+)\/analyze$/);
  if (method === "POST" && analyzeMatch) {
    const candidate = await repository.getById("candidates", decodeURIComponent(analyzeMatch[1]));
    if (!candidate || candidate.user_id !== userId) throw Object.assign(new Error("未找到候选新衣。"), { status: 404 });
    const existing = await repository.findMany("clothing", { user_id: userId, status: "active" });
    const candidateScenes = sanitizeTags(candidate.scenes, allowedScenes);
    const similar = existing.map((item) => {
      let score = item.category === candidate.category ? 55 : 0;
      if (item.color && candidate.color && item.color === candidate.color) score += 25;
      score += sanitizeTags(item.scenes, allowedScenes).filter((scene) => candidateScenes.includes(scene)).length * 10;
      return { ...mapItem(item), score };
    }).filter((item) => item.score >= 55).sort((a, b) => b.score - a.score).slice(0, 3);
    const compatible = existing.filter((item) => item.category !== candidate.category && sanitizeTags(item.scenes, allowedScenes).some((scene) => candidateScenes.includes(scene))).slice(0, 6).map(mapItem);
    const lowFrequencySimilar = similar.filter((item) => Number(item.wear_count || 0) < 3).length;
    const conclusion = lowFrequencySimilar >= 2 ? "重复风险较高" : compatible.length >= 5 ? "值得考虑" : compatible.length >= 2 ? "建议谨慎" : "补缺型";
    const analysis = {
      conclusion,
      similar,
      compatible,
      reasons: [`可与 ${compatible.length} 件已有衣物形成候选搭配`, lowFrequencySimilar ? `发现 ${lowFrequencySimilar} 件低频相似旧衣` : "未发现多件低频相似旧衣", "结论仅依据用户确认的标签与真实穿着记录"],
      needsTryOn: ["版型是否舒适", "坐下和走动是否受限", "是否能搭配现有鞋子"]
    };
    await repository.update("candidates", candidate.id, { analysis });
    return response(event, 200, analysis);
  }

  const decisionMatch = path.match(/^\/api\/candidates\/([^/]+)\/decision$/);
  if (method === "POST" && decisionMatch) {
    const decision = ["purchased", "wait", "declined"].includes(body.decision) ? body.decision : null;
    if (!decision) throw Object.assign(new Error("购买决定无效。"), { status: 400 });
    const candidateId = decodeURIComponent(decisionMatch[1]);
    await repository.withTransaction(async (tx) => {
      const candidate = await tx.getById("candidates", candidateId);
      if (!candidate || candidate.user_id !== userId) throw Object.assign(new Error("购买决定无效。"), { status: 400 });
      if (candidate.decision) throw Object.assign(new Error("这件候选新衣已经记录过购买决定。"), { status: 409 });
      await tx.update("candidates", candidate.id, { decision });
      if (decision === "purchased") await tx.add("clothing", {
        user_id: userId,
        image_key: candidate.image_key,
        name: candidate.name,
        category: candidate.category,
        color: candidate.color || "",
        styles: sanitizeTags(candidate.styles),
        scenes: sanitizeTags(candidate.scenes, allowedScenes),
        price: candidate.price == null ? null : Number(candidate.price),
        wear_count: 0,
        status: "active",
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
      name: String(error?.name || "Error")
    }));
    const duplicate = String(error?.code || "").toLowerCase().includes("duplicate");
    const status = duplicate ? 409 : Number(error?.status || 500);
    return response(event, status, {
      error: status < 500 ? error.message : "服务器暂时无法完成该操作，请稍后重试。",
      requestId
    });
  }
};

exports._test = { cleanText, parseArray, parseBody, sanitizeTags };
