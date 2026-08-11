const api = require("../../services/api");
const session = require("../../services/session");
const { createLayer } = require("../../utils/outfit-canvas");
const { findPlan, previewPlan } = require("../../utils/outfit-gallery");
const WEAR_RECORD_PREVIEW_KEY = "wardrobloom_wear_record_preview";

Page({
  data: {
    plan: null,
    garments: [],
    isWearRecord: false,
    loading: true,
    error: ""
  },

  onLoad(options = {}) {
    this.planId = options.id ? decodeURIComponent(options.id) : "";
    this.recordId = options.recordId ? decodeURIComponent(options.recordId) : "";
    this.setData({ isWearRecord: Boolean(this.recordId) });
  },

  onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.loadPlan();
  },

  async loadPlan() {
    if (!this.planId && !this.recordId) return this.setData({ loading: false, error: "缺少搭配信息。" });
    this.setData({ loading: true, error: "" });
    try {
      let rawPlan;
      if (this.recordId) {
        let record;
        try {
          record = await api.getOutfitRecord(this.recordId);
        } catch (error) {
          // v40 云函数尚未提供详情接口时，先使用日历页刚加载的整套衣物进行只读预览。
          const fallback = wx.getStorageSync(WEAR_RECORD_PREVIEW_KEY);
          if (!fallback || String(fallback.id) !== this.recordId) throw error;
          record = fallback;
        }
        const canvas = record.canvas || { width: 320, height: 520 };
        const layers = Array.isArray(record.layers) && record.layers.length
          ? record.layers
          : (Array.isArray(record.items) ? record.items : []).map((item, index) => createLayer(item, index, canvas, `wear-${item.id}-${index}`));
        if (!layers.length) return this.setData({ loading: false, error: "这条穿着记录没有可展示的衣物。" });
        rawPlan = { ...record, id: `wear-${record.id}`, canvas, layers, updatedAt: record.wornAt, isWearRecord: true };
      } else {
        rawPlan = findPlan(await api.listOutfitPlans(), this.planId);
        if (!rawPlan) return this.setData({ loading: false, error: "这份搭配方案已不存在。" });
      }
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
    else wx.redirectTo({ url: this.recordId ? "/pages/wear-calendar/index" : "/pages/outfit-gallery/index" });
  }
});
