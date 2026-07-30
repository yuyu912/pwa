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
        reject(new Error(response.data?.error || `请求失败（${response.statusCode}）`));
      },
      fail() { reject(new Error("网络请求失败，请检查测试环境地址和网络。")); }
    });
  });
}

async function login({ username, password }) {
  const result = config.USE_MOCK ? mock.login(username) : await request("/api/auth/login", "POST", { username, password });
  session.save(result);
  return result;
}

module.exports = {
  login,
  getMe: () => config.USE_MOCK ? Promise.resolve(mock.getMe()) : request("/api/auth/me"),
  listItems: () => config.USE_MOCK ? Promise.resolve(mock.listItems()) : request("/api/items"),
  getItem: async (id) => {
    if (config.USE_MOCK) return mock.getItem(id);
    const list = await request("/api/items");
    return list.find((item) => String(item.id) === String(id));
  },
  addWearLog: (id, data) => config.USE_MOCK ? Promise.resolve(mock.addWearLog(id, data)) : request(`/api/items/${id}/wear-logs`, "POST", data),
  createCandidate: () => config.USE_MOCK ? Promise.resolve(mock.createCandidate()) : Promise.reject(new Error("真实候选新衣创建依赖图片识别草稿，今天未接入上传与 AI 任务。")),
  analyzeCandidate: (id) => config.USE_MOCK ? Promise.resolve(mock.analyzeCandidate(id)) : request(`/api/candidates/${id}/analyze`, "POST"),
  recordDecision: (id, decision) => config.USE_MOCK ? Promise.resolve(mock.recordDecision(id, decision)) : request(`/api/candidates/${id}/decision`, "POST", { decision })
};
