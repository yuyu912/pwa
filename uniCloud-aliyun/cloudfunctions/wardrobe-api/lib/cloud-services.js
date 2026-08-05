"use strict";

const crypto = require("crypto");
const https = require("https");
const COS = require("cos-nodejs-sdk-v5");
const { assessMattingQuality } = require("./png-alpha");

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
  const requestMatting = async (algorithm, timeoutMessage) => {
    const result = await withTimeout(cosRequest({
      ...objectOptions(sourceKey),
      Method: "GET",
      Query: { "ci-process": algorithm },
      RawBody: true
    }), timeoutMessage);
    return Buffer.from(result.Body);
  };
  const checkOutput = (output, providerCallCount) => {
    try {
      return assessMattingQuality(output);
    } catch (error) {
      throw Object.assign(new Error(`抠图结果无法校验：${error.message}`), {
        status: 502,
        code: "MATTING_OUTPUT_INVALID",
        providerCallCount
      });
    }
  };

  let providerCallCount = 0;
  let modelName = "商品抠图";
  try {
    let output = await requestMatting("GoodsMatting", "商品抠图响应超时，请稍后重试。");
    providerCallCount = 1;
    let quality = checkOutput(output, providerCallCount);
    if (!quality.accepted) {
      // 商品模型留下连边背景时，才追加一次通用抠图；正常图片仍只产生一次调用。
      modelName = "通用抠图兜底";
      output = await requestMatting("AIPicMatting", "通用抠图响应超时，请稍后重试。");
      providerCallCount = 2;
      quality = checkOutput(output, providerCallCount);
    }
    if (!quality.accepted) {
      throw Object.assign(new Error("背景去除不完整，请换一张衣物边缘更清楚、四周留有空间的图片。"), {
        status: 422,
        code: "MATTING_QUALITY_LOW",
        providerCallCount
      });
    }
    const cutoutKey = `cutouts/${sourceKey.split("/").pop().replace(/\.[^.]+$/, "")}.png`;
    await cosCall("putObject", {
      ...objectOptions(cutoutKey),
      Body: output,
      ContentType: "image/png",
      ACL: "private"
    });
    return { cutoutKey, modelName, providerCallCount };
  } catch (error) {
    // 只记录已经拿到响应的调用；例如兜底请求失败时，至少保留第一次商品抠图成本。
    if (providerCallCount && !error.providerCallCount) error.providerCallCount = providerCallCount;
    throw error;
  }
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

const embeddingHttpRequest = (url, requestBody, apiKey) => new Promise((resolve, reject) => {
  const content = JSON.stringify(requestBody);
  const request = https.request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(content)
    },
    timeout: 30000
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { message: text.slice(0, 500) }; }
      resolve({ statusCode: Number(response.statusCode || 0), data });
    });
  });
  request.on("timeout", () => request.destroy(Object.assign(new Error("视觉相似分析响应超时。"), {
    code: "EMBEDDING_TIMEOUT",
    status: 504
  })));
  request.on("error", reject);
  request.end(content);
});

// 每张私有衣物图生成独立向量；同一批最多 64 张，减少首次衣橱建索引的网络往返。
const generateImageEmbeddings = async (keys) => {
  required(["DASHSCOPE_API_KEY", "VISION_EMBEDDING_YUAN_PER_THOUSAND"]);
  if (!Array.isArray(keys) || !keys.length || keys.length > 64) {
    throw Object.assign(new Error("视觉向量批次必须包含 1–64 张图片。"), { status: 400, code: "EMBEDDING_BATCH_INVALID" });
  }
  const model = process.env.VISION_EMBEDDING_MODEL || "tongyi-embedding-vision-flash-2026-03-06";
  const dimension = Number(process.env.VISION_EMBEDDING_DIMENSION || 512);
  const endpoint = process.env.DASHSCOPE_EMBEDDING_URL
    || "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
  const response = await embeddingHttpRequest(endpoint, {
    model,
    input: { contents: keys.map((key) => ({ image: signedUrl(key, "GET", 600) })) },
    parameters: { dimension, res_level: 1 }
  }, process.env.DASHSCOPE_API_KEY);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error("视觉相似分析暂时不可用。"), {
      status: 502,
      code: cleanText(response.data?.code, 80) || "EMBEDDING_HTTP_ERROR",
      providerStatusCode: response.statusCode
    });
  }
  const rows = response.data?.output?.embeddings || [];
  if (rows.length !== keys.length || rows.some((row) => !Array.isArray(row.embedding) || row.embedding.length !== dimension)) {
    throw Object.assign(new Error("视觉向量返回数量或维度不正确。"), { status: 502, code: "EMBEDDING_OUTPUT_INVALID" });
  }
  const usage = response.data?.usage || {};
  const inputTokens = Number(usage.input_tokens || usage.total_tokens || 0);
  const yuanPerThousand = Number(process.env.VISION_EMBEDDING_YUAN_PER_THOUSAND);
  return {
    model,
    dimension,
    vectors: rows.sort((a, b) => a.index - b.index).map((row) => row.embedding.map(Number)),
    usage,
    estimatedCostMicros: Math.ceil(inputTokens * yuanPerThousand * 1000),
    requestId: cleanText(response.data?.request_id, 100)
  };
};

