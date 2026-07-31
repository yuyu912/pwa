const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { username: "", password: "", inviteCode: "", mode: "login", loading: false, error: "" },
  onShow() {
    const { user, token } = session.restore();
    if (user && token) wx.redirectTo({ url: "/pages/home/index" });
  },
  onUsername(event) { this.setData({ username: event.detail.value }); },
  onPassword(event) { this.setData({ password: event.detail.value }); },
  onInviteCode(event) { this.setData({ inviteCode: event.detail.value }); },
  toggleMode() {
    const registering = this.data.mode === "register";
    this.setData({ mode: registering ? "login" : "register", error: "" });
  },
  async submit() {
    const registering = this.data.mode === "register";
    const { username, password, inviteCode } = this.data;
    if (!username || !password || (registering && !inviteCode)) {
      this.setData({ error: registering ? "请填写邀请码、用户名和密码。" : "请填写用户名和密码。" });
      return;
    }
    if (registering && password.length < 8) {
      this.setData({ error: "注册密码至少需要 8 位。" });
      return;
    }
    this.setData({ loading: true, error: "" });
    try {
      const result = registering
        ? await api.register({ inviteCode, username, password })
        : await api.login({ username, password });
      if (registering) {
        // 恢复码只在注册响应中返回一次；先让用户保存，再进入衣橱，避免账号无法找回。
        wx.showModal({
          title: "请保存恢复码",
          content: `恢复码：${result.recoveryCode || "未返回"}\n请截图或记录。它用于日后找回账号。`,
          confirmText: "我已保存",
          showCancel: false,
          success: () => wx.redirectTo({ url: "/pages/home/index" })
        });
      } else {
        wx.redirectTo({ url: "/pages/home/index" });
      }
    } catch (error) {
      this.setData({ error: error.message || "登录失败，请重试。" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
