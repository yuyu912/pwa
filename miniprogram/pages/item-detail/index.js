const api = require("../../services/api");
const CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const SEASONS = ["春夏", "春秋", "秋冬", "多季"];
const THICKNESSES = ["薄", "适中", "厚"];
const IDLE_REASONS = ["很少穿", "不合适", "重复", "风格变化", "其他"];
const listFromText = (value) => String(value || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 4);

function editFormFromItem(item) {
  return {
    name: item?.name || "",
    category: item?.category || "",
    color: item?.color || "",
    season: item?.season || "",
    thickness: item?.thickness || "",
    pattern: item?.pattern || "",
    material: item?.material || "",
    stylesText: (item?.styles || []).join("、"),
    scenesText: (item?.scenes || []).join("、"),
    price: item?.price ?? ""
  };
}

function normalizeItem(item) {
  // 详情页同时兼容云端 snake_case 与模拟数据 camelCase，不改变后端接口或数据库字段。
  return item ? {
    ...item,
    wearCount: Number(item.wearCount ?? item.wear_count ?? 0),
    idleStatus: item.idleStatus || item.idle_status || "active",
    idleReason: item.idleReason || item.idle_reason || "",
    idleNote: item.idleNote || item.idle_note || ""
  } : null;
}

function formatWearLog(log) {
  const date = log.wornAt ? new Date(log.wornAt) : null;
  const validDate = date && !Number.isNaN(date.getTime());
  return {
    ...log,
    dateText: validDate
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "日期未知"
  };
}

