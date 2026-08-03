const api = require("../../services/api");
const session = require("../../services/session");
const { filterWardrobe } = require("../../utils/wardrobe-filter");

function normalizeItem(item) {
  // 云端沿用数据库字段 wear_count，模拟数据使用 wearCount；页面统一后不再出现“已穿 次”。
  return { ...item, wearCount: Number(item.wearCount ?? item.wear_count ?? 0), imageLoadFailed: false };
}

function currentMonthRange() {
  const today = new Date();
  return {
    start: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
    end: new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString()
  };
}

Page({
  data: {
    user: {},
    items: [],
    filteredItems: [],
    keyword: "",
    activeCategory: "全部",
    activeSeason: "全部",
    activeThickness: "全部",
    activeWearStatus: "全部",
    categories: ["全部", "上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"],
    seasons: ["全部", "春夏", "春秋", "秋冬", "多季"],
    thicknesses: ["全部", "薄", "适中", "厚"],
    wearStatuses: ["全部", "本月穿过", "本月未穿"],
    matchedCount: 0,
    monthlyWearTotal: 0,
    loading: true,
    error: ""
  },
  onShow() { this.loadItems(); },
  async loadItems() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ user, loading: true, error: "" });
    try {
      // imageLoadFailed 只属于当前页面状态，不写回云端，也不会影响衣物正式数据。
      const range = currentMonthRange();
      const [rawItems, monthlyLogs] = await Promise.all([api.listItems(), api.getMonthlyWearLogs(range.start, range.end)]);
      const countsByItem = {};
      monthlyLogs.forEach((log) => {
        if (log.item?.id) countsByItem[String(log.item.id)] = (countsByItem[String(log.item.id)] || 0) + 1;
      });
      const items = rawItems.map((item) => ({ ...normalizeItem(item), monthlyWearCount: countsByItem[String(item.id)] || 0 }));
      this.setData({ items });
      this.applyFilter();
    } catch (error) {
      this.setData({ error: error.message || "衣橱读取失败。" });
    } finally { this.setData({ loading: false }); }
  },
  applyFilter() {
    this.setData(filterWardrobe(this.data.items, {
      keyword: this.data.keyword,
      category: this.data.activeCategory,
      season: this.data.activeSeason,
      thickness: this.data.activeThickness,
      wearStatus: this.data.activeWearStatus
    }));
  },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); this.applyFilter(); },
  selectCategory(event) { this.setData({ activeCategory: event.currentTarget.dataset.category }); this.applyFilter(); },
  selectSeason(event) { this.setData({ activeSeason: event.currentTarget.dataset.value }); this.applyFilter(); },
  selectThickness(event) { this.setData({ activeThickness: event.currentTarget.dataset.value }); this.applyFilter(); },
  selectWearStatus(event) { this.setData({ activeWearStatus: event.currentTarget.dataset.value }); this.applyFilter(); },
  onImageError(event) {
    const id = String(event.currentTarget.dataset.id);
    // 签名地址过期或网络失败时仅回退为颜色块，卡片和其他属性仍然可以正常使用。
    const items = this.data.items.map((item) => String(item.id) === id ? { ...item, imageLoadFailed: true } : item);
    this.setData({ items });
    this.applyFilter();
  },
  openItem(event) { wx.navigateTo({ url: `/pages/item-detail/index?id=${event.currentTarget.dataset.id}` }); },
  openCandidate() { wx.navigateTo({ url: "/pages/add-item/index?mode=candidate" }); }
});
