const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { user: null, userInitial: "W", entitlement: null, loading: true, deleting: false, message: "", error: "" },
  async onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 3 });
    const restored = session.restore();
    if (!restored.token) return wx.redirectTo({ url: "/pages/login/index" });
    try {
      const result = await api.getMe();
      if (!result?.user?.username) throw new Error("账户信息不完整。");
      session.save({ user: result.user, token: restored.token });
      this.setData({ user: result.user, userInitial: String(result.user.username).slice(0, 1).toUpperCase(), loading: false, error: "" });
      try { this.setData({ entitlement: await api.getEntitlement() }); } catch {}
    } catch (error) {
      this.setData({ loading: false, error: error.message || "账户信息加载失败。" });
    }
  },
  loginAgain() { session.clear(); wx.reLaunch({ url: "/pages/login/index" }); },
  openPrivacy() { wx.navigateTo({ url: "/pages/privacy/index" }); },
  openAgreement() { wx.navigateTo({ url: "/pages/agreement/index" }); },
  openComplaint() { wx.navigateTo({ url: "/pages/complaint/index" }); },
  openPlans() { wx.navigateTo({ url: "/pages/plans/index" }); },
  openCommunityAdmin() { wx.navigateTo({ url: "/pages/community-admin/index" }); },
  logout() {
    wx.showModal({
      title: "退出登录",
      content: "退出只会清除这台手机上的登录状态，不会删除账号、衣橱或搭配记录。",
      confirmText: "确认退出",
      success: ({ confirm }) => {
        if (!confirm) return;
        session.clear();
        wx.reLaunch({ url: "/pages/login/index" });
      }
    });
  },
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
