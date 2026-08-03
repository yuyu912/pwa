const api = require("../../services/api");

const categories = ["功能问题", "隐私与数据", "不当内容", "其他"];

Page({
  data: { categories, categoryIndex: 0, detail: "", contact: "", submitting: false, message: "", error: "" },
  onCategoryChange(event) { this.setData({ categoryIndex: Number(event.detail.value) }); },
  onDetail(event) { this.setData({ detail: event.detail.value }); },
  onContact(event) { this.setData({ contact: event.detail.value }); },
  async submit() {
    const detail = String(this.data.detail || "").trim();
    if (detail.length < 5) return this.setData({ error: "请填写至少 5 个字的问题说明。", message: "" });
    this.setData({ submitting: true, error: "", message: "" });
    try {
      await api.submitComplaint({ category: categories[this.data.categoryIndex], detail, contact: this.data.contact });
      this.setData({ detail: "", contact: "", message: "已提交，我们会根据内容进行核验处理。" });
    } catch (error) {
      this.setData({ error: error.message || "提交失败，请稍后重试。" });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