Page({
  data: {
    item: null,
    imageLoadFailed: false,
    scenes: ["通勤", "休闲", "约会", "旅行", "聚会", "运动"],
    comforts: ["舒适", "一般", "不舒适", "待确认"],
    scene: "通勤",
    comfort: "舒适",
    note: "",
    wearLogs: [],
    historyLoading: true,
    saving: false,
    editing: false,
    deleting: false,
    categories: CATEGORIES,
    seasons: SEASONS,
    thicknesses: THICKNESSES,
    categoryIndex: 0,
    seasonIndex: 0,
    thicknessIndex: 0,
    editForm: {},
    message: "",
    idleReasons: IDLE_REASONS,
    idleReasonIndex: 0,
    idleReason: IDLE_REASONS[0],
    idleNote: "",
    idleSaving: false,
    idleMessage: ""
  },
  async onLoad(options) {
    // 每次进入详情都重新读取衣物，以获取后端新生成的 COS 临时签名地址。
    try {
      const [item, wearLogs] = await Promise.all([api.getItem(options.id), api.getWearLogs(options.id)]);
      this.setData({
        item: normalizeItem(item),
        wearLogs: wearLogs.map(formatWearLog),
        historyLoading: false,
        imageLoadFailed: false
      });
    } catch {
      this.setData({ item: null, historyLoading: false });
    }
  },
  onImageError() {
    // 图片加载失败不改变衣物本身，只让当前页面显示颜色占位。
    this.setData({ imageLoadFailed: true });
  },
  startEdit() {
    const item = this.data.item;
    if (!item) return;
    this.setData({
      editing: true,
      message: "",
      editForm: editFormFromItem(item),
      categoryIndex: Math.max(0, CATEGORIES.indexOf(item.category)),
      seasonIndex: Math.max(0, SEASONS.indexOf(item.season)),
      thicknessIndex: Math.max(0, THICKNESSES.indexOf(item.thickness))
    });
  },
  cancelEdit() { this.setData({ editing: false, message: "" }); },
  onEditInput(event) { this.setData({ [`editForm.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onEditCategory(event) {
    const categoryIndex = Number(event.detail.value);
    this.setData({ categoryIndex, "editForm.category": CATEGORIES[categoryIndex] });
  },
  onEditSeason(event) {
    const seasonIndex = Number(event.detail.value);
    this.setData({ seasonIndex, "editForm.season": SEASONS[seasonIndex] });
  },
  onEditThickness(event) {
    const thicknessIndex = Number(event.detail.value);
    this.setData({ thicknessIndex, "editForm.thickness": THICKNESSES[thicknessIndex] });
  },
  async saveEdit() {
    if (!this.data.item || this.data.saving) return;
    const form = this.data.editForm;
    if (!form.category) return this.setData({ message: "请选择衣物品类。" });
    this.setData({ saving: true, message: "" });
    try {
      const item = await api.updateItem(this.data.item.id, {
        name: form.name,
        category: form.category,
        color: form.color,
        season: form.season,
        thickness: form.thickness,
        pattern: form.pattern,
        material: form.material,
        styles: listFromText(form.stylesText),
        scenes: listFromText(form.scenesText),
        price: form.price
      });
      this.setData({ item: normalizeItem(item), editing: false, message: "衣物信息已更新。" });
    } catch (error) { this.setData({ message: error.message || "保存失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  },
  deleteItem() {
    if (!this.data.item || this.data.deleting) return;
    wx.showModal({
      title: "移出衣橱",
      content: "衣物将不再参与天气推荐和新衣分析，穿着记录会保留。确定继续吗？",
      confirmText: "确认移出",
      confirmColor: "#9a6670",
      success: async ({ confirm }) => {
        if (!confirm) return;
        this.setData({ deleting: true, message: "" });
        try {
          await api.deleteItem(this.data.item.id);
          wx.showToast({ title: "已移出衣橱", icon: "success" });
          setTimeout(() => wx.redirectTo({ url: "/pages/wardrobe/index" }), 500);
        } catch (error) {
          this.setData({ deleting: false, message: error.message || "移出失败，请重试。" });
        }
      }
    });
  },
  onScene(event) { this.setData({ scene: this.data.scenes[event.detail.value] }); },
  onComfort(event) { this.setData({ comfort: this.data.comforts[event.detail.value] }); },
  onNote(event) { this.setData({ note: event.detail.value }); },
  async saveWear() {
    if (!this.data.item) return;
    this.setData({ saving: true, message: "" });
    try {
      await api.addWearLog(this.data.item.id, {
        scene: this.data.scene,
        comfort: this.data.comfort,
        note: this.data.note
      });
      // 保存后同时刷新衣物次数和历史，确保页面显示的是云端最终状态而不是本地猜测值。
      const [item, wearLogs] = await Promise.all([
        api.getItem(this.data.item.id),
        api.getWearLogs(this.data.item.id)
      ]);
      this.setData({
        item: normalizeItem(item),
        wearLogs: wearLogs.map(formatWearLog),
        note: "",
        message: "穿着记录已保存。"
      });
    } catch (error) { this.setData({ message: error.message || "记录失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  },
  onIdleReason(event) {
    const idleReasonIndex = Number(event.detail.value);
    this.setData({ idleReasonIndex, idleReason: IDLE_REASONS[idleReasonIndex] });
  },
  onIdleNote(event) { this.setData({ idleNote: event.detail.value }); },
  async markIdle() {
    if (!this.data.item || this.data.idleSaving) return;
    this.setData({ idleSaving: true, idleMessage: "" });
    try {
      const item = await api.markItemIdle(this.data.item.id, { reason: this.data.idleReason, note: this.data.idleNote });
      this.setData({ item: normalizeItem(item), idleNote: "", idleMessage: "已加入私人闲置清单。" });
    } catch (error) { this.setData({ idleMessage: error.message || "闲置标记失败，请重试。" }); }
    finally { this.setData({ idleSaving: false }); }
  },
  async restoreIdle() {
    if (!this.data.item || this.data.idleSaving) return;
    this.setData({ idleSaving: true, idleMessage: "" });
    try {
      const item = await api.restoreIdleItem(this.data.item.id);
      this.setData({ item: normalizeItem(item), idleMessage: "已恢复为正常使用。" });
    } catch (error) { this.setData({ idleMessage: error.message || "恢复失败，请重试。" }); }
    finally { this.setData({ idleSaving: false }); }
  }
});
