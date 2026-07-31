const api = require("../../services/api");
const weatherService = require("../../services/weather");

Page({
  data: { location: null, weather: null, recommendation: null },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, weather: null, recommendation: null });
    const weather = weatherService.getDemoWeather(location);
    const recommendation = weatherService.recommend(await api.listItems(), weather);
    this.setData({ location, weather, recommendation });
  },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toOutfit() { wx.navigateTo({ url: "/pages/today-outfit/index" }); },
  goBack() { wx.navigateBack(); }
});
