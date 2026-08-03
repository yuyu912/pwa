function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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

module.exports = { generateListing };
