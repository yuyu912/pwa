const api = require("../../services/api");

const statusText = {
  resolving: "正在读取", screenshot_required: "待补截图", ready_to_analyze: "待识别",
  analyzing: "识别中", awaiting_confirmation: "待确认", ready: "已完成", failed: "未完成"
};

Page({
  data: { history: [], record: null, loading: true, error: "", statusText },
  onLoad() { this.loadHistory(); },
  async loadHistory() {
    this.setData({ loading: true, error: "" });
    try { const result = await api.listInspirations(); this.setData({ history: result.records || [] }); }
    catch (error) { this.setData({ error: error.message || "历史记录读取失败。" }); }
    finally { this.setData({ loading: false }); }
  },
  async openRecord(event) {
    this.setData({ loading: true, error: "" });
    try {
      const record = await api.getInspiration(event.currentTarget.dataset.id);
      const matches = (record.matches || []).map((group) => ({ ...group, candidates: (group.candidates || []).map((candidate) => ({ ...candidate, key: candidate.item.id, reasonsText: (candidate.reasons || []).join(" · ") })) }));
      this.setData({ record: { ...record, matches } });
    } catch (error) { this.setData({ error: error.message || "记录读取失败。" }); }
    finally { this.setData({ loading: false }); }
  },
  closeRecord() { this.setData({ record: null }); },
  deleteRecord(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({ title: "删除这条私密灵感？", content: "记录和你上传的私密截图将一并删除，无法恢复。", confirmColor: "#a65e58",
      success: async ({ confirm }) => {
        if (!confirm) return;
        try { await api.deleteInspiration(id); if (this.data.record?.id === id) this.setData({ record: null }); await this.loadHistory(); }
        catch (error) { wx.showToast({ title: error.message || "删除失败", icon: "none" }); }
      }
    });
  },
  goBack() { wx.navigateBack(); }
});
