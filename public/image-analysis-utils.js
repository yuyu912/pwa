function rgbToHsv(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { hue, saturation: max ? delta / max : 0, value: max };
}

function colorFamily(hue, saturation, value) {
  if (value < 0.22) return "黑色系";
  if (saturation < 0.12 && value > 0.86) return "白色系";
  if (saturation < 0.18) return "灰色系";
  if (hue < 15 || hue >= 345) return "红色系";
  if (hue < 50) return "黄色系";
  if (hue < 78) return "黄绿色系";
  if (hue < 165) return "绿色系";
  if (hue < 200) return "青色系";
  if (hue < 255) return "蓝色系";
  if (hue < 290) return "紫色系";
  if (hue < 345) return "粉色系";
  return "中性色";
}

export function analyzeRgbaPixels(pixels, width, height) {
  const total = width * height;
  const mask = new Uint8Array(total);
  let foreground = 0;
  let transparent = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0, saturation: 0, value: 0 }));
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha <= 12) transparent += 1;
    if (alpha < 48) continue;
    const pixelIndex = index / 4;
    mask[pixelIndex] = 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    foreground += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const hsv = rgbToHsv(r, g, b);
    if (hsv.value < 0.2 || hsv.value > 0.97 || hsv.saturation < 0.08) continue;
    const weight = (alpha / 255) * (0.25 + hsv.saturation) * (0.4 + hsv.value);
    const bin = bins[Math.floor(hsv.hue / 15) % bins.length];
    bin.weight += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
    bin.saturation += hsv.saturation * weight;
    bin.value += hsv.value * weight;
  }
  const foregroundRatio = total ? foreground / total : 0;
  const transparentRatio = total ? transparent / total : 0;
  const boxWidthRatio = maxX >= minX ? (maxX - minX + 1) / width : 0;
  const boxHeightRatio = maxY >= minY ? (maxY - minY + 1) / height : 0;
  let largestComponent = 0;
  const queue = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (!mask[start]) continue;
    let head = 0;
    let tail = 0;
    let component = 0;
    queue[tail++] = start;
    mask[start] = 0;
    while (head < tail) {
      const current = queue[head++];
      component += 1;
      const x = current % width;
      const neighbors = [current - width, current + width, current - 1, current + 1];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= total || !mask[neighbor]) continue;
        if ((neighbor === current - 1 && x === 0) || (neighbor === current + 1 && x === width - 1)) continue;
        mask[neighbor] = 0;
        queue[tail++] = neighbor;
      }
    }
    largestComponent = Math.max(largestComponent, component);
  }
  const connectedRatio = foreground ? largestComponent / foreground : 0;
  const quality = {
    foregroundRatio,
    transparentRatio,
    boxWidthRatio,
    boxHeightRatio,
    connectedRatio,
    valid: foregroundRatio >= 0.03 && foregroundRatio <= 0.94 && transparentRatio >= 0.03 && boxWidthRatio >= 0.1 && boxHeightRatio >= 0.1 && connectedRatio >= 0.72,
  };
  const dominantIndex = bins.reduce((best, bin, index) => bin.weight > bins[best].weight ? index : best, 0);
  const dominant = bins[dominantIndex];
  if (!dominant.weight) return { quality, color: "" };
  const r = Math.round(dominant.r / dominant.weight);
  const g = Math.round(dominant.g / dominant.weight);
  const b = Math.round(dominant.b / dominant.weight);
  const hue = dominantIndex * 15 + 7.5;
  const family = colorFamily(hue, dominant.saturation / dominant.weight, dominant.value / dominant.weight);
  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  return { quality, color: `${family}（${hex}）`, hue };
}
