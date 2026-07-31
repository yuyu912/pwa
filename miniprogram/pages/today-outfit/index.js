const api = require("../../services/api");
const weatherService = require("../../services/weather");

Page({
  data: { location: null, weather: null, recommendation: null },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, weather: null, recommendation: null });
    const weather = weatherService.getDemoWeather(location);
    this.setData({ location, weather, recommendation: weatherService.recommend(await api.listItems(), weather) });
  },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  goBack() { wx.navigateBack(); }
});
