const api = require("../../services/api");
const session = require("../../services/session");

function normalizeItem(item) {
  // 云端沿用数据库字段 wear_count，模拟数据使用 wearCount；页面统一后不再出现“已穿 次”。
  return { ...item, wearCount: Number(item.wearCount ?? item.wear_count ?? 0), imageLoadFailed: false };
}

function filterItems(items, keyword, category) {
  const term = keyword.trim().toLowerCase();
  return items.filter((item) => {
    // 搜索文本覆盖用户确认后的完整衣物属性，避免已经保存的材质等字段无法被检索。
    const text = [
      item.name,
      item.category,
      item.color,
      item.season,
      item.thickness,
      item.pattern,
      item.material,
      ...(item.styles || []),
      ...(item.scenes || [])
    ].filter(Boolean).join(" ").toLowerCase();
    return (!term || text.includes(term)) && (category === "全部" || item.category === category);
  });
}

Page({
  data: { user: {}, items: [], filteredItems: [], keyword: "", activeCategory: "全部", categories: ["全部", "上衣", "裤子", "半身裙", "外套", "连衣裙", "鞋子"], loading: true, error: "" },
  onShow() { this.loadItems(); },
  async loadItems() {
    const { user, token } = session.restore();
    if (!user || !token) return wx.redirectTo({ url: "/pages/login/index" });
    this.setData({ user, loading: true, error: "" });
    try {
      // imageLoadFailed 只属于当前页面状态，不写回云端，也不会影响衣物正式数据。
      const items = (await api.listItems()).map(normalizeItem);
      this.setData({ items, filteredItems: filterItems(items, this.data.keyword, this.data.activeCategory) });
    } catch (error) {
      this.setData({ error: error.message || "衣橱读取失败。" });
    } finally { this.setData({ loading: false }); }
  },
  applyFilter() { this.setData({ filteredItems: filterItems(this.data.items, this.data.keyword, this.data.activeCategory) }); },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); this.applyFilter(); },
  selectCategory(event) { this.setData({ activeCategory: event.currentTarget.dataset.category }); this.applyFilter(); },
  onImageError(event) {
    const id = String(event.currentTarget.dataset.id);
    // 签名地址过期或网络失败时仅回退为颜色块，卡片和其他属性仍然可以正常使用。
    const items = this.data.items.map((item) => String(item.id) === id ? { ...item, imageLoadFailed: true } : item);
    this.setData({ items, filteredItems: filterItems(items, this.data.keyword, this.data.activeCategory) });
  },
  openItem(event) { wx.navigateTo({ url: `/pages/item-detail/index?id=${event.currentTarget.dataset.id}` }); },
  openCandidate() { wx.navigateTo({ url: "/pages/add-item/index?mode=candidate" }); }
});
