const api = require("../../services/api");

const TABS = [
  { id: "feed", label: "灵感广场" },
  { id: "mine", label: "我的发布" },
  { id: "ranking", label: "本周榜" }
];

Page({
  data: { tabs: TABS, tab: "feed", posts: [], loading: false, error: "" },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const result = this.data.tab === "ranking" ? await api.getCommunityRanking() : await api.listCommunityPosts(this.data.tab);
      this.setData({ posts: result.posts || [], loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "灵感广场暂时无法加载。" });
    }
  },
  changeTab(event) { this.setData({ tab: event.currentTarget.dataset.id, posts: [] }); this.load(); },
  toCreate() { wx.navigateTo({ url: "/pages/community-create/index" }); },
  async toggleLike(event) {
    const post = this.data.posts.find((item) => String(item.id) === String(event.currentTarget.dataset.id));
    if (!post || post.isMine) return wx.showToast({ title: "不能给自己的作品点赞", icon: "none" });
    try {
      const result = await api.setCommunityLike(post.id, post.liked ? "unlike" : "like");
      this.setData({ posts: this.data.posts.map((item) => item.id === post.id ? { ...item, liked: result.liked, likeCount: result.likeCount } : item) });
    } catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
  },
  report(event) {
    const id = event.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ["不当内容", "广告或联系方式", "冒用他人作品", "其他"],
      success: async ({ tapIndex }) => {
        try { await api.reportCommunityPost(id, ["不当内容", "广告或联系方式", "冒用他人作品", "其他"][tapIndex]); wx.showToast({ title: "已提交举报" }); }
        catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
      }
    });
  },
  remove(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: "下架这条穿搭？", content: "下架后不会继续出现在灵感广场。", success: async ({ confirm }) => {
      if (!confirm) return;
      try { await api.removeCommunityPost(id); this.load(); }
      catch (error) { wx.showToast({ title: error.message, icon: "none" }); }
    } });
  },
  goBack() { wx.navigateBack(); }
});
