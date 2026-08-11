const api = require("../../services/api");
const session = require("../../services/session");
const { findPlan, previewPlan } = require("../../utils/outfit-gallery");

Page({
  data: {
    plan: null,
    garments: [],
    loading: true,
    error: ""
  },

  onLoad(options = {}) {
    this.planId = options.id ? decodeURIComponent(options.id) : "";
  },

  onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.loadPlan();
  },

  async loadPlan() {
    if (!this.planId) return this.setData({ loading: false, error: "缺少搭配方案信息。" });
    this.setData({ loading: true, error: "" });
    try {
      const rawPlan = findPlan(await api.listOutfitPlans(), this.planId);
      if (!rawPlan) return this.setData({ loading: false, error: "这份搭配方案已不存在。" });
      const plan = previewPlan(rawPlan, { targetWidth: 88, targetHeight: 86, maxScale: 3.4 });
      this.setData({ plan, garments: plan.layers, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "搭配详情读取失败，请重试。" });
    }
  },

  onImageError(event) {
    const key = String(event.currentTarget.dataset.key || "");
    if (!this.data.plan || !key) return;
    const layers = this.data.plan.layers.map((layer) => layer.previewKey === key ? { ...layer, imageFailed: true } : layer);
    this.setData({ plan: { ...this.data.plan, layers }, garments: layers });
  },

  backToGallery() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.redirectTo({ url: "/pages/outfit-gallery/index" });
  }
});
