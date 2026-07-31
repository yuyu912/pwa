"use strict";

const crypto = require("crypto");
const https = require("https");
const COS = require("cos-nodejs-sdk-v5");

let cosClient;

const required = (names) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw Object.assign(new Error(`云函数缺少配置：${missing.join(", ")}`), { status: 503 });
};

const getCos = () => {
  if (cosClient) return cosClient;
  required(["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION"]);
  cosClient = new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY
  });
  return cosClient;
};

const objectOptions = (key) => ({
  Bucket: process.env.COS_BUCKET,
  Region: process.env.COS_REGION,
  Key: key
});

const cosCall = (method, options) => new Promise((resolve, reject) => {
  getCos()[method](options, (error, data) => error ? reject(error) : resolve(data));
});

const cosRequest = (options) => new Promise((resolve, reject) => {
  getCos().request(options, (error, data) => error ? reject(error) : resolve(data));
});

const withTimeout = (promise, message, milliseconds = 25000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 504 })), milliseconds);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); }
  );
});

const signedUrl = (key, method = "GET", expires = 600) => getCos().getObjectUrl({
  ...objectOptions(key),
  Method: method,
  Sign: true,
  Expires: expires
});

// 手机只拿到 5 分钟有效、仅能写入本任务文件的私有 COS 地址；密钥始终留在云函数。
const createUpload = (userId, mimeType, taskId = crypto.randomUUID()) => {
  const extension = mimeType === "image/png" ? "png" : "jpg";
  const sourceKey = `uploads/${userId}/${taskId}.${extension}`;
  return { taskId, sourceKey, uploadUrl: signedUrl(sourceKey, "PUT", 300), expiresIn: 300 };
};

const readObject = async (key) => {
  const result = await cosCall("getObject", objectOptions(key));
  return Buffer.from(result.Body);
};

const deleteObject = (key) => cosCall("deleteObject", objectOptions(key));
const sourceHash = async (key) => crypto.createHash("sha256").update(await readObject(key)).digest("hex");

// 商品抠图生成透明主图。原图仅作为本次任务输入，正式衣橱不会保存它。
const extractGarment = async (sourceKey) => {
  if (process.env.COS_CI_ENABLED !== "true") {
    throw Object.assign(new Error("衣物主体图服务尚未配置。"), { status: 503 });
  }
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
const allowedSeasons = ["春夏", "春秋", "秋冬", "多季"];
const allowedThicknesses = ["薄", "适中", "厚"];
const sanitizeTags = (value, allowed = null, max = 4) => Array.isArray(value)
  ? value.map((item) => cleanText(item, 20)).filter((item) => item && (!allowed || allowed.includes(item))).slice(0, max)
  : [];

const parseModelJson = (content) => {
  const text = Array.isArray(content) ? content.map((item) => item.text || "").join("") : String(content || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(new Error("AI 未返回可确认的标签。"), { status: 502 });
  return JSON.parse(match[0]);
};

// DCloud 官方响应字段为 status；兼容 statusCode 是为了支持不同 urllib 版本与本地测试替身。
const responseStatus = (response) => Number(response?.statusCode || response?.status || 0);

const buildQwenRequestBody = (imageUrl, model) => ({
  model,
  temperature: 0.1,
  // 衣物入库只需要结构化候选，不需要思考链；关闭思考模式可降低输出成本并提高 JSON 稳定性。
  enable_thinking: false,
  // 百炼已建议新接入使用 max_completion_tokens；限制输出长度也是单件成本控制的一部分。
  max_completion_tokens: 450,
  stream: false,
  response_format: { type: "json_object" },
  messages: [{
    role: "user",
    content: [
      {
        type: "image_url",
        image_url: { url: imageUrl },
        // 官方 OpenAI 兼容格式要求 max_pixels 与 image_url 同级，不能放进 image_url 对象内部。
        max_pixels: 786432
      },
      { type: "text", text: "__PROMPT__" }
    ]
  }]
});

const buildQwenHttpOptions = (requestBody, apiKey) => {
  const content = JSON.stringify(requestBody);
  return {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(content)
  },
  content,
  timeout: 25000
  };
};

const qwenHttpRequest = (url, requestBody, apiKey) => new Promise((resolve, reject) => {
  const options = buildQwenHttpOptions(requestBody, apiKey);
  // uniCloud.httpclient 在阿里云运行时持续返回 InternalServerError，因此改用 Node 原生 HTTPS。
  // 这仍然是服务端调用，API Key 不会进入小程序、图片地址也不会写入日志。
  const request = https.request(url, {
    method: options.method,
    headers: options.headers,
    timeout: options.timeout
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      resolve({ statusCode: Number(response.statusCode || 0), data, headers: response.headers });
    });
  });
  request.on("timeout", () => request.destroy(Object.assign(new Error("AI 标签识别响应超时，请稍后重试。"), {
    code: "QWEN_TIMEOUT",
    status: 504
  })));
  request.on("error", reject);
  request.end(options.content);
});

