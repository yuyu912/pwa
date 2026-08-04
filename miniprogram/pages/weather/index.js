const api = require("../../services/api");
const weatherService = require("../../services/weather");

Page({
  data: { location: null, weather: null, recommendation: null, loading: false, error: "" },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, weather: null, recommendation: null, error: "" });
    this.setData({ location, weather: null, recommendation: null, loading: true, error: "" });
    try {
      const [weatherData, items] = await Promise.all([
        api.getWeather(location.districtCode || location.cityCode || location.provinceCode),
        api.listItems()
      ]);
      const weather = weatherService.formatLiveWeather(weatherData, location);
      this.setData({ weather, recommendation: weatherService.recommend(items, weather), loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "实时天气暂时无法获取，请稍后重试。" });
    }
  },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toOutfit() { wx.navigateTo({ url: "/pages/today-outfit/index" }); },
  goBack() { wx.navigateBack(); }
});
