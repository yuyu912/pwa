import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import COS from "cos-nodejs-sdk-v5";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import * as tiiaSdk from "tencentcloud-sdk-nodejs-tiia";
import { databaseDriver, databaseHealth, initializeDatabase, many, one, run, transaction } from "./db.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const uploadDir = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(root, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

await initializeDatabase();

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const jwtSecret = process.env.JWT_SECRET || "development-only-change-me";
const cookieSecure = process.env.COOKIE_SECURE === "true";
if (cookieSecure) app.set("trust proxy", 1);
if (process.env.NODE_ENV === "production") {
  const required = ["JWT_SECRET", "ADMIN_BOOTSTRAP_TOKEN", "COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION", "VITA_API_KEY", "TIIA_GROUP_ID", "TIIA_REGION"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`生产环境缺少必要配置：${missing.join(", ")}`);
  if (!cookieSecure) throw new Error("生产环境必须设置 COOKIE_SECURE=true。");
}
const now = () => new Date().toISOString();
const json = (text) => JSON.parse(text || "[]");
const tokenFor = (user) => jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: "7d" });
const setSession = (response, user) => response.cookie("wardrobe_session", tokenFor(user), { httpOnly: true, secure: cookieSecure, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use((request, response, next) => {
  request.requestId = crypto.randomUUID().slice(0, 8);
  response.set("x-request-id", request.requestId);
  next();
});
app.use(express.static(path.join(root, "public"), { index: "index.html" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/")) });

// 本地零付费阶段的硬开关：即使旧服务被误启动，也绝不创建或调用腾讯云客户端。
const paidCloudEnabled = false;
const cosEnabled = paidCloudEnabled && ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION"].every((key) => process.env[key]);
const cos = cosEnabled ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY }) : null;
const vitaEnabled = Boolean(cos && process.env.VITA_API_KEY);
const ciEnabled = Boolean(cos && process.env.COS_CI_ENABLED === "true");
const searchEnabled = Boolean(cos && process.env.TIIA_GROUP_ID && process.env.TIIA_REGION);
const searchClient = searchEnabled ? new tiiaSdk.tiia.v20190529.Client({ credential: { secretId: process.env.COS_SECRET_ID, secretKey: process.env.COS_SECRET_KEY }, region: process.env.TIIA_REGION, profile: { httpProfile: { endpoint: "tiia.tencentcloudapi.com" } } }) : null;
const saveImage = async (userId, file) => {
  const extension = file.mimetype === "image/png" ? "png" : "jpg";
  const key = `${userId}/${crypto.randomUUID()}.${extension}`;
  if (cos) {
    await new Promise((resolve, reject) => cos.putObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL: "private" }, (error) => error ? reject(error) : resolve()));
  } else {
    const destination = path.join(uploadDir, key); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, file.buffer);
  }
  return key;
};
const removeImage = async (key) => {
  if (cos) return new Promise((resolve, reject) => cos.deleteObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key }, (error) => error ? reject(error) : resolve()));
  fs.rmSync(path.join(uploadDir, key), { force: true });
};
const signedImageUrl = (key) => cos.getObjectUrl({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key, Sign: true, Expires: 600 });
const cosRequest = (options) => new Promise((resolve, reject) => cos.request(options, (error, data) => error ? reject(error) : resolve(data)));
const withTimeout = (promise, message, ms = 25000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { const error = new Error(message); error.status = 504; reject(error); }, ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const requireUser = (request, response, next) => {
  try { request.user = jwt.verify(request.cookies.wardrobe_session, jwtSecret); next(); }
  catch { response.status(401).json({ error: "请先登录。" }); }
};
const asyncRoute = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
const cleanText = (value, max = 80) => String(value || "").trim().slice(0, max);
const requireImage = (request, response) => { if (!request.file) { response.status(400).json({ error: "请上传一张衣物图片。" }); return false; } return true; };
const allowedCategories = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const allowedScenes = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const sanitizeTags = (value, allowed = null, max = 4) => Array.isArray(value) ? value.map((item) => cleanText(item, 20)).filter((item) => item && (!allowed || allowed.includes(item))).slice(0, max) : [];
const parseModelJson = (content) => { const text = Array.isArray(content) ? content.map((item) => item.text || "").join("") : String(content || ""); const match = text.match(/\{[\s\S]*\}/); if (!match) throw new Error("AI 未返回可确认的标签。"); return JSON.parse(match[0]); };
const recognizeImage = async (key) => {
  if (!vitaEnabled) { const error = new Error("AI 识别尚未配置。请先在服务器 .env 填写 COS 与 VITA_API_KEY。"); error.status = 503; throw error; }
  const imageUrl = cos.getObjectUrl({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key, Sign: true, Expires: 600 });
  const prompt = `你是衣橱应用的衣物标签助手。先检查这张透明背景图是否只保留一件完整衣物，不能有脸、头发、皮肤、肢体、人体轮廓、模特或另一件衣物；再只分析该衣物。只返回 JSON，不要 Markdown。字段必须是：valid（布尔值）、reason（中文）、name（简短中文名称）、category（仅可为：上衣、裤子、半身裙、外套、连衣裙、鞋子）、color（主色中文）、styles（最多3个中文风格标签）、scenes（从休闲、通勤、约会、旅行、聚会、运动中选最多3个）、needsConfirmation（数组）。valid=false 时 reason 写明原因，其他字段可为空。不得判断身材适配或保证合身。`;
  const aiResponse = await withTimeout(fetch("https://api.vita.cloud.tencent.com/v1/video2text/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.VITA_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.VITA_MODEL || "vita-video-3.0", temperature: 0.1, stream: false, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }] }) }), "AI 标签识别响应超时，请稍后重试。");
  if (!aiResponse.ok) { const error = new Error("AI 识别暂时不可用，请稍后再试。"); error.status = 502; throw error; }
  const raw = parseModelJson((await aiResponse.json()).choices?.[0]?.message?.content);
  return { valid: raw.valid === true, reason: cleanText(raw.reason, 120) || "无法确认是否只保留一件衣物", tags: { name: cleanText(raw.name, 80) || "待确认衣物", category: allowedCategories.includes(raw.category) ? raw.category : "", color: cleanText(raw.color, 30), styles: sanitizeTags(raw.styles), scenes: sanitizeTags(raw.scenes, allowedScenes), needsConfirmation: sanitizeTags(raw.needsConfirmation, null, 3) } };
};
const extractGarment = async (sourceKey) => {
  if (!ciEnabled) { const error = new Error("衣物主体图尚未配置。请先开通数据万象商品抠图，并在 .env 设置 COS_CI_ENABLED=true。"); error.status = 503; throw error; }
  const result = await withTimeout(cosRequest({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Method: "GET", Key: sourceKey, Query: { "ci-process": "GoodsMatting" }, RawBody: true }), "商品抠图响应超时，请稍后重试。");
  const cutoutKey = `cutouts/${sourceKey.replace(/^\d+\//, "")}.png`;
  await new Promise((resolve, reject) => cos.putObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: cutoutKey, Body: result.Body, ContentType: "image/png", ACL: "private" }, (error) => error ? reject(error) : resolve()));
  return cutoutKey;
};
const ensureSearchGroup = async () => {
  if (!searchClient) { const error = new Error("相似衣物识别尚未配置。请先开通图像搜索，并设置 TIIA_GROUP_ID 与 TIIA_REGION。"); error.status = 503; throw error; }
  try { await withTimeout(searchClient.CreateGroup({ GroupId: process.env.TIIA_GROUP_ID, GroupName: "衣橱关系衣物库", MaxCapacity: 1000, GroupType: 8, Brief: "仅用于私有衣橱重复识别" }), "图像搜索服务响应超时，请稍后重试。"); }
  catch (error) { if (!String(error?.code || "").includes("AlreadyExist")) throw error; }
};
const findSimilarItems = async (userId, key) => {
  await ensureSearchGroup();
  const response = await withTimeout(searchClient.SearchImage({ GroupId: process.env.TIIA_GROUP_ID, ImageUrl: signedImageUrl(key), Limit: 10, MatchThreshold: 75, EnableDetect: true }), "相似衣物检索响应超时，请稍后重试。");
  const entityIds = (response.ImageInfos || []).map((image) => image.EntityId).filter(Boolean);
  if (!entityIds.length) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const items = await many(`SELECT id, name, category, color, image_key, search_entity_id FROM clothing_items WHERE user_id = ? AND search_entity_id IN (${placeholders})`, [userId, ...entityIds]);
  return (response.ImageInfos || []).map((image) => {
    const item = items.find((candidate) => candidate.search_entity_id === image.EntityId);
    return item ? { ...mapItem(item), score: Number(image.Score || 0) } : null;
  }).filter(Boolean);
};
const indexItem = async (userId, itemId, key) => {
  await ensureSearchGroup();
  const entityId = `u${userId}_i${itemId}`;
  await withTimeout(searchClient.CreateImage({ GroupId: process.env.TIIA_GROUP_ID, EntityId: entityId, PicName: `item_${itemId}`, ImageUrl: signedImageUrl(key), CustomContent: JSON.stringify({ userId, itemId }) }), "衣物搜索索引响应超时，请稍后重试。");
  await run("UPDATE clothing_items SET search_entity_id = ? WHERE id = ?", [entityId, itemId]);
  return entityId;
};

app.get("/api/health", asyncRoute(async (_request, response) => {
  const ready = await databaseHealth().catch(() => false);
  response.status(ready ? 200 : 503).json({ ok: ready, service: "wardrobe", database: ready ? "ready" : "unavailable" });
}));

app.post("/api/auth/register", asyncRoute(async (request, response) => {
  const inviteCode = cleanText(request.body.inviteCode, 40); const username = cleanText(request.body.username, 30); const password = String(request.body.password || "");
  if (!inviteCode || !/^[\w\u4e00-\u9fa5-]{2,30}$/.test(username) || password.length < 8) return response.status(400).json({ error: "邀请码、用户名或密码格式不符合要求。" });
  const recoveryCode = crypto.randomBytes(6).toString("hex").toUpperCase();
  const passwordHash = await bcrypt.hash(password, 12); const recoveryHash = await bcrypt.hash(recoveryCode, 12);
  const user = await transaction(async (tx) => {
    const lock = databaseDriver === "mysql" ? " FOR UPDATE" : "";
    const invite = await tx.one(`SELECT * FROM invites WHERE code = ?${lock}`, [inviteCode]);
    if (!invite || invite.used_by) { const error = new Error("邀请码无效或已被使用。"); error.status = 400; throw error; }
    if (await tx.one("SELECT id FROM users WHERE username = ?", [username])) { const error = new Error("该用户名已被使用。"); error.status = 409; throw error; }
    const inserted = await tx.run("INSERT INTO users (username, password_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?)", [username, passwordHash, recoveryHash, now()]);
    const created = { id: inserted.insertId, username };
    await tx.run("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?", [created.id, now(), invite.id]);
    return created;
  });
  setSession(response, user);
  response.status(201).json({ user, recoveryCode });
}));
app.post("/api/auth/login", asyncRoute(async (request, response) => {
  const user = await one("SELECT * FROM users WHERE username = ?", [cleanText(request.body.username, 30)]);
  if (!user || !(await bcrypt.compare(String(request.body.password || ""), user.password_hash))) return response.status(401).json({ error: "用户名或密码不正确。" });
  setSession(response, user); response.json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/recover", asyncRoute(async (request, response) => {
  const user = await one("SELECT * FROM users WHERE username = ?", [cleanText(request.body.username, 30)]); const password = String(request.body.newPassword || "");
  if (!user || password.length < 8 || !(await bcrypt.compare(String(request.body.recoveryCode || ""), user.recovery_hash))) return response.status(400).json({ error: "恢复码或新密码不正确。" });
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), user.id]); setSession(response, user); response.json({ user: { id: user.id, username: user.username } });
}));
app.post("/api/auth/logout", (_request, response) => { response.clearCookie("wardrobe_session", { path: "/" }); response.status(204).end(); });
app.get("/api/auth/me", requireUser, (request, response) => response.json({ user: request.user }));

