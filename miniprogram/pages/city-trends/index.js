const api = require("../../services/api");
const weatherService = require("../../services/weather");
Page({
  data: { location: null, trend: null, error: "" },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, trend: null });
    this.setData({ location, error: "" });
    try { this.setData({ trend: await api.getCityTrends(location.cityCode || location.districtCode) }); }
    catch (error) { this.setData({ error: error.message || "城市趋势暂时不可用" }); }
  },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); }
});
