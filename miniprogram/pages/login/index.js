const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { username: "演示用户", password: "", loading: false, error: "" },
  onShow() {
    const { user, token } = session.restore();
    if (user && token) wx.redirectTo({ url: "/pages/wardrobe/index" });
  },
  onUsername(event) { this.setData({ username: event.detail.value }); },
  onPassword(event) { this.setData({ password: event.detail.value }); },
  async submit() {
    this.setData({ loading: true, error: "" });
    try {
      await api.login({ username: this.data.username, password: this.data.password });
      wx.redirectTo({ url: "/pages/wardrobe/index" });
    } catch (error) {
      this.setData({ error: error.message || "登录失败，请重试。" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
