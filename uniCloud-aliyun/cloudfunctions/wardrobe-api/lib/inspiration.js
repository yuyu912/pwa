"use strict";

const dns = require("dns").promises;
const https = require("https");
const net = require("net");

const NOTE_HOSTS = ["xhslink.cn", "xhslink.com", "xiaohongshu.com"];
const IMAGE_HOSTS = ["xhscdn.com", "xiaohongshu.com"];
const ALLOWED_CATEGORIES = ["上衣", "裤子", "半身裙", "外套", "连衣裙"];
const ALLOWED_SCENES = ["休闲", "通勤", "约会", "旅行", "聚会", "运动"];
const ALLOWED_SLOTS = ["top", "bottom", "dress", "outerwear"];
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INITIAL_STATE_BYTES = 512 * 1024;

const cleanText = (value, max = 120) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const cleanTags = (value, allowed = null, max = 3) => (Array.isArray(value) ? value : [])
  .map((entry) => cleanText(entry, 20))
  .filter((entry, index, list) => entry && list.indexOf(entry) === index && (!allowed || allowed.includes(entry)))
  .slice(0, max);

const hostAllowed = (hostname, roots) => roots.some((root) => hostname === root || hostname.endsWith(`.${root}`));

const detectImageMime = (buffer) => {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
};

const extractXiaohongshuUrl = (sharedText) => {
  const urls = String(sharedText || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const raw of urls) {
    try {
      const url = new URL(raw.replace(/[，。；、）\]】]+$/g, ""));
      const hostname = url.hostname.toLowerCase();
      if (!hostAllowed(hostname, NOTE_HOSTS)) continue;
      // 小红书分享文本当前可能生成 http://xhslink.cn；只对该短链域名升级 HTTPS，实际出站请求仍禁止 HTTP。
      if (url.protocol === "http:" && (hostname === "xhslink.cn" || hostname.endsWith(".xhslink.cn"))) url.protocol = "https:";
      if (url.protocol === "https:") return url.toString();
    } catch {}
  }
  throw Object.assign(new Error("只支持有效的小红书 HTTPS 分享链接。"), { status: 400, code: "INSPIRATION_LINK_INVALID" });
};

const isPrivateAddress = (address) => {
  const normalized = String(address || "").toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19)
      || parts[0] === 0
      || parts[0] >= 224;
  }
  if (net.isIPv6(normalized)) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff");
  }
  return true;
};

const validatedAddresses = async (url, roots) => {
  if (!(url instanceof URL) || url.protocol !== "https:" || !hostAllowed(url.hostname.toLowerCase(), roots)) {
    throw Object.assign(new Error("链接目标不在允许的平台域名内。"), { status: 400, code: "INSPIRATION_HOST_FORBIDDEN" });
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error("链接目标地址不可访问。"), { status: 400, code: "INSPIRATION_ADDRESS_FORBIDDEN" });
  }
  const seen = new Set();
  return addresses.filter((entry) => {
    if (seen.has(entry.address)) return false;
    seen.add(entry.address);
    return true;
  }).slice(0, 4);
};

const pinnedLookup = (address) => (_hostname, lookupOptions, callback) => {
  // Node 20+ 的 HTTPS 客户端可能以 all:true 请求地址数组；Node 16 仍使用单地址回调。
  if (lookupOptions?.all) return callback(null, [{ address: address.address, family: address.family }]);
  return callback(null, address.address, address.family);
};

const retryableAddressError = (error) => [
  "INSPIRATION_PUBLIC_PAGE_TIMEOUT", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ECONNREFUSED", "ERR_SOCKET_CONNECTION_TIMEOUT"
].includes(String(error?.code || ""));

const withAddressFallback = async (addresses, requester) => {
  let lastError = null;
  for (let index = 0; index < addresses.length; index += 1) {
    try { return await requester(addresses[index]); } catch (error) {
      lastError = error;
      if (!retryableAddressError(error) || index === addresses.length - 1) throw error;
    }
  }
  throw lastError || Object.assign(new Error("链接目标地址不可访问。"), { code: "INSPIRATION_ADDRESS_FORBIDDEN" });
};

