const api = require("../../services/api");
const session = require("../../services/session");
const { previewPlan } = require("../../utils/outfit-gallery");

Page({
  data: {
    plans: [],
    loading: true,
    error: ""
  },

  onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.loadPlans();
  },

  async loadPlans() {
    this.setData({ loading: true, error: "" });
    try {
      const plans = (await api.listOutfitPlans()).map(previewPlan);
      this.setData({ plans, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "搭配方案读取失败，请重试。" });
    }
  },

  openPlan(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id) wx.navigateTo({ url: `/pages/outfit-detail/index?id=${encodeURIComponent(id)}` });
  },

  createPlan() {
    wx.navigateTo({ url: "/pages/outfit-canvas/index?mode=new" });
  },

  onImageError(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const plans = this.data.plans.map((plan) => ({
      ...plan,
      layers: plan.layers.map((layer) => layer.previewKey === key ? { ...layer, imageFailed: true } : layer)
    }));
    this.setData({ plans });
  }
});

module.exports = { previewPlan };
