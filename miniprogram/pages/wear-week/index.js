const api = require("../../services/api");
const history = require("../../utils/wear-history");

Page({
  data: {
    selectedKey: "",
    rangeTitle: "本周",
    yearText: "",
    days: [],
    totalCount: 0,
    distinctItemCount: 0,
    weeklyItems: [],
    weeklyFavorite: null,
    loading: true,
    error: "",
    imageFailures: {}
  },
  onLoad(options) {
    const selectedKey = history.dateFromKey(options.date) ? options.date : history.dateKey(new Date());
    this.setData({ selectedKey });
  },
  onShow() {
    this.loadWeek();
  },
  async loadWeek() {
    const range = history.weekRange(this.data.selectedKey);
    if (!range) return this.setData({ loading: false, error: "日期无效，请返回日历重新选择。" });
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const logs = await api.getMonthlyWearLogs(range.start, range.end);
      const groups = history.groupWearLogs(history.normalizeWearLogs(logs));
      const daySummaries = history.buildDaySummaries(groups, "week-day");
      const summary = history.buildHistorySummary(groups, "week");
      const title = history.weekTitle(range);
      this.setData({
        rangeTitle: title.title,
        yearText: title.yearText,
        days: range.days.map((day) => ({
          ...day,
          previewItems: daySummaries[day.key]?.previewItems || [],
          count: daySummaries[day.key]?.count || 0
        })),
        totalCount: summary.totalCount,
        distinctItemCount: summary.distinctItemCount,
        weeklyItems: summary.items,
        weeklyFavorite: summary.favorite,
        loading: false
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error.message || "本周穿着记录加载失败，请重试。",
        days: [],
        totalCount: 0,
        distinctItemCount: 0,
        weeklyItems: [],
        weeklyFavorite: null
      });
    }
  },
  openItem(event) {
    const { id, active } = event.currentTarget.dataset;
    if (!active) return wx.showToast({ title: "该衣物已移出衣橱", icon: "none" });
    wx.navigateTo({ url: `/pages/item-detail/index?id=${encodeURIComponent(id)}` });
  },
  onImageError(event) {
    this.setData({ [`imageFailures.${event.currentTarget.dataset.id}`]: true });
  },
  retry() {
    this.loadWeek();
  }
});

