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
        reject(new Error(trace ? `${message}（${trace}）` : message));
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
  listItems: () => config.USE_MOCK ? Promise.resolve(mock.listItems()) : request("/api/items"),
  getItem: async (id) => {
    if (config.USE_MOCK) return mock.getItem(id);
    const list = await request("/api/items");
    return list.find((item) => String(item.id) === String(id));
  },
  getAiBudget: () => config.USE_MOCK ? Promise.resolve(mock.getAiBudget()) : request("/api/ai-budget"),
  createUpload: (data) => config.USE_MOCK ? Promise.resolve(mock.createUpload(data)) : request("/api/uploads/presign", "POST", data),
  uploadBinary: (upload, filePath, mimeType) => config.USE_MOCK ? Promise.resolve(mock.uploadBinary(upload, filePath, mimeType)) : uploadBinary(upload.uploadUrl, filePath, mimeType),
  recognizeItem: (taskId) => config.USE_MOCK ? Promise.resolve(mock.recognizeItem(taskId)) : request("/api/recognize", "POST", { taskId }),
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
  addWearLog: (id, data) => config.USE_MOCK ? Promise.resolve(mock.addWearLog(id, data)) : request(`/api/items/${id}/wear-logs`, "POST", data),
  createCandidate: (data) => config.USE_MOCK ? Promise.resolve(mock.createCandidate(data)) : request("/api/candidates", "POST", data),
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