// 千问只给“候选标签”，材质、季节、厚薄等需要由用户在页面上确认后才可正式入库。
const recognizeImage = async (key) => {
  // 未配置当前 Token 单价时直接停用真实调用，避免预算 50 元的估算失真。
  required([
    "DASHSCOPE_API_KEY",
    "QWEN_INPUT_YUAN_PER_MILLION",
    "QWEN_OUTPUT_YUAN_PER_MILLION"
  ]);
  const endpoint = String(process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const model = process.env.QWEN_VL_MODEL || "qwen3-vl-plus";
  const prompt = "你是衣橱应用的衣物标签助手。检查透明背景图是否主要保留一件完整衣物，再生成待用户确认的候选标签。只返回JSON，不要Markdown。字段：valid布尔值；reason中文；name简短中文名称；category仅可为上衣、裤子、半身裙、外套、连衣裙、鞋子；color主色中文；season仅可为春夏、春秋、秋冬、多季；thickness仅可为薄、适中、厚；pattern花纹中文；material视觉推测材质中文；styles最多3个；scenes从休闲、通勤、约会、旅行、聚会、运动中选最多3个；needsConfirmation最多4项。不能有脸、头发、皮肤、肢体、模特或另一件主要衣物。材质、季节和厚薄只能作为候选，不得保证真实成分、尺码或合身。";
  const requestBody = buildQwenRequestBody(signedUrl(key), model);
  requestBody.messages[0].content[1].text = prompt;
  const response = await qwenHttpRequest(
    `${endpoint}/chat/completions`,
    requestBody,
    process.env.DASHSCOPE_API_KEY
  );
  // uniCloud 的 urllib 响应使用 status；部分运行环境或测试替身使用 statusCode，因此两者都要兼容。
  const providerStatusCode = responseStatus(response);
  if (providerStatusCode < 200 || providerStatusCode >= 300) {
    const providerError = response.data?.error || {};
    throw Object.assign(new Error("AI 识别暂时不可用，请稍后再试。"), {
      status: 502,
      code: cleanText(providerError.code, 80) || "QWEN_HTTP_ERROR",
      providerStatusCode,
      providerUsage: response.data?.usage || null
    });
  }
  let raw;
  try {
    raw = parseModelJson(response.data?.choices?.[0]?.message?.content);
  } catch (error) {
    throw Object.assign(new Error("AI 未返回可解析的 JSON 标签。"), {
      status: 502,
      code: "QWEN_INVALID_JSON",
      providerUsage: response.data?.usage || null
    });
  }
  return {
    valid: raw.valid === true,
    reason: cleanText(raw.reason, 120) || "无法确认是否只保留一件衣物",
    tags: {
      name: cleanText(raw.name, 80) || "待确认衣物",
      category: allowedCategories.includes(raw.category) ? raw.category : "",
      color: cleanText(raw.color, 30),
      season: allowedSeasons.includes(raw.season) ? raw.season : "",
      thickness: allowedThicknesses.includes(raw.thickness) ? raw.thickness : "",
      pattern: cleanText(raw.pattern, 30),
      material: cleanText(raw.material, 30),
      styles: sanitizeTags(raw.styles),
      scenes: sanitizeTags(raw.scenes, allowedScenes),
      needsConfirmation: sanitizeTags(raw.needsConfirmation, null, 4)
    },
    usage: response.data?.usage || {},
    provider: "dashscope",
    model: response.data?.model || model
  };
};

module.exports = {
  createUpload,
  deleteObject,
  extractGarment,
  recognizeImage,
  signedUrl,
  sourceHash,
  _test: { buildQwenHttpOptions, buildQwenRequestBody, parseModelJson, responseStatus }
};