app.post("/api/admin/invites", asyncRoute(async (request, response) => {
  if (!process.env.ADMIN_BOOTSTRAP_TOKEN || request.get("x-admin-token") !== process.env.ADMIN_BOOTSTRAP_TOKEN) return response.status(401).json({ error: "管理员令牌无效。" });
  const code = cleanText(request.body.code, 40) || crypto.randomBytes(5).toString("hex").toUpperCase();
  if (await one("SELECT id FROM invites WHERE code = ?", [code])) return response.status(409).json({ error: "邀请码已存在。" });
  await run("INSERT INTO invites (code, created_at) VALUES (?, ?)", [code, now()]); response.status(201).json({ code });
}));

app.post("/api/recognize", requireUser, upload.single("image"), asyncRoute(async (request, response) => {
  let sourceKey = null, cutoutKey = null;
  try {
    if (!requireImage(request, response)) return;
    const isClosetEntry = request.body.mode !== "candidate";
    const sourceHash = crypto.createHash("sha256").update(request.file.buffer).digest("hex");
    const exact = isClosetEntry && await one("SELECT id, name, category, color, image_key FROM clothing_items WHERE user_id = ? AND source_hash = ?", [request.user.id, sourceHash]);
    if (exact) return response.status(409).json({ error: "这张衣物图片已经录入过。", duplicate: { type: "blocked", item: mapItem(exact), score: 100 } });
    sourceKey = await saveImage(request.user.id, request.file);
    cutoutKey = await extractGarment(sourceKey);
    const recognition = await recognizeImage(cutoutKey);
    if (!recognition.valid) return response.status(422).json({ error: `未能只保留一件衣物：${recognition.reason}。请改用平铺或挂拍照片。` });
    const tags = recognition.tags;
    const similar = isClosetEntry ? await findSimilarItems(request.user.id, cutoutKey) : [];
    const blocked = similar.find((item) => item.score >= 90);
    if (blocked) return response.status(409).json({ error: `这件衣物与“${blocked.name}”高度相似，已阻止重复录入。`, duplicate: { type: "blocked", item: blocked, score: blocked.score } });
    const inserted = await run("INSERT INTO image_drafts (user_id, image_key, source_hash, similarity_json, created_at) VALUES (?, ?, ?, ?, ?)", [request.user.id, cutoutKey, sourceHash, JSON.stringify(similar), now()]);
    response.status(201).json({ draftId: inserted.insertId, tags, duplicate: similar[0] ? { type: "warning", item: similar[0], score: similar[0].score } : null });
    sourceKey = null; cutoutKey = null;
  } catch (error) { throw error; }
  finally {
    if (sourceKey) await removeImage(sourceKey).catch(() => {});
    if (cutoutKey) await removeImage(cutoutKey).catch(() => {});
  }
}));

