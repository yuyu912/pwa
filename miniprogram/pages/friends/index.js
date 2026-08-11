const api = require("../../services/api");
const session = require("../../services/session");

const verdicts = [
  { value: "like", label: "好看" },
  { value: "neutral", label: "一般" },
  { value: "dislike", label: "不建议" }
];
function consumePendingShareToken() {
  const app = getApp();
  const token = app.globalData.pendingOutfitToken || wx.getStorageSync("pending_outfit_token") || "";
  app.globalData.pendingOutfitToken = "";
  wx.removeStorageSync("pending_outfit_token");
  return token;
}

Page({
  data: {
    token: "", items: [], selectedIds: [], question: "这套搭配适合我吗？", loading: true, saving: false,
    error: "", message: "", activeRequest: null, guestRequest: null, results: null,
    verdicts, verdict: "like", comment: "", reportReason: "", restoreCode: ""
  },
  onLoad(options) {
    // 分享入口只消费一次；本人以前创建的请求必须通过页面上的口令恢复，不能劫持普通入口。
    const token = options.token || consumePendingShareToken();
    if (options.token) consumePendingShareToken();
    this.setData({ token });
    wx.showShareMenu({ withShareTicket: false });
  },
  onShow() { this.load(); },
  async load() {
    const { user, token } = session.restore();
    if (!user || !token) {
      if (this.data.token) return wx.redirectTo({ url: `/pages/login/index?token=${encodeURIComponent(this.data.token)}` });
      return wx.redirectTo({ url: "/pages/login/index" });
    }
    this.setData({ loading: true, error: "" });
    try {
      if (this.data.token) {
        const guestRequest = await api.getOutfitRequest(this.data.token);
        if (guestRequest.isOwner) {
          const results = await api.getOutfitResults(guestRequest.id);
          this.setData({ activeRequest: { ...guestRequest, token: this.data.token }, results, guestRequest: null });
        } else {
          this.setData({ guestRequest, activeRequest: null, results: null, verdict: guestRequest.ownResponse?.verdict || "like", comment: guestRequest.ownResponse?.comment || "" });
        }
      } else {
        const items = (await api.listItems()).map((item) => ({ ...item, selected: this.data.selectedIds.includes(String(item.id)) }));
        this.setData({ items, activeRequest: null, guestRequest: null, results: null });
      }
    } catch (error) { this.setData({ error: error.message || "好友帮搭暂时不可用。" }); }
    finally { this.setData({ loading: false }); }
  },
  toggleItem(event) {
    const id = String(event.currentTarget.dataset.id);
    const selectedIds = this.data.selectedIds.includes(id)
      ? this.data.selectedIds.filter((item) => item !== id)
      : this.data.selectedIds.length >= 5 ? this.data.selectedIds : [...this.data.selectedIds, id];
    this.setData({
      selectedIds,
      items: this.data.items.map((item) => ({ ...item, selected: selectedIds.includes(String(item.id)) })),
      error: selectedIds.length >= 5 ? "最多分享 5 件衣物。" : ""
    });
  },
  onQuestion(event) { this.setData({ question: event.detail.value }); },
  onRestoreCode(event) { this.setData({ restoreCode: event.detail.value }); },
  pasteRestoreCode() {
    wx.getClipboardData({
      success: ({ data }) => {
        const restoreCode = String(data || "").trim();
        this.setData({ restoreCode, error: restoreCode ? "" : "剪贴板里没有内容。" });
      },
      fail: () => this.setData({ error: "无法读取剪贴板，请长按输入框手动粘贴。" })
    });
  },
  onComment(event) { this.setData({ comment: event.detail.value }); },
  selectVerdict(event) { this.setData({ verdict: event.currentTarget.dataset.value }); },
  async createRequest() {
    if (!this.data.selectedIds.length || !this.data.question.trim()) return this.setData({ error: "请选择衣物并填写想问好友的问题。" });
    this.setData({ saving: true, error: "" });
    try {
      const activeRequest = await api.createOutfitRequest({ itemIds: this.data.selectedIds, question: this.data.question });
      wx.setStorageSync("owner_outfit_token", activeRequest.token);
      this.setData({ activeRequest, token: activeRequest.token, message: "搭配请求已创建，点击右上角分享给好友。" });
      wx.showShareMenu({ withShareTicket: false });
    } catch (error) { this.setData({ error: error.message || "创建失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  },
  onShareAppMessage() {
    if (!this.data.activeRequest?.token) return { title: "Wardrobloom" };
    return {
      title: "想请你帮我看看这套搭配",
      path: `/pages/friends/index?token=${encodeURIComponent(this.data.activeRequest.token)}`
    };
  },
  copyInviteCode() {
    const token = this.data.activeRequest?.token || this.data.token;
    if (!token) return this.setData({ error: "当前请求缺少分享口令，请重新创建。" });
    wx.setClipboardData({
      data: `搭配:${token}`,
      success: () => this.setData({ message: "好友帮搭口令已复制。请通过微信文字消息发给好友。" })
    });
  },
  openByInviteCode() {
    const match = String(this.data.restoreCode || "").trim().match(/^(?:搭配|OUTFIT)[:：](.+)$/i);
    if (!match) return this.setData({ error: "请粘贴包含“搭配:”开头的完整好友帮搭口令。" });
    const token = match[1].trim();
    wx.setStorageSync("owner_outfit_token", token);
    this.setData({ token, error: "", message: "" });
    this.load();
  },
  async submitReply() {
    if (!this.data.comment.trim()) return this.setData({ error: "请写一句不超过 200 字的建议。" });
    this.setData({ saving: true, error: "" });
    try {
      const payload = { verdict: this.data.verdict, comment: this.data.comment };
      if (this.data.guestRequest.ownResponse) await api.updateOutfitReply(this.data.token, payload);
      else await api.replyToOutfitRequest(this.data.token, payload);
      this.setData({ message: "建议已保存，发起人可以看到你的回复。" });
      await this.load();
    } catch (error) { this.setData({ error: error.message || "提交失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  },
  async closeRequest() {
    if (!this.data.activeRequest) return;
    this.setData({ saving: true, error: "" });
    try {
      await api.closeOutfitRequest(this.data.activeRequest.id);
      this.setData({ message: "已关闭分享，旧链接不能再提交建议。" });
      await this.load();
    } catch (error) { this.setData({ error: error.message || "关闭失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  },
  async reportReply(event) {
    const id = event.currentTarget.dataset.id;
    try {
      await api.reportOutfitReply(id, "发起人举报不当短评");
      this.setData({ message: "该短评已隐藏并进入处理队列。" });
      await this.load();
    } catch (error) { this.setData({ error: error.message || "举报失败。" }); }
  },
  startNew() { wx.removeStorageSync("owner_outfit_token"); this.setData({ token: "", selectedIds: [], activeRequest: null, guestRequest: null, results: null, message: "", restoreCode: "" }); this.load(); },
  goHome() { wx.reLaunch({ url: "/pages/home/index" }); }
});