const imageEditHttpRequest = (url, requestBody, apiKey) => new Promise((resolve, reject) => {
  const content = JSON.stringify(requestBody);
  const request = https.request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(content)
    },
    timeout: 90000
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { message: text.slice(0, 500) }; }
      resolve({ statusCode: Number(response.statusCode || 0), data });
    });
  });
  request.on("timeout", () => request.destroy(Object.assign(new Error("AI 衣架移除响应超时，原抠图仍可继续使用。"), {
    code: "IMAGE_EDIT_TIMEOUT",
    status: 504
  })));
  request.on("error", reject);
  request.end(content);
});

const downloadImage = (url, redirects = 0) => new Promise((resolve, reject) => {
  if (redirects > 3) return reject(new Error("AI 修复图下载重定向过多。"));
  const request = https.get(url, { timeout: 30000 }, (response) => {
    if ([301, 302, 303, 307, 308].includes(Number(response.statusCode)) && response.headers.location) {
      response.resume();
      downloadImage(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      return;
    }
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
      response.resume();
      reject(new Error("AI 修复图下载失败。"));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) request.destroy(new Error("AI 修复图超过 10MB。"));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
  });
  request.on("timeout", () => request.destroy(new Error("AI 修复图下载超时。")));
  request.on("error", reject);
});

const buildHangerEditRequestBody = (imageUrl, model) => ({
  model,
  input: {
    messages: [{
      role: "user",
      content: [
        { image: imageUrl },
        { text: "只移除衣架，包括挂钩和衣架横臂。仅补全衣架遮挡的少量衣物纹理。保持同一件衣物的版型、领口、肩线、袖型、纽扣数量和位置、下摆、颜色、花纹、材质纹理、褶皱、主体比例与透明背景不变。不要美化、重设计或改变衣架区域以外的任何衣物细节。" }
      ]
    }]
  },
  parameters: { n: 1, watermark: false, prompt_extend: false, size: "1024*1536" }
});

// 用户主动触发后才调用图片编辑；原抠图始终保留，生成图立即转存私有 COS。
const removeHanger = async (sourceKey) => {
  required(["DASHSCOPE_API_KEY", "AI_IMAGE_EDIT_COST_MICROS"]);
  const model = process.env.QWEN_IMAGE_EDIT_MODEL || "qwen-image-2.0";
  const endpoint = process.env.DASHSCOPE_IMAGE_EDIT_URL
    || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const requestBody = buildHangerEditRequestBody(signedUrl(sourceKey, "GET", 600), model);
  const response = await imageEditHttpRequest(endpoint, requestBody, process.env.DASHSCOPE_API_KEY);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error("AI 衣架移除暂时不可用，原抠图仍可继续使用。"), {
      status: 502,
      code: cleanText(response.data?.code, 80) || "IMAGE_EDIT_HTTP_ERROR",
      providerStatusCode: response.statusCode
    });
  }
  const resultUrl = response.data?.output?.choices?.[0]?.message?.content?.find((item) => item.image)?.image;
  if (!resultUrl) throw Object.assign(new Error("AI 未返回衣架移除图片。"), { status: 502, code: "IMAGE_EDIT_NO_OUTPUT" });
  let tempKey = null;
  try {
    const output = await downloadImage(resultUrl);
    const baseName = sourceKey.split("/").pop().replace(/\.[^.]+$/, "");
    const editedKey = `edits/${baseName}-hanger.png`;
    let transparent = false;
    try { transparent = assessMattingQuality(output).accepted; } catch {}
    if (transparent) {
      await cosCall("putObject", { ...objectOptions(editedKey), Body: output, ContentType: "image/png", ACL: "private" });
      return { imageKey: editedKey, model, imageEditCalls: 1, postMattingCalls: 0 };
    }
    tempKey = `edit-temp/${baseName}-hanger-generated.png`;
    await cosCall("putObject", { ...objectOptions(tempKey), Body: output, ContentType: "image/png", ACL: "private" });
    const extraction = await extractGarment(tempKey);
    return {
      imageKey: extraction.cutoutKey,
      model,
      imageEditCalls: 1,
      postMattingCalls: extraction.providerCallCount
    };
  } catch (error) {
    error.imageEditCallCount = 1;
    throw error;
  } finally {
    if (tempKey) await deleteObject(tempKey).catch(() => {});
  }
};

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
  generateImageEmbeddings,
  recognizeImage,
  removeHanger,
  signedUrl,
  sourceHash,
  _test: { assessMattingQuality, buildHangerEditRequestBody, buildQwenHttpOptions, buildQwenRequestBody, parseModelJson, responseStatus }
};
