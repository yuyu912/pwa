"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const COS = require("cos-nodejs-sdk-v5");
const { assessMattingQuality } = require("./png-alpha");
const { applyRepairCandidate, assessGarmentContourQuality, buildGarmentCutout, buildOcclusionBoxMask, buildWardrobeDisplayCanvas, imageSizeFromPng, placeMaskOnCanvas } = require("./garment-mask");

let cosClient;
let garmentSegmentationClient;

const OUTFIT_STABILITY_VERSION = "2026-08-06-wardrobe-display-v25";
const DEFAULT_VISION_MODEL = "qwen3-vl-flash-2026-01-22";
const DEFAULT_IMAGE_EDIT_MODEL = "qwen-image-2.0-pro-2026-06-22";
const GARMENT_SEGMENTATION_MODEL = "SegmentCloth";
const GARMENT_CLASSES = ["tops", "coat", "pants", "skirt", "bag", "shoes", "hat"];

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

const cropOperation = (box) => {
  const [x1, y1, x2, y2] = box.map((value) => Math.max(0, Math.round(Number(value) || 0)));
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  return { x: x1, y: y1, width, height, query: `imageMogr2/cut/${width}x${height}x${x1}x${y1}` };
};

const downloadCrop = async (key, box) => {
  const operation = cropOperation(box);
  try {
    // COS Node SDK 的下载时图片处理规则必须通过 QueryString 传入，由 SDK 完成签名和下载。
    const result = await withTimeout(cosCall("getObject", {
      ...objectOptions(key),
      QueryString: operation.query
    }), "单品裁剪响应超时。", 30000);
    return {
      body: Buffer.from(result.Body),
      contentType: result.headers?.["content-type"] || "image/jpeg",
      operation
    };
  } catch (error) {
    const providerStatusCode = Number(error?.statusCode || 0) || undefined;
    throw Object.assign(new Error(providerStatusCode
      ? `腾讯云单品裁剪失败（HTTP ${providerStatusCode}）。`
      : "腾讯云单品裁剪失败。"), {
      status: 502,
      code: "OUTFIT_CROP_DOWNLOAD_FAILED",
      providerStatusCode
    });
  }
};

const paddedPixelBox = (box, size, paddingRatio = 0.05) => {
  const raw = box.map((value, index) => Number(value) * (index % 2 === 0 ? size.width : size.height) / 999);
  const paddingX = Math.max(2, (raw[2] - raw[0]) * paddingRatio);
  const paddingY = Math.max(2, (raw[3] - raw[1]) * paddingRatio);
  return [
    Math.max(0, raw[0] - paddingX), Math.max(0, raw[1] - paddingY),
    Math.min(size.width, raw[2] + paddingX), Math.min(size.height, raw[3] + paddingY)
  ];
};

const validateCropSize = (sourceSize, cropSize, operation) => {
  const widthTolerance = Math.max(3, operation.width * 0.04);
  const heightTolerance = Math.max(3, operation.height * 0.04);
  const sameAsSource = Math.abs(cropSize.width - sourceSize.width) <= 2 && Math.abs(cropSize.height - sourceSize.height) <= 2;
  const expected = Math.abs(cropSize.width - operation.width) <= widthTolerance && Math.abs(cropSize.height - operation.height) <= heightTolerance;
  if (sameAsSource || !expected) throw Object.assign(new Error("单品裁剪未生效，已停止展示完整人物图。"), { status: 502, code: "OUTFIT_CROP_INVALID" });
};

const imageSize = async (key) => {
  const result = await cosRequest({ ...objectOptions(key), Method: "GET", Query: { imageInfo: "" }, RawBody: true });
  const info = JSON.parse(Buffer.from(result.Body).toString("utf8"));
  const width = Number(info.width);
  const height = Number(info.height);
  if (!width || !height) throw Object.assign(new Error("无法读取穿搭照片尺寸。"), { status: 422 });
  return { width, height };
};

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

const createWardrobeDisplay = async (sourceKey) => {
  const display = buildWardrobeDisplayCanvas(await readObject(sourceKey));
  if (display.visiblePixelPreservationScore !== 100) {
    throw Object.assign(new Error("衣橱展示图未能完整保留原始衣物像素。"), { status: 422, code: "WARDROBE_DISPLAY_PIXEL_CHANGED" });
  }
  const quality = assessMattingQuality(display.buffer);
  if (!quality.accepted) {
    throw Object.assign(new Error("衣橱展示图透明边缘未通过质量检查。"), { status: 422, code: "WARDROBE_DISPLAY_ALPHA_QUALITY" });
  }
  const contour = assessGarmentContourQuality(display.buffer);
  if (!contour.accepted) {
    throw Object.assign(new Error(contour.failureReason), { status: 422, code: "WARDROBE_DISPLAY_CONTOUR_QUALITY" });
  }
  const displayKey = `outfit-displays/${crypto.randomUUID()}.png`;
  await cosCall("putObject", { ...objectOptions(displayKey), Body: display.buffer, ContentType: "image/png", ACL: "private" });
  return { displayKey, ...display };
};

const deleteObject = (key) => cosCall("deleteObject", objectOptions(key));
const sourceHash = async (key) => crypto.createHash("sha256").update(await readObject(key)).digest("hex");

const garmentSegmentationConfigured = () => Boolean(
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID && process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
);

const getGarmentSegmentationClient = () => {
  required(["ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"]);
  if (garmentSegmentationClient) return garmentSegmentationClient;
  const ImagesegClient = require("@alicloud/imageseg20191230");
  garmentSegmentationClient = new ImagesegClient.default({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    endpoint: "imageseg.cn-shanghai.aliyuncs.com",
    regionId: "cn-shanghai",
    connectTimeout: 10000,
    readTimeout: 30000
  });
  return garmentSegmentationClient;
};

const clothingClassesForDetection = (detection) => {
  if (detection.category === "裤子") return ["pants"];
  if (detection.category === "半身裙") return ["skirt"];
  if (detection.category === "连衣裙") return ["tops", "skirt"];
  if (detection.category === "外套" || detection.slot === "outerwear") return ["coat"];
  if (detection.isComposite === true || detection.structureFacts?.layerMode === "fixed_combined") return ["tops", "coat"];
  return ["tops"];
};

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
        providerCallCount,
        mattingQuality: quality
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
const outfitCategories = ["上衣", "裤子", "半身裙", "外套", "连衣裙"];
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
  temperature: 0,
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
      resolve({ statusCode: Number(response.statusCode || 0), data, headers: response.headers });
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

const generateUrlEmbeddings = async (urls) => {
  required(["DASHSCOPE_API_KEY", "VISION_EMBEDDING_YUAN_PER_THOUSAND"]);
  if (!Array.isArray(urls) || !urls.length || urls.length > 16) throw Object.assign(new Error("穿搭裁剪数量必须为 1–16 件。"), { status: 400 });
  const model = process.env.VISION_EMBEDDING_MODEL || "tongyi-embedding-vision-flash-2026-03-06";
  const dimension = Number(process.env.VISION_EMBEDDING_DIMENSION || 512);
  const endpoint = process.env.DASHSCOPE_EMBEDDING_URL || "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
  const response = await embeddingHttpRequest(endpoint, { model, input: { contents: urls.map((image) => ({ image })) }, parameters: { dimension, res_level: 1 } }, process.env.DASHSCOPE_API_KEY);
  const rows = response.data?.output?.embeddings || [];
  if (response.statusCode < 200 || response.statusCode >= 300 || rows.length !== urls.length) throw Object.assign(new Error("穿搭裁剪向量生成失败。"), { status: 502, code: "OUTFIT_EMBEDDING_FAILED" });
  return { model, dimension, vectors: rows.sort((a, b) => a.index - b.index).map((row) => row.embedding.map(Number)) };
};

const enumValue = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const canonicalOutfitLabel = (value, kind) => {
  const text = cleanText(value, 30);
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  const mappings = kind === "pattern" ? {
    solid: "纯色", plain: "纯色", striped: "条纹", stripe: "条纹", plaid: "格纹", checked: "格纹",
    floral: "花卉", printed: "印花", print: "印花", leopard: "豹纹", polka_dot: "波点", denim: "牛仔"
  } : {
    white: "白色", off_white: "米白", ivory: "象牙白", cream: "奶油色", beige: "米色",
    light_gray: "浅灰", light_grey: "浅灰", gray: "灰色", grey: "灰色", black: "黑色",
    light_blue: "浅蓝", blue: "蓝色", navy: "藏蓝", brown: "棕色", red: "红色", pink: "粉色",
    purple: "紫色", green: "绿色", yellow: "黄色", orange: "橙色"
  };
  return mappings[key] || text;
};
const normalizeStructureFacts = (value, item = {}) => {
  const facts = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const upper = ["top", "outerwear"].includes(item.slot);
  const lower = ["bottom", "dress"].includes(item.slot);
  const text = `${item.structure || ""} ${(item.styles || []).join(" ")}`;
  return {
    layerMode: upper
      ? enumValue(facts.layer_mode, ["single", "fixed_combined", "separate"], item.is_composite === true || /假两件|固定套穿|多层|叠层/.test(text) ? "fixed_combined" : "single")
      : "not_applicable",
    sleeveLength: upper
      ? enumValue(facts.sleeve_length, ["wrist_long", "three_quarter", "short", "sleeveless"], /长袖|手腕/.test(text) ? "wrist_long" : /七分/.test(text) ? "three_quarter" : /无袖/.test(text) ? "sleeveless" : /短袖/.test(text) ? "short" : "unknown")
      : "not_applicable",
    sleeveShape: cleanText(facts.sleeve_shape, 40),
    outerNeckline: cleanText(facts.outer_neckline, 40),
    innerNeckline: cleanText(facts.inner_neckline, 40),
    necklineRelation: upper
      ? enumValue(facts.neckline_relation, ["flush", "slightly_lower", "clearly_lower", "not_applicable"], /几乎平齐/.test(text) ? "flush" : /略低/.test(text) ? "slightly_lower" : /明显低/.test(text) ? "clearly_lower" : "not_applicable")
      : "not_applicable",
    layerCoverage: cleanText(facts.layer_coverage, 60),
    closureAndTies: cleanText(facts.closure_and_ties, 60),
    transparency: cleanText(facts.transparency, 40),
    hemShape: cleanText(facts.hem_shape, 50),
    riseAndWaistband: lower ? cleanText(facts.rise_and_waistband, 60) : "",
    lowerClosure: lower ? cleanText(facts.lower_closure, 50) : "",
    pleats: lower ? cleanText(facts.pleats, 50) : "",
    legShape: lower ? cleanText(facts.leg_shape, 50) : "",
    pocketLayout: lower ? cleanText(facts.pocket_layout, 60) : "",
    frontSeam: lower ? cleanText(facts.front_seam, 50) : "",
    decorations: cleanText(facts.decorations, 80)
  };
};

