const DEFAULT_WEATHER_ICON = "cloud";

const getWeatherIcon = (condition) => {
  const normalized = String(condition || "").trim();
  if (!normalized) return DEFAULT_WEATHER_ICON;

  // 组合天气先判断影响更明确的状态，例如“雨夹雪”显示雪，“晴转多云”显示云。
  if (normalized.includes("雪")) return "snow";
  if (["雨", "雷", "雹"].some((keyword) => normalized.includes(keyword))) return "rain";
  if (normalized.includes("风")) return "wind";
  if (["雾", "霾", "沙", "尘"].some((keyword) => normalized.includes(keyword))) return "haze";
  if (["云", "阴"].some((keyword) => normalized.includes(keyword))) return "cloud";
  if (normalized.includes("晴")) return "sun";
  return DEFAULT_WEATHER_ICON;
};

module.exports = { DEFAULT_WEATHER_ICON, getWeatherIcon };
