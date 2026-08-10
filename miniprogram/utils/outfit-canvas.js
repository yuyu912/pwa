const MIN_SCALE = 0.45;
const MAX_SCALE = 2.2;
const MAX_LAYERS = 12;

const clamp = (value, min, max, fallback = min) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

const placementFor = (category, index, canvas = {}) => {
  canvas = canvas || {};
  const width = Math.max(280, Number(canvas.width) || 320);
  const height = Math.max(420, Number(canvas.height) || 520);
  const positions = {
    "上衣": [0.25, 0.12], "外套": [0.54, 0.12], "裤子": [0.28, 0.47],
    "半身裙": [0.28, 0.47], "连衣裙": [0.37, 0.24], "鞋子": [0.58, 0.72]
  };
  const [xRatio, yRatio] = positions[category] || [0.4, 0.35];
  const offset = (index % 4) * 8;
  return {
    x: Math.round(clamp(width * xRatio + offset, 0, Math.max(0, width - 110), 20)),
    y: Math.round(clamp(height * yRatio + offset, 0, Math.max(0, height - 140), 20))
  };
};

const createLayer = (item, index, canvas, key) => ({
  key: String(key || `${item.id}-${index}`),
  itemId: String(item.id),
  name: item.name || "未命名衣物",
  category: item.category || "",
  color: item.color || "",
  imageUrl: item.imageUrl || "",
  imageFailed: false,
  ...placementFor(item.category, index, canvas),
  scale: 1,
  rotation: 0,
  z: index + 1
});

const serializeLayers = (layers) => ({
  version: 1,
  layers: (Array.isArray(layers) ? layers : []).slice(0, MAX_LAYERS).map((layer) => ({
    key: String(layer.key),
    itemId: String(layer.itemId),
    x: Math.round(clamp(layer.x, 0, 2000, 0)),
    y: Math.round(clamp(layer.y, 0, 3000, 0)),
    scale: Number(clamp(layer.scale, MIN_SCALE, MAX_SCALE, 1).toFixed(2)),
    rotation: Math.round(clamp(layer.rotation, -180, 180, 0)),
    z: Math.round(clamp(layer.z, 1, MAX_LAYERS, 1))
  }))
});

const restoreLayers = (draft, items) => {
  const byId = new Map((Array.isArray(items) ? items : []).map((item) => [String(item.id), item]));
  const saved = Array.isArray(draft?.layers) ? draft.layers.slice(0, MAX_LAYERS) : [];
  return saved.map((layer, index) => {
    const item = byId.get(String(layer.itemId));
    if (!item) return null;
    return {
      ...createLayer(item, index, null, layer.key || `${item.id}-${index}`),
      x: Math.round(clamp(layer.x, 0, 2000, 0)),
      y: Math.round(clamp(layer.y, 0, 3000, 0)),
      scale: Number(clamp(layer.scale, MIN_SCALE, MAX_SCALE, 1).toFixed(2)),
      rotation: Math.round(clamp(layer.rotation, -180, 180, 0)),
      z: Math.round(clamp(layer.z, 1, MAX_LAYERS, index + 1))
    };
  }).filter(Boolean).sort((left, right) => left.z - right.z).map((layer, index) => ({ ...layer, z: index + 1 }));
};

const reorderLayer = (layers, key, direction) => {
  const ordered = [...(Array.isArray(layers) ? layers : [])].sort((left, right) => left.z - right.z);
  const index = ordered.findIndex((layer) => layer.key === key);
  if (index < 0) return ordered;
  const [selected] = ordered.splice(index, 1);
  if (direction === "back") ordered.unshift(selected);
  else ordered.push(selected);
  return ordered.map((layer, layerIndex) => ({ ...layer, z: layerIndex + 1 }));
};

const rotateLayer = (layers, key, amount) => (Array.isArray(layers) ? layers : []).map((layer) => {
  if (layer.key !== key) return layer;
  let rotation = Number(layer.rotation || 0) + Number(amount || 0);
  if (rotation > 180) rotation -= 360;
  if (rotation < -180) rotation += 360;
  return { ...layer, rotation };
});

module.exports = { MAX_LAYERS, MAX_SCALE, MIN_SCALE, createLayer, reorderLayer, restoreLayers, rotateLayer, serializeLayers };
