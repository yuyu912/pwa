const api = require("../../services/api");

Page({
  data: { items: [], loading: true, error: "", imageFailures: {} },
  onShow() { this.loadItems(); },
  async loadItems() {
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const items = (await api.listWaitingCandidates()).map((item) => ({
        ...item,
        waitText: item.waitDays > 0 ? `已观望 ${item.waitDays} 天` : "今天开始观望",
        statusText: item.coolingOffComplete ? "已满 7 天，可以重新复盘" : `冷静期还剩 ${item.daysRemaining} 天`
      }));
      this.setData({ items, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "观望清单加载失败。" });
    }
  },
  openCandidate(event) {
    wx.navigateTo({ url: `/pages/candidate/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  startAnalysis() { wx.navigateTo({ url: "/pages/add-item/index?mode=candidate" }); },
  onImageError(event) { this.setData({ [`imageFailures.${event.currentTarget.dataset.id}`]: true }); }
});
