const input = document.querySelector("#image-input");
const button = document.querySelector("#run-button");
const preview = document.querySelector("#preview");
const message = document.querySelector("#message");
const result = document.querySelector("#result");
let selectedFile;
let previewUrl;

const setStatus = (id, text) => { document.querySelector(id).textContent = text; };
const setMessage = (text, isError = false) => {
  message.textContent = text;
  message.classList.toggle("error", isError);
};

setStatus("#webgpu-status", navigator.gpu ? "可用，后续优先尝试" : "未检测到，后续将测试 WASM 回退");
setStatus("#crypto-status", globalThis.crypto?.subtle ? "可用" : "不可用");
setStatus("#canvas-status", document.createElement("canvas").getContext("2d") ? "可用" : "不可用");

const toHex = (value) => value.toString(16).padStart(2, "0");

const estimateColor = async (file) => {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, 160 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0; let green = 0; let blue = 0; let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const [r, g, b, alpha] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    if (alpha < 220 || (max > 238 && min > 238) || max - min < 14) continue;
    red += r; green += g; blue += b; count += 1;
  }
  if (!count) return "未能从图片中提取明显颜色";
  const rgb = [red / count, green / count, blue / count].map(Math.round);
  const [r, g, b] = rgb;
  const name = r > g * 1.25 && r > b * 1.25 ? "红色系" : b > r * 1.2 && b > g * 1.08 ? "蓝色系" : g > r * 1.15 && g > b * 1.05 ? "绿色系" : r > 165 && g > 135 && b < 120 ? "黄色/棕色系" : "中性色";
  return `${name}（#${toHex(r)}${toHex(g)}${toHex(b)}，整图估算）`;
};

input.addEventListener("change", () => {
  selectedFile = input.files?.[0];
  button.disabled = !selectedFile;
  result.hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (!selectedFile) return;
  previewUrl = URL.createObjectURL(selectedFile);
  preview.src = previewUrl;
  preview.hidden = false;
  setMessage(`已选择“${selectedFile.name}”。点击开始后只会在本机计算。`);
});

button.addEventListener("click", async () => {
  if (!selectedFile || !globalThis.crypto?.subtle) return setMessage("当前浏览器不支持本地哈希，无法继续此验证。", true);
  button.disabled = true;
  const startedAt = performance.now();
  setMessage("正在浏览器本地读取图片与计算哈希…");
  try {
    const [digest, color] = await Promise.all([
      crypto.subtle.digest("SHA-256", await selectedFile.arrayBuffer()),
      estimateColor(selectedFile)
    ]);
    const hash = Array.from(new Uint8Array(digest), toHex).join("");
    document.querySelector("#hash-result").textContent = hash;
    document.querySelector("#color-result").textContent = color;
    document.querySelector("#time-result").textContent = `${Math.round(performance.now() - startedAt)} ms`;
    result.hidden = false;
    setMessage("本地基础验证完成：没有上传或保存图片。");
  } catch (error) {
    setMessage(`本地处理失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("beforeunload", () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
