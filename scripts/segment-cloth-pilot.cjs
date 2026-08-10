"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const sdkRoot = path.join(__dirname, "..", "uniCloud-aliyun", "cloudfunctions", "wardrobe-api", "node_modules", "@alicloud", "imageseg20191230");
const ImagesegClient = require(sdkRoot);
const { PNG } = require(path.join(__dirname, "..", "uniCloud-aliyun", "cloudfunctions", "wardrobe-api", "node_modules", "pngjs"));
const clothClasses = ["tops", "coat", "pants", "skirt", "shoes"];

const normalizeClassUrls = (classUrl) => {
  if (!classUrl || typeof classUrl !== "object") return {};
  const result = {};
  for (const clothClass of clothClasses) {
    if (typeof classUrl[clothClass] === "string" && /^https?:\/\//i.test(classUrl[clothClass])) result[clothClass] = classUrl[clothClass];
  }
  if (Object.keys(result).length || typeof classUrl.key !== "string") return result;
  for (const clothClass of clothClasses) {
    const alternatives = clothClasses.filter((value) => value !== clothClass).join("|");
    const match = classUrl.key.match(new RegExp(`["']?${clothClass}["']?\\s*:\\s*(https?:\\/\\/.+?)(?=\\s*,\\s*["']?(?:${alternatives})["']?\\s*:|\\s*}$)`, "i"));
    if (match) result[clothClass] = match[1].trim().replace(/["']$/, "");
  }
  return result;
};

const maskStats = (buffer) => {
  const png = PNG.sync.read(buffer);
  let dark = 0;
  let light = 0;
  let middle = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const value = Math.round((png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3);
    if (value <= 8) dark += 1;
    else if (value >= 247) light += 1;
    else middle += 1;
  }
  return { width: png.width, height: png.height, darkPixels: dark, lightPixels: light, edgePixels: middle };
};

const requiredEnvironment = ["ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"];
const localEnvironmentFiles = [".env.local", ".env"].map((filename) => path.join(__dirname, "..", "uniCloud-aliyun", "cloudfunctions", "wardrobe-api", filename));
for (const localEnvironmentFile of localEnvironmentFiles) {
  if (!fs.existsSync(localEnvironmentFile)) continue;
  const lines = fs.readFileSync(localEnvironmentFile, "utf8").split(/\r?\n/);
  for (const name of requiredEnvironment) {
    if (process.env[name]) continue;
    const line = lines.find((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry));
    if (!line) continue;
    let value = line.slice(line.indexOf("=") + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) process.env[name] = value;
  }
}
const missing = requiredEnvironment.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join("、")}。请只在本机环境中设置，不要写入脚本。`);
  process.exit(2);
}

const classArgument = process.argv.slice(2).find((value) => value.startsWith("--classes="));
const combinedRequest = process.argv.includes("--combined");
const rpcV2 = process.argv.includes("--rpc-v2");
const selectedClasses = classArgument
  ? classArgument.slice("--classes=".length).split(",").map((value) => value.trim()).filter((value) => clothClasses.includes(value))
  : [];
const inputPaths = process.argv.slice(2).filter((value) => !value.startsWith("--classes=") && value !== "--combined" && value !== "--rpc-v2").map((value) => path.resolve(value));
if (inputPaths.length < 1 || inputPaths.length > 2) {
  console.error("用法：node scripts/segment-cloth-pilot.cjs <单张原图>，或同时传入两张原图");
  process.exit(2);
}
for (const inputPath of inputPaths) {
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    console.error(`找不到测试图片：${inputPath}`);
    process.exit(2);
  }
  if (fs.statSync(inputPath).size > 3 * 1024 * 1024) {
    console.error(`测试图片超过 SegmentCloth 的 3MB 限制：${path.basename(inputPath)}`);
    process.exit(2);
  }
}

const download = (url, redirects = 0) => new Promise((resolve, reject) => {
  if (redirects > 3) return reject(new Error("分割结果下载重定向过多。"));
  const client = new URL(url).protocol === "http:" ? http : https;
  const request = client.get(url, { timeout: 30000 }, (response) => {
    if ([301, 302, 303, 307, 308].includes(Number(response.statusCode)) && response.headers.location) {
      response.resume();
      download(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      return;
    }
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
      response.resume();
      reject(new Error(`分割结果下载失败（HTTP ${response.statusCode || 0}）。`));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) request.destroy(new Error("分割结果超过30MB安全限制。"));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
  });
  request.on("timeout", () => request.destroy(new Error("分割结果下载超时。")));
  request.on("error", reject);
});

const client = rpcV2
  ? require(path.join(__dirname, "..", "uniCloud-aliyun", "cloudfunctions", "wardrobe-api", "lib", "cloud-services.js"))._test.getGarmentSegmentationDiagnosticClient()
  : new ImagesegClient.default({
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    endpoint: "imageseg.cn-shanghai.aliyuncs.com",
    regionId: "cn-shanghai",
    connectTimeout: 10000,
    readTimeout: 30000
  });

const outputDirectory = path.join(__dirname, "..", "tmp", `segment-cloth-pilot-${Date.now()}`);
fs.mkdirSync(outputDirectory, { recursive: true });

const run = async () => {
  const report = [];
  for (let index = 0; index < inputPaths.length; index += 1) {
    const inputPath = inputPaths[index];
    const prefix = `sample-${index + 1}`;
    const requestedClasses = selectedClasses.length ? selectedClasses : inputPaths.length === 1
      ? ["tops", "coat", "pants"]
      : index === 0 ? ["tops", "pants"] : ["tops", "coat", "pants"];
    const classFiles = {};
    const classStats = {};
    const requestIds = {};
    if (combinedRequest) {
      const request = new ImagesegClient.SegmentClothAdvanceRequest({
        imageURLObject: fs.createReadStream(inputPath),
        outMode: 0,
        clothClass: requestedClasses,
        returnForm: "mask"
      });
      const response = await client.segmentClothAdvance(request, { connectTimeout: 10000, readTimeout: 30000, autoretry: false });
      const element = response?.body?.data?.elements?.[0];
      const urls = normalizeClassUrls(element?.classUrl);
      for (const clothClass of requestedClasses) {
        if (!urls[clothClass]) continue;
        const filename = `${prefix}-${clothClass}-mask.png`;
        const maskBuffer = await download(urls[clothClass]);
        fs.writeFileSync(path.join(outputDirectory, filename), maskBuffer);
        classFiles[clothClass] = filename;
        classStats[clothClass] = maskStats(maskBuffer);
        requestIds[clothClass] = response?.body?.requestId || "";
      }
      report.push({ sample: index + 1, sourceFile: path.basename(inputPath), requestIds, classFiles, classStats, combinedRequest: true });
      continue;
    }
    for (const clothClass of requestedClasses) {
      const request = new ImagesegClient.SegmentClothAdvanceRequest({
        imageURLObject: fs.createReadStream(inputPath),
        outMode: 1,
        clothClass: [clothClass],
        returnForm: "mask"
      });
      const response = await client.segmentClothAdvance(request, { connectTimeout: 10000, readTimeout: 30000, autoretry: false });
      const element = response?.body?.data?.elements?.[0];
      const url = normalizeClassUrls(element?.classUrl)[clothClass] || element?.imageURL;
      if (!url) throw new Error(`第${index + 1}张图片没有返回 ${clothClass} 蒙版。`);
      const filename = `${prefix}-${clothClass}-mask.png`;
      const maskBuffer = await download(url);
      fs.writeFileSync(path.join(outputDirectory, filename), maskBuffer);
      classFiles[clothClass] = filename;
      classStats[clothClass] = maskStats(maskBuffer);
      requestIds[clothClass] = response?.body?.requestId || "";
    }
    report.push({
      sample: index + 1,
      sourceFile: path.basename(inputPath),
      requestIds,
      classFiles,
      classStats
    });
  }
  const reportPath = path.join(outputDirectory, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({ createdAt: new Date().toISOString(), service: "SegmentCloth", transport: rpcV2 ? "native_rpc_v2" : "sdk_default", report }, null, 2)}\n`);
  console.log(`验证输出：${outputDirectory}`);
  console.log(`报告文件：${reportPath}`);
};

run().catch((error) => {
  console.error(`SegmentCloth 验证失败：${error.code || error.message || "未知错误"}`);
  process.exitCode = 1;
});
