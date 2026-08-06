"use strict";

const crypto = require("crypto");
const http = require("http");
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

const normalizeOutfitDetections = (raw) => {
  const slots = ["top", "bottom", "dress", "outerwear"];
  const detections = (Array.isArray(raw?.detections) ? raw.detections : [])
    .filter((item) => slots.includes(item.slot) && outfitCategories.includes(item.category) && Array.isArray(item.bbox_2d) && item.bbox_2d.length === 4)
    .slice(0, 4)
    .map((item) => ({
      slot: item.slot,
      category: item.category,
      color: cleanText(item.color, 30),
      pattern: cleanText(item.pattern, 30),
      styles: sanitizeTags(item.styles),
      structure: cleanText(item.structure, 160),
      isComposite: item.is_composite === true,
      bbox: item.bbox_2d.map(Number),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0))
    }));
  const upper = detections.filter((item) => ["top", "outerwear"].includes(item.slot));
  const combined = raw?.upper_body_mode === "combined" || upper.some((item) => item.isComposite);
  if (!combined || upper.length < 1) return detections;
  const anchor = upper.find((item) => item.isComposite) || upper.find((item) => item.slot === "outerwear") || upper[0];
  const bbox = [
    Math.min(...upper.map((item) => item.bbox[0])),
    Math.min(...upper.map((item) => item.bbox[1])),
    Math.max(...upper.map((item) => item.bbox[2])),
    Math.max(...upper.map((item) => item.bbox[3]))
  ];
  const color = cleanText(raw?.upper_body_color, 30)
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
    isComposite: true,
    bbox,
    confidence: Math.max(...upper.map((item) => item.confidence))
  }, ...detections.filter((item) => !["top", "outerwear"].includes(item.slot))];
};

