"use strict";

const { PNG } = require("pngjs");
const jpeg = require("jpeg-js");
const { decodeRgbaPng } = require("./png-alpha");

const decodePng = (buffer, options = {}) => {
  try {
    if (options.useValidatedRgbaDecoder === true) return decodeRgbaPng(buffer);
    return PNG.sync.read(buffer, options);
  } catch {
    throw Object.assign(new Error("服饰分割未返回可处理的 PNG。"), { status: 502, code: "GARMENT_MASK_INVALID" });
  }
};

const encodePng = (width, height, data) => PNG.sync.write({ width, height, data: Buffer.from(data) });
const decodeMaskImage = (buffer) => {
  try {
    return decodePng(buffer);
  } catch {
    try {
      const image = jpeg.decode(buffer, { useTArray: true });
      if (!image?.width || !image?.height || !image?.data) throw new Error("empty jpeg");
      return { width: image.width, height: image.height, data: Buffer.from(image.data) };
    } catch {
      throw Object.assign(new Error("遮挡物分割未返回可处理的 PNG 或 JPG。"), { status: 502, code: "OCCLUDER_MASK_INVALID" });
    }
  }
};
const imageSizeFromPng = (buffer) => {
  const image = decodePng(buffer);
  return { width: image.width, height: image.height };
};
const imageSizeFromBuffer = (buffer) => {
  const image = decodeMaskImage(buffer);
  return { width: image.width, height: image.height };
};
const pixelOffset = (width, x, y) => (y * width + x) * 4;
const luminanceAt = (image, x, y) => {
  const offset = pixelOffset(image.width, x, y);
  return Math.round(image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114);
};

const maskCoverage = (image) => {
  const border = [];
  for (let x = 0; x < image.width; x += 1) {
    border.push(luminanceAt(image, x, 0), luminanceAt(image, x, image.height - 1));
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    border.push(luminanceAt(image, 0, y), luminanceAt(image, image.width - 1, y));
  }
  const foregroundIsLight = border.reduce((sum, value) => sum + value, 0) / Math.max(1, border.length) < 128;
  const coverage = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = pixelOffset(image.width, x, y);
      const value = foregroundIsLight ? luminanceAt(image, x, y) : 255 - luminanceAt(image, x, y);
      coverage[y * image.width + x] = Math.round(value * image.data[offset + 3] / 255);
    }
  }
  return coverage;
};

const unionMaskCoverage = (maskBuffers, width, height) => {
  const union = new Uint8Array(width * height);
  for (const buffer of maskBuffers) {
    const mask = decodePng(buffer);
    if (mask.width !== width || mask.height !== height) {
      throw Object.assign(new Error("服饰分类蒙版尺寸与原图不一致。"), { status: 502, code: "GARMENT_MASK_SIZE_MISMATCH" });
    }
    const coverage = maskCoverage(mask);
    for (let index = 0; index < union.length; index += 1) union[index] = Math.max(union[index], coverage[index]);
  }
  return union;
};

const unionOccluderCoverage = (maskBuffers, width, height) => {
  const union = new Uint8Array(width * height);
  for (const buffer of maskBuffers) {
    const image = decodeMaskImage(buffer);
    if (image.width !== width || image.height !== height) {
      throw Object.assign(new Error("遮挡物蒙版尺寸与人物照片不一致。"), { status: 422, code: "OCCLUDER_MASK_SIZE_MISMATCH" });
    }
    let hasTransparency = false;
    for (let index = 3; index < image.data.length; index += 4) {
      if (image.data[index] < 250) { hasTransparency = true; break; }
    }
    const coverage = hasTransparency
      ? Uint8Array.from({ length: width * height }, (_, index) => image.data[index * 4 + 3])
      : maskCoverage(image);
    for (let index = 0; index < union.length; index += 1) union[index] = Math.max(union[index], coverage[index]);
  }
  return union;
};

