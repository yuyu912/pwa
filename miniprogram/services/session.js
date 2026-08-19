const APP = getApp;
const config = require("../config");
const DEMO_TOKEN = "readonly-demo";

function demoSession() {
  const current = APP().globalData.user;
  const user = current?.demoReadonly ? current : { id: "readonly-demo", username: "只读演示", role: "user", demoReadonly: true };
  APP().globalData.user = user;
  APP().globalData.token = DEMO_TOKEN;
  return { user, token: DEMO_TOKEN };
}

function restore() {
  if (config.DEMO_READONLY) return demoSession();
  const user = wx.getStorageSync("wardrobe_user");
  const token = wx.getStorageSync("wardrobe_token");
  if (user && token) {
    APP().globalData.user = user;
    APP().globalData.token = token;
  } else {
    // 从只读 Demo 热切换到正式模式时，不允许内存中的演示 Token 继续发起写请求。
    APP().globalData.user = null;
    APP().globalData.token = "";
  }
  return { user, token };
}

function save({ user, token }) {
  if (config.DEMO_READONLY) {
    APP().globalData.user = { ...user, demoReadonly: true };
    APP().globalData.token = DEMO_TOKEN;
    return;
  }
  APP().globalData.user = user;
  APP().globalData.token = token;
  wx.setStorageSync("wardrobe_user", user);
  wx.setStorageSync("wardrobe_token", token);
}

function clear() {
  if (config.DEMO_READONLY) return demoSession();
  APP().globalData.user = null;
  APP().globalData.token = "";
  wx.removeStorageSync("wardrobe_user");
  wx.removeStorageSync("wardrobe_token");
}

module.exports = { restore, save, clear };
