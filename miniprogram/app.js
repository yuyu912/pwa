function shareTokenFrom(options = {}) {
  if (options.query?.token) return String(options.query.token);
  // 少数微信入口会把 query 放进 scene；只接受 token= 形式，避免把无关 scene 当作分享凭据。
  const scene = decodeURIComponent(String(options.scene || ""));
  const match = scene.match(/(?:^|[?&])token=([^&]+)/);
  return match ? match[1] : "";
}

function rememberShareToken(app, options) {
  const token = shareTokenFrom(options);
  if (!token) return;
  app.globalData.pendingOutfitToken = token;
  wx.setStorageSync("pending_outfit_token", token);
}

App({
  globalData: {
    user: null,
    token: "",
    currentCandidate: null,
    pendingOutfitToken: ""
  },
  onLaunch(options) { rememberShareToken(this, options); },
  onShow(options) { rememberShareToken(this, options); }
});
