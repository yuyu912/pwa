const api = require("../../services/api");
const { createBatch, updateBatchItem, nextBatchIndex, batchSummary } = require("../../utils/batch-upload");

const CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"];
const SEASONS = ["春夏", "春秋", "秋冬", "多季"];
const THICKNESSES = ["薄", "适中", "厚"];
const FORMALITIES = ["未设置", "休闲", "轻商务", "商务", "半正式", "正式", "运动", "户外"];
const STYLES = ["韩系", "清新", "酷飒", "简约", "休闲", "通勤", "复古", "甜美", "运动", "街头", "优雅", "度假"];
const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const selectableOptions = (values, selected = []) => values.map((value) => ({ value, selected: selected.includes(value) }));

const emptyForm = () => ({
  name: "",
  category: "",
  color: "",
  season: "",
  thickness: "",
  pattern: "",
  material: "",
  designDetailsText: "",
  formality: "",
  functionTagsText: "",
  stylesText: "",
  scenesText: "",
  price: ""
});

const idempotencyKey = () => `wx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const listFromText = (value, max = 4) => String(value || "").split(/[、,，]/).map((item) => item.trim()).filter(Boolean).slice(0, max);
const entitlementView = (entitlement) => {
  if (!entitlement) return null;
  const remainingMs = Math.max(0, Date.parse(entitlement.trialEndsAt || "") - Date.parse(entitlement.serverTime || ""));
  const quota = entitlement.quota;
  return {
    ...entitlement,
    remainingDays: entitlement.status === "trialing" ? Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))) : 0,
    statusText: entitlement.status === "trialing" ? "7 天 AI 权益试用中" : entitlement.status === "active" ? "AI 会员有效" : "免费保底额度",
    quotaText: quota ? `属性识别剩余 ${quota.recognition.remaining}/${quota.recognition.limit} · 移除衣架 ${quota.hangerRemoval.remaining}/${quota.hangerRemoval.limit}` : "",
    quotaWarning: quota?.recognition.exceeded || quota?.hangerRemoval.exceeded
  };
};

Page({
  data: {
    categories: CATEGORIES,
    seasons: SEASONS,
    thicknesses: THICKNESSES,
    formalities: FORMALITIES,
    styleOptions: selectableOptions(STYLES),
    sceneOptions: selectableOptions(SCENES),
    categoryIndex: 0,
    seasonIndex: 0,
    thicknessIndex: 0,
    formalityIndex: 0,
    imagePath: "",
    resultImage: "",
    originalCutoutUrl: "",
    hangerEditUrl: "",
    selectedImage: "original",
    hangerEditBusy: false,
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
    entitlement: null,
    aiProgress: null,
    mattingQualityFailed: false,
    form: emptyForm(),
    needsConfirmation: [],
    batchItems: [],
    batchIndex: -1,
    batchSummary: null,
    preparingBatch: false,
    entryMode: "closet",
    entrySource: "single_item_upload",
    photoMode: "single",
    multiDetections: [],
    qualityWarning: "",
    mattingConfirmed: false
  },

  onLoad(options) {
    const entryMode = options.mode === "candidate" ? "candidate" : "closet";
    this.setData({
      entryMode,
      entrySource: "single_item_upload"
    });
    this.refreshBudget();
    this.refreshEntitlement();
  },

  async refreshEntitlement() {
    try { this.setData({ entitlement: entitlementView(await api.getEntitlement()) }); }
    catch (error) { this.setData({ errorText: error.message }); }
  },

  async refreshBudget() {
    try {
      const budget = await api.getAiBudget();
      this.setData({ budget });
    } catch (error) {}
  },

  selectPhotoMode(event) {
    if (!["idle", "selected", "error", "batch-complete"].includes(this.data.stage)) {
      wx.showToast({ title: "请先完成当前处理", icon: "none" });
      return;
    }
    const photoMode = event.currentTarget.dataset.mode === "multi" ? "multi" : "single";
    this.setData({ photoMode, entrySource: photoMode === "multi" ? "multi_item_upload" : "single_item_upload", multiDetections: [], errorText: "" });
  },

  handleUploadTap() {
    if (this.data.stage !== "multi-review") this.chooseImage();
  },

  chooseImage() {
    if (this.data.batchItems.length > 1 && this.data.stage !== "batch-complete") {
      wx.showToast({ title: "请先完成当前批次", icon: "none" });
      return;
    }
    const count = this.data.entryMode === "candidate" || this.data.photoMode === "multi" ? 1 : 9;
    const handleSuccess = (result) => {
      const tempFilePaths = Array.isArray(result.tempFiles)
        ? result.tempFiles.map((file) => file.tempFilePath).filter(Boolean)
        : result.tempFilePaths || [];
      if (!tempFilePaths.length) {
        this.setData({ errorText: "没有读取到图片，请重新选择。" });
        return;
      }
      if (this.data.entryMode !== "candidate" && tempFilePaths.length > 1) return this.prepareBatch(tempFilePaths);
      this.setData({ batchItems: [], batchIndex: -1, batchSummary: null });
      this.compressSelected(tempFilePaths[0]);
    };
    const handleFail = (error) => {
      // 用户主动取消不算错误；权限或工具异常必须同时显示 Toast 和页面提示。
      if (!String(error?.errMsg || "").includes("cancel")) {
        const errorText = "无法打开相册或相机，请检查微信开发者工具的授权设置后重试。";
        this.setData({ errorText });
        wx.showToast({ title: errorText, icon: "none", duration: 3000 });
      }
    };
    // 新版基础库优先使用 chooseMedia；旧版仍回退 chooseImage，两个入口返回值在这里统一处理。
    if (typeof wx.chooseMedia === "function") {
      wx.chooseMedia({
        count,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        success: handleSuccess,
        fail: handleFail
      });
      return;
    }
    wx.chooseImage({
      count,
      sourceType: ["album", "camera"],
      success: handleSuccess,
      fail: handleFail
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
      originalCutoutUrl: "",
      hangerEditUrl: "",
      selectedImage: "original",
      hangerEditBusy: false,
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
      mattingQualityFailed: false,
      aiProgress: null,
      qualityWarning: "",
      mattingConfirmed: false,
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
          originalCutoutUrl: "",
          hangerEditUrl: "",
          selectedImage: "original",
          hangerEditBusy: false,
          mimeType,
          fileSize: size,
          taskId: "",
          draftId: "",
          manualUpload: null,
          manualUploaded: false,
          stage: "selected",
          stageText: "图片已准备好",
          errorText: "",
          mattingQualityFailed: false,
          form: emptyForm(),
          needsConfirmation: [],
          multiDetections: [],
          qualityWarning: "",
          mattingConfirmed: false
        });
      },
      fail: () => this.setData({ stage: "error", stageText: "", errorText: "无法读取这张图片，请重新选择。" })
    });
  },

  // 真实模式在抠图后暂停，让用户决定是否额外调用图片编辑，再继续属性识别。
  async startRecognition() {
    if (!this.data.imagePath || ["uploading", "matting", "recognizing", "saving"].includes(this.data.stage)) return;
    if (this.data.budget?.status === "blocked") {
      this.setData({ errorText: "AI 自动识别暂时不可用，你仍可选择“仅抠图，手动填写”。" });
      return;
    }
    if (this.data.photoMode === "multi" && this.data.batchIndex < 0) return this.startMultiDetection();
    try {
      this.setData({
        stage: "uploading",
        stageText: "正在私密上传衣物图片…",
        aiProgress: {
          providerName: "腾讯云 COS",
          modelName: "私有对象存储",
          actionText: "正在加密传输衣物图片",
          usageText: "本步骤仅上传私密图片，不消耗图片处理次数或大模型 Token。"
        },
        errorText: ""
      });
      const currentBatch = this.data.batchItems[this.data.batchIndex];
      let taskId = currentBatch?.serverPrepared ? currentBatch.taskId : "";
      if (!taskId) {
        const upload = await api.createUpload({
          mimeType: this.data.mimeType,
          size: this.data.fileSize,
          // candidate 任务和正式衣橱任务共用识别链路，但确认后的数据写入不同集合。
          mode: this.data.entryMode === "candidate" ? "candidate" : "closet",
          idempotencyKey: idempotencyKey()
        });
        taskId = upload.taskId;
        this.setData({ taskId });
        this.updateCurrentBatch({ taskId, status: "uploading" });
        await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
      } else {
        this.setData({ taskId });
        this.updateCurrentBatch({ status: "matting" });
      }
      this.setData({
        stage: "matting",
        stageText: "正在调用百度智能云，按衣物范围分离主体与背景…",
        aiProgress: {
          providerName: "百度智能云",
          modelName: "衣物框定位 / 百度框选抠图",
          actionText: "正在分离衣物主体与图片背景",
          usageText: "先定位主要衣物范围，再按框抠除床单、被子等背景；定位不计入属性识别次数。"
        }
      });
      const matting = await api.mattingItem(taskId);
      this.showMattingReview(matting);
    } catch (error) {
      this.updateCurrentBatch({ status: "error", errorText: error.message || "AI 处理失败。" });
      this.setData({
        stage: "error",
        stageText: "",
        mattingQualityFailed: error.code === "MATTING_QUALITY_LOW",
        errorText: error.message || "AI 处理失败，请重试或手动录入。"
      });
      this.refreshBudget();
    }
  },

  async startMultiDetection() {
    try {
      this.setData({
        stage: "uploading",
        stageText: "正在私密上传整张衣物照片…",
        errorText: "",
        aiProgress: { providerName: "腾讯云 COS", modelName: "私有对象存储", actionText: "正在加密传输照片", usageText: "上传后只定位无人物照片中的衣物，最多返回 3 件。" }
      });
      const upload = await api.createUpload({ mimeType: this.data.mimeType, size: this.data.fileSize, mode: "multi_detection", idempotencyKey: idempotencyKey() });
      this.setData({ taskId: upload.taskId });
      await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
      this.setData({
        stage: "multi-detecting",
        stageText: "正在定位照片中的多件衣物…",
        aiProgress: { providerName: "阿里云百炼", modelName: "通义千问 VL", actionText: "正在识别每件衣物的位置和品类", usageText: "定位步骤不计入属性识别次数；最终按实际保存件数统计。" }
      });
      const result = await api.detectMultipleGarments(upload.taskId);
      const multiDetections = (result.detections || []).map((item) => ({
        ...item,
        selected: true,
        confidenceText: `${Math.round(item.confidence * 100)}%`,
        labelText: `${item.category}${item.color ? ` · ${item.color}` : ""}`,
        boxStyle: `left:${item.bbox[0] / 10}%;top:${item.bbox[1] / 10}%;width:${(item.bbox[2] - item.bbox[0]) / 10}%;height:${(item.bbox[3] - item.bbox[1]) / 10}%;`
      }));
      this.setData({
        stage: "multi-review",
        stageText: `识别到 ${multiDetections.length} 件，请确认识别框`,
        multiDetections,
        budget: result.budget || this.data.budget,
        aiProgress: { providerName: "阿里云百炼", modelName: result.model || "通义千问 VL", actionText: "已定位待拆分的衣物", usageText: "取消勾选错误项后，再逐件抠图和确认属性。" }
      });
    } catch (error) {
      this.setData({ stage: "error", stageText: "", errorText: error.message || "多件衣物定位失败，请改用单件录入。" });
      this.refreshBudget();
    }
  },

  toggleMultiGarment(event) {
    const detectionId = event.currentTarget.dataset.id;
    this.setData({ multiDetections: this.data.multiDetections.map((item) => item.detectionId === detectionId ? { ...item, selected: !item.selected } : item) });
  },

  async confirmMultiGarments() {
    const detectionIds = this.data.multiDetections.filter((item) => item.selected).map((item) => item.detectionId);
    if (!detectionIds.length) return wx.showToast({ title: "请至少选择一件", icon: "none" });
    try {
      this.setData({ stage: "multi-splitting", stageText: "正在按识别框拆分衣物…", errorText: "" });
      const result = await api.splitMultipleGarments(this.data.taskId, detectionIds);
      const batchItems = result.items.map((item, index) => ({
        id: `multi-${this.data.taskId}-${index}`,
        sourcePath: item.cropUrl,
        imagePath: item.cropUrl,
        mimeType: "image/jpeg",
        fileSize: 0,
        taskId: item.taskId,
        draftId: "",
        serverPrepared: true,
        status: "ready",
        errorText: "",
        detectedCategory: item.category
      }));
      this.setData({ batchItems, batchIndex: -1, batchSummary: batchSummary(batchItems), multiDetections: [] });
      this.loadBatchItem(0);
    } catch (error) {
      this.setData({ stage: "multi-review", stageText: "请重新确认衣物框", errorText: error.message || "衣物拆分失败，请重试。" });
    }
  },

  showMattingReview(matting) {
    const originalCutoutUrl = matting.originalCutoutUrl || matting.cutoutUrl || this.data.imagePath;
    const selectedImage = matting.selectedImage === "hanger_edit" && matting.hangerEditUrl ? "hanger_edit" : "original";
    const resultImage = selectedImage === "hanger_edit" ? matting.hangerEditUrl : originalCutoutUrl;
    this.setData({
      stage: "matting-review",
      stageText: "抠图已完成，请确认是否需要移除衣架",
      resultImage,
      originalCutoutUrl,
      hangerEditUrl: matting.hangerEditUrl || "",
      selectedImage,
      hangerEditBusy: false,
      errorText: "",
      qualityWarning: matting.qualityWarning || "",
      mattingConfirmed: false,
      aiProgress: {
        providerName: matting.providerName || "百度智能云",
        modelName: matting.modelName || "商品抠图",
        actionText: "已分离衣物主体与背景，原抠图已安全保留",
        usageText: "如图片含衣架，可主动调用一次 AI 图片编辑；不点击就不会产生这笔消耗。"
      }
    });
    this.updateCurrentBatch({ status: "matting-review", errorText: "" });
  },

  async removeHanger() {
    if (!this.data.taskId || this.data.hangerEditBusy || this.data.hangerEditUrl) return;
    try {
      this.setData({
        hangerEditBusy: true,
        stageText: "正在调用通义千问图像编辑，识别并移除衣架…",
        errorText: "",
        aiProgress: {
          providerName: "阿里云百炼",
          modelName: "qwen-image-2.0",
          actionText: "正在识别衣架区域并修复被遮挡的衣物画面",
          usageText: "这是用户主动发起的增强图片编辑；成功生成会消耗 1 次图片编辑，原抠图不会被覆盖。"
        }
      });
      const edited = await api.removeHanger(this.data.taskId);
      this.setData({
        hangerEditBusy: false,
        stage: this.data.manualMode ? "manual" : "matting-review",
        stageText: "AI 衣架移除预览已生成，请对比后选择",
        resultImage: edited.hangerEditUrl || edited.cutoutUrl,
        originalCutoutUrl: edited.originalCutoutUrl || this.data.originalCutoutUrl,
        hangerEditUrl: edited.hangerEditUrl || edited.cutoutUrl,
        selectedImage: "hanger_edit",
        mattingConfirmed: false,
        aiProgress: {
          providerName: edited.providerName || "阿里云百炼",
          modelName: edited.modelName || "qwen-image-2.0",
          actionText: "已移除衣架并生成可选修复图",
          usageText: "本次图片编辑已完成；原抠图仍保留，可随时切回。"
        }
      });
      this.refreshEntitlement();
    } catch (error) {
      this.setData({
        hangerEditBusy: false,
        stage: this.data.manualMode ? "manual" : "matting-review",
        stageText: "原抠图仍可继续使用",
        resultImage: this.data.originalCutoutUrl,
        selectedImage: "original",
        errorText: error.message || "衣架移除失败，请使用原抠图继续。"
      });
      this.refreshBudget();
    }
  },

  previewOriginal() {
    this.setData({ resultImage: this.data.originalCutoutUrl, selectedImage: "original", mattingConfirmed: false, errorText: "" });
  },

  previewHangerEdit() {
    if (!this.data.hangerEditUrl) return;
    this.setData({ resultImage: this.data.hangerEditUrl, selectedImage: "hanger_edit", mattingConfirmed: false, errorText: "" });
  },

  confirmMattingPreview() {
    this.setData({ mattingConfirmed: true, errorText: "" });
  },

  async continueRecognition() {
    if (!this.data.taskId || this.data.hangerEditBusy || this.data.stage === "recognizing") return;
    try {
      this.setData({ mattingConfirmed: true });
      await api.selectTaskImage(this.data.taskId, this.data.selectedImage);
      this.setData({
        stage: "recognizing",
        stageText: "正在调用通义千问 VL，与衣物属性特征进行比对…",
        aiProgress: {
          providerName: "阿里云百炼",
          modelName: "通义千问 VL",
          actionText: "正在将衣物图像与服装属性特征进行比对，并生成候选标签",
          usageText: "本步骤消耗大模型 Token，用于理解衣物图像并生成待确认属性。"
        }
      });
      const result = await api.recognizeLabels(this.data.taskId);
      this.applyRecognition(result);
    } catch (error) {
      this.updateCurrentBatch({ status: "error", errorText: error.message || "AI 处理失败。" });
      this.setData({
        stage: "error",
        stageText: "",
        mattingQualityFailed: error.code === "MATTING_QUALITY_LOW",
        errorText: error.message || "AI 处理失败，请重试或手动录入。"
      });
      this.refreshBudget();
    }
  },

  async retryRecognition() {
    if (!this.data.taskId) return this.startRecognition();
    try {
      this.setData({
        stage: "matting",
        stageText: "正在确认百度框选抠图阶段…",
        aiProgress: {
          providerName: "百度智能云",
          modelName: "衣物框定位 / 百度框选抠图",
          actionText: "正在复用已完成的抠图结果，或继续未完成的背景分离",
          usageText: "已完成的抠图不会重复调用；百度故障或质量不合格时才会使用腾讯回退。"
        },
        errorText: ""
      });
      this.updateCurrentBatch({ status: "recognizing", errorText: "" });
      await api.mattingItem(this.data.taskId);
      this.setData({
        stage: "recognizing",
        stageText: "正在重试通义千问 VL 候选标签识别…",
        aiProgress: {
          providerName: "阿里云百炼",
          modelName: "通义千问 VL",
          actionText: "正在重新比对衣物属性特征并生成候选标签",
          usageText: "仅重试模型识别阶段，不重复调用已完成抠图；本步骤会消耗大模型 Token。"
        }
      });
      this.applyRecognition(await api.recognizeLabels(this.data.taskId));
    } catch (error) {
      this.updateCurrentBatch({ status: "error", errorText: error.message || "重试失败。" });
      this.setData({ stage: "error", stageText: "", mattingQualityFailed: error.code === "MATTING_QUALITY_LOW", errorText: error.message || "重试失败，请手动录入。" });
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
      stageText: "AI 已完成，等待你确认",
      aiProgress: {
        providerName: "阿里云百炼",
        modelName: result.model || "通义千问 VL",
        actionText: "已生成待确认的衣物候选标签",
        usageText: "本次大模型 Token 已用于生成候选标签，确认或修改后才会正式入库。"
      },
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
        designDetailsText: (tags.designDetails || []).join("、"),
        formality: "",
        functionTagsText: "",
        stylesText: (tags.styles || []).join("、"),
        scenesText: (tags.scenes || []).join("、"),
        price: ""
      },
      styleOptions: selectableOptions(STYLES, tags.styles || []),
      sceneOptions: selectableOptions(SCENES, tags.scenes || []),
      needsConfirmation: tags.needsConfirmation || []
    });
    this.updateCurrentBatch({ taskId: this.data.taskId, draftId: result.draftId, status: "confirming", errorText: "" });
    this.refreshEntitlement();
  },

  onFieldInput(event) {
    this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value });
  },

  toggleTagOption(event) {
    const key = event.currentTarget.dataset.type === "scene" ? "sceneOptions" : "styleOptions";
    const value = event.currentTarget.dataset.value;
    const options = this.data[key];
    const current = options.find((item) => item.value === value);
    if (!current) return;
    if (!current.selected && options.filter((item) => item.selected).length >= 3) {
      wx.showToast({ title: "最多选择 3 项", icon: "none" });
      return;
    }
    this.setData({ [key]: options.map((item) => item.value === value ? { ...item, selected: !item.selected } : item) });
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
  onFormalityChange(event) {
    const formalityIndex = Number(event.detail.value);
    this.setData({ formalityIndex, "form.formality": FORMALITIES[formalityIndex] === "未设置" ? "" : FORMALITIES[formalityIndex] });
  },

  async useManualMode() {
    if (this.data.entryMode === "candidate") {
      wx.showToast({ title: "候选新衣分析需要先完成 AI 识别", icon: "none" });
      return;
    }
    if (!this.data.imagePath || ["uploading", "matting", "saving"].includes(this.data.stage)) return;
    try {
      let upload = this.data.manualUpload;
      if (!upload) {
        this.setData({
          stage: "uploading",
          stageText: "正在私密上传衣物图片…",
          aiProgress: {
            providerName: "腾讯云 COS",
            modelName: "私有对象存储",
            actionText: "正在加密传输衣物图片",
            usageText: "本步骤仅上传私密图片，不消耗图片处理次数或大模型 Token。"
          },
          errorText: ""
        });
        upload = await api.createUpload({
          mimeType: this.data.mimeType,
          size: this.data.fileSize,
          mode: "manual",
          idempotencyKey: idempotencyKey()
        });
        this.setData({ manualUpload: upload, taskId: upload.taskId });
      }
      if (!this.data.manualUploaded) {
        await api.uploadBinary(upload, this.data.imagePath, this.data.mimeType);
        this.setData({ manualUploaded: true });
      }
      this.setData({
        stage: "matting",
        stageText: "正在调用百度智能云，按衣物范围分离主体与背景…",
        aiProgress: {
          providerName: "百度智能云",
          modelName: "衣物框定位 / 百度框选抠图",
          actionText: "正在分离衣物主体与图片背景",
          usageText: "通义仅定位主要衣物范围，不生成属性标签，也不计入属性识别次数。"
        }
      });
      const matting = await api.mattingItem(upload.taskId);
      const originalCutoutUrl = matting.originalCutoutUrl || matting.cutoutUrl || this.data.imagePath;
      const selectedImage = matting.selectedImage === "hanger_edit" && matting.hangerEditUrl ? "hanger_edit" : "original";
      this.setData({
        manualMode: true,
        stage: "manual",
        stageText: "抠图已完成；可选移除衣架，再手动填写属性",
        errorText: "",
        resultImage: selectedImage === "hanger_edit" ? matting.hangerEditUrl : originalCutoutUrl,
        originalCutoutUrl,
        hangerEditUrl: matting.hangerEditUrl || "",
        selectedImage,
        mattingConfirmed: false,
        hangerEditBusy: false,
        aiProgress: {
          providerName: matting.providerName || "百度智能云",
          modelName: matting.modelName || "商品抠图",
          actionText: "已分离衣物主体与图片背景",
          usageText: "本次只用通义定位衣物范围，属性由你手动填写，不计入属性识别次数。"
        },
        form: this.data.form.category ? this.data.form : { ...emptyForm(), category: CATEGORIES[0], season: SEASONS[0], thickness: THICKNESSES[0] }
      });
      this.updateCurrentBatch({ status: "manual", errorText: "" });
    } catch (error) {
      this.setData({ manualMode: false, stage: "error", stageText: "", mattingQualityFailed: error.code === "MATTING_QUALITY_LOW", errorText: error.message || "基础抠图失败，请重试。" });
    }
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
      designDetails: listFromText(form.designDetailsText, 6),
      formality: form.formality,
      functionTags: listFromText(form.functionTagsText, 6),
      styles: this.data.styleOptions.filter((item) => item.selected).map((item) => item.value),
      scenes: this.data.sceneOptions.filter((item) => item.selected).map((item) => item.value),
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
      await api.createItem({ draftId: this.data.draftId, sourceType: this.data.entrySource, ...this.formPayload() });
      this.finishSave();
    } catch (error) {
      this.setData({ stage: "confirming", stageText: "请确认后重试", errorText: error.message });
    }
  },

  // 基础录入保存用户填写的字段和已完成的透明图，不调用通义千问 VL。
  async saveManual() {
    if (this.data.stage === "saving") return;
    if (!this.data.mattingConfirmed) return wx.showToast({ title: "请先确认抠图完整", icon: "none" });
    if (!this.validateForm() || !this.data.imagePath) return;
    try {
      this.setData({ stage: "saving", stageText: "正在保存手动录入衣物…", errorText: "" });
      const upload = this.data.manualUpload;
      if (!upload || !this.data.manualUploaded) throw new Error("请先完成基础抠图。");
      await api.selectTaskImage(upload.taskId, this.data.selectedImage);
      // 入库响应丢失时保留同一 taskId 重试，云端会返回已保存结果，不会再创建一件。
      await api.createManualItem({ taskId: upload.taskId, sourceType: this.data.entrySource, ...this.formPayload() });
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
    this.setData({ stage: "single-complete", stageText: "已放入衣橱", errorText: "" });
    wx.showToast({ title: "入库成功", icon: "success" });
  },

  continueAdding() {
    this.setData({
      categoryIndex: 0, seasonIndex: 0, thicknessIndex: 0, formalityIndex: 0,
      imagePath: "", resultImage: "", originalCutoutUrl: "", hangerEditUrl: "", selectedImage: "original", hangerEditBusy: false,
      mimeType: "image/jpeg", fileSize: 0, taskId: "", draftId: "", manualUpload: null, manualUploaded: false,
      stage: "idle", stageText: "", errorText: "", isDemo: false, manualMode: false, aiProgress: null, mattingQualityFailed: false,
      form: emptyForm(), needsConfirmation: [], batchItems: [], batchIndex: -1, batchSummary: null, preparingBatch: false,
      multiDetections: [], qualityWarning: "", mattingConfirmed: false,
      styleOptions: selectableOptions(STYLES), sceneOptions: selectableOptions(SCENES)
    }, () => this.chooseImage());
  },

  skipBatchItem() {
    if (this.data.batchItems.length <= 1 || this.data.batchIndex < 0) return;
    this.updateCurrentBatch({ status: "skipped" });
    const nextIndex = nextBatchIndex(this.data.batchItems, this.data.batchIndex);
    nextIndex >= 0 ? this.loadBatchItem(nextIndex) : this.completeBatch();
  },

  completeBatch() {
    const summary = batchSummary(this.data.batchItems);
    this.setData({ stage: "batch-complete", stageText: "本次批量录入已完成", errorText: "", batchSummary: summary, imagePath: "", resultImage: "", originalCutoutUrl: "", hangerEditUrl: "", selectedImage: "original", hangerEditBusy: false, manualMode: false });
  },

  openWardrobe() { wx.redirectTo({ url: "/pages/wardrobe/index" }); },

  openPlans() { wx.navigateTo({ url: "/pages/plans/index" }); },

  goBack() {
    wx.navigateBack();
  }
});
