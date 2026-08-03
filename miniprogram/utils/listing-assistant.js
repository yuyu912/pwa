function money(value) {
  if (value === "" || value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1000000 ? number : null;
}

function validateListingForm(form) {
  if (!["sale", "rent"].includes(form.mode)) return "请选择转卖或出租。";
  if (!String(form.condition || "").trim()) return "请填写成色说明。";
  if (!String(form.delivery || "").trim()) return "请填写交付方式。";
  const invalidMoney = (value) => value !== "" && value != null && money(value) === null;
  if (form.mode === "sale" && invalidMoney(form.salePrice)) return "转卖价格应为 0 至 1000000 元，或留空待议。";
  if (form.mode === "rent" && invalidMoney(form.dailyRent)) return "日租金应为 0 至 1000000 元，或留空待议。";
  if (form.mode === "rent" && invalidMoney(form.deposit)) return "押金应为 0 至 1000000 元，或留空待议。";
  const minDays = Number(form.minDays);
  if (form.mode === "rent" && (!Number.isInteger(minDays) || minDays < 1 || minDays > 365)) return "最短租期应为 1 至 365 天的整数。";
  const url = String(form.url || "").trim();
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return "商品链接必须以 http:// 或 https:// 开头。";
  return "";
}

function generateListing(item, form) {
  const mode = form.mode === "rent" ? "rent" : "sale";
  const condition = String(form.condition || "成色请以图片为准").trim();
  const delivery = String(form.delivery || "交付方式可协商").trim();
  const tags = [item.category, item.color, item.material].filter(Boolean).join(" / ");
  const title = mode === "rent"
    ? `出租｜${item.name || item.category || "闲置衣物"}`
    : `闲置转卖｜${item.name || item.category || "衣物"}`;
  const priceLine = mode === "rent"
    ? `日租金：¥${money(form.dailyRent) ?? "待议"}；押金：¥${money(form.deposit) ?? "待议"}；最短租期：${Math.max(1, Number(form.minDays) || 1)} 天`
    : `转卖价格：¥${money(form.salePrice) ?? "待议"}`;
  const lines = [
    title,
    tags ? `衣物信息：${tags}` : "",
    `成色说明：${condition}`,
    priceLine,
    `交付方式：${delivery}`,
    form.note ? `补充说明：${String(form.note).trim()}` : "",
    "图片和描述来自本人衣橱记录，具体情况请在第三方平台沟通确认。"
  ].filter(Boolean);
  return { title: title.slice(0, 60), content: lines.join("\n") };
}

module.exports = { generateListing, validateListingForm };
