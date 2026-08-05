const api = require("../../services/api");
const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];

Page({
  data: { items: [], selectedIds: [], scenes: SCENES, sceneIndex: 0, note: "", submitting: false, error: "" },
  async onLoad() {
    try { this.setData({ items: (await api.listItems()).map((item) => ({ ...item, selected: false })) }); }
    catch (error) { this.setData({ error: error.message }); }
  },
  toggleItem(event) {
    const id = String(event.currentTarget.dataset.id);
    const selected = this.data.selectedIds.includes(id);
    if (!selected && this.data.selectedIds.length >= 5) return wx.showToast({ title: "最多选择 5 件", icon: "none" });
    const selectedIds = selected ? this.data.selectedIds.filter((item) => item !== id) : [...this.data.selectedIds, id];
    this.setData({ selectedIds, items: this.data.items.map((item) => ({ ...item, selected: selectedIds.includes(String(item.id)) })) });
  },
  onSceneChange(event) { this.setData({ sceneIndex: Number(event.detail.value) }); },
  onNoteInput(event) { this.setData({ note: event.detail.value.slice(0, 30) }); },
  async submit() {
    if (this.data.selectedIds.length < 2) return this.setData({ error: "请至少选择 2 件衣物。" });
    this.setData({ submitting: true, error: "" });
    try {
      await api.createCommunityPost({ itemIds: this.data.selectedIds, scene: SCENES[this.data.sceneIndex], note: this.data.note });
      wx.showModal({ title: "已提交审核", content: "审核通过后才会出现在灵感广场。", showCancel: false, success: () => wx.navigateBack() });
    } catch (error) { this.setData({ error: error.message || "发布失败，请稍后重试。", submitting: false }); }
  },
  goBack() { wx.navigateBack(); }
});
