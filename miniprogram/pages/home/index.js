const api = require("../../services/api");
const session = require("../../services/session");
const weatherService = require("../../services/weather");

const HOME_WEATHER_TIPS = {
  "晴": "适合轻薄透气穿搭",
  "多云": "适合柔和色系穿搭",
  "小雨": "适合轻外套与防雨鞋",
  "降温": "适合叠穿保暖"
};

Page({
  data: { itemCount: 0, weatherTemp: "选择地区", weatherCopy: "设置所在地后获取演示天气", weatherTip: "按衣橱推荐今天穿什么", hasLocation: false, imageErrors: {} },
  async onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    try { this.setData({ itemCount: (await api.listItems()).length }); }
    catch { this.setData({ itemCount: 0 }); }
    const location = weatherService.loadLocation();
    if (location) {
      const weather = weatherService.getDemoWeather(location);
      this.setData({ weatherTemp: `${weather.low}–${weather.high}°C`, weatherCopy: `${location.cityName} · ${weather.condition} · 演示`, weatherTip: HOME_WEATHER_TIPS[weather.condition] || "查看今日穿搭建议", hasLocation: true });
    }
  },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  // 新衣分析先复用已验证的图片识别页，确认候选标签后再进入决策报告。
  toCandidate() { wx.navigateTo({ url: "/pages/add-item/index?mode=candidate" }); },
  toWeather() { wx.navigateTo({ url: "/pages/weather/index" }); },
  toTodayOutfit() { wx.navigateTo({ url: "/pages/today-outfit/index" }); },
  toAdd() { wx.navigateTo({ url: "/pages/add-item/index" }); },
  toFriends() { wx.navigateTo({ url: "/pages/friends/index" }); },
  toMine() { wx.showToast({ title: "个人中心将在账号联调后开放", icon: "none" }); },
  onActionImageError(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ [`imageErrors.${id}`]: true });
  }
});
