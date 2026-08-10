const api = require("../../services/api");
const session = require("../../services/session");
const canvasModel = require("../../utils/outfit-canvas");

const CATEGORIES = ["全部", "上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];

Page({
  data: {
    items: [],
    visibleItems: [],
    layers: [],
    categories: CATEGORIES,
    activeCategory: "全部",
    selectedKey: "",
    canvasWidth: 320,
    canvasHeight: 520,
    loading: true,
    error: "",
    savedText: "",
    pickerImageFailures: {}
  },

  onLoad() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.draftKey = `outfit_canvas_draft:${user.id || user._id || user.username}`;
    this.loadItems();
  },

  onReady() {
    wx.createSelectorQuery().in(this).select("#outfitCanvas").boundingClientRect((rect) => {
      if (rect?.width && rect?.height) this.setData({ canvasWidth: rect.width, canvasHeight: rect.height });
    }).exec();
  },

  onUnload() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDraft(true);
  },

  async loadItems() {
    this.setData({ loading: true, error: "" });
    try {
      const items = (await api.listItems()).filter((item) => item.idleStatus !== "considering" && item.idle_status !== "considering");
      let draft = null;
      try { draft = wx.getStorageSync(this.draftKey) || null; } catch {}
      const layers = canvasModel.restoreLayers(draft, items);
      this.setData({ items, visibleItems: items, layers, selectedKey: layers.length ? layers[layers.length - 1].key : "", loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "衣橱读取失败，请稍后重试。" });
    }
  },

  selectCategory(event) {
    const activeCategory = event.currentTarget.dataset.category;
    this.setData({
      activeCategory,
      visibleItems: activeCategory === "全部" ? this.data.items : this.data.items.filter((item) => item.category === activeCategory)
    });
  },

  addItem(event) {
    const itemId = String(event.currentTarget.dataset.id);
    const existing = this.data.layers.find((layer) => layer.itemId === itemId);
    if (existing) {
      this.setData({ selectedKey: existing.key, layers: canvasModel.reorderLayer(this.data.layers, existing.key, "front") });
      this.scheduleSave();
      return wx.showToast({ title: "已选中画布中的衣物", icon: "none" });
    }
    if (this.data.layers.length >= canvasModel.MAX_LAYERS) return wx.showToast({ title: "画布最多放 12 件衣物", icon: "none" });
    const item = this.data.items.find((entry) => String(entry.id) === itemId);
    if (!item) return;
    const key = `${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const layer = canvasModel.createLayer(item, this.data.layers.length, { width: this.data.canvasWidth, height: this.data.canvasHeight }, key);
    this.setData({ layers: [...this.data.layers, layer], selectedKey: key, savedText: "" });
    this.scheduleSave();
  },

  selectLayer(event) {
    const key = event.currentTarget.dataset.key;
    if (key && key !== this.data.selectedKey) this.setData({ selectedKey: key });
  },

  layerIndex(key) { return this.data.layers.findIndex((layer) => layer.key === key); },

  onLayerMove(event) {
    const key = event.currentTarget.dataset.key;
    const index = this.layerIndex(key);
    if (index < 0 || !["touch", "friction", "out-of-bounds"].includes(event.detail.source)) return;
    this.setData({ [`layers[${index}].x`]: event.detail.x, [`layers[${index}].y`]: event.detail.y, selectedKey: key, savedText: "" });
    this.scheduleSave();
  },

  onLayerScale(event) {
    const key = event.currentTarget.dataset.key;
    const index = this.layerIndex(key);
    if (index < 0) return;
    this.setData({ [`layers[${index}].scale`]: event.detail.scale, selectedKey: key, savedText: "" });
    this.scheduleSave();
  },

  rotateLeft() { this.rotate(-15); },
  rotateRight() { this.rotate(15); },
  shrinkSelected() { this.scaleSelected(-0.1); },
  growSelected() { this.scaleSelected(0.1); },
  scaleSelected(amount) {
    const index = this.layerIndex(this.data.selectedKey);
    if (index < 0) return;
    const scale = Math.max(
      canvasModel.MIN_SCALE,
      Math.min(canvasModel.MAX_SCALE, Number(this.data.layers[index].scale || 1) + amount)
    );
    this.setData({ [`layers[${index}].scale`]: Number(scale.toFixed(2)), savedText: "" });
    this.scheduleSave();
  },
  rotate(amount) {
    if (!this.data.selectedKey) return;
    this.setData({ layers: canvasModel.rotateLayer(this.data.layers, this.data.selectedKey, amount), savedText: "" });
    this.scheduleSave();
  },

  bringFront() { this.reorder("front"); },
  sendBack() { this.reorder("back"); },
  reorder(direction) {
    if (!this.data.selectedKey) return;
    this.setData({ layers: canvasModel.reorderLayer(this.data.layers, this.data.selectedKey, direction), savedText: "" });
    this.scheduleSave();
  },

  deleteSelected() {
    if (!this.data.selectedKey) return;
    const layers = this.data.layers.filter((layer) => layer.key !== this.data.selectedKey).map((layer, index) => ({ ...layer, z: index + 1 }));
    this.setData({ layers, selectedKey: layers.length ? layers[layers.length - 1].key : "", savedText: "" });
    this.scheduleSave();
  },

  clearCanvas() {
    if (!this.data.layers.length) return;
    wx.showModal({
      title: "清空画布",
      content: "将移除画布上的全部衣物，衣橱中的衣物不会被删除。",
      confirmText: "清空",
      confirmColor: "#9a6670",
      success: ({ confirm }) => {
        if (!confirm) return;
        this.setData({ layers: [], selectedKey: "", savedText: "" });
        this.saveDraft();
      }
    });
  },

  saveDraft(silent = false) {
    if (!this.draftKey) return;
    try {
      wx.setStorageSync(this.draftKey, canvasModel.serializeLayers(this.data.layers));
      if (!silent) this.setData({ savedText: this.data.layers.length ? "草稿已保存在本机" : "画布已清空" });
    } catch {
      if (!silent) this.setData({ savedText: "草稿保存失败，请保留当前页面" });
    }
  },

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveDraft(), 350);
  },

  onLayerImageError(event) {
    const index = this.layerIndex(event.currentTarget.dataset.key);
    if (index >= 0) this.setData({ [`layers[${index}].imageFailed`]: true });
  },

  onPickerImageError(event) {
    this.setData({ [`pickerImageFailures.${event.currentTarget.dataset.id}`]: true });
  },

  retry() { this.loadItems(); }
});
