const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { itemCount: 0 },
  async onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    try { this.setData({ itemCount: (await api.listItems()).length }); }
    catch { this.setData({ itemCount: 0 }); }
  },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  toCandidate() { wx.navigateTo({ url: "/pages/candidate/index" }); },
  toWeather() { wx.navigateTo({ url: "/pages/weather/index" }); },
  toTodayOutfit() { wx.navigateTo({ url: "/pages/today-outfit/index" }); },
  toAdd() { wx.navigateTo({ url: "/pages/add-item/index" }); },
  toFriends() { wx.navigateTo({ url: "/pages/friends/index" }); },
  toMine() { wx.showToast({ title: "个人中心将在账号联调后开放", icon: "none" }); }
});
