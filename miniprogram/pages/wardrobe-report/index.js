const api = require("../../services/api");
const { buildWardrobeReport } = require("../../utils/wardrobe-report");

function monthRange(year, month) {
  return {
    start: new Date(year, month, 1).toISOString(),
    end: new Date(year, month + 1, 1).toISOString()
  };
}

Page({
  data: {
    year: 0,
    month: 0,
    monthText: "",
    report: null,
    loading: true,
    error: "",
    imageFailures: {}
  },
  onLoad(options) {
    const today = new Date();
    const year = Number(options.year);
    const month = Number(options.month);
    this.setData({
      year: Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : today.getFullYear(),
      month: Number.isInteger(month) && month >= 0 && month <= 11 ? month : today.getMonth()
    });
    this.loadReport();
  },
  async loadReport() {
    const { year, month } = this.data;
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const range = monthRange(year, month);
      const [items, logs] = await Promise.all([api.listItems(), api.getMonthlyWearLogs(range.start, range.end)]);
      this.setData({
        monthText: `${year}年${month + 1}月`,
        report: buildWardrobeReport(items, logs),
        loading: false
      });
    } catch (error) {
      this.setData({ loading: false, report: null, error: error.message || "衣橱报表加载失败，请重试。" });
    }
  },
  openItem(event) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },
  onImageError(event) { this.setData({ [`imageFailures.${event.currentTarget.dataset.id}`]: true }); },
  retry() { this.loadReport(); }
});
