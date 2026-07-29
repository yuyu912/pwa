export function createLocalId(cryptoApi = globalThis.crypto) {
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export async function fingerprintFile(file, cryptoApi = globalThis.crypto) {
  const buffer = await file.arrayBuffer();
  if (cryptoApi?.subtle) {
    return Array.from(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const bytes = new Uint8Array(buffer);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ (byte + 0x9d), 0x85ebca6b) >>> 0;
  }
  return `compat-${bytes.length}-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function hasValidEmbedding(value) {
  if (value instanceof ArrayBuffer) return value.byteLength > 0 && value.byteLength % 4 === 0;
  if (ArrayBuffer.isView(value)) return value.byteLength > 0 && value.byteLength % 4 === 0;
  return false;
}

export function normalizeRecognitionState(item) {
  const embeddingReady = hasValidEmbedding(item?.embedding);
  return {
    recognitionMode: item?.recognitionMode || (embeddingReady ? "ai" : "manual-fallback"),
    embeddingState: item?.embeddingState || (embeddingReady ? "ready" : "unavailable"),
    cutoutState: item?.cutoutState || (embeddingReady ? "ready" : "pending"),
  };
}

export function createManualFallbackDraft(file, sourceHash, color = "", recognitionError = "") {
  return {
    source: file,
    cutout: file,
    sourceHash,
    embedding: new ArrayBuffer(0),
    recognitionMode: "manual-fallback",
    embeddingState: "unavailable",
    cutoutState: "pending",
    recognitionCandidates: {},
    recognitionConfidence: {},
    recognitionError,
    tags: { category: "", color, season: "", pattern: "", material: "", styles: [], scenes: [] },
  };
}

export async function timedFetch(url, options = {}, timeout = 10000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
