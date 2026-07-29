const LIBRARY_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const MODELS = {
  matting: "BritishWerewolf/U-2-Netp",
  vision: "Xenova/clip-vit-base-patch32",
};
const LABELS = {
  categories: [
    ["a product photo of a shirt or blouse", "上衣"],
    ["a product photo of trousers or pants", "裤子"],
    ["a product photo of a skirt", "半身裙"],
    ["a product photo of a jacket or coat", "外套"],
    ["a product photo of a shirt dress", "连衣裙"],
    ["a product photo of a dress", "连衣裙"],
    ["a product photo of shoes", "鞋子"],
  ],
  patterns: [
    ["plain solid color clothing without a print", "纯色"],
    ["striped clothing", "条纹"],
    ["plaid clothing", "格纹"],
    ["floral clothing", "碎花"],
    ["polka dot clothing", "波点"],
    ["printed graphic clothing", "印花"],
  ],
  materials: [
    ["cotton fabric clothing", "棉"],
    ["knitted fabric clothing", "针织"],
    ["denim clothing", "牛仔"],
    ["wool clothing", "羊毛"],
    ["linen fabric clothing", "亚麻"],
    ["chiffon fabric clothing", "雪纺"],
    ["leather clothing", "皮革"],
    ["polyester fabric clothing", "涤纶"],
  ],
  seasons: [
    ["lightweight clothing for hot summer weather", "夏季"],
    ["warm thick clothing for cold winter weather", "冬季"],
    ["clothing for mild spring or autumn weather", "春秋"],
    ["clothing suitable for several seasons", "四季"],
  ],
  styles: [
    ["minimalist clothing style", "简约"],
    ["smart office clothing style", "通勤"],
    ["elegant clothing style", "优雅"],
    ["casual clothing style", "休闲"],
    ["soft feminine clothing style", "温柔"],
    ["sportswear clothing style", "运动"],
    ["vintage clothing style", "复古"],
    ["streetwear clothing style", "街头"],
    ["formal clothing style", "正式"],
  ],
  scenes: [
    ["clothing for everyday life", "日常"],
    ["clothing for work or office", "通勤"],
    ["clothing for a date", "约会"],
    ["clothing for travel", "旅行"],
    ["clothing for a party", "聚会"],
    ["clothing for sports", "运动"],
  ],
};

let transformers;
let remover;
let removerProcessor;
let classifier;
let libraryLoading;
let removerLoading;
let classifierLoading;

const send = (type, payload = {}, transfer = []) => postMessage({ type, ...payload }, transfer);

async function loadLibrary() {
  if (transformers) return transformers;
  if (libraryLoading) return libraryLoading;
  libraryLoading = (async () => {
    if (!self.isSecureContext) {
      throw Object.assign(new Error("完整本地 AI 需要 HTTPS，请复制线上链接到 Safari 或 Chrome 打开"), { stage: "运行环境" });
    }
    send("progress", { text: "正在连接本地 AI 资源…", percent: 1, state: "pending" });
    try {
      transformers = await import(LIBRARY_URL);
    } catch (error) {
      throw Object.assign(new Error(error.message || "Transformers.js 资源无法连接"), { stage: "资源连接" });
    }
    return transformers;
  })();
  try {
    return await libraryLoading;
  } finally {
    libraryLoading = null;
  }
}

const modelProgress = (item) => {
      if (item.status === "progress" && item.progress != null) {
        send("progress", {
          text: `正在下载本地模型：${item.file || "组件"}`,
          percent: Math.round(item.progress),
          state: "pending",
        });
      }
};

async function loadRemover() {
  if (remover && removerProcessor) return;
  if (removerLoading) return removerLoading;
  removerLoading = (async () => {
    await loadLibrary();
    send("progress", { text: "正在下载或加载通用衣物抠图模型…", percent: 2, state: "removing-background" });
    try {
      remover = await transformers.AutoModel.from_pretrained(MODELS.matting, {
        device: "wasm",
        dtype: "fp32",
        progress_callback: modelProgress,
      });
      removerProcessor = await transformers.AutoProcessor.from_pretrained(MODELS.matting, { progress_callback: modelProgress });
    } catch (error) {
      remover = null;
      removerProcessor = null;
      throw Object.assign(new Error(error.message || "U-2-Netp 模型加载失败"), { stage: "抠图模型下载" });
    }
  })();
  try {
    await removerLoading;
  } finally {
    removerLoading = null;
  }
}

async function loadClassifier() {
  if (classifier) return;
  if (classifierLoading) return classifierLoading;
  classifierLoading = (async () => {
    await loadLibrary();
    const device = self.navigator.gpu ? "webgpu" : "wasm";
    send("progress", { text: "正在下载或加载衣物理解模型…", percent: 45, state: "recognizing" });
    try {
      classifier = await transformers.pipeline("zero-shot-image-classification", MODELS.vision, {
        device,
        dtype: device === "webgpu" ? "q4f16" : "q8",
        progress_callback: modelProgress,
      });
    } catch (error) {
      classifier = null;
      throw Object.assign(new Error(error.message || "CLIP 模型加载失败"), { stage: "模型下载" });
    }
    send("ready", { device });
  })();
  try {
    await classifierLoading;
  } finally {
    classifierLoading = null;
  }
}