const analyzeOutfit = async (sourceKey, userId, captureId) => {
  required(["DASHSCOPE_API_KEY"]);
  const model = process.env.QWEN_VL_MODEL || "qwen3-vl-flash";
  const requestBody = buildQwenRequestBody(signedUrl(sourceKey, "GET", 600), model);
  requestBody.max_completion_tokens = 700;
  requestBody.messages[0].content[1].text = "识别人物当前实际穿着的核心衣物，只返回 JSON：{upper_body_mode,upper_body_color,upper_body_structure,detections:[{slot,category,color,pattern,styles,structure,is_composite,bbox_2d,confidence}]}。upper_body_mode 仅可为 single、combined、separate：假两件、固定套穿、视觉上依赖内外层共同形成完整款式的上装必须为 combined，并只返回一个 slot=top、category=上衣、is_composite=true 的上身检测，bbox 覆盖内外两层全部可见部分；普通可独立替换的外套和内搭才用 separate。structure 必须用完整中文句子客观写出固定可见结构。上装必须明确袖长是长袖到手腕、七分袖、短袖还是无袖，写清外层与内层各自领口形状，并说明内层领口相对外层领口是几乎平齐、略低还是明显低领，以及内外层覆盖范围、前襟系带和袖型；下装写明腰头宽窄、抽绳内外位置、褶裥、裤腿宽度与垂坠轮廓。禁止只返回‘领口、袖子、腰头、抽绳、裤腿’等字段名。slot 仅允许 top,bottom,dress,outerwear；category 仅允许 上衣,裤子,半身裙,外套,连衣裙；pattern 为纯色、条纹、格纹、印花等简短中文；bbox_2d 为 [x1,y1,x2,y2]，坐标归一化到 0-999。第一版不识别鞋子；忽略首饰、帽子和包；看不清不要猜。";
  const response = await qwenHttpRequest(process.env.DASHSCOPE_VISION_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", requestBody, process.env.DASHSCOPE_API_KEY);
  if (responseStatus(response) < 200 || responseStatus(response) >= 300) throw Object.assign(new Error("今日穿搭定位暂时不可用。"), { status: 502, code: "OUTFIT_DETECTION_FAILED" });
  const raw = parseModelJson(response.data?.choices?.[0]?.message?.content);
  const detections = normalizeOutfitDetections(raw);
  if (!detections.some((item) => ["bottom", "dress"].includes(item.slot))) {
    const lowerBodyRequest = buildQwenRequestBody(signedUrl(sourceKey, "GET", 600), model);
    lowerBodyRequest.max_completion_tokens = 350;
    lowerBodyRequest.messages[0].content[1].text = "只定位人物实际穿着的下装；只返回 JSON：{detections:[{slot,category,color,pattern,styles,structure,is_composite,bbox_2d,confidence}]}。slot 仅允许 bottom 或 dress；category 仅允许 裤子、半身裙、连衣裙。structure 必须是30到120字完整中文句子，明确腰头高低和宽窄、松紧或纽扣、抽绳是否外露及穿出位置、褶裥、裤腿是直筒/阔腿/喇叭及宽松程度、裤脚与垂坠轮廓；禁止只抄‘腰头、抽绳、裤腿’等字段名。bbox_2d 为归一化到 0-999 的 [x1,y1,x2,y2]。不识别鞋子；看不清就返回空 detections，不要猜。";
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

const downloadImage = (url, redirects = 0) => new Promise((resolve, reject) => {
  if (redirects > 3) return reject(new Error("AI 修复图下载重定向过多。"));
  const client = new URL(url).protocol === "http:" ? http : https;
  const request = client.get(url, { timeout: 30000 }, (response) => {
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

const vectorCosine = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
};

const upperGarmentText = (detection) => [detection.structure, ...(detection.styles || [])].filter(Boolean).join(" ");

const usesFaithfulUpperPresentation = (detection) => ["上衣", "外套"].includes(detection.category)
  && (detection.isComposite === true || /露肩|单肩|斜肩|不对称|不规则下摆|薄纱|透视|多层|叠层|假两件|系带|蝙蝠袖/.test(upperGarmentText(detection)));

const usesFaithfulArrangement = (detection) => detection.category === "裤子"
  && /双层|宽腰头|内置抽绳|褶裥|超宽|喇叭|垂坠/.test(detection.structure || "");

const usesFaithfulPresentation = (detection) => usesFaithfulArrangement(detection) || usesFaithfulUpperPresentation(detection);

const usesContrastingUpperBackground = (detection) => ["上衣", "外套"].includes(detection.category)
  && /白|米|奶油|象牙|浅灰/.test(detection.color || "");

const flatLaySize = (detection) => {
  if (["裤子", "半身裙", "连衣裙"].includes(detection.category)) return "768*1536";
  if (usesFaithfulUpperPresentation(detection)) return "1536*1024";
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
  if (qualities.some((quality) => Number(quality.transparentBorderRatio) < 0.98)) return "平铺候选触碰画布边缘或仍有连边背景。";
  return "平铺图边缘抠图未通过质量检查。";
};

const flatLayCategoryRule = (category) => {
  if (category === "裤子") return "目标只能是一条裤子（pants / trousers），必须完整保留腰头到两个裤脚；严禁输出上衣、裙子、鞋或其他品类。";
  if (category === "上衣") return "目标只能是一件上衣（top），必须保持照片中可见的正面领口、肩带或袖型与下摆；严禁输出裤子、裙子、鞋或其他品类。";
  return `目标只能是一件${category}，严禁替换成任何其他服装品类。`;
};

const buildFlatLayRequestBody = (imageUrl, detection, model) => ({
  model,
  input: { messages: [{ role: "user", content: [
    { image: imageUrl },
    { text: `这是严格的单品图像编辑任务，不是自由生成。${detection.isComposite ? "目标是一件固定组合上装或假两件，内层与外层共同构成同一件衣物；必须同时保留两层的颜色、领口、前襟、系带、袖型和原有覆盖关系，不得拆开、删除或替换其中任何一层。内层领口相对外层领口的垂直高度属于固定设计：原图几乎平齐时不得降低成低领、吊带领或大面积露胸。" : flatLayCategoryRule(detection.category)}${usesFaithfulArrangement(detection) ? "这是结构复杂的裤装，采用保真整理而不是标准化重绘：必须原样保留双层或宽腰头、抽绳的内外位置与穿出口、褶裥和超宽垂坠裤腿；只移除人物、鞋和背景，并让左右裤腿自然舒展，严禁改成普通单层松紧腰、外露抽绳、直筒裤或常规运动裤。" : ""}${usesFaithfulUpperPresentation(detection) ? "这是固定剪裁复杂的上装，采用保真整理而不是标准化平铺重绘：必须保持原图中的穿着朝向和完整轮廓，原样保留露肩或单肩开口、不对称或不规则下摆、薄纱透明层、内外层覆盖关系、系带位置和袖型；长袖到手腕必须仍是完整长袖，严禁缩短成七分袖、五分袖或短袖；只移除人物、其他衣物与背景，严禁改成普通圆领、对称下摆或单层上衣。" : ""}只提取照片中正在穿着的${detection.color || ""}${detection.category}。已识别的固定结构为：${detection.structure || "所有结构以原图为准"}。可见特征为${(detection.styles || []).join("、") || "以原图为准"}、${detection.pattern || "图案以原图为准"}。移除人物、皮肤、肢体、背景以及不属于目标单品的其他衣物，${usesFaithfulPresentation(detection) ? "在保留原始朝向、固定结构和廓形的前提下做自然保真整理" : "把同一件目标衣物转换为正面自然平铺展示"}。必须保持原衣物可见的颜色、图案、领口、袖长、肩带或袖型、前襟系带、抽绳与腰头、内外领口相对高度与覆盖范围、裤型、纽扣、口袋、缝线、明显装饰和材质纹理，尤其不能磨平罗纹针织、牛仔水洗、织纹或压线。衣物轮廓应连续自然，边缘平滑干净，不得出现白边、锯齿、破洞或残留皮肤。不要展示背面，不得美化、改款、缩窄、加宽或增加原图不可确认的细节。${flatLayBackgroundRule(detection)}${flatLaySpacingRule(detection)}画面只能保留目标单品。` }
  ] }] },
  parameters: {
    n: flatLayCandidateCount(detection),
    watermark: false,
    prompt_extend: false,
    size: flatLaySize(detection),
    negative_prompt: "人物、模特、皮肤、手臂、手、头发、脸、其他衣物、鞋子、衣架、背景杂物、锯齿边缘、白边、破损、孔洞、模糊纹理、改变领口、改变裤型、改变口袋、增加装饰"
  }
});

const generateFlatLayCandidates = async (sourceKey, detection) => {
  required(["DASHSCOPE_API_KEY", "AI_IMAGE_EDIT_COST_MICROS"]);
  const model = process.env.QWEN_IMAGE_EDIT_MODEL || "qwen-image-2.0-pro";
  const endpoint = process.env.DASHSCOPE_IMAGE_EDIT_URL || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const response = await imageEditHttpRequest(endpoint, buildFlatLayRequestBody(signedUrl(sourceKey, "GET", 600), detection, model), process.env.DASHSCOPE_API_KEY);
  if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(new Error("AI 平铺图生成暂时不可用。"), { status: 502, code: cleanText(response.data?.code, 80) || "FLAT_LAY_HTTP_ERROR" });
  const resultUrls = (response.data?.output?.choices || [])
    .flatMap((choice) => choice?.message?.content || [])
    .map((item) => item?.image)
    .filter(Boolean)
    .slice(0, flatLayCandidateCount(detection));
  if (!resultUrls.length) throw Object.assign(new Error("AI 未返回平铺图。"), { status: 502, code: "FLAT_LAY_NO_OUTPUT" });
  const candidates = [];
  const rejected = [];
  for (const resultUrl of resultUrls) {
    // 每个候选使用独立 UUID，避免二次抠图时互相覆盖。
    const tempKey = `outfit-flat-temp/${crypto.randomUUID()}-flat.png`;
    try {
      await cosCall("putObject", { ...objectOptions(tempKey), Body: await downloadImage(resultUrl), ContentType: "image/png", ACL: "private" });
      const extracted = await extractGarment(tempKey);
      candidates.push({ flatLayKey: extracted.cutoutKey, model });
    } catch (error) {
      rejected.push(error);
    } finally {
      await deleteObject(tempKey).catch(() => {});
    }
  }
  if (!candidates.length) {
    const qualities = rejected.map((error) => error.mattingQuality).filter(Boolean);
    throw Object.assign(new Error(mattingFailureReason(qualities)), { status: 422, code: "FLAT_LAY_MATTING_FAILED" });
  }
  return candidates;
};

const flatLayAccepted = (similarity, verdict, detection = null) => {
  const isComposite = typeof detection === "boolean" ? detection : detection?.isComposite === true;
  const isUpper = typeof detection === "object" && ["上衣", "外套"].includes(detection?.category);
  return Number(similarity) >= 0.4
    && Number(verdict?.fidelityScore) >= 90
    && ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch"].every((key) => verdict?.[key] === true)
    && (!isComposite || verdict?.layersMatch === true)
    && (!isUpper || ["sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch"].every((key) => verdict?.[key] === true));
};

const verifyGeneratedGarment = async (cropKey, generatedKey, detection, imageOrigin) => {
  const embedding = await generateImageEmbeddings([cropKey, generatedKey]);
  const similarity = vectorCosine(embedding.vectors[0], embedding.vectors[1]);
  const model = process.env.QWEN_VL_MODEL || "qwen3-vl-flash";
  const requestBody = buildQwenRequestBody(signedUrl(cropKey, "GET", 600), model);
  requestBody.max_completion_tokens = 350;
  requestBody.messages[0].content.splice(1, 0, { type: "image_url", image_url: { url: signedUrl(generatedKey, "GET", 600) }, max_pixels: 786432 });
  const presentationRule = imageOrigin === "cutout"
    ? "图2应保持图1中目标衣物原有的朝向、穿着姿态、轮廓和可见纹理，只允许移除人物、其他衣物和背景；除被手遮挡的极小区域外，不应重绘或改变细节。仅忽略背景是否透明或纯白。"
    : "忽略人物姿态、背景、平铺方式以及穿着造成的临时褶皱、拉伸和遮挡；不得忽略衣物本身固定的剪裁、纹理和装饰差异。";
  requestBody.messages[0].content[2].text = `图1是真实人物照片中裁出的${detection.category}，图2是系统生成的衣物图。只返回JSON：{sameGarment,colorMatch,patternMatch,shapeMatch,fixedDetailsMatch,layersMatch,sleeveLengthMatch,necklineHeightMatch,layerCoverageMatch,fidelityScore,reason}。fidelityScore为0到100整数，表示图2对图1中目标衣物可见设计的真实性。fixedDetailsMatch只判断衣物固定设计：材质纹理、领口或腰头、袖长、袖型或裤型、纽扣、口袋、缝线和装饰；人物穿着造成且平铺后理应消失的褶皱、拉伸和遮挡不算固定细节差异。上衣必须逐项比较：sleeveLengthMatch 判断长袖到手腕、七分袖、短袖或无袖是否一致，图1长袖而图2露出明显前臂必须为 false；necklineHeightMatch 判断领口形状及垂直高度是否一致，组合上装还要比较内层领口相对外层领口的高度，图1几乎平齐而图2变成明显低领或吊带必须为 false；layerCoverageMatch 判断内外层可见面积、覆盖边界与系带位置是否一致。非上衣的这三项返回 true。任一项为 false 时 fixedDetailsMatch 必须为 false，fidelityScore 不得高于89。${detection.isComposite ? `这是组合上装，固定结构为：${detection.structure || "以图1为准"}。layersMatch 只有在图2同时保留图1的内层和外层、颜色及覆盖关系时才为 true；少一层或把两层融合成普通单件必须为 false。` : "非组合衣物的 layersMatch 返回 true。"}不能因为品类相同就判定一致。${presentationRule}`;
  const endpoint = String(process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const response = await qwenHttpRequest(`${endpoint}/chat/completions`, requestBody, process.env.DASHSCOPE_API_KEY);
  if (responseStatus(response) < 200 || responseStatus(response) >= 300) throw Object.assign(new Error("平铺图细节核验暂时不可用。"), { status: 502, code: "FLAT_LAY_VERIFY_HTTP_ERROR" });
  const verdict = parseModelJson(response.data?.choices?.[0]?.message?.content);
  const semanticKeys = ["sameGarment", "colorMatch", "patternMatch", "shapeMatch", "fixedDetailsMatch"];
  if (["上衣", "外套"].includes(detection.category)) semanticKeys.push("sleeveLengthMatch", "necklineHeightMatch", "layerCoverageMatch");
  const semanticAccepted = semanticKeys.every((key) => verdict[key] === true);
  const score = Math.max(0, Math.min(100, Math.round(Number(verdict.fidelityScore) || 0)));
  return { accepted: flatLayAccepted(similarity, verdict, detection), score, vectorSimilarity: Math.round(similarity * 100), semanticAccepted, reason: cleanText(verdict.reason, 120) };
};

const prepareOutfitDetection = async (detection) => {
  try {
    // Pro 编辑模型优先保持真实纹理并整理成平铺形态，生成后再做透明抠图与严格真实性核验。
    const generated = await generateFlatLayCandidates(detection.cropKey, detection);
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
      .sort((left, right) => right.verification.score - left.verification.score || right.verification.vectorSimilarity - left.verification.vectorSimilarity)[0];
    await Promise.all(evaluated.filter((candidate) => candidate !== selected).map((candidate) => deleteObject(candidate.flatLayKey).catch(() => {})));
    if (selected) return {
      cutoutKey: "", flatLayKey: selected.flatLayKey, selectedImageKey: selected.flatLayKey,
      imageOrigin, fidelityScore: selected.verification.score, fidelityStatus: "accepted",
      processingStatus: "ready", processingError: ""
    };
    const bestRejected = evaluated.sort((left, right) => right.verification.score - left.verification.score)[0];
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: bestRejected?.verification.score || 0, fidelityStatus: "rejected",
      processingStatus: "failed", processingError: `本件未能可靠拆解：${bestRejected?.verification.reason || "平铺图未通过真实性核验"}`
    };
  } catch (error) {
    return {
      cutoutKey: "", flatLayKey: "", selectedImageKey: "",
      imageOrigin: "", fidelityScore: null, fidelityStatus: "unavailable",
      processingStatus: "failed", processingError: `本件未能可靠拆解：${cleanText(error.message, 120) || "平铺处理失败"}`
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
  prepareOutfitDetection,
  recognizeImage,
  removeHanger,
  signedUrl,
  sourceHash,
  _test: { assessMattingQuality, buildFlatLayRequestBody, buildHangerEditRequestBody, buildQwenHttpOptions, buildQwenRequestBody, cropOperation, flatLayAccepted, flatLayCandidateCount, flatLaySize, mattingFailureReason, normalizeOutfitDetections, paddedPixelBox, parseModelJson, responseStatus, usesContrastingUpperBackground, usesFaithfulArrangement, usesFaithfulPresentation, usesFaithfulUpperPresentation, validateCropSize, vectorCosine }
};
