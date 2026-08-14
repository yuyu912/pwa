const api = require("../../services/api");
const WEAR_RECORD_PREVIEW_KEY = "wardrobloom_wear_record_preview";

const pad = (value) => String(value).padStart(2, "0");
const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function monthRange(year, month) {
  return {
    start: new Date(year, month, 1).toISOString(),
    end: new Date(year, month + 1, 1).toISOString()
  };
}

function calendarDays(year, month, selectedKey, counts) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday }, (_, index) => ({ key: `blank-${index}`, empty: true }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey(new Date(year, month, day));
    cells.push({ key, day, count: counts[key] || 0, className: key === selectedKey ? "calendar-day selected" : "calendar-day" });
  }
  while (cells.length % 7) cells.push({ key: `blank-end-${cells.length}`, empty: true });
  return cells;
}

function groupWearLogs(logs) {
  const groups = new Map();
  logs.forEach((log) => {
    const key = log.outfitRecordId ? `outfit:${log.outfitRecordId}` : `single:${log.id}`;
    if (!groups.has(key)) groups.set(key, {
      id: key,
      outfitRecordId: log.outfitRecordId || "",
      title: log.outfitTitle || log.item?.name || "单件穿着",
      wornAt: log.wornAt,
      dateKey: log.dateKey,
      timeText: log.timeText,
      scene: log.scene || "",
      note: log.note || "",
      items: []
    });
    if (log.item) groups.get(key).items.push({ ...log.item, logId: log.id });
  });
  return [...groups.values()];
}

Page({
  data: {
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    year: 0,
    month: 0,
    monthText: "",
    days: [],
    groups: [],
    selectedKey: "",
    selectedGroups: [],
    totalCount: 0,
    distinctItemCount: 0,
    loading: true,
    error: "",
    imageFailures: {}
  },
  onLoad() {
    const today = new Date();
    this.setData({ year: today.getFullYear(), month: today.getMonth(), selectedKey: dateKey(today) });
  },
  onShow() {
    if (this.getTabBar()) this.getTabBar().setData({ selected: 2 });
    this.loadMonth();
  },
  async loadMonth() {
    const { year, month, selectedKey } = this.data;
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const range = monthRange(year, month);
      const logs = await api.getMonthlyWearLogs(range.start, range.end);
      const normalized = logs.filter((log) => log.item).map((log) => ({
        ...log,
        dateKey: dateKey(new Date(log.wornAt)),
        timeText: new Date(log.wornAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      }));
      const counts = {};
      const groups = groupWearLogs(normalized);
      groups.forEach((group) => { counts[group.dateKey] = (counts[group.dateKey] || 0) + 1; });
      const firstRecordedDay = groups[0]?.dateKey || "";
      const effectiveSelectedKey = selectedKey.startsWith(`${year}-${pad(month + 1)}-`) ? selectedKey : firstRecordedDay;
      this.setData({
        groups,
        selectedKey: effectiveSelectedKey,
        selectedGroups: groups.filter((group) => group.dateKey === effectiveSelectedKey),
        days: calendarDays(year, month, effectiveSelectedKey, counts),
        monthText: `${year}年${month + 1}月`,
        totalCount: groups.length,
        distinctItemCount: new Set(normalized.map((log) => log.item.id)).size,
        loading: false
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error.message || "穿着记录加载失败，请重试。",
        groups: [],
        selectedGroups: [],
        days: calendarDays(year, month, selectedKey, {})
      });
    }
  },
  previousMonth() { this.changeMonth(-1); },
  nextMonth() { this.changeMonth(1); },
  changeMonth(offset) {
    const target = new Date(this.data.year, this.data.month + offset, 1);
    this.setData({ year: target.getFullYear(), month: target.getMonth(), selectedKey: "" });
    this.loadMonth();
  },
  selectDay(event) {
    const key = event.currentTarget.dataset.key;
    if (!key) return;
    const counts = {};
    this.data.groups.forEach((group) => { counts[group.dateKey] = (counts[group.dateKey] || 0) + 1; });
    this.setData({
      selectedKey: key,
      selectedGroups: this.data.groups.filter((group) => group.dateKey === key),
      days: calendarDays(this.data.year, this.data.month, key, counts)
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

module.exports = { groupWearLogs, WEAR_RECORD_PREVIEW_KEY };
