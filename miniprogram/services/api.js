const config = require("../config");
const mock = require("./mock");
const session = require("./session");

function request(path, method = "GET", data = {}) {
  if (!config.API_BASE_URL) return Promise.reject(new Error("尚未配置 uniCloud HTTP 地址。"));
  const token = getApp().globalData.token;
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.API_BASE_URL}${path}`,
      method,
      data,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response.data);
        const stageNames = {
          read_source: "COS 读取原图",
          goods_matting: "腾讯商品抠图",
          qwen_recognition: "千问识别"
        };
        const message = response.data?.error || `请求失败（${response.statusCode}）`;
        const stage = stageNames[response.data?.aiTaskStage] || response.data?.aiTaskStage;
        const provider = [
          response.data?.providerCode,
          response.data?.providerStatus && `HTTP ${response.data.providerStatus}`,
          response.data?.providerMessage
        ].filter(Boolean).join(" / ");
        const trace = [
          stage && `阶段：${stage}`,
          provider && `原因：${provider}`,
          response.data?.requestId && `请求号：${response.data.requestId}`,
          response.data?.buildId && `版本：${response.data.buildId}`
        ].filter(Boolean).join("；");
        // 只显示安全的阶段、错误码、HTTP 状态和请求号；密钥与供应商完整响应不会返回小程序。
        const requestError = new Error(trace ? `${message}（${trace}）` : message);
        requestError.code = response.data?.providerCode || "";
        reject(requestError);
      },
      fail() { reject(new Error("网络请求失败，请检查测试环境地址和网络。")); }
    });
  });
}

function uploadBinary(uploadUrl, filePath, mimeType) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success(file) {
        wx.request({
          url: uploadUrl,
          method: "PUT",
          data: file.data,
          header: { "Content-Type": mimeType },
          success(response) {
            if (response.statusCode >= 200 && response.statusCode < 300) return resolve();
            reject(new Error(`图片上传失败（${response.statusCode}）`));
          },
          fail() { reject(new Error("图片上传失败，请检查网络和 COS 合法域名。")); }
        });
      },
      fail() { reject(new Error("无法读取刚才选择的图片。")); }
    });
  });
}

async function login({ username, password }) {
  const result = config.USE_MOCK ? mock.login(username) : await request("/api/auth/login", "POST", { username, password });
  session.save(result);
  return result;
}

async function register({ inviteCode, username, password }) {
  // 邀请码只在云端注册时使用：云函数会原子校验并占用，客户端不能自行视为有效。
  const result = config.USE_MOCK
    ? mock.login(username)
    : await request("/api/auth/register", "POST", { inviteCode, username, password });
  // 注册成功后与登录共用同一份会话保存逻辑，后续请求自动携带 JWT。
  session.save(result);
  return result;
}

async function registerOutfitGuest({ token, username, password }) {
  const result = config.USE_MOCK
    ? mock.login(username)
    : await request("/api/auth/outfit-guest-register", "POST", { token, username, password });
  session.save(result);
  return result;
}

module.exports = {
  login,
  register,
  registerOutfitGuest,
  getMe: () => config.USE_MOCK ? Promise.resolve(mock.getMe()) : request("/api/auth/me"),
  getEntitlement: () => config.USE_MOCK ? Promise.resolve(mock.getEntitlement()) : request("/api/entitlements/me"),
  getPlans: () => config.USE_MOCK ? Promise.resolve(mock.getPlans()) : request("/api/plans"),
  listItems: () => config.USE_MOCK ? Promise.resolve(mock.listItems()) : request("/api/items"),
  getItem: async (id) => {
    if (config.USE_MOCK) return mock.getItem(id);
    return request(`/api/items/${encodeURIComponent(id)}`);
  },
  getAiBudget: () => config.USE_MOCK ? Promise.resolve(mock.getAiBudget()) : request("/api/ai-budget"),
  createUpload: (data) => config.USE_MOCK ? Promise.resolve(mock.createUpload(data)) : request("/api/uploads/presign", "POST", data),
  createOutfitCapture: (data) => request("/api/outfit-captures/presign", "POST", data),
  analyzeOutfitCapture: (id) => request(`/api/outfit-captures/${encodeURIComponent(id)}/analyze`, "POST"),
  prepareOutfitDetection: (captureId, detectionId) => request(`/api/outfit-captures/${encodeURIComponent(captureId)}/detections/${encodeURIComponent(detectionId)}/prepare`, "POST"),
  cancelOutfitCapture: (id) => request(`/api/outfit-captures/${encodeURIComponent(id)}`, "DELETE"),
  confirmOutfitCapture: (id, data) => request(`/api/outfit-captures/${encodeURIComponent(id)}/confirm`, "POST", data),
  getStyleProfile: () => request("/api/style-profile"),
  getCityTrends: (cityCode) => request(`/api/city-trends?cityCode=${encodeURIComponent(cityCode)}`),
  createInspiration: (data) => request("/api/inspirations", "POST", data),
  createInspirationScreenshotUpload: (id, data) => request(`/api/inspirations/${encodeURIComponent(id)}/screenshot/presign`, "POST", data),
  analyzeInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}/analyze`, "POST"),
  confirmInspiration: (id, data) => request(`/api/inspirations/${encodeURIComponent(id)}/confirm`, "PATCH", data),
  listInspirations: () => request("/api/inspirations"),
  getInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}`),
  deleteInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}`, "DELETE"),
  uploadBinary: (upload, filePath, mimeType) => config.USE_MOCK ? Promise.resolve(mock.uploadBinary(upload, filePath, mimeType)) : uploadBinary(upload.uploadUrl, filePath, mimeType),
  recognizeItem: (taskId) => config.USE_MOCK ? Promise.resolve(mock.recognizeItem(taskId)) : request("/api/recognize", "POST", { taskId }),
  mattingItem: (taskId) => config.USE_MOCK ? Promise.resolve(mock.mattingItem(taskId)) : request(`/api/tasks/${taskId}/matting`, "POST"),
  removeHanger: (taskId) => config.USE_MOCK ? Promise.resolve(mock.removeHanger(taskId)) : request(`/api/tasks/${taskId}/hanger-removal`, "POST"),
  selectTaskImage: (taskId, choice) => config.USE_MOCK ? Promise.resolve(mock.selectTaskImage(taskId, choice)) : request(`/api/tasks/${taskId}/image-selection`, "POST", { choice }),
  recognizeLabels: (taskId) => config.USE_MOCK ? Promise.resolve(mock.recognizeItem(taskId)) : request(`/api/tasks/${taskId}/recognition`, "POST"),
  retryRecognition: (taskId) => config.USE_MOCK ? Promise.resolve(mock.recognizeItem(taskId)) : request(`/api/tasks/${taskId}/retry`, "POST"),
  createItem: (data) => config.USE_MOCK ? Promise.resolve(mock.createItem(data)) : request("/api/items", "POST", data),
  createManualItem: (data) => config.USE_MOCK ? Promise.resolve(mock.createManualItem(data)) : request("/api/items/manual", "POST", data),
  updateItem: (id, data) => config.USE_MOCK ? Promise.resolve(mock.updateItem(id, data)) : request(`/api/items/${id}`, "PATCH", data),
  deleteItem: (id) => config.USE_MOCK ? Promise.resolve(mock.deleteItem(id)) : request(`/api/items/${id}`, "DELETE"),
  listIdleItems: () => config.USE_MOCK ? Promise.resolve(mock.listIdleItems()) : request("/api/idle-items"),
  markItemIdle: (id, data) => config.USE_MOCK ? Promise.resolve(mock.markItemIdle(id, data)) : request(`/api/items/${id}/idle`, "POST", data),
  restoreIdleItem: (id) => config.USE_MOCK ? Promise.resolve(mock.restoreIdleItem(id)) : request(`/api/items/${id}/idle`, "DELETE"),
  saveItemListing: (id, data) => config.USE_MOCK ? Promise.resolve(mock.saveItemListing(id, data)) : request(`/api/items/${id}/listing`, "PUT", data),
  getWearLogs: (id) => config.USE_MOCK ? Promise.resolve(mock.getWearLogs(id)) : request(`/api/items/${id}/wear-logs`),
  getMonthlyWearLogs: (start, end) => config.USE_MOCK
    ? Promise.resolve(mock.getMonthlyWearLogs(start, end))
    : request(`/api/wear-logs?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  getRewards: () => config.USE_MOCK ? Promise.resolve(mock.getRewards()) : request("/api/rewards/me"),
  getWeather: (adcode) => config.USE_MOCK
    ? Promise.reject(new Error("模拟模式不提供实时天气。"))
    : request(`/api/weather?adcode=${encodeURIComponent(adcode)}`),
  listCommunityPosts: (scope = "feed") => request(`/api/community/posts?scope=${encodeURIComponent(scope)}`),
  getCommunityRanking: () => request("/api/community/ranking"),
  createCommunityPost: (data) => request("/api/community/posts", "POST", data),
  removeCommunityPost: (id) => request(`/api/community/posts/${encodeURIComponent(id)}`, "DELETE"),
  setCommunityLike: (id, action) => request(`/api/community/posts/${encodeURIComponent(id)}/like`, "PUT", { action }),
  reportCommunityPost: (id, reason) => request(`/api/community/posts/${encodeURIComponent(id)}/report`, "POST", { reason }),
  getCommunityReview: () => request("/api/community/admin/review"),
  reviewCommunityPost: (id, status, note = "") => request(`/api/community/admin/posts/${encodeURIComponent(id)}`, "PATCH", { status, note }),
  resolveCommunityReport: (id, action) => request(`/api/community/admin/reports/${encodeURIComponent(id)}`, "PATCH", { action }),
  addWearLog: (id, data) => config.USE_MOCK ? Promise.resolve(mock.addWearLog(id, data)) : request(`/api/items/${id}/wear-logs`, "POST", data),
  createCandidate: (data) => config.USE_MOCK ? Promise.resolve(mock.createCandidate(data)) : request("/api/candidates", "POST", data),
  listWaitingCandidates: () => config.USE_MOCK ? Promise.resolve(mock.listWaitingCandidates()) : request("/api/candidates?decision=wait"),
  getCandidate: (id) => config.USE_MOCK ? Promise.resolve(mock.getCandidate(id)) : request(`/api/candidates/${id}`),
  analyzeCandidate: (id) => config.USE_MOCK ? Promise.resolve(mock.analyzeCandidate(id)) : request(`/api/candidates/${id}/analyze`, "POST"),
  recordDecision: (id, decision) => config.USE_MOCK ? Promise.resolve(mock.recordDecision(id, decision)) : request(`/api/candidates/${id}/decision`, "POST", { decision }),
  createOutfitRequest: (data) => request("/api/outfit-requests", "POST", data),
  getOutfitRequest: (token) => request(`/api/outfit-requests/${encodeURIComponent(token)}`),
  replyToOutfitRequest: (token, data) => request(`/api/outfit-requests/${encodeURIComponent(token)}/responses`, "POST", data),
  updateOutfitReply: (token, data) => request(`/api/outfit-requests/${encodeURIComponent(token)}/responses/me`, "PATCH", data),
  closeOutfitRequest: (id) => request(`/api/outfit-requests/${encodeURIComponent(id)}/close`, "POST"),
  getOutfitResults: (id) => request(`/api/outfit-requests/${encodeURIComponent(id)}/results`),
  reportOutfitReply: (id, reason) => request(`/api/outfit-responses/${encodeURIComponent(id)}/report`, "POST", { reason }),
  requestAccountDeletion: () => request("/api/auth/delete-request", "POST"),
  submitComplaint: (data) => request("/api/complaints", "POST", data)
};
