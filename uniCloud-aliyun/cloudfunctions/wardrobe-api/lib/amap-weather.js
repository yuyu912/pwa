"use strict";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

const providerError = (message, code = "AMAP_WEATHER_ERROR", providerStatusCode = 0) => Object.assign(
  new Error(message),
  { status: 502, code, providerStatusCode }
);

const normalizeLive = (payload) => {
  const live = payload?.lives?.[0];
  if (String(payload?.status) !== "1" || !live) {
    throw providerError("高德天气服务暂时未返回有效数据。", String(payload?.infocode || "AMAP_EMPTY_RESULT"));
  }
  const temperature = Number(live.temperature);
  if (!Number.isFinite(temperature)) throw providerError("高德天气温度数据无效。", "AMAP_INVALID_TEMPERATURE");
  return {
    provider: "amap",
    province: String(live.province || ""),
    city: String(live.city || ""),
    adcode: String(live.adcode || ""),
    condition: String(live.weather || "未知"),
    temperature,
    humidity: String(live.humidity || ""),
    windDirection: String(live.winddirection || ""),
    windPower: String(live.windpower || ""),
    reportTime: String(live.reporttime || "")
  };
};

async function getLiveWeather(adcode) {
  const cached = cache.get(adcode);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  const key = process.env.AMAP_WEATHER_KEY;
  if (!key) throw Object.assign(new Error("云函数尚未配置实时天气服务。"), { status: 503, code: "AMAP_KEY_MISSING" });

  let result;
  try {
    result = await uniCloud.httpclient.request("https://restapi.amap.com/v3/weather/weatherInfo", {
      method: "GET",
      data: { key, city: adcode, extensions: "base", output: "JSON" },
      dataType: "json",
      timeout: 8000
    });
  } catch {
    throw providerError("连接高德天气服务失败，请稍后重试。", "AMAP_NETWORK_ERROR");
  }
  const providerStatus = Number(result.statusCode || result.status);
  if (providerStatus < 200 || providerStatus >= 300) {
    throw providerError("高德天气服务请求失败。", "AMAP_HTTP_ERROR", providerStatus);
  }
  const value = normalizeLive(result.data);
  cache.set(adcode, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...value, cached: false };
}

module.exports = { getLiveWeather, normalizeLive };
