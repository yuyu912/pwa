const LIBRARY_URL = new URL("./vendor/transformers.min.js", self.location.href).href;
const ORT_URL = new URL("./vendor/ort.wasm.min.mjs", self.location.href).href;
const VENDOR_PATH = new URL("./vendor/", self.location.href).href;
const MODEL_PATH = new URL("./models/", self.location.href).href;
const MODELS = {
  matting: new URL("./models/u2netp/onnx/model.onnx", self.location.href).href,
  vision: "mobileclip-s0",
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
let ort;
let remover;
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
      transformers.env.allowRemoteModels = false;
      transformers.env.localModelPath = MODEL_PATH;
      transformers.env.backends.onnx.wasm.wasmPaths = VENDOR_PATH;
      transformers.env.backends.onnx.wasm.numThreads = 1;
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
  if (remover) return;
  if (removerLoading) return removerLoading;
  removerLoading = (async () => {
    send("progress", { text: "正在从本站加载轻量衣物抠图模型…", percent: 2, state: "removing-background" });
    try {
      ort ||= await import(ORT_URL);
      ort.env.wasm.wasmPaths = VENDOR_PATH;
      ort.env.wasm.numThreads = 1;
      remover = await ort.InferenceSession.create(MODELS.matting, { executionProviders: ["wasm"] });
    } catch (error) {
      remover = null;
      throw Object.assign(new Error(error.message || "同域 U-2-Netp 模型加载失败"), { stage: "抠图模型加载" });
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
    const device = "wasm";
    send("progress", { text: "正在从本站加载衣物理解模型…", percent: 45, state: "recognizing" });
    try {
      classifier = await transformers.pipeline("zero-shot-image-classification", MODELS.vision, {
        device,
        dtype: "q8",
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

async function cutoutWithMask(file) {
  if (typeof OffscreenCanvas === "undefined" || typeof ImageData === "undefined") {
    throw new Error("当前浏览器 Worker 不支持透明蒙版合成，请使用最新版 Safari 或 Chrome");
  }
  const bitmap = await createImageBitmap(file);
  const inputSize = 320;
  const scale = Math.min(inputSize / bitmap.width, inputSize / bitmap.height);
  const contentWidth = Math.max(1, Math.round(bitmap.width * scale));
  const contentHeight = Math.max(1, Math.round(bitmap.height * scale));
  const offsetX = Math.floor((inputSize - contentWidth) / 2);
  const offsetY = Math.floor((inputSize - contentHeight) / 2);
  const inputCanvas = new OffscreenCanvas(inputSize, inputSize);
  const inputContext = inputCanvas.getContext("2d", { willReadFrequently: true });
  inputContext.clearRect(0, 0, inputSize, inputSize);
  inputContext.drawImage(bitmap, offsetX, offsetY, contentWidth, contentHeight);
  const inputPixels = inputContext.getImageData(0, 0, inputSize, inputSize).data;
  const input = new Float32Array(3 * inputSize * inputSize);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let index = 0; index < inputSize * inputSize; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      input[channel * inputSize * inputSize + index] = (inputPixels[index * 4 + channel] / 255 - mean[channel]) / std[channel];
    }
  }
  const inputName = remover.inputNames[0];
  const output = await remover.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, inputSize, inputSize]) });
  const mask = output[remover.outputNames[0]] || Object.values(output)[0];
  if (!mask?.data?.length) throw new Error("抠图模型没有返回有效蒙版");
  const maskHeight = mask.dims.at(-2) || inputSize;
  const maskWidth = mask.dims.at(-1) || inputSize;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of mask.data) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const needsSigmoid = minimum < 0 || maximum > 1;
  const maskCanvas = new OffscreenCanvas(maskWidth, maskHeight);
  const maskContext = maskCanvas.getContext("2d");
  const maskFrame = maskContext.createImageData(maskWidth, maskHeight);
  for (let index = 0; index < maskWidth * maskHeight; index += 1) {
    const raw = mask.data[index];
    const probability = needsSigmoid ? 1 / (1 + Math.exp(-raw)) : raw;
    const value = Math.max(0, Math.min(255, Math.round(probability * 255)));
    const offset = index * 4;
    maskFrame.data[offset] = value;
    maskFrame.data[offset + 1] = value;
    maskFrame.data[offset + 2] = value;
    maskFrame.data[offset + 3] = 255;
  }
  maskContext.putImageData(maskFrame, 0, 0);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  const alphaCanvas = new OffscreenCanvas(canvas.width, canvas.height);
  const maskScaleX = maskWidth / inputSize;
  const maskScaleY = maskHeight / inputSize;
  alphaCanvas.getContext("2d").drawImage(
    maskCanvas,
    offsetX * maskScaleX,
    offsetY * maskScaleY,
    contentWidth * maskScaleX,
    contentHeight * maskScaleY,
    0,
    0,
    canvas.width,
    canvas.height,
  );
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
