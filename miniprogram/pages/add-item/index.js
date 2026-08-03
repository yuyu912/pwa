const api = require("../../services/api");
const { createBatch, updateBatchItem, nextBatchIndex, batchSummary } = require("../../utils/batch-upload");

const CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const SEASONS = ["春夏", "春秋", "秋冬", "多季"];
const THICKNESSES = ["薄", "适中", "厚"];

const emptyForm = () => ({
  name: "",
  category: "",
  color: "",
  season: "",
  thickness: "",
  pattern: "",
  material: "",
  stylesText: "",
  scenesText: "",
  price: ""
});

const idempotencyKey = () => `wx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const listFromText = (value) => String(value || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 4);

Page({
  data: {
    categories: CATEGORIES,
    seasons: SEASONS,
    thicknesses: THICKNESSES,
    categoryIndex: 0,
    seasonIndex: 0,
    thicknessIndex: 0,
    imagePath: "",
    resultImage: "",
    mimeType: "image/jpeg",
    fileSize: 0,
    taskId: "",
    draftId: "",
    manualUpload: null,
    manualUploaded: false,
    stage: "idle",
    stageText: "",
    errorText: "",
    isDemo: false,
    manualMode: false,
    budget: null,
    form: emptyForm(),
    needsConfirmation: [],
    batchItems: [],
    batchIndex: -1,
    batchSummary: null,
    preparingBatch: false
  },

  onLoad(options) {
    const entryMode = options.mode === "candidate" ? "candidate" : "closet";
    this.setData({ entryMode });
    this.refreshBudget();
  },

  async refreshBudget() {
    try {
      const budget = await api.getAiBudget();
      this.setData({ budget, manualMode: budget.status === "blocked" });
    } catch (error) {
      this.setData({ errorText: error.message });
    }
  },

  chooseImage() {
    if (this.data.batchItems.length && this.data.stage !== "batch-complete") {
      wx.showToast({ title: "请先完成当前批次", icon: "none" });
      return;
    }
    // chooseImage 在微信开发者工具和真机都更稳定；只在本地取得临时路径，尚未上传或产生 AI 费用。
    wx.chooseImage({
      count: this.data.entryMode === "candidate" ? 1 : 9,
      sourceType: ["album", "camera"],
      success: ({ tempFilePaths }) => {
        if (this.data.entryMode !== "candidate" && tempFilePaths.length > 1) return this.prepareBatch(tempFilePaths);
        this.setData({ batchItems: [], batchIndex: -1, batchSummary: null });
        this.compressSelected(tempFilePaths[0]);
      },
      fail: (error) => {
        // 用户主动取消不算错误；其他失败必须显示出来，避免页面无反馈。
        if (!String(error.errMsg || "").includes("cancel")) {
          this.setData({ errorText: "无法打开相册或相机，请检查开发者工具权限后重试。" });
        }
      }
    });
  },

  compressFile(sourcePath) {
    return new Promise((resolve) => {
      wx.compressImage({ src: sourcePath, quality: 75, success: ({ tempFilePath }) => resolve(tempFilePath), fail: () => resolve(sourcePath) });
    });
  },

  fileInfo(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileInfo({ filePath, success: resolve, fail: () => reject(new Error("无法读取这张图片。")) });
    });
  },

  async prepareBatch(paths) {
    let batchItems = createBatch(paths);
    this.setData({ batchItems, batchIndex: -1, batchSummary: batchSummary(batchItems), preparingBatch: true, stage: "compressing", stageText: `正在准备 0 / ${batchItems.length} 张图片…`, errorText: "" });
    for (let index = 0; index < batchItems.length; index += 1) {
      try {
        const imagePath = await this.compressFile(batchItems[index].sourcePath);
        const { size } = await this.fileInfo(imagePath);
        const tooLarge = size > 2 * 1024 * 1024;
        batchItems = updateBatchItem(batchItems, index, {
          imagePath,
          mimeType: /\.png$/i.test(imagePath) ? "image/png" : "image/jpeg",
          fileSize: size,
          status: tooLarge ? "error" : "ready",
          errorText: tooLarge ? "压缩后仍超过 2MB，请跳过这张。" : ""
        });
      } catch (error) {
        batchItems = updateBatchItem(batchItems, index, { status: "error", errorText: error.message });
      }
      this.setData({ batchItems, stageText: `正在准备 ${index + 1} / ${batchItems.length} 张图片…` });
    }
    this.setData({ batchItems, preparingBatch: false, batchSummary: batchSummary(batchItems) });
    this.loadBatchItem(0);
  },

  loadBatchItem(index) {
    const item = this.data.batchItems[index];
    if (!item) return this.completeBatch();
    this.setData({
      batchIndex: index,
      imagePath: item.imagePath || item.sourcePath,
      resultImage: "",
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      taskId: item.taskId || "",
      draftId: item.draftId || "",
      manualUpload: null,
      manualUploaded: false,
      stage: item.status === "error" ? "batch-item-error" : "selected",
      stageText: item.status === "error" ? "这张图片无法处理" : `第 ${index + 1} / ${this.data.batchItems.length} 件已准备好`,
      errorText: item.errorText || "",
      manualMode: false,
      form: emptyForm(),
      needsConfirmation: []
    });
  },

  updateCurrentBatch(changes) {
    if (this.data.batchIndex < 0) return;
    const batchItems = updateBatchItem(this.data.batchItems, this.data.batchIndex, changes);
    this.setData({ batchItems, batchSummary: batchSummary(batchItems) });
  },

  compressSelected(sourcePath) {
    this.setData({ stage: "compressing", stageText: "正在压缩图片…", errorText: "" });
    wx.compressImage({
      src: sourcePath,
      quality: 75,
      success: ({ tempFilePath }) => this.inspectFile(tempFilePath),
      fail: () => this.inspectFile(sourcePath)
    });
  },

  inspectFile(filePath) {
    wx.getFileInfo({
      filePath,
      success: ({ size }) => {
        if (size > 2 * 1024 * 1024) {
          this.setData({ stage: "error", stageText: "", errorText: "压缩后仍超过 2MB，请换一张更小的图片。" });
          return;
        }
        const mimeType = /\.png$/i.test(filePath) ? "image/png" : "image/jpeg";
        this.setData({
          imagePath: filePath,
          resultImage: "",
          mimeType,
          fileSize: size,
          taskId: "",
          draftId: "",
          manualUpload: null,
          manualUploaded: false,
          stage: "selected",
          stageText: "图片已准备好",
          errorText: "",
          form: emptyForm(),
          needsConfirmation: []
        });
      },
      fail: () => this.setData({ stage: "error", stageText: "", errorText: "无法读取这张图片，请重新选择。" })
    });
  },

  // 真实模式按“上传 -> 抠图 -> 识别”推进；处理中禁用重复操作，云端还会用幂等键兜底。
  async startRecognition() {
    if (!this.data.imagePath || ["uploading", "matting", "recognizing", "saving"].includes(this.data.stage)) return;
    if (this.data.budget?.status === "blocked") {
      this.setData({ manualMode: true, errorText: "AI 测试额度已用完，请使用手动录入。" });
      return;
    }
    try {
      this.setData({ stage: "uploading", stageText: "正在私密上传…", errorText: "" });
      const upload = await api.createUpload({
        mimeType: this.data.mimeType,
        size: this.data.fileSize,
        // candidate 任务和正式衣橱任务共用识别链路，但确认后的数据写入不同集合。
        mode: this.data.entryMode === "candidate" ? "candidate" : "closet",
        idempotencyKey: idempotencyKey()
      });
      this.setData({ taskId: upload.taskId });
      this.updateCurrentBatch({ taskId: upload.taskId, status: "uploading" });
      await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
      this.setData({ stage: "matting", stageText: "正在去除背景…" });
      const result = await api.recognizeItem(upload.taskId);
      this.applyRecognition(result);
    } catch (error) {
      this.updateCurrentBatch({ status: "error", errorText: error.message || "AI 处理失败。" });
      this.setData({
        stage: "error",
        stageText: "",
        errorText: error.message || "AI 处理失败，请重试或手动录入。"
      });
      this.refreshBudget();
    }
  },

  async retryRecognition() {
    if (!this.data.taskId) return this.startRecognition();
    try {
      this.setData({ stage: "recognizing", stageText: "正在重试衣物识别…", errorText: "" });
      this.updateCurrentBatch({ status: "recognizing", errorText: "" });
      this.applyRecognition(await api.retryRecognition(this.data.taskId));
    } catch (error) {
      this.updateCurrentBatch({ status: "error", errorText: error.message || "重试失败。" });
      this.setData({ stage: "error", stageText: "", errorText: error.message || "重试失败，请手动录入。" });
      this.refreshBudget();
    }
  },

  // AI 返回的是可修改的候选值，不是最终事实；此处只回填表单，不会自动写入衣橱。
  applyRecognition(result) {
    const tags = result.tags || {};
    this.setData({
      resultImage: result.cutoutUrl || this.data.imagePath,
      draftId: result.draftId,
      stage: "confirming",
      stageText: "AI 已生成候选，请逐项确认",
      errorText: "",
      isDemo: result.isDemo === true,
      budget: result.budget || this.data.budget,
      categoryIndex: Math.max(0, CATEGORIES.indexOf(tags.category)),
      seasonIndex: Math.max(0, SEASONS.indexOf(tags.season)),
      thicknessIndex: Math.max(0, THICKNESSES.indexOf(tags.thickness)),
      form: {
        name: tags.name || "",
        category: tags.category || "",
        color: tags.color || "",
        season: tags.season || "",
        thickness: tags.thickness || "",
        pattern: tags.pattern || "",
        material: tags.material || "",
        stylesText: (tags.styles || []).join("、"),
        scenesText: (tags.scenes || []).join("、"),
        price: ""
      },
      needsConfirmation: tags.needsConfirmation || []
    });
    this.updateCurrentBatch({ taskId: this.data.taskId, draftId: result.draftId, status: "confirming", errorText: "" });
  },

  onFieldInput(event) {
    this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value });
  },

  onCategoryChange(event) {
    const index = Number(event.detail.value);
    this.setData({ categoryIndex: index, "form.category": CATEGORIES[index] });
  },

  onSeasonChange(event) {
    const index = Number(event.detail.value);
    this.setData({ seasonIndex: index, "form.season": SEASONS[index] });
  },

  onThicknessChange(event) {
    const index = Number(event.detail.value);
    this.setData({ thicknessIndex: index, "form.thickness": THICKNESSES[index] });
  },

  useManualMode() {
    if (this.data.entryMode === "candidate") {
      wx.showToast({ title: "候选新衣分析需要先完成 AI 识别", icon: "none" });
      return;
    }
    this.setData({
      manualMode: true,
      stage: this.data.imagePath ? "manual" : "idle",
      stageText: this.data.imagePath ? "手动填写后即可入库，不调用 AI" : "",
      errorText: "",
      resultImage: this.data.imagePath,
      form: this.data.form.category ? this.data.form : { ...emptyForm(), category: CATEGORIES[0], season: SEASONS[0], thickness: THICKNESSES[0] }
    });
    this.updateCurrentBatch({ status: "manual", errorText: "" });
  },

  formPayload() {
    const form = this.data.form;
    return {
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
    };
  },

  validateForm() {
    if (!this.data.form.category) {
      wx.showToast({ title: "请确认衣物品类", icon: "none" });
      return false;
    }
    return true;
  },

  // 用户点击确认后才调用正式入库接口，这是 AI 不能自动替用户做决定的产品边界。
  async saveConfirmed() {
    if (this.data.stage === "saving") return;
    if (!this.validateForm() || !this.data.draftId) return;
    try {
      const isCandidate = this.data.entryMode === "candidate";
      this.setData({ stage: "saving", stageText: isCandidate ? "正在生成新衣分析…" : "正在正式入库…", errorText: "" });
      if (isCandidate) {
        const candidate = await api.createCandidate({ draftId: this.data.draftId, ...this.formPayload() });
        this.setData({ stage: "saved", stageText: "候选新衣已确认", errorText: "" });
        return wx.redirectTo({ url: `/pages/candidate/index?id=${candidate.id}` });
      }
      await api.createItem({ draftId: this.data.draftId, ...this.formPayload() });
      this.finishSave();
    } catch (error) {
      this.setData({ stage: "confirming", stageText: "请确认后重试", errorText: error.message });
    }
  },

  // 手动录入只保存用户填写的字段和原图，不触发任何 AI 服务或按件费用。
  async saveManual() {
    if (this.data.stage === "saving") return;
    if (!this.validateForm() || !this.data.imagePath) return;
    try {
      this.setData({ stage: "saving", stageText: "正在保存手动录入衣物…", errorText: "" });
      let upload = this.data.manualUpload;
      if (!upload) {
        upload = await api.createUpload({
          mimeType: this.data.mimeType,
          size: this.data.fileSize,
          mode: "manual",
          idempotencyKey: idempotencyKey()
        });
        this.setData({ manualUpload: upload });
      }
      if (!this.data.manualUploaded) {
        await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
        this.setData({ manualUploaded: true });
      }
      // 入库响应丢失时保留同一 taskId 重试，云端会返回已保存结果，不会再创建一件。
      await api.createManualItem({ taskId: upload.taskId, ...this.formPayload() });
      this.finishSave();
    } catch (error) {
      this.setData({ stage: "manual", stageText: "手动录入", errorText: error.message });
    }
  },

  finishSave() {
    if (this.data.batchItems.length > 1) {
      this.updateCurrentBatch({ status: "saved", errorText: "" });
      this.setData({ stage: "saved", stageText: `第 ${this.data.batchIndex + 1} 件已放入衣橱`, errorText: "" });
      wx.showToast({ title: "入库成功", icon: "success" });
      const nextIndex = nextBatchIndex(this.data.batchItems, this.data.batchIndex);
      return setTimeout(() => nextIndex >= 0 ? this.loadBatchItem(nextIndex) : this.completeBatch(), 500);
    }
    this.setData({ stage: "saved", stageText: "已放入衣橱", errorText: "" });
    wx.showToast({ title: "入库成功", icon: "success" });
    setTimeout(() => wx.redirectTo({ url: "/pages/wardrobe/index" }), 500);
  },

  skipBatchItem() {
    if (this.data.batchItems.length <= 1 || this.data.batchIndex < 0) return;
    this.updateCurrentBatch({ status: "skipped" });
    const nextIndex = nextBatchIndex(this.data.batchItems, this.data.batchIndex);
    nextIndex >= 0 ? this.loadBatchItem(nextIndex) : this.completeBatch();
  },

  completeBatch() {
    const summary = batchSummary(this.data.batchItems);
    this.setData({ stage: "batch-complete", stageText: "本次批量录入已完成", errorText: "", batchSummary: summary, imagePath: "", resultImage: "", manualMode: false });
  },

  openWardrobe() { wx.redirectTo({ url: "/pages/wardrobe/index" }); },

  goBack() {
    wx.navigateBack();
  }
});
