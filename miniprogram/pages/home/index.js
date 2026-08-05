const api = require("../../services/api");
const session = require("../../services/session");
const weatherService = require("../../services/weather");

const HOME_WEATHER_TIPS = {
  "晴": "适合轻薄透气穿搭",
  "多云": "适合柔和色系穿搭",
  "小雨": "适合轻外套与防雨鞋",
  "降温": "适合叠穿保暖"
};

const entitlementView = (entitlement) => {
  const remainingMs = Math.max(0, Date.parse(entitlement.trialEndsAt || "") - Date.parse(entitlement.serverTime || ""));
  const quota = entitlement.quota;
  return {
    ...entitlement,
    remainingDays: entitlement.status === "trialing" ? Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))) : 0,
    title: entitlement.status === "trialing" ? "7 天 AI 权益试用中" : entitlement.status === "active" ? "AI 会员有效" : "AI 权益试用已结束",
    note: entitlement.status === "trialing" ? `剩余约 ${Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)))} 天` : entitlement.status === "active" ? "查看当前权益" : "免费保底额度使用中，当前功能不会被锁定",
    quotaText: quota ? `属性识别 ${quota.recognition.remaining}/${quota.recognition.limit} · 移除衣架 ${quota.hangerRemoval.remaining}/${quota.hangerRemoval.limit}` : "",
    quotaWarning: quota?.recognition.exceeded || quota?.hangerRemoval.exceeded
  };
};

Page({
  data: { itemCount: 0, weatherTemp: "选择地区", weatherCopy: "设置地区后获取实时天气", weatherTip: "按衣橱推荐今天穿什么", hasLocation: false, imageErrors: {}, entitlement: null },
  async onShow() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    try { this.setData({ itemCount: (await api.listItems()).length }); }
    catch { this.setData({ itemCount: 0 }); }
    try {
      const entitlement = entitlementView(await api.getEntitlement());
      this.setData({ entitlement });
      const app = getApp();
      if (entitlement.status === "expired" && !app.globalData.entitlementPromptShown) {
        app.globalData.entitlementPromptShown = true;
        wx.showModal({
          title: "7 天试用已结束",
          content: "周、月、年套餐正在准备中。本阶段不会收费，也不会锁定现有功能。",
          confirmText: "查看套餐",
          cancelText: "稍后",
          success: ({ confirm }) => { if (confirm) this.toPlans(); }
        });
      }
    } catch {}
    const location = weatherService.loadLocation();
    if (location) {
      this.setData({ weatherTemp: "获取中", weatherCopy: location.cityName, weatherTip: "正在读取实时天气", hasLocation: true });
      try {
        const weather = weatherService.formatLiveWeather(
          await api.getWeather(location.districtCode || location.cityCode || location.provinceCode),
          location
        );
        this.setData({ weatherTemp: `${weather.temperature}°C`, weatherCopy: `${location.cityName} · ${weather.condition}`, weatherTip: HOME_WEATHER_TIPS[weather.condition] || "查看今日穿搭建议" });
      } catch {
        this.setData({ weatherTemp: "暂不可用", weatherCopy: location.cityName, weatherTip: "点击查看或稍后重试" });
      }
    }
  },
  toWardrobe() { wx.navigateTo({ url: "/pages/wardrobe/index" }); },
  // 新衣分析先复用已验证的图片识别页，确认候选标签后再进入决策报告。
  toCandidate() { wx.navigateTo({ url: "/pages/add-item/index?mode=candidate" }); },
  toCandidateWaitlist() { wx.navigateTo({ url: "/pages/candidate-waitlist/index" }); },
  toCommunity() { wx.navigateTo({ url: "/pages/community/index" }); },
  toWeather() { wx.navigateTo({ url: "/pages/weather/index" }); },
  toTodayOutfit() { wx.navigateTo({ url: "/pages/today-outfit/index" }); },
  toAdd() { wx.navigateTo({ url: "/pages/add-item/index" }); },
  toFriends() { wx.navigateTo({ url: "/pages/friends/index" }); },
  toWearCalendar() { wx.navigateTo({ url: "/pages/wear-calendar/index" }); },
  toMine() { wx.navigateTo({ url: "/pages/account/index" }); },
  toPlans() { wx.navigateTo({ url: "/pages/plans/index" }); },
  onActionImageError(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ [`imageErrors.${id}`]: true });
  }
});
