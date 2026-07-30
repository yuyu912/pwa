const api = require("../../services/api");
const session = require("../../services/session");

function filterItems(items, keyword, category) {
  const term = keyword.trim().toLowerCase();
  return items.filter((item) => {
    const text = [item.name, item.category, item.color, ...(item.styles || []), ...(item.scenes || [])].join(" ").toLowerCase();
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
      const items = await api.listItems();
      this.setData({ items, filteredItems: filterItems(items, this.data.keyword, this.data.activeCategory) });
    } catch (error) {
      this.setData({ error: error.message || "衣橱读取失败。" });
    } finally { this.setData({ loading: false }); }
  },
  applyFilter() { this.setData({ filteredItems: filterItems(this.data.items, this.data.keyword, this.data.activeCategory) }); },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); this.applyFilter(); },
  selectCategory(event) { this.setData({ activeCategory: event.currentTarget.dataset.category }); this.applyFilter(); },
  openItem(event) { wx.navigateTo({ url: `/pages/item-detail/index?id=${event.currentTarget.dataset.id}` }); },
  openCandidate() { wx.navigateTo({ url: "/pages/candidate/index" }); }
});
