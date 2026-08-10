import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = String(process.env.WARDROBE_TEST_BASE_URL || "").replace(/\/+$/, "");
const token = String(process.env.WARDROBE_TEST_TOKEN || "");
const manifestPath = path.resolve(process.argv[2] || "test/viapi-diagnostic.manifest.json");
if (!baseUrl || !token) throw new Error("请先在本机设置 WARDROBE_TEST_BASE_URL 与 WARDROBE_TEST_TOKEN；脚本不会保存 Token。");

const request = async (pathname, options = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text.slice(0, 300) }; }
  if (!response.ok) {
    const detail = [
      body.error,
      body.aiTaskStage,
      body.providerCode,
      body.providerStatus ? `HTTP ${body.providerStatus}` : "",
      body.providerRequestId ? `供应商请求号 ${body.providerRequestId}` : "",
      body.providerMessage,
      body.requestId ? `请求号 ${body.requestId}` : ""
    ].filter(Boolean).join(" / ");
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return body;
};

const mimeTypeFor = (filePath) => /\.png$/i.test(filePath) ? "image/png" : "image/jpeg";
const safeName = (value) => String(value).replace(/[^a-z0-9_-]+/gi, "-");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const outputDirectory = path.resolve("tmp", `viapi-cloud-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await fs.mkdir(outputDirectory, { recursive: true });
const runs = [];
const expectedBuildId = "2026-08-07-viapi-rpc-diagnostic-v29";
const health = await request("/api/health");
if (health.buildId !== expectedBuildId
  || health.garmentSegmentationDiagnostic?.transport !== "native_rpc_v2"
  || health.garmentSegmentationDiagnostic?.fileAuthorizationTransport !== "native_rpc_v2"
  || health.garmentSegmentationDiagnostic?.credentialMode !== "dedicated_ram"
  || health.garmentSegmentationDiagnostic?.productionEnabled !== false) {
  throw new Error(`线上版本或隔离开关不正确：${health.buildId || "unknown"}。请先部署完整 v29，不要在 v28/v30 上运行该诊断。`);
}

for (const sample of manifest.samples || []) {
  const sourcePath = path.resolve(sample.localPath);
  const source = await fs.readFile(sourcePath);
  let captureId = "";
  try {
    const upload = await request("/api/outfit-captures/presign", {
      method: "POST",
      body: JSON.stringify({ mimeType: mimeTypeFor(sourcePath), size: source.length })
    });
    captureId = upload.captureId;
    const uploaded = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": mimeTypeFor(sourcePath) }, body: source });
    if (!uploaded.ok) throw new Error(`原图上传失败：HTTP ${uploaded.status}`);
    const diagnostic = await request(`/api/admin/outfit-captures/${encodeURIComponent(captureId)}/segmentation-diagnostic`, { method: "POST", body: "{}" });
    const detections = [];
    for (const [index, detection] of (diagnostic.detections || []).entries()) {
      let localCutout = "";
      if (detection.cutoutUrl) {
        const cutout = await fetch(detection.cutoutUrl);
        if (!cutout.ok) throw new Error(`抠图下载失败：HTTP ${cutout.status}`);
        localCutout = path.join(outputDirectory, `${safeName(sample.id)}-${index + 1}.png`);
        await fs.writeFile(localCutout, Buffer.from(await cutout.arrayBuffer()));
      }
      detections.push({ ...detection, localCutout });
    }
    const categories = detections.map((item) => item.category);
    const missing = (sample.expectedCategories || []).filter((category) => !categories.includes(category));
    const failed = detections.filter((item) => item.segmentationStatus === "failed" || !item.cutoutUrl);
    runs.push({ sampleId: sample.id, transport: diagnostic.transport, originalDeleted: diagnostic.originalDeleted, categories, missing, failed: failed.map((item) => item.processingError), detections });
  } catch (error) {
    runs.push({ sampleId: sample.id, error: error.message });
  } finally {
    if (captureId) await request(`/api/outfit-captures/${encodeURIComponent(captureId)}`, { method: "DELETE" }).catch(() => {});
  }
}

const passed = runs.every((run) => !run.error && run.transport === "native_rpc_v2" && run.originalDeleted === true && run.missing.length === 0 && run.failed.length === 0);
const report = { generatedAt: new Date().toISOString(), buildExpected: expectedBuildId, buildActual: health.buildId, passed, runs };
await fs.writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
const rows = runs.map((run) => `<section><h2>${escapeHtml(run.sampleId)}</h2><p>${escapeHtml(run.error || (run.missing?.length || run.failed?.length ? "未通过" : "通过"))}</p>${(run.detections || []).map((item) => `<article><h3>${escapeHtml(item.category)} · ${escapeHtml(item.segmentationStatus)}</h3>${item.localCutout ? `<img src="${escapeHtml(path.basename(item.localCutout))}">` : ""}<p>${escapeHtml(item.processingError)}</p></article>`).join("")}</section>`).join("");
await fs.writeFile(path.join(outputDirectory, "report.html"), `<!doctype html><meta charset="utf-8"><title>VIAPI 云端隔离诊断</title><style>body{font-family:sans-serif;max-width:1000px;margin:auto;padding:24px}section{border-top:1px solid #ddd}article{padding:12px;background:#f7f7f7;margin:8px 0}img{max-width:360px;max-height:520px;background:#ddd}</style><h1>VIAPI 云端隔离诊断：${passed ? "通过" : "未通过"}</h1><p>所有任务均已取消，未确认入衣橱。</p>${rows}`);
console.log(JSON.stringify({ outputDirectory, passed, samples: runs.length }, null, 2));
if (!passed) process.exitCode = 1;
