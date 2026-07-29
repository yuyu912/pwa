import { buildOutfitRecommendation, weatherKind, weatherLabels } from "./weather-rules.js?v=1";
import { buildPurchaseAnalysis } from "./analysis-rules.js?v=2";
import { createLocalId, createManualFallbackDraft, fingerprintFile, hasValidEmbedding, normalizeRecognitionState, timedFetch } from "./runtime-utils.js?v=3";
import { regionPath, regionToLocation, searchRegions } from "./region-search.js?v=1";
import { analyzeRgbaPixels } from "./image-analysis-utils.js?v=1";

const $ = (selector) => document.querySelector(selector);
const dbName = "wardrobe-local-v1";
const DB_VERSION = 2;
const WEATHER_LOCATION_KEY = "wardrobe-weather-location-v1";
const WEATHER_CACHE_KEY = "wardrobe-weather-cache-v1";
const WEATHER_CACHE_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MODEL_IDLE_TIMEOUT_MS = 90000;
const AI_PREFLIGHT_URLS = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js",
  "https://huggingface.co/BritishWerewolf/U-2-Netp/resolve/main/config.json",
  "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/config.json",
];
let database;
let draft;
let editingItem;
let batchQueue = [];
let batchTotal = 0;
let batchSaved = 0;
let batchFailedFile = null;
let selectedLocation = null;
let weatherSnapshot = null;
let analysisCandidate = null;
let currentAnalysis = null;
let aiPreflight = null;
let regionDataPromise = null;
let modelState = "模型尚未下载。首次识别将在 Wi-Fi 下下载本地模型。";

const message = (text, error = false) => { const target = $("#app-message"); target.textContent = text; target.classList.toggle("error", error); };
const splitTags = (value) => String(value || "").split(/[，,]/).map((item) => item.trim()).filter(Boolean).slice(0, 4);
const id = () => createLocalId();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const tx = (store, mode = "readonly") => database.transaction(store, mode).objectStore(store);
const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const getAll = (store) => request(tx(store).getAll());
const put = (store, value) => request(tx(store, "readwrite").put(value));
const clear = (store) => request(tx(store, "readwrite").clear());
const blobUrl = (blob) => URL.createObjectURL(blob);
const hashFile = (file) => fingerprintFile(file);
const fetchWithTimeout = (url, options = {}, timeout = REQUEST_TIMEOUT_MS) => timedFetch(url, options, timeout);
const normalizeItem = (item) => ({
  ...item,
  ...normalizeRecognitionState(item),
  color: item.color || "",
  season: item.season || "四季",
  pattern: item.pattern || "",
  material: item.material || "",
  brand: item.brand || "",
  purchaseDate: item.purchaseDate || "",
  purchaseChannel: item.purchaseChannel || "",
  styles: Array.isArray(item.styles) ? item.styles : [],
  scenes: Array.isArray(item.scenes) ? item.scenes : [],
  customTags: Array.isArray(item.customTags) ? item.customTags : [],
  wearCount: Number(item.wearCount || 0),
});

async function openDatabase() {
  database = await new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("items")) open.result.createObjectStore("items", { keyPath: "id" });
      if (!open.result.objectStoreNames.contains("wearLogs")) open.result.createObjectStore("wearLogs", { keyPath: "id" });
      if (!open.result.objectStoreNames.contains("analysisRecords")) open.result.createObjectStore("analysisRecords", { keyPath: "id" });
    };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
}

function deleteItemAndLogs(itemId) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["items", "wearLogs"], "readwrite");
    transaction.objectStore("items").delete(itemId);
    const cursorRequest = transaction.objectStore("wearLogs").openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (cursor.value.itemId === itemId) cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function analyzeCutout(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 180 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return analyzeRgbaPixels(pixels, canvas.width, canvas.height);
}

async function safeAnalyzeCutout(blob) {
  try {
    return await analyzeCutout(blob);
  } catch {
    return { color: "", quality: { valid: false } };
  }
}

let worker;
function createAiWorker() {
  worker = new Worker("./local-ai-worker.js?v=7", { type: "module" });
  return worker;
}
createAiWorker();
async function ensureAiResourcesReachable() {
  if (aiPreflight) return aiPreflight;
  aiPreflight = (async () => {
    message("正在检查本地 AI 模型资源连接…");
    for (const url of AI_PREFLIGHT_URLS) {
      const response = await timedFetch(url, { cache: "force-cache" }, 15000);
      if (!response.ok) throw new Error(`模型资源返回 ${response.status}`);
      await response.arrayBuffer();
    }
  })();
  try {
    await aiPreflight;
  } catch (error) {
    aiPreflight = null;
    throw new Error(`微信无法连接本地 AI 模型资源：${error.message || "网络超时"}。请复制链接到 Safari 重试。`);
  }
}
const recognize = async (file) => {
  if (!globalThis.isSecureContext) {
    const error = new Error("完整本地 AI 抠图需要 HTTPS。当前图片已保留，请复制线上链接到 Safari 或 Chrome 后重试。");
    error.stage = "运行环境";
    throw error;
  }
  await ensureAiResourcesReachable();
  return new Promise((resolve, reject) => {
  let timer;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cleanup();
      worker.terminate();
      createAiWorker();
      const error = new Error("模型下载或本地推理连续 90 秒没有进度，请稍后重试。图片仍保留为待抠图。");
      error.stage = "模型超时";
      reject(error);
    }, MODEL_IDLE_TIMEOUT_MS);
  };
  const cleanup = () => {
    clearTimeout(timer);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
  };
  const onMessage = (event) => {
    const data = event.data;
    resetTimer();
    if (data.type === "progress") { modelState = data.text; $("#model-status").textContent = modelState; message(`${data.text}${data.percent != null ? ` ${data.percent}%` : ""}`); }
    if (data.type === "ready") { modelState = `本地模型已就绪（${data.device === "webgpu" ? "WebGPU" : "WASM"}）。`; $("#model-status").textContent = modelState; }
    if (data.type === "result") { cleanup(); resolve(data); }
    if (data.type === "error") {
      cleanup();
      const error = new Error(data.message);
      error.stage = data.stage || "Worker运行";
      reject(error);
    }
  };
  const onError = () => { cleanup(); reject(new Error("Worker启动失败：当前浏览器无法运行本地 AI，可转手动确认。")); };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  resetTimer();
  worker.postMessage({ type: "recognize", file });
  });
};

function switchPage(name) {
  const navName = name === "add" ? "closet" : name;
  document.querySelectorAll(".bottom-nav [data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === navName));
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `${name}-page`));
  window.scrollTo({ top: 0, behavior: "smooth" });
  message("");
}
function cosine(left, right) { const a = new Float32Array(left), b = new Float32Array(right); let dot = 0, aa = 0, bb = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }

