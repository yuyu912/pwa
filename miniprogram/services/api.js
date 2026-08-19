const config = require("../config");
const mock = require("./mock");
const session = require("./session");

let demoSessionPromise = null;

function requestOnce(path, method = "GET", data = {}, token = "") {
  if (!config.API_BASE_URL) return Promise.reject(new Error("尚未配置 uniCloud HTTP 地址。"));
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
          multi_garment_detection: "多件衣物定位",
          qwen_recognition: "千问识别"
        };
        const rawError = response.data?.error;
        const errorCode = typeof rawError === "object" ? rawError?.code : "";
        const errorMessage = typeof rawError === "object" ? rawError?.message : rawError;
        const message = errorCode === "PrePayResourceExhausted"
          ? "测试服务资源已耗尽，请在 uniCloud 控制台恢复云函数资源后重试。"
          : String(errorMessage || `请求失败（${response.statusCode}）`);
        const stage = stageNames[response.data?.aiTaskStage] || response.data?.aiTaskStage;
        const provider = [
          response.data?.providerCode,
          response.data?.fallbackReasonCode && `百度回退 ${response.data.fallbackReasonCode}`,
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
        requestError.code = response.data?.providerCode || errorCode || "";
        reject(requestError);
      },
      fail() { reject(new Error("网络请求失败，请检查测试环境地址和网络。")); }
    });
  });
}

async function demoSession() {
  if (!demoSessionPromise) {
    demoSessionPromise = requestOnce("/api/demo/session").then((result) => {
      session.save(result);
      return result;
    }).catch((error) => { demoSessionPromise = null; throw error; });
  }
  return demoSessionPromise;
}

async function request(path, method = "GET", data = {}) {
  if (config.DEMO_READONLY && !path.startsWith("/api/demo/")) {
    const demo = await demoSession();
    return requestOnce(path, method, data, demo.token);
  }
  return requestOnce(path, method, data, getApp().globalData.token);
}

const demoCache = new Map();
function monthRange() {
  const today = new Date();
  return {
    start: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
    end: new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString()
  };
}
async function demoBootstrap(start, end) {
  const range = start && end ? { start, end } : monthRange();
  const key = `${range.start}|${range.end}`;
  if (!demoCache.has(key)) {
    demoCache.set(key, request(`/api/demo/bootstrap?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`));
  }
  try { return await demoCache.get(key); }
  catch (error) { demoCache.delete(key); throw error; }
}
const readonlyError = () => Promise.reject(new Error("Demo 会话不允许执行此操作。"));

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

