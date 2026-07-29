const LIBRARY_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm";
const MODELS = { matting: "Xenova/modnet", vision: "Xenova/clip-vit-base-patch32" };
let transformers;
let remover;
let classifier;
let extractor;
let loading;

const send = (type, payload = {}) => postMessage({ type, ...payload });

async function loadModels() {
  if (remover && classifier && extractor) return;
  if (loading) return loading;
  loading = (async () => {
    send("progress", { text: "正在准备本地 AI…", percent: 1 });
    transformers = await import(LIBRARY_URL);
    const device = self.navigator.gpu ? "webgpu" : "wasm";
    const dtype = "q4f16";
    const options = { device, dtype, progress_callback: (item) => {
      if (item.status === "progress" && item.progress != null) send("progress", { text: `正在下载本地模型：${item.file || "组件"}`, percent: Math.round(item.progress) });
    }};
    send("progress", { text: "正在加载本地抠图模型…", percent: 2 });
    remover = await transformers.pipeline("background-removal", MODELS.matting, options);
    send("progress", { text: "正在加载本地衣物理解模型…", percent: 40 });
    classifier = await transformers.pipeline("zero-shot-image-classification", MODELS.vision, options);
    extractor = await transformers.pipeline("image-feature-extraction", MODELS.vision, options);
    send("ready", { device });
  })();
  try { await loading; } finally { loading = null; }
}

function asPngBlob(image) {
  const width = image.width;
  const height = image.height;
  const channels = image.channels || 4;
  const source = image.data;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0, offset = 0; pixel < source.length; pixel += channels, offset += 4) {
    rgba[offset] = source[pixel]; rgba[offset + 1] = source[pixel + Math.min(1, channels - 1)]; rgba[offset + 2] = source[pixel + Math.min(2, channels - 1)]; rgba[offset + 3] = channels > 3 ? source[pixel + 3] : 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function classify(url, labels) {
  const output = await classifier(url, labels);
  return output.filter((item) => item.score >= .14).slice(0, 3).map((item) => item.label);
}

async function recognize(file) {
  await loadModels();
  const url = URL.createObjectURL(file);
  try {
    send("progress", { text: "正在本地抠出衣物主体…", percent: 80 });
    const removed = await remover(url);
    const cutout = await asPngBlob(removed);
    const cutoutUrl = URL.createObjectURL(cutout);
    const [categories, styles, scenes, features] = await Promise.all([
      classify(cutoutUrl, ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"]),
      classify(cutoutUrl, ["简约", "通勤", "休闲", "温柔", "运动", "复古", "街头", "正式"]),
      classify(cutoutUrl, ["日常", "通勤", "约会", "旅行", "聚会", "运动"]),
      extractor(cutoutUrl, { pooling: "mean", normalize: true })
    ]);
    URL.revokeObjectURL(cutoutUrl);
    const embedding = Float32Array.from(features.data || features.tolist?.()[0] || []);
    if (!embedding.length) throw new Error("本地相似度向量未生成。");
    send("result", { cutout, embedding: embedding.buffer, tags: { category: categories[0] || "上衣", styles, scenes } }, [embedding.buffer]);
  } finally { URL.revokeObjectURL(url); }
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "recognize") return;
  try { await recognize(event.data.file); }
  catch (error) { send("error", { message: `本地 AI 未完成：${error.message || "请检查网络与设备性能。"}` }); }
});
