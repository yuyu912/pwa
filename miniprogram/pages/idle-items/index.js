const api = require("../../services/api");

function dateText(value, emptyText) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : emptyText;
}

Page({
  data: { items: [], loading: true, error: "", imageFailures: {}, restoringId: "" },
  onShow() { this.loadItems(); },
  async loadItems() {
    this.setData({ loading: true, error: "", imageFailures: {} });
    try {
      const items = (await api.listIdleItems()).map((item) => ({
        ...item,
        wearCount: Number(item.wearCount ?? item.wear_count ?? 0),
        idleReason: item.idleReason || item.idle_reason || "",
        idleNote: item.idleNote || item.idle_note || "",
        markedText: dateText(item.idleMarkedAt || item.idle_marked_at, "标记日期未知"),
        lastWornText: dateText(item.lastWornAt, "还没有穿着记录")
      }));
      this.setData({ items, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: error.message || "私人闲置清单加载失败。" });
    }
  },
  openItem(event) { wx.navigateTo({ url: `/pages/item-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async restoreItem(event) {
    const id = String(event.currentTarget.dataset.id);
    if (this.data.restoringId) return;
    this.setData({ restoringId: id, error: "" });
    try {
      await api.restoreIdleItem(id);
      this.setData({ items: this.data.items.filter((item) => String(item.id) !== id) });
      wx.showToast({ title: "已恢复", icon: "success" });
    } catch (error) { this.setData({ error: error.message || "恢复失败，请重试。" }); }
    finally { this.setData({ restoringId: "" }); }
  },
  onImageError(event) { this.setData({ [`imageFailures.${event.currentTarget.dataset.id}`]: true }); }
});