const normalizeOutfitDetections = (raw) => {
  const slots = ["top", "bottom", "dress", "outerwear"];
  const normalizeOcclusions = (items) => (Array.isArray(items) ? items : [])
    .filter((item) => item && Array.isArray(item.bbox_2d) && item.bbox_2d.length === 4)
    .slice(0, 8)
    .map((item) => ({
      type: cleanText(item.type, 20),
      bbox: item.bbox_2d.map((value) => Math.max(0, Math.min(999, Number(value) || 0)))
    }))
    .filter((item) => /字幕|文字|头发|手|手臂|皮肤|包|包带|配饰/.test(item.type) && item.bbox[2] > item.bbox[0] && item.bbox[3] > item.bbox[1]);
  const detections = (Array.isArray(raw?.detections) ? raw.detections : [])
    .filter((item) => slots.includes(item.slot) && outfitCategories.includes(item.category) && Array.isArray(item.bbox_2d) && item.bbox_2d.length === 4)
    .slice(0, 4)
    .map((item) => {
      const structureFacts = normalizeStructureFacts(item.structure_facts, item);
      const structure = cleanText(item.structure, 160);
      const explicitFixedCombination = /假两件|固定组合|固定套穿|一体式双层|不可拆分/.test(structure);
      const isComposite = item.is_composite === true
        || structureFacts.layerMode === "fixed_combined"
        || explicitFixedCombination;
      if (isComposite) structureFacts.layerMode = "fixed_combined";
      return {
        slot: item.slot,
        category: item.category,
        color: canonicalOutfitLabel(item.color, "color"),
        pattern: canonicalOutfitLabel(item.pattern, "pattern"),
        styles: sanitizeTags(item.styles),
        structure,
        structureFacts,
        isComposite,
        occlusions: normalizeOcclusions(item.occlusions),
        bbox: item.bbox_2d.map(Number),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0))
      };
    });
  const upper = detections.filter((item) => ["top", "outerwear"].includes(item.slot));
  const combined = raw?.upper_body_mode === "combined"
    || upper.some((item) => item.isComposite || item.structureFacts?.layerMode === "fixed_combined");
  if (!combined || upper.length < 1) return detections;
  const anchor = upper.find((item) => item.isComposite) || upper.find((item) => item.slot === "outerwear") || upper[0];
  const bbox = [
    Math.min(...upper.map((item) => item.bbox[0])),
    Math.min(...upper.map((item) => item.bbox[1])),
    Math.max(...upper.map((item) => item.bbox[2])),
    Math.max(...upper.map((item) => item.bbox[3]))
  ];
  const color = canonicalOutfitLabel(raw?.upper_body_color, "color")
    || [...new Set(upper.map((item) => item.color).filter(Boolean))].join("/");
  const structure = cleanText(raw?.upper_body_structure, 160)
    || upper.map((item) => item.structure).filter(Boolean).join("；");
  const styles = [...new Set(upper.flatMap((item) => item.styles).concat("假两件"))].slice(0, 4);
  return [{
    ...anchor,
    slot: "top",
    category: "上衣",
    color,
    styles,
    structure,
    structureFacts: {
      ...anchor.structureFacts,
      layerMode: "fixed_combined"
    },
    isComposite: true,
    occlusions: upper.flatMap((item) => item.occlusions || []).slice(0, 8),
    bbox,
    confidence: Math.max(...upper.map((item) => item.confidence))
  }, ...detections.filter((item) => !["top", "outerwear"].includes(item.slot))];
};

