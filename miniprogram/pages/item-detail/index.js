const api = require("../../services/api");

Page({
  data: { item: null, scenes: ["通勤", "休闲", "约会", "旅行", "聚会", "运动"], scene: "通勤", note: "", saving: false, message: "" },
  async onLoad(options) {
    try { this.setData({ item: await api.getItem(options.id) }); }
    catch { this.setData({ item: null }); }
  },
  onScene(event) { this.setData({ scene: this.data.scenes[event.detail.value] }); },
  onNote(event) { this.setData({ note: event.detail.value }); },
  async saveWear() {
    if (!this.data.item) return;
    this.setData({ saving: true, message: "" });
    try {
      await api.addWearLog(this.data.item.id, { scene: this.data.scene, note: this.data.note, comfort: "待确认" });
      const item = await api.getItem(this.data.item.id);
      this.setData({ item, message: "已记录真实穿着；模拟模式下仅更新本地演示数据。" });
    } catch (error) { this.setData({ message: error.message || "记录失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  }
});
