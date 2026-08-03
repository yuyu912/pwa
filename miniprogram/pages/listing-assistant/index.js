const api = require("../../services/api");
const { generateListing, validateListingForm } = require("../../utils/listing-assistant");

const MODES = [{ value: "sale", label: "转卖" }, { value: "rent", label: "出租" }];
const STATUSES = [{ value: "draft", label: "准备中" }, { value: "listed", label: "已上架" }, { value: "delisted", label: "已下架" }, { value: "completed", label: "已成交" }];

function formFromItem(item) {
  return {
    mode: item.listing_mode || "sale", condition: item.listing_condition || "", salePrice: item.listing_sale_price ?? "",
    dailyRent: item.listing_daily_rent ?? "", deposit: item.listing_deposit ?? "", minDays: item.listing_min_days || 1,
    delivery: item.listing_delivery || "", note: item.listing_note || "", platform: item.listing_platform || "闲鱼",
    url: item.listing_url || "", status: item.listing_status || "draft"
  };
}

Page({
  data: { item: null, form: {}, modes: MODES, statuses: STATUSES, modeIndex: 0, statusIndex: 0, generated: null, loading: true, saving: false, message: "", error: "" },
  async onLoad(options) {
    try {
      const item = await api.getItem(options.id);
      if (!item || (item.idle_status || item.idleStatus || "active") !== "considering") throw new Error("请先把衣物加入私人闲置清单。");
      const form = formFromItem(item);
      this.setData({ item, form, modeIndex: Math.max(0, MODES.findIndex((entry) => entry.value === form.mode)), statusIndex: Math.max(0, STATUSES.findIndex((entry) => entry.value === form.status)), generated: generateListing(item, form), loading: false });
    } catch (error) { this.setData({ loading: false, error: error.message || "发布助手加载失败。" }); }
  },
  onInput(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value, error: "", message: "" }); },
  onMode(event) { const modeIndex = Number(event.detail.value); this.setData({ modeIndex, "form.mode": MODES[modeIndex].value }); },
  onStatus(event) { const statusIndex = Number(event.detail.value); this.setData({ statusIndex, "form.status": STATUSES[statusIndex].value }); },
  generate() {
    const error = validateListingForm(this.data.form);
    if (error) return this.setData({ error, message: "" });
    this.setData({ generated: generateListing(this.data.item, this.data.form), error: "", message: "文案已更新。" });
  },
  copyText() {
    const error = validateListingForm(this.data.form);
    if (error) return this.setData({ error, message: "" });
    const generated = generateListing(this.data.item, this.data.form);
    this.setData({ generated, error: "" });
    wx.setClipboardData({
      data: `${generated.title}\n\n${generated.content}`,
      success: () => this.setData({ message: "发布文案已复制，请到第三方平台粘贴。" }),
      fail: () => this.setData({ error: "复制失败，请长按文案手动复制。", message: "" })
    });
  },
  previewImage() {
    if (!this.data.item?.imageUrl) return this.setData({ error: "当前衣物图片暂时无法读取。", message: "" });
    wx.previewImage({ current: this.data.item.imageUrl, urls: [this.data.item.imageUrl], fail: () => this.setData({ error: "图片预览失败，请稍后重试。" }) });
  },
  async save() {
    if (this.data.saving) return;
    const validationError = validateListingForm(this.data.form);
    if (validationError) return this.setData({ error: validationError, message: "" });
    this.setData({ saving: true, error: "", message: "" });
    try {
      const item = await api.saveItemListing(this.data.item.id, this.data.form);
      const form = formFromItem(item);
      this.setData({ item, form, generated: generateListing(item, form), message: "发布记录已保存。" });
    } catch (error) { this.setData({ error: error.message || "保存失败，请重试。" }); }
    finally { this.setData({ saving: false }); }
  }
});