const placeMaskOnCanvas = (buffer, width, height, x, y) => {
  const source = decodeMaskImage(buffer);
  const canvas = new PNG({ width, height });
  canvas.data.fill(0);
  const offsetX = Math.max(0, Math.round(Number(x) || 0));
  const offsetY = Math.max(0, Math.round(Number(y) || 0));
  for (let sourceY = 0; sourceY < source.height && sourceY + offsetY < height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width && sourceX + offsetX < width; sourceX += 1) {
      const sourceOffset = pixelOffset(source.width, sourceX, sourceY);
      const targetOffset = pixelOffset(width, sourceX + offsetX, sourceY + offsetY);
      source.data.copy(canvas.data, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return encodePng(width, height, canvas.data);
};

const buildOcclusionBoxMask = (width, height, occlusions, typePattern) => {
  const mask = new PNG({ width, height });
  mask.data.fill(0);
  for (const occlusion of Array.isArray(occlusions) ? occlusions : []) {
    if (!typePattern.test(String(occlusion.type || "")) || !Array.isArray(occlusion.bbox) || occlusion.bbox.length !== 4) continue;
    const box = occlusion.bbox.map((value, index) => {
      const dimension = index % 2 === 0 ? width : height;
      return Math.max(0, Math.min(dimension - 1, Math.round(Number(value) * dimension / 999)));
    });
    for (let y = box[1]; y <= box[3]; y += 1) for (let x = box[0]; x <= box[2]; x += 1) {
      const offset = pixelOffset(width, x, y);
      mask.data[offset] = 255;
      mask.data[offset + 1] = 255;
      mask.data[offset + 2] = 255;
      mask.data[offset + 3] = 255;
    }
  }
  return encodePng(width, height, mask.data);
};

const foregroundBounds = (alpha, width, height, box) => {
  let minX = box.x2;
  let minY = box.y2;
  let maxX = box.x1 - 1;
  let maxY = box.y1 - 1;
  for (let y = box.y1; y < box.y2; y += 1) {
    for (let x = box.x1; x < box.x2; x += 1) {
      if (alpha[y * width + x] < 16) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw Object.assign(new Error("指定衣物类别没有得到有效蒙版。"), { status: 422, code: "GARMENT_MASK_EMPTY" });
  return { minX, minY, maxX, maxY };
};

// 衣橱展示只重新排版透明画布，不缩放、不拉伸，也不改写任何可见衣物像素。
const buildWardrobeDisplayCanvas = (buffer, paddingRatio = 0.12, options = {}) => {
  // 腾讯结果已经由同一解码器完成格式和像素解压；补留白复用该结果，避免第二套解析器规则不一致。
  const source = decodePng(buffer, options.useValidatedRgbaDecoder === true ? { useValidatedRgbaDecoder: true } : {});
  const alpha = Uint8Array.from({ length: source.width * source.height }, (_, index) => source.data[index * 4 + 3]);
  const bounds = foregroundBounds(alpha, source.width, source.height, { x1: 0, y1: 0, x2: source.width, y2: source.height });
  const subjectWidth = bounds.maxX - bounds.minX + 1;
  const subjectHeight = bounds.maxY - bounds.minY + 1;
  const longestSide = Math.max(subjectWidth, subjectHeight);
  const padding = Math.max(8, Math.ceil(longestSide * Math.max(0.08, Math.min(0.2, Number(paddingRatio) || 0.12))));
  const side = longestSide + padding * 2;
  const output = new PNG({ width: side, height: side });
  output.data.fill(0);
  const offsetX = padding + Math.floor((longestSide - subjectWidth) / 2);
  const offsetY = padding + Math.floor((longestSide - subjectHeight) / 2);
  let visiblePixels = 0;
  let preservedPixels = 0;
  for (let y = 0; y < subjectHeight; y += 1) {
    for (let x = 0; x < subjectWidth; x += 1) {
      const sourceOffset = pixelOffset(source.width, bounds.minX + x, bounds.minY + y);
      const targetOffset = pixelOffset(output.width, offsetX + x, offsetY + y);
      // 完全透明像素可能仍藏着白底或棋盘格 RGB；不复制它，避免缩略图压缩后出现白边。
      if (source.data[sourceOffset + 3] === 0) continue;
      source.data.copy(output.data, targetOffset, sourceOffset, sourceOffset + 4);
      if (source.data[sourceOffset + 3] >= 16) {
        visiblePixels += 1;
        if (output.data[targetOffset] === source.data[sourceOffset]
          && output.data[targetOffset + 1] === source.data[sourceOffset + 1]
          && output.data[targetOffset + 2] === source.data[sourceOffset + 2]
          && output.data[targetOffset + 3] === source.data[sourceOffset + 3]) preservedPixels += 1;
      }
    }
  }
  return {
    buffer: encodePng(output.width, output.height, output.data),
    width: output.width,
    height: output.height,
    paddingRatio: Math.round(padding / side * 10000) / 10000,
    displayMode: "square_centered_source_pixels",
    visiblePixelPreservationScore: visiblePixels ? Math.round(preservedPixels * 10000 / visiblePixels) / 100 : 0
  };
};

const assessGarmentContourQuality = (buffer) => {
  const image = decodePng(buffer);
  const alpha = Uint8Array.from({ length: image.width * image.height }, (_, index) => image.data[index * 4 + 3]);
  const bounds = foregroundBounds(alpha, image.width, image.height, { x1: 0, y1: 0, x2: image.width, y2: image.height });
  const subjectWidth = bounds.maxX - bounds.minX + 1;
  const subjectHeight = bounds.maxY - bounds.minY + 1;
  let foreground = 0;
  let perimeterForeground = 0;
  let perimeter = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const visible = alpha[y * image.width + x] >= 16;
      if (visible) foreground += 1;
      if (x === bounds.minX || x === bounds.maxX || y === bounds.minY || y === bounds.maxY) {
        perimeter += 1;
        if (visible) perimeterForeground += 1;
      }
    }
  }
  const boundingBoxFillRatio = foreground / Math.max(1, subjectWidth * subjectHeight);
  const opaquePerimeterRatio = perimeterForeground / Math.max(1, perimeter);
  const rectangularForeground = boundingBoxFillRatio >= 0.92 && opaquePerimeterRatio >= 0.85;
  return {
    accepted: !rectangularForeground,
    boundingBoxFillRatio: Math.round(boundingBoxFillRatio * 10000) / 10000,
    opaquePerimeterRatio: Math.round(opaquePerimeterRatio * 10000) / 10000,
    failureReason: rectangularForeground ? "衣物蒙版仍呈矩形人物裁剪，未形成清晰的透明衣物轮廓。" : ""
  };
};

const internalTransparentComponents = (alpha, width, height) => {
  const outside = new Uint8Array(width * height);
  const queue = [];
  const addOutside = (x, y) => {
    const index = y * width + x;
    if (outside[index] || alpha[index] >= 16) return;
    outside[index] = 1;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    addOutside(x, 0);
    addOutside(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    addOutside(0, y);
    addOutside(width - 1, y);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) addOutside(x - 1, y);
    if (x + 1 < width) addOutside(x + 1, y);
    if (y > 0) addOutside(x, y - 1);
    if (y + 1 < height) addOutside(x, y + 1);
  }
  const visited = new Uint8Array(width * height);
  const components = [];
  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start] >= 16 || outside[start] || visited[start]) continue;
    const component = [];
    const pending = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const index = pending[cursor];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || outside[neighbor] || alpha[neighbor] >= 16) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
};

