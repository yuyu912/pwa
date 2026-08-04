const api = require("../../services/api");
const formatTime = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "待确认";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

Page({
  data: { loading: true, error: "", entitlement: null, plans: [], purchaseEnabled: false },
  onLoad() { this.load(); },
  async load() {
    this.setData({ loading: true, error: "" });
    try {
      const [entitlement, catalog] = await Promise.all([api.getEntitlement(), api.getPlans()]);
      this.setData({ entitlement: { ...entitlement, trialEndsText: formatTime(entitlement.trialEndsAt) }, plans: catalog.plans || [], purchaseEnabled: catalog.purchaseEnabled === true });
    } catch (error) {
      this.setData({ error: error.message || "套餐信息暂时无法读取。" });
    } finally {
      this.setData({ loading: false });
    }
  },
  goBack() { wx.navigateBack(); }
});