const requestBuffer = async (input, options = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  const roots = options.roots || NOTE_HOSTS;
  const limit = Number(options.limit || MAX_HTML_BYTES);
  const redirects = Number(options.redirects || 0);
  if (redirects > 3) throw Object.assign(new Error("分享链接跳转次数过多。"), { status: 422, code: "INSPIRATION_REDIRECT_LIMIT" });
  const addresses = await validatedAddresses(url, roots);
  return withAddressFallback(addresses, (address) => new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      timeout: 8000,
      headers: {
        Accept: options.accept || "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        "User-Agent": "WardrobeRelation-InspirationResolver/1.0"
      },
      lookup: pinnedLookup(address)
    }, async (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        try {
          const next = new URL(response.headers.location, url);
          resolve(await requestBuffer(next, { ...options, redirects: redirects + 1 }));
        } catch (error) { reject(error); }
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(Object.assign(new Error(`公开页面返回 HTTP ${statusCode}。`), { status: 422, code: "INSPIRATION_PUBLIC_PAGE_BLOCKED", providerStatusCode: statusCode }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          request.destroy(Object.assign(new Error("公开内容超过首版大小限制。"), { status: 422, code: "INSPIRATION_SOURCE_TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: cleanText(response.headers["content-type"], 100).toLowerCase(),
        finalUrl: url.toString()
      }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("公开页面读取超时。"), { status: 422, code: "INSPIRATION_PUBLIC_PAGE_TIMEOUT" })));
    request.on("error", reject);
    request.end();
  }));
};

const decodeEntities = (value) => String(value || "")
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

const metaAttributes = (tag) => {
  const attributes = {};
  String(tag || "").replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_all, name, quoted, single, bare) => {
    attributes[String(name).toLowerCase()] = decodeEntities(quoted ?? single ?? bare ?? "");
    return _all;
  });
  return attributes;
};

const collectJsonLd = (value, result) => {
  if (Array.isArray(value)) return value.forEach((entry) => collectJsonLd(entry, result));
  if (!value || typeof value !== "object") return;
  if (!result.title && value.headline) result.title = cleanText(value.headline, 120);
  const author = Array.isArray(value.author) ? value.author[0] : value.author;
  if (!result.author && author) result.author = cleanText(typeof author === "string" ? author : author.name, 60);
  const images = Array.isArray(value.image) ? value.image : value.image ? [value.image] : [];
  images.forEach((image) => result.images.push(typeof image === "string" ? image : image?.url || image?.contentUrl || ""));
  Object.values(value).forEach((entry) => collectJsonLd(entry, result));
};

const isPlatformUiImage = (url) => url.hostname === "picasso-static.xiaohongshu.com"
  && url.pathname.startsWith("/fe-platform/");

const isPublicErrorPage = (html, finalUrl) => {
  try {
    const url = new URL(finalUrl);
    if (url.pathname === "/404" || url.pathname.startsWith("/404/")) return true;
    if (url.searchParams.has("error_code")) return true;
  } catch {}
  return /(当前笔记暂时无法浏览|笔记已删除|笔记不存在)/i.test(String(html || ""));
};

const replaceBareUndefined = (text) => {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (inString) {
      output += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    const before = text[index - 1] || "";
    const after = text[index + 9] || "";
    if (text.startsWith("undefined", index) && !/[\w$]/.test(before) && !/[\w$]/.test(after)) {
      output += "null";
      index += 9;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
};

const parseInitialState = (html) => {
  const text = String(html || "");
  const assignment = /window\.__INITIAL_STATE__\s*=\s*/.exec(text);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length;
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length && index - start <= MAX_INITIAL_STATE_BYTES; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try { return JSON.parse(replaceBareUndefined(text.slice(start, index + 1))); } catch { return null; }
    }
  }
  return null;
};