const binaryComponents = (binary, width, height) => {
  const visited = new Uint8Array(binary.length);
  const components = [];
  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || visited[start]) continue;
    const component = [];
    const pending = [start];
    visited[start] = 1;
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const index = pending[cursor];
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || !binary[neighbor]) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
};

const explicitOcclusionComponents = (originalAlpha, output, detection, source, bounds, paddingX, paddingY, sourceOccluderCoverage = null) => {
  const occlusions = Array.isArray(detection.occlusions) ? detection.occlusions : [];
  if (!occlusions.length) return [];
  const components = [];
  const subjectWidth = Math.max(1, bounds.maxX - bounds.minX + 1);
  const subjectHeight = Math.max(1, bounds.maxY - bounds.minY + 1);
  const maxHorizontalSearch = Math.max(3, Math.ceil(subjectWidth * 0.12));
  const maxVerticalSearch = Math.max(3, Math.ceil(subjectHeight * 0.12));
  const maxBodyVerticalSearch = Math.max(maxVerticalSearch, Math.ceil(subjectHeight * 0.25));
  const hasVisible = (x, y, dx, dy, limit) => {
    for (let distance = 1; distance <= limit; distance += 1) {
      const nextX = x + dx * distance;
      const nextY = y + dy * distance;
      if (nextX < 0 || nextY < 0 || nextX >= output.width || nextY >= output.height) return false;
      if (originalAlpha[nextY * output.width + nextX] >= 16) return true;
    }
    return false;
  };
  for (const occlusion of occlusions) {
    if (!Array.isArray(occlusion.bbox) || occlusion.bbox.length !== 4) continue;
    const candidate = new Uint8Array(originalAlpha.length);
    const sourceBox = occlusion.bbox.map((value, index) => {
      const dimension = index % 2 === 0 ? source.width : source.height;
      return Math.max(0, Math.min(dimension, Math.round(Number(value) * dimension / 999)));
    });
    const minX = Math.max(0, sourceBox[0] - bounds.minX + paddingX);
    const minY = Math.max(0, sourceBox[1] - bounds.minY + paddingY);
    const maxX = Math.min(output.width - 1, sourceBox[2] - bounds.minX + paddingX);
    const maxY = Math.min(output.height - 1, sourceBox[3] - bounds.minY + paddingY);
    const isBodyOccluder = /头发|手|手臂|皮肤/.test(String(occlusion.type || ""));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const index = y * output.width + x;
        if (originalAlpha[index] >= 16) continue;
        const sourceX = x + bounds.minX - paddingX;
        const sourceY = y + bounds.minY - paddingY;
        if (sourceOccluderCoverage && (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height
          || sourceOccluderCoverage[sourceY * source.width + sourceX] < 16)) continue;
        const verticalEvidence = hasVisible(x, y, 0, -1, maxVerticalSearch) && hasVisible(x, y, 0, 1, maxVerticalSearch);
        const horizontalEvidence = hasVisible(x, y, -1, 0, maxHorizontalSearch) && hasVisible(x, y, 1, 0, maxHorizontalSearch);
        const relativeY = (y - paddingY) / subjectHeight;
        const oneSidedBodyEvidence = isBodyOccluder && relativeY <= 0.3
          && hasVisible(x, y, 0, 1, maxBodyVerticalSearch);
        const supported = ["裤子", "半身裙"].includes(detection.category)
          ? verticalEvidence || oneSidedBodyEvidence
          : verticalEvidence || horizontalEvidence || oneSidedBodyEvidence;
        if (supported) candidate[index] = 1;
      }
    }
    components.push(...binaryComponents(candidate, output.width, output.height));
  }
  return components;
};

