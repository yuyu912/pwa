const api = require("../../services/api");

Page({
  data: { posts: [], reports: [], loading: true, error: "" },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const result = await api.getCommunityReview();
      this.setData({ posts: result.posts || [], reports: result.reports || [], loading: false });
    } catch (error) { this.setData({ loading: false, error: error.message || "审核列表加载失败。" }); }
  },
  approve(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: "通过这条穿搭？", content: "通过后会立即出现在灵感广场。", success: async ({ confirm }) => {
      if (!confirm) return;
      try { await api.reviewCommunityPost(id, "approved"); wx.showToast({ title: "已通过" }); this.load(); }
      catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
    } });
  },
  reject(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: "拒绝发布", editable: true, placeholderText: "填写原因（最多100字）", success: async ({ confirm, content }) => {
      if (!confirm) return;
      try { await api.reviewCommunityPost(id, "rejected", content || "内容不符合发布规范"); wx.showToast({ title: "已拒绝" }); this.load(); }
      catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
    } });
  },
  resolveReport(event) {
    const id = event.currentTarget.dataset.id;
    wx.showActionSheet({ itemList: ["保留作品并关闭举报", "下架作品"], success: async ({ tapIndex }) => {
      try { await api.resolveCommunityReport(id, tapIndex === 1 ? "remove_post" : "dismiss"); wx.showToast({ title: "举报已处理" }); this.load(); }
      catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
    } });
  },
  goBack() { wx.navigateBack(); }
});
