const api = require("../../services/api");
const { buildCapsulePlan } = require("../../utils/capsule-plan");

const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];

Page({
  data: { scenes: SCENES, sceneIndex: 0, scene: SCENES[0], items: [], offset: 0, plan: null, loading: true, error: "" },
  onLoad(query) {
    const scene = decodeURIComponent(query.scene || "");
    const sceneIndex = Math.max(0, SCENES.indexOf(scene));
    this.setData({ sceneIndex, scene: SCENES[sceneIndex] });
  },
  async onShow() {
    try {
      const items = await api.listItems();
      this.setData({ items, loading: false, error: "" });
      this.generatePlan();
    } catch {
      this.setData({ loading: false, error: "暂时无法读取衣橱，请稍后重试。" });
    }
  },
  generatePlan() {
    this.setData({ plan: buildCapsulePlan(this.data.items, this.data.scene, this.data.offset) });
  },
  onSceneChange(event) {
    const sceneIndex = Number(event.detail.value);
    this.setData({ sceneIndex, scene: SCENES[sceneIndex], offset: 0 });
    this.generatePlan();
  },
  changePlan() {
    this.setData({ offset: this.data.offset + 1 });
    this.generatePlan();
  },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  goBack() { wx.navigateBack(); }
});
