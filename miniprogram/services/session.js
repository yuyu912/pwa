const APP = getApp;

function restore() {
  const user = wx.getStorageSync("wardrobe_user");
  const token = wx.getStorageSync("wardrobe_token");
  if (user && token) {
    APP().globalData.user = user;
    APP().globalData.token = token;
  }
  return { user, token };
}

function save({ user, token }) {
  APP().globalData.user = user;
  APP().globalData.token = token;
  wx.setStorageSync("wardrobe_user", user);
  wx.setStorageSync("wardrobe_token", token);
}

function clear() {
  APP().globalData.user = null;
  APP().globalData.token = "";
  wx.removeStorageSync("wardrobe_user");
  wx.removeStorageSync("wardrobe_token");
}

module.exports = { restore, save, clear };