const initialStateImages = (html, finalUrl) => {
  let noteId = "";
  try {
    const match = new URL(finalUrl).pathname.match(/^\/(?:discovery\/item|explore)\/([0-9a-f]+)\/?$/i);
    noteId = match?.[1] || "";
  } catch {}
  if (!noteId) return [];
  const state = parseInitialState(html);
  const imageList = state?.note?.noteDetailMap?.[noteId]?.note?.imageList;
  if (!Array.isArray(imageList)) return [];
  return imageList.map((image) => {
    const defaultInfo = Array.isArray(image?.infoList)
      ? image.infoList.find((entry) => entry?.imageScene === "WB_DFT") || image.infoList[0]
      : null;
    return image?.urlDefault || defaultInfo?.url || image?.urlPre || image?.url || "";
  }).filter(Boolean).slice(0, 3);
};

const normalizePublicImageUrl = (value, baseUrl) => {
  try {
    const url = new URL(decodeEntities(value), baseUrl);
    const hostname = url.hostname.toLowerCase();
    // INITIAL_STATE 当前会给出 HTTP CDN 地址；只升级已在图片白名单内的小红书 CDN，不发出 HTTP 请求。
    if (url.protocol === "http:" && hostAllowed(hostname, ["xhscdn.com"])) url.protocol = "https:";
    return url.toString();
  } catch { return ""; }
};

