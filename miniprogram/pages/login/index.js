const api = require("../../services/api");
const session = require("../../services/session");
const pendingShareToken = () => getApp().globalData.pendingOutfitToken || wx.getStorageSync("pending_outfit_token") || "";
const navigateAfterAuth = (sharedToken) => {
  if (sharedToken) return wx.redirectTo({ url: `/pages/friends/index?token=${encodeURIComponent(sharedToken)}` });
  return wx.switchTab({ url: "/pages/home/index" });
};

Page({
  data: { username: "", password: "", sharedToken: "", mode: "login", loading: false, error: "" },
  onLoad(options) {
    const sharedToken = options.token || pendingShareToken();
    if (sharedToken) getApp().globalData.pendingOutfitToken = sharedToken;
    this.setData({ sharedToken });
  },
  onShow() {
    const { user, token } = session.restore();
    if (user && token) navigateAfterAuth(this.data.sharedToken);
  },
  onUsername(event) { this.setData({ username: event.detail.value }); },
  onPassword(event) { this.setData({ password: event.detail.value }); },
  toggleMode() {
    const registering = this.data.mode === "register";
    this.setData({ mode: registering ? "login" : "register", error: "" });
  },
  async submit() {
    const registering = this.data.mode === "register";
    const { username, password } = this.data;
    const outfitToken = this.data.sharedToken;
    if (!username || !password) {
      this.setData({ error: "请填写用户名和密码。" });
      return;
    }
    if (registering && password.length < 8) {
      this.setData({ error: "注册密码至少需要 8 位。" });
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const result = registering
        ? outfitToken
          ? await api.registerOutfitGuest({ token: outfitToken, username, password })
          : await api.register({ username, password })
        : await api.login({ username, password });
      if (registering) {
        // 恢复码只在注册响应中返回一次；先让用户保存，再进入衣橱，避免账号无法找回。
        wx.showModal({
          title: "请保存恢复码",
          content: `恢复码：${result.recoveryCode || "未返回"}\n请截图或记录。它用于日后找回账号。`,
          confirmText: "我已保存",
          showCancel: false,
          success: () => navigateAfterAuth(outfitToken)
        });
      } else {
        navigateAfterAuth(this.data.sharedToken);
      }
    } catch (error) {
      this.setData({ error: error.message || "登录失败，请重试。" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
