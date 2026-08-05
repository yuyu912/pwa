const api = require("../../services/api");
Page({ data: { profile: null, error: "" }, async onShow() { try { this.setData({ profile: await api.getStyleProfile(), error: "" }); } catch (error) { this.setData({ error: error.message || "暂时无法生成画像" }); } } });