const mapItem = (item) => ({ ...item, styles: json(item.styles), scenes: json(item.scenes), imageUrl: `/api/images/${encodeURIComponent(item.image_key)}` });
app.get("/api/items", requireUser, asyncRoute(async (request, response) => response.json((await many("SELECT * FROM clothing_items WHERE user_id = ? ORDER BY id DESC", [request.user.id])).map(mapItem))));
app.post("/api/items", requireUser, upload.single("image"), asyncRoute(async (request, response) => {
  const hasDraftId = Boolean(request.body.draftId);
  let draft = hasDraftId ? await one("SELECT * FROM image_drafts WHERE id = ? AND user_id = ?", [request.body.draftId, request.user.id]) : null;
  const usedDraftFallback = !draft && !request.file;
  if (usedDraftFallback) draft = await one("SELECT * FROM image_drafts WHERE user_id = ? AND item_id IS NULL ORDER BY id DESC LIMIT 1", [request.user.id]);
  console.info("[item-save]", JSON.stringify({ contentType: request.get("content-type") || "", hasDraftId, hasFile: Boolean(request.file), draftFound: Boolean(draft), usedDraftFallback }));
  if (draft?.item_id) return response.status(200).json(mapItem(await one("SELECT * FROM clothing_items WHERE id = ?", [draft.item_id])));
  if (!draft && !request.file) return response.status(400).json({ error: "未找到刚才的识别结果，请重新识别后再保存。" });
  const imageKey = draft ? draft.image_key : await saveImage(request.user.id, request.file); const name = cleanText(request.body.name, 80) || "未命名衣物"; const category = cleanText(request.body.category, 30);
  if (!category) return response.status(400).json({ error: "请选择衣物品类。" });
  const saved = await transaction(async (tx) => {
    const lock = databaseDriver === "mysql" ? " FOR UPDATE" : "";
    const lockedDraft = draft ? await tx.one(`SELECT * FROM image_drafts WHERE id = ? AND user_id = ?${lock}`, [draft.id, request.user.id]) : null;
    if (lockedDraft?.item_id) return { item: await tx.one("SELECT * FROM clothing_items WHERE id = ?", [lockedDraft.item_id]), alreadySaved: true };
    const inserted = await tx.run("INSERT INTO clothing_items (user_id, image_key, name, category, color, styles, scenes, price, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [request.user.id, imageKey, name, category, cleanText(request.body.color, 30), JSON.stringify(json(request.body.styles)), JSON.stringify(json(request.body.scenes)), Number(request.body.price) || null, lockedDraft?.source_hash || null, now()]);
    const item = await tx.one("SELECT * FROM clothing_items WHERE id = ?", [inserted.insertId]);
    if (lockedDraft) await tx.run("UPDATE image_drafts SET item_id = ? WHERE id = ?", [item.id, lockedDraft.id]);
    return { item, alreadySaved: false };
  });
  if (saved.alreadySaved) return response.status(200).json(mapItem(saved.item));
  const item = saved.item;
  let warning = null;
  if (draft) {
    try { await indexItem(request.user.id, item.id, imageKey); }
    catch (error) {
      console.warn("[item-index]", JSON.stringify({ code: String(error?.code || ""), status: Number(error?.status || 0) }));
      warning = "衣物已保存，但相似衣物检索暂时不可用；同件不同背景的重复提醒会稍后补齐。";
    }
  }
  response.status(201).json({ ...mapItem(await one("SELECT * FROM clothing_items WHERE id = ?", [item.id])), warning });
}));
app.post("/api/items/:id/wear-logs", requireUser, asyncRoute(async (request, response) => {
  await transaction(async (tx) => {
    const item = await tx.one("SELECT id FROM clothing_items WHERE id = ? AND user_id = ?", [request.params.id, request.user.id]);
    if (!item) { const error = new Error("未找到衣物。"); error.status = 404; throw error; }
    await tx.run("INSERT INTO wear_logs (user_id, item_id, scene, comfort, note, worn_at) VALUES (?, ?, ?, ?, ?, ?)", [request.user.id, item.id, cleanText(request.body.scene, 30), cleanText(request.body.comfort, 30), cleanText(request.body.note, 200), now()]);
    await tx.run("UPDATE clothing_items SET wear_count = wear_count + 1 WHERE id = ?", [item.id]);
  });
  response.status(201).json({ ok: true });
}));

app.post("/api/candidates", requireUser, upload.single("image"), asyncRoute(async (request, response) => {
  const draft = request.body.draftId ? await one("SELECT * FROM image_drafts WHERE id = ? AND user_id = ?", [request.body.draftId, request.user.id]) : null;
  if (!draft && !requireImage(request, response)) return;
  const imageKey = draft ? draft.image_key : await saveImage(request.user.id, request.file); const category = cleanText(request.body.category, 30); if (!category) return response.status(400).json({ error: "请选择候选新衣品类。" });
  const id = await transaction(async (tx) => {
    const inserted = await tx.run("INSERT INTO candidates (user_id, image_key, name, category, color, styles, scenes, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [request.user.id, imageKey, cleanText(request.body.name, 80) || "候选新衣", category, cleanText(request.body.color, 30), JSON.stringify(json(request.body.styles)), JSON.stringify(json(request.body.scenes)), Number(request.body.price) || null, now()]);
    if (draft) await tx.run("DELETE FROM image_drafts WHERE id = ?", [draft.id]);
    return inserted.insertId;
  });
  response.status(201).json({ id });
}));
app.post("/api/candidates/:id/analyze", requireUser, asyncRoute(async (request, response) => {
  const candidate = await one("SELECT * FROM candidates WHERE id = ? AND user_id = ?", [request.params.id, request.user.id]); if (!candidate) return response.status(404).json({ error: "未找到候选新衣。" });
  const candidateScenes = json(candidate.scenes); const existing = await many("SELECT * FROM clothing_items WHERE user_id = ? AND status = 'active'", [request.user.id]);
  const similar = existing.map((item) => { let score = 0; if (item.category === candidate.category) score += 55; if (item.color && candidate.color && item.color === candidate.color) score += 25; const overlap = json(item.scenes).filter((scene) => candidateScenes.includes(scene)).length; score += overlap * 10; return { ...mapItem(item), score }; }).filter((item) => item.score >= 55).sort((a, b) => b.score - a.score).slice(0, 3);
  const compatible = existing.filter((item) => item.category !== candidate.category && json(item.scenes).some((scene) => candidateScenes.includes(scene))).slice(0, 6).map(mapItem);
  const lowFrequencySimilar = similar.filter((item) => item.wear_count < 3).length;
  const conclusion = lowFrequencySimilar >= 2 ? "重复风险较高" : compatible.length >= 5 ? "值得考虑" : compatible.length >= 2 ? "建议谨慎" : "补缺型";
  const analysis = { conclusion, similar, compatible, reasons: [`可与 ${compatible.length} 件已有衣物形成候选搭配`, lowFrequencySimilar ? `发现 ${lowFrequencySimilar} 件低频相似旧衣` : "未发现多件低频相似旧衣", "结论仅依据用户确认的标签与真实穿着记录"], needsTryOn: ["版型是否舒适", "坐下和走动是否受限", "是否能搭配现有鞋子"] };
  await run("UPDATE candidates SET analysis_json = ? WHERE id = ?", [JSON.stringify(analysis), candidate.id]); response.json(analysis);
}));
app.post("/api/candidates/:id/decision", requireUser, asyncRoute(async (request, response) => {
  const decision = ["purchased", "wait", "declined"].includes(request.body.decision) ? request.body.decision : null;
  if (!decision) return response.status(400).json({ error: "购买决定无效。" });
  await transaction(async (tx) => {
    const lock = databaseDriver === "mysql" ? " FOR UPDATE" : "";
    const candidate = await tx.one(`SELECT * FROM candidates WHERE id = ? AND user_id = ?${lock}`, [request.params.id, request.user.id]);
    if (!candidate) { const error = new Error("购买决定无效。"); error.status = 400; throw error; }
    if (candidate.decision) { const error = new Error("这件候选新衣已经记录过购买决定。"); error.status = 409; throw error; }
    await tx.run("UPDATE candidates SET decision = ? WHERE id = ?", [decision, candidate.id]);
    if (decision === "purchased") await tx.run("INSERT INTO clothing_items (user_id, image_key, name, category, color, styles, scenes, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [candidate.user_id, candidate.image_key, candidate.name, candidate.category, candidate.color, candidate.styles, candidate.scenes, candidate.price, now()]);
  });
  response.json({ ok: true, addedToWardrobe: decision === "purchased" });
}));
app.get("/api/images/:key", requireUser, asyncRoute(async (request, response) => {
  const key = decodeURIComponent(request.params.key); const owned = await one("SELECT id FROM clothing_items WHERE user_id = ? AND image_key = ? UNION SELECT id FROM candidates WHERE user_id = ? AND image_key = ?", [request.user.id, key, request.user.id, key]);
  if (!owned) return response.status(404).end();
  if (!cos) return response.sendFile(path.join(uploadDir, key));
  cos.getObject({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key }, (error, data) => error ? response.status(404).end() : response.type(data.headers["content-type"] || "image/jpeg").send(data.Body));
}));

app.use((error, request, response, _next) => {
  console.error("[request-error]", JSON.stringify({ requestId: request.requestId, code: String(error?.code || ""), status: Number(error?.status || 0), name: String(error?.name || "Error") }));
  if (error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "图片超过 10MB，请压缩后再试。" });
  if (error.code === "ER_DUP_ENTRY") return response.status(409).json({ error: "这条记录已经存在。", requestId: request.requestId });
  response.status(error.status || 500).json({ error: error.status ? error.message : "服务器暂时无法完成该操作，请稍后重试。", requestId: request.requestId });
});
app.listen(port, host, () => console.log(`衣橱关系 PWA 已启动：http://localhost:${port}（数据库：${databaseDriver}）`));
