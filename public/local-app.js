const $ = (selector) => document.querySelector(selector);
const dbName = "wardrobe-local-v1";
let database;
let draft;
let modelState = "模型尚未下载。首次识别将在 Wi-Fi 下下载本地模型。";

const message = (text, error = false) => { const target = $("#app-message"); target.textContent = text; target.classList.toggle("error", error); };
const splitTags = (value) => String(value || "").split(/[，,]/).map((item) => item.trim()).filter(Boolean).slice(0, 4);
const id = () => crypto.randomUUID();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const tx = (store, mode = "readonly") => database.transaction(store, mode).objectStore(store);
const request = (value) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const getAll = (store) => request(tx(store).getAll());
const put = (store, value) => request(tx(store, "readwrite").put(value));
const clear = (store) => request(tx(store, "readwrite").clear());
const blobUrl = (blob) => URL.createObjectURL(blob);
const hashFile = async (file) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function openDatabase() {
  database = await new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("items", { keyPath: "id" }); open.result.createObjectStore("wearLogs", { keyPath: "id" }); };
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
}

function colorFrom(blob) {
  return createImageBitmap(blob).then((bitmap) => {
    const scale = Math.min(1, 120 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, bitmap.width * scale); canvas.height = Math.max(1, bitmap.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let r = 0, g = 0, b = 0, count = 0;
    for (let index = 0; index < pixels.length; index += 4) { if (pixels[index + 3] < 60) continue; r += pixels[index]; g += pixels[index + 1]; b += pixels[index + 2]; count += 1; }
    r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
    const name = r > g * 1.2 && r > b * 1.2 ? "红色系" : b > r * 1.15 && b > g * 1.05 ? "蓝色系" : g > r * 1.12 && g > b ? "绿色系" : r > 165 && g > 135 && b < 120 ? "黄色/棕色系" : Math.max(r, g, b) < 85 ? "深色系" : "中性色";
    return `${name}（#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}）`;
  });
}

const worker = new Worker("./local-ai-worker.js?v=1", { type: "module" });
const recognize = (file) => new Promise((resolve, reject) => {
  const onMessage = (event) => {
    const data = event.data;
    if (data.type === "progress") { modelState = data.text; $("#model-status").textContent = modelState; message(`${data.text}${data.percent != null ? ` ${data.percent}%` : ""}`); }
    if (data.type === "ready") { modelState = `本地模型已就绪（${data.device === "webgpu" ? "WebGPU" : "WASM"}）。`; $("#model-status").textContent = modelState; }
    if (data.type === "result") { worker.removeEventListener("message", onMessage); resolve(data); }
    if (data.type === "error") { worker.removeEventListener("message", onMessage); reject(new Error(data.message)); }
  };
  worker.addEventListener("message", onMessage); worker.postMessage({ type: "recognize", file });
});

function switchPage(name) { document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === name)); document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `${name}-page`)); message(""); }
function cosine(left, right) { const a = new Float32Array(left), b = new Float32Array(right); let dot = 0, aa = 0, bb = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }

async function renderCloset() {
  const items = (await getAll("items")).sort((a, b) => b.createdAt - a.createdAt); $("#item-count").textContent = `${items.length} 件`; $("#item-detail").hidden = true;
  const list = $("#item-list"); list.replaceChildren();
  if (!items.length) { list.innerHTML = '<div class="empty"><strong>从第一件真实衣物开始</strong><p>照片和记录只会留在这台设备。录入 5 件后，新衣分析会更有参考价值。</p></div>'; return; }
  items.forEach((item) => { const card = document.createElement("article"); card.className = "item-card"; const image = document.createElement("img"); image.src = blobUrl(item.cutout); image.alt = item.name; const body = document.createElement("div"); body.innerHTML = `<strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.category)} · ${escapeHtml(item.color || "未填写颜色")}</p><p>${escapeHtml(item.scenes.join("、") || "未填写场景")} · 已穿 ${Number(item.wearCount || 0)} 次</p><button class="text-button" type="button">记录今天穿了</button>`; body.querySelector("button").addEventListener("click", async (event) => { event.stopPropagation(); item.wearCount += 1; await put("items", item); await put("wearLogs", { id: id(), itemId: item.id, wornAt: Date.now(), scene: "日常" }); await renderCloset(); message("已记录今天穿了。"); }); card.append(image, body); card.addEventListener("click", () => showDetail(item)); list.append(card); });
}

function showDetail(item) { const detail = $("#item-detail"); detail.innerHTML = ""; const back = document.createElement("button"); back.className = "text-button"; back.textContent = "返回衣橱"; back.onclick = () => { detail.hidden = true; }; const image = document.createElement("img"); image.src = blobUrl(item.cutout); image.alt = item.name; const copy = document.createElement("div"); copy.innerHTML = `<p class="eyebrow">本地衣物详情</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</p><p>风格：${escapeHtml(item.styles.join("、") || "未填写")}</p><p>场景：${escapeHtml(item.scenes.join("、") || "未填写")}</p><p>价格：${item.price == null ? "未填写" : `¥${escapeHtml(item.price)}`}</p><p>已穿 ${Number(item.wearCount || 0)} 次</p>`; detail.append(back, image, copy); detail.hidden = false; detail.scrollIntoView({ behavior: "smooth", block: "start" }); }