async function register({ username, password }) {
  const result = config.USE_MOCK
    ? mock.login(username)
    : await request("/api/auth/register", "POST", { username, password });
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
  getMe: async () => config.DEMO_READONLY ? { user: { ...(await demoBootstrap()).user, demoReadonly: true } } : config.USE_MOCK ? mock.getMe() : request("/api/auth/me"),
  getEntitlement: () => config.DEMO_READONLY ? Promise.resolve(null) : config.USE_MOCK ? Promise.resolve(mock.getEntitlement()) : request("/api/entitlements/me"),
  getPlans: () => config.USE_MOCK ? Promise.resolve(mock.getPlans()) : request("/api/plans"),
  listItems: async () => config.DEMO_READONLY ? (await demoBootstrap()).items : config.USE_MOCK ? mock.listItems() : request("/api/items"),
  getItem: async (id) => {
    if (config.DEMO_READONLY) return (await demoBootstrap()).items.find((item) => String(item.id) === String(id)) || null;
    if (config.USE_MOCK) return mock.getItem(id);
    return request(`/api/items/${encodeURIComponent(id)}`);
  },
  getAiBudget: () => config.USE_MOCK ? Promise.resolve(mock.getAiBudget()) : request("/api/ai-budget"),
  createUpload: (data) => config.USE_MOCK ? Promise.resolve(mock.createUpload(data)) : request("/api/uploads/presign", "POST", data),
  getStyleProfile: () => request("/api/style-profile"),
  getCityTrends: (cityCode) => request(`/api/city-trends?cityCode=${encodeURIComponent(cityCode)}`),
  understandOutfitRequest: (data) => request("/api/outfit-assistant/understand", "POST", data),
  createInspiration: (data) => request("/api/inspirations", "POST", data),
  createInspirationScreenshotUpload: (id, data) => request(`/api/inspirations/${encodeURIComponent(id)}/screenshot/presign`, "POST", data),
  analyzeInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}/analyze`, "POST"),
  confirmInspiration: (id, data) => request(`/api/inspirations/${encodeURIComponent(id)}/confirm`, "PATCH", data),
  rematchInspiration: (id, data) => request(`/api/inspirations/${encodeURIComponent(id)}/rematch`, "POST", data),
  listInspirations: () => request("/api/inspirations"),
  getInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}`),
  deleteInspiration: (id) => request(`/api/inspirations/${encodeURIComponent(id)}`, "DELETE"),
  uploadBinary: (upload, filePath, mimeType) => config.USE_MOCK ? Promise.resolve(mock.uploadBinary(upload, filePath, mimeType)) : uploadBinary(upload.uploadUrl, filePath, mimeType),
  recognizeItem: (taskId) => config.USE_MOCK ? Promise.resolve(mock.recognizeItem(taskId)) : request("/api/recognize", "POST", { taskId }),
  mattingItem: (taskId) => config.USE_MOCK ? Promise.resolve(mock.mattingItem(taskId)) : request(`/api/tasks/${taskId}/matting`, "POST"),
  detectMultipleGarments: (taskId) => config.USE_MOCK ? Promise.resolve(mock.detectMultipleGarments(taskId)) : request(`/api/tasks/${taskId}/multi-garments`, "POST"),
  splitMultipleGarments: (taskId, detectionIds) => config.USE_MOCK ? Promise.resolve(mock.splitMultipleGarments(taskId, detectionIds)) : request(`/api/tasks/${taskId}/multi-garments/selection`, "POST", { detectionIds }),
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
  getWearLogs: async (id) => config.DEMO_READONLY ? (await demoBootstrap()).wearLogs.filter((log) => String(log.item?.id || log.itemId) === String(id)) : config.USE_MOCK ? mock.getWearLogs(id) : request(`/api/items/${id}/wear-logs`),
  getMonthlyWearLogs: async (start, end) => config.DEMO_READONLY ? (await demoBootstrap(start, end)).wearLogs : config.USE_MOCK
    ? Promise.resolve(mock.getMonthlyWearLogs(start, end))
    : request(`/api/wear-logs?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  getOutfitRecord: (id) => config.DEMO_READONLY ? Promise.reject(new Error("请使用日历中的只读穿搭快照。")) : request(`/api/outfit-records/${encodeURIComponent(id)}`),
  listOutfitPlans: async () => config.DEMO_READONLY ? (await demoBootstrap()).outfitPlans : request("/api/outfit-plans"),
  createOutfitPlan: (data) => request("/api/outfit-plans", "POST", data),
  updateOutfitPlan: (id, data) => request(`/api/outfit-plans/${encodeURIComponent(id)}`, "PUT", data),
  renameOutfitPlan: (id, title) => request(`/api/outfit-plans/${encodeURIComponent(id)}`, "PATCH", { title }),
  copyOutfitPlan: (id, data) => request(`/api/outfit-plans/${encodeURIComponent(id)}/copy`, "POST", data),
  deleteOutfitPlan: (id) => request(`/api/outfit-plans/${encodeURIComponent(id)}`, "DELETE"),
  recordOutfitPlanWear: (id, data) => request(`/api/outfit-plans/${encodeURIComponent(id)}/wear`, "POST", data),
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
  requestAccountDeletion: () => config.DEMO_READONLY ? readonlyError() : request("/api/auth/delete-request", "POST"),
  submitComplaint: (data) => request("/api/complaints", "POST", data)
};
