const api = require("../../services/api");

const statusText = {
  resolving: "正在读取公开信息", screenshot_required: "链接暂时无法读取，请上传截图",
  ready_to_analyze: "图片已准备好", analyzing: "AI 正在识别一套主穿搭",
  awaiting_confirmation: "请确认识别标签", ready: "已按当前衣橱完成匹配",
  failed: "本次识别未完成，可补充截图重试"
};
const mimeFromPath = (path) => /\.png(?:$|\?)/i.test(path) ? "image/png" : /\.webp(?:$|\?)/i.test(path) ? "image/webp" : "image/jpeg";
const idempotencyKey = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const editableSlots = (record) => ((record?.detectedOutfit?.slots) || []).map((slot) => ({
  ...slot, designDetailsText: (slot.designDetails || []).join("、"), stylesText: (slot.styles || []).join("、"), scenesText: (slot.scenes || []).join("、")
}));
const splitTags = (value, max = 4) => String(value || "").split(/[、,，/\s]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, max);

Page({
  data: { tab: "import", shareText: "", busy: false, progressText: "", record: null, editSlots: [], history: [], statusText, errorText: "" },
  onLoad() { this.loadHistory(); },
  onShow() { if (this.getTabBar()) this.getTabBar().setData({ selected: 1 }); },
  onShareInput(event) { this.setData({ shareText: event.detail.value }); },
  showImport() { this.setData({ tab: "import" }); },
  showHistory() { this.setData({ tab: "history" }); this.loadHistory(); },

  async loadHistory() {
    try { const result = await api.listInspirations(); this.setData({ history: result.records || [] }); } catch {}
  },

  setRecord(record) {
    const matches = ((record?.matches) || []).map((group) => ({
      ...group,
      inspiration: { ...group.inspiration, designDetailsText: (group.inspiration?.designDetails || []).join("、"), stylesText: (group.inspiration?.styles || []).join("、") },
      candidates: (group.candidates || []).map((candidate) => ({ ...candidate, key: candidate.item.id, reasonsText: (candidate.reasons || []).join(" · ") }))
    }));
    const platformFallback = record?.status === "screenshot_required" && record.sourceType === "xiaohongshu_link";
    const analysisFallback = platformFallback && ["INSPIRATION_NO_OUTFIT", "INSPIRATION_AI_FAILED"].includes(record.errorCode);
    this.setData({
      record: record ? {
        ...record, matches,
        fallbackTitle: analysisFallback ? "公开图片未识别成功，请上传原笔记截图" : platformFallback ? "请补充一张原笔记截图" : "请换一张完整清晰的主穿搭截图",
        fallbackNote: platformFallback ? "平台可能限制公开访问。截图只保存在你的私密灵感历史中。" : "请尽量保留上装、下装或连衣裙的完整轮廓。"
      } : null,
      editSlots: editableSlots(record), errorText: ""
    });
  },

  resetImport() { this.setData({ tab: "import", record: null, editSlots: [], shareText: "", errorText: "" }); },

  async startLink() {
    const shareText = this.data.shareText.trim();
    if (!shareText || this.data.busy) return wx.showToast({ title: "请粘贴一条小红书分享文本", icon: "none" });
    this.setData({ busy: true, progressText: "正在安全读取公开信息…", errorText: "", record: null, editSlots: [] });
    try {
      const record = await api.createInspiration({ sourceType: "xiaohongshu_link", shareText, idempotencyKey: idempotencyKey("xhs") });
      this.setRecord(record);
      if (record.status === "ready_to_analyze") await this.analyzeRecord(record.id);
    } catch (error) { this.setData({ errorText: error.message || "链接处理失败，请改用截图。" }); }
    finally { this.setData({ busy: false, progressText: "" }); this.loadHistory(); }
  },

  chooseScreenshot() {
    if (this.data.busy) return;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], success: ({ tempFiles }) => this.uploadScreenshot(tempFiles[0]) });
  },

  async uploadScreenshot(file) {
    if (!file || Number(file.size || 0) > 5 * 1024 * 1024) return wx.showToast({ title: "截图不能超过 5MB", icon: "none" });
    const mimeType = mimeFromPath(file.tempFilePath);
    this.setData({ busy: true, progressText: "正在上传私密截图…", errorText: "" });
    try {
      let record = this.data.record; let upload;
      if (record && ["screenshot_required", "failed"].includes(record.status)) upload = await api.createInspirationScreenshotUpload(record.id, { mimeType, size: file.size });
      else { const created = await api.createInspiration({ sourceType: "user_screenshot", mimeType, idempotencyKey: idempotencyKey("shot") }); record = created.record; upload = created.upload; }
      await api.uploadBinary(upload, file.tempFilePath, mimeType);
      this.setRecord({ ...record, status: "ready_to_analyze" });
      await this.analyzeRecord(record.id);
    } catch (error) { this.setData({ errorText: error.message || "截图处理失败，请稍后重试。" }); }
    finally { this.setData({ busy: false, progressText: "" }); this.loadHistory(); }
  },

  async analyzeRecord(id) {
    this.setData({ busy: true, progressText: "AI 正在选择并识别一套主穿搭…" });
    this.setRecord(await api.analyzeInspiration(id));
  },

  onSlotInput(event) { this.setData({ [`editSlots[${Number(event.currentTarget.dataset.index)}].${event.currentTarget.dataset.field}`]: event.detail.value }); },

  async confirmTags() {
    if (this.data.busy || !this.data.record) return;
    const slots = this.data.editSlots.map((slot) => ({
      slot: slot.slot, category: slot.category, name: slot.name, color: slot.color, season: slot.season, thickness: slot.thickness, pattern: slot.pattern,
      designDetails: splitTags(slot.designDetailsText, 6), styles: splitTags(slot.stylesText), scenes: splitTags(slot.scenesText), confidence: slot.confidence, evidence: slot.evidence
    }));
    this.setData({ busy: true, progressText: "正在按当前衣橱重算…", errorText: "" });
    try { this.setRecord(await api.confirmInspiration(this.data.record.id, { summary: this.data.record.summary, slots })); wx.showToast({ title: "匹配完成", icon: "success" }); }
    catch (error) { this.setData({ errorText: error.message || "标签确认失败。" }); }
    finally { this.setData({ busy: false, progressText: "" }); this.loadHistory(); }
  },

  async openHistory(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ busy: true, progressText: "正在按当前衣橱重新匹配…", tab: "import", errorText: "" });
    try { this.setRecord(await api.getInspiration(id)); }
    catch (error) { this.setData({ errorText: error.message || "记录读取失败。" }); }
    finally { this.setData({ busy: false, progressText: "" }); }
  },

  deleteHistory(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "删除这条私密灵感？", content: "记录和你上传的私密截图将一并删除，无法恢复。", confirmColor: "#a65e58",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await api.deleteInspiration(id);
          if (this.data.record?.id === id) this.setData({ record: null, editSlots: [] });
          await this.loadHistory(); wx.showToast({ title: "已删除", icon: "success" });
        } catch (error) { wx.showToast({ title: error.message || "删除失败", icon: "none" }); }
      }
    });
  }
});
