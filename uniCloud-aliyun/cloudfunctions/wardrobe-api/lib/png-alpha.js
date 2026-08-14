"use strict";

const zlib = require("zlib");

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// 腾讯抠图应返回 8-bit RGBA PNG。该解码器只接受固定格式，供透明质量检查和贴边补留白共用。
const decodeRgbaPng = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("抠图服务未返回有效 PNG。");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("抠图 PNG 数据不完整。");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") idat.push(buffer.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlace !== 0 || !idat.length) {
    throw new Error("抠图 PNG 不含可校验的透明通道。");
  }
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("抠图 PNG 像素数据不完整。");
  let previous = Buffer.alloc(stride);
  const data = Buffer.alloc(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const encoded = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const row = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
      const up = previous[index] || 0;
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upperLeft)
                : null;
      if (predictor == null) throw new Error("抠图 PNG 使用了未知过滤方式。");
      row[index] = (encoded[index] + predictor) & 255;
    }
    row.copy(data, y * stride);
    previous = row;
  }
  return { width, height, data };
};

const alphaMetrics = (buffer) => {
  const image = decodeRgbaPng(buffer);
  let transparent = 0;
  let borderTransparent = 0;
  let foregroundPixels = 0;
  const visited = new Uint8Array(image.width * image.height);
  const queue = new Int32Array(image.width * image.height);
  const componentSizes = [];
  let queueLength = 0;
  const visit = (next) => {
    if (visited[next] || image.data[next * 4 + 3] < 16) return;
    visited[next] = 1;
    queue[queueLength] = next;
    queueLength += 1;
  };
  const borderTotal = image.width * 2 + Math.max(0, image.height - 2) * 2;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const isTransparent = image.data[(y * image.width + x) * 4 + 3] < 16;
      if (isTransparent) transparent += 1;
      else foregroundPixels += 1;
      if ((y === 0 || y === image.height - 1 || x === 0 || x === image.width - 1) && isTransparent) borderTransparent += 1;
    }
  }
  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || image.data[start * 4 + 3] < 16) continue;
    let size = 0;
    queueLength = 1;
    queue[0] = start;
    visited[start] = 1;
    for (let cursor = 0; cursor < queueLength; cursor += 1) {
      const current = queue[cursor];
      size += 1;
      const x = current % image.width;
      const y = Math.floor(current / image.width);
      if (x > 0) visit(current - 1);
      if (x + 1 < image.width) visit(current + 1);
      if (y > 0) visit(current - image.width);
      if (y + 1 < image.height) visit(current + image.width);
    }
    componentSizes.push(size);
  }
  componentSizes.sort((left, right) => right - left);
  return {
    width: image.width,
    height: image.height,
    transparentRatio: transparent / (image.width * image.height),
    transparentBorderRatio: borderTransparent / borderTotal,
    // 衣物主体应是最大的连续前景；明显的第二块前景通常是床单、被子或其他杂物残留。
    secondaryForegroundRatio: foregroundPixels ? (componentSizes[1] || 0) / foregroundPixels : 0
  };
};

const assessMattingQuality = (buffer) => {
  const metrics = alphaMetrics(buffer);
  const accepted = metrics.transparentRatio >= 0.08
    && metrics.transparentRatio <= 0.95
    && metrics.secondaryForegroundRatio <= 0.01
    // 复杂背景残留通常会连到图片边缘；测试中 92% 会放过右侧木板，98% 可拦截且不影响正常样本。
    && metrics.transparentBorderRatio >= 0.98;
  return { accepted, ...metrics };
};

const assessBasicMattingQuality = (buffer) => {
  const metrics = alphaMetrics(buffer);
  // 首版只拦截几乎没有透明背景或衣物主体几乎消失的严重结果，其余交给用户在预览页确认。
  const accepted = metrics.transparentRatio >= 0.02 && metrics.transparentRatio <= 0.98;
  return { accepted, ...metrics };
};

module.exports = { alphaMetrics, assessBasicMattingQuality, assessMattingQuality, decodeRgbaPng };