const parsePublicMetadata = (html, baseUrl) => {
  const text = String(html || "");
  const result = { title: "", author: "", images: [] };
  for (const tag of text.match(/<meta\b[^>]*>/gi) || []) {
    const attributes = metaAttributes(tag);
    const key = String(attributes.property || attributes.name || "").toLowerCase();
    const content = attributes.content || "";
    if (!result.title && ["og:title", "twitter:title"].includes(key)) result.title = cleanText(content, 120);
    if (!result.author && ["author", "article:author"].includes(key)) result.author = cleanText(content, 60);
    if (["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(key)) result.images.push(content);
  }
  for (const match of text.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectJsonLd(JSON.parse(match[1]), result); } catch {}
  }
  result.images.push(...initialStateImages(text, baseUrl));
  const seen = new Set();
  result.images = result.images.map((entry) => normalizePublicImageUrl(entry, baseUrl)).filter((entry) => {
    if (!entry || seen.has(entry)) return false;
    try {
      const url = new URL(entry);
      if (url.protocol !== "https:" || !hostAllowed(url.hostname.toLowerCase(), IMAGE_HOSTS)) return false;
      if (isPlatformUiImage(url)) return false;
    } catch { return false; }
    seen.add(entry);
    return true;
  }).slice(0, 3);
  return result;
};

const resolveXiaohongshuPublicContent = async (sharedText) => {
  const sourceUrl = extractXiaohongshuUrl(sharedText);
  try {
    const page = await requestBuffer(sourceUrl, { roots: NOTE_HOSTS, limit: MAX_HTML_BYTES });
    if (!page.contentType.includes("text/html")) throw Object.assign(new Error("分享链接没有返回公开网页。"), { code: "INSPIRATION_PUBLIC_PAGE_UNAVAILABLE" });
    const html = page.buffer.toString("utf8");
    if (isPublicErrorPage(html, page.finalUrl)) throw Object.assign(new Error("公开笔记当前不可浏览。"), { code: "INSPIRATION_PUBLIC_PAGE_UNAVAILABLE" });
    if (/(验证码|安全验证|登录后查看|captcha)/i.test(html)) throw Object.assign(new Error("公开页面需要登录或验证。"), { code: "INSPIRATION_PUBLIC_PAGE_BLOCKED" });
    const metadata = parsePublicMetadata(html, page.finalUrl);
    const images = [];
    for (const imageUrl of metadata.images) {
      try {
        const image = await requestBuffer(imageUrl, { roots: IMAGE_HOSTS, limit: MAX_IMAGE_BYTES, accept: "image/avif,image/webp,image/png,image/jpeg" });
        const contentType = detectImageMime(image.buffer);
        if (!contentType) continue;
        images.push({ sourceUrl: image.finalUrl, contentType, buffer: image.buffer });
      } catch {}
    }
    return {
      sourceUrl: page.finalUrl,
      title: metadata.title,
      author: metadata.author,
      images,
      screenshotRequired: images.length === 0,
      errorCode: images.length ? "" : "INSPIRATION_PUBLIC_IMAGES_UNAVAILABLE"
    };
  } catch (error) {
    return { sourceUrl, title: "", author: "", images: [], screenshotRequired: true, errorCode: cleanText(error.code, 80) || "INSPIRATION_PUBLIC_PAGE_UNAVAILABLE" };
  }
};

const slotForCategory = (category) => category === "上衣" ? "top"
  : ["裤子", "半身裙"].includes(category) ? "bottom"
    : category === "连衣裙" ? "dress" : category === "外套" ? "outerwear" : "";

const normalizeSlot = (value) => {
  const slot = cleanText(value, 30).toLowerCase();
  if (["top", "upper", "upper_body", "上装", "上衣"].includes(slot)) return "top";
  if (["bottom", "lower", "lower_body", "下装"].includes(slot)) return "bottom";
  if (["dress", "连衣裙"].includes(slot)) return "dress";
  if (["outerwear", "coat", "外套"].includes(slot)) return "outerwear";
  return "";
};

const normalizeCategory = (entry, slot) => {
  const category = cleanText(entry?.category, 40);
  if (ALLOWED_CATEGORIES.includes(category)) return category;
  const text = `${category} ${cleanText(entry?.name, 40)}`.toLowerCase();
  if (/(鞋|靴|包|配饰|帽|围巾)/.test(text)) return "";
  if (text.includes("连衣裙")) return "连衣裙";
  if (text.includes("半身裙")) return "半身裙";
  if (/(裤子|长裤|短裤|牛仔裤|阔腿裤|西裤)/.test(text)) return "裤子";
  if (/(外套|大衣|夹克|风衣|西装外套)/.test(text)) return "外套";
  if (/(上衣|衬衫|t恤|背心|针织衫|毛衣|卫衣)/.test(text)) return "上衣";
  // 只有槽位本身已经消除歧义时才兜底；“裙装”不能判断连衣裙或半身裙，始终拒绝。
  if (text.includes("裙装")) return "";
  if (slot === "top") return "上衣";
  if (slot === "dress") return "连衣裙";
  if (slot === "outerwear") return "外套";
  return "";
};

const analysisEntries = (raw) => {
  if (Array.isArray(raw?.slots)) return { entries: raw.slots, source: "slots_array" };
  if (raw?.slots && typeof raw.slots === "object") return { entries: Object.values(raw.slots), source: "slots_object" };
  for (const key of ["items", "garments", "outfit"]) {
    if (Array.isArray(raw?.[key])) return { entries: raw[key], source: `${key}_array` };
  }
  return { entries: [], source: "missing" };
};

const sanitizeOutfitAnalysis = (raw) => {
  const slots = [];
  const used = new Set();
  const { entries, source } = analysisEntries(raw);
  const filtered = { invalidCategory: 0, invalidSlot: 0, slotMismatch: 0, duplicateSlot: 0 };
  for (const entry of entries) {
    const statedSlot = normalizeSlot(entry?.slot);
    const category = normalizeCategory(entry, statedSlot);
    const slot = statedSlot || slotForCategory(category);
    if (!category) { filtered.invalidCategory += 1; continue; }
    if (!slot) { filtered.invalidSlot += 1; continue; }
    if (slotForCategory(category) !== slot) { filtered.slotMismatch += 1; continue; }
    if (used.has(slot)) { filtered.duplicateSlot += 1; continue; }
    used.add(slot);
    slots.push({
      slot,
      category,
      name: cleanText(entry.name, 40) || category,
      color: cleanText(entry.color, 30),
      pattern: cleanText(entry.pattern, 30),
      styles: cleanTags(entry.styles),
      scenes: cleanTags(entry.scenes, ALLOWED_SCENES),
      confidence: Math.max(0, Math.min(100, Number(entry.confidence || 0))),
      evidence: cleanText(entry.evidence, 100)
    });
  }
  if (!slots.length) throw Object.assign(new Error("没有识别到可确认的主要穿搭。"), {
    status: 422,
    code: "INSPIRATION_NO_OUTFIT",
    safeDiagnostic: { source, rawSlotCount: entries.length, acceptedSlotCount: 0, filtered }
  });
  return {
    mainImageIndex: Math.max(0, Math.min(2, Number(raw?.mainImageIndex || 0))),
    summary: cleanText(raw?.summary, 120) || "待确认穿搭",
    slots
  };
};

const COLOR_FAMILIES = [
  ["黑", "深灰", "炭灰"], ["白", "米白", "奶油", "象牙"], ["灰", "银灰"],
  ["蓝", "藏蓝", "牛仔", "雾蓝"], ["红", "酒红", "粉", "玫红"], ["绿", "军绿", "鼠尾草"],
  ["黄", "姜黄", "金"], ["棕", "咖", "驼", "卡其"], ["紫", "淡紫"]
];
const normalized = (value) => cleanText(value, 40).toLowerCase();
const colorFamily = (value) => {
  const color = normalized(value);
  const family = COLOR_FAMILIES.find((values) => values.some((entry) => color.includes(entry)));
  return family ? family[0] : color;
};
const overlap = (left, right) => {
  const a = new Set(cleanTags(left, null, 10));
  const b = cleanTags(right, null, 10);
  return b.length ? b.filter((entry) => a.has(entry)).length / Math.max(a.size, b.length) : 0;
};

const scoreItem = (slot, item) => {
  if (slot.category !== item.category) return null;
  let score = 40;
  const reasons = ["品类一致"];
  const leftColor = colorFamily(slot.color);
  const rightColor = colorFamily(item.color);
  if (leftColor && rightColor && leftColor === rightColor) { score += 25; reasons.push("色系接近"); }
  if (normalized(slot.pattern) && normalized(slot.pattern) === normalized(item.pattern)) { score += 10; reasons.push("图案一致"); }
  const styleOverlap = overlap(slot.styles, item.styles);
  if (styleOverlap) { score += Math.round(styleOverlap * 15); reasons.push("风格接近"); }
  const sceneOverlap = overlap(slot.scenes, item.scenes);
  if (sceneOverlap) { score += Math.round(sceneOverlap * 10); reasons.push("场景相符"); }
  return { score: Math.min(100, score), reasons };
};

const matchWardrobe = (slots, items) => {
  const matches = (Array.isArray(slots) ? slots : []).map((slot) => {
    const candidates = (Array.isArray(items) ? items : []).map((item) => {
      const verdict = scoreItem(slot, item);
      return verdict ? { item, ...verdict } : null;
    }).filter((entry) => entry && entry.score >= 55)
      .sort((left, right) => right.score - left.score || String(left.item.id).localeCompare(String(right.item.id)))
      .slice(0, 3);
    return { slot: slot.slot, inspiration: slot, candidates, missing: candidates.length === 0 };
  });
  return { matches, missing: matches.filter((entry) => entry.missing).map((entry) => entry.inspiration.name || entry.inspiration.category) };
};

module.exports = {
  ALLOWED_CATEGORIES,
  ALLOWED_SCENES,
  detectImageMime,
  IMAGE_HOSTS,
  NOTE_HOSTS,
  extractXiaohongshuUrl,
  hostAllowed,
  isPrivateAddress,
  matchWardrobe,
  parsePublicMetadata,
  resolveXiaohongshuPublicContent,
  sanitizeOutfitAnalysis,
  scoreItem,
  slotForCategory,
  _test: { analysisEntries, cleanTags, colorFamily, initialStateImages, isPlatformUiImage, isPublicErrorPage, metaAttributes, normalizeCategory, normalizePublicImageUrl, normalizeSlot, parseInitialState, pinnedLookup, replaceBareUndefined, retryableAddressError, withAddressFallback }
};
