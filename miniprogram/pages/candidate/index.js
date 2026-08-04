const api = require("../../services/api");

Page({
  data: { candidateId: "", candidate: null, analysis: null, loading: true, error: "", message: "", decided: false, reviewingWait: false, imageLoadFailed: false },
  onLoad(options) {
    this.setData({ candidateId: options.id || "" });
    this.load();
  },
  async load() {
    if (!this.data.candidateId) {
      this.setData({ loading: false, error: "请先上传并确认一件候选新衣。" });
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const candidate = await api.getCandidate(this.data.candidateId);
      const analysis = await api.analyzeCandidate(candidate.id);
      this.setData({ candidate, analysis, reviewingWait: candidate.decision === "wait", decided: ["purchased", "declined"].includes(candidate.decision) });
    } catch (error) { this.setData({ error: error.message || "候选新衣分析暂不可用。" }); }
    finally { this.setData({ loading: false }); }
  },
  async decide(event) {
    if (this.data.decided) return;
    try {
      const decision = event.currentTarget.dataset.decision;
      await api.recordDecision(this.data.candidate.id, decision);
      const messages = { purchased: "已记录购买，这件衣物已加入衣橱。", wait: "已加入观望清单，7 天后可回来复盘。", declined: "已记录不买，本次不会加入衣橱。" };
      this.setData({ decided: true, message: messages[decision] });
    } catch (error) { this.setData({ message: error.message || "记录失败，请重试。" }); }
  },
  onImageError() { this.setData({ imageLoadFailed: true }); },
  startAnother() { wx.redirectTo({ url: "/pages/add-item/index?mode=candidate" }); }
});
