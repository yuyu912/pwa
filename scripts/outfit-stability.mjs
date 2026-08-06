import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = String(process.env.WARDROBE_TEST_BASE_URL || "").replace(/\/+$/, "");
const token = String(process.env.WARDROBE_TEST_TOKEN || "");
const manifestPath = path.resolve(process.argv[2] || "test/outfit-stability.manifest.json");
if (!baseUrl || !token) throw new Error("请先设置 WARDROBE_TEST_BASE_URL 与 WARDROBE_TEST_TOKEN。脚本不会读取或保存账号密码。");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(1000, Number(milliseconds) || 1000)));
const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error || body?.providerMessage || `HTTP ${response.status}`);
  return body;
};
const mimeTypeFor = (filePath) => /\.png$/i.test(filePath) ? "image/png" : "image/jpeg";
const safeName = (value) => String(value).replace(/[^a-z0-9_-]+/gi, "-");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const repeatCount = Math.max(1, Number(manifest.repeatCount || 3));
const maxEstimatedYuan = Math.max(0.5, Number(manifest.maxEstimatedYuan || 60));
const outputDirectory = path.resolve("tmp", `outfit-stability-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(outputDirectory, { recursive: true });

let estimatedOutputs = 0;
const runs = [];
const reserveCost = (count) => {
  if ((estimatedOutputs + count) * 0.5 > maxEstimatedYuan) throw new Error(`预计图像编辑费用将超过 ${maxEstimatedYuan} 元，已停止后续调用。`);
  estimatedOutputs += count;
};

const prepareDetection = async (captureId, detection, runDirectory) => {
  let response;
  let queueCount = 0;
  let stage = "initial";
  while (true) {
    // 保真路径不只由 isComposite 触发；按第一轮最多 3 张预留，避免复杂单层衣物低估费用。
    const reservedOutputs = stage === "correction" ? 2 : 3;
    reserveCost(reservedOutputs);
    response = await request(`/api/outfit-captures/${encodeURIComponent(captureId)}/detections/${encodeURIComponent(detection.detectionId)}/prepare`, { method: "POST", body: "{}" });
    if (response.processingStatus === "queued") {
      estimatedOutputs -= reservedOutputs;
      queueCount += 1;
      if (queueCount > 20) throw new Error("排队超过20次，停止该检测项。 ");
      await sleep(Math.min(90000, response.retryAfterMs || 31000));
      continue;
    }
    if (response.retryable) {
      await sleep(Math.min(90000, response.retryAfterMs || 65000));
      continue;
    }
    if (response.correctionAvailable) {
      stage = "correction";
      continue;
    }
    break;
  }
  let localImage = "";
  if (response.imageUrl) {
    const imageResponse = await fetch(response.imageUrl);
    if (!imageResponse.ok) throw new Error(`结果图下载失败：HTTP ${imageResponse.status}`);
    localImage = path.join(runDirectory, `${safeName(detection.detectionId)}.png`);
    await fs.writeFile(localImage, Buffer.from(await imageResponse.arrayBuffer()));
  }
  return { ...response, localImage };
};

for (const sample of manifest.samples || []) {
  const sourcePath = path.resolve(sample.localPath);
  const source = await fs.readFile(sourcePath);
  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    const runDirectory = path.join(outputDirectory, `${safeName(sample.id)}-${repeat}`);
    await fs.mkdir(runDirectory, { recursive: true });
    let captureId = "";
    const startedAt = new Date().toISOString();
    try {
      const upload = await request("/api/outfit-captures/presign", {
        method: "POST",
        body: JSON.stringify({ mimeType: mimeTypeFor(sourcePath), size: source.length })
      });
      captureId = upload.captureId;
      const uploaded = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": mimeTypeFor(sourcePath) }, body: source });
      if (!uploaded.ok) throw new Error(`原图上传失败：HTTP ${uploaded.status}`);
      const analyzed = await request(`/api/outfit-captures/${encodeURIComponent(captureId)}/analyze`, { method: "POST", body: "{}" });
      const detections = [];
      for (const detection of analyzed.detections || []) detections.push(await prepareDetection(captureId, detection, runDirectory));
      runs.push({ sampleId: sample.id, sourcePage: sample.sourcePage, repeat, startedAt, detections });
    } catch (error) {
      runs.push({ sampleId: sample.id, sourcePage: sample.sourcePage, repeat, startedAt, error: error.message });
    } finally {
      if (captureId) await request(`/api/outfit-captures/${encodeURIComponent(captureId)}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

const report = { generatedAt: new Date().toISOString(), baseUrl, repeatCount, estimatedOutputs, estimatedYuan: estimatedOutputs * 0.5, runs };
await fs.writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
const rows = runs.map((run) => `<section><h2>${escapeHtml(run.sampleId)} · 第 ${run.repeat} 次</h2><p>${escapeHtml(run.error || "完成")}</p>${(run.detections || []).map((item) => `<article><h3>${escapeHtml(item.category)} · ${escapeHtml(item.processingStatus)} · ${escapeHtml(item.fidelityScore)}</h3><p>${escapeHtml(item.structure)}</p><pre>${escapeHtml(JSON.stringify(item.structureFacts || {}, null, 2))}</pre>${item.localImage ? `<img src="${escapeHtml(path.relative(outputDirectory, item.localImage).replaceAll("\\", "/"))}">` : ""}<p>${escapeHtml(item.processingError)}</p></article>`).join("")}</section>`).join("");
await fs.writeFile(path.join(outputDirectory, "report.html"), `<!doctype html><meta charset="utf-8"><title>复杂穿搭稳定性报告</title><style>body{font-family:sans-serif;max-width:1100px;margin:auto;padding:24px}section{border-top:1px solid #ddd}article{padding:12px;background:#f7f7f7;margin:8px 0}img{max-width:360px;max-height:520px;background:#ddd}pre{white-space:pre-wrap}</style><h1>复杂穿搭稳定性报告</h1><p>估算输出 ${estimatedOutputs} 张，约 ${estimatedOutputs * 0.5} 元。任务均已取消，未确认入衣橱。</p>${rows}`);
console.log(JSON.stringify({ outputDirectory, estimatedOutputs, estimatedYuan: estimatedOutputs * 0.5 }, null, 2));
