/**
 * 真实联调使用已部署的 uniCloud HTTP 地址。小程序 API 调用会携带
 * Bearer Token；只有用户主动提交图片识别时才会调用付费 AI 服务。
 */
module.exports = {
  USE_MOCK: false,
  API_BASE_URL: "https://fc-mp-cbf1a3d9-43f4-417f-8d75-271d0a0ddc92.next.bspapp.com/wardrobe-api"
};
