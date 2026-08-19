const api = require("../../services/api");
const config = require("../../config");
const weatherService = require("../../services/weather");

const statusText = { resolving: "正在读取公开信息", screenshot_required: "链接暂时无法读取，请上传截图", ready_to_analyze: "图片已准备好", analyzing: "AI 正在识别一套主穿搭", awaiting_confirmation: "请确认识别标签", ready: "已按当前衣橱完成匹配", failed: "本次识别未完成，可补充截图重试" };
const mimeFromPath = (path) => /\.png(?:$|\?)/i.test(path) ? "image/png" : /\.webp(?:$|\?)/i.test(path) ? "image/webp" : "image/jpeg";
const idempotencyKey = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const messageId = () => `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const splitTags = (value, max = 4) => String(value || "").split(/[、,，/\s]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, max);
const hasXiaohongshuLink = (value) => /https?:\/\/(?:[^/]+\.)?(?:xiaohongshu\.com|xhslink\.(?:cn|com))\//i.test(value);
const defaultPreferences = () => ({ scene: "休闲", occasion: "", formalityPreference: "smart_casual", styles: [], preferredCategories: [], excludedCategories: [], preferredColors: [], excludedColors: [], warmthPreference: "normal" });
const FORMALITY_TEXT = { casual: "休闲", smart_casual: "得体休闲", business: "商务", semi_formal: "半正式", formal: "正式", athletic: "运动", outdoor: "户外" };
const preferenceTags = (preferences = {}) => [...new Set([
  preferences.occasion || preferences.scene,
  FORMALITY_TEXT[preferences.formalityPreference],
  ...(preferences.styles || []),
  ...(preferences.preferredCategories || []).map((category) => `想穿${category}`),
  ...(preferences.excludedCategories || []).map((category) => `不穿${category}`),
  ...(preferences.preferredColors || []).map((color) => `偏好${color}`),
  ...(preferences.excludedColors || []).map((color) => `避开${color}`),
  preferences.warmthPreference === "warmer" ? "更保暖" : preferences.warmthPreference === "cooler" ? "更清凉" : ""
].filter(Boolean))];
const relaxOptionsFor = (preferences = {}, recommendation = {}) => {
  if (!recommendation.missingText || /鞋子/.test(recommendation.missingText)) return [];
  const options = [];
  const nextFormality = { formal: ["semi_formal", "放宽为半正式"], semi_formal: ["business", "放宽为商务"], business: ["smart_casual", "放宽为得体休闲"] }[preferences.formalityPreference];
  if (nextFormality) options.push({ key: "formality", value: nextFormality[0], label: nextFormality[1] });
  if ((preferences.styles || []).length) options.push({ key: "styles", value: "", label: "先不限制风格" });
  if ((preferences.preferredColors || []).length) options.push({ key: "colors", value: "", label: "先不限制颜色" });
  if ((preferences.preferredCategories || []).length) options.push({ key: "categories", value: "", label: "先不限定品类" });
  return options.slice(0, 3);
};
const initialMessages = () => [{ id: messageId(), role: "assistant", type: "text", text: "把小红书链接发给我，或直接告诉我场景和想穿的风格。我只会从你的真实衣橱里推荐。" }];
const editableSlots = (record) => ((record?.detectedOutfit?.slots) || []).map((slot) => ({ ...slot, designDetailsText: (slot.designDetails || []).join("、"), stylesText: (slot.styles || []).join("、"), scenesText: (slot.scenes || []).join("、") }));
const candidateView = (candidate) => ({ ...candidate, key: candidate.item.id, reasonsText: (candidate.reasons || []).join(" · ") });
const recordView = (record) => {
  const matches = ((record?.matches) || []).map((group) => {
    const candidates = (group.candidates || []).map(candidateView);
    return { ...group, inspiration: { ...group.inspiration, designDetailsText: (group.inspiration?.designDetails || []).join("、"), stylesText: (group.inspiration?.styles || []).join("、") }, candidates, selected: candidates[0] || null };
  });
  const platformFallback = record?.status === "screenshot_required" && record.sourceType === "xiaohongshu_link";
  const analysisFallback = platformFallback && ["INSPIRATION_NO_OUTFIT", "INSPIRATION_AI_FAILED"].includes(record.errorCode);
  return record ? { ...record, matches, fallbackTitle: analysisFallback ? "公开图片未识别成功，请上传原笔记截图" : platformFallback ? "请补充一张原笔记截图" : "请换一张完整清晰的主穿搭截图", fallbackNote: platformFallback ? "平台可能限制公开访问。截图只保存在你的私密灵感历史中。" : "请尽量保留上装、下装或连衣裙的完整轮廓。" } : null;
};

Page({
  data: { demoReadonly: config.DEMO_READONLY, tab: "import", inputText: "", busy: false, messages: initialMessages(), record: null, editSlots: [], history: [], statusText, scrollIntoView: "" },
  onLoad() { this.sessionVersion = 1; this.context = this.emptyContext(); this.loadHistory(); },
  onShow() { if (this.getTabBar()) this.getTabBar().setData({ selected: 1 }); },
  onHide() { this.clearConversation(); },
  onUnload() { this.sessionVersion = (this.sessionVersion || 0) + 1; },
  emptyContext() { return { mode: "idle", preferences: defaultPreferences(), lockedItemIds: [], excludedItemIds: [], currentItems: [], currentRecordId: "", offset: 0, followupUsed: false, sourceShown: false }; },
  // 页面隐藏即结束临时会话；递增版本可让已经发出的异步请求失去回写资格。
  clearConversation() { this.sessionVersion = (this.sessionVersion || 0) + 1; this.context = this.emptyContext(); this.setData({ inputText: "", busy: false, messages: initialMessages(), record: null, editSlots: [], scrollIntoView: "" }); },
  isCurrent(version) { return version === this.sessionVersion; },
  onInput(event) { this.setData({ inputText: event.detail.value }); },
  showImport() { this.setData({ tab: "import" }); },
  showHistory() { this.setData({ tab: "history" }); this.loadHistory(); },

  appendMessage(message) {
    const next = [...this.data.messages.map((item) => item.actionable ? { ...item, actionable: false } : item), { id: messageId(), ...message }];
    const last = next[next.length - 1].id;
    this.setData({ messages: next, scrollIntoView: last });
  },
  addAssistant(text) { if (text) this.appendMessage({ role: "assistant", type: "text", text }); },
  showPreferenceState() { this.appendMessage({ role: "assistant", type: "state", tags: preferenceTags(this.context.preferences) }); },
  startProgress(text) { const id = messageId(); this.setData({ messages: [...this.data.messages, { id, role: "assistant", type: "progress", text }], scrollIntoView: id }); return id; },
  endProgress(id) { this.setData({ messages: this.data.messages.filter((message) => message.id !== id) }); },
  recentMessages() { return this.data.messages.filter((message) => message.type === "text" && ["user", "assistant"].includes(message.role)).slice(-10).map((message) => ({ role: message.role, content: message.text })); },
  async loadHistory() { try { const result = await api.listInspirations(); this.setData({ history: result.records || [] }); } catch {} },

  async sendMessage() {
    const text = this.data.inputText.trim();
    if (!text || this.data.busy) return;
    const version = this.sessionVersion;
    this.appendMessage({ role: "user", type: "text", text });
    this.setData({ inputText: "", busy: true });
    try { if (hasXiaohongshuLink(text)) await this.startLink(text, version); else await this.handleText(text, version); }
    finally { if (this.isCurrent(version)) this.setData({ busy: false }); }
  },

  async startLink(shareText, version = this.sessionVersion) {
    const progressId = this.startProgress("正在安全读取公开信息…");
    try {
      const record = await api.createInspiration({ sourceType: "xiaohongshu_link", shareText, idempotencyKey: idempotencyKey("xhs") });
      if (!this.isCurrent(version)) return;
      this.context = { ...this.emptyContext(), mode: "inspiration", currentRecordId: record.id };
      this.presentRecord(record);
      if (record.status === "ready_to_analyze") await this.analyzeRecord(record.id, version);
    } catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "链接处理失败，请改用截图。"); }
    finally { if (this.isCurrent(version)) { this.endProgress(progressId); this.loadHistory(); } }
  },

  chooseScreenshot() { if (!this.data.busy) wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: ({ tempFiles }) => this.uploadScreenshot(tempFiles[0]) }); },
  async uploadScreenshot(file) {
    if (!file || Number(file.size || 0) > 5 * 1024 * 1024) return wx.showToast({ title: "截图不能超过 5MB", icon: "none" });
    const version = this.sessionVersion; const progressId = this.startProgress("正在上传私密截图…"); this.setData({ busy: true });
    try {
      let record = this.data.record; let upload; const mimeType = mimeFromPath(file.tempFilePath);
      if (record && ["screenshot_required", "failed"].includes(record.status)) upload = await api.createInspirationScreenshotUpload(record.id, { mimeType, size: file.size });
      else { const created = await api.createInspiration({ sourceType: "user_screenshot", mimeType, idempotencyKey: idempotencyKey("shot") }); record = created.record; upload = created.upload; }
      await api.uploadBinary(upload, file.tempFilePath, mimeType);
      if (!this.isCurrent(version)) return;
      this.context = { ...this.context, mode: "inspiration", currentRecordId: record.id };
      await this.analyzeRecord(record.id, version);
    } catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "截图处理失败，请稍后重试。"); }
    finally { if (this.isCurrent(version)) { this.endProgress(progressId); this.setData({ busy: false }); this.loadHistory(); } }
  },
  async analyzeRecord(id, version = this.sessionVersion) {
    const progressId = this.startProgress("AI 正在选择并识别一套主穿搭…");
    try { const record = await api.analyzeInspiration(id); if (this.isCurrent(version)) this.presentRecord(record); }
    finally { if (this.isCurrent(version)) this.endProgress(progressId); }
  },
  presentRecord(rawRecord) {
    const record = recordView(rawRecord); this.setData({ record, editSlots: editableSlots(record) });
    if (!this.context.sourceShown && (record.sourceUrl || record.sourceTitle || record.screenshotUrl)) {
      this.context.sourceShown = true;
      this.appendMessage({ role: "assistant", type: "source", record });
    }
    if (["screenshot_required", "failed"].includes(record.status)) this.appendMessage({ role: "assistant", type: "screenshot", record, text: `${record.fallbackTitle}。${record.fallbackNote}` });
    else if (record.status === "awaiting_confirmation") this.appendMessage({ role: "assistant", type: "confirm", text: "我识别出了这套穿搭，请确认标签后再匹配你的衣橱。" });
    else if (record.status === "ready") this.appendInspirationRecommendation(record);
  },

  onSlotInput(event) { this.setData({ [`editSlots[${Number(event.currentTarget.dataset.index)}].${event.currentTarget.dataset.field}`]: event.detail.value }); },
  async confirmTags() {
    if (this.data.busy || !this.data.record) return;
    const version = this.sessionVersion;
    const slots = this.data.editSlots.map((slot) => ({ slot: slot.slot, category: slot.category, name: slot.name, color: slot.color, season: slot.season, thickness: slot.thickness, pattern: slot.pattern, designDetails: splitTags(slot.designDetailsText, 6), styles: splitTags(slot.stylesText), scenes: splitTags(slot.scenesText), confidence: slot.confidence, evidence: slot.evidence }));
    const progressId = this.startProgress("正在按当前衣橱匹配…"); this.setData({ busy: true });
    try { const record = await api.confirmInspiration(this.data.record.id, { summary: this.data.record.summary, slots }); if (this.isCurrent(version)) this.presentRecord(record); }
    catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "标签确认失败。"); }
    finally { if (this.isCurrent(version)) { this.endProgress(progressId); this.setData({ busy: false }); this.loadHistory(); } }
  },

  currentOutfitFacts() { return (this.context.currentItems || []).map((item) => ({ name: item.name, category: item.category, color: item.color, reasons: item.reasons || [] })); },
  previousUserMessage() { const users = this.data.messages.filter((message) => message.role === "user" && message.type === "text"); return users.length > 1 ? users[users.length - 2].text : ""; },
  applyItemDirectives(text) {
    const locked = new Set(this.context.lockedItemIds || []); const excluded = new Set(this.context.excludedItemIds || []);
    for (const clause of String(text).split(/[，,。；;、]/).map((part) => part.trim()).filter(Boolean)) {
      for (const item of this.context.currentItems || []) {
        if (!clause.includes(item.category) && !clause.includes(item.name)) continue;
        if (/(保留|留下|不要换)/.test(clause)) { locked.add(String(item.id)); excluded.delete(String(item.id)); }
        if (/(换掉|替换|不要|不喜欢)/.test(clause) && !/(不要换)/.test(clause)) { excluded.add(String(item.id)); locked.delete(String(item.id)); }
      }
    }
    this.context.lockedItemIds = [...locked]; this.context.excludedItemIds = [...excluded];
  },
  async handleText(text, version) {
    const progressId = this.startProgress("正在理解你的需求…");
    try {
      const result = await api.understandOutfitRequest({ message: text, previousMessage: this.previousUserMessage(), followupUsed: this.context.followupUsed, contextPreferences: this.context.preferences, currentCategories: (this.context.currentItems || []).map((item) => item.category), currentOutfitFacts: this.currentOutfitFacts(), recentMessages: this.recentMessages().slice(0, -1), idempotencyKey: idempotencyKey("chat") });
      if (!this.isCurrent(version)) return;
      const preferences = result.preferences || defaultPreferences(); this.context.preferences = preferences; this.context.followupUsed = this.context.followupUsed || preferences.needsClarification; this.applyItemDirectives(text);
      if (preferences.needsClarification) return this.addAssistant(preferences.question);
      if (preferences.action === "answer") return this.addAssistant(preferences.reply || "我只能依据当前真实衣物和已显示的推荐理由回答。");
      if (preferences.action === "reroll") { this.context.offset += 1; (this.context.currentItems || []).forEach((item) => { if (!this.context.lockedItemIds.includes(String(item.id))) this.context.excludedItemIds.push(String(item.id)); }); }
      if (preferences.reply) this.addAssistant(preferences.reply);
      if (preferences.action === "recommend") this.showPreferenceState();
      if (this.context.mode === "inspiration" && this.context.currentRecordId) await this.rematchInspiration(version); else await this.recommendFromText(version);
    } catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "这次没有理解成功，请换一种说法再试。"); }
    finally { if (this.isCurrent(version)) this.endProgress(progressId); }
  },
  async recommendFromText(version) {
    const location = weatherService.loadLocation();
    if (!location) return this.addAssistant("需要先设置所在地区，我才能通过天气安全筛选。请到天气页选择地区后再回来重新开始对话。");
    const [weatherData, items] = await Promise.all([api.getWeather(location.districtCode || location.cityCode || location.provinceCode), api.listItems()]);
    if (!this.isCurrent(version)) return;
    const weather = weatherService.effectiveWeather(weatherData, location);
    const preferences = { ...this.context.preferences, lockedItemIds: this.context.lockedItemIds, excludedItemIds: [...new Set(this.context.excludedItemIds)] };
    const recommendation = weatherService.recommend(items, weather, preferences.scene || "休闲", this.context.offset, preferences);
    this.context.mode = "outfit"; this.context.currentItems = (recommendation.items || []).map((item) => ({ ...item, reasons: [recommendation.reason] }));
    this.appendMessage({ role: "assistant", type: "outfit", actionable: true, items: this.context.currentItems, reason: recommendation.reason, missingText: recommendation.missingText, relaxOptions: relaxOptionsFor(preferences, recommendation) });
  },
  async relaxPreference(event) {
    if (this.data.busy) return;
    const { key, value, label } = event.currentTarget.dataset;
    const next = { ...this.context.preferences };
    if (key === "formality") next.formalityPreference = value;
    else if (key === "styles") next.styles = [];
    else if (key === "colors") next.preferredColors = [];
    else if (key === "categories") next.preferredCategories = [];
    else return;
    this.context.preferences = next;
    this.context.offset = 0;
    this.appendMessage({ role: "user", type: "text", text: label || "放宽这项条件" });
    this.showPreferenceState();
    const version = this.sessionVersion;
    this.setData({ busy: true });
    try { await this.recommendFromText(version); }
    catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "放宽后仍没有找到合适的完整搭配。"); }
    finally { if (this.isCurrent(version)) this.setData({ busy: false }); }
  },
  async rematchInspiration(version) {
    const record = await api.rematchInspiration(this.context.currentRecordId, { preferences: this.context.preferences, lockedItemIds: this.context.lockedItemIds, excludedItemIds: [...new Set(this.context.excludedItemIds)] });
    if (this.isCurrent(version)) this.appendInspirationRecommendation(recordView(record));
  },
  appendInspirationRecommendation(record) {
    const items = (record.matches || []).map((group) => group.selected ? ({ ...group.selected.item, reasons: group.selected.reasons || [], slot: group.slot }) : null).filter(Boolean);
    this.context.mode = "inspiration"; this.context.currentRecordId = record.id; this.context.currentItems = items; this.setData({ record });
    this.appendMessage({ role: "assistant", type: "inspiration", actionable: true, matches: record.matches || [], missingText: (record.missing || []).join("、") });
  },
  keepItem(event) { this.updateItemChoice(event.currentTarget.dataset.itemId, false); },
  replaceItem(event) { this.updateItemChoice(event.currentTarget.dataset.itemId, true); },
  async updateItemChoice(itemId, replace) {
    if (this.data.busy || !itemId) return;
    const item = (this.context.currentItems || []).find((entry) => String(entry.id) === String(itemId)); if (!item) return;
    const locked = new Set(this.context.lockedItemIds); const excluded = new Set(this.context.excludedItemIds);
    if (replace) { excluded.add(String(itemId)); locked.delete(String(itemId)); } else { locked.add(String(itemId)); excluded.delete(String(itemId)); }
    this.context.lockedItemIds = [...locked]; this.context.excludedItemIds = [...excluded];
    this.appendMessage({ role: "user", type: "text", text: replace ? `换掉${item.name}` : `保留${item.name}` });
    if (!replace) return this.addAssistant(`好的，我会保留${item.name}。`);
    const version = this.sessionVersion; this.setData({ busy: true });
    try { if (this.context.mode === "inspiration") await this.rematchInspiration(version); else await this.recommendFromText(version); }
    catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "暂时没有找到合适的替换衣物。"); }
    finally { if (this.isCurrent(version)) this.setData({ busy: false }); }
  },
  async openHistory(event) {
    const version = this.sessionVersion; this.setData({ busy: true, tab: "import" }); const progressId = this.startProgress("正在按当前衣橱重新匹配…");
    try { const record = await api.getInspiration(event.currentTarget.dataset.id); if (!this.isCurrent(version)) return; this.context = { ...this.emptyContext(), mode: "inspiration", currentRecordId: record.id }; this.appendMessage({ role: "user", type: "text", text: "打开这条私密灵感" }); this.presentRecord(record); }
    catch (error) { if (this.isCurrent(version)) this.addAssistant(error.message || "记录读取失败。"); }
    finally { if (this.isCurrent(version)) { this.endProgress(progressId); this.setData({ busy: false }); } }
  },
  deleteHistory(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: "删除这条私密灵感？", content: "记录和你上传的私密截图将一并删除，无法恢复。", confirmColor: "#a65e58", success: async ({ confirm }) => { if (!confirm) return; try { await api.deleteInspiration(id); await this.loadHistory(); wx.showToast({ title: "已删除", icon: "success" }); } catch (error) { wx.showToast({ title: error.message || "删除失败", icon: "none" }); } } });
  }
});
