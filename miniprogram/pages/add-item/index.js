const api = require("../../services/api");

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
    stage: "idle",
    stageText: "",
    errorText: "",
    isDemo: false,
    manualMode: false,
    budget: null,
    form: emptyForm(),
    needsConfirmation: []
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
    // chooseImage 在微信开发者工具和真机都更稳定；只在本地取得临时路径，尚未上传或产生 AI 费用。
    wx.chooseImage({
      count: 1,
      sourceType: ["album", "camera"],
      success: ({ tempFilePaths }) => this.compressSelected(tempFilePaths[0]),
      fail: (error) => {
        // 用户主动取消不算错误；其他失败必须显示出来，避免页面无反馈。
        if (!String(error.errMsg || "").includes("cancel")) {
          this.setData({ errorText: "无法打开相册或相机，请检查开发者工具权限后重试。" });
        }
      }
    });
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
      await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
      this.setData({ stage: "matting", stageText: "正在去除背景…" });
      const result = await api.recognizeItem(upload.taskId);
      this.applyRecognition(result);
    } catch (error) {
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
      this.applyRecognition(await api.retryRecognition(this.data.taskId));
    } catch (error) {
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
    if (!this.validateForm() || !this.data.imagePath) return;
    try {
      this.setData({ stage: "saving", stageText: "正在保存手动录入衣物…", errorText: "" });
      const upload = await api.createUpload({
        mimeType: this.data.mimeType,
        size: this.data.fileSize,
        mode: "manual",
        idempotencyKey: idempotencyKey()
      });
      await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
      await api.createManualItem({ taskId: upload.taskId, ...this.formPayload() });
      this.finishSave();
    } catch (error) {
      this.setData({ stage: "manual", stageText: "手动录入", errorText: error.message });
    }
  },

  finishSave() {
    this.setData({ stage: "saved", stageText: "已放入衣橱", errorText: "" });
    wx.showToast({ title: "入库成功", icon: "success" });
    setTimeout(() => wx.redirectTo({ url: "/pages/wardrobe/index" }), 500);
  },

  goBack() {
    wx.navigateBack();
  }
});
