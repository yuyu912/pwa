const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { user: null, loading: true, deleting: false, message: "", error: "" },
  async onShow() {
    const restored = session.restore();
    if (!restored.token) return wx.redirectTo({ url: "/pages/login/index" });
    try {
      const result = await api.getMe();
      if (!result?.user?.username) throw new Error("账户信息不完整。");
      session.save({ user: result.user, token: restored.token });
      this.setData({ user: result.user, loading: false, error: "" });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "账户信息加载失败。" });
    }
  },
  loginAgain() { session.clear(); wx.reLaunch({ url: "/pages/login/index" }); },
  openPrivacy() { wx.navigateTo({ url: "/pages/privacy/index" }); },
  openAgreement() { wx.navigateTo({ url: "/pages/agreement/index" }); },
  openComplaint() { wx.navigateTo({ url: "/pages/complaint/index" }); },
  openCommunityAdmin() { wx.navigateTo({ url: "/pages/community-admin/index" }); },
  requestDeletion() {
    wx.showModal({ title: "停用并申请删除账号", content: "账号和现有登录凭证将立即停用，关联数据进入最长 30 天的人工核验与删除处理。提交后不能自行恢复。", confirmText: "确认停用", confirmColor: "#a95568", success: async ({ confirm }) => {
      if (!confirm) return;
      this.setData({ deleting: true, message: "" });
      try {
        await api.requestAccountDeletion();
        session.clear();
        wx.reLaunch({ url: "/pages/login/index" });
      } catch (error) { this.setData({ message: error.message || "提交删除申请失败。" }); }
      finally { this.setData({ deleting: false }); }
    }});
  }
});
