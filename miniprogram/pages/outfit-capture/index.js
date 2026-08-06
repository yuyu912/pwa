const api = require("../../services/api");
const weatherService = require("../../services/weather");
const SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(1000, Number(milliseconds) || 1000)));

Page({
  data: { photo: "", captureId: "", detections: [], selected: {}, selectedRecent: {}, skipDetectionIndexes: [], recentItems: [], scenes: SCENES, sceneIndex: 0, busy: false, error: "", originalDeleted: false },
  async onLoad() { try { this.setData({ recentItems: (await api.listItems()).slice(0, 12) }); } catch {} },
  choosePhoto() {
    const success = async (result) => {
      const selected = result.tempFiles?.[0] || (result.tempFilePaths?.[0] ? { tempFilePath: result.tempFilePaths[0], size: 0 } : null);
      if (!selected) return;
      const file = selected.size ? selected : { ...selected, ...(await new Promise((resolve, reject) => wx.getFileInfo({ filePath: selected.tempFilePath, success: resolve, fail: reject }))) };
      if (this.data.captureId) await api.cancelOutfitCapture(this.data.captureId).catch(() => {});
      this.setData({ photo: file.tempFilePath, captureId: "", detections: [], selected: {}, selectedRecent: {}, skipDetectionIndexes: [], error: "", originalDeleted: false });
      await this.analyze(file);
    };
    const fail = (error) => { if (!String(error?.errMsg || "").includes("cancel")) wx.showToast({ title: "无法打开相机或相册", icon: "none" }); };
    if (typeof wx.chooseMedia === "function") return wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["camera", "album"], success, fail });
    wx.chooseImage({ count: 1, sourceType: ["camera", "album"], success, fail });
  },
  async analyze(file) {
    this.setData({ busy: true, error: "" });
    try {
      const mimeType = /\.png$/i.test(file.tempFilePath) ? "image/png" : "image/jpeg";
      const upload = await api.createOutfitCapture({ mimeType, size: file.size });
      this.setData({ captureId: upload.captureId });
      await api.uploadBinary(upload, file.tempFilePath, mimeType);
      const result = await api.analyzeOutfitCapture(upload.captureId);
      // 候选只作提醒；没有用户明确选择时，每件检测结果都按新衣入库。
      this.setData({ detections: result.detections, selected: {}, originalDeleted: result.originalDeleted });
      await this.prepareDetections(upload.captureId, result.detections);
    } catch (error) { this.setData({ error: error.message || "识别失败，可从最近衣物快速勾选。" }); }
    finally { this.setData({ busy: false }); }
  },
  async prepareDetections(captureId, detections) {
    for (let index = 0; index < detections.length; index += 1) {
      this.setData({
        [`detections[${index}].processingStatus`]: "processing",
        [`detections[${index}].processingStage`]: detections[index].segmentationStatus === "repair_pending"
          ? "occlusion_repair"
          : detections[index].segmentationStatus === "ready" ? "source_mask_verification" : "segmentation_failed",
        [`detections[${index}].processingError`]: ""
      });
      try {
        let prepared;
        let queueCount = 0;
        do {
          prepared = await api.prepareOutfitDetection(captureId, detections[index].detectionId);
          if (prepared.processingStatus === "queued") {
            queueCount += 1;
            if (queueCount > 20) throw new Error("图片生成排队时间过长，请稍后重新尝试。");
            this.setData({ [`detections[${index}]`]: prepared });
            await wait(Math.min(90000, prepared.retryAfterMs || 31000));
            continue;
          }
          if (prepared.retryable) {
            this.setData({ [`detections[${index}]`]: prepared });
            await wait(Math.min(90000, prepared.retryAfterMs || 65000));
            continue;
          }
          if (prepared.correctionAvailable) {
            this.setData({ [`detections[${index}].processingStatus`]: "processing", [`detections[${index}].processingStage`]: "correction" });
            continue;
          }
          break;
        } while (true);
        this.setData({ [`detections[${index}]`]: prepared });
      } catch (error) {
        this.setData({ [`detections[${index}].processingStatus`]: "failed", [`detections[${index}].processingError`]: error.message || "本件未能可靠拆解" });
      }
    }
  },
  selectMatch(event) {
    const slot = event.currentTarget.dataset.slot;
    const id = event.currentTarget.dataset.id;
    this.setData({ [`selected.${slot}`]: this.data.selected[slot] === id ? "" : id });
  },
  toggleRecent(event) {
    const id = event.currentTarget.dataset.id;
    const selectedRecent = { ...this.data.selectedRecent };
    if (selectedRecent[id]) delete selectedRecent[id]; else selectedRecent[id] = id;
    this.setData({ selectedRecent });
  },
  onSceneChange(event) { this.setData({ sceneIndex: Number(event.detail.value) }); },
  async confirm() {
    const itemIds = [...new Set([...Object.values(this.data.selected), ...Object.values(this.data.selectedRecent)].filter(Boolean))];
    if (!this.data.captureId || (!this.data.detections.length && !itemIds.length)) return wx.showToast({ title: "没有可以保存的衣物", icon: "none" });
    this.setData({ busy: true });
    try {
      const location = weatherService.loadLocation();
      const detectionSelections = Object.entries(this.data.selected).map(([detectionIndex, itemId]) => ({ detectionIndex: Number(detectionIndex), itemId }));
      const result = await api.confirmOutfitCapture(this.data.captureId, { itemIds, detectionSelections, skipDetectionIndexes: this.data.skipDetectionIndexes, scene: SCENES[this.data.sceneIndex], weather: { city: location?.cityName || "" } });
      this.setData({ captureId: "" });
      wx.showModal({ title: "今日穿搭已记录", content: `新增 ${result.createdCount} 件，复用已有 ${result.reusedCount} 件${result.pendingCount ? `，${result.pendingCount} 件待完善` : ""}`, showCancel: false, success: () => wx.navigateBack() });
    } catch (error) { wx.showToast({ title: error.message || "保存失败", icon: "none" }); }
    finally { this.setData({ busy: false }); }
  },
  manualOnly() { this.setData({ skipDetectionIndexes: this.data.detections.map((_, index) => index), detections: [], error: "已切换为最近衣物快速勾选。" }); },
  async onUnload() { if (this.data.captureId) await api.cancelOutfitCapture(this.data.captureId).catch(() => {}); }
});