const boundaryColors = (component, output) => {
  const componentSet = new Set(component);
  const colors = [];
  for (const index of component) {
    const x = index % output.width;
    const y = Math.floor(index / output.width);
    const neighbors = [x > 0 ? index - 1 : -1, x + 1 < output.width ? index + 1 : -1, y > 0 ? index - output.width : -1, y + 1 < output.height ? index + output.width : -1];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || componentSet.has(neighbor) || output.data[neighbor * 4 + 3] < 16) continue;
      colors.push([output.data[neighbor * 4], output.data[neighbor * 4 + 1], output.data[neighbor * 4 + 2]]);
    }
  }
  return colors;
};

const componentBounds = (component, width) => component.reduce((bounds, index) => {
  const x = index % width;
  const y = Math.floor(index / width);
  return {
    minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y)
  };
}, { minX: width, minY: Number.MAX_SAFE_INTEGER, maxX: -1, maxY: -1 });

const alphaBounds = (alpha, width) => {
  const visible = [];
  for (let index = 0; index < alpha.length; index += 1) if (alpha[index] >= 16) visible.push(index);
  return componentBounds(visible, width);
};

const touchesCriticalStructure = (component, originalAlpha, output, detection) => {
  const garment = alphaBounds(originalAlpha, output.width);
  const hole = componentBounds(component, output.width);
  const subjectWidth = Math.max(1, garment.maxX - garment.minX + 1);
  const subjectHeight = Math.max(1, garment.maxY - garment.minY + 1);
  const relativeTop = (hole.minY - garment.minY) / subjectHeight;
  const relativeBottom = (garment.maxY - hole.maxY) / subjectHeight;
  const relativeLeft = (hole.minX - garment.minX) / subjectWidth;
  const relativeRight = (garment.maxX - hole.maxX) / subjectWidth;
  if (["上衣", "外套", "连衣裙"].includes(detection.category)) {
    return relativeTop < 0.2 || relativeBottom < 0.1 || relativeLeft < 0.06 || relativeRight < 0.06;
  }
  if (["裤子", "半身裙"].includes(detection.category)) {
    return relativeTop < 0.28 || relativeBottom < 0.1;
  }
  return false;
};