const analyzeOutfit = async (sourceKey, userId, captureId) => {
  required(["DASHSCOPE_API_KEY"]);
  const model = process.env.QWEN_VL_MODEL || DEFAULT_VISION_MODEL;
  const sourceFingerprint = await sourceHash(sourceKey);
  const requestBody = buildQwenRequestBody(signedUrl(sourceKey, "GET", 600), model);
  requestBody.max_completion_tokens = 900;
  requestBody.messages[0].content[1].text = "识别人物当前实际穿着的核心衣物，只返回 JSON：{upper_body_mode,upper_body_color,upper_body_structure,detections:[{slot,category,color,pattern,styles,structure,structure_facts,is_composite,bbox_2d,occlusions:[{type,bbox_2d}],confidence}]}。upper_body_mode 仅可为 single、combined、separate：假两件、固定套穿、视觉上依赖内外层共同形成完整款式的上装必须为 combined，并只返回一个 slot=top、category=上衣、is_composite=true 的上身检测，bbox 覆盖内外两层全部可见部分；普通可独立替换的外套和内搭才用 separate。structure 必须用完整中文句子客观写出固定可见结构。structure_facts 必须客观填写：上装使用 layer_mode(single/fixed_combined/separate)、sleeve_length(wrist_long/three_quarter/short/sleeveless)、sleeve_shape、outer_neckline、inner_neckline、neckline_relation(flush/slightly_lower/clearly_lower/not_applicable)、layer_coverage、closure_and_ties、transparency、hem_shape、decorations；下装使用 rise_and_waistband、lower_closure、pleats、leg_shape、pocket_layout、front_seam、hem_shape、decorations。occlusions 只记录明确盖住该衣物的字幕/文字、头发、手、手臂、皮肤、包、包带或配饰，每个 bbox_2d 只框遮挡物与该衣物重叠的局部，不要框整件衣物；没有明确遮挡时返回空数组。上装必须明确袖长，写清外层与内层各自领口及相对高度、覆盖范围、前襟系带和袖型；下装写明腰头、纽扣或抽绳、褶裥、口袋、前中缝、裤腿和裤脚。slot 仅允许 top,bottom,dress,outerwear；category 仅允许 上衣,裤子,半身裙,外套,连衣裙；所有 bbox_2d 均归一化到 0-999。不识别鞋子；包只作为遮挡物，不作为衣物；看不清不要猜。";
  requestBody.messages[0].content[1].text += "color、pattern、upper_body_color 必须使用中文。薄纱、半透明或透视上衣下仅为遮挡身体而穿的贴身打底、内衣或肤色层不算第二件核心衣物：upper_body_mode 必须为 single，layer_mode 必须为 single，只在 transparency 中描述透视程度；不得把透过面料看到的身体、裤腰或阴影误写成独立内搭。";
  const response = await qwenHttpRequest(process.env.DASHSCOPE_VISION_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", requestBody, process.env.DASHSCOPE_API_KEY);
  if (responseStatus(response) < 200 || responseStatus(response) >= 300) throw Object.assign(new Error("今日穿搭定位暂时不可用。"), { status: 502, code: "OUTFIT_DETECTION_FAILED" });
  const raw = parseModelJson(response.data?.choices?.[0]?.message?.content);
  const detections = normalizeOutfitDetections(raw);
  if (!detections.some((item) => ["bottom", "dress"].includes(item.slot))) {
    const lowerBodyRequest = buildQwenRequestBody(signedUrl(sourceKey, "GET", 600), model);
    lowerBodyRequest.max_completion_tokens = 350;
    lowerBodyRequest.messages[0].content[1].text = "只定位人物实际穿着的下装；只返回 JSON：{detections:[{slot,category,color,pattern,styles,structure,structure_facts,is_composite,bbox_2d,occlusions:[{type,bbox_2d}],confidence}]}。slot 仅允许 bottom 或 dress；category 仅允许 裤子、半身裙、连衣裙。structure 必须是30到120字完整中文句子；structure_facts 填写 rise_and_waistband、lower_closure、pleats、leg_shape、pocket_layout、front_seam、hem_shape、decorations。occlusions 只记录明确覆盖下装的字幕/文字、手、手臂、皮肤、包或配饰，并只框与下装重叠部分；没有则返回空数组。必须明确腰头、纽扣或抽绳、褶裥、口袋布局、前中缝、裤腿形态和裤脚；看不清的字段留空，不得猜测。所有 bbox_2d 均归一化到 0-999。不识别鞋子。";
    const lowerBodyResponse = await qwenHttpRequest(process.env.DASHSCOPE_VISION_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", lowerBodyRequest, process.env.DASHSCOPE_API_KEY);
    if (responseStatus(lowerBodyResponse) >= 200 && responseStatus(lowerBodyResponse) < 300) {
      const lowerRaw = parseModelJson(lowerBodyResponse.data?.choices?.[0]?.message?.content);
      const lower = normalizeOutfitDetections(lowerRaw).find((item) => ["bottom", "dress"].includes(item.slot));
      if (lower && lower.structure.length < 20) {
        try {
          const detailRequest = buildQwenRequestBody(signedUrl(sourceKey, "GET", 600), model);
          detailRequest.max_completion_tokens = 300;
          detailRequest.messages[0].content[1].text = "只分析图中下装的固定结构，只返回 JSON：{structure,styles}。structure 用40到120字完整中文句子准确描述腰头高低宽窄、抽绳是内置还是外露及穿出位置、褶裥、裤腿宽度和直筒/阔腿/喇叭形态、裤脚及垂坠感。禁止泛泛写‘腰头、抽绳、裤腿’，不得猜测看不见的设计。styles 最多4项。";
          const detailResponse = await qwenHttpRequest(process.env.DASHSCOPE_VISION_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", detailRequest, process.env.DASHSCOPE_API_KEY);
          if (responseStatus(detailResponse) >= 200 && responseStatus(detailResponse) < 300) {
            const detail = parseModelJson(detailResponse.data?.choices?.[0]?.message?.content);
            lower.structure = cleanText(detail.structure, 160) || lower.structure;
            lower.styles = sanitizeTags(detail.styles).length ? sanitizeTags(detail.styles) : lower.styles;
          }
        } catch {}
      }
      if (lower) detections.push(lower);
    }
  }
  if (!detections.length) throw Object.assign(new Error("没有定位到可确认的核心衣物。"), { status: 422, code: "OUTFIT_NOT_FOUND" });
  const size = await imageSize(sourceKey);
  const cropKeys = [];
  try {
    for (let index = 0; index < detections.length; index += 1) {
      const cropKey = `outfit-crops/${userId}/${captureId}-${index}.jpg`;
      const pixelBox = paddedPixelBox(detections[index].bbox, size);
      const cropped = await downloadCrop(sourceKey, pixelBox);
      await cosCall("putObject", { ...objectOptions(cropKey), Body: cropped.body, ContentType: cropped.contentType, ACL: "private" });
      validateCropSize(size, await imageSize(cropKey), cropped.operation);
      cropKeys.push(cropKey);
    }
    return { detections: detections.map((item, index) => ({
      ...item,
      detectionId: `d-${index}`,
      sourceFingerprint,
      cropKey: cropKeys[index],
      cutoutKey: "",
      flatLayKey: "",
      selectedImageKey: "",
      imageOrigin: "",
      fidelityScore: null,
      fidelityStatus: "pending",
      processingStatus: "cropped",
      processingError: ""
    })) };
  } catch (error) {
    await Promise.all(cropKeys.map((key) => deleteObject(key).catch(() => {})));
    throw error;
  }
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

const downloadImage = (url, redirects = 0, maxBytes = 10 * 1024 * 1024) => new Promise((resolve, reject) => {
  if (redirects > 3) return reject(new Error("AI 修复图下载重定向过多。"));
  const client = new URL(url).protocol === "http:" ? http : https;
  const request = client.get(url, { timeout: 30000 }, (response) => {
    if ([301, 302, 303, 307, 308].includes(Number(response.statusCode)) && response.headers.location) {
      response.resume();
      downloadImage(new URL(response.headers.location, url).toString(), redirects + 1, maxBytes).then(resolve, reject);
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
      if (size > maxBytes) request.destroy(new Error("图片处理结果超过安全大小限制。"));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
  });
  request.on("timeout", () => request.destroy(new Error("AI 修复图下载超时。")));
  request.on("error", reject);
});

const segmentationSource = async (sourceKey, userId, captureId) => {
  const [buffer, size] = await Promise.all([readObject(sourceKey), imageSize(sourceKey)]);
  if (buffer.length <= 3 * 1024 * 1024 && size.width < 2000 && size.height < 2000) {
    const pixelSource = await cosCall("getObject", { ...objectOptions(sourceKey), QueryString: "imageMogr2/format/png" });
    return { key: sourceKey, url: signedUrl(sourceKey, "GET", 600), temporaryKey: "", buffer: Buffer.from(pixelSource.Body) };
  }
  const temporaryKey = `outfit-segmentation-input/${userId}/${captureId}.jpg`;
  let thumbnail = "1999x1999>";
  let processed = await cosCall("getObject", {
    ...objectOptions(sourceKey),
    QueryString: `imageMogr2/thumbnail/${thumbnail}/format/jpg/quality/85`
  });
  let body = Buffer.from(processed.Body);
  if (body.length > 3 * 1024 * 1024) {
    thumbnail = "1600x1600>";
    processed = await cosCall("getObject", {
      ...objectOptions(sourceKey),
      QueryString: `imageMogr2/thumbnail/${thumbnail}/format/jpg/quality/70`
    });
    body = Buffer.from(processed.Body);
  }
  if (body.length > 3 * 1024 * 1024) {
    throw Object.assign(new Error("人物照片压缩后仍超过服饰分割限制，请换一张更小的照片。"), { status: 422, code: "GARMENT_SEGMENTATION_INPUT_TOO_LARGE" });
  }
  const pixelSource = await cosCall("getObject", {
    ...objectOptions(sourceKey),
    QueryString: `imageMogr2/thumbnail/${thumbnail}/format/png`
  });
  await cosCall("putObject", { ...objectOptions(temporaryKey), Body: body, ContentType: "image/jpeg", ACL: "private" });
  return { key: temporaryKey, url: signedUrl(temporaryKey, "GET", 600), temporaryKey, buffer: Buffer.from(pixelSource.Body) };
};

// SegmentCloth 的 ClassUrl 在不同 SDK 响应中可能是直接 Map，
// 也可能被包装在 key 字段的一段类别到 URL 文本中。
const normalizeSegmentClothClassUrls = (classUrl) => {
  if (!classUrl || typeof classUrl !== "object") return {};
  const direct = {};
  for (const clothClass of GARMENT_CLASSES) {
    if (typeof classUrl[clothClass] === "string" && /^https?:\/\//i.test(classUrl[clothClass])) {
      direct[clothClass] = classUrl[clothClass];
    }
  }
  if (Object.keys(direct).length || typeof classUrl.key !== "string") return direct;
  const wrapped = classUrl.key.trim();
  for (const clothClass of GARMENT_CLASSES) {
    const nextClasses = GARMENT_CLASSES.filter((value) => value !== clothClass).join("|");
    const match = wrapped.match(new RegExp(`["']?${clothClass}["']?\\s*:\\s*(https?:\\/\\/.+?)(?=\\s*,\\s*["']?(?:${nextClasses})["']?\\s*:|\\s*}$)`, "i"));
    if (match) direct[clothClass] = match[1].trim().replace(/["']$/, "");
  }
  return direct;
};

const segmentOutfitGarments = async (sourceKey, detections, userId, captureId) => {
  if (!garmentSegmentationConfigured()) {
    throw Object.assign(new Error("服饰分割服务尚未配置，请先设置独立 RAM 子账号密钥。"), { status: 503, code: "GARMENT_SEGMENTATION_NOT_CONFIGURED" });
  }
  const classes = [...new Set(detections.flatMap(clothingClassesForDetection))];
  const source = await segmentationSource(sourceKey, userId, captureId);
  const createdKeys = [];
  try {
    const ImagesegClient = require("@alicloud/imageseg20191230");
    const downloadedMasks = [];
    for (const clothClass of classes) {
      const request = new ImagesegClient.SegmentClothRequest({
        imageURL: source.url,
        outMode: 1,
        clothClass: [clothClass],
        returnForm: "mask"
      });
      const response = await withTimeout(
        getGarmentSegmentationClient().segmentClothWithOptions(request, { connectTimeout: 10000, readTimeout: 30000, autoretry: false }),
        "服饰分割响应超时，请稍后重试。",
        35000
      );
      const element = response?.body?.data?.elements?.[0];
      const classUrls = normalizeSegmentClothClassUrls(element?.classUrl);
      const maskUrl = classUrls[clothClass] || element?.imageURL;
      downloadedMasks.push([clothClass, maskUrl ? await downloadImage(maskUrl, 0, 30 * 1024 * 1024) : null]);
    }
    const maskBuffers = new Map(downloadedMasks.filter(([, buffer]) => buffer));
    const sourceSize = imageSizeFromPng(source.buffer);
    const occlusionText = detections.flatMap((item) => item.occlusions || []).map((item) => item.type).join(" ");
    const occluderMasks = new Map();
    if (/头发/.test(occlusionText)) {
      const response = await withTimeout(
        getGarmentSegmentationClient().segmentHairWithOptions(new ImagesegClient.SegmentHairRequest({ imageURL: source.url }), { connectTimeout: 10000, readTimeout: 30000, autoretry: false }),
        "头发遮挡分割响应超时，请稍后重试。",
        35000
      );
      const buffers = [];
      for (const element of response?.body?.data?.elements || []) {
        if (!element?.imageURL) continue;
        buffers.push(placeMaskOnCanvas(await downloadImage(element.imageURL, 0, 30 * 1024 * 1024), sourceSize.width, sourceSize.height, element.x, element.y));
      }
      if (buffers.length) occluderMasks.set("hair", buffers);
    }
    if (/手|手臂|皮肤/.test(occlusionText)) {
      const response = await withTimeout(
        getGarmentSegmentationClient().segmentSkinWithOptions(new ImagesegClient.SegmentSkinRequest({ URL: source.url }), { connectTimeout: 10000, readTimeout: 30000, autoretry: false }),
        "皮肤遮挡分割响应超时，请稍后重试。",
        35000
      );
      const url = response?.body?.data?.URL;
      if (url) occluderMasks.set("skin", [await downloadImage(url, 0, 30 * 1024 * 1024)]);
    }
    const segmented = [];
    const segmentedSize = sourceSize;
    for (let index = 0; index < detections.length; index += 1) {
      const detection = detections[index];
      const requiredClasses = clothingClassesForDetection(detection);
      const missingClasses = requiredClasses.filter((clothClass) => !maskBuffers.has(clothClass));
      if (missingClasses.length) {
        segmented.push({
          ...detection,
          segmentationStatus: "failed",
          segmentationProvider: "aliyun_segment_cloth",
          processingStatus: "failed",
          processingError: "未从人物照片中得到完整的目标衣物蒙版，请补拍单品照片。",
          failureKind: "segmentation_class_missing"
        });
        continue;
      }
      try {
        const detectionOccluderMasks = (detection.occlusions || []).flatMap((item) => {
          if (/头发/.test(item.type)) return occluderMasks.get("hair") || [];
          if (/手|手臂|皮肤/.test(item.type)) return occluderMasks.get("skin") || [];
          return [];
        });
        if ((detection.occlusions || []).some((item) => /字幕|文字|包|包带|配饰/.test(item.type))) {
          detectionOccluderMasks.push(buildOcclusionBoxMask(sourceSize.width, sourceSize.height, detection.occlusions, /字幕|文字|包|包带|配饰/));
        }
        const cutout = buildGarmentCutout(
          source.buffer,
          requiredClasses.map((clothClass) => maskBuffers.get(clothClass)),
          paddedPixelBox(detection.bbox, segmentedSize),
          detection,
          detectionOccluderMasks
        );
        if (cutout.unsafeReason) {
          segmented.push({
            ...detection,
            segmentationStatus: "failed",
            segmentationProvider: "aliyun_segment_cloth",
            visiblePixelPreservationScore: cutout.visiblePixelPreservationScore,
            occlusionRatio: cutout.occlusionRatio,
            repairMode: "rejected",
            referenceRequired: true,
            processingStatus: "failed",
            processingError: `衣物被头发、手臂或配饰遮挡较多：${cutout.unsafeReason} 请补拍单品照片。`,
            failureKind: "segmentation_occlusion_high"
          });
          continue;
        }
        const quality = assessMattingQuality(cutout.buffer);
        if (!quality.accepted) {
          segmented.push({
            ...detection,
            segmentationStatus: "failed",
            segmentationProvider: "aliyun_segment_cloth",
            visiblePixelPreservationScore: cutout.visiblePixelPreservationScore,
            occlusionRatio: cutout.occlusionRatio,
            processingStatus: "failed",
            processingError: "衣物蒙版边缘或透明区域未通过质量检查，请补拍边缘更清楚的单品照片。",
            failureKind: "segmentation_alpha_quality"
          });
          continue;
        }
        const contour = assessGarmentContourQuality(cutout.buffer);
        if (!contour.accepted) {
          segmented.push({
            ...detection,
            segmentationStatus: "failed",
            segmentationProvider: "aliyun_segment_cloth",
            visiblePixelPreservationScore: cutout.visiblePixelPreservationScore,
            occlusionRatio: cutout.occlusionRatio,
            processingStatus: "failed",
            processingError: `${contour.failureReason} 请换用衣物与背景色差更明显的照片，或补拍单品照片。`,
            failureKind: "segmentation_contour_rectangular"
          });
          continue;
        }
        const cutoutKey = `outfit-segmented/${userId}/${captureId}-${index}.png`;
        await cosCall("putObject", { ...objectOptions(cutoutKey), Body: cutout.buffer, ContentType: "image/png", ACL: "private" });
        createdKeys.push(cutoutKey);
        let repairMaskKey = "";
        if (cutout.repairMode === "image_edit_small_internal_hole" && cutout.repairMaskBuffer) {
          repairMaskKey = `outfit-repair-masks/${userId}/${captureId}-${index}.png`;
          await cosCall("putObject", { ...objectOptions(repairMaskKey), Body: cutout.repairMaskBuffer, ContentType: "image/png", ACL: "private" });
          createdKeys.push(repairMaskKey);
        }
        segmented.push({
          ...detection,
          cutoutKey,
          repairMaskKey,
          repairMode: cutout.repairMode,
          referenceRequired: false,
          imageOrigin: "source_garment_mask",
          visiblePixelPreservationScore: cutout.visiblePixelPreservationScore,
          occlusionRatio: cutout.occlusionRatio,
          segmentationStatus: repairMaskKey ? "repair_pending" : "ready",
          segmentationProvider: "aliyun_segment_cloth",
          processingStatus: "cropped",
          processingError: "",
          failureKind: ""
        });
      } catch (error) {
        segmented.push({
          ...detection,
          segmentationStatus: "failed",
          segmentationProvider: "aliyun_segment_cloth",
          processingStatus: "failed",
          processingError: cleanText(error.message, 120) || "衣物蒙版不可用，请补拍单品照片。",
          failureKind: cleanText(error.code, 60) || "segmentation_processing_failed"
        });
      }
    }
    return segmented;
  } catch (error) {
    await Promise.all(createdKeys.map((key) => deleteObject(key).catch(() => {})));
    if (error.status) throw error;
    throw Object.assign(new Error("服饰分割暂时不可用，人物原图将被清理，请稍后重试。"), {
      status: 502,
      code: cleanText(error.code || error.data?.Code, 80) || "GARMENT_SEGMENTATION_FAILED"
    });
  } finally {
    if (source.temporaryKey) await deleteObject(source.temporaryKey).catch(() => {});
  }
};

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

const vectorCosine = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
};

const upperGarmentText = (detection) => [detection.structure, ...(detection.styles || [])].filter(Boolean).join(" ");

const structureFactsText = (detection) => Object.entries(detection.structureFacts || {})
  .filter(([, value]) => value && !["not_applicable", "unknown"].includes(value))
  .map(([key, value]) => `${key}=${value}`)
  .join("；");

const deterministicSeed = (detection, stage = "initial") => {
  const source = [
    detection.sourceFingerprint || "missing-source",
    detection.slot || "unknown-slot",
    detection.category || "unknown-category",
    stage,
    OUTFIT_STABILITY_VERSION
  ].join("|");
  return crypto.createHash("sha256").update(source).digest().readUInt32BE(0) & 0x7fffffff;
};

const usesFaithfulUpperPresentation = (detection) => ["上衣", "外套"].includes(detection.category)
  && (detection.isComposite === true
    || detection.structureFacts?.layerMode === "fixed_combined"
    || /露肩|单肩|斜肩|不对称|不规则下摆|薄纱|透视|多层|叠层|假两件|系带|蝙蝠袖|荷叶边|拼接|蕾丝|镂空|流苏|泡泡袖|灯笼袖|复杂印花/.test(`${upperGarmentText(detection)} ${structureFactsText(detection)}`));

const usesFaithfulArrangement = (detection) => detection.category === "裤子"
  && /双层|宽腰头|内置抽绳|褶裥|超宽|喇叭|垂坠|工装|多口袋|拼接|卷边|前中缝|水洗|破洞|印花/.test(`${detection.structure || ""} ${structureFactsText(detection)}`);

const usesFaithfulPresentation = (detection) => usesFaithfulArrangement(detection) || usesFaithfulUpperPresentation(detection);

const usesContrastingUpperBackground = (detection) => ["上衣", "外套"].includes(detection.category)
  && /白|米|奶油|象牙|浅灰/.test(detection.color || "");

const flatLaySize = (detection) => {
  if (["裤子", "半身裙", "连衣裙"].includes(detection.category)) return "768*1536";
  if (usesFaithfulUpperPresentation(detection)) {
    const wideSleeve = /蝙蝠|和服|宽袖|超宽|横向/.test(`${detection.structure || ""} ${detection.structureFacts?.sleeveShape || ""}`);
    return wideSleeve ? "1536*1024" : "1536*1536";
  }
  return "1024*1024";
};

const flatLayCandidateCount = (detection) => usesFaithfulPresentation(detection)
  ? 3
  : 2;

const flatLayBackgroundRule = (detection) => usesContrastingUpperBackground(detection)
  ? "使用统一中性深灰色（#4B5563）纯色背景，与浅色衣物形成清晰边界；背景不得有渐变、阴影、纹理或其他物体。"
  : "使用纯白色背景，背景不得有渐变、阴影、纹理或其他物体。";

const flatLaySpacingRule = (detection) => (["上衣", "外套"].includes(detection.category)
  && (usesFaithfulUpperPresentation(detection) || usesContrastingUpperBackground(detection)))
  ? "衣物必须完整居中，领口、袖口和下摆距离画布四边至少约12%，不得触碰或裁断任何边缘。"
  : "衣物必须完整居中且不得触碰画布边缘。";

const mattingFailureReason = (qualities) => {
  if (qualities.some((quality) => Number(quality.transparentRatio) < 0.08)) return "平铺候选透明背景面积不足。";
  if (qualities.some((quality) => Number(quality.transparentRatio) > 0.95)) return "平铺候选衣物主体过小或被过度去除。";
  if (qualities.some((quality) => Number(quality.transparentBorderRatio) < 0.98)) return "平铺候选画布边缘仍有不透明像素。";
  return "平铺图边缘抠图未通过质量检查。";
};

const mattingFailureKind = (qualities) => {
  if (!qualities.length) return "matting_output_invalid";
  if (qualities.some((quality) => Number(quality.transparentRatio) < 0.08)) return "matting_transparency_low";
  if (qualities.some((quality) => Number(quality.transparentRatio) > 0.95)) return "matting_subject_too_small";
  if (qualities.some((quality) => Number(quality.transparentBorderRatio) < 0.98)) return "matting_border_opaque";
  return "matting_quality_low";
};

const flatLayCategoryRule = (category) => {
  if (category === "裤子") return "目标只能是一条裤子（pants / trousers），必须完整保留腰头到两个裤脚；严禁输出上衣、裙子、鞋或其他品类。";
  if (category === "上衣") return "目标只能是一件上衣（top），必须保持照片中可见的正面领口、肩带或袖型与下摆；严禁输出裤子、裙子、鞋或其他品类。";
  return `目标只能是一件${category}，严禁替换成任何其他服装品类。`;
};

const flatLayFactRule = (detection) => {
  const facts = detection.structureFacts || {};
  if (["上衣", "外套"].includes(detection.category)) {
    const values = [
      facts.sleeveLength === "wrist_long" ? "袖长必须到手腕" : facts.sleeveLength === "three_quarter" ? "袖长必须为七分袖" : facts.sleeveLength === "short" ? "袖长必须为短袖" : facts.sleeveLength === "sleeveless" ? "必须保持无袖" : "",
      facts.sleeveShape && `袖型：${facts.sleeveShape}`,
      facts.outerNeckline && `外层领口：${facts.outerNeckline}`,
      facts.innerNeckline && `内层领口：${facts.innerNeckline}`,
      facts.necklineRelation === "flush" ? "内外领口几乎平齐" : facts.necklineRelation === "slightly_lower" ? "内层领口仅略低于外层" : facts.necklineRelation === "clearly_lower" ? "内层领口明显低于外层" : "",
      facts.layerCoverage && `层次覆盖：${facts.layerCoverage}`,
      facts.closureAndTies && `开合与系带：${facts.closureAndTies}`,
      facts.transparency && `透明层：${facts.transparency}`,
      facts.hemShape && `下摆：${facts.hemShape}`,
      facts.decorations && `固定装饰：${facts.decorations}`
    ].filter(Boolean);
    return values.length ? `只锁定以下可见上装事实：${values.join("；")}。未识别的细节以原图为准，禁止推测或标准化。` : "所有上装细节以原图为准，禁止推测或标准化。";
  }
  const values = [facts.riseAndWaistband, facts.lowerClosure, facts.pleats, facts.legShape, facts.pocketLayout, facts.frontSeam, facts.hemShape, facts.decorations].filter(Boolean);
  return values.length ? `只锁定以下可见下装事实：${values.join("；")}。未识别的细节以原图为准。` : "所有下装细节以原图为准。";
};

const buildFlatLayRequestBody = (imageUrl, detection, model) => ({
  model,
  input: { messages: [{ role: "user", content: [
    { image: imageUrl },
    { text: `这是严格的单品图像编辑任务，不是自由生成。${detection.isComposite ? "目标是一件固定组合上装或假两件，内外层共同构成同一件衣物；必须同时保留两层及原有覆盖关系，不得拆开、删除或替换，也不得融合。" : flatLayCategoryRule(detection.category)}${usesFaithfulPresentation(detection) ? "采用保真整理：保持原图穿着朝向、固定剪裁、完整轮廓和材质，只移除人物、其他衣物与背景。" : "转换为正面自然平铺展示。"}只提取照片中正在穿着的${detection.color || ""}${detection.category}。${flatLayFactRule(detection)}可见结构描述：${detection.structure || "全部以原图为准"}。颜色、图案、材质纹理和固定装饰必须与原图一致；不得美化、改款、缩窄、加宽、缩短袖长、降低内层领口、融合层次、改变下摆或增加不可确认的细节。边缘必须完整干净，不得有白边、锯齿、破洞、皮肤或头发。${flatLayBackgroundRule(detection)}${flatLaySpacingRule(detection)}画面只能保留目标单品。` }
  ] }] },
  parameters: {
    n: flatLayCandidateCount(detection),
    watermark: false,
    prompt_extend: false,
    size: flatLaySize(detection),
    seed: deterministicSeed(detection, "initial"),
    negative_prompt: "人物、模特、皮肤、手臂、手、头发、脸、其他衣物、鞋子、衣架、背景杂物、锯齿边缘、白边、破损、孔洞、模糊纹理、改变领口、改变袖长、融合层次、改变裤型、改变口袋、增加装饰"
  }
});

const buildOcclusionRepairRequestBody = (cropUrl, cutoutUrl, maskUrl, detection, model, size) => ({
  model,
  input: { messages: [{ role: "user", content: [
    { image: cropUrl },
    { image: cutoutUrl },
    { image: maskUrl },
    { text: `这是严格的衣物局部补全任务，不是整件重绘。图1是真实人物照片中的目标${detection.category}，图2是已经按服饰蒙版提取的原始可见衣物像素，图3是修补蒙版。只允许修改图3白色蒙版覆盖的小孔洞；图3黑色区域、图2全部已有可见像素、透明画布位置和衣物外轮廓必须保持原坐标不变。${flatLayFactRule(detection)}可见结构描述：${detection.structure || "全部以图1和图2为准"}。只延续孔洞四周已经可见的颜色、材质、纹理走向和连续缝线。优先省略而不是发明：不得编造文字、Logo、印花、纽扣、拉链、口袋、五金、标签、装饰或隐藏剪裁。不得改变袖长、袖型、领口高度、内外层覆盖、系带、下摆、腰头、前中缝、裤型和裤脚。不得输出人物、皮肤、手臂、手、头发、脸、包带、其他衣物或背景。输出必须保持与图2完全相同的画布尺寸和对齐位置，只输出补全后的透明衣物图。` }
  ] }] },
  parameters: {
    n: 2,
    watermark: false,
    prompt_extend: false,
    size: `${size.width}*${size.height}`,
    seed: deterministicSeed(detection, "occlusion-repair"),
    negative_prompt: "整件重绘、改变原始像素、改变轮廓、改变袖长、改变领口、融合层次、改变下摆、改变腰头、改变口袋、增加文字、增加印花、增加装饰、人物、皮肤、手、手臂、头发、脸、包带、其他衣物、背景"
  }
});

const buildCorrectiveFlatLayRequestBody = (sourceUrl, rejectedUrl, detection, reason, model) => {
  const requestBody = buildFlatLayRequestBody(sourceUrl, detection, model);
  requestBody.input.messages[0].content = [
    { image: sourceUrl },
    { image: rejectedUrl },
    { text: `图1是真实人物照片中的原始组合上装，图2是上一轮未通过真实性核验的错误整理图。必须继续把全部内外层作为一件组合上装，不得拆成两件。只修正以下已确认差异：${cleanText(reason, 160) || "固定剪裁与层次不一致"}。以图1为唯一真实性依据，图2仅用于定位错误，不得沿用其错误设计。必须恢复长袖到手腕、内外领口原有相对高度、内外层覆盖范围、系带位置、袖型、下摆、颜色和材质纹理；严禁把双层融合成单层、把长袖缩短、把近领内搭改成低领或吊带。${flatLayBackgroundRule(detection)}${flatLaySpacingRule(detection)}只输出修正后的同一件组合上装。` }
  ];
  requestBody.parameters.n = 2;
  requestBody.parameters.seed = deterministicSeed(detection, "correction");
  return requestBody;
};

const generateFlatLayCandidates = async (sourceKey, detection, correction = null) => {
  required(["DASHSCOPE_API_KEY", "AI_IMAGE_EDIT_COST_MICROS"]);
  const model = DEFAULT_IMAGE_EDIT_MODEL;
  const endpoint = process.env.DASHSCOPE_IMAGE_EDIT_URL || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const candidateCount = correction ? 2 : flatLayCandidateCount(detection);
  const sourceUrl = signedUrl(sourceKey, "GET", 600);
  const requestBody = correction
    ? buildCorrectiveFlatLayRequestBody(sourceUrl, signedUrl(correction.seedKey, "GET", 600), detection, correction.reason, model)
    : buildFlatLayRequestBody(sourceUrl, detection, model);
  const response = await imageEditHttpRequest(endpoint, requestBody, process.env.DASHSCOPE_API_KEY);
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error("AI 平铺图生成暂时不可用。"), {
    status: 502,
    code: cleanText(response.data?.code, 80) || "FLAT_LAY_HTTP_ERROR",
    providerStatusCode: response.statusCode,
    retryAfterMs: Math.max(0, Number(response.headers?.["retry-after"] || 0) * 1000)
  });
  const resultUrls = (response.data?.output?.choices || [])
    .flatMap((choice) => choice?.message?.content || [])
    .map((item) => item?.image)
    .filter(Boolean)
    .slice(0, candidateCount);
  if (!resultUrls.length) throw Object.assign(new Error("AI 未返回平铺图。"), { status: 502, code: "FLAT_LAY_NO_OUTPUT" });
  const candidates = [];
  const rejected = [];
  for (let candidateIndex = 0; candidateIndex < resultUrls.length; candidateIndex += 1) {
    const resultUrl = resultUrls[candidateIndex];
    // 每个候选使用独立 UUID，避免二次抠图时互相覆盖。
    const tempKey = `outfit-flat-temp/${crypto.randomUUID()}-flat.png`;
    try {
      await cosCall("putObject", { ...objectOptions(tempKey), Body: await downloadImage(resultUrl), ContentType: "image/png", ACL: "private" });
      const extracted = await extractGarment(tempKey);
      candidates.push({ flatLayKey: extracted.cutoutKey, model, candidateIndex });
    } catch (error) {
      rejected.push(error);
    } finally {
      await deleteObject(tempKey).catch(() => {});
    }
  }
  if (!candidates.length) {
    const qualities = rejected.map((error) => error.mattingQuality).filter(Boolean);
    throw Object.assign(new Error(mattingFailureReason(qualities)), {
      status: 422,
      code: "FLAT_LAY_MATTING_FAILED",
      failureKind: mattingFailureKind(qualities)
    });
  }
  return candidates;
};

const generateOcclusionRepairCandidates = async (detection) => {
  required(["DASHSCOPE_API_KEY", "AI_IMAGE_EDIT_COST_MICROS"]);
  if (!detection.cutoutKey || !detection.repairMaskKey) {
    throw Object.assign(new Error("局部遮挡修补缺少原像素图或修补蒙版。"), { status: 422, code: "GARMENT_REPAIR_INPUT_MISSING" });
  }
  const [originalBuffer, repairMaskBuffer] = await Promise.all([
    readObject(detection.cutoutKey),
    readObject(detection.repairMaskKey)
  ]);
  const size = imageSizeFromPng(originalBuffer);
  const requestBody = buildOcclusionRepairRequestBody(
    signedUrl(detection.cropKey, "GET", 600),
    signedUrl(detection.cutoutKey, "GET", 600),
    signedUrl(detection.repairMaskKey, "GET", 600),
    detection,
    DEFAULT_IMAGE_EDIT_MODEL,
    size
  );
  const endpoint = process.env.DASHSCOPE_IMAGE_EDIT_URL || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const response = await imageEditHttpRequest(endpoint, requestBody, process.env.DASHSCOPE_API_KEY);
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error("衣物局部补全暂时不可用。"), {
    status: 502,
    code: cleanText(response.data?.code, 80) || "GARMENT_REPAIR_HTTP_ERROR",
    providerStatusCode: response.statusCode,
    retryAfterMs: Math.max(0, Number(response.headers?.["retry-after"] || 0) * 1000)
  });
  const resultUrls = (response.data?.output?.choices || [])
    .flatMap((choice) => choice?.message?.content || [])
    .map((item) => item?.image)
    .filter(Boolean)
    .slice(0, 2);
  if (!resultUrls.length) throw Object.assign(new Error("AI 未返回衣物局部补全候选。"), { status: 502, code: "GARMENT_REPAIR_NO_OUTPUT" });
  const candidates = [];
  for (let candidateIndex = 0; candidateIndex < resultUrls.length; candidateIndex += 1) {
    try {
      const repaired = applyRepairCandidate(originalBuffer, await downloadImage(resultUrls[candidateIndex]), repairMaskBuffer);
      if (repaired.visiblePixelPreservationScore !== 100) continue;
      const repairedKey = `outfit-repaired/${crypto.randomUUID()}-${candidateIndex}.png`;
      await cosCall("putObject", { ...objectOptions(repairedKey), Body: repaired.buffer, ContentType: "image/png", ACL: "private" });
      candidates.push({
        cutoutKey: repairedKey,
        candidateIndex,
        visiblePixelPreservationScore: repaired.visiblePixelPreservationScore,
        repairedPixelCount: repaired.repairedPixelCount
      });
    } catch {}
  }
  if (!candidates.length) throw Object.assign(new Error("局部补全候选尺寸或像素保真未通过检查。"), { status: 422, code: "GARMENT_REPAIR_CANDIDATES_INVALID" });
  return candidates;
};

const flatLayAccepted = (similarity, verdict, detection = null) => {
  const isComposite = typeof detection === "boolean" ? detection : detection?.isComposite === true;
  const isUpper = typeof detection === "object" && ["上衣", "外套"].includes(detection?.category);
  const isBottom = typeof detection === "object" && detection?.category === "裤子";
  return Number(similarity) >= 0.4
    && Number(verdict?.fidelityScore) >= 90
    && ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch"].every((key) => verdict?.[key] === true)
    && (!isComposite || verdict?.layersMatch === true)
    && (!isUpper || ["sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch"].every((key) => verdict?.[key] === true))
    && (!isBottom || ["waistbandMatch", "pocketLayoutMatch", "seamMatch", "legShapeMatch", "hemMatch"].every((key) => verdict?.[key] === true));
};

const correctionAvailable = (detection) => detection?.isComposite === true
  && ["上衣", "外套"].includes(detection.category)
  && Boolean(detection.correctionSeedKey)
  && detection.correctionAttempted !== true;

const userFacingVerificationReason = (reason) => cleanText(reason, 160)
  .replaceAll("sameGarment", "同一衣物一致性")
  .replaceAll("colorMatch", "颜色一致性")
  .replaceAll("patternMatch", "图案一致性")
  .replaceAll("shapeMatch", "轮廓一致性")
  .replaceAll("fixedDetailsMatch", "固定细节一致性")
  .replaceAll("noPersonResidue", "无人物残留")
  .replaceAll("clearTransparentContour", "透明轮廓清晰度")
  .replaceAll("visibleStructurePreserved", "可见结构保留")
  .replaceAll("sleeveLengthMatch", "袖长一致性")
  .replaceAll("necklineHeightMatch", "领口高度一致性")
  .replaceAll("layerCoverageMatch", "层次覆盖一致性")
  .replaceAll("layersMatch", "内外层一致性")
  .replaceAll("waistbandMatch", "腰头一致性")
  .replaceAll("pocketLayoutMatch", "口袋布局一致性")
  .replaceAll("seamMatch", "缝线一致性")
  .replaceAll("legShapeMatch", "裤型一致性")
  .replaceAll("hemMatch", "裤脚一致性");

const verifyGeneratedGarment = async (cropKey, generatedKey, detection, imageOrigin) => {
  const embedding = await generateImageEmbeddings([cropKey, generatedKey]);
  const similarity = vectorCosine(embedding.vectors[0], embedding.vectors[1]);
  const model = process.env.QWEN_VL_MODEL || DEFAULT_VISION_MODEL;
  const requestBody = buildQwenRequestBody(signedUrl(cropKey, "GET", 600), model);
  requestBody.max_completion_tokens = 350;
  requestBody.messages[0].content.splice(1, 0, { type: "image_url", image_url: { url: signedUrl(generatedKey, "GET", 600) }, max_pixels: 786432 });
  const presentationRule = imageOrigin === "cutout"
    ? "图2应保持图1中目标衣物原有的朝向、穿着姿态、轮廓和可见纹理，只允许移除人物、其他衣物和背景；除被手遮挡的极小区域外，不应重绘或改变细节。仅忽略背景是否透明或纯白。"
    : "忽略人物姿态、背景、平铺方式以及穿着造成的临时褶皱、拉伸和遮挡；不得忽略衣物本身固定的剪裁、纹理和装饰差异。";
  requestBody.messages[0].content[2].text = `图1是真实人物照片中裁出的${detection.category}，图2是系统生成的衣物图。只返回JSON：{sameGarment,colorMatch,patternMatch,shapeMatch,fixedDetailsMatch,layersMatch,sleeveLengthMatch,necklineHeightMatch,layerCoverageMatch,waistbandMatch,pocketLayoutMatch,seamMatch,legShapeMatch,hemMatch,fidelityScore,reason}。reason只使用自然中文说明具体可见差异，不得输出JSON字段名或英文核验名。规范化固定事实为：${structureFactsText(detection) || "以图1为准"}。fidelityScore为0到100整数，表示图2对图1中目标衣物可见设计的真实性。fixedDetailsMatch只判断衣物固定设计：材质纹理、领口或腰头、袖长、袖型或裤型、纽扣、口袋、缝线和装饰；人物穿着造成且平铺后理应消失的褶皱、拉伸和遮挡不算固定细节差异。上衣必须逐项比较：sleeveLengthMatch 判断袖长，necklineHeightMatch 判断领口形状及相对高度，layerCoverageMatch 判断内外层覆盖边界与系带位置；图1长袖而图2露出明显前臂必须为 false，图1内外领口几乎平齐而图2变成低领或吊带必须为 false。裤子必须逐项比较：waistbandMatch 判断腰头高度宽度及纽扣抽绳，pocketLayoutMatch 判断口袋数量位置轮廓，seamMatch 判断前中缝和固定压线是否连续且位置一致，legShapeMatch 判断直筒阔腿喇叭及宽度，hemMatch 判断卷边和裤脚轮廓。非对应品类的专项字段返回 true。任一适用专项字段为 false 时 fixedDetailsMatch 必须为 false，fidelityScore 不得高于89。${detection.isComposite ? `这是组合上装，固定结构为：${detection.structure || "以图1为准"}。layersMatch 只有在图2同时保留图1的内层和外层、颜色及覆盖关系时才为 true；少一层或把两层融合成普通单件必须为 false。` : "非组合衣物的 layersMatch 返回 true。"}不能因为品类相同就判定一致。${presentationRule}`;
  const endpoint = String(process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const response = await qwenHttpRequest(`${endpoint}/chat/completions`, requestBody, process.env.DASHSCOPE_API_KEY);
  if (responseStatus(response) < 200 || responseStatus(response) >= 300) throw Object.assign(new Error("平铺图细节核验暂时不可用。"), { status: 502, code: "FLAT_LAY_VERIFY_HTTP_ERROR" });
  const verdict = parseModelJson(response.data?.choices?.[0]?.message?.content);
  const semanticKeys = ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch"];
  if (["上衣", "外套"].includes(detection.category)) semanticKeys.push("sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch");
  if (detection.category === "裤子") semanticKeys.push("waistbandMatch", "pocketLayoutMatch", "seamMatch", "legShapeMatch", "hemMatch");
  const semanticAccepted = semanticKeys.every((key) => verdict[key] === true);
  const score = Math.max(0, Math.min(100, Math.round(Number(verdict.fidelityScore) || 0)));
  const failedChecks = semanticKeys.filter((key) => verdict[key] !== true);
  const vectorSimilarity = Math.round(similarity * 100);
  const diagnostic = [
    similarity < 0.4 ? `视觉相似度${vectorSimilarity}%低于40%` : "",
    failedChecks.length ? `未通过：${userFacingVerificationReason(failedChecks.join("、"))}` : ""
  ].filter(Boolean).join("；");
  return {
    accepted: flatLayAccepted(similarity, verdict, detection),
    score,
    vectorSimilarity,
    semanticAccepted,
    failedChecks,
    reason: [diagnostic, userFacingVerificationReason(verdict.reason)].filter(Boolean).join("；")
  };
};

const sourceMaskAccepted = (verdict, detection, preservationScore) => {
  const requiredChecks = ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch", "noPersonResidue", "clearTransparentContour", "visibleStructurePreserved"];
  if (detection.isComposite === true) requiredChecks.push("layersMatch");
  if (["上衣", "外套"].includes(detection.category)) requiredChecks.push("sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch");
  if (detection.category === "裤子") requiredChecks.push("waistbandMatch", "pocketLayoutMatch", "seamMatch", "legShapeMatch", "hemMatch");
  return Number(preservationScore) === 100
    && Number(verdict?.fidelityScore) >= 90
    && requiredChecks.every((key) => verdict?.[key] === true);
};

const verifySourceGarmentCutout = async (detection) => {
  required(["DASHSCOPE_API_KEY"]);
  const model = process.env.QWEN_VL_MODEL || DEFAULT_VISION_MODEL;
  const requestBody = buildQwenRequestBody(signedUrl(detection.cropKey, "GET", 600), model);
  requestBody.max_completion_tokens = 350;
  requestBody.messages[0].content.splice(1, 0, { type: "image_url", image_url: { url: signedUrl(detection.cutoutKey, "GET", 600) }, max_pixels: 786432 });
  requestBody.messages[0].content[2].text = `图1是真实人物照片中裁出的${detection.category}，图2是直接从同一张照片按服饰类别蒙版提取的透明衣物图，不是重新生成的商品图。只返回JSON：{sameGarment,colorMatch,patternMatch,shapeMatch,fixedDetailsMatch,noPersonResidue,clearTransparentContour,visibleStructurePreserved,layersMatch,sleeveLengthMatch,necklineHeightMatch,layerCoverageMatch,waistbandMatch,pocketLayoutMatch,seamMatch,legShapeMatch,hemMatch,fidelityScore,reason}。reason必须只用自然中文，不得输出英文核验字段。重点检查图2是否残留皮肤、手、手臂、头发、脸、包带、背景或其他衣物；有任何人物或配饰残留时 noPersonResidue=false。clearTransparentContour 只有在衣物外边缘完整、背景完全透明，且边缘没有矩形照片块、白底或木纹背景、字幕、鞋、人体及其他物体时才为 true；边缘模糊、粘连背景或无法确认裤腿间隙时必须为 false。规范化固定事实：${structureFactsText(detection) || "以图1可见衣物为准"}。图2允许保持人物穿着时的姿态和自然褶皱，不要求平铺或左右对称；但图1中可见的袖长、领口相对高度、层次、系带、下摆、腰头、口袋、缝线、裤型、裤脚、花纹和固定装饰必须保留。图2出现明显缺口、遮挡残留、轮廓不清或把两个层次错误合并时 visibleStructurePreserved=false，相关专项字段也必须为false，fidelityScore不得高于89。非对应品类的专项字段返回true。`;
  const endpoint = String(process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const response = await qwenHttpRequest(`${endpoint}/chat/completions`, requestBody, process.env.DASHSCOPE_API_KEY);
  if (responseStatus(response) < 200 || responseStatus(response) >= 300) {
    throw Object.assign(new Error("衣物蒙版真实性核验暂时不可用。"), { status: 502, code: "SOURCE_MASK_VERIFY_HTTP_ERROR" });
  }
  const verdict = parseModelJson(response.data?.choices?.[0]?.message?.content);
  const checks = ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch", "noPersonResidue", "clearTransparentContour", "visibleStructurePreserved"];
  if (detection.isComposite === true) checks.push("layersMatch");
  if (["上衣", "外套"].includes(detection.category)) checks.push("sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch");
  if (detection.category === "裤子") checks.push("waistbandMatch", "pocketLayoutMatch", "seamMatch", "legShapeMatch", "hemMatch");
  const failedChecks = checks.filter((key) => verdict[key] !== true);
  const score = Math.max(0, Math.min(100, Math.round(Number(verdict.fidelityScore) || 0)));
  const preservationScore = Number(detection.visiblePixelPreservationScore || 0);
  const diagnostic = [
    preservationScore !== 100 ? `原图可见像素保留率为${preservationScore}%` : "",
    failedChecks.length ? `未通过：${userFacingVerificationReason(failedChecks.join("、"))}` : ""
  ].filter(Boolean).join("；");
  return {
    accepted: sourceMaskAccepted(verdict, detection, preservationScore),
    score,
    failedChecks,
    reason: [diagnostic, userFacingVerificationReason(verdict.reason)].filter(Boolean).join("；")
  };
};

const retryableFlatLayError = (error) => Number(error?.providerStatusCode) === 429
  || ["InternalError.Algo", "ServiceUnavailable"].includes(String(error?.code || ""));

const prepareGeneratedOutfitDetection = async (detection) => {
  const correcting = correctionAvailable(detection);
  try {
    // Pro 编辑模型优先保持真实纹理并整理成平铺形态，生成后再做透明抠图与严格真实性核验。
    const generated = correcting
      ? await generateFlatLayCandidates(detection.cropKey, detection, { seedKey: detection.correctionSeedKey, reason: detection.correctionReason })
      : await generateFlatLayCandidates(detection.cropKey, detection);
    const imageOrigin = usesFaithfulPresentation(detection) ? "cutout" : "flat_lay";
    const evaluated = await Promise.all(generated.map(async (candidate) => {
      try {
        return { ...candidate, verification: await verifyGeneratedGarment(detection.cropKey, candidate.flatLayKey, detection, imageOrigin) };
      } catch (error) {
        return { ...candidate, verification: { accepted: false, score: 0, vectorSimilarity: 0, reason: cleanText(error.message, 120) } };
      }
    }));
    const selected = evaluated
      .filter((candidate) => candidate.verification.accepted)
      .sort((left, right) => right.verification.score - left.verification.score
        || right.verification.vectorSimilarity - left.verification.vectorSimilarity
        || left.candidateIndex - right.candidateIndex)[0];
    if (selected) {
      await Promise.all(evaluated.filter((candidate) => candidate !== selected).map((candidate) => deleteObject(candidate.flatLayKey).catch(() => {})));
      if (correcting) await deleteObject(detection.correctionSeedKey).catch(() => {});
      return {
        cutoutKey: "", flatLayKey: selected.flatLayKey, selectedImageKey: selected.flatLayKey,
        imageOrigin, fidelityScore: selected.verification.score, fidelityStatus: "accepted",
        correctionSeedKey: "", correctionReason: "", correctionAttempted: correcting,
        retryable: false, retryAfterMs: 0, failureKind: "", providerRetryAttempted: false, providerRetryStage: "",
        processingStatus: "ready", processingError: ""
      };
    }
    const bestRejected = evaluated.sort((left, right) => right.verification.score - left.verification.score
      || right.verification.vectorSimilarity - left.verification.vectorSimilarity
      || left.candidateIndex - right.candidateIndex)[0];
    if (!correcting && detection.isComposite === true && ["上衣", "外套"].includes(detection.category) && bestRejected) {
      await Promise.all(evaluated.filter((candidate) => candidate !== bestRejected).map((candidate) => deleteObject(candidate.flatLayKey).catch(() => {})));
      return {
        cutoutKey: "", flatLayKey: "", selectedImageKey: "",
        imageOrigin: "", fidelityScore: bestRejected.verification.score || 0, fidelityStatus: "rejected",
        correctionSeedKey: bestRejected.flatLayKey,
        correctionReason: bestRejected.verification.reason || "固定剪裁与层次不一致",
        correctionAttempted: false,
        retryable: false, retryAfterMs: 0, failureKind: "fidelity_rejected", providerRetryAttempted: false, providerRetryStage: "",
        processingStatus: "failed", processingError: "第一轮未通过真实性核验，准备根据袖长、领口和层次差异再次校正。"
      };
    }
    await Promise.all(evaluated.map((candidate) => deleteObject(candidate.flatLayKey).catch(() => {})));
    if (correcting) await deleteObject(detection.correctionSeedKey).catch(() => {});
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: bestRejected?.verification.score || 0, fidelityStatus: "rejected",
      correctionSeedKey: "", correctionReason: "", correctionAttempted: correcting || detection.correctionAttempted === true,
      retryable: false, retryAfterMs: 0, failureKind: "fidelity_rejected", providerRetryAttempted: false, providerRetryStage: "",
      processingStatus: "failed", processingError: `本件未能可靠拆解：${bestRejected?.verification.reason || "平铺图未通过真实性核验"}`
    };
  } catch (error) {
    const stage = correcting ? "correction" : "initial";
    const retryable = retryableFlatLayError(error)
      && !(detection.providerRetryAttempted === true && detection.providerRetryStage === stage);
    if (retryable) {
      return {
        cutoutKey: "", flatLayKey: "", selectedImageKey: "",
        imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
        correctionSeedKey: correcting ? detection.correctionSeedKey : "",
        correctionReason: correcting ? detection.correctionReason : "",
        correctionAttempted: detection.correctionAttempted === true,
        retryable: true,
        retryAfterMs: Math.max(65000, Number(error.retryAfterMs || 0)),
        failureKind: "provider_busy",
        providerRetryAttempted: true,
        providerRetryStage: stage,
        processingStage: stage,
        processingStatus: "failed",
        processingError: "图片生成服务繁忙，已安排一次自动重试。"
      };
    }
    if (correcting) await deleteObject(detection.correctionSeedKey).catch(() => {});
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
      correctionSeedKey: "", correctionReason: "", correctionAttempted: correcting || detection.correctionAttempted === true,
      retryable: false, retryAfterMs: 0,
      failureKind: retryableFlatLayError(error) ? "provider_error" : cleanText(error.failureKind, 60) || "processing_error",
      providerRetryAttempted: false, providerRetryStage: "",
      processingStatus: "failed", processingError: `本件未能可靠拆解：${cleanText(error.message, 120) || "平铺处理失败"}`
    };
  }
};

const prepareOcclusionRepair = async (detection) => {
  let candidates = [];
  try {
    candidates = await generateOcclusionRepairCandidates(detection);
    const evaluated = await Promise.all(candidates.map(async (candidate) => {
      try {
        const verification = await verifySourceGarmentCutout({
          ...detection,
          cutoutKey: candidate.cutoutKey,
          visiblePixelPreservationScore: candidate.visiblePixelPreservationScore
        });
        return { ...candidate, verification };
      } catch (error) {
        return { ...candidate, verification: { accepted: false, score: 0, reason: cleanText(error.message, 120) } };
      }
    }));
    const selected = evaluated
      .filter((candidate) => candidate.verification.accepted)
      .sort((left, right) => right.verification.score - left.verification.score || left.candidateIndex - right.candidateIndex)[0];
    if (!selected) {
      await Promise.all(evaluated.map((candidate) => deleteObject(candidate.cutoutKey).catch(() => {})));
      await Promise.all([detection.cutoutKey, detection.repairMaskKey].filter(Boolean).map((key) => deleteObject(key).catch(() => {})));
      const bestRejected = evaluated.sort((left, right) => right.verification.score - left.verification.score || left.candidateIndex - right.candidateIndex)[0];
      return {
        cutoutKey: "", repairMaskKey: "", flatLayKey: "", selectedImageKey: "",
        imageOrigin: "", fidelityScore: bestRejected?.verification.score || 0, fidelityStatus: "rejected",
        visiblePixelPreservationScore: 100, occlusionRatio: detection.occlusionRatio,
        segmentationStatus: "rejected", repairMode: "rejected", referenceRequired: true,
        retryable: false, retryAfterMs: 0, failureKind: "repair_quality_failed",
        processingStatus: "failed",
        processingError: `本件小范围遮挡未能可靠补全：${bestRejected?.verification.reason || "候选未通过真实性核验"} 请补充同一件衣服的另一角度或单品照片。`
      };
    }
    const display = await createWardrobeDisplay(selected.cutoutKey);
    await Promise.all(evaluated.filter((candidate) => candidate !== selected).map((candidate) => deleteObject(candidate.cutoutKey).catch(() => {})));
    await Promise.all([detection.cutoutKey, detection.repairMaskKey, selected.cutoutKey].filter(Boolean).map((key) => deleteObject(key).catch(() => {})));
    return {
      cutoutKey: "", repairMaskKey: "", flatLayKey: "", selectedImageKey: display.displayKey,
      imageOrigin: "source_garment_mask_repaired", fidelityScore: selected.verification.score, fidelityStatus: "accepted",
      visiblePixelPreservationScore: selected.visiblePixelPreservationScore, occlusionRatio: detection.occlusionRatio,
      displayMode: display.displayMode, displayPaddingRatio: display.paddingRatio,
      segmentationStatus: "accepted", repairMode: "image_edit_small_internal_hole", referenceRequired: false,
      retryable: false, retryAfterMs: 0, failureKind: "",
      processingStatus: "ready", processingError: ""
    };
  } catch (error) {
    await Promise.all(candidates.map((candidate) => deleteObject(candidate.cutoutKey).catch(() => {})));
    const retryable = retryableFlatLayError(error) && detection.providerRetryAttempted !== true;
    if (retryable) {
      return {
        cutoutKey: detection.cutoutKey, repairMaskKey: detection.repairMaskKey, flatLayKey: "", selectedImageKey: "",
        imageOrigin: "source_garment_mask", fidelityScore: null, fidelityStatus: "unavailable",
        visiblePixelPreservationScore: detection.visiblePixelPreservationScore, occlusionRatio: detection.occlusionRatio,
        segmentationStatus: "repair_pending", repairMode: detection.repairMode, referenceRequired: false,
        retryable: true, retryAfterMs: Math.max(65000, Number(error.retryAfterMs || 0)), failureKind: "provider_busy",
        providerRetryAttempted: true, providerRetryStage: "occlusion_repair",
        processingStatus: "failed", processingError: "局部补全服务繁忙，已安排一次自动重试。"
      };
    }
    await Promise.all([detection.cutoutKey, detection.repairMaskKey].filter(Boolean).map((key) => deleteObject(key).catch(() => {})));
    return {
      cutoutKey: "", repairMaskKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
      visiblePixelPreservationScore: detection.visiblePixelPreservationScore, occlusionRatio: detection.occlusionRatio,
      segmentationStatus: "failed", repairMode: "rejected", referenceRequired: true,
      retryable: false, retryAfterMs: 0,
      failureKind: cleanText(error.code, 60) || "repair_processing_failed",
      processingStatus: "failed",
      processingError: `本件小范围遮挡未能可靠补全：${cleanText(error.message, 120) || "局部补全失败"} 请补充同一件衣服的另一角度或单品照片。`
    };
  }
};

const requiresOutfitImageEdit = (detection) => detection?.segmentationStatus === "repair_pending";

const prepareOutfitDetection = async (detection) => {
  if (detection.segmentationStatus === "repair_pending") return prepareOcclusionRepair(detection);
  if (detection.segmentationStatus !== "ready" || !detection.cutoutKey) {
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
      correctionSeedKey: "", correctionReason: "", correctionAttempted: true,
      retryable: false, retryAfterMs: 0,
      failureKind: detection.failureKind || "segmentation_unavailable",
      processingStatus: "failed",
      processingError: detection.processingError || "本件未能从人物照片中得到可靠衣物蒙版，请补拍单品照片。"
    };
  }
  try {
    const verification = await verifySourceGarmentCutout(detection);
    if (!verification.accepted) {
      await deleteObject(detection.cutoutKey).catch(() => {});
      return {
        cutoutKey: "", flatLayKey: "", selectedImageKey: "",
        imageOrigin: "", fidelityScore: verification.score, fidelityStatus: "rejected",
        correctionSeedKey: "", correctionReason: "", correctionAttempted: true,
        retryable: false, retryAfterMs: 0, failureKind: "source_mask_rejected",
        visiblePixelPreservationScore: detection.visiblePixelPreservationScore,
        occlusionRatio: detection.occlusionRatio,
        segmentationStatus: "rejected",
        processingStatus: "failed",
        processingError: `本件未能可靠拆解：${verification.reason || "衣物蒙版含人物残留或固定结构不完整"}`
      };
    }
    const display = await createWardrobeDisplay(detection.cutoutKey);
    await deleteObject(detection.cutoutKey).catch(() => {});
    return {
      cutoutKey: "",
      flatLayKey: "",
      selectedImageKey: display.displayKey,
      imageOrigin: "source_garment_mask",
      fidelityScore: verification.score,
      fidelityStatus: "accepted",
      visiblePixelPreservationScore: detection.visiblePixelPreservationScore,
      occlusionRatio: detection.occlusionRatio,
      displayMode: display.displayMode,
      displayPaddingRatio: display.paddingRatio,
      segmentationStatus: "accepted",
      correctionSeedKey: "", correctionReason: "", correctionAttempted: true,
      retryable: false, retryAfterMs: 0, failureKind: "",
      processingStatus: "ready", processingError: ""
    };
  } catch (error) {
    await deleteObject(detection.cutoutKey).catch(() => {});
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
      visiblePixelPreservationScore: detection.visiblePixelPreservationScore,
      occlusionRatio: detection.occlusionRatio,
      segmentationStatus: "failed",
      correctionSeedKey: "", correctionReason: "", correctionAttempted: true,
      retryable: false, retryAfterMs: 0,
      failureKind: cleanText(error.code, 60) || "source_mask_verification_failed",
      processingStatus: "failed",
      processingError: `本件未能可靠拆解：${cleanText(error.message, 120) || "衣物蒙版核验失败"}`
    };
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
  analyzeOutfit,
  segmentOutfitGarments,
  prepareOutfitDetection,
  requiresOutfitImageEdit,
  recognizeImage,
  removeHanger,
  signedUrl,
  sourceHash,
  _test: { assessMattingQuality, buildCorrectiveFlatLayRequestBody, buildFlatLayRequestBody, buildHangerEditRequestBody, buildOcclusionRepairRequestBody, buildQwenHttpOptions, buildQwenRequestBody, canonicalOutfitLabel, clothingClassesForDetection, correctionAvailable, cropOperation, deterministicSeed, flatLayAccepted, flatLayCandidateCount, flatLayFactRule, flatLaySize, garmentSegmentationConfigured, mattingFailureKind, mattingFailureReason, normalizeOutfitDetections, normalizeSegmentClothClassUrls, normalizeStructureFacts, paddedPixelBox, parseModelJson, responseStatus, retryableFlatLayError, sourceMaskAccepted, structureFactsText, userFacingVerificationReason, usesContrastingUpperBackground, usesFaithfulArrangement, usesFaithfulPresentation, usesFaithfulUpperPresentation, validateCropSize, vectorCosine }
};
