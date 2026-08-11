const clamp = (value, min, max, fallback = min) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const dateText = (value) => {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "日期未知";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const rotatedBounds = (layer) => {
  const radians = Number(layer.rotation || 0) * Math.PI / 180;
  const rotatedWidth = Math.abs(layer.width * Math.cos(radians)) + Math.abs(layer.height * Math.sin(radians));
  const rotatedHeight = Math.abs(layer.width * Math.sin(radians)) + Math.abs(layer.height * Math.cos(radians));
  const centerX = layer.left + layer.width / 2;
  const centerY = layer.top + layer.height / 2;
  return {
    left: centerX - rotatedWidth / 2,
    right: centerX + rotatedWidth / 2,
    top: centerY - rotatedHeight / 2,
    bottom: centerY + rotatedHeight / 2
  };
};

const fitLayers = (layers, options = {}) => {
  if (!layers.length) return [];
  const targetWidth = clamp(options.targetWidth, 50, 94, 84);
  const targetHeight = clamp(options.targetHeight, 50, 94, 82);
  const maxScale = clamp(options.maxScale, 1, 4, 3);
  const bounds = layers.map(rotatedBounds);
  const group = {
    left: Math.min(...bounds.map((entry) => entry.left)),
    right: Math.max(...bounds.map((entry) => entry.right)),
    top: Math.min(...bounds.map((entry) => entry.top)),
    bottom: Math.max(...bounds.map((entry) => entry.bottom))
  };
  const groupWidth = Math.max(1, group.right - group.left);
  const groupHeight = Math.max(1, group.bottom - group.top);
  const scale = Math.min(targetWidth / groupWidth, targetHeight / groupHeight, maxScale);
  const groupCenterX = (group.left + group.right) / 2;
  const groupCenterY = (group.top + group.bottom) / 2;
  return layers.map((layer) => {
    const centerX = layer.left + layer.width / 2;
    const centerY = layer.top + layer.height / 2;
    const width = layer.width * scale;
    const height = layer.height * scale;
    return {
      ...layer,
      left: Number((50 + (centerX - groupCenterX) * scale - width / 2).toFixed(2)),
      top: Number((50 + (centerY - groupCenterY) * scale - height / 2).toFixed(2)),
      width: Number(width.toFixed(2)),
      height: Number(height.toFixed(2))
    };
  });
};

const previewPlan = (plan = {}, options = {}) => {
  const canvasWidth = Math.max(1, Number(plan.canvas?.width) || 320);
  const canvasHeight = Math.max(1, Number(plan.canvas?.height) || 520);
  const sourceLayers = (Array.isArray(plan.layers) ? plan.layers : []).map((layer, index) => {
    const scale = clamp(layer.scale, 0.45, 2.2, 1);
    const sourceSize = 27 * scale;
    return {
      ...layer,
      previewKey: `${plan.id || "plan"}-${layer.key || index}`,
      left: Number((clamp(layer.x, 0, canvasWidth, 0) / canvasWidth * 100).toFixed(2)),
      top: Number((clamp(layer.y, 0, canvasHeight, 0) / canvasHeight * 100).toFixed(2)),
      width: Number(sourceSize.toFixed(2)),
      height: Number(sourceSize.toFixed(2)),
      rotation: Math.round(clamp(layer.rotation, -180, 180, 0)),
      z: Math.round(clamp(layer.z, 1, 12, index + 1)),
      imageFailed: false
    };
  }).sort((left, right) => left.z - right.z);
  const layers = fitLayers(sourceLayers, options);
  return {
    ...plan,
    layers,
    itemCount: layers.length,
    dateText: dateText(plan.updatedAt || plan.createdAt)
  };
};

const findPlan = (plans, id) => (Array.isArray(plans) ? plans : []).find((plan) => String(plan.id) === String(id)) || null;

module.exports = { dateText, findPlan, fitLayers, previewPlan, rotatedBounds };
