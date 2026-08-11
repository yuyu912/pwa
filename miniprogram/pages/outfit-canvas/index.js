const api = require("../../services/api");
const session = require("../../services/session");
const canvasModel = require("../../utils/outfit-canvas");

const CATEGORIES = ["全部", "上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const SCENES = ["未填写", "休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const pad = (value) => String(value).padStart(2, "0");
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const idempotencyKey = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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
    pickerImageFailures: {},
    plans: [],
    plansError: "",
    currentPlanId: "",
    currentPlanTitle: "",
    planDirty: false,
    planBusy: false,
    wearFormVisible: false,
    today: localDate(),
    wearDate: localDate(),
    wearScenes: SCENES,
    wearSceneIndex: 0,
    wearNote: "",
    exporting: false
  },

  onLoad(options = {}) {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.draftKey = `outfit_canvas_draft:${user.id || user._id || user.username}`;
    this.startBlank = options.mode === "new";
    if (this.startBlank) {
      try { wx.setStorageSync(this.draftKey, canvasModel.serializeLayers([])); } catch {}
    }
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
      let plans = [];
      let plansError = "";
      try { plans = await api.listOutfitPlans(); }
      catch { plansError = "搭配方案需在新 Schema 和云函数部署后使用，当前画布仍可编辑。"; }
      let draft = null;
      if (!this.startBlank) try { draft = wx.getStorageSync(this.draftKey) || null; } catch {}
      const layers = canvasModel.restoreLayers(draft, items);
      this.setData({ items, visibleItems: items, layers, plans, plansError, selectedKey: layers.length ? layers[layers.length - 1].key : "", loading: false });
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
      this.setData({ selectedKey: existing.key, layers: canvasModel.reorderLayer(this.data.layers, existing.key, "front"), planDirty: true });
      this.scheduleSave();
      return wx.showToast({ title: "已选中画布中的衣物", icon: "none" });
    }
    if (this.data.layers.length >= canvasModel.MAX_LAYERS) return wx.showToast({ title: "画布最多放 12 件衣物", icon: "none" });
    const item = this.data.items.find((entry) => String(entry.id) === itemId);
    if (!item) return;
    const key = `${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const layer = canvasModel.createLayer(item, this.data.layers.length, { width: this.data.canvasWidth, height: this.data.canvasHeight }, key);
    this.setData({ layers: [...this.data.layers, layer], selectedKey: key, savedText: "", planDirty: true });
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
    this.setData({ [`layers[${index}].x`]: event.detail.x, [`layers[${index}].y`]: event.detail.y, selectedKey: key, savedText: "", planDirty: true });
    this.scheduleSave();
  },

  onLayerScale(event) {
    const key = event.currentTarget.dataset.key;
    const index = this.layerIndex(key);
    if (index < 0) return;
    this.setData({ [`layers[${index}].scale`]: event.detail.scale, selectedKey: key, savedText: "", planDirty: true });
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
    this.setData({ [`layers[${index}].scale`]: Number(scale.toFixed(2)), savedText: "", planDirty: true });
    this.scheduleSave();
  },
  rotate(amount) {
    if (!this.data.selectedKey) return;
    this.setData({ layers: canvasModel.rotateLayer(this.data.layers, this.data.selectedKey, amount), savedText: "", planDirty: true });
    this.scheduleSave();
  },

  bringFront() { this.reorder("front"); },
  sendBack() { this.reorder("back"); },
  reorder(direction) {
    if (!this.data.selectedKey) return;
    this.setData({ layers: canvasModel.reorderLayer(this.data.layers, this.data.selectedKey, direction), savedText: "", planDirty: true });
    this.scheduleSave();
  },

  deleteSelected() {
    if (!this.data.selectedKey) return;
    const layers = this.data.layers.filter((layer) => layer.key !== this.data.selectedKey).map((layer, index) => ({ ...layer, z: index + 1 }));
    this.setData({ layers, selectedKey: layers.length ? layers[layers.length - 1].key : "", savedText: "", planDirty: true });
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
        this.setData({ layers: [], selectedKey: "", savedText: "", planDirty: true });
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

  async savePlan() {
    if (!this.data.layers.length || this.data.planBusy) return wx.showToast({ title: "请先添加衣物", icon: "none" });
    this.setData({ planBusy: true });
    try {
      const layout = canvasModel.buildPlanPayload(this.data.layers, { width: this.data.canvasWidth, height: this.data.canvasHeight });
      let saved;
      if (this.data.currentPlanId) saved = await api.updateOutfitPlan(this.data.currentPlanId, layout);
      else {
        this.pendingPlanKey = this.pendingPlanKey || idempotencyKey("outfit-plan");
        saved = await api.createOutfitPlan({ ...layout, idempotencyKey: this.pendingPlanKey });
        this.pendingPlanKey = "";
      }
      const plans = [saved, ...this.data.plans.filter((plan) => plan.id !== saved.id)];
      this.setData({ plans, currentPlanId: saved.id, currentPlanTitle: saved.title, planDirty: false, planBusy: false, savedText: "搭配方案已保存" });
    } catch (error) {
      this.setData({ planBusy: false });
      wx.showToast({ title: error.message || "搭配保存失败", icon: "none" });
    }
  },

  loadPlan(event) {
    const plan = this.data.plans.find((entry) => entry.id === event.currentTarget.dataset.id);
    if (!plan) return;
    const layers = canvasModel.restoreLayers(plan, this.data.items);
    this.setData({
      layers,
      selectedKey: layers.length ? layers[layers.length - 1].key : "",
      currentPlanId: plan.id,
      currentPlanTitle: plan.title,
      planDirty: false,
      wearFormVisible: false,
      savedText: "已打开保存的搭配"
    });
    this.saveDraft(true);
  },

  newPlan() {
    wx.showModal({
      title: "新建搭配",
      content: "新建后将清空当前画布，已经保存的搭配方案不受影响。",
      confirmText: "新建",
      success: ({ confirm }) => {
        if (!confirm) return;
        this.pendingPlanKey = "";
        this.setData({ layers: [], selectedKey: "", currentPlanId: "", currentPlanTitle: "", planDirty: false, wearFormVisible: false, savedText: "" });
        this.saveDraft(true);
      }
    });
  },

  renamePlan(event) {
    const id = event.currentTarget.dataset.id;
    const plan = this.data.plans.find((entry) => entry.id === id);
    if (!plan || this.data.planBusy) return;
    wx.showModal({
      title: "重命名搭配方案",
      editable: true,
      placeholderText: "输入1～30个字",
      content: plan.title,
      success: async ({ confirm, content }) => {
        if (!confirm) return;
        const title = String(content || "").trim();
        if (!title) return wx.showToast({ title: "请输入方案名称", icon: "none" });
        this.setData({ planBusy: true });
        try {
          const renamed = await api.renameOutfitPlan(id, title);
          this.setData({
            plans: this.data.plans.map((entry) => entry.id === id ? renamed : entry),
            currentPlanTitle: this.data.currentPlanId === id ? renamed.title : this.data.currentPlanTitle,
            planBusy: false
          });
          wx.showToast({ title: "已重命名", icon: "success" });
        } catch (error) {
          this.setData({ planBusy: false });
          wx.showToast({ title: error.message || "重命名失败", icon: "none" });
        }
      }
    });
  },

  async copyPlan(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.plans.some((entry) => entry.id === id) || this.data.planBusy) return;
    this.setData({ planBusy: true });
    try {
      const copied = await api.copyOutfitPlan(id, { idempotencyKey: idempotencyKey(`outfit-plan-copy-${id}`) });
      this.setData({ plans: [copied, ...this.data.plans], planBusy: false });
      wx.showToast({ title: "已复制", icon: "success" });
    } catch (error) {
      this.setData({ planBusy: false });
      wx.showToast({ title: error.message || "复制失败", icon: "none" });
    }
  },

  deletePlan(event) {
    const id = event.currentTarget.dataset.id;
    const plan = this.data.plans.find((entry) => entry.id === id);
    if (!plan) return;
    wx.showModal({
      title: "删除搭配方案",
      content: "只删除这份方案，已经记入日历的穿着历史不会删除。",
      confirmText: "删除",
      confirmColor: "#9a6670",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await api.deleteOutfitPlan(id);
          const deletingCurrent = id === this.data.currentPlanId;
          this.setData({
            plans: this.data.plans.filter((entry) => entry.id !== id),
            currentPlanId: deletingCurrent ? "" : this.data.currentPlanId,
            currentPlanTitle: deletingCurrent ? "" : this.data.currentPlanTitle,
            planDirty: deletingCurrent ? Boolean(this.data.layers.length) : this.data.planDirty,
            wearFormVisible: deletingCurrent ? false : this.data.wearFormVisible
          });
        } catch (error) { wx.showToast({ title: error.message || "删除失败", icon: "none" }); }
      }
    });
  },

  openWearForm() {
    if (!this.data.currentPlanId) return wx.showToast({ title: "请先保存搭配方案", icon: "none" });
    if (this.data.planDirty) return wx.showToast({ title: "请先保存当前修改", icon: "none" });
    this.pendingWearKey = "";
    this.setData({ wearFormVisible: true, wearDate: localDate(), wearSceneIndex: 0, wearNote: "" });
  },
  closeWearForm() { this.setData({ wearFormVisible: false }); },
  onWearDate(event) { this.pendingWearKey = ""; this.setData({ wearDate: event.detail.value }); },
  onWearScene(event) { this.pendingWearKey = ""; this.setData({ wearSceneIndex: Number(event.detail.value) }); },
  onWearNote(event) { this.pendingWearKey = ""; this.setData({ wearNote: event.detail.value }); },
  async confirmWear() {
    if (this.data.planBusy || !this.data.currentPlanId) return;
    this.pendingWearKey = this.pendingWearKey || idempotencyKey(`outfit-wear-${this.data.currentPlanId}`);
    this.setData({ planBusy: true });
    try {
      const scene = SCENES[this.data.wearSceneIndex] === "未填写" ? "" : SCENES[this.data.wearSceneIndex];
      const result = await api.recordOutfitPlanWear(this.data.currentPlanId, {
        date: this.data.wearDate,
        scene,
        note: this.data.wearNote,
        idempotencyKey: this.pendingWearKey
      });
      this.pendingWearKey = "";
      this.setData({ planBusy: false, wearFormVisible: false });
      wx.showToast({ title: result.duplicate ? "这次穿着已记录" : `已记录 ${result.recordedCount} 件衣物`, icon: "none" });
    } catch (error) {
      this.setData({ planBusy: false });
      wx.showToast({ title: error.message || "穿搭记录失败", icon: "none" });
    }
  },

  canvasNode() {
    return new Promise((resolve, reject) => wx.createSelectorQuery().in(this).select("#exportCanvas").fields({ node: true, size: true }, (result) => {
      if (result?.node) resolve(result.node);
      else reject(new Error("导出画布初始化失败，请重试。"));
    }).exec());
  },

  canvasImage(canvas, src) {
    return new Promise((resolve, reject) => wx.getImageInfo({
      src,
      success: ({ path }) => {
        const image = canvas.createImage();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("衣物图片读取失败，请刷新衣橱后重试。"));
        image.src = path;
      },
      fail: () => reject(new Error("衣物图片下载失败，请检查网络后重试。"))
    }));
  },

  saveExport(canvas) {
    return new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: "png", quality: 1, success: ({ tempFilePath }) => {
      wx.saveImageToPhotosAlbum({ filePath: tempFilePath, success: resolve, fail: reject });
    }, fail: reject }));
  },

  async exportImage() {
    if (!this.data.layers.length || this.data.exporting) return wx.showToast({ title: "请先添加衣物", icon: "none" });
    this.setData({ exporting: true });
    try {
      const canvas = await this.canvasNode();
      // 导出画布保持与页面画布相同宽高比，避免位置和衣物比例被纵向拉伸。
      const target = { width: 1080, height: Math.round(1080 * this.data.canvasHeight / this.data.canvasWidth) };
      canvas.width = target.width;
      canvas.height = target.height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fffdf8";
      context.fillRect(0, 0, target.width, target.height);
      const windowWidth = wx.getSystemInfoSync().windowWidth || 375;
      const layerSize = { width: windowWidth * 190 / 750, height: windowWidth * 230 / 750 };
      const ordered = [...this.data.layers].sort((left, right) => left.z - right.z);
      for (const layer of ordered) {
        if (!layer.imageUrl) continue;
        const image = await this.canvasImage(canvas, layer.imageUrl);
        const rect = canvasModel.exportLayerRect(layer, { width: this.data.canvasWidth, height: this.data.canvasHeight }, target, layerSize);
        context.save();
        context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
        context.rotate(Number(layer.rotation || 0) * Math.PI / 180);
        const imageRatio = image.width && image.height ? Math.min(rect.width / image.width, rect.height / image.height) : 1;
        const drawWidth = image.width && image.height ? image.width * imageRatio : rect.width;
        const drawHeight = image.width && image.height ? image.height * imageRatio : rect.height;
        context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
        context.restore();
      }
      await this.saveExport(canvas);
      wx.showToast({ title: "搭配图片已保存到相册", icon: "none" });
    } catch (error) {
      const message = String(error?.errMsg || error?.message || "导出失败，请重试。");
      if (/auth deny|authorize|permission/i.test(message)) {
        wx.showModal({ title: "需要相册权限", content: "请在设置中允许保存到相册后重试。", confirmText: "去设置", success: ({ confirm }) => { if (confirm) wx.openSetting(); } });
      } else wx.showToast({ title: message.slice(0, 30), icon: "none" });
    } finally { this.setData({ exporting: false }); }
  },

  retry() { this.loadItems(); }
});