async function makeDraft(file) {
  const sourceHash = await hashFile(file); const existing = await getAll("items"); if (existing.some((item) => item.sourceHash === sourceHash)) throw new Error("这张图片已经录入过，无需重复保存。");
  const result = await recognize(file); const cutout = result.cutout; const color = await colorFrom(cutout); draft = { source: file, cutout, sourceHash, embedding: result.embedding, tags: { ...result.tags, color } };
  const form = $("#item-confirmation"); form.elements.name.value = `${color.split("（")[0]}${result.tags.category}`; form.elements.category.value = result.tags.category; form.elements.color.value = color; form.elements.styles.value = result.tags.styles.join("，"); form.elements.scenes.value = result.tags.scenes.join("，"); form.querySelector("img").src = blobUrl(cutout); form.hidden = false; message("本地 AI 已完成，请确认标签后再保存。"); form.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#item-form").addEventListener("submit", async (event) => { event.preventDefault(); const file = event.currentTarget.elements.image.files?.[0]; if (!file) return; const button = event.currentTarget.querySelector("button"); button.disabled = true; try { await makeDraft(file); } catch (error) { message(error.message, true); } finally { button.disabled = false; } });
$("#item-confirmation").addEventListener("submit", async (event) => { event.preventDefault(); if (!draft) return; const form = event.currentTarget; const item = { id: id(), name: form.elements.name.value.trim(), category: form.elements.category.value, color: form.elements.color.value.trim(), styles: splitTags(form.elements.styles.value), scenes: splitTags(form.elements.scenes.value), price: form.elements.price.value ? Number(form.elements.price.value) : null, sourceHash: draft.sourceHash, source: draft.source, cutout: draft.cutout, embedding: draft.embedding, wearCount: 0, createdAt: Date.now(), modelVersion: "modnet+clip-local-v1" }; await put("items", item); draft = null; form.hidden = true; $("#item-form").reset(); await renderCloset(); switchPage("closet"); message("已保存到这台设备的衣橱。"); });
$("[data-cancel-draft]").addEventListener("click", () => { draft = null; $("#item-confirmation").hidden = true; });

$("#candidate-form").addEventListener("submit", async (event) => { event.preventDefault(); const file = event.currentTarget.elements.image.files?.[0]; if (!file) return; const button = event.currentTarget.querySelector("button"); button.disabled = true; try { const result = await recognize(file); const items = await getAll("items"); const scores = items.map((item) => ({ item, score: cosine(result.embedding, item.embedding) })).sort((a, b) => b.score - a.score); const sameCategory = items.filter((item) => item.category === result.tags.category); const similar = scores.filter(({ score }) => score >= .75).slice(0, 3); const compatible = items.filter((item) => item.category !== result.tags.category && item.scenes.some((scene) => result.tags.scenes.includes(scene))).length; const conclusion = similar.some(({ score }) => score >= .9) ? "重复风险较高" : compatible >= 5 ? "值得考虑" : compatible >= 2 ? "建议谨慎" : "补缺型"; const panel = $("#analysis-result"); panel.innerHTML = `<p class="eyebrow">本地分析结论</p><h2>${conclusion}</h2><p>AI 判断品类为“${result.tags.category}”，建议场景为“${result.tags.scenes.join("、") || "未识别"}”。</p><ul><li>现有同品类衣物：${sameCategory.length} 件</li><li>可形成候选搭配的衣物：${compatible} 件</li><li>${similar.length ? `发现 ${similar.length} 件相似衣物，最高相似度 ${Math.round(similar[0].score * 100)}%` : "未发现高度相似的已有衣物"}</li></ul><h3>试穿时重点确认</h3><p>版型是否舒适；是否适合已有鞋包；是否会替代低频旧衣。</p>`; panel.hidden = false; message("本地新衣分析完成。"); } catch (error) { message(error.message, true); } finally { button.disabled = false; } });

async function encodeBlob(blob) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); }); }
async function decodeBlob(dataUrl) { return (await fetch(dataUrl)).blob(); }
$("#export-data").addEventListener("click", async () => { const items = await getAll("items"); const wearLogs = await getAll("wearLogs"); const serializable = await Promise.all(items.map(async (item) => ({ ...item, source: await encodeBlob(item.source), cutout: await encodeBlob(item.cutout), embedding: Array.from(new Uint8Array(item.embedding)) }))); const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: serializable, wearLogs })], { type: "application/json" }); const link = document.createElement("a"); link.href = blobUrl(blob); link.download = `衣橱关系本地备份-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); message("本地备份已导出，请保存到安全位置。"); });
$("#import-data").addEventListener("change", async (event) => { const file = event.currentTarget.files?.[0]; if (!file) return; try { const backup = JSON.parse(await file.text()); if (backup.version !== 1 || !Array.isArray(backup.items)) throw new Error("这不是可识别的衣橱关系本地备份。"); if (!confirm(`将用备份中的 ${backup.items.length} 件衣物覆盖当前本地衣橱，确定继续吗？`)) return; await clear("items"); await clear("wearLogs"); for (const item of backup.items) await put("items", { ...item, source: await decodeBlob(item.source), cutout: await decodeBlob(item.cutout), embedding: Uint8Array.from(item.embedding).buffer }); for (const log of backup.wearLogs || []) await put("wearLogs", log); await renderCloset(); message("本地备份已恢复。"); } catch (error) { message(error.message, true); } finally { event.currentTarget.value = ""; } });

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => switchPage(button.dataset.page)));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => message("离线缓存暂未启用，请使用 HTTPS 发布后的页面安装。", true));
await openDatabase(); await renderCloset();
