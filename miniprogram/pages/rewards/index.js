const api = require("../../services/api");

Page({
  data: { summary: null, loading: true, error: "" },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      this.setData({ summary: await api.getRewards(), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "成长记录加载失败，请稍后重试。" });
    }
  },
  explainExchange() {
    wx.showModal({ title: "兑换暂未开放", content: "当前阶段只记录星星发行量和理论成本，不会扣除星星或增加 AI 次数。", showCancel: false });
  },
  goBack() { wx.navigateBack(); }
});
