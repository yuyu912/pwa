const api = require("../../services/api");
const weatherService = require("../../services/weather");

Page({
  data: {
    location: null,
    liveWeather: null,
    weather: null,
    items: [],
    recommendation: null,
    loading: false,
    error: "",
    manualOpen: false,
    conditions: weatherService.WEATHER_CONDITIONS,
    manualCondition: "晴",
    manualTemperature: 20
  },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, liveWeather: null, weather: null, recommendation: null, error: "" });
    this.setData({ location, liveWeather: null, weather: null, recommendation: null, loading: true, error: "" });
    try {
      const [weatherData, items] = await Promise.all([
        api.getWeather(location.districtCode || location.cityCode || location.provinceCode),
        api.listItems()
      ]);
      const liveWeather = weatherService.formatLiveWeather(weatherData, location);
      const override = weatherService.loadWeatherOverride(location);
      const weather = weatherService.applyWeatherOverride(liveWeather, override);
      this.setData({
        liveWeather,
        weather,
        items,
        recommendation: weatherService.recommend(items, weather),
        loading: false,
        manualOpen: Boolean(override),
        manualCondition: weather.condition,
        manualTemperature: weather.temperature
      });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "实时天气暂时无法获取，请稍后重试。" });
    }
  },
  previewManual(condition, temperature) {
    const weather = weatherService.applyWeatherOverride(this.data.liveWeather, { condition, temperature });
    this.setData({
      weather,
      manualCondition: condition,
      manualTemperature: weather.temperature,
      recommendation: weatherService.recommend(this.data.items, weather)
    });
  },
  toggleManual() {
    if (!this.data.manualOpen) {
      this.setData({ manualOpen: true });
      return;
    }
    const override = weatherService.loadWeatherOverride(this.data.location);
    const weather = weatherService.applyWeatherOverride(this.data.liveWeather, override);
    this.setData({
      manualOpen: false,
      weather,
      manualCondition: weather.condition,
      manualTemperature: weather.temperature,
      recommendation: weatherService.recommend(this.data.items, weather)
    });
  },
  onConditionTap(event) {
    this.previewManual(event.currentTarget.dataset.condition, this.data.manualTemperature);
  },
  changeTemperature(event) {
    const delta = Number(event.currentTarget.dataset.delta);
    const temperature = Math.min(
      weatherService.MAX_TEMPERATURE,
      Math.max(weatherService.MIN_TEMPERATURE, this.data.manualTemperature + delta)
    );
    this.previewManual(this.data.manualCondition, temperature);
  },
  restoreLiveWeather() {
    weatherService.clearWeatherOverride();
    const weather = weatherService.applyWeatherOverride(this.data.liveWeather, null);
    this.setData({
      weather,
      manualOpen: false,
      manualCondition: weather.condition,
      manualTemperature: weather.temperature,
      recommendation: weatherService.recommend(this.data.items, weather)
    });
    wx.showToast({ title: "已恢复实时天气", icon: "none" });
  },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toOutfit() {
    if (this.data.manualOpen) {
      weatherService.saveWeatherOverride(
        this.data.location,
        this.data.manualCondition,
        this.data.manualTemperature
      );
    }
    wx.navigateTo({ url: "/pages/today-outfit/index" });
  },
  goBack() { wx.navigateBack(); }
});