const isNaturalTrouserLegGap = (component, originalAlpha, output, detection) => {
  if (detection.category !== "裤子") return false;
  const garment = alphaBounds(originalAlpha, output.width);
  const hole = componentBounds(component, output.width);
  const garmentWidth = Math.max(1, garment.maxX - garment.minX + 1);
  const garmentHeight = Math.max(1, garment.maxY - garment.minY + 1);
  const holeCenterX = ((hole.minX + hole.maxX) / 2 - garment.minX) / garmentWidth;
  const holeTop = (hole.minY - garment.minY) / garmentHeight;
  const holeBottom = (hole.maxY - garment.minY) / garmentHeight;
  const holeHeight = (hole.maxY - hole.minY + 1) / garmentHeight;
  const holeWidth = (hole.maxX - hole.minX + 1) / garmentWidth;
  return holeCenterX >= 0.4 && holeCenterX <= 0.6
    && holeTop >= 0.12 && holeTop <= 0.5
    && holeBottom >= 0.65
    && holeHeight >= 0.3
    && holeWidth <= 0.3;
};

const padRepairAssets = (output, repairMask) => {
  const targetWidth = Math.max(512, Math.ceil(output.width / 64) * 64);
  const targetHeight = Math.max(512, Math.ceil(output.height / 64) * 64);
  if (targetWidth > 2048 || targetHeight > 2048) {
    return { unsafeReason: "待修补衣物超过局部编辑画布限制。" };
  }
  if (targetWidth === output.width && targetHeight === output.height) return { output, repairMask };
  const padded = new PNG({ width: targetWidth, height: targetHeight });
  const paddedMask = new PNG({ width: targetWidth, height: targetHeight });
  padded.data.fill(0);
  paddedMask.data.fill(0);
  const offsetX = Math.floor((targetWidth - output.width) / 2);
  const offsetY = Math.floor((targetHeight - output.height) / 2);
  for (let y = 0; y < output.height; y += 1) {
    for (let x = 0; x < output.width; x += 1) {
      const sourceOffset = pixelOffset(output.width, x, y);
      const targetOffset = pixelOffset(targetWidth, x + offsetX, y + offsetY);
      output.data.copy(padded.data, targetOffset, sourceOffset, sourceOffset + 4);
      repairMask.data.copy(paddedMask.data, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { output: padded, repairMask: paddedMask };
};

const repairSmallHoles = (output, originalAlpha, detection, explicitComponents = []) => {
  const foregroundPixels = originalAlpha.reduce((sum, value) => sum + (value >= 16 ? 1 : 0), 0);
  const intentionalOpenwork = /镂空|蕾丝|网眼|透视|透明|破洞/.test(`${detection.structure || ""} ${Object.values(detection.structureFacts || {}).join(" ")}`);
  const candidate = new Uint8Array(originalAlpha.length);
  const explicitPixels = new Uint8Array(originalAlpha.length);
  for (const component of explicitComponents) for (const index of component) explicitPixels[index] = 1;
  const explicitPixelCount = explicitPixels.reduce((sum, value) => sum + value, 0);
  const estimatedGarmentPixels = Math.max(1, foregroundPixels + explicitPixelCount);
  const internalComponents = intentionalOpenwork
    ? []
    : internalTransparentComponents(originalAlpha, output.width, output.height)
      .filter((component) => !isNaturalTrouserLegGap(component, originalAlpha, output, detection));
  const unknownInternalComponents = internalComponents.filter((component) => !component.some((index) => explicitPixels[index]));
  const largeInternal = unknownInternalComponents.filter((component) => component.length / Math.max(1, foregroundPixels) > 0.02);
  if (largeInternal.length) {
    return { repairedPixelCount: 0, occlusionRatio: largeInternal.reduce((sum, item) => sum + item.length, 0) / Math.max(1, foregroundPixels), unsafeReason: "衣物内部存在超过2%的未知缺口。", repairMode: "rejected" };
  }
  const internalPixels = unknownInternalComponents.reduce((sum, item) => sum + item.length, 0);
  if (internalPixels / Math.max(1, foregroundPixels) > 0.05) {
    return { repairedPixelCount: 0, occlusionRatio: internalPixels / Math.max(1, foregroundPixels), unsafeReason: "衣物未知小缺口合计超过5%。", repairMode: "rejected" };
  }
  const largeExplicit = explicitComponents.filter((component) => component.length / estimatedGarmentPixels > 0.105);
  if (largeExplicit.length) {
    const largestRatio = Math.max(...largeExplicit.map((component) => component.length / estimatedGarmentPixels));
    return {
      repairedPixelCount: 0,
      occlusionRatio: largeExplicit.reduce((sum, item) => sum + item.length, 0) / estimatedGarmentPixels,
      unsafeReason: `明确遮挡区域单块占衣物${Math.round(largestRatio * 10000) / 100}%，超过10.5%的边缘容差，不能可靠局部补全。`,
      repairMode: "rejected"
    };
  }
  const knownOcclusions = Array.isArray(detection.occlusions) ? detection.occlusions : [];
  const onlyPreciseBodyOcclusions = knownOcclusions.length > 0
    && knownOcclusions.every((occlusion) => /头发|手|手臂|皮肤/.test(String(occlusion.type || "")));
  const explicitOcclusionLimit = knownOcclusions.length >= 2 ? 0.18 : onlyPreciseBodyOcclusions ? 0.15 : 0.12;
  if (explicitPixelCount / estimatedGarmentPixels > explicitOcclusionLimit) {
    return {
      repairedPixelCount: 0,
      occlusionRatio: explicitPixelCount / estimatedGarmentPixels,
      unsafeReason: `明确遮挡区域合计超过${Math.round(explicitOcclusionLimit * 100)}%，不能可靠局部补全。`,
      repairMode: "rejected"
    };
  }
  if (!intentionalOpenwork) {
    for (const component of internalComponents) {
      for (const index of component) candidate[index] = 1;
    }
  }
  for (const component of explicitComponents) for (const index of component) {
    candidate[index] = 1;
    explicitPixels[index] = 1;
  }
  const components = binaryComponents(candidate, output.width, output.height);
  const repairable = components;
  const totalRepairPixels = repairable.reduce((sum, item) => sum + item.length, 0);
  if (totalRepairPixels / estimatedGarmentPixels > explicitOcclusionLimit) {
    return {
      repairedPixelCount: 0,
      occlusionRatio: totalRepairPixels / estimatedGarmentPixels,
      unsafeReason: `衣物全部待补区域合计超过${Math.round(explicitOcclusionLimit * 100)}%。`,
      repairMode: "rejected"
    };
  }
  const repairMask = new PNG({ width: output.width, height: output.height });
  repairMask.data.fill(0);
  let generatedPixelCount = 0;
  let deterministicPixelCount = 0;
  for (const component of repairable) {
    const hasExplicitEvidence = component.some((index) => explicitPixels[index]);
    const componentRatio = component.length / Math.max(1, foregroundPixels);
    const isNegligibleMaskNoise = componentRatio <= 0.0005;
    if (!hasExplicitEvidence && !isNegligibleMaskNoise && touchesCriticalStructure(component, originalAlpha, output, detection)) {
      return { repairedPixelCount: 0, occlusionRatio: totalRepairPixels / estimatedGarmentPixels, unsafeReason: "遮挡靠近领口、袖口、下摆或腰头等关键结构，不能可靠补全。", repairMode: "rejected" };
    }
    const colors = boundaryColors(component, output);
    if (hasExplicitEvidence) {
      for (const index of component) {
        const offset = index * 4;
        repairMask.data[offset] = 255;
        repairMask.data[offset + 1] = 255;
        repairMask.data[offset + 2] = 255;
        repairMask.data[offset + 3] = 255;
      }
      generatedPixelCount += component.length;
      continue;
    }
    if (colors.length < 4) return { repairedPixelCount: 0, occlusionRatio: totalRepairPixels / estimatedGarmentPixels, unsafeReason: "遮挡边缘信息不足，无法保真修补。", repairMode: "rejected" };
    const mean = [0, 1, 2].map((channel) => colors.reduce((sum, color) => sum + color[channel], 0) / colors.length);
    const deviation = [0, 1, 2].map((channel) => Math.sqrt(colors.reduce((sum, color) => sum + (color[channel] - mean[channel]) ** 2, 0) / colors.length));
    if (Math.max(...deviation) > 64) return { repairedPixelCount: 0, occlusionRatio: totalRepairPixels / estimatedGarmentPixels, unsafeReason: "遮挡周围包含复杂图案或固定细节，不能可靠补全。", repairMode: "rejected" };
    if (Math.max(...deviation) <= 28) {
      for (const index of component) {
        output.data[index * 4] = Math.round(mean[0]);
        output.data[index * 4 + 1] = Math.round(mean[1]);
        output.data[index * 4 + 2] = Math.round(mean[2]);
        output.data[index * 4 + 3] = 255;
      }
      deterministicPixelCount += component.length;
    } else {
      for (const index of component) {
        const offset = index * 4;
        repairMask.data[offset] = 255;
        repairMask.data[offset + 1] = 255;
        repairMask.data[offset + 2] = 255;
        repairMask.data[offset + 3] = 255;
      }
      generatedPixelCount += component.length;
    }
  }
  return {
    repairedPixelCount: deterministicPixelCount,
    generatedPixelCount,
    repairMask,
    occlusionRatio: totalRepairPixels / estimatedGarmentPixels,
    unsafeReason: "",
    repairMode: generatedPixelCount ? "image_edit_small_internal_hole" : deterministicPixelCount ? "deterministic_small_internal_hole" : "none"
  };
};

const buildGarmentCutout = (combinedBuffer, maskBuffers, pixelBox, detection = {}, occluderMaskBuffers = []) => {
  const combined = decodePng(combinedBuffer);
  const classCoverage = unionMaskCoverage(maskBuffers, combined.width, combined.height);
  const occluderCoverage = occluderMaskBuffers.length
    ? unionOccluderCoverage(occluderMaskBuffers, combined.width, combined.height)
    : new Uint8Array(combined.width * combined.height);
  const alpha = new Uint8Array(combined.width * combined.height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = Math.round(combined.data[index * 4 + 3] * classCoverage[index] * (255 - occluderCoverage[index]) / 65025);
  }
  const box = {
    x1: Math.max(0, Math.floor(pixelBox[0])),
    y1: Math.max(0, Math.floor(pixelBox[1])),
    x2: Math.min(combined.width, Math.ceil(pixelBox[2])),
    y2: Math.min(combined.height, Math.ceil(pixelBox[3]))
  };
  const bounds = foregroundBounds(alpha, combined.width, combined.height, box);
  const subjectWidth = bounds.maxX - bounds.minX + 1;
  const subjectHeight = bounds.maxY - bounds.minY + 1;
  const paddingX = Math.max(2, Math.ceil(subjectWidth * 0.12));
  const paddingY = Math.max(2, Math.ceil(subjectHeight * 0.12));
  const output = new PNG({ width: subjectWidth + paddingX * 2, height: subjectHeight + paddingY * 2 });
  output.data.fill(0);
  const originalAlpha = new Uint8Array(output.width * output.height);
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const sourceIndex = y * combined.width + x;
      const targetX = x - bounds.minX + paddingX;
      const targetY = y - bounds.minY + paddingY;
      const targetIndex = targetY * output.width + targetX;
      const sourceOffset = sourceIndex * 4;
      const targetOffset = targetIndex * 4;
      output.data[targetOffset] = combined.data[sourceOffset];
      output.data[targetOffset + 1] = combined.data[sourceOffset + 1];
      output.data[targetOffset + 2] = combined.data[sourceOffset + 2];
      output.data[targetOffset + 3] = alpha[sourceIndex];
      originalAlpha[targetIndex] = alpha[sourceIndex];
    }
  }
  const originalVisiblePixels = Buffer.from(output.data);
  const explicitComponents = explicitOcclusionComponents(
    originalAlpha,
    output,
    detection,
    combined,
    bounds,
    paddingX,
    paddingY,
    occluderMaskBuffers.length ? occluderCoverage : null
  );
  const repair = repairSmallHoles(output, originalAlpha, detection, explicitComponents);
  let preserved = 0;
  let visible = 0;
  for (let index = 0; index < originalAlpha.length; index += 1) {
    if (originalAlpha[index] < 16) continue;
    visible += 1;
    const offset = index * 4;
    if (output.data[offset] === originalVisiblePixels[offset]
      && output.data[offset + 1] === originalVisiblePixels[offset + 1]
      && output.data[offset + 2] === originalVisiblePixels[offset + 2]
      && output.data[offset + 3] === originalVisiblePixels[offset + 3]) preserved += 1;
  }
  const padded = repair.generatedPixelCount ? padRepairAssets(output, repair.repairMask) : { output, repairMask: repair.repairMask };
  if (padded.unsafeReason) repair.unsafeReason = padded.unsafeReason;
  const finalOutput = padded.output || output;
  const finalRepairMask = padded.repairMask;
  return {
    buffer: encodePng(finalOutput.width, finalOutput.height, finalOutput.data),
    repairMaskBuffer: repair.generatedPixelCount && finalRepairMask ? encodePng(finalRepairMask.width, finalRepairMask.height, finalRepairMask.data) : null,
    width: finalOutput.width,
    height: finalOutput.height,
    visiblePixelPreservationScore: visible ? Math.round(preserved * 10000 / visible) / 100 : 0,
    occlusionRatio: Math.round(repair.occlusionRatio * 10000) / 10000,
    repairedPixelCount: repair.repairedPixelCount,
    generatedPixelCount: repair.generatedPixelCount || 0,
    repairMode: repair.unsafeReason ? "rejected" : repair.repairMode,
    unsafeReason: repair.unsafeReason
  };
};

const applyRepairCandidate = (originalBuffer, candidateBuffer, repairMaskBuffer) => {
  const original = decodePng(originalBuffer);
  const candidate = decodePng(candidateBuffer);
  const repairMask = decodePng(repairMaskBuffer);
  if (candidate.width !== original.width || candidate.height !== original.height
    || repairMask.width !== original.width || repairMask.height !== original.height) {
    throw Object.assign(new Error("局部修补候选尺寸与原图不一致。"), { status: 422, code: "GARMENT_REPAIR_SIZE_MISMATCH" });
  }
  const result = Buffer.from(original.data);
  let repairedPixelCount = 0;
  let visiblePixels = 0;
  let preservedPixels = 0;
  for (let index = 0; index < original.width * original.height; index += 1) {
    const offset = index * 4;
    const repair = luminanceAt(repairMask, index % original.width, Math.floor(index / original.width)) >= 128;
    if (repair) {
      result[offset] = candidate.data[offset];
      result[offset + 1] = candidate.data[offset + 1];
      result[offset + 2] = candidate.data[offset + 2];
      result[offset + 3] = 255;
      repairedPixelCount += 1;
    }
    if (original.data[offset + 3] >= 16) {
      visiblePixels += 1;
      if (result[offset] === original.data[offset]
        && result[offset + 1] === original.data[offset + 1]
        && result[offset + 2] === original.data[offset + 2]
        && result[offset + 3] === original.data[offset + 3]) preservedPixels += 1;
    }
  }
  return {
    buffer: encodePng(original.width, original.height, result),
    width: original.width,
    height: original.height,
    repairedPixelCount,
    visiblePixelPreservationScore: visiblePixels ? Math.round(preservedPixels * 10000 / visiblePixels) / 100 : 0
  };
};

module.exports = {
  applyRepairCandidate,
  assessGarmentContourQuality,
  buildGarmentCutout,
  buildWardrobeDisplayCanvas,
  buildOcclusionBoxMask,
  imageSizeFromBuffer,
  imageSizeFromPng,
  placeMaskOnCanvas,
  _test: { decodePng, encodePng, internalTransparentComponents, maskCoverage, unionMaskCoverage }
};
