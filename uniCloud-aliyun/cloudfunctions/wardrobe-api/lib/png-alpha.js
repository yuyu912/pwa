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

// 腾讯抠图应返回 8-bit RGBA PNG。只解析 Alpha，不解码或保存用户图像内容。
const alphaMetrics = (buffer) => {
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
  let transparent = 0;
  let borderTransparent = 0;
  const borderTotal = width * 2 + Math.max(0, height - 2) * 2;
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
    for (let x = 0; x < width; x += 1) {
      const isTransparent = row[x * bytesPerPixel + 3] < 16;
      if (isTransparent) transparent += 1;
      if ((y === 0 || y === height - 1 || x === 0 || x === width - 1) && isTransparent) borderTransparent += 1;
    }
    previous = row;
  }
  return {
    width,
    height,
    transparentRatio: transparent / (width * height),
    transparentBorderRatio: borderTransparent / borderTotal
  };
};

const assessMattingQuality = (buffer) => {
  const metrics = alphaMetrics(buffer);
  const accepted = metrics.transparentRatio >= 0.08
    && metrics.transparentRatio <= 0.95
    // 复杂背景残留通常会连到图片边缘；测试中 92% 会放过右侧木板，98% 可拦截且不影响正常样本。
    && metrics.transparentBorderRatio >= 0.98;
  return { accepted, ...metrics };
};

module.exports = { alphaMetrics, assessMattingQuality };
