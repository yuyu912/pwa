"use strict";

const crypto = require("crypto");
const COS = require("cos-nodejs-sdk-v5");
const tiiaSdk = require("tencentcloud-sdk-nodejs-tiia");

let clients;

const required = (names) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw Object.assign(new Error(`云函数缺少配置：${missing.join(", ")}`), { status: 503 });
};

const getClients = () => {
  if (clients) return clients;
  required(["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION", "VITA_API_KEY", "TIIA_GROUP_ID", "TIIA_REGION"]);
  const credential = { secretId: process.env.COS_SECRET_ID, secretKey: process.env.COS_SECRET_KEY };
  clients = {
    cos: new COS({ SecretId: credential.secretId, SecretKey: credential.secretKey }),
    search: new tiiaSdk.tiia.v20190529.Client({
      credential,
      region: process.env.TIIA_REGION,
      profile: { httpProfile: { endpoint: "tiia.tencentcloudapi.com" } }
    })
  };
  return clients;
};

const cosCall = (method, options) => new Promise((resolve, reject) => {
  getClients().cos[method](options, (error, data) => error ? reject(error) : resolve(data));
});

const cosRequest = (options) => new Promise((resolve, reject) => {
  getClients().cos.request(options, (error, data) => error ? reject(error) : resolve(data));
});

const withTimeout = (promise, message, milliseconds = 25000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 504 })), milliseconds);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); }
  );
});

const objectOptions = (key) => ({
  Bucket: process.env.COS_BUCKET,
  Region: process.env.COS_REGION,
  Key: key
});

const signedUrl = (key, method = "GET", expires = 600) => getClients().cos.getObjectUrl({
  ...objectOptions(key),
  Method: method,
  Sign: true,
  Expires: expires
});

const createUpload = (userId, mimeType) => {
  const extension = mimeType === "image/png" ? "png" : "jpg";
  const sourceKey = `uploads/${userId}/${crypto.randomUUID()}.${extension}`;
  return { sourceKey, uploadUrl: signedUrl(sourceKey, "PUT", 300), expiresIn: 300 };
};

const readObject = async (key) => {
  const result = await cosCall("getObject", objectOptions(key));
  return Buffer.from(result.Body);
};

const deleteObject = (key) => cosCall("deleteObject", objectOptions(key));

const sourceHash = async (key) => crypto.createHash("sha256").update(await readObject(key)).digest("hex");

const extractGarment = async (sourceKey) => {
  if (process.env.COS_CI_ENABLED !== "true") throw Object.assign(new Error("衣物主体图服务尚未配置。"), { status: 503 });
  const result = await withTimeout(cosRequest({
    ...objectOptions(sourceKey),
    Method: "GET",
    Query: { "ci-process": "GoodsMatting" },
    RawBody: true
  }), "商品抠图响应超时，请稍后重试。");
  const cutoutKey = `cutouts/${sourceKey.split("/").pop().replace(/\.[^.]+$/, "")}.png`;
  await cosCall("putObject", {
    ...objectOptions(cutoutKey),
    Body: result.Body,
    ContentType: "image/png",
    ACL: "private"
  });
  return cutoutKey;
};

const cleanText = (value, max = 80) => String(value || "").trim().slice(0, max);
const allowedCategories = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const allowedScenes = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const sanitizeTags = (value, allowed = null, max = 4) => Array.isArray(value)
  ? value.map((item) => cleanText(item, 20)).filter((item) => item && (!allowed || allowed.includes(item))).slice(0, max)
  : [];

const parseModelJson = (content) => {
  const text = Array.isArray(content) ? content.map((item) => item.text || "").join("") : String(content || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(new Error("AI 未返回可确认的标签。"), { status: 502 });
  return JSON.parse(match[0]);
};

const recognizeImage = async (key) => {
  const prompt = "你是衣橱应用的衣物标签助手。先检查这张透明背景图是否只保留一件完整衣物，不能有脸、头发、皮肤、肢体、人体轮廓、模特或另一件衣物；再只分析该衣物。只返回 JSON，不要 Markdown。字段必须是：valid（布尔值）、reason（中文）、name（简短中文名称）、category（仅可为：上衣、裤子、半身裙、外套、连衣裙、鞋子）、color（主色中文）、styles（最多3个中文风格标签）、scenes（从休闲、通勤、约会、旅行、聚会、运动中选最多3个）、needsConfirmation（数组）。valid=false 时 reason 写明原因，其他字段可为空。不得判断身材适配或保证合身。";
  const response = await withTimeout(uniCloud.httpclient.request(
    "https://api.vita.cloud.tencent.com/v1/video2text/chat/completions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.VITA_API_KEY}`, "Content-Type": "application/json" },
      content: JSON.stringify({
        model: process.env.VITA_MODEL || "vita-video-3.0",
        temperature: 0.1,
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: signedUrl(key) } }] }]
      }),
      dataType: "json",
      timeout: 25000
    }
  ), "AI 标签识别响应超时，请稍后重试。");
  if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
    throw Object.assign(new Error("AI 识别暂时不可用，请稍后再试。"), { status: 502 });
  }
  const raw = parseModelJson(response.data?.choices?.[0]?.message?.content);
  return {
    valid: raw.valid === true,
    reason: cleanText(raw.reason, 120) || "无法确认是否只保留一件衣物",
    tags: {
      name: cleanText(raw.name, 80) || "待确认衣物",
      category: allowedCategories.includes(raw.category) ? raw.category : "",
      color: cleanText(raw.color, 30),
      styles: sanitizeTags(raw.styles),
      scenes: sanitizeTags(raw.scenes, allowedScenes),
      needsConfirmation: sanitizeTags(raw.needsConfirmation, null, 3)
    }
  };
};

const ensureSearchGroup = async () => {
  try {
    await withTimeout(getClients().search.CreateGroup({
      GroupId: process.env.TIIA_GROUP_ID,
      GroupName: "衣橱关系衣物库",
      MaxCapacity: 1000,
      GroupType: 8,
      Brief: "仅用于私有衣橱重复识别"
    }), "图像搜索服务响应超时，请稍后重试。");
  } catch (error) {
    if (!String(error?.code || "").includes("AlreadyExist")) throw error;
  }
};

const searchImage = async (key) => {
  await ensureSearchGroup();
  return withTimeout(getClients().search.SearchImage({
    GroupId: process.env.TIIA_GROUP_ID,
    ImageUrl: signedUrl(key),
    Limit: 10,
    MatchThreshold: 75,
    EnableDetect: true
  }), "相似衣物检索响应超时，请稍后重试。");
};

const indexImage = async (userId, itemId, key) => {
  await ensureSearchGroup();
  const entityId = `u${userId}_i${itemId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  await withTimeout(getClients().search.CreateImage({
    GroupId: process.env.TIIA_GROUP_ID,
    EntityId: entityId,
    PicName: `item_${String(itemId).slice(0, 40)}`,
    ImageUrl: signedUrl(key),
    CustomContent: JSON.stringify({ userId, itemId })
  }), "衣物搜索索引响应超时，请稍后重试。");
  return entityId;
};

module.exports = {
  createUpload,
  deleteObject,
  extractGarment,
  indexImage,
  recognizeImage,
  searchImage,
  signedUrl,
  sourceHash
};
