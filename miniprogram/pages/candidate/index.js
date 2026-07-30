const api = require("../../services/api");

Page({
  data: { candidate: null, analysis: null, loading: true, error: "", message: "" },
  onLoad() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const candidate = await api.createCandidate();
      const analysis = await api.analyzeCandidate(candidate.id);
      this.setData({ candidate, analysis });
    } catch (error) { this.setData({ error: error.message || "候选新衣分析暂不可用。" }); }
    finally { this.setData({ loading: false }); }
  },
  async decide(event) {
    try {
      await api.recordDecision(this.data.candidate.id, event.currentTarget.dataset.decision);
      this.setData({ message: event.currentTarget.dataset.decision === "purchased" ? "已记录购买决定；真实云端模式会按接口返回结果处理。" : "已记录观望决定，可稍后再次查看报告。" });
    } catch (error) { this.setData({ message: error.message || "记录失败，请重试。" }); }
  }
});
