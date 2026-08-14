const api = require("../../services/api");
const history = require("../../utils/wear-history");
const WEAR_RECORD_PREVIEW_KEY = "wardrobloom_wear_record_preview";

Page({
  data: {
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    year: 0,
    month: 0,
    monthText: "",
    days: [],
    groups: [],
    selectedKey: "",
    selectedTitle: "今天",
    selectedSubtitle: "",
    selectedGroups: [],
    totalCount: 0,
    distinctItemCount: 0,
    monthlyItems: [],
    monthlyFavorite: null,
    lastTappedKey: "",
    loading: true,
    error: "",
    imageFailures: {}
  },
  onLoad() {
    const today = new Date();
    const selectedKey = history.dateKey(today);
    const copy = history.selectedDateCopy(selectedKey, today);
    this.setData({ year: today.getFullYear(), month: today.getMonth(), selectedKey, selectedTitle: copy.title, selectedSubtitle: copy.subtitle });
  },
  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    this.loadMonth();
  },
  async loadMonth() {
    const { year, month, selectedKey } = this.data;
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const range = history.monthRange(year, month);
      const logs = await api.getMonthlyWearLogs(range.start, range.end);
      const normalized = history.normalizeWearLogs(logs);
      const groups = history.groupWearLogs(normalized);
      const daySummaries = history.buildDaySummaries(groups);
      const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
      const effectiveSelectedKey = selectedKey.startsWith(monthPrefix) ? selectedKey : history.defaultSelectedKey(year, month, groups);
      const copy = history.selectedDateCopy(effectiveSelectedKey);
      const summary = history.buildHistorySummary(groups, "month");
      this.setData({
        groups,
        selectedKey: effectiveSelectedKey,
        selectedTitle: copy.title,
        selectedSubtitle: copy.subtitle,
        selectedGroups: groups.filter((group) => group.dateKey === effectiveSelectedKey),
        days: history.calendarDays(year, month, effectiveSelectedKey, daySummaries),
        monthText: `${year}年${month + 1}月`,
        totalCount: summary.totalCount,
        distinctItemCount: summary.distinctItemCount,
        monthlyItems: summary.items,
        monthlyFavorite: summary.favorite,
        lastTappedKey: "",
        loading: false
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error.message || "穿着记录加载失败，请重试。",
        groups: [],
        selectedGroups: [],
        monthlyItems: [],
        monthlyFavorite: null,
        totalCount: 0,
        distinctItemCount: 0,
        days: history.calendarDays(year, month, selectedKey)
      });
    }
  },
  previousMonth() { this.changeMonth(-1); },
  nextMonth() { this.changeMonth(1); },
  changeMonth(offset) {
    const target = new Date(this.data.year, this.data.month + offset, 1);
    this.setData({ year: target.getFullYear(), month: target.getMonth(), selectedKey: "", lastTappedKey: "" });
    this.loadMonth();
  },
  selectDay(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    const daySummaries = history.buildDaySummaries(this.data.groups);
    const hasRecords = Boolean(daySummaries[key]?.count);
    if (this.data.lastTappedKey === key && hasRecords) {
      return wx.navigateTo({ url: `/pages/wear-week/index?date=${encodeURIComponent(key)}` });
    }
    const copy = history.selectedDateCopy(key);
    this.setData({
      selectedKey: key,
      selectedTitle: copy.title,
      selectedSubtitle: copy.subtitle,
      selectedGroups: this.data.groups.filter((group) => group.dateKey === key),
      days: history.calendarDays(this.data.year, this.data.month, key, daySummaries),
      lastTappedKey: key
    });
  },
  openItem(event) {
    const { id, active } = event.currentTarget.dataset;
    if (!active) return wx.showToast({ title: "该衣物已移出衣橱", icon: "none" });
    wx.navigateTo({ url: `/pages/item-detail/index?id=${encodeURIComponent(id)}` });
  },
  openOutfit(event) {
    const recordId = String(event.currentTarget.dataset.recordId || "");
    if (!recordId) return wx.showToast({ title: "单件记录请点击衣物查看", icon: "none" });
    const group = this.data.groups.find((entry) => String(entry.outfitRecordId) === recordId);
    if (group) wx.setStorageSync(WEAR_RECORD_PREVIEW_KEY, {
      id: recordId,
      title: group.title,
      wornAt: group.wornAt,
      scene: group.scene,
      note: group.note,
      items: group.items.map(({ logId, ...item }) => item)
    });
    wx.navigateTo({ url: `/pages/outfit-detail/index?recordId=${encodeURIComponent(recordId)}` });
  },
  openReport() {
    wx.navigateTo({ url: `/pages/wardrobe-report/index?year=${this.data.year}&month=${this.data.month}` });
  },
  openRewards() { wx.navigateTo({ url: "/pages/rewards/index" }); },
  onImageError(event) { this.setData({ [`imageFailures.${event.currentTarget.dataset.id}`]: true }); },
  retry() { this.loadMonth(); }
});

module.exports = { ...history, WEAR_RECORD_PREVIEW_KEY };
