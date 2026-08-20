const api = require("../../services/api");
const weatherService = require("../../services/weather");
const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];

Page({
  data: { location: null, weather: null, items: [], recommendation: null, error: "", scenes: SCENES, sceneIndex: 0, scene: SCENES[0], seenCoreKeys: [] },
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
      const recommendation = weatherService.recommend(items, weather, this.data.scene);
      this.setData({ weather, items, recommendation, seenCoreKeys: recommendation.selectedCoreKey ? [recommendation.selectedCoreKey] : [] });
    } catch (error) {
      this.setData({ error: error.message || "实时天气暂时无法获取，请稍后重试。" });
    }
  },
  generateOutfit(reset = false) {
    const { items, weather, scene, recommendation, seenCoreKeys } = this.data;
    const currentCoreItemIds = reset ? [] : (recommendation?.items || [])
      .filter((item) => !["外套", "夹克", "风衣"].includes(item.category))
      .map((item) => String(item.id));
    const next = weatherService.recommend(items, weather, scene, 0, {
      currentCoreItemIds,
      excludedCoreKeys: reset ? [] : seenCoreKeys
    });
    const nextSeen = reset ? [] : [...seenCoreKeys];
    if (next.selectedCoreKey && !nextSeen.includes(next.selectedCoreKey)) nextSeen.push(next.selectedCoreKey);
    this.setData({ recommendation: next, seenCoreKeys: nextSeen });
  },
  onSceneChange(event) {
    const sceneIndex = Number(event.detail.value);
    this.setData({ sceneIndex, scene: SCENES[sceneIndex], seenCoreKeys: [] });
    this.generateOutfit(true);
  },
  changeOutfit() {
    this.generateOutfit();
  },
  toCapsulePlan() { wx.navigateTo({ url: `/pages/capsule-plan/index?scene=${encodeURIComponent(this.data.scene)}` }); },
  chooseRegion() { wx.navigateTo({ url: "/pages/region-picker/index" }); },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  goBack() { wx.navigateBack(); }
});
