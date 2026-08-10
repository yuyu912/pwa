const api = require("../../services/api");
const weatherService = require("../../services/weather");
const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];

Page({
  data: { location: null, weather: null, items: [], recommendation: null, error: "", scenes: SCENES, sceneIndex: 0, scene: SCENES[0], outfitOffset: 0 },
  async onShow() {
    const location = weatherService.loadLocation();
    if (!location) return this.setData({ location: null, weather: null, recommendation: null, error: "" });
    this.setData({ location, weather: null, recommendation: null, error: "" });
    try {
      const [weatherData, items] = await Promise.all([
        api.getWeather(location.districtCode || location.cityCode || location.provinceCode),
        api.listItems()
      ]);
      const weather = weatherService.effectiveWeather(weatherData, location);
      const recommendation = weatherService.recommend(items, weather, this.data.scene, this.data.outfitOffset);
      this.setData({ weather, items, recommendation });
    } catch (error) {
      this.setData({ error: error.message || "实时天气暂时无法获取，请稍后重试。" });
    }
  },
  generateOutfit() {
    const { items, weather, scene, outfitOffset } = this.data;
    this.setData({ recommendation: weatherService.recommend(items, weather, scene, outfitOffset) });
  },
  onSceneChange(event) {
    const sceneIndex = Number(event.detail.value);
    this.setData({ sceneIndex, scene: SCENES[sceneIndex], outfitOffset: 0 });
    this.generateOutfit();
  },
  changeOutfit() {
    this.setData({ outfitOffset: this.data.outfitOffset + 1 });
    this.generateOutfit();
  },
  toCapsulePlan() { wx.navigateTo({ url: `/pages/capsule-plan/index?scene=${encodeURIComponent(this.data.scene)}` }); },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  goBack() { wx.navigateBack(); }
});
