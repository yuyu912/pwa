const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view"), appView = $("#app-view"), authMessage = $("#auth-message"), appMessage = $("#app-message");
const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const apiBase = String(window.WARDROBE_CONFIG?.apiBase || "").replace(/\/+$/, "");
const cloudApiMode = Boolean(apiBase);
const tokenKey = "wardrobe_cloud_token";
const apiUrl = (url) => `${apiBase}${url}`;
const api = async (url, options = {}) => {
  const { timeoutMs = 75000, retryConnection: retryOption, ...fetchOptions } = options;
  const retryConnection = retryOption ?? String(fetchOptions.method || "GET").toUpperCase() === "GET";
  let response;
  for (let attempt = 0; attempt <= (retryConnection ? 1 : 0); attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(fetchOptions.headers || {});
      const token = cloudApiMode ? window.localStorage.getItem(tokenKey) : "";
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      response = await fetch(apiUrl(url), { ...fetchOptions, headers, signal: controller.signal });
      break;
    } catch (error) {
      if (attempt === 0 && retryConnection) {
        message(authView.hidden ? appMessage : authMessage, "正在唤醒云端衣橱，请稍候…", false);
        await wait(1500);
        continue;
      }
      throw new Error(error.name === "AbortError" ? "云端衣橱唤醒超时，请稍后重试。" : "暂时无法连接云端衣橱，请检查网络后重试。");
    } finally {
      window.clearTimeout(timer);
    }
  }
  const body = response.status === 204 ? "" : await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; }
  catch { throw new Error(`云端返回了无法读取的内容（状态 ${response.status}）。`); }
  if (!response.ok) {
    if (response.status === 401 && cloudApiMode) window.localStorage.removeItem(tokenKey);
    const requestNote = data.requestId ? `（请求编号：${data.requestId}）` : "";
    const error = new Error(`${data.error || "操作未完成，请稍后重试。"}${requestNote}`);
    error.data = data;
    throw error;
  }
  if (cloudApiMode && data.token) window.localStorage.setItem(tokenKey, data.token);
  return data;
};
const listValue = (value) => String(value || "").split("，").join(",").split(",").map((item) => item.trim()).filter(Boolean);
const message = (target, text, isError = false) => { target.textContent = text; target.classList.toggle("error", isError); };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const compress = async (file) => {
  if (!file || ((file.type === "image/png" || file.type === "image/jpeg") && file.size < 1.2 * 1024 * 1024)) return file;
  const image = await createImageBitmap(file); const max = 1600; const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .86)); return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
};
window.wardrobeApi = api;
window.wardrobeCloudApiMode = cloudApiMode;
window.wardrobeCompress = compress;
const showAuth = () => { authView.hidden = false; appView.hidden = true; };
const showApp = async (user) => { authView.hidden = true; appView.hidden = false; $("#welcome-name").textContent = `你好，${user.username}`; await loadItems(); };
const showItemDetail = (item) => {
  const detail = $("#item-detail");
  detail.innerHTML = `<button class="text-button" data-close-detail>返回衣橱</button><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}"><div><p class="eyebrow">衣物详情</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</p><p>风格：${escapeHtml(item.styles.join("、") || "未填写")}</p><p>适用场景：${escapeHtml(item.scenes.join("、") || "未填写")}</p><p>价格：${item.price == null ? "未填写" : `¥${escapeHtml(item.price)}`}</p><p>已穿 ${Number(item.wear_count || 0)} 次</p></div>`;
  detail.hidden = false;
  detail.querySelector("[data-close-detail]").addEventListener("click", () => { detail.hidden = true; });
  detail.scrollIntoView({ behavior: "smooth", block: "start" });
};
const loadItems = async () => {
  const items = await api("/api/items"); $("#item-count").textContent = `${items.length} 件`;
  $("#item-detail").hidden = true;
  $("#item-list").innerHTML = items.length ? items.map((item) => `<article class="item-card" data-item="${escapeHtml(item.id)}" tabindex="0" role="button"><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}"><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.category)}${item.color ? ` · ${escapeHtml(item.color)}` : ""}</p><p>${escapeHtml(item.scenes.join("、") || "未填写场景")} · 已穿 ${Number(item.wear_count || 0)} 次</p><button class="text-button" data-wear="${escapeHtml(item.id)}">记录今天穿了</button></div></article>`).join("") : `<div class="empty"><strong>先录入一件真实衣物</strong><p>达到 5 件后，新衣分析会更有参考价值。</p></div>`;
  document.querySelectorAll("[data-item]").forEach((card) => card.addEventListener("click", (event) => { if (!event.target.closest("[data-wear]")) showItemDetail(items.find((item) => String(item.id) === card.dataset.item)); }));
  document.querySelectorAll("[data-wear]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/items/${button.dataset.wear}/wear-logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: "日常", comfort: "未填写" }) }); message(appMessage, "已记录今天穿了。", false); await loadItems(); } catch (error) { message(appMessage, error.message, true); } }));
};
document.querySelectorAll("[data-auth]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll("[data-auth]").forEach((tab) => tab.classList.toggle("active", tab === button)); document.querySelectorAll("#auth-view .form").forEach((form) => form.classList.toggle("active", form.id === `${button.dataset.auth}-form`)); message(authMessage, ""); }));
$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await showApp(result.user); } catch (error) { message(authMessage, error.message, true); } });
$("#register-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); message(authMessage, `注册成功。请立即保存恢复码：${result.recoveryCode}`); await showApp(result.user); } catch (error) { message(authMessage, error.message, true); } });
$("#recover-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/auth/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await showApp(result.user); } catch (error) { message(authMessage, error.message, true); } });
$("#logout").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST" }); if (cloudApiMode) window.localStorage.removeItem(tokenKey); showAuth(); });
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll("[data-page]").forEach((tab) => tab.classList.toggle("active", tab === button)); document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `${button.dataset.page}-page`)); message(appMessage, ""); }));
const formData = async (form) => { const data = new FormData(form); if (data.get("draftId")) data.delete("image"); else { const file = data.get("image"); if (file?.size) data.set("image", await compress(file)); } data.set("styles", JSON.stringify(listValue(data.get("styles")))); data.set("scenes", JSON.stringify(listValue(data.get("scenes")))); return data; };
const draftPayload = (form) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId: form.elements.draftId.value, name: form.elements.name.value, category: form.elements.category.value, color: form.elements.color.value, styles: JSON.stringify(listValue(form.elements.styles.value)), scenes: JSON.stringify(listValue(form.elements.scenes.value)), price: form.elements.price.value }) });
$("#item-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("[data-ai-submit]"); button.disabled = true; button.textContent = "正在保存…"; try { const item = await api("/api/items", { method: "POST", ...(form.elements.draftId.value ? draftPayload(form) : { body: await formData(form) }) }); form.reset(); message(appMessage, item.warning || "衣物已同步到云端。", false); document.querySelector('[data-page="closet"]').click(); await loadItems(); } catch (error) { message(appMessage, error.message, true); } finally { button.disabled = false; if (form.dataset.aiReady === "true") button.textContent = "确认并保存到衣橱"; } });
$("#candidate-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const form = event.currentTarget; const created = await api("/api/candidates", { method: "POST", ...(form.elements.draftId.value ? draftPayload(form) : { body: await formData(form) }) }); const analysis = await api(`/api/candidates/${created.id}/analyze`, { method: "POST" }); const result = $("#analysis-result"); result.hidden = false; result.innerHTML = `<article class="panel analysis"><p class="eyebrow">分析结论</p><h2>${escapeHtml(analysis.conclusion)}</h2><ul>${analysis.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul><h3>试穿时重点确认</h3><p>${escapeHtml(analysis.needsTryOn.join("；"))}</p><div class="decision-row"><button class="primary" data-decision="purchased">决定购买</button><button class="secondary" data-decision="wait">暂时观望</button><button class="secondary" data-decision="declined">决定不买</button></div></article>`; result.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", async () => { try { const decision = await api(`/api/candidates/${created.id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: button.dataset.decision }) }); message(appMessage, decision.addedToWardrobe ? "已确认购买并加入正式衣橱。" : "购买决定已保存。", false); if (decision.addedToWardrobe) await loadItems(); } catch (error) { message(appMessage, error.message, true); } })); } catch (error) { message(appMessage, error.message, true); } });
document.addEventListener("click", (event) => { const button = event.target.closest('[data-decision="purchased"]'); if (button && !button.dataset.confirmed) { event.stopImmediatePropagation(); if (window.confirm("确认已购买并把这件衣物加入正式衣橱吗？")) { button.dataset.confirmed = "true"; button.click(); } } }, true);
window.addEventListener("online", () => $("#offline-note").hidden = true); window.addEventListener("offline", () => $("#offline-note").hidden = false);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
const startApp = async () => {
  message(authMessage, "正在唤醒云端衣橱，请稍候…", false);
  try {
    await api("/api/health", { timeoutMs: 90000 });
    message(authMessage, "", false);
    const { user } = await api("/api/auth/me", { retryConnection: false });
    await showApp(user);
  } catch (error) {
    showAuth();
    if (error.message !== "请先登录。") message(authMessage, error.message, true);
    else message(authMessage, "", false);
  }
};
startApp();
