"use strict";

const CACHE_TTL_MS = 10 * 60 * 1000;
const FORECAST_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const cache = new Map();
const forecastCache = new Map();

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

const normalizeForecast = (payload) => {
  const forecast = payload?.forecasts?.[0];
  const today = forecast?.casts?.[0];
  if (String(payload?.status) !== "1" || !today) return null;
  const dayTemperature = Number(today.daytemp);
  const nightTemperature = Number(today.nighttemp);
  if (!Number.isFinite(dayTemperature) || !Number.isFinite(nightTemperature)) return null;
  return {
    forecastDate: String(today.date || ""),
    low: Math.min(dayTemperature, nightTemperature),
    high: Math.max(dayTemperature, nightTemperature),
    dayCondition: String(today.dayweather || ""),
    nightCondition: String(today.nightweather || ""),
    dayWindPower: String(today.daypower || ""),
    nightWindPower: String(today.nightpower || ""),
    forecastReportTime: String(forecast.reporttime || "")
  };
};

async function requestWeatherPayload(key, adcode, extensions) {
  let result;
  try {
    result = await uniCloud.httpclient.request("https://restapi.amap.com/v3/weather/weatherInfo", {
      method: "GET",
      data: { key, city: adcode, extensions, output: "JSON" },
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
  return result.data;
}

async function getWeather(adcode) {
  const cached = cache.get(adcode);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  const key = process.env.AMAP_WEATHER_KEY;
  if (!key) throw Object.assign(new Error("云函数尚未配置实时天气服务。"), { status: 503, code: "AMAP_KEY_MISSING" });

  const cachedForecast = forecastCache.get(adcode);
  const forecastPromise = cachedForecast && cachedForecast.expiresAt > Date.now()
    ? Promise.resolve(cachedForecast.value)
    : requestWeatherPayload(key, adcode, "all")
      .then(normalizeForecast)
      .then((forecast) => {
        if (forecast) forecastCache.set(adcode, { value: forecast, expiresAt: Date.now() + FORECAST_CACHE_TTL_MS });
        return forecast;
      })
      .catch(() => null);
  const [livePayload, forecast] = await Promise.all([
    requestWeatherPayload(key, adcode, "base"),
    forecastPromise
  ]);
  const value = { ...normalizeLive(livePayload), ...(forecast || {}) };
  cache.set(adcode, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ...value, cached: false };
}

module.exports = { getLiveWeather: getWeather, getWeather, normalizeForecast, normalizeLive };