async function renderCloset() {
  const allItems = (await getAll("items")).map(normalizeItem);
  const search = $("#closet-search").value.trim().toLowerCase();
  const category = $("#closet-category").value;
  const color = $("#closet-color").value;
  const season = $("#closet-season").value;
  const scene = $("#closet-scene").value;
  const sort = $("#closet-sort").value;
  const view = $("#closet-view").value;
  const lastWornAt = new Map();
  (await getAll("wearLogs")).forEach((log) => lastWornAt.set(log.itemId, Math.max(lastWornAt.get(log.itemId) || 0, Number(log.wornAt || 0))));
  const items = allItems.filter((item) => {
    const searchable = [item.name, item.category, item.color, item.season, item.pattern, item.material, item.brand, item.purchaseChannel, ...item.styles, ...item.scenes, ...item.customTags].join(" ").toLowerCase();
    return (!search || searchable.includes(search))
      && (!category || item.category === category)
      && (!color || item.color.startsWith(color))
      && (!season || item.season === season)
      && (!scene || item.scenes.includes(scene));
  }).sort((a, b) => {
    if (sort === "frequency") return b.wearCount - a.wearCount;
    if (sort === "worn") return (lastWornAt.get(b.id) || 0) - (lastWornAt.get(a.id) || 0);
    if (sort === "name") return String(a.name).localeCompare(String(b.name), "zh-CN");
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
  $("#item-count").textContent = `${allItems.length} 件`;
  $("#home-item-count").textContent = allItems.length;
  const remaining = Math.max(0, 5 - allItems.length);
  $("#home-progress-hint").innerHTML = remaining ? `再添 <strong id="home-more-count">${remaining}</strong> 件分析更完整` : "新衣分析已解锁";
  $("#filter-result").textContent = items.length === allItems.length ? "" : `当前显示 ${items.length} / ${allItems.length} 件`;
  $("#item-detail").hidden = true;
  const list = $("#item-list");
  list.replaceChildren();
  list.classList.toggle("grouped-view", view === "grouped");
  if (!allItems.length) { list.innerHTML = '<div class="empty"><strong>从第一件真实衣物开始</strong><p>照片和记录只会留在这台设备。录入 5 件后，新衣分析会更有参考价值。</p></div>'; if (weatherSnapshot) await renderWeatherRecommendation(); return; }
  if (!items.length) { list.innerHTML = '<div class="empty"><strong>没有找到符合条件的衣物</strong><p>可以修改搜索词或清除筛选条件。</p></div>'; if (weatherSnapshot) await renderWeatherRecommendation(); return; }
  if (view === "grouped") {
    const categories = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
    categories.forEach((groupName) => {
      const groupItems = items.filter((item) => item.category === groupName);
      if (!groupItems.length) return;
      const group = document.createElement("section");
      group.className = "closet-group";
      const heading = document.createElement("h2");
      heading.textContent = `${groupName} · ${groupItems.length} 件`;
      const cards = document.createElement("div");
      cards.className = "closet-group-cards";
      groupItems.forEach((item) => cards.append(createItemCard(item)));
      group.append(heading, cards);
      list.append(group);
    });
  } else {
    items.forEach((item) => list.append(createItemCard(item)));
  }
  if (weatherSnapshot) await renderWeatherRecommendation();
}

function createItemCard(item) {
  const card = document.createElement("article");
  card.className = "item-card";
  const image = document.createElement("img");
  image.src = blobUrl(item.cutout);
  image.alt = item.name;
  const body = document.createElement("div");
  body.innerHTML = `<strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.category)} · ${escapeHtml(item.season)} · ${escapeHtml(item.color || "未填写颜色")}</p><p>${escapeHtml(item.scenes.join("、") || "未填写场景")} · 已穿 ${item.wearCount} 次</p><button class="text-button" type="button">记录今天穿了</button>`;
  body.querySelector("button").addEventListener("click", async (event) => {
    event.stopPropagation();
    item.wearCount += 1;
    await put("items", item);
    await put("wearLogs", { id: id(), itemId: item.id, wornAt: Date.now(), scene: "日常" });
    await renderCloset();
    message("已记录今天穿了。");
  });
  card.append(image, body);
  card.addEventListener("click", () => showDetail(item));
  return card;
}

function openItemEditor(item) {
  editingItem = normalizeItem(item);
  const form = $("#item-edit-form");
  form.elements.name.value = editingItem.name;
  form.elements.category.value = editingItem.category;
  form.elements.color.value = editingItem.color || "";
  form.elements.season.value = editingItem.season;
  form.elements.pattern.value = editingItem.pattern;
  form.elements.material.value = editingItem.material;
  form.elements.styles.value = editingItem.styles.join("，");
  form.elements.scenes.value = editingItem.scenes.join("，");
  form.elements.brand.value = editingItem.brand;
  form.elements.purchaseDate.value = editingItem.purchaseDate;
  form.elements.purchaseChannel.value = editingItem.purchaseChannel;
  form.elements.customTags.value = editingItem.customTags.join("，");
  form.elements.price.value = editingItem.price ?? "";
  $("#item-edit-dialog").showModal();
}

function showDetail(item) {
  const detail = $("#item-detail");
  detail.innerHTML = "";
  const back = document.createElement("button");
  back.className = "text-button";
  back.textContent = "返回衣橱";
  back.onclick = () => { detail.hidden = true; };
  const image = document.createElement("img");
  image.src = blobUrl(item.cutout);
  image.alt = item.name;
  const copy = document.createElement("div");
  copy.innerHTML = `<p class="eyebrow">本地衣物详情</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)} · ${escapeHtml(item.season)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</p><p>花纹：${escapeHtml(item.pattern || "未填写")} · 材质：${escapeHtml(item.material || "未填写")}</p><p>风格：${escapeHtml(item.styles.join("、") || "未填写")}</p><p>场景：${escapeHtml(item.scenes.join("、") || "未填写")}</p><p>品牌：${escapeHtml(item.brand || "未填写")} · 购买日期：${escapeHtml(item.purchaseDate || "未填写")}</p><p>购买渠道：${escapeHtml(item.purchaseChannel || "未填写")}</p><p>自定义标签：${escapeHtml(item.customTags.join("、") || "未填写")}</p><p>价格：${item.price == null ? "未填写" : `¥${escapeHtml(item.price)}`}</p><p>已穿 ${item.wearCount} 次</p>`;
  const actions = document.createElement("div");
  actions.className = "item-detail-actions";
  const editButton = document.createElement("button");
  editButton.className = "secondary";
  editButton.type = "button";
  editButton.textContent = "编辑衣物";
  editButton.onclick = () => openItemEditor(item);
  const deleteButton = document.createElement("button");
  deleteButton.className = "danger-button";
  deleteButton.type = "button";
  deleteButton.textContent = "删除衣物";
  deleteButton.onclick = async () => {
    if (!confirm(`确定删除“${item.name}”吗？对应的穿着记录也会删除，此操作无法撤销。`)) return;
    await deleteItemAndLogs(item.id);
    detail.hidden = true;
    await renderCloset();
    message("衣物和对应穿着记录已从这台设备删除。");
  };
  actions.append(editButton, deleteButton);
  detail.append(back, image, copy, actions);
  detail.hidden = false;
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showDraftConfirmation(candidateDraft) {
  draft = candidateDraft;
  const form = $("#item-confirmation");
  const manualFallback = draft.recognitionMode === "manual-fallback";
  const cutoutReady = draft.cutoutState === "ready";
  const classificationReady = draft.embeddingState === "ready";
  const colorName = String(draft.tags.color || "").split("（")[0];
  form.elements.name.value = `${colorName}${draft.tags.category || "衣物"}`;
  form.elements.category.value = draft.tags.category || "";
  form.elements.color.value = draft.tags.color || "";
  form.elements.season.value = draft.tags.season || "";
  form.elements.pattern.value = draft.tags.pattern || "";
  form.elements.material.value = draft.tags.material || "";
  form.elements.styles.value = (draft.tags.styles || []).join("，");
  form.elements.scenes.value = (draft.tags.scenes || []).join("，");
  form.elements.brand.value = "";
  form.elements.purchaseDate.value = "";
  form.elements.purchaseChannel.value = "";
  form.elements.customTags.value = "";
  form.elements.price.value = "";
  form.querySelector("img").src = blobUrl(draft.cutout);
  form.querySelector(".preview-card").classList.toggle("transparent-preview", cutoutReady);
  form.querySelector(".cutout-preview").alt = cutoutReady ? "本地 AI 生成的衣物主体图" : "等待重新抠图的衣物原图";
  form.querySelector(".success-chip").textContent = cutoutReady && classificationReady ? "✓ 抠图与分类已完成" : cutoutReady ? "抠图已完成 · 分类待重试" : classificationReady ? "分类已完成 · 抠图待重试" : "待抠图 · 图片已保留";
  form.querySelector(".ai-intro").textContent = manualFallback
    ? "本地 AI 未完成，当前显示原图且不会伪装成抠图结果。请稍后重试，或手动填写后保存为待抠图衣物。"
    : cutoutReady && classificationReady
      ? "AI 结果只供参考。标有“待确认”的字段可信度较低，请按实物修改。"
      : classificationReady
        ? "衣物标签已经识别，但本次抠图未通过。当前显示原图，可确认标签后保存或重新抠图。"
        : "透明抠图已经保留，但标签模型未完成。可重新识别，或手动确认空白字段。";
  const confidence = draft.recognitionConfidence || {};
  const lowFields = Object.entries({
    categories: "品类",
    patterns: "花纹",
    materials: "材质",
    seasons: "季节",
    styles: "风格",
    scenes: "场景",
  }).filter(([field]) => confidence[field] === "low").map(([, label]) => label);
  form.querySelector(".recognition-summary").textContent = manualFallback
    ? `未生成 AI 标签：${draft.recognitionError || "本地模型未完成"}。所有字段需要手动确认。`
    : !classificationReady
      ? `标签未生成：${draft.recognitionError || "本地分类模型未完成"}。`
      : lowFields.length
      ? `待确认：${lowFields.join("、")}。材质仅为图片外观推测。`
      : "识别候选已填写；材质仍建议按衣物水洗标确认。";
  form.querySelector("[data-retry-draft]").hidden = cutoutReady && classificationReady;
  $("#item-form").hidden = true;
  form.hidden = false;
  document.querySelectorAll("#add-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 1));
  $("#batch-status").textContent = batchTotal > 1 ? `正在确认第 ${batchTotal - batchQueue.length + 1} / ${batchTotal} 件，已保存 ${batchSaved} 件。` : "";
  message(manualFallback ? "已保留原图并转为手动确认；保存后不会伪装成 AI 识别结果。" : cutoutReady && classificationReady ? "本地 AI 已完成，请按实物确认标签后再保存。" : classificationReady ? "分类已完成，但抠图待重试；标签不会再一起丢失。" : "抠图结果已保留，但分类待重试。", !(cutoutReady && classificationReady));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function makeDraft(file) {
  const sourceHash = await hashFile(file);
  const existing = await getAll("items");
  if (existing.some((item) => item.sourceHash === sourceHash)) {
    const error = new Error("这张图片已经录入过，无需重复保存。");
    error.code = "DUPLICATE";
    throw error;
  }
  const result = await recognize(file);
  let color = "";
  let cutoutState = result.cutoutState || "pending";
  if (cutoutState === "ready") {
    const analysis = await safeAnalyzeCutout(result.cutout);
    if (analysis.quality.valid) color = analysis.color;
    else cutoutState = "pending";
  }
  showDraftConfirmation({
    source: file,
    cutout: result.cutout,
    sourceHash,
    embedding: result.embedding,
    recognitionMode: cutoutState === "ready" && result.embeddingState === "ready" ? "ai" : "ai-partial",
    embeddingState: result.embeddingState || (hasValidEmbedding(result.embedding) ? "ready" : "unavailable"),
    cutoutState,
    recognitionCandidates: result.recognitionCandidates || {},
    recognitionConfidence: result.recognitionConfidence || {},
    recognitionError: result.recognitionError || (cutoutState === "ready" ? "" : result.cutoutError || "抠图质量检查未通过"),
    tags: { ...result.tags, color },
  });
}

async function makeManualDraft(file, recognitionError = null) {
  const sourceHash = await hashFile(file);
  const existing = await getAll("items");
  if (existing.some((item) => item.sourceHash === sourceHash)) {
    const error = new Error("这张图片已经录入过，无需重复保存。");
    error.code = "DUPLICATE";
    throw error;
  }
  showDraftConfirmation(createManualFallbackDraft(file, sourceHash, "", recognitionError?.message || ""));
}

async function processNextBatchItem() {
  while (batchQueue.length) {
    const file = batchQueue[0];
    try {
      await makeDraft(file);
      batchQueue.shift();
      batchFailedFile = null;
      $("#batch-error").hidden = true;
      return true;
    } catch (error) {
      if (error.code === "DUPLICATE") {
        batchQueue.shift();
        message(`${file.name}：${error.message}，已跳过。`, true);
        continue;
      }
      if (batchTotal === 1) {
        await makeManualDraft(file, error);
        batchQueue.shift();
        batchFailedFile = null;
        $("#batch-error").hidden = true;
        return true;
      }
      batchFailedFile = file;
      $("#batch-error-copy").textContent = `${file.name}：${error.message}`;
      $("#batch-error").hidden = false;
      $("#item-confirmation").hidden = true;
      $("#item-form").hidden = false;
      message("当前图片未被丢弃，可以转手动确认、重试、跳过或取消批次。", true);
      return false;
    }
  }
  return false;
}

function resetBatch() {
  batchQueue = [];
  batchTotal = 0;
  batchSaved = 0;
  batchFailedFile = null;
  draft = null;
  $("#item-confirmation").hidden = true;
  $("#item-form").hidden = false;
  $("#item-form").reset();
  $("#batch-status").textContent = "";
  $("#batch-error").hidden = true;
  document.querySelectorAll("#add-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 0));
}

$("#item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const files = Array.from(event.currentTarget.elements.image.files || []);
  if (!files.length) return;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  batchQueue = files;
  batchTotal = files.length;
  batchSaved = 0;
  $("#batch-status").textContent = files.length > 1 ? `已选择 ${files.length} 件，将逐张识别和确认。` : "";
  try {
    const started = await processNextBatchItem();
    if (!started && !batchFailedFile) resetBatch();
  } catch (error) {
    message(error.message, true);
    resetBatch();
  } finally {
    button.disabled = false;
  }
});

$("[data-retry-batch]").addEventListener("click", async () => {
  $("#batch-error").hidden = true;
  await processNextBatchItem();
});
$("[data-manual-batch]").addEventListener("click", async () => {
  if (!batchFailedFile || batchQueue[0] !== batchFailedFile) return;
  const file = batchFailedFile;
  const errorText = $("#batch-error-copy").textContent;
  try {
    await makeManualDraft(file, new Error(errorText));
    batchQueue.shift();
    batchFailedFile = null;
    $("#batch-error").hidden = true;
  } catch (error) {
    message(error.message, true);
  }
});
$("[data-skip-batch]").addEventListener("click", async () => {
  if (batchFailedFile && batchQueue[0] === batchFailedFile) batchQueue.shift();
  batchFailedFile = null;
  $("#batch-error").hidden = true;
  if (!batchQueue.length || !await processNextBatchItem()) {
    if (!batchFailedFile) resetBatch();
  }
});
$("[data-abort-batch]").addEventListener("click", () => {
  resetBatch();
  message("本批次已取消，未确认的图片不会保存。");
});

$("#item-confirmation").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!draft) return;
  const form = event.currentTarget;
  const item = {
    id: id(),
    name: form.elements.name.value.trim(),
    category: form.elements.category.value,
    color: form.elements.color.value.trim(),
    season: form.elements.season.value,
    pattern: form.elements.pattern.value.trim(),
    material: form.elements.material.value.trim(),
    styles: splitTags(form.elements.styles.value),
    scenes: splitTags(form.elements.scenes.value),
    brand: form.elements.brand.value.trim(),
    purchaseDate: form.elements.purchaseDate.value,
    purchaseChannel: form.elements.purchaseChannel.value.trim(),
    customTags: splitTags(form.elements.customTags.value),
    price: form.elements.price.value ? Number(form.elements.price.value) : null,
    sourceHash: draft.sourceHash,
    source: draft.source,
    cutout: draft.cutout,
    embedding: draft.embedding,
    recognitionMode: draft.recognitionMode || "ai",
    embeddingState: draft.embeddingState || (hasValidEmbedding(draft.embedding) ? "ready" : "unavailable"),
    cutoutState: draft.cutoutState || (draft.recognitionMode === "ai" ? "ready" : "pending"),
    recognitionCandidates: draft.recognitionCandidates || {},
    recognitionConfidence: draft.recognitionConfidence || {},
    recognitionError: draft.recognitionError || "",
    wearCount: 0,
    createdAt: Date.now(),
    modelVersion: draft.recognitionMode === "manual-fallback" ? "manual-fallback-v2" : "u2netp+clip-local-v1",
  };
  await put("items", item);
  batchSaved += 1;
  draft = null;
  if (batchQueue.length) {
    const started = await processNextBatchItem();
    if (started || batchFailedFile) return;
  }
  const saved = batchSaved;
  resetBatch();
  await renderCloset();
  switchPage("closet");
  message(saved > 1 ? `本批次 ${saved} 件衣物已保存到这台设备。` : "已保存到这台设备的衣橱。");
});
$("[data-retry-draft]").addEventListener("click", async () => {
  if (!draft?.source) return;
  const source = draft.source;
  message("正在重新执行本地抠图与识别…");
  try {
    await makeDraft(source);
  } catch (error) {
    await makeManualDraft(source, error);
  }
});
$("[data-cancel-draft]").addEventListener("click", () => { resetBatch(); window.scrollTo({ top: 0, behavior: "smooth" }); message("本批次已取消，未确认的图片不会保存。"); });

$("#item-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingItem) return;
  const form = event.currentTarget;
  const updatedItem = {
    ...editingItem,
    name: form.elements.name.value.trim(),
    category: form.elements.category.value,
    color: form.elements.color.value.trim(),
    season: form.elements.season.value,
    pattern: form.elements.pattern.value.trim(),
    material: form.elements.material.value.trim(),
    styles: splitTags(form.elements.styles.value),
    scenes: splitTags(form.elements.scenes.value),
    brand: form.elements.brand.value.trim(),
    purchaseDate: form.elements.purchaseDate.value,
    purchaseChannel: form.elements.purchaseChannel.value.trim(),
    customTags: splitTags(form.elements.customTags.value),
    price: form.elements.price.value ? Number(form.elements.price.value) : null,
    updatedAt: Date.now(),
  };
  await put("items", updatedItem);
  editingItem = null;
  $("#item-edit-dialog").close();
  await renderCloset();
  showDetail(updatedItem);
  message("衣物信息已保存。");
});
document.querySelectorAll("[data-close-edit]").forEach((button) => button.addEventListener("click", () => { editingItem = null; $("#item-edit-dialog").close(); }));
["#closet-search", "#closet-category", "#closet-color", "#closet-season", "#closet-scene", "#closet-sort", "#closet-view"].forEach((selector) => $(selector).addEventListener(selector === "#closet-search" ? "input" : "change", renderCloset));

async function renderAnalysisHistory() {
  const target = $("#analysis-history-list");
  const records = (await getAll("analysisRecords")).sort((left, right) => Number(right.createdAt) - Number(left.createdAt)).slice(0, 10);
  target.replaceChildren();
  if (!records.length) {
    target.innerHTML = '<p class="hint">还没有保存过购衣决定。</p>';
    return;
  }
  records.forEach((record) => {
    const card = document.createElement("article");
    card.className = "history-card";
    const time = new Date(record.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    card.innerHTML = `<strong>${escapeHtml(record.candidate?.name || "候选新衣")} · ${escapeHtml(record.decision)}</strong><small>${escapeHtml(record.verdict)} · 本机规则评分 ${record.ruleScore}% · ${time}</small><small>${escapeHtml((record.reasons || []).join("、") || "未填写原因")}</small>`;
    target.append(card);
  });
}

async function saveAnalysisDecision(decision) {
  if (!currentAnalysis || !analysisCandidate) return;
  const reasons = [...document.querySelectorAll("#analysis-result [name='decisionReason']:checked")].map((input) => input.value);
  await put("analysisRecords", {
    id: id(),
    createdAt: Date.now(),
    candidate: {
      name: analysisCandidate.name,
      category: analysisCandidate.tags.category,
      color: analysisCandidate.tags.color,
      season: analysisCandidate.tags.season,
      pattern: analysisCandidate.tags.pattern,
      material: analysisCandidate.tags.material,
      styles: analysisCandidate.tags.styles,
      scenes: analysisCandidate.tags.scenes,
    },
    maxSimilarity: currentAnalysis.maxSimilarity,
    similarityAvailable: currentAnalysis.similarityAvailable,
    conflictLevel: currentAnalysis.conflictLevel,
    matchRate: currentAnalysis.matchRate,
    matchingItemIds: currentAnalysis.topSimilarities.map(({ item }) => item.id),
    outfitItemIds: currentAnalysis.outfits.map((outfit) => outfit.filter((item) => item.id !== "candidate").map((item) => item.id)),
    sceneCoverage: currentAnalysis.coveredScenes,
    gap: currentAnalysis.nextGap,
    ruleScore: currentAnalysis.ruleScore,
    verdict: currentAnalysis.verdict,
    decision,
    reasons,
  });
  await renderAnalysisHistory();
}

function resetCandidateAnalysis() {
  analysisCandidate = null;
  currentAnalysis = null;
  $("#analysis-result").hidden = true;
  $("#candidate-form").hidden = false;
  $("#candidate-manual-form").hidden = true;
  $("#candidate-form").reset();
  document.querySelectorAll("#analysis-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 0));
  window.scrollTo({ top: 0, behavior: "smooth" });
  message("");
}

function renderPurchaseAnalysis(result) {
  const panel = $("#analysis-result");
  const similarityCopy = !result.similarityAvailable
    ? "候选图或现有衣物缺少可用 embedding，相似度未计算，不能据此判断“无同款”"
    : result.topSimilarities.length
    ? `最高相似度 ${Math.round(result.maxSimilarity * 100)}%，判定为“${result.conflictLevel}”`
    : "衣橱暂无可用于相似度比较的衣物";
  const similarityValue = result.similarityAvailable ? `${Math.round(result.maxSimilarity * 100)}%` : "—";
  const scoreLabel = result.similarityAvailable ? "本机规则评分" : "手动模式规则评分";
  const similarHtml = result.topSimilarities.map(({ item, score }) => `
    <article><img src="${blobUrl(item.cutout)}" alt=""><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.color || "未填写颜色")}</small></span><b>${Math.round(score * 100)}%</b></article>`).join("");
  const outfitHtml = result.outfits.length
    ? result.outfits.map((outfit, index) => `<article>方案 ${index + 1}：${outfit.map((item) => escapeHtml(item.name)).join(" ＋ ")}</article>`).join("")
    : "<article>当前衣橱还不能组成真实搭配，不会生成虚假单品。</article>";
  panel.innerHTML = `
    <section class="result-hero">
      <span class="result-icon" aria-hidden="true">👗</span>
      <h2>${escapeHtml(result.verdict)}</h2>
      <p>这是本机衣橱规则判断，不是版型或上身效果保证</p>
      <div class="result-score">${scoreLabel}：<strong>${result.ruleScore}%</strong></div>
    </section>
    <div class="metric-grid">
      <article class="metric-card"><span aria-hidden="true">🔎</span><strong>${similarityValue}</strong><small>${escapeHtml(result.conflictLevel)}</small></article>
      <article class="metric-card"><span aria-hidden="true">🧺</span><strong>${Math.round(result.matchRate * 100)}%</strong><small>${result.compatibleCount}/${result.structuralCount} 个结构组合可搭</small></article>
      <article class="metric-card"><span aria-hidden="true">🌿</span><strong>${result.coveredScenes.length}</strong><small>覆盖场景：${escapeHtml(result.coveredScenes.join("、") || "暂无")}</small></article>
      <article class="metric-card"><span aria-hidden="true">👚</span><strong>${result.fillsGap ? "补缺" : "非缺口"}</strong><small>下一步值得补：${escapeHtml(result.nextGap)}</small></article>
    </div>
    <section class="reason-card">
      <h3>第一、二步 · 检索与冲突</h3>
      <ul><li>识别为 ${escapeHtml(analysisCandidate.tags.category)}，${escapeHtml(analysisCandidate.tags.color)}，${escapeHtml(analysisCandidate.tags.pattern || "花纹待确认")}，${escapeHtml(analysisCandidate.tags.material || "材质待确认")}</li><li>${escapeHtml(similarityCopy)}</li></ul>
      ${similarHtml ? `<div class="similarity-list">${similarHtml}</div>` : ""}
    </section>
    <section class="reason-card">
      <h3>第三步 · 真实搭配</h3>
      <p>搭配率 = 符合季节和场景的组合数 ÷ 当前衣橱可形成的结构组合数。</p>
      <div class="outfit-list">${outfitHtml}</div>
      <p>${result.missing.length ? `当前还缺：${escapeHtml(result.missing.join("、"))}` : "当前未发现必要搭配品类缺口。"}</p>
    </section>
    <section class="reason-card">
      <h3>第四步 · 衣橱缺口</h3>
      <ul><li>${result.fillsGap ? "这件候选衣物可补充当前品类缺口。" : "当前衣橱已有同品类基础数量。"}</li><li>下一步最值得补充：${escapeHtml(result.nextGap)}</li><li>胶囊衣橱数量只是透明规则基准，不是 AI 概率。</li></ul>
    </section>
    <section class="decision-card">
      <h3>第五步 · 记录你的决定</h3>
      <div class="decision-reasons">
        ${["重复较多", "搭配较少", "版型风险", "价格原因", "暂时不需要"].map((reason) => `<label><input type="checkbox" name="decisionReason" value="${reason}">${reason}</label>`).join("")}
      </div>
      <button class="decision-choice" type="button" data-decision="决定购买"><span>🛍️</span><span><strong>决定购买</strong><small>保存决定并进入衣物确认，不重复识别</small></span><span>›</span></button>
      <button class="decision-choice" type="button" data-decision="暂时观望"><span>🔖</span><span><strong>暂时观望</strong><small>保存到本机购衣历史</small></span><span>›</span></button>
      <button class="decision-choice" type="button" data-decision="决定不买"><span>🚪</span><span><strong>决定不买</strong><small>保存原因，帮助下次判断</small></span><span>›</span></button>
      <button class="secondary" type="button" data-restart-analysis>重新分析一件</button>
    </section>`;
  panel.hidden = false;
  panel.querySelectorAll("[data-decision]").forEach((choice) => choice.addEventListener("click", async () => {
    panel.querySelectorAll("[data-decision]").forEach((button) => { button.disabled = true; });
    const decision = choice.dataset.decision;
    try {
      await saveAnalysisDecision(decision);
    } catch (error) {
      panel.querySelectorAll("[data-decision]").forEach((button) => { button.disabled = false; });
      message(`决定未保存：${error.message}`, true);
      return;
    }
    if (decision === "决定购买") {
      const existing = await getAll("items");
      if (existing.some((item) => item.sourceHash === analysisCandidate.sourceHash)) {
        message("这张图片已经在衣橱中，本次决定已记录，但不会重复入库。", true);
        return;
      }
      showDraftConfirmation(analysisCandidate);
      switchPage("add");
      message("已复用本次识别结果，请确认标签后加入衣橱。");
      return;
    }
    message(`已在本机保存：${decision}。`);
  }));
  panel.querySelector("[data-restart-analysis]").addEventListener("click", resetCandidateAnalysis);
}

async function completeCandidateAnalysis(similarityAvailable) {
  const items = (await getAll("items")).map(normalizeItem);
  const comparableItems = items.filter((item) => hasValidEmbedding(item.embedding) && item.embeddingState === "ready");
  const canCompare = similarityAvailable && hasValidEmbedding(analysisCandidate.embedding) && comparableItems.length > 0;
  const similarities = canCompare
    ? comparableItems.map((item) => ({ item, score: cosine(analysisCandidate.embedding, item.embedding) }))
    : [];
  currentAnalysis = buildPurchaseAnalysis(analysisCandidate, items, similarities, { similarityAvailable: canCompare });
  renderPurchaseAnalysis(currentAnalysis);
  $("#candidate-form").hidden = true;
  $("#candidate-manual-form").hidden = true;
  document.querySelectorAll("#analysis-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 2));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function prepareManualCandidate(file, sourceHash, error) {
  analysisCandidate = {
    id: "candidate",
    name: "待确认衣物",
    source: file,
    cutout: file,
    sourceHash,
    embedding: new ArrayBuffer(0),
    recognitionMode: "manual-fallback",
    embeddingState: "unavailable",
    cutoutState: "pending",
    recognitionCandidates: {},
    recognitionConfidence: {},
    recognitionError: error?.message || "",
    tags: { category: "", color: "", season: "", pattern: "", material: "", styles: [], scenes: [] },
    category: "",
    color: "",
    season: "",
    styles: [],
    scenes: [],
  };
  const form = $("#candidate-manual-form");
  form.querySelector("img").src = blobUrl(file);
  form.querySelector(".preview-card").classList.remove("transparent-preview");
  form.querySelector(".success-chip").textContent = "待抠图 · 相似度未计算";
  form.querySelector(".ai-intro").textContent = "本地 AI 未完成，当前显示原图且图片没有丢失。请手动确认基础标签，搭配和缺口规则仍可继续运行。";
  form.elements.category.value = "";
  form.elements.color.value = "";
  form.elements.season.value = "";
  form.elements.pattern.value = "";
  form.elements.material.value = "";
  form.elements.styles.value = "";
  form.elements.scenes.value = "";
  $("#candidate-form").hidden = true;
  form.hidden = false;
  document.querySelectorAll("#analysis-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 1));
  message("本地 AI 未完成，已保留新衣原图。请手动确认标签后继续；相似度会明确显示为“未计算”。", true);
}

function showAiCandidateConfirmation() {
  const form = $("#candidate-manual-form");
  const cutoutReady = analysisCandidate.cutoutState === "ready";
  const classificationReady = analysisCandidate.embeddingState === "ready";
  form.querySelector("img").src = blobUrl(analysisCandidate.cutout);
  form.querySelector(".preview-card").classList.toggle("transparent-preview", cutoutReady);
  form.querySelector(".success-chip").textContent = cutoutReady && classificationReady ? "✓ 抠图与分类已完成" : cutoutReady ? "抠图已完成 · 分类待重试" : classificationReady ? "分类已完成 · 抠图待重试" : "本地 AI 待重试";
  form.querySelector(".ai-intro").textContent = cutoutReady && classificationReady
    ? "图片已在本机完成抠图与识别。候选标签不是事实，请确认后再运行五步分析。"
    : classificationReady
      ? "标签识别已完成，但本次抠图未通过。当前保留原图，确认标签后仍可继续分析。"
      : "抠图已经保留，但标签模型未完成。请手动确认空白字段后继续，或返回后重新识别。";
  form.elements.category.value = analysisCandidate.tags.category || "";
  form.elements.color.value = analysisCandidate.tags.color || "";
  form.elements.season.value = analysisCandidate.tags.season || "";
  form.elements.pattern.value = analysisCandidate.tags.pattern || "";
  form.elements.material.value = analysisCandidate.tags.material || "";
  form.elements.styles.value = (analysisCandidate.tags.styles || []).join("，");
  form.elements.scenes.value = (analysisCandidate.tags.scenes || []).join("，");
  $("#candidate-form").hidden = true;
  form.hidden = false;
  document.querySelectorAll("#analysis-page .stepper li").forEach((step, index) => step.classList.toggle("active", index === 1));
  message(cutoutReady && classificationReady ? "本地抠图与标签候选已生成，请先确认；低可信结果可直接修改。" : classificationReady ? "标签候选已生成，抠图未通过但不再影响分类。" : "抠图已保留，但标签识别未完成。", !(cutoutReady && classificationReady));
}

$("#candidate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = event.currentTarget.elements.image.files?.[0];
  if (!file) return;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  let sourceHash = "";
  try {
    sourceHash = await hashFile(file);
    const result = await recognize(file);
    let color = "";
    let cutoutState = result.cutoutState || "pending";
    if (cutoutState === "ready") {
      const cutoutAnalysis = await safeAnalyzeCutout(result.cutout);
      if (cutoutAnalysis.quality.valid) color = cutoutAnalysis.color;
      else cutoutState = "pending";
    }
    analysisCandidate = {
      id: "candidate",
      name: `${color.split("（")[0]}${result.tags.category}`,
      source: file,
      cutout: result.cutout,
      sourceHash,
      embedding: result.embedding,
      recognitionMode: cutoutState === "ready" && result.embeddingState === "ready" ? "ai" : "ai-partial",
      embeddingState: result.embeddingState || (hasValidEmbedding(result.embedding) ? "ready" : "unavailable"),
      cutoutState,
      recognitionCandidates: result.recognitionCandidates || {},
      recognitionConfidence: result.recognitionConfidence || {},
      recognitionError: result.recognitionError || (cutoutState === "ready" ? "" : result.cutoutError || "抠图质量检查未通过"),
      tags: { ...result.tags, color },
      category: result.tags.category,
      color,
      season: result.tags.season,
      styles: result.tags.styles,
      scenes: result.tags.scenes,
    };
    showAiCandidateConfirmation();
  } catch (error) {
    try {
      if (!sourceHash) sourceHash = await hashFile(file);
      await prepareManualCandidate(file, sourceHash, error);
    } catch (fallbackError) {
      message(`图片无法进入手动确认：${fallbackError.message}`, true);
    }
  } finally {
    button.disabled = false;
  }
});

$("#candidate-manual-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!analysisCandidate) return;
  const form = event.currentTarget;
  const scenes = splitTags(form.elements.scenes.value);
  analysisCandidate.tags = {
    category: form.elements.category.value,
    color: form.elements.color.value.trim(),
    season: form.elements.season.value,
    pattern: form.elements.pattern.value.trim(),
    material: form.elements.material.value.trim(),
    styles: splitTags(form.elements.styles.value),
    scenes,
  };
  analysisCandidate.name = `${analysisCandidate.tags.color.split("（")[0]}${analysisCandidate.tags.category}`;
  Object.assign(analysisCandidate, {
    category: analysisCandidate.tags.category,
    color: analysisCandidate.tags.color,
    season: analysisCandidate.tags.season,
    styles: analysisCandidate.tags.styles,
    scenes: analysisCandidate.tags.scenes,
  });
  const similarityAvailable = analysisCandidate.embeddingState === "ready" && hasValidEmbedding(analysisCandidate.embedding);
  await completeCandidateAnalysis(similarityAvailable);
  message(similarityAvailable ? "本地五步新衣分析完成，请确认规则依据后记录决定。" : "手动标签的搭配和缺口分析已完成；相似度没有伪造。");
});
$("[data-cancel-manual-analysis]").addEventListener("click", resetCandidateAnalysis);

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function setWeatherIcon(element, kind) {
  element.classList.remove("weather-sunny", "weather-partly", "weather-rain", "weather-snow", "weather-fog", "weather-thunder");
  element.classList.add(`weather-${kind}`);
}

function renderWeatherSummary(snapshot, cached = false) {
  weatherSnapshot = snapshot;
  setWeatherIcon($("#hero-weather-icon"), snapshot.kind);
  setWeatherIcon($("#home-weather-icon"), snapshot.kind);
  $("#home-weather-title").textContent = `${snapshot.cityName} · ${Math.round(snapshot.temperature)}°C`;
  $("#home-weather-detail").textContent = `${snapshot.label} · 体感 ${Math.round(snapshot.apparentTemperature)}°C`;
  const updated = new Date(snapshot.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  $("#weather-summary").innerHTML = `<div class="weather-summary-main"><span class="weather-summary-icon weather-dynamic weather-${snapshot.kind}" aria-hidden="true"></span><div><strong>${escapeHtml(snapshot.cityName)} · ${Math.round(snapshot.temperature)}°C</strong><p>${escapeHtml(snapshot.label)}，体感 ${Math.round(snapshot.apparentTemperature)}°C；${Math.round(snapshot.minTemperature)}–${Math.round(snapshot.maxTemperature)}°C</p><small>降水概率 ${Math.round(snapshot.precipitationProbability)}% · 风速 ${Math.round(snapshot.windSpeed)} km/h · ${cached ? "缓存" : "更新"}于 ${updated}</small></div></div>`;
}

async function renderWeatherRecommendation() {
  const panel = $("#outfit-recommendation");
  if (!weatherSnapshot) {
    panel.innerHTML = '<p class="hint">选择城市并取得天气后，再从本机衣橱生成推荐。</p>';
    $("#today-recommendation-copy").textContent = "选择城市后，从真实衣橱推荐";
    return;
  }
  const items = (await getAll("items")).map(normalizeItem);
  const recommendation = buildOutfitRecommendation(items, weatherSnapshot);
  panel.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "今日衣橱推荐";
  const reason = document.createElement("p");
  reason.className = "recommendation-reason";
  reason.textContent = recommendation.reason;
  panel.append(heading, reason);
  if (recommendation.items.length) {
    const cards = document.createElement("div");
    cards.className = "recommendation-items";
    recommendation.items.forEach((item) => {
      const card = document.createElement("article");
      const image = document.createElement("img");
      image.src = blobUrl(item.cutout);
      image.alt = item.name;
      const copy = document.createElement("span");
      copy.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.season)}</small>`;
      card.append(image, copy);
      cards.append(card);
    });
    panel.append(cards);
    $("#today-recommendation-copy").textContent = recommendation.items.map((item) => item.name).slice(0, 2).join("＋");
  } else {
    $("#today-recommendation-copy").textContent = "衣橱信息不足，点击查看缺口";
  }
  if (recommendation.missing.length) {
    const missing = document.createElement("p");
    missing.className = "recommendation-missing";
    missing.textContent = `还缺：${recommendation.missing.join("、")}。不会用不适合的衣物凑数。`;
    panel.append(missing);
  }
}

async function fetchWeather(location, force = false) {
  const cache = readStorage(WEATHER_CACHE_KEY);
  const sameLocation = cache?.locationId === location.id;
  if (!force && sameLocation && Date.now() - Number(cache.snapshot?.fetchedAt || 0) < WEATHER_CACHE_MS) {
    renderWeatherSummary(cache.snapshot, true);
    await renderWeatherRecommendation();
    return;
  }
  $("#weather-summary").innerHTML = "<p>正在获取当天真实天气…</p>";
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: location.timezone || "auto",
    forecast_days: "1",
  });
  try {
    const response = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!response.ok) throw new Error(`天气服务返回 ${response.status}`);
    const data = await response.json();
    const kind = weatherKind(data.current?.weather_code ?? data.daily?.weather_code?.[0]);
    const snapshot = {
      cityName: location.name,
      fetchedAt: Date.now(),
      temperature: Number(data.current?.temperature_2m),
      apparentTemperature: Number(data.current?.apparent_temperature),
      precipitation: Number(data.current?.precipitation || 0),
      precipitationProbability: Number(data.daily?.precipitation_probability_max?.[0] || 0),
      windSpeed: Number(data.current?.wind_speed_10m || 0),
      minTemperature: Number(data.daily?.temperature_2m_min?.[0]),
      maxTemperature: Number(data.daily?.temperature_2m_max?.[0]),
      kind,
      label: weatherLabels[kind],
    };
    const requiredWeatherValues = [
      snapshot.temperature,
      snapshot.apparentTemperature,
      snapshot.minTemperature,
      snapshot.maxTemperature,
    ];
    if (!requiredWeatherValues.every(Number.isFinite)) {
      throw new Error("天气数据不完整");
    }
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ locationId: location.id, snapshot }));
    renderWeatherSummary(snapshot);
    await renderWeatherRecommendation();
  } catch (error) {
    if (sameLocation && cache?.snapshot) {
      renderWeatherSummary(cache.snapshot, true);
      await renderWeatherRecommendation();
      message("天气联网更新失败，当前显示最近一次缓存。", true);
      return;
    }
    weatherSnapshot = null;
    $("#home-weather-title").textContent = location.name;
    $("#home-weather-detail").textContent = "天气暂不可用，点击重试";
    $("#weather-summary").innerHTML = `<p>天气暂不可用：${escapeHtml(error.message)}。衣橱数据没有上传。</p>`;
    await renderWeatherRecommendation();
  }
}

async function chooseLocation(result, target = $("#city-search-results")) {
  selectedLocation = {
    id: String(result.id),
    name: result.name,
    admin1: result.admin1 || "",
    admin2: result.admin2 || "",
    country: result.country || "中国",
    latitude: Number(result.latitude),
    longitude: Number(result.longitude),
    timezone: result.timezone || "Asia/Shanghai",
  };
  localStorage.setItem(WEATHER_LOCATION_KEY, JSON.stringify(selectedLocation));
  target.replaceChildren();
  await fetchWeather(selectedLocation, true);
}

async function loadRegionData() {
  if (!regionDataPromise) {
    regionDataPromise = fetch("./china-regions.min.json?v=1", { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`离线区划资源返回 ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (!Array.isArray(payload.regions) || payload.regions.length < 2800) throw new Error("离线区划数据不完整");
        return payload.regions;
      })
      .catch((error) => {
        regionDataPromise = null;
        throw error;
      });
  }
  return regionDataPromise;
}

function renderCityResults(regions) {
  const target = $("#city-search-results");
  target.replaceChildren();
  if (!regions.length) {
    target.innerHTML = '<p class="hint">没有找到该城市，请尝试输入完整城市或区县名称。</p>';
    return;
  }
  regions.forEach((region) => {
    const button = document.createElement("button");
    button.className = "city-result";
    button.type = "button";
    const levelCopy = region.level === "district" ? "区县天气" : region.level === "city" ? "城市天气" : "省级天气";
    button.innerHTML = `<strong>${escapeHtml(region.name)}</strong><small>${escapeHtml(regionPath(region))} · ${levelCopy}</small>`;
    button.addEventListener("click", () => chooseLocation(regionToLocation(region), target));
    target.append(button);
  });
}

$("#city-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = event.currentTarget.elements.city.value.trim();
  if (query.length < 2) return;
  const target = $("#city-search-results");
  const button = event.currentTarget.querySelector("button");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "搜索中…";
  target.innerHTML = "<p>正在搜索本机离线区划…</p>";
  try {
    const regions = await loadRegionData();
    renderCityResults(searchRegions(regions, query));
  } catch (error) {
    target.innerHTML = `<p class="hint">离线区划资源暂不可用：${escapeHtml(error.message || "未知错误")}。请刷新页面后重试。</p>`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

function openWeatherDialog() {
  const dialog = $("#weather-dialog");
  if (!dialog.open) dialog.showModal();
  if (selectedLocation && !weatherSnapshot) fetchWeather(selectedLocation);
}

$("#weather-open").addEventListener("click", openWeatherDialog);
$("#today-recommendation-open").addEventListener("click", openWeatherDialog);
document.querySelectorAll("[data-close-weather]").forEach((button) => button.addEventListener("click", () => $("#weather-dialog").close()));

async function initializeWeather() {
  selectedLocation = readStorage(WEATHER_LOCATION_KEY);
  const cache = readStorage(WEATHER_CACHE_KEY);
  if (!selectedLocation) {
    await renderWeatherRecommendation();
    return;
  }
  if (cache?.locationId === selectedLocation.id && cache.snapshot) {
    renderWeatherSummary(cache.snapshot, true);
    await renderWeatherRecommendation();
  }
  await fetchWeather(selectedLocation);
}

async function encodeBlob(blob) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); }); }
async function decodeBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }
$("#export-data").addEventListener("click", async () => { const items = await getAll("items"); const wearLogs = await getAll("wearLogs"); const analysisRecords = await getAll("analysisRecords"); const serializable = await Promise.all(items.map(async (item) => ({ ...item, source: await encodeBlob(item.source), cutout: await encodeBlob(item.cutout), embedding: Array.from(new Uint8Array(item.embedding)) }))); const blob = new Blob([JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items: serializable, wearLogs, analysisRecords })], { type: "application/json" }); const link = document.createElement("a"); link.href = blobUrl(blob); link.download = `衣橱关系本地备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); message("本地备份已导出，请保存到安全位置。"); });
$("#import-data").addEventListener("change", async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; try { const backup = JSON.parse(await file.text()); if (![1, 2].includes(backup.version) || !Array.isArray(backup.items)) throw new Error("这不是可识别的衣橱关系本地备份。"); if (!confirm(`将用备份中的 ${backup.items.length} 件衣物覆盖当前本地衣橱，确定继续吗？`)) return; await clear("items"); await clear("wearLogs"); await clear("analysisRecords"); for (const item of backup.items) await put("items", normalizeItem({ ...item, source: await decodeBlob(item.source), cutout: await decodeBlob(item.cutout), embedding: Uint8Array.from(item.embedding || []).buffer })); for (const log of backup.wearLogs || []) await put("wearLogs", log); for (const record of backup.analysisRecords || []) await put("analysisRecords", record); await renderCloset(); await renderAnalysisHistory(); message("本地备份已恢复。"); } catch (error) { message(error.message, true); } finally { event.currentTarget.value = ""; } });

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => message("离线缓存暂未启用，请使用 HTTPS 发布后的页面安装。", true));
$("#runtime-mode").textContent = globalThis.isSecureContext
  ? "当前为安全环境：重复检测使用 SHA-256，并优先尝试 WebGPU。"
  : "当前为微信/局域网兼容模式：图片会保留，但完整 AI 抠图需复制 HTTPS 线上链接到 Safari 或 Chrome。";
await openDatabase(); await renderCloset(); await renderAnalysisHistory(); await initializeWeather();