async function cutoutWithMask(file, sourceUrl) {
  if (typeof OffscreenCanvas === "undefined" || typeof ImageData === "undefined") {
    throw new Error("当前浏览器 Worker 不支持透明蒙版合成，请使用最新版 Safari 或 Chrome");
  }
  const image = await transformers.RawImage.fromURL(sourceUrl);
  const processed = await removerProcessor(image);
  const output = await remover({ input: processed.pixel_values });
  const mask = output.mask || Object.values(output)[0];
  if (!mask?.data?.length || !Array.isArray(mask.dims)) throw new Error("抠图模型没有返回有效蒙版");
  const maskHeight = mask.dims.at(-2);
  const maskWidth = mask.dims.at(-1);
  const maskCanvas = new OffscreenCanvas(maskWidth, maskHeight);
  const maskContext = maskCanvas.getContext("2d");
  const maskFrame = maskContext.createImageData(maskWidth, maskHeight);
  for (let index = 0; index < maskWidth * maskHeight; index += 1) {
    const value = mask.data[index];
    const offset = index * 4;
    maskFrame.data[offset] = value;
    maskFrame.data[offset + 1] = value;
    maskFrame.data[offset + 2] = value;
    maskFrame.data[offset + 3] = 255;
  }
  maskContext.putImageData(maskFrame, 0, 0);
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const scale = Math.min(maskWidth / canvas.width, maskHeight / canvas.height);
  const contentWidth = Math.max(1, Math.round(canvas.width * scale));
  const contentHeight = Math.max(1, Math.round(canvas.height * scale));
  const cropX = Math.max(0, Math.floor((maskWidth - contentWidth) / 2));
  const cropY = Math.max(0, Math.floor((maskHeight - contentHeight) / 2));
  const alphaCanvas = new OffscreenCanvas(canvas.width, canvas.height);
  alphaCanvas.getContext("2d").drawImage(maskCanvas, cropX, cropY, contentWidth, contentHeight, 0, 0, canvas.width, canvas.height);
  const alpha = alphaCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 0; index < canvas.width * canvas.height; index += 1) {
    const matte = alpha[index * 4];
    frame.data[index * 4 + 3] = Math.round(frame.data[index * 4 + 3] * matte / 255);
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.putImageData(frame, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function classifyGroup(url, choices, field) {
  const output = await classifier(url, choices.map(([prompt]) => prompt));
  const byPrompt = new Map(output.map((item) => [item.label, Number(item.score || 0)]));
  const ranked = choices
    .map(([prompt, label]) => ({ label, score: byPrompt.get(prompt) || 0 }))
    .sort((left, right) => right.score - left.score);
  const top = ranked[0] || { label: "", score: 0 };
  const margin = top.score - (ranked[1]?.score || 0);
  const confidence = field === "materials" ? "low" : top.score >= 0.35 && margin >= 0.08 ? "high" : "low";
  return {
    value: top.label,
    candidates: ranked.slice(0, 3),
    confidence,
    scores: choices.map(([prompt]) => byPrompt.get(prompt) || 0),
  };
}

function normalizeVector(values) {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Float32Array.from(values, (value) => value / length);
}

async function recognize(file) {
  const sourceUrl = URL.createObjectURL(file);
  let cutoutUrl = "";
  try {
    await loadLibrary();
    send("progress", { text: "正在完整抠出衣物主体…", percent: 72, state: "removing-background" });
    let cutout = file;
    let cutoutState = "pending";
    let cutoutError = "";
    try {
      await loadRemover();
      cutout = await cutoutWithMask(file, sourceUrl);
      cutoutState = "ready";
    } catch (error) {
      cutoutError = error.message || "本地抠图失败";
    }
    cutoutUrl = cutoutState === "ready" ? URL.createObjectURL(cutout) : sourceUrl;
    send("progress", { text: "正在识别品类、花纹、材质、季节、风格与场景…", percent: 84, state: "recognizing" });
    let grouped;
    try {
      await loadClassifier();
      grouped = {};
      for (const [field, choices] of Object.entries(LABELS)) {
        grouped[field] = await classifyGroup(cutoutUrl, choices, field);
      }
    } catch (error) {
      send("result", {
        cutout,
        embedding: new ArrayBuffer(0),
        recognitionMode: "ai-partial",
        embeddingState: "unavailable",
        cutoutState,
        cutoutError,
        recognitionError: `标签识别失败：${error.message || "CLIP 模型未完成"}`,
        recognitionCandidates: {},
        recognitionConfidence: {},
        tags: { category: "", pattern: "", material: "", season: "", styles: [], scenes: [] },
      });
      return;
    }
    const embedding = normalizeVector(Object.keys(LABELS).flatMap((field) => grouped[field].scores));
    const tags = {
      category: grouped.categories.value,
      pattern: grouped.patterns.value,
      material: grouped.materials.value,
      season: grouped.seasons.value,
      styles: grouped.styles.candidates.slice(0, 2).map(({ label }) => label),
      scenes: grouped.scenes.candidates.slice(0, 2).map(({ label }) => label),
    };
    const recognitionCandidates = Object.fromEntries(Object.entries(grouped).map(([field, result]) => [field, result.candidates]));
    const recognitionConfidence = Object.fromEntries(Object.entries(grouped).map(([field, result]) => [field, result.confidence]));
    send("progress", { text: "正在完成本地识别结果…", percent: 98, state: "ready" });
    send("result", {
      cutout,
      embedding: embedding.buffer,
      recognitionMode: "ai",
      embeddingState: "ready",
      cutoutState,
      cutoutError,
      recognitionCandidates,
      recognitionConfidence,
      tags,
    }, [embedding.buffer]);
  } finally {
    if (cutoutUrl) URL.revokeObjectURL(cutoutUrl);
    URL.revokeObjectURL(sourceUrl);
  }
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "recognize") return;
  send("progress", { text: "本地 AI Worker 已启动…", percent: 0, state: "pending" });
  try {
    await recognize(event.data.file);
  } catch (error) {
    send("error", {
      stage: error.stage || "Worker运行",
      message: `${error.stage || "Worker运行"}失败：${error.message || "请检查网络与设备性能。"}`,
    });
  }
});
